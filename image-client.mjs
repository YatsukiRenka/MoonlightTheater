import {rasterMime, sanitizeSVG} from './image-file.mjs';
import {catalogPrice, combineImageUsage, modelPrice, summarizeImageUsage} from './image-usage.mjs';
import {imageCapabilities, legacyImageOptions, prepareImageOptions, validateReferenceImages} from './image-options.mjs';
import {isResponseTimeout, readImageStream, readResponseChunk} from './image-stream.mjs';
import {requestGoogleToken, validGoogleClientId} from './google-oauth.mjs';

const resourceKey = 'moonlight-image-resources-v1';
const resourceIds = ['openai', 'gemini', 'gemini-oauth', 'custom'];
const projectPattern = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,20})$/;
const googleScope = 'https://www.googleapis.com/auth/cloud-platform';
const maxResponse = 128 * 1024 * 1024;
const maxCatalogResponse = 20 * 1024 * 1024;
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

export function clearLegacyImageResources(storage) {
  if (storage.getItem(resourceKey) !== null) storage.removeItem(resourceKey);
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

function editURL(resource, origin) {
  const generation = endpoint(resource.url, origin);
  if (!generation) return null;
  if (resource.editsURL) {
    const edit = endpoint(resource.editsURL, origin);
    return edit?.origin === generation.origin ? edit.href : null;
  }
  if (!/\/images\/generations\/?$/.test(generation.pathname)) return null;
  generation.pathname = generation.pathname.replace(/\/generations\/?$/, '/edits');
  return generation.href;
}

function validKey(key) {
  return typeof key === 'string' && Boolean(key) && key.length <= 1024 && !/[^!-~]/.test(key);
}

function validateResource(id, values, previous, origin) {
  const field = name => typeof values[name] === 'string' ? values[name].trim() : '';
  const enteredKey = field('key');
  const key = enteredKey || (id === 'custom' && values.clearKey === true ? '' : previous?.key || '');
  if (id !== 'gemini-oauth' && (id !== 'custom' || key) && !validKey(key)) {
    throw new Error('请填写有效的 API Key。');
  }
  if (id === 'gemini-oauth') {
    const clientId = field('clientId');
    const project = field('project');
    if (!validGoogleClientId(clientId)) throw new Error('请填写 Google Cloud 的 Web 应用 Client ID。');
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
    if (key && !enteredKey && (format !== previous?.format || endpoint(url, origin).origin !== endpoint(previous?.url, origin)?.origin)) {
      throw new Error('更换自定义接口域名或协议时，请填写该接口的 API Key，或清除已保存的密钥。');
    }
    const editsURL = format === 'openai' ? field('editsURL') : '';
    const draft = {url, format, key, modelsURL, editsURL};
    if (modelsURL.length > 2048 || !modelListURL(draft, origin)) {
      throw new Error('请填写与生图接口同源的模型列表地址。');
    }
    if (editsURL && (editsURL.length > 2048 || !editURL(draft, origin))) {
      throw new Error('请填写与生图接口同源的参考图接口地址。');
    }
    return draft;
  }
  return {key};
}

export function resolveImageResourceConfig(provider, values, {previous, origin = location.origin, verification} = {}) {
  if (!resourceIds.includes(provider)) throw new Error('请选择一个有效的接口。');
  const input = record(values);
  const draft = validateResource(provider, input, previous, origin);
  const verified = verifications.get(verification);
  let models;
  let prices = {};
  if (verified?.id === provider && verified.origin === origin && JSON.stringify(verified.draft) === JSON.stringify(draft)) {
    models = verification.models;
    prices = verification.prices;
  } else if (!verification && previous
    && Object.entries(draft).every(([name, value]) => value === (name === 'editsURL' ? previous[name] || '' : previous[name]))) {
    models = savedModels(provider, previous);
    prices = previous.prices || {};
  }
  if (!models?.length) throw new Error('请先验证当前接口配置并获取模型。');
  if (!models.includes(input.model)) throw new Error('请从返回的列表中选择一个模型。');
  return {...draft, models, model: input.model, prices};
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
      ready: validGoogleClientId(oauth.clientId) && projectPattern.test(oauth.project || ''),
      connected: Boolean(currentGoogleToken(authorization, oauth)),
    },
    custom: {ready: Boolean(customReady), format, supportsReferences: format === 'gemini' || Boolean(editURL(custom, origin))},
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
  Object.assign(resources.custom, {url: custom.url || '', format, modelsURL: custom.modelsURL || '', editsURL: custom.editsURL || ''});
  return {providers, resources, canConfigure: true};
}

