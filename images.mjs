import {initializeImageSettings, setModelOptions} from './image-settings.mjs';
import {initializeImageControls} from './image-controls.mjs';
import {mountImageDeck} from './image-deck.mjs';
import {readImageHistory, saveImageHistory} from './image-history.mjs';
import {money} from './image-usage.mjs';
import {
  authorizeGoogle, currentGoogleToken, describeImageResources, generateImage,
  readImageResources, updateImageResource, verifyImageResource,
} from './image-client.mjs';

const names = {openai: 'OpenAI', gemini: 'Gemini', 'gemini-oauth': 'Gemini · Google OAuth', custom: '自定义接口'};
const preferenceKey = 'moonlight-image-preferences';

function readPreferences() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(preferenceKey));
    if (saved && Object.hasOwn(names, saved.provider) &&
        saved.models && typeof saved.models === 'object') {
      const settings = saved.settings && typeof saved.settings === 'object' ? saved.settings : {};
      return {...saved, settings};
    }
  } catch {}
  return {provider: 'openai', models: {}, settings: {}};
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
  const extra = metrics.extraCharges && cost?.source !== 'reported' ? ' · 附加费用另计' : '';
  const parts = [
    ['耗时', (metrics.elapsed / 1000).toFixed(1) + ' 秒'],
    ['Token 合计', tokens == null ? '接口未返回' : formatted(tokens)],
    ['费用', cost ? money(cost.value, cost.currency) + ' · ' + subtitle + extra : '暂无可用估算'],
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
  const connect = byId('imageGoogle');
  const generate = byId('imageGenerate');
  const connection = byId('imageConnection');
  const status = byId('imageStatus');
  const metricsBox = byId('imageMetrics');
  const empty = byId('imageEmpty');
  const gallery = byId('imageGallery');
  const resultDetails = byId('imageResultDetails');
  const partial = byId('imagePartial');
  const partialAsset = byId('imagePartialAsset');
  const preview = byId('imagePreview');
  const previewImage = byId('imagePreviewAsset');
  const history = byId('imageRecords');
  const historyStatus = byId('imageHistoryStatus');

  const preferences = readPreferences();
  provider.value = preferences.provider;
  const controls = initializeImageControls(preferences.settings, savePreferences, preferences.aspect);
  let availability;
  let busy = false;
  let resources = {};
  let authorization;
  let expiryTimer;
  let galleryURLs = [];
  let historyURLs = [];
  let previewURL;
  let partialURL;
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
    const selected = models.includes(preferred) ? preferred : config?.model || '';
    if (model.options.length !== models.length + 1 || models.some((id, i) => model.options[i + 1].value !== id)) {
      setModelOptions(model, models, selected, '请先验证接口');
    } else if (model.value !== selected) model.value = selected;
    byId('imageAuth').hidden = !google || !config?.ready;
    connect.textContent = config?.connected ? '断开 Google 授权' : '使用 Google 登录';
    for (const control of [provider, connect]) control.disabled = busy;
    model.disabled = busy || !models.length;
    generate.disabled = busy || !ready || !model.value;
    updateModelControls();

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

  function updateModelControls() {
    const id = provider.value;
    const config = availability?.[id];
    controls.update(id, id === 'openai' ? 'openai' : id === 'custom' ? config?.format : 'gemini',
      model.value, busy, id !== 'custom' || config?.supportsReferences);
  }

  function openPreview(blob) {
    previewURL = URL.createObjectURL(blob);
    previewImage.src = previewURL;
    preview.showModal();
  }

  function renderDetails(container, record) {
    const children = [];
    if (record.text) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = '模型附带文字';
      const text = document.createElement('p');
      text.textContent = record.text;
      details.append(summary, text);
      children.push(details);
    }
    if (record.sources?.length) {
      const sources = document.createElement('p');
      sources.className = 'image-sources';
      sources.append('Google 搜索来源');
      for (const {url, title} of record.sources) {
        if (!url.startsWith('https://')) continue;
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = title;
        sources.append(link);
      }
      children.push(sources);
    }
    container.replaceChildren(...children);
    container.hidden = !children.length;
  }

  function renderImages(record) {
    galleryURLs.forEach(url => URL.revokeObjectURL(url));
    gallery.replaceChildren();
    galleryURLs = mountImageDeck(gallery, record, openPreview);
    renderMetrics(metricsBox, record.metrics);
    renderDetails(resultDetails, record);
    empty.hidden = true;
    gallery.hidden = false;
  }

  function showPartial(image) {
    URL.revokeObjectURL(partialURL);
    partialURL = URL.createObjectURL(imageBlob(image));
    partialAsset.src = partialURL;
    partial.hidden = false;
    empty.hidden = true;
    gallery.hidden = true;
  }

  function clearPartial() {
    if (!partialURL) return;
    partial.hidden = true;
    partialAsset.removeAttribute('src');
    URL.revokeObjectURL(partialURL);
    partialURL = undefined;
    gallery.hidden = !gallery.children.length;
    empty.hidden = !gallery.hidden;
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
      historyURLs.push(...mountImageDeck(thumbnails, record, openPreview, true));
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
      const additional = document.createElement('div');
      renderDetails(additional, record);
      card.append(title, date, thumbnails, metrics, details, additional);
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
    updateModelControls();
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

  form.noValidate = true;
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy || generate.disabled) return;
    const context = getPrompt();
    if (!context.prompt.trim()) {
      showStatus('请先填写完整提示词。', true);
      return;
    }
    const selectedProvider = provider.value;
    let inputs;
    try { inputs = controls.capture(); } catch (error) { showStatus(error.message, true); return; }
    busy = true;
    refreshControls();
    form.classList.add('image-pending');
    showStatus('正在通过 ' + names[selectedProvider] + ' 生成图片…');
    try {
      const result = await generateImage({
        provider: selectedProvider, model: model.value, prompt: context.prompt, ...inputs,
      }, resources, authorization, {
        onPartial: showPartial,
        onProgress(index, total) {
          if (total > 1) showStatus('正在通过 ' + names[selectedProvider] + ' 生图 · 请求 ' + index + ' / ' + total);
        },
      });
      const record = {
        ...context, model: result.model, provider: selectedProvider, time: Date.now(), metrics: result.metrics,
        images: result.images.map(imageBlob), text: result.text, sources: result.sources,
      };
      if (selectedProvider === 'gemini-oauth' && result.warningStatus === 401) authorization = undefined;
      clearPartial();
      renderImages(record);
      const completed = '已生成 ' + record.images.length + ' 张图片。'
        + (result.warning ? ' 后续请求未完成。' + result.warning : '');
      showStatus(completed, Boolean(result.warning));
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
      clearPartial();
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
