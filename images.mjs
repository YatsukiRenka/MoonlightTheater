import {initializeImageSettings, setModelOptions} from './image-settings.mjs';
import {initializeImageControls} from './image-controls.mjs';
import {mountImageDeck} from './image-deck.mjs';
import {readImageHistory, saveImageHistory} from './image-history.mjs';
import {money} from './image-usage.mjs';
import {
  apiProviderNames, readAPIResources, removeAPIResource, saveAPIResource, verifyAPIResource,
} from './api-resources.mjs';
import {authorizeGoogle, currentGoogleToken, describeImageResources, generateImage} from './image-client.mjs';

const preferenceKey = 'moonlight-image-preferences';

function readPreferences() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(preferenceKey));
    if (saved && saved.models && typeof saved.models === 'object' && !Array.isArray(saved.models)) {
      const resourceId = typeof saved.resourceId === 'string' ? saved.resourceId
        : Object.hasOwn(apiProviderNames, saved.provider) ? saved.provider : '';
      const settings = saved.settings && typeof saved.settings === 'object' ? saved.settings : {};
      return {resourceId, models: saved.models, settings, aspect: saved.aspect};
    }
  } catch {}
  return {resourceId: '', models: {}, settings: {}};
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
  const resourceSelect = byId('imageProvider');
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
  const previewContent = byId('imagePreviewAsset');
  const history = byId('imageRecords');
  const historyStatus = byId('imageHistoryStatus');

  const preferences = readPreferences();
  const controls = initializeImageControls(preferences.settings, savePreferences, preferences.aspect);
  let availability;
  let busy = false;
  let resources = new Map();
  const authorizations = new Map();
  let expiryTimer;
  let galleryDeck;
  let historyDecks = [];
  let activePreview;
  let partialURL;
  let historyOpen = false;
  let historyRead = 0;

  const imageSettings = initializeImageSettings({
    verify: (provider, values, id) => verifyAPIResource(provider, values, {id, authorization: authorizations.get(id)}),
    async save(draft) {
      const saved = await saveAPIResource(draft);
      if (saved.provider === 'gemini-oauth' && currentGoogleToken(draft.verification?.authorization, saved.config)) {
        authorizations.set(saved.id, draft.verification.authorization);
      }
      refreshAvailability();
      return {id: saved.id, name: saved.name};
    },
    async remove(id) {
      await removeAPIResource(id);
      authorizations.delete(id);
      delete preferences.models[id];
      if (preferences.resourceId === id) preferences.resourceId = '';
      savePreferences();
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
    const id = resourceSelect.value;
    const resource = availability?.get(id);
    const google = resource?.provider === 'gemini-oauth';
    const ready = google ? resource.connected : resource?.ready;
    const models = resource?.ready ? resource.models : [];
    const preferred = preferences.models[id];
    const selected = models.includes(preferred) ? preferred : resource?.model || '';
    setModelOptions(model, models, selected, '请先验证接口');
    byId('imageAuth').hidden = !google || !resource.ready;
    connect.textContent = resource?.connected ? '断开 Google 授权' : '使用 Google 登录';
    resourceSelect.disabled = busy || !availability?.size;
    connect.disabled = busy;
    model.disabled = busy || !models.length;
    generate.disabled = busy || !ready || !model.value;
    updateModelControls();

    if (!availability) connection.textContent = '浏览器未允许本站使用本地存储。';
    else if (!resource) connection.textContent = '请在「设置」中添加 API 资源。';
    else if (!resource.ready) connection.textContent = '请先在「设置」中验证此接口并选择模型。';
    else if (google) connection.textContent = resource.connected
      ? '已授权 Google Cloud，使用此项目的 Vertex AI 配额。'
      : '请登录 Google 并授权 Vertex AI 调用。';
    else if (resource.provider === 'custom') connection.textContent = resource.format === 'gemini' ? 'Gemini 兼容协议' : 'OpenAI Images 兼容协议';
    else connection.textContent = '';
  }

  function refreshAvailability() {
    let available;
    try {
      const rows = readAPIResources();
      resources = new Map(rows.map(row => [row.id, row]));
      available = rows.map(({id, provider, name, config}) => {
        const authorization = authorizations.get(id);
        if (authorization && !currentGoogleToken(authorization, config)) authorizations.delete(id);
        const description = describeImageResources({[provider]: config}, authorizations.get(id));
        return {...description.resources[provider], ...description.providers[provider], id, provider, name};
      });
    } catch { resources = new Map(); }
    for (const id of authorizations.keys()) if (!resources.has(id)) authorizations.delete(id);
    clearTimeout(expiryTimer);
    if (authorizations.size) {
      const expiry = Math.min(...Array.from(authorizations.values(), value => value.expires));
      expiryTimer = setTimeout(refreshAvailability, Math.max(0, expiry - Date.now()));
    }
    availability = available && new Map(available.map(row => [row.id, row]));
    const rows = available ?? [];
    const labels = rows.map(({id, name, provider}) => [id, name === apiProviderNames[provider] ? name : name + ' · ' + apiProviderNames[provider]]);
    if (resourceSelect.options.length !== labels.length + 1 || labels.some(([id, label], index) => {
      const option = resourceSelect.options[index + 1];
      return option.value !== id || option.text !== label;
    })) {
      const placeholder = new Option('请在设置中添加 API 资源', '');
      placeholder.disabled = Boolean(labels.length);
      resourceSelect.replaceChildren(placeholder, ...labels.map(([id, label]) => new Option(label, id)));
    }
    resourceSelect.value = availability?.has(preferences.resourceId) ? preferences.resourceId
      : (rows.find(row => row.ready) ?? rows[0])?.id ?? '';
    imageSettings.update(available);
    refreshControls();
  }

  async function changeGoogle(id) {
    const resource = availability?.get(id);
    if (busy) throw new Error('请等待当前生图或授权操作结束。');
    if (resource?.provider !== 'gemini-oauth' || !resource.ready) return '';
    busy = true;
    refreshControls();
    try {
      if (resource.connected) {
        authorizations.delete(id);
        return '已断开 Google 授权。';
      }
      authorizations.set(id, await authorizeGoogle(resources.get(id).config));
      return 'Google 授权成功。';
    } finally {
      busy = false;
      refreshAvailability();
    }
  }

  function updateModelControls() {
    const resource = availability?.get(resourceSelect.value);
    const provider = resource?.provider;
    controls.update(provider, provider === 'openai' ? 'openai' : provider === 'custom' ? resource.format : 'gemini',
      model.value, busy, provider !== 'custom' || resource.supportsReferences);
  }

  function closePreviewDeck() {
    if (!activePreview) return;
    const {deck, select} = activePreview;
    deck.dispose();
    select(deck.currentIndex);
    activePreview = undefined;
  }

  function openPreview({record, index, ratio, select}) {
    if (preview.open) return;
    closePreviewDeck();
    const deck = mountImageDeck(previewContent, record, {
      preview: true, initialIndex: index, initialRatio: ratio, keyboardScope: preview,
    });
    activePreview = {deck, select};
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
    galleryDeck?.dispose();
    galleryDeck = mountImageDeck(gallery, record, {openPreview});
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
    historyDecks.forEach(deck => deck.dispose());
    historyDecks = [];
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
      title.textContent = (apiProviderNames[record.provider] || record.provider) + ' · ' + record.model;
      const date = document.createElement('time');
      date.dateTime = new Date(record.time).toISOString();
      date.textContent = new Date(record.time).toLocaleString('zh-CN');
      const thumbnails = document.createElement('div');
      historyDecks.push(mountImageDeck(thumbnails, record, {compact: true, openPreview}));
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

  resourceSelect.onchange = () => {
    preferences.resourceId = resourceSelect.value;
    savePreferences();
    refreshControls();
  };
  model.onchange = () => {
    preferences.models[resourceSelect.value] = model.value;
    savePreferences();
    updateModelControls();
  };
  byId('closeImagePreview').onclick = () => preview.close();
  preview.onclose = () => { if (!preview.open) closePreviewDeck(); };

  connect.onclick = async () => {
    try {
      showStatus(await changeGoogle(resourceSelect.value));
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
    const selected = resources.get(resourceSelect.value);
    if (!selected) return;
    const {id, provider: selectedProvider, config, name} = selected;
    const authorization = authorizations.get(id);
    let inputs;
    try { inputs = controls.capture(); } catch (error) { showStatus(error.message, true); return; }
    busy = true;
    refreshControls();
    form.classList.add('image-pending');
    showStatus('正在通过 ' + name + ' 生成图片…');
    try {
      const result = await generateImage({
        provider: selectedProvider, model: model.value, prompt: context.prompt, ...inputs,
      }, {[selectedProvider]: config}, authorization, {
        onPartial: showPartial,
        onProgress(index, total) {
          if (total > 1) showStatus('正在通过 ' + name + ' 生图 · 请求 ' + index + ' / ' + total);
        },
      });
      const record = {
        ...context, model: result.model, provider: selectedProvider, time: Date.now(), metrics: result.metrics,
        images: result.images.map(imageBlob), text: result.text, sources: result.sources,
      };
      if (result.warningStatus === 401 && authorizations.get(id) === authorization) authorizations.delete(id);
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
      if (error.status === 401 && authorizations.get(id) === authorization) authorizations.delete(id);
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