export function authorizeGoogle(resource) {
  if (!validGoogleClientId(resource?.clientId) || !projectPattern.test(resource?.project || '')) {
    throw new Error('请先保存 Google OAuth 配置。');
  }
  const {clientId, project} = resource;
  return requestGoogleToken(clientId, googleScope, 'Google 授权未完成，或未授予 Cloud 调用权限。')
    .then(auth => ({clientId, project, ...auth}));
}

const upstreamMessages = {
  400: '接口拒绝了请求，请检查所选模型、高级设置与参考图片。',
  401: '接口未通过身份验证，请检查 API Key 或重新完成 Google 授权。',
  402: '接口拒绝调用，请检查账单或余额。',
  403: '接口拒绝调用，请检查模型权限、API 启用状态和账单。',
  404: '找不到接口或模型，请检查配置。',
  429: '已达到接口速率限制或配额，请稍后再试。',
};

const catalogTimeout = 20_000;
const downloadTimeout = 180_000;
const generationTimeout = 600_000;
const streamingTimeout = 900_000;

async function outbound(url, options, send, timeout) {
  const signal = AbortSignal.timeout(timeout);
  let response;
  try {
    response = await send(url, {
      ...options, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer',
      redirect: 'error', signal,
    });
  } catch (error) {
    throw new Error(isResponseTimeout(error, signal)
      ? '连接接口超时。'
      : '无法从浏览器直连接口。请检查网络，以及接口是否允许本站跨域访问（CORS）。', {cause: error});
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const error = new Error(upstreamMessages[response.status] || '接口返回 HTTP ' + response.status + '。');
    error.status = response.status;
    throw error;
  }
  return {response, signal};
}

async function boundedBlob({response, signal}, limit = maxResponse) {
  if (!response.body) throw new Error('接口未返回数据。');
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const {value, done} = await readResponseChunk(reader, signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new Error('返回的图片数据过大。');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks);
}

