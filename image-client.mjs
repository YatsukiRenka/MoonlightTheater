const resourceKey = 'moonlight-image-resources-v1';
const resourceIds = ['openai', 'gemini', 'gemini-oauth', 'custom'];
const projectPattern = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,20})$/;
const clientPattern = /^[A-Za-z0-9_-]{4,220}\.apps\.googleusercontent\.com$/;
const googleScope = 'https://www.googleapis.com/auth/cloud-platform';
const sizes = {portrait: '1024x1536', square: '1024x1024', landscape: '1536x1024'};
const aspects = {portrait: '2:3', square: '1:1', landscape: '3:2'};
const maxResponse = 20 * 1024 * 1024;
export const imageModels = {
  openai: 'gpt-image-2',
  gemini: 'gemini-3.1-flash-image',
  'gemini-oauth': 'gemini-3.1-flash-image',
  custom: '',
};

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function readImageResources(storage = globalThis.localStorage) {
  const raw = storage.getItem(resourceKey);
  if (!raw) return {};
  let saved;
  try { saved = record(JSON.parse(raw)); } catch { return {}; }
  return Object.fromEntries(resourceIds.filter(id => Object.hasOwn(saved, id)).map(id => [id, record(saved[id])]));
}

function endpoint(value, origin) {
  if (typeof value !== 'string' || !value || /[\\\s\x00-\x1f\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.origin === origin || url.username || url.password || url.hash) return null;
    if (url.protocol === 'https:' || (loopback && url.protocol === 'http:')) return url;
  } catch {}
  return null;
}

function validCustom(value, format, origin) {
  const url = endpoint(value, origin);
  if (!url) return false;
  if (format === 'openai') return !value.includes('{model}');
  return format === 'gemini' && value.split('{model}').length === 2
    && /\/models\/(?:\{model\}|%7Bmodel%7D):generateContent$/.test(url.pathname);
}

function validModel(model, format) {
  const pattern = format === 'openai'
    ? /^[A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+)*$/
    : /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
  return typeof model === 'string' && model.length <= 128 && pattern.test(model);
}

function validKey(key) {
  return typeof key === 'string' && Boolean(key) && key.length <= 1024 && !/[^!-~]/.test(key);
}

function validateResource(id, values, previous, origin) {
  const field = name => typeof values[name] === 'string' ? values[name].trim() : '';
  const key = field('key') || (id === 'custom' && values.clearKey === true ? '' : previous?.key || '');
  if (id !== 'gemini-oauth' && (id !== 'custom' || key) && !validKey(key)) {
    throw new Error('请填写有效的 API Key。');
  }
  if (id === 'gemini-oauth') {
    const clientId = field('clientId');
    const project = field('project');
    if (!clientPattern.test(clientId)) throw new Error('请填写 Google Cloud 的 Web 应用 Client ID。');
    if (!projectPattern.test(project)) throw new Error('请填写有效的 Google Cloud 项目 ID 或项目编号。');
    return {clientId, project};
  }
  if (id === 'custom') {
    const url = field('url');
    const format = field('format');
    const model = field('model');
    if (url.length > 2048 || !validCustom(url, format, origin)) {
      throw new Error(format === 'gemini'
        ? '请填写包含 /models/{model}:generateContent 的外部 Gemini 接口地址。'
        : '请填写外部 HTTPS 接口或本机回环 HTTP 地址。');
    }
    if (model && !validModel(model, format)) throw new Error('请填写有效的默认模型 ID。');
    return {url, format, key, model};
  }
  return {key};
}

export function updateImageResource(id, action, values, {
  storage = globalThis.localStorage, origin = location.origin,
} = {}) {
  if (!resourceIds.includes(id) || !['save', 'remove'].includes(action)) throw new Error('请选择一个有效的接口。');
  const resources = readImageResources(storage);
  if (action === 'remove') delete resources[id];
  else resources[id] = validateResource(id, record(values), resources[id], origin);
  try {
    if (Object.keys(resources).length) storage.setItem(resourceKey, JSON.stringify(resources));
    else storage.removeItem(resourceKey);
  } catch {
    throw new Error('浏览器无法保存本地配置。');
  }
  return resources;
}

