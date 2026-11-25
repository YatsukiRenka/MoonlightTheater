import {initializeImageSettings, setModelOptions} from './image-settings.mjs';
import {readImageHistory, saveImageHistory} from './image-history.mjs';
import {money} from './image-usage.mjs';
import {
  authorizeGoogle, currentGoogleToken, describeImageResources, generateImage,
  readImageResources, updateImageResource, verifyImageResource,
} from './image-client.mjs';

const names = {openai: 'OpenAI', gemini: 'Gemini', 'gemini-oauth': 'Gemini · Google OAuth', custom: '自定义接口'};
const preferenceKey = 'moonlight-image-preferences';
const imageTypes = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'};

function readPreferences() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(preferenceKey));
    if (saved && Object.hasOwn(names, saved.provider) &&
        ['auto', 'portrait', 'square', 'landscape'].includes(saved.aspect) &&
        saved.models && typeof saved.models === 'object') return saved;
  } catch {}
  return {provider: 'openai', aspect: 'auto', models: {}};
}

function imageBlob(image) {
  return image.blob || new Blob([
    Uint8Array.from(atob(image.base64), byte => byte.charCodeAt(0)),
  ], {type: image.mime});
}

function renderMetrics(container, metrics) {
  if (!metrics) return;
  const formatted = value => value.toLocaleString('zh-HK');
  const tokens = metrics.tokens?.total;
  const cost = metrics.cost;
  const subtitle = cost?.source === 'reported' ? '接口返回'
    : cost?.upperBound ? '估算上限' : cost?.source === 'catalog' ? '接口目录估算' : '官方参考价估算';
  const parts = [
    ['耗时', (metrics.elapsed / 1000).toFixed(1) + ' 秒'],
    ['Token 合计', tokens == null ? '接口未返回' : formatted(tokens)],
    ['费用', cost ? money(cost.value, cost.currency) + ' · ' + subtitle : '暂无可用估算'],
  ];
  const list = document.createElement('dl');
  for (const [label, value] of parts) {
    const item = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const data = document.createElement('dd');
    data.textContent = value;
    item.append(term, data);
    list.append(item);
  }
  container.replaceChildren(list);
  container.hidden = false;
}