async function readAPIJSON(request, limit) {
  const text = await (await boundedBlob(request, limit)).text();
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

export async function verifyImageResourceConfig(provider, values, {
  previous, origin = location.origin, send = globalThis.fetch,
  authorization, authorize = authorizeGoogle,
} = {}) {
  if (!resourceIds.includes(provider)) throw new Error('请选择一个有效的接口。');
  const draft = validateResource(provider, record(values), previous, origin);
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
    const response = await readAPIJSON(await outbound(catalog.href, {headers}, send, catalogTimeout), maxCatalogResponse);
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
      const {response} = await outbound(firstPage, {}, send, catalogTimeout);
      await response.body?.cancel();
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
  verifications.set(verification, {id: provider, origin, draft});
  return verification;
}

function inline(data, output) {
  if (typeof data !== 'string' || data.length < 16 || data.length % 4 || /[^A-Za-z0-9+/=]/.test(data)) return null;
  const padding = data.indexOf('=');
  if (padding !== -1 && !/^={1,2}$/.test(data.slice(padding))) return null;
  const mime = rasterMime(atob(data.slice(0, 16)));
  if (mime) return {mime, base64: data};
  const blob = output === 'svg' ? sanitizeSVG(new TextDecoder().decode(Uint8Array.from(atob(data), ch => ch.charCodeAt(0)))) : null;
  return blob ? {mime: blob.type, blob} : null;
}

async function linkedImage(value, origin, send) {
  const url = endpoint(value, origin);
  if (!url) throw new Error('接口返回了无效的外部图片地址。');
  const data = await boundedBlob(await outbound(url.href, {}, send, downloadTimeout));
  const mime = rasterMime(String.fromCharCode(...new Uint8Array(await data.slice(0, 12).arrayBuffer())));
  if (!mime) throw new Error('外部图片地址没有返回受支持的图片。');
  return {mime, blob: data.slice(0, data.size, mime)};
}

async function extractImages(response, format, origin, send, output) {
  if (format === 'openai') {
    const images = [];
    for (const item of array(response.data)) {
      const image = inline(item?.b64_json, output);
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

async function base64File(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let raw = '';
  for (let start = 0; start < bytes.length; start += 32768) {
    raw += String.fromCharCode(...bytes.subarray(start, start + 32768));
  }
  return btoa(raw);
}

async function geminiRequest(prompt, references, settings, caps) {
  const {aspectRatio, imageSize, thinkingLevel, modalities, search, mimeType, compressionQuality, personGeneration} = settings;
  const parts = [{text: prompt}, ...await Promise.all(references.map(async file => ({
    inlineData: {mimeType: file.type, data: await base64File(file)},
  })))];
  const imageConfig = {...(aspectRatio && {aspectRatio}), ...(imageSize && {imageSize}), ...(personGeneration && {personGeneration})};
  if (caps.vertex && mimeType) imageConfig.imageOutputOptions = {mimeType, ...(compressionQuality !== undefined && {compressionQuality})};
  const generationConfig = {responseModalities: modalities === 'image' ? ['IMAGE'] : ['TEXT', 'IMAGE']};
  if (Object.keys(imageConfig).length) generationConfig.imageConfig = imageConfig;
  if (thinkingLevel) generationConfig.thinkingConfig = {thinkingLevel};
  if (caps.developer && mimeType) generationConfig.responseFormat = {image: {mimeType: 'IMAGE_JPEG'}};
  const request = {contents: [{role: 'user', parts}], generationConfig};
  if (search) {
    const searchTypes = {...(search !== 'images' && {webSearch: {}}), ...(search !== 'web' && {imageSearch: {}})};
    request.tools = [{googleSearch: search === 'web' ? {} : {searchTypes}}];
  }
  return JSON.stringify(request);
}

function geminiDetails(response) {
  const text = [];
  const sources = [];
  for (const candidate of array(response.candidates)) {
    for (const part of array(candidate?.content?.parts)) {
      if (!part?.thought && typeof part?.text === 'string') text.push(part.text.slice(0, 2000));
    }
    const grounding = candidate?.groundingMetadata || candidate?.grounding_metadata;
    for (const chunk of array(grounding?.groundingChunks || grounding?.grounding_chunks)) {
      const value = chunk?.image || chunk?.web;
      try {
        const url = new URL(value.sourceUri ?? value.source_uri ?? value.uri);
        if (url.protocol === 'https:' && !url.username && !url.password) {
          sources.push({url: url.href, title: String(value.title || url.hostname).slice(0, 160)});
        }
      } catch {}
    }
  }
  return {text: text.join('\n').slice(0, 4000), sources};
}

async function readStreamingImages(request, onPartial, receive) {
  await readImageStream(request, (type, event) => {
    if (type === 'error') throw new Error('接口报告流式生图失败。');
    if (type === 'image_generation.partial_image' || type === 'image_edit.partial_image') {
      const img = inline(event.b64_json);
      if (img) onPartial(img);
    }
    if (type === 'image_generation.completed' || type === 'image_edit.completed') {
      const img = inline(event.b64_json);
      if (img) receive([img], event);
    }
  }, maxResponse);
}

export async function generateImage({provider, model: requestedModel, aspect, prompt, options = {}, references = [], editLayer}, resources, authorization, {
  origin = location.origin, send = globalThis.fetch, onPartial = () => {}, onProgress = () => {},
} = {}) {
  const {providers} = describeImageResources(resources, authorization, origin);
  const entry = providers[provider];
  if (!entry?.ready) throw new Error('请先在「设置」中配置此接口。');
  const resource = resources[provider];
  const format = providerFormat(provider, resource);
  const model = requestedModel || entry.model;
  if (!entry.models.includes(model)) throw new Error('请从已验证的模型列表中选择。');
  if (!prompt.trim() || prompt.length > 16000) throw new Error('请输入 1 到 16000 字符的提示词。');
  const caps = imageCapabilities(provider, format, model);
  validateReferenceImages(references, caps);
  const hasReferences = references.length > 0;
  const legacy = legacyImageOptions(format, aspect);
  const settings = prepareImageOptions(caps, {...legacy, ...options}, hasReferences);
  const {n, partial_images, ...params} = settings;
  const streaming = Boolean(partial_images);
  const requests = format === 'gemini' || streaming ? Number(n || 1) : 1;
  let url;
  if (provider === 'openai') {
    url = 'https://api.openai.com/v1/images/' + (hasReferences ? 'edits' : 'generations');
  } else if (provider === 'gemini') {
    url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  } else if (provider === 'gemini-oauth') {
    url = 'https://aiplatform.googleapis.com/v1/projects/' + resource.project
      + '/locations/global/publishers/google/models/' + model + ':generateContent';
  } else {
    const customURL = endpoint(resource.url.replace('{model}', model), origin);
    if (!customURL) throw new Error('自定义接口必须指向本站以外的地址。');
    url = format === 'openai' && hasReferences ? editURL(resource, origin) : customURL.href;
    if (!url) throw new Error('请先在设置中填写兼容的参考图编辑接口。');
  }
  const headers = providerAuthentication(provider, resource, authorization);
  const started = performance.now();
  let body;
  if (format === 'openai') {
    const payload = {model, prompt, ...params, ...(streaming ? {stream: true, partial_images} : n !== undefined ? {n} : {})};
    if (hasReferences) {
      body = new FormData();
      for (const [key, value] of Object.entries(payload)) body.set(key, String(value));
      for (const file of references) body.append(references.length === 1 ? 'image' : 'image[]', file, file.name || 'reference');
      if (editLayer) {
        const {type, file} = editLayer;
        if (!file || file.type !== 'image/png' || file.size === 0 || file.size >= 4 * 1024 * 1024
          || (type !== 'mask' && !(type === 'markup' && caps.modern))) {
          throw new Error('遮罩或标注图需为当前模型支持的 PNG，大小小于 4 MB。');
        }
        body.set(type, file, file.name || type + '.png');
      }
    } else body = JSON.stringify(payload);
  } else body = await geminiRequest(prompt, references, params, caps);
  if (typeof body === 'string') headers['Content-Type'] = 'application/json';
  const rate = modelPrice(provider, model, resource.prices);
  const images = [];
  const usages = [];
  const texts = [];
  const sources = new Map();
  let warning;
  let warningStatus;
  function receive(batch, result) {
    images.push(...batch);
    usages.push(summarizeImageUsage(result, format, rate, batch.length));
  }
  for (let index = 0; index < requests; index++) {
    try {
      onProgress(index + 1, requests);
      const initialCount = images.length;
      const timeout = streaming ? streamingTimeout : generationTimeout;
      const request = await outbound(url, {method: 'POST', headers, body}, send, timeout);
      if (streaming && request.response.headers.get('content-type')?.includes('text/event-stream')) {
        await readStreamingImages(request, onPartial, receive);
      } else {
        const result = await readAPIJSON(request);
        receive(await extractImages(result, format, origin, send, params.output_format), result);
        if (format === 'gemini') {
          const details = geminiDetails(result);
          if (details.text) texts.push(details.text);
          for (const source of details.sources) sources.set(source.url, source);
        }
      }
      if (images.length === initialCount) throw new Error('接口未返回可显示的图片，请检查模型或调整提示词。');
    } catch (error) {
      if (!images.length) throw error;
      warning = error.message;
      warningStatus = error.status;
      break;
    }
  }
  if (!images.length) throw new Error('接口未返回可显示的图片，请检查模型或调整提示词。');
  const usage = combineImageUsage(usages);
  const extraCharges = Boolean(params.search || params.output_format === 'svg');
  return {model, images, warning, warningStatus, text: texts.join('\n\n').slice(0, 5000), sources: [...sources.values()],
    metrics: {...usage, extraCharges, elapsed: performance.now() - started}};
}
