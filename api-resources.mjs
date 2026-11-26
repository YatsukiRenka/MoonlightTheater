import {clearLegacyImageResources, readImageResources, resolveImageResourceConfig, verifyImageResourceConfig} from './image-client.mjs';
import {catalogPrice} from './image-usage.mjs';
import {t} from './i18n.mjs';

export const apiProviderNames = Object.freeze({
  openai: 'OpenAI', gemini: 'Gemini', 'gemini-oauth': 'Gemini · Google OAuth', custom: '自定义接口',
});

const storageKey = 'moonlight-image-resources-v2';
const identityFields = {
  openai: ['key'], gemini: ['key'], 'gemini-oauth': ['clientId', 'project'], custom: ['format', 'url', 'modelsURL', 'editsURL', 'key'],
};
const savedProofs = new WeakMap();
const resourceId = /^[A-Za-z0-9_-]{1,120}$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validatedProvider(provider) {
  if (typeof provider !== 'string' || !Object.hasOwn(apiProviderNames, provider)) throw new Error(t('请选择一个有效的接口。'));
}

function resourceName(name, provider) {
  const value = typeof name === 'string' ? name.trim() : '';
  return value || apiProviderNames[provider];
}

function unusedResourceName(provider, rows) {
  const base = apiProviderNames[provider];
  const used = new Set(rows.map(row => row.name));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(base + ' ' + suffix)) suffix++;
  return base + ' ' + suffix;
}

function savedConfig(provider, raw) {
  const config = {};
  for (const field of [...identityFields[provider], 'model']) {
    if (typeof raw[field] === 'string') config[field] = raw[field];
  }
  if (Array.isArray(raw.models)) config.models = [...new Set(raw.models.filter(model => typeof model === 'string'))];
  if (isObject(raw.prices)) {
    const prices = Object.entries(raw.prices).flatMap(([model, rate]) => {
      const price = catalogPrice({currency: rate?.currency, per_image: rate?.perImage,
        input_per_million_tokens: rate?.input, output_per_million_tokens: rate?.output});
      return price ? [[model, price]] : [];
    });
    config.prices = Object.fromEntries(prices);
  }
  return config;
}

export function readAPIResources(storage = globalThis.localStorage) {
  const raw = storage.getItem(storageKey);
  if (raw === null) {
    // Legacy provider IDs stay stable so the previous studio selection can be kept.
    return Object.entries(readImageResources(storage)).map(([provider, config]) => ({
      id: provider, provider, name: apiProviderNames[provider], config: savedConfig(provider, config),
    }));
  }
  let saved;
  try { saved = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(saved)) return [];
  const rows = new Map();
  for (const row of saved) {
    if (!isObject(row) || typeof row.id !== 'string' || !resourceId.test(row.id) || rows.has(row.id)
      || typeof row.provider !== 'string' || !Object.hasOwn(apiProviderNames, row.provider) || !isObject(row.config)) continue;
    const {id, provider} = row;
    rows.set(id, {id, provider, name: resourceName(row.name, provider), config: savedConfig(provider, row.config)});
  }
  return [...rows.values()];
}

function findTarget(rows, id, provider) {
  if (id === undefined || id === null || id === '') return undefined;
  const row = rows.find(saved => saved.id === id);
  if (!row || row.provider !== provider) throw new Error(t('此接口已移除或类型已变更，请重新打开设置。'));
  return row;
}

export async function verifyAPIResource(provider, values, {
  id, storage = globalThis.localStorage, origin = location.origin, send, authorization, authorize,
} = {}) {
  validatedProvider(provider);
  const row = findTarget(readAPIResources(storage), id, provider);
  const verified = await verifyImageResourceConfig(provider, values, {
    previous: row?.config, origin, send, authorization: row ? authorization : undefined, authorize,
  });
  const proof = Object.freeze(Object.defineProperty({models: verified.models, prices: verified.prices}, 'authorization', {
    value: verified.authorization,
  }));
  savedProofs.set(proof, {id: row?.id, provider, origin, storage, verified});
  return proof;
}

function persistResources(storage, rows) {
  const previous = storage.getItem(storageKey);
  try { storage.setItem(storageKey, JSON.stringify(rows)); }
  catch { throw new Error(t('浏览器无法保存本地配置。')); }
  // Retire the migrated copy after the new one is safely recorded.
  try { clearLegacyImageResources(storage); }
  catch (error) {
    try {
      if (previous === null) storage.removeItem(storageKey);
      else storage.setItem(storageKey, previous);
    } catch {}
    throw new Error(t('浏览器无法移除旧版接口配置。'), {cause: error});
  }
}

function withWriteLock(action) {
  const locks = globalThis.navigator?.locks;
  // Return a promise so a failed validation still completes the lock callback.
  return typeof locks?.request === 'function' ? locks.request(storageKey, async () => action()) : action();
}

export async function saveAPIResource({id, provider, name, values, verification}, {
  storage = globalThis.localStorage, origin = location.origin,
} = {}) {
  validatedProvider(provider);
  return withWriteLock(() => {
    const all = readAPIResources(storage);
    const previous = findTarget(all, id, provider);
    const match = savedProofs.get(verification);
    if (verification && (!match || match.storage !== storage || match.origin !== origin
      || match.provider !== provider || match.id !== previous?.id)) throw new Error(t('请先验证当前接口配置并获取模型。'));
    const label = (typeof name === 'string' ? name.trim() : '') || previous?.name || unusedResourceName(provider, all);
    if (label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) throw new Error(t('接口名称最多可填写 80 个字符。'));
    const config = resolveImageResourceConfig(provider, values, {previous: previous?.config, origin, verification: match?.verified});
    const row = {id: previous?.id ?? 'api-' + crypto.randomUUID(), provider, name: label, config};
    const updated = previous ? all.map(saved => saved.id === previous.id ? row : saved) : [...all, row];
    persistResources(storage, updated);
    if (verification) savedProofs.delete(verification);
    return row;
  });
}

export async function removeAPIResource(id, {storage = globalThis.localStorage} = {}) {
  return withWriteLock(() => {
    const rows = readAPIResources(storage);
    const remaining = rows.filter(row => row.id !== id);
    if (remaining.length === rows.length) return false;
    // An empty newer library must not fall back to resources deleted after migration.
    persistResources(storage, remaining);
    return true;
  });
}
