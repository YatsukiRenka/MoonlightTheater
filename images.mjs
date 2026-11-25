import {initializeImageSettings, setModelOptions} from './image-settings.mjs';
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

function makeAsset(image, index, seed) {
  const blob = image.blob || new Blob([
    Uint8Array.from(atob(image.base64), byte => byte.charCodeAt(0)),
  ], {type: image.mime});
  const url = URL.createObjectURL(blob);
  const fileSeed = seed.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);
  return {url, filename: 'moonlight-' + fileSeed + '-' + (index + 1) + '.' + imageTypes[image.mime]};
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
  const empty = byId('imageEmpty');
  const gallery = byId('imageGallery');
  const preview = byId('imagePreview');
  const previewImage = byId('imagePreviewAsset');

  const preferences = readPreferences();
  provider.value = preferences.provider;
  aspect.value = preferences.aspect;
  let availability;
  let busy = false;
  let resources = {};
  let authorization;
  let expiryTimer;
  let assets = [];

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

  function renderImages(images, context) {
    const nextAssets = images.map((image, index) => makeAsset(image, index, context.seed));
    assets.forEach(asset => URL.revokeObjectURL(asset.url));
    assets = nextAssets;
    gallery.replaceChildren();
    for (const [index, asset] of assets.entries()) {
      const card = document.createElement('figure');
      const thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'image-thumb';
      thumb.setAttribute('aria-label', '放大查看角色图 ' + (index + 1));
      const image = document.createElement('img');
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => {
        thumb.disabled = true;
        thumb.textContent = '图片载入失败';
      });
      image.src = asset.url;
      thumb.append(image);
      thumb.onclick = () => {
        previewImage.src = asset.url;
        preview.showModal();
      };
      const caption = document.createElement('figcaption');
      const metadata = document.createElement('span');
      metadata.textContent = context.model + ' · ' + (context.language === 'en' ? 'EN' : '中文') + ' · ' + context.seed;
      const link = document.createElement('a');
      link.href = asset.url;
      link.download = asset.filename;
      link.textContent = '下载原图';
      caption.append(metadata, link);
      card.append(thumb, caption);
      gallery.append(card);
    }
    empty.hidden = true;
    gallery.hidden = false;
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
  preview.onclose = () => previewImage.removeAttribute('src');

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
      renderImages(result.images, {...context, model: result.model});
      showStatus('已生成 ' + result.images.length + ' 张图片。');
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
}