export function initializeImages(getPrompt) {
  const byId = id => document.getElementById(id);
  const form = byId('imageForm');
  const provider = byId('imageProvider');
  const model = byId('imageModel');
  const aspect = byId('imageAspect');
  const connect = byId('imageGoogle');
  const generate = byId('imageGenerate');
  const connection = byId('imageConnection');
  const status = byId('imageStatus');
  const metricsBox = byId('imageMetrics');
  const empty = byId('imageEmpty');
  const gallery = byId('imageGallery');
  const preview = byId('imagePreview');
  const previewImage = byId('imagePreviewAsset');
  const history = byId('imageRecords');
  const historyStatus = byId('imageHistoryStatus');

  const preferences = readPreferences();
  provider.value = preferences.provider;
  aspect.value = preferences.aspect;
  let availability;
  let busy = false;
  let resources = {};
  let authorization;
  let expiryTimer;
  let galleryURLs = [];
  let historyURLs = [];
  let previewURL;
  let historyOpen = false;
  let historyRead = 0;

  const imageSettings = initializeImageSettings({
    verify: (id, values) => verifyImageResource(id, values, {authorization}),
    save(id, action, values, verification) {
      updateImageResource(id, action, values, {verification});
      if (verification?.authorization) rememberGoogle(verification.authorization);
      refreshAvailability();
    },
    google: changeGoogle,
  });

  function savePreferences() {
    try { sessionStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch {}
  }

  function showStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle('image-error', error);
  }

  function refreshControls() {
    const id = provider.value;
    const config = availability?.[id];
    const google = id === 'gemini-oauth';
    const ready = google ? config?.connected : config?.ready;
    const models = config?.ready ? config.models : [];
    const preferred = preferences.models[id];
    setModelOptions(model, models, models.includes(preferred) ? preferred : config?.model, '请先验证接口');
    byId('imageAuth').hidden = !google || !config?.ready;
    connect.textContent = config?.connected ? '断开 Google 授权' : '使用 Google 登录';
    for (const control of [provider, aspect, connect]) control.disabled = busy;
    model.disabled = busy || !models.length;
    generate.disabled = busy || !ready || !model.value;

    if (!availability) connection.textContent = '浏览器未允许本站使用本地存储。';
    else if (!config?.ready) connection.textContent = '请先在「设置」中验证此接口并选择模型。';
    else if (google) connection.textContent = config.connected
      ? '已授权 Google Cloud，使用此项目的 Vertex AI 配额。'
      : '请登录 Google 并授权 Vertex AI 调用。';
    else if (id === 'custom') connection.textContent = '已配置 · ' + (config.format === 'gemini' ? 'Gemini 兼容协议' : 'OpenAI Images 兼容协议');
    else connection.textContent = '已配置 API Key。';
  }

  function refreshAvailability() {
    let data;
    try {
      resources = readImageResources();
      if (!currentGoogleToken(authorization, resources['gemini-oauth'])) {
        authorization = undefined;
        clearTimeout(expiryTimer);
      }
      data = describeImageResources(resources, authorization);
    } catch {}
    availability = data?.providers;
    imageSettings.update(data);
    refreshControls();
  }

  function rememberGoogle(result) {
    authorization = result;
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(refreshAvailability, Math.max(0, result.expires - Date.now()));
  }

  async function changeGoogle() {
    if (busy || !availability?.['gemini-oauth']?.ready) return '';
    busy = true;
    refreshControls();
    try {
      if (availability['gemini-oauth'].connected) {
        authorization = undefined;
        return '已断开 Google 授权。';
      }
      rememberGoogle(await authorizeGoogle(resources['gemini-oauth']));
      return 'Google 授权成功。';
    } finally {
      busy = false;
      refreshAvailability();
    }
  }

  function appendImages(container, images, record, compact = false) {
    const urls = [];
    const fileSeed = record.seed.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);
    for (const [index, blob] of images.entries()) {
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const card = document.createElement('figure');
      const thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'image-thumb';
      thumb.setAttribute('aria-label', '放大查看角色图 ' + (index + 1));
      const image = document.createElement('img');
      image.alt = '';
      if (compact) image.loading = 'lazy';
      image.addEventListener('error', () => {
        thumb.disabled = true;
        thumb.textContent = '图片载入失败';
      });
      image.src = url;
      thumb.append(image);
      thumb.onclick = () => {
        previewURL = URL.createObjectURL(blob);
        previewImage.src = previewURL;
        preview.showModal();
      };
      const caption = document.createElement('figcaption');
      if (!compact) {
        const metadata = document.createElement('span');
        metadata.textContent = record.model + ' · ' + (record.language === 'en' ? 'EN' : '中文') + ' · ' + record.seed;
        caption.append(metadata);
      }
      const link = document.createElement('a');
      link.href = url;
      link.download = 'moonlight-' + fileSeed + '-' + (index + 1) + '.' + imageTypes[blob.type];
      link.textContent = '下载原图';
      caption.append(link);
      card.append(thumb, caption);
      container.append(card);
    }
    return urls;
  }

  function renderImages(record) {
    galleryURLs.forEach(url => URL.revokeObjectURL(url));
    gallery.replaceChildren();
    galleryURLs = appendImages(gallery, record.images, record);
    renderMetrics(metricsBox, record.metrics);
    empty.hidden = true;
    gallery.hidden = false;
  }

  function releaseHistory() {
    historyURLs.forEach(url => URL.revokeObjectURL(url));
    historyURLs = [];
    history.replaceChildren();
  }

  function hideHistory() {
    historyOpen = false;
    historyRead++;
    releaseHistory();
  }

  async function showHistory() {
    historyOpen = true;
    const read = ++historyRead;
    historyStatus.textContent = '正在读取生图记录…';
    let records;
    try {
      records = await readImageHistory();
    } catch {
      if (read === historyRead) historyStatus.textContent = '无法读取此浏览器的生图记录。';
      return;
    }
    if (read !== historyRead) return;
    releaseHistory();
    historyStatus.textContent = records.length ? '' : '此浏览器还没有生图记录。';
    for (const record of records) {
      const card = document.createElement('article');
      card.className = 'panel image-history-record';
      const title = document.createElement('h2');
      title.textContent = (names[record.provider] || record.provider) + ' · ' + record.model;
      const date = document.createElement('time');
      date.dateTime = new Date(record.time).toISOString();
      date.textContent = new Date(record.time).toLocaleString('zh-CN');
      const thumbnails = document.createElement('div');
      thumbnails.className = 'image-gallery';
      historyURLs.push(...appendImages(thumbnails, record.images, record, true));
      const metrics = document.createElement('div');
      metrics.className = 'image-metrics';
      metrics.hidden = true;
      renderMetrics(metrics, record.metrics);
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = '查看生成时的提示词 · ' + (record.language === 'en' ? 'EN' : '中文');
      const prompt = document.createElement('pre');
      prompt.textContent = record.prompt;
      details.append(summary, prompt);
      card.append(title, date, thumbnails, metrics, details);
      history.append(card);
    }
  }

  provider.onchange = () => {
    preferences.provider = provider.value;
    savePreferences();
    refreshControls();
  };
  model.onchange = () => {
    preferences.models[provider.value] = model.value;
    savePreferences();
  };
  aspect.onchange = () => {
    preferences.aspect = aspect.value;
    savePreferences();
  };
  byId('closeImagePreview').onclick = () => preview.close();
  preview.onclose = () => {
    previewImage.removeAttribute('src');
    URL.revokeObjectURL(previewURL);
    previewURL = undefined;
  };

  connect.onclick = async () => {
    try {
      showStatus(await changeGoogle());
    } catch (error) {
      showStatus(error.message, true);
    }
  };

  form.onsubmit = async event => {
    event.preventDefault();
    if (busy || generate.disabled) return;
    const context = getPrompt();
    if (!context.prompt.trim()) {
      showStatus('请先填写完整提示词。', true);
      return;
    }
    const selectedProvider = provider.value;
    busy = true;
    refreshControls();
    form.classList.add('image-pending');
    showStatus('正在通过 ' + names[selectedProvider] + ' 生成图片…');
    try {
      const result = await generateImage({
        provider: selectedProvider, model: model.value, aspect: aspect.value, prompt: context.prompt,
      }, resources, authorization);
      const record = {
        ...context, model: result.model, provider: selectedProvider, time: Date.now(), metrics: result.metrics,
        images: result.images.map(imageBlob),
      };
      renderImages(record);
      const completed = '已生成 ' + record.images.length + ' 张图片。';
      showStatus(completed);
      try {
        await saveImageHistory(record);
        if (historyOpen) void showHistory();
      } catch {
        showStatus(completed + ' 此浏览器无法保存本次生图记录。', true);
      }
    } catch (error) {
      showStatus(error.message, true);
      if (selectedProvider === 'gemini-oauth' && error.status === 401) authorization = undefined;
    } finally {
      busy = false;
      form.classList.remove('image-pending');
      refreshAvailability();
    }
  };

  refreshAvailability();
  window.addEventListener('storage', refreshAvailability);
  window.addEventListener('hashchange', () => {
    if (location.hash === '#settings') refreshAvailability();
  });
  return {showHistory, hideHistory};
}
