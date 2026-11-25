import {catalogPrice, modelPrice, summarizeImageUsage} from './image-usage.mjs';

const resourceKey = 'moonlight-image-resources-v1';
const resourceIds = ['openai', 'gemini', 'gemini-oauth', 'custom'];
const projectPattern = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,20})$/;
const clientPattern = /^[A-Za-z0-9_-]{4,220}\.apps\.googleusercontent\.com$/;
const googleScope = 'https://www.googleapis.com/auth/cloud-platform';
const sizes = {portrait: '1024x1536', square: '1024x1024', landscape: '1536x1024'};
const aspects = {portrait: '2:3', square: '1:1', landscape: '3:2'};
const maxResponse = 20 * 1024 * 1024;
const verifications = new WeakMap();

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

const providerFormat = (id, resource) => id === 'custom' ? resource.format : id === 'openai' ? 'openai' : 'gemini';
const array = value => Array.isArray(value) ? value : [];
function savedModels(id, resource) {
  return [...new Set(array(resource?.models).filter(model => validModel(model, providerFormat(id, resource))))];
}

function modelListURL(resource, origin) {
  const generation = endpoint(resource.url, origin);
  if (!generation) return null;
  if (resource.modelsURL) {
    const catalog = endpoint(resource.modelsURL, origin);
    return catalog?.origin === generation.origin ? catalog : null;
  }
  const suffix = resource.format === 'gemini'
    ? /\/(?:\{model\}|%7Bmodel%7D):generateContent$/
    : /\/images\/generations\/?$/;
  if (!suffix.test(generation.pathname)) return null;
  generation.pathname = generation.pathname.replace(suffix, resource.format === 'gemini' ? '' : '/models');
  return generation;
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
    const modelsURL = field('modelsURL');
    if (url.length > 2048 || !validCustom(url, format, origin)) {
      throw new Error(format === 'gemini'
        ? '请填写包含 /models/{model}:generateContent 的外部 Gemini 接口地址。'
        : '请填写外部 HTTPS 接口或本机回环 HTTP 地址。');
    }
    const draft = {url, format, key, modelsURL};
    if (modelsURL.length > 2048 || !modelListURL(draft, origin)) {
      throw new Error('请填写与生图接口同源的模型列表地址。');
    }
    return draft;
  }
  return {key};
}

