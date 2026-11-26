import {
  discardDriveImageRendition, downloadDriveImageObject, driveImageHeader, listDriveImageManifests, readDriveImageChecksum,
  uploadDriveImageObject,
} from './drive-history.mjs';
import {defaultHistoryLimits, historyLimitRanges} from './history-limits.mjs';
import {sha256} from './vendor/noble-sha256.mjs';
import {t} from './i18n.mjs';

const mib = 1024 * 1024;
const version = 1;
const chunkSize = mib;
const manifestLimit = 2 * mib;
const manifestCacheLimit = historyLimitRanges.imageCount.max;
const passwordProbeLimit = 3;
const tierLimits = {thumbnail: 8 * mib, preview: 32 * mib, original: 512 * mib};
const tiers = Object.keys(tierLimits);
const rasterTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const originalTypes = new Set([...rasterTypes, 'image/gif', 'image/svg+xml']);
const objectId = /^[A-Za-z0-9_-]{1,256}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const magic = encoder.encode(driveImageHeader);
const saltSize = 16;
const nonceSize = 12;
const tagSize = 16;
const headerSize = magic.length + saltSize + nonceSize + 4;
const encodedSize = bytes => headerSize + bytes + Math.ceil(bytes / chunkSize) * tagSize;
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const validId = value => typeof value === 'string' && objectId.test(value);
const invalidManifest = () => new Error(t('云端生图记录格式无效。'));
const invalidImage = () => new Error(t('密码不正确，或云端图片未通过完整性校验。'));

// Web Crypto does not offer incremental digests. The vendored SHA-256 reads large files in bounded chunks.
async function ciphertextChecksum(blob) {
  const digest = sha256.create();
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const chunk = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
    digest.update(chunk);
  }
  return hex(digest.digest());
}

function validMedia(tier, mime, bytes) {
  return (tier === 'original' ? originalTypes : rasterTypes).has(mime)
    && Number.isSafeInteger(bytes) && bytes > 0 && bytes <= tierLimits[tier];
}

function imageContext(batchId, index, tier) {
  return JSON.stringify([batchId, index, tier]);
}

function projectMetrics(metrics) {
  if (!Number.isFinite(metrics?.elapsed) || metrics.elapsed < 0) return undefined;
  const numeric = value => Number.isFinite(value) && value >= 0;
  let tokens;
  if (metrics.tokens && typeof metrics.tokens === 'object') {
    tokens = {};
    for (const key of ['input', 'output', 'thinking', 'total', 'inputImage', 'outputImage']) {
      const value = metrics.tokens[key];
      if (value === null || numeric(value)) tokens[key] = value;
    }
  }
  const cost = metrics.cost;
  const finiteCost = cost && numeric(cost.value) && /^[A-Z]{3}$/.test(cost.currency)
    && ['reported', 'catalog', 'official'].includes(cost.source);
  return {elapsed: metrics.elapsed, tokens, cost: finiteCost ? {
    value: cost.value, currency: cost.currency, source: cost.source, upperBound: cost.upperBound === true,
  } : null, extraCharges: metrics.extraCharges === true};
}

function projectRecord(record) {
  if (!record || !validId(record.id) || !Number.isFinite(record.time) || record.time < 0 || record.time > 8.64e15
    || !['zh', 'en'].includes(record.language) || typeof record.prompt !== 'string' || record.prompt.length > 65_536
    || !['model', 'provider', 'seed'].every(key => typeof record[key] === 'string' && record[key].length <= 1024)) {
    throw invalidManifest();
  }
  const {id, model, provider, prompt, seed, language, time} = record;
  const text = typeof record.text === 'string' ? record.text.slice(0, 16_384) : undefined;
  const sources = [];
  for (const item of Array.isArray(record.sources) ? record.sources.slice(0, 100) : []) {
    if (typeof item?.url !== 'string' || item.url.length > 4096 || typeof item.title !== 'string') continue;
    try {
      const link = new URL(item.url);
      if (link.protocol === 'https:' && !link.username && !link.password) sources.push({url: link.href, title: item.title.slice(0, 512)});
    } catch {}
  }
  return {id, model, provider, prompt, seed, language, time, metrics: projectMetrics(record.metrics), text, sources};
}

function manifestRecord(data, manifestId) {
  if (data?.version !== version || !Array.isArray(data.renditions) || !data.renditions.length || data.renditions.length > 100) {
    throw invalidManifest();
  }
  const record = projectRecord(data.record);
  for (const item of data.renditions) {
    for (const tier of tiers) {
      const detail = item?.details?.[tier];
      if (!validId(item?.[tier]) || !detail || !validMedia(tier, detail.mime, detail.bytes)
        || typeof detail.digest !== 'string' || !digestPattern.test(detail.digest)) throw invalidManifest();
    }
    if (item.mime !== item.details.original.mime || item.bytes !== item.details.original.bytes) throw invalidManifest();
  }
  const size = data.renditions.reduce((total, item) => total + item.bytes, 0);
  return {...record, size, cloud: {version, manifestId, batchId: record.id, renditions: data.renditions}};
}