export function currentGoogleToken(authorization, resource) {
  if (authorization && resource?.clientId === authorization.clientId
    && resource?.project === authorization.project && authorization.expires > Date.now()) return authorization.token;
  return '';
}

export function describeImageResources(saved, authorization, origin = location.origin) {
  const oauth = saved['gemini-oauth'] || {};
  const custom = saved.custom || {};
  const format = custom.format || 'openai';
  const customReady = validCustom(custom.url, format, origin) && (!custom.key || validKey(custom.key));
  const providers = {
    openai: {ready: validKey(saved.openai?.key), model: imageModels.openai},
    gemini: {ready: validKey(saved.gemini?.key), model: imageModels.gemini},
    'gemini-oauth': {
      ready: clientPattern.test(oauth.clientId || '') && projectPattern.test(oauth.project || ''),
      connected: Boolean(currentGoogleToken(authorization, oauth)), model: imageModels['gemini-oauth'],
    },
    custom: {ready: customReady, model: custom.model || '', format},
  };
  const resources = Object.fromEntries(resourceIds.map(id => [
    id, {saved: Boolean(saved[id]), hasSecret: Boolean(saved[id]?.key), ready: providers[id].ready},
  ]));
  Object.assign(resources['gemini-oauth'], {clientId: oauth.clientId || '', project: oauth.project || ''});
  Object.assign(resources.custom, {url: custom.url || '', format, model: custom.model || ''});
  return {providers, resources, canConfigure: true};
}

let googleScript;
function loadGoogleOAuth() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve(globalThis.google.accounts.oauth2);
  googleScript ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    const failed = () => {
      script.remove();
      reject(new Error('无法加载 Google 登录，请检查网络后重试。'));
    };
    script.onload = () => {
      if (globalThis.google?.accounts?.oauth2) resolve(globalThis.google.accounts.oauth2);
      else failed();
    };
    script.onerror = failed;
    document.head.append(script);
  }).catch(error => {
    googleScript = undefined;
    throw error;
  });
  return googleScript;
}

export function authorizeGoogle(resource) {
  if (!clientPattern.test(resource?.clientId || '') || !projectPattern.test(resource?.project || '')) {
    throw new Error('请先保存 Google OAuth 配置。');
  }
  const {clientId, project} = resource;
  const request = oauth => new Promise((resolve, reject) => {
    const client = oauth.initTokenClient({
      client_id: clientId,
      scope: googleScope,
      include_granted_scopes: false,
      callback(response) {
        const seconds = Number(response.expires_in);
        if (!response.access_token || !Number.isFinite(seconds) || seconds <= 0
          || !oauth.hasGrantedAllScopes(response, googleScope)) {
          reject(new Error('Google 授权未完成，或未授予 Cloud 调用权限。'));
          return;
        }
        resolve({clientId, project, token: response.access_token, expires: Date.now() + seconds * 1000});
      },
      error_callback(error) {
        reject(new Error(error.type === 'popup_failed_to_open'
          ? '浏览器拦截了 Google 登录窗口。请允许弹出窗口，再点击登录。'
          : 'Google 登录窗口已关闭或授权失败。'));
      },
    });
    client.requestAccessToken({prompt: 'select_account'});
  });
  const oauth = globalThis.google?.accounts?.oauth2;
  return oauth ? request(oauth) : loadGoogleOAuth().then(request);
}

const upstreamMessages = {
  400: '接口拒绝了请求，请检查模型和画幅设置。',
  401: '接口未通过身份验证，请检查 API Key 或重新完成 Google 授权。',
  402: '接口拒绝调用，请检查账单或余额。',
  403: '接口拒绝调用，请检查模型权限、API 启用状态和账单。',
  404: '找不到接口或模型，请检查配置。',
  429: '已达到接口速率限制或配额，请稍后再试。',
};

async function outbound(url, options, send) {
  let response;
  try {
    response = await send(url, {
      ...options, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer',
      redirect: 'error', signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError'
      ? '连接接口超时。'
      : '无法从浏览器直连接口。请检查网络，以及接口是否允许本站跨域访问（CORS）。');
  }
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error(upstreamMessages[response.status] || '接口返回 HTTP ' + response.status + '。');
    error.status = response.status;
    throw error;
  }
  return response;
}