export function updateImageResource(id, action, values, {
  storage = globalThis.localStorage, origin = location.origin, verification,
} = {}) {
  if (!resourceIds.includes(id) || !['save', 'remove'].includes(action)) throw new Error('请选择一个有效的接口。');
  const resources = readImageResources(storage);
  if (action === 'remove') delete resources[id];
  else {
    const previous = resources[id];
    const draft = validateResource(id, record(values), previous, origin);
    const verified = verifications.get(verification);
    let models;
    let prices = {};
    if (verified?.id === id && JSON.stringify(verified.draft) === JSON.stringify(draft)) {
      models = verification.models;
      prices = verification.prices;
    } else if (!verification && previous
      && Object.entries(draft).every(([name, value]) => value === previous[name])) {
      models = savedModels(id, previous);
      prices = previous.prices || {};
    }
    if (!models?.length) throw new Error('请先验证当前接口配置并获取模型。');
    if (!models.includes(values.model)) throw new Error('请从返回的列表中选择一个模型。');
    resources[id] = {...draft, models, model: values.model, prices};
  }
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
  const customReady = validCustom(custom.url, format, origin) && modelListURL({...custom, format}, origin)
    && (!custom.key || validKey(custom.key));
  const providers = {
    openai: {ready: validKey(saved.openai?.key)},
    gemini: {ready: validKey(saved.gemini?.key)},
    'gemini-oauth': {
      ready: clientPattern.test(oauth.clientId || '') && projectPattern.test(oauth.project || ''),
      connected: Boolean(currentGoogleToken(authorization, oauth)),
    },
    custom: {ready: Boolean(customReady), format},
  };
  for (const id of resourceIds) {
    const models = savedModels(id, saved[id]);
    const model = models.includes(saved[id]?.model) ? saved[id].model : '';
    Object.assign(providers[id], {ready: providers[id].ready && Boolean(model), models, model});
  }
  const resources = Object.fromEntries(resourceIds.map(id => [
    id, {
      saved: Boolean(saved[id]), hasSecret: Boolean(saved[id]?.key), ready: providers[id].ready,
      models: providers[id].models, model: providers[id].model, prices: saved[id]?.prices || {},
    },
  ]));
  Object.assign(resources['gemini-oauth'], {clientId: oauth.clientId || '', project: oauth.project || ''});
  Object.assign(resources.custom, {url: custom.url || '', format, modelsURL: custom.modelsURL || ''});
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

async function outbound(url, options, send, timeout = 180_000) {
  let response;
  try {
    response = await send(url, {
      ...options, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer',
      redirect: 'error', signal: AbortSignal.timeout(timeout),
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

async function readAPIJSON(response) {
  const text = await (await boundedBlob(response)).text();
  try { return record(JSON.parse(text)); } catch { throw new Error('接口返回的内容不是有效 JSON。'); }
}

function hasImageOutput(row, id, provider, format) {
  const output = row?.outputModalities ?? row?.output_modalities ?? row?.supportedOutputTypes
    ?? row?.architecture?.output_modalities;
  if (format === 'gemini' && Array.isArray(row?.supportedGenerationMethods)
    && !row.supportedGenerationMethods.includes('generateContent')) return false;
  if (Array.isArray(output) && output.length) return output.some(type => String(type).toLowerCase() === 'image');
  if (provider === 'custom') return true;
  return format === 'openai' ? /^(?:gpt-image-|chatgpt-image-latest$)/.test(id)
    : /^gemini-(?:.*-image(?:-|$)|nano-banana(?:-|$))/.test(id);
}

function pageModels(response, provider, format) {
  if (provider === 'gemini-oauth') {
    return array(response.publisherModels).flatMap(row => {
      const ids = [row?.publisherModelTemplate, row?.versionId, row?.name]
        .map(value => typeof value === 'string' ? value.split('/').at(-1).split('@')[0] : '');
      const id = ids.find(id => id.startsWith('gemini-') && validModel(id, format) && hasImageOutput(row, id, provider, format));
      return id ? [{id, price: catalogPrice(row?.pricing)}] : [];
    });
  }
  const rows = format === 'openai' ? array(response.data) : array(response.models);
  return rows.flatMap(row => {
    const value = typeof row === 'string' ? row : format === 'openai' ? row?.id : row?.name;
    const id = format === 'gemini' && typeof value === 'string' ? value.replace(/^models\//, '') : value;
    return validModel(id, format) && hasImageOutput(row, id, provider, format)
      ? [{id, price: catalogPrice(row?.pricing)}] : [];
  });
}

function providerAuthentication(provider, resource, authorization) {
  if (provider === 'gemini-oauth') {
    const token = currentGoogleToken(authorization, resource);
    if (!token) throw new Error('请先完成 Google 授权。');
    return {Authorization: 'Bearer ' + token};
  }
  if (!resource.key) return {};
  return providerFormat(provider, resource) === 'openai'
    ? {Authorization: 'Bearer ' + resource.key} : {'x-goog-api-key': resource.key};
}

export async function verifyImageResource(provider, values, {
  storage = globalThis.localStorage, origin = location.origin, send = globalThis.fetch,
  authorization, authorize = authorizeGoogle,
} = {}) {
  if (!resourceIds.includes(provider)) throw new Error('请选择一个有效的接口。');
  const draft = validateResource(provider, record(values), readImageResources(storage)[provider], origin);
  const format = providerFormat(provider, draft);
  if (provider === 'gemini-oauth' && !currentGoogleToken(authorization, draft)) authorization = await authorize(draft);
  const headers = providerAuthentication(provider, draft, authorization);
  let catalog;
  if (provider === 'openai') catalog = new URL('https://api.openai.com/v1/models');
  else if (provider === 'gemini') catalog = new URL('https://generativelanguage.googleapis.com/v1beta/models');
  else if (provider === 'gemini-oauth') {
    catalog = new URL('https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/google/models');
    headers['x-goog-user-project'] = draft.project;
  } else catalog = modelListURL(draft, origin);
  const models = new Set();
  const prices = new Map();
  const tokens = new Set();
  const firstPage = catalog.href;
  for (;;) {
    const response = await readAPIJSON(await outbound(catalog.href, {headers}, send, 20_000));
    for (const {id, price} of pageModels(response, provider, format)) {
      models.add(id);
      if (price) prices.set(id, Object.freeze(price));
    }
    const next = response.nextPageToken;
    if (!next) break;
    if (typeof next !== 'string' || tokens.has(next) || tokens.size >= 20) throw new Error('无法读取完整模型列表。');
    tokens.add(next);
    catalog.searchParams.set('pageToken', next);
  }
  if (!models.size) throw new Error('接口未返回可选的生图模型。');
  if (provider === 'custom' && draft.key) {
    let status;
    try {
      const openCatalog = await outbound(firstPage, {}, send, 20_000);
      await openCatalog.body?.cancel();
    } catch (error) {
      status = error.status;
    }
    if (![401, 403].includes(status)) throw new Error('此模型列表无法校验网关密钥。请填写需要认证且支持 CORS 的模型列表地址。');
  }
  const verification = Object.freeze({
    models: Object.freeze([...models].sort((a, b) => a.localeCompare(b, 'en', {numeric: true}))),
    prices: Object.freeze(Object.fromEntries(prices)),
    authorization: provider === 'gemini-oauth' ? authorization : undefined,
  });
  verifications.set(verification, {id: provider, draft});
  return verification;
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
  const resource = resources[provider];
  const format = providerFormat(provider, resource);
  const model = requestedModel || entry.model;
  if (!entry.models.includes(model)) throw new Error('请从已验证的模型列表中选择。');
  if (!prompt.trim() || prompt.length > 16000) throw new Error('请输入 1 到 16000 字符的提示词。');
  let url;
  if (provider === 'openai') {
    url = 'https://api.openai.com/v1/images/generations';
  } else if (provider === 'gemini') {
    url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  } else if (provider === 'gemini-oauth') {
    url = 'https://aiplatform.googleapis.com/v1/projects/' + resource.project
      + '/locations/global/publishers/google/models/' + model + ':generateContent';
  } else {
    const customURL = endpoint(resource.url.replace('{model}', model), origin);
    if (!customURL) throw new Error('自定义接口必须指向本站以外的地址。');
    url = customURL.href;
  }
  const headers = {'Content-Type': 'application/json', ...providerAuthentication(provider, resource, authorization)};
  const payload = format === 'openai'
    ? {model, prompt, ...(sizes[aspect] ? {size: sizes[aspect]} : {})}
    : {
        contents: [{role: 'user', parts: [{text: prompt}]}],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          ...(aspects[aspect] ? {imageConfig: {aspectRatio: aspects[aspect]}} : {}),
        },
      };
  const started = performance.now();
  const response = await outbound(url, {method: 'POST', headers, body: JSON.stringify(payload)}, send);
  const result = await readAPIJSON(response);
  const images = await extractImages(result, format, origin, send);
  if (!images.length) throw new Error('接口未返回可显示的图片，请检查模型或调整提示词。');
  const usage = summarizeImageUsage(result, format, modelPrice(provider, model, resource.prices), images.length);
  return {model, images, metrics: {...usage, elapsed: performance.now() - started}};
}