function randomHeader(bytes, salt) {
  const header = new Uint8Array(headerSize);
  header.set(magic);
  header.set(salt, magic.length);
  crypto.getRandomValues(header.subarray(magic.length + saltSize, headerSize - 4));
  new DataView(header.buffer).setUint32(headerSize - 4, bytes);
  return header;
}

async function transform(blob, header, key, context, decrypting, mime) {
  const bytes = new DataView(header.buffer).getUint32(headerSize - 4);
  const contextBytes = encoder.encode(context);
  const associatedData = new Uint8Array(headerSize + contextBytes.length + 4);
  associatedData.set(header);
  associatedData.set(contextBytes, headerSize);
  const associatedView = new DataView(associatedData.buffer);
  const nonce = header.slice(magic.length + saltSize, headerSize - 4);
  const nonceView = new DataView(nonce.buffer);
  const counterOffset = nonceSize - 4;
  const nonceSeed = nonceView.getUint32(counterOffset);
  const algorithm = {name: 'AES-GCM', iv: nonce, additionalData: associatedData, tagLength: tagSize * 8};
  const parts = decrypting ? [] : [header];
  const digestBytes = mime ? new Uint8Array(Math.ceil(bytes / chunkSize) * 32) : null;
  let offset = decrypting ? headerSize : 0;
  for (let index = 0, remaining = bytes; remaining > 0; index++) {
    const size = Math.min(chunkSize, remaining);
    const inputSize = size + (decrypting ? tagSize : 0);
    const chunk = await blob.slice(offset, offset + inputSize).arrayBuffer();
    nonceView.setUint32(counterOffset, nonceSeed ^ index);
    associatedView.setUint32(associatedData.length - 4, index);
    let result;
    try {
      result = decrypting ? await crypto.subtle.decrypt(algorithm, key, chunk) : await crypto.subtle.encrypt(algorithm, key, chunk);
    } catch (error) { if (decrypting) throw invalidImage(); throw error; }
    parts.push(new Blob([result]));
    if (digestBytes) digestBytes.set(new Uint8Array(await crypto.subtle.digest('SHA-256', decrypting ? result : chunk)), index * 32);
    remaining -= size;
    offset += inputSize;
  }
  // Hash the ordered SHA-256 chunk digests so large images can be checked with bounded buffers.
  const digest = digestBytes ? hex(await crypto.subtle.digest('SHA-256', digestBytes)) : undefined;
  return {blob: new Blob(parts, {type: decrypting && mime ? mime : 'application/octet-stream'}), digest};
}