async function boundedBlob(response) {
  if (!response.body) throw new Error('接口未返回数据。');
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponse) {
        await reader.cancel();
        throw new Error('返回的图片数据过大。');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks);
}

function rasterMime(prefix) {
  if (prefix.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (prefix.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP') return 'image/webp';
}

function inline(data) {
  if (typeof data !== 'string' || data.length < 16 || data.length % 4 || /[^A-Za-z0-9+/=]/.test(data)) return null;
  const padding = data.indexOf('=');
  if (padding !== -1 && !/^={1,2}$/.test(data.slice(padding))) return null;
  const mime = rasterMime(atob(data.slice(0, 16)));
  return mime ? {mime, base64: data} : null;
}

async function linkedImage(value, origin, send) {
  const url = endpoint(value, origin);
  if (!url) throw new Error('接口返回了无效的外部图片地址。');
  const data = await boundedBlob(await outbound(url.href, {}, send));
  const mime = rasterMime(String.fromCharCode(...new Uint8Array(await data.slice(0, 12).arrayBuffer())));
  if (!mime) throw new Error('外部图片地址没有返回受支持的图片。');
  return {mime, blob: data.slice(0, data.size, mime)};
}

const array = value => Array.isArray(value) ? value : [];
async function extractImages(response, format, origin, send) {
  if (format === 'openai') {
    const images = [];
    for (const item of array(response.data)) {
      const image = inline(item?.b64_json);
      if (image) images.push(image);
      else if (item?.url) images.push(await linkedImage(item.url, origin, send));
    }
    return images;
  }
  return array(response.candidates).flatMap(candidate => array(candidate?.content?.parts).flatMap(part => {
    const image = part && !part.thought && inline((part.inlineData || part.inline_data)?.data);
    return image ? [image] : [];
  }));
}

export async function generateImage({provider, model: requestedModel, aspect, prompt}, resources, authorization, {
  origin = location.origin, send = globalThis.fetch,
} = {}) {
  const {providers} = describeImageResources(resources, authorization, origin);
  const entry = providers[provider];
  if (!entry?.ready) throw new Error('请先在「设置」中配置此接口。');
  const format = provider === 'custom' ? entry.format : provider;
  const model = requestedModel.trim() || entry.model;
  if (!validModel(model, format)) throw new Error('请填写有效的模型 ID。');
  if (!prompt.trim() || prompt.length > 16000) throw new Error('请输入 1 到 16000 字符的提示词。');
  const resource = resources[provider];
  let url;
  let headers = {'Content-Type': 'application/json'};
  if (provider === 'openai') {
    url = 'https://api.openai.com/v1/images/generations';
    headers.Authorization = 'Bearer ' + resource.key;
  } else if (provider === 'gemini') {
    url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
    headers['x-goog-api-key'] = resource.key;
  } else if (provider === 'gemini-oauth') {
    const token = currentGoogleToken(authorization, resource);
    if (!token) throw new Error('请先完成 Google 授权。');
    url = 'https://aiplatform.googleapis.com/v1/projects/' + resource.project
      + '/locations/global/publishers/google/models/' + model + ':generateContent';
    headers.Authorization = 'Bearer ' + token;
  } else {
    const customURL = endpoint(resource.url.replace('{model}', model), origin);
    if (!customURL) throw new Error('自定义接口必须指向本站以外的地址。');
    url = customURL.href;
    if (resource.key) {
      if (format === 'openai') headers.Authorization = 'Bearer ' + resource.key;
      else headers['x-goog-api-key'] = resource.key;
    }
  }
  const payload = format === 'openai'
    ? {model, prompt, ...(sizes[aspect] ? {size: sizes[aspect]} : {})}
    : {
        contents: [{role: 'user', parts: [{text: prompt}]}],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          ...(aspects[aspect] ? {imageConfig: {aspectRatio: aspects[aspect]}} : {}),
        },
      };
  const response = await outbound(url, {method: 'POST', headers, body: JSON.stringify(payload)}, send);
  const text = await (await boundedBlob(response)).text();
  let result;
  try { result = record(JSON.parse(text)); } catch { throw new Error('接口返回的内容不是有效 JSON。'); }
  const images = await extractImages(result, format, origin, send);
  if (!images.length) throw new Error('接口未返回可显示的图片，请检查模型或调整提示词。');
  return {model, images};
}