export function createCloudImageStore(auth, password, {send = globalThis.fetch} = {}) {
  if (typeof password !== 'string' || !password.length || password.length > 1024) throw new Error(t('请输入有效的云端备份密码。'));
  if (!globalThis.crypto?.subtle) throw new Error(t('此浏览器未提供云端图片加密功能，请通过安全连接打开应用。'));
  const options = {send};
  const keys = new Map();
  const manifests = new Map();
  let passwordKey;

  function keyFor(salt) {
    const id = hex(salt);
    if (!keys.has(id)) {
      passwordKey ??= crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
      const key = passwordKey.then(keySource => crypto.subtle.deriveKey({name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256'},
        keySource, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']));
      if (keys.size >= 64) keys.delete(keys.keys().next().value);
      keys.set(id, key);
    }
    return keys.get(id);
  }

  async function seal(blob, salt, context, mime) {
    return transform(blob, randomHeader(blob.size, salt), await keyFor(salt), context, false, mime);
  }

  async function open(blob, context, limit, mime, expectedBytes) {
    if (blob.size < encodedSize(1) || blob.size > encodedSize(limit)) throw invalidImage();
    const header = new Uint8Array(await blob.slice(0, headerSize).arrayBuffer());
    const bytes = new DataView(header.buffer).getUint32(headerSize - 4);
    if (bytes <= 0 || bytes > limit || (expectedBytes !== undefined && bytes !== expectedBytes)
      || blob.size !== encodedSize(bytes) || magic.some((byte, index) => byte !== header[index])) throw invalidImage();
    const salt = header.subarray(magic.length, magic.length + saltSize);
    return transform(blob, header, await keyFor(salt), context, true, mime);
  }

  async function getImage(cloud, index, tier) {
    const item = cloud?.renditions?.[index];
    const details = item?.details?.[tier];
    if (cloud?.version !== version || !validId(cloud.batchId) || !Number.isSafeInteger(index) || index < 0
      || !Object.hasOwn(tierLimits, tier) || !validId(item?.[tier]) || !details || !validMedia(tier, details.mime, details.bytes)
      || typeof details.digest !== 'string' || !digestPattern.test(details.digest)) throw invalidManifest();
    const ciphertext = await downloadDriveImageObject(auth, item[tier], {...options, maxBytes: encodedSize(details.bytes)});
    const {blob, digest} = await open(ciphertext, imageContext(cloud.batchId, index, tier), details.bytes, details.mime, details.bytes);
    if (digest !== details.digest) throw invalidImage();
    return blob;
  }

  async function putBatch(record, images) {
    const metadata = projectRecord(record);
    if (!Array.isArray(images) || !images.length || images.length > 100 || !images.every(item => tiers.every(tier => {
      const blob = item?.[tier];
      return blob instanceof Blob && validMedia(tier, blob.type, blob.size);
    }))) throw new Error(t('云端图片分档无效或超过大小限制。'));
    const salt = crypto.getRandomValues(new Uint8Array(saltSize));
    const created = [];
    const cloud = {version, batchId: metadata.id, renditions: []};
    let submitted = false;
    try {
      for (const [index, image] of images.entries()) {
        const item = {mime: image.original.type, bytes: image.original.size, details: {}};
        cloud.renditions.push(item);
        for (const tier of tiers) {
          const original = image[tier];
          const {blob, digest} = await seal(original, salt, imageContext(metadata.id, index, tier), original.type);
          const receipt = await uploadDriveImageObject(auth, blob, 'rendition', options);
          created.push(receipt);
          item[tier] = receipt.id;
          item.details[tier] = {mime: original.type, bytes: original.size, digest};
          if (tier === 'original') {
            const storedChecksum = await readDriveImageChecksum(auth, receipt, options);
            if (!storedChecksum || storedChecksum !== await ciphertextChecksum(blob)) {
              throw new Error(t('未能验证 Google Drive 上的原图，已保留本地原图。'));
            }
          }
        }
      }
      const json = new Blob([JSON.stringify({version, record: metadata, renditions: cloud.renditions})]);
      if (json.size > manifestLimit) throw new Error(t('云端生图记录超过大小限制。'));
      const {blob} = await seal(json, salt, 'manifest');
      submitted = true;
      const {id} = await uploadDriveImageObject(auth, blob, 'manifest', {...options, generatedAt: metadata.time});
      return {...cloud, manifestId: id};
    } catch (error) {
      // Once manifest submission starts, an ambiguous network error can hide a successful commit.
      if (!submitted) for (const receipt of created) await discardDriveImageRendition(auth, receipt, options).catch(() => {});
      throw error;
    }
  }

  async function readManifest(file) {
    if (file.size > encodedSize(manifestLimit)) return null;
    let ciphertext;
    try { ciphertext = await downloadDriveImageObject(auth, file.id, {...options, maxBytes: encodedSize(manifestLimit)}); }
    catch (error) { if (error.status === 404) return null; throw error; }
    try {
      const {blob} = await open(ciphertext, 'manifest', manifestLimit);
      return manifestRecord(JSON.parse(decoder.decode(await blob.arrayBuffer())), file.id);
    } catch { return null; }
  }

  async function cachedManifest(file) {
    const cached = manifests.get(file.id);
    if (cached?.size === file.size && cached.createdTime === file.createdTime) return cached.record;
    if (cached) manifests.delete(file.id);
    const record = await readManifest(file);
    if (record) {
      if (manifests.size >= manifestCacheLimit) manifests.delete(manifests.keys().next().value);
      manifests.set(file.id, {size: file.size, createdTime: file.createdTime, record});
    }
    return record;
  }

  async function probePassword() {
    const {files, skipped} = await listDriveImageManifests(auth, {...options, limit: passwordProbeLimit});
    if (!files.length && !skipped) return 'empty';
    for (const file of files) if (await cachedManifest(file)) return 'verified';
    return 'invalid';
  }

  async function listBatches({limit = defaultHistoryLimits.imageCount} = {}) {
    if (!Number.isInteger(limit) || limit < 0 || limit > manifestCacheLimit) throw new Error(t('云图库读取数量无效。'));
    const listing = await listDriveImageManifests(auth, {...options, limit});
    const {files} = listing;
    const activeIds = new Set(files.map(file => file.id));
    for (const id of manifests.keys()) if (!activeIds.has(id)) manifests.delete(id);
    const records = new Map();
    let skipped = listing.skipped;
    for (let offset = 0; offset < files.length; offset += 4) {
      const batch = await Promise.all(files.slice(offset, offset + 4).map(cachedManifest));
      for (const record of batch) {
        if (!record) skipped++;
        else if (!records.has(record.id)) records.set(record.id, record);
      }
    }
    return {records: [...records.values()].sort((a, b) => b.time - a.time || a.id.localeCompare(b.id, 'en')), skipped};
  }

  return {putBatch, listBatches, getImage, probePassword};
}
