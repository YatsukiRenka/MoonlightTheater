import {t} from './i18n.mjs';
const encoder = new TextEncoder();
const archiveMagic = 'MLHIST01';
const encryptedMagic = 'MLHENC01';
const metadataLimit = 16 * 1024 * 1024;
const encryptedImageLimit = 512 * 1024 * 1024;
const magicSize = 8;
const archiveHeaderSize = magicSize + 4;
const archiveLimit = archiveHeaderSize + metadataLimit + encryptedImageLimit;
const chunkSize = 1024 * 1024;
const tagSize = 16;
const saltSize = 16;
const noncePrefixSize = 8;
const encryptedHeaderSize = magicSize + saltSize + noncePrefixSize + 4;
const encryptedLimit = encryptedHeaderSize + archiveLimit + Math.ceil(archiveLimit / chunkSize) * tagSize;
const mimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);
const mediaType = 'application/octet-stream';

function invalidArchive() {
  return new Error(t('历史备份格式无效或文件不完整。'));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fields(value, keys) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

function validId(value) {
  return (Number.isSafeInteger(value) && value >= 0) || (typeof value === 'string' && value.length > 0
    && value.length <= 256 && !/[/\\\u0000-\u001f\u007f]/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value));
}

function validNumber(value) {
  return Number.isFinite(value) && value >= 0;
}

function promptMetadata(prompts) {
  if (!isObject(prompts) || !Array.isArray(prompts.records) || prompts.records.length > 1000
    || !prompts.records.every(isObject) || !isObject(prompts.profiles) || !isObject(prompts.manualMaterials)) {
    throw invalidArchive();
  }
  // The prompt-history layer validates and projects its nested profiles and records.
  return fields(prompts, ['records', 'profiles', 'manualMaterials']);
}

function imageMetrics(metrics) {
  if (metrics === undefined || metrics === null) return metrics;
  if (!isObject(metrics) || !validNumber(metrics.elapsed)) throw invalidArchive();
  const result = fields(metrics, ['elapsed', 'extraCharges']);
  if (result.extraCharges !== undefined && typeof result.extraCharges !== 'boolean') throw invalidArchive();
  if (metrics.tokens !== undefined) {
    if (!isObject(metrics.tokens)) throw invalidArchive();
    result.tokens = fields(metrics.tokens, ['input', 'output', 'thinking', 'total', 'inputImage', 'outputImage']);
    if (Object.values(result.tokens).some(value => value !== null && !validNumber(value))) throw invalidArchive();
  }
  if (metrics.cost === null) result.cost = null;
  else if (metrics.cost !== undefined) {
    if (!isObject(metrics.cost) || !validNumber(metrics.cost.value) || typeof metrics.cost.currency !== 'string'
      || !/^[A-Z]{3}$/.test(metrics.cost.currency) || typeof metrics.cost.source !== 'string'
      || (metrics.cost.upperBound !== undefined && typeof metrics.cost.upperBound !== 'boolean')) throw invalidArchive();
    result.cost = fields(metrics.cost, ['value', 'currency', 'source', 'upperBound']);
  }
  return result;
}

function cloudRecord(value, count) {
  const fileId = /^[A-Za-z0-9_-]{1,256}$/;
  if (!isObject(value) || value.version !== 1 || typeof value.manifestId !== 'string' || !fileId.test(value.manifestId)
    || typeof value.batchId !== 'string' || !fileId.test(value.batchId)
    || !Array.isArray(value.renditions) || value.renditions.length !== count) throw invalidArchive();
  const renditions = value.renditions.map(item => {
    if (!isObject(item) || !isObject(item.details) || !mimeTypes.has(item.mime)
      || !Number.isSafeInteger(item.bytes) || item.bytes < 1) throw invalidArchive();
    const details = {};
    for (const tier of ['thumbnail', 'preview', 'original']) {
      const meta = item.details[tier];
      if (typeof item[tier] !== 'string' || !fileId.test(item[tier]) || !isObject(meta) || !mimeTypes.has(meta.mime)
        || !Number.isSafeInteger(meta.bytes) || meta.bytes < 1 || typeof meta.digest !== 'string'
        || !/^[0-9a-f]{64}$/.test(meta.digest)) throw invalidArchive();
      details[tier] = fields(meta, ['mime', 'bytes', 'digest']);
    }
    if (item.mime !== details.original.mime || item.bytes !== details.original.bytes) throw invalidArchive();
    return {...fields(item, ['thumbnail', 'preview', 'original', 'mime', 'bytes']), details};
  });
  return {version: 1, manifestId: value.manifestId, batchId: value.batchId, renditions};
}

function imageGroup(value, mapImage) {
  if (!isObject(value) || !Array.isArray(value.images) || !value.images.length
    || (value.id !== undefined && !validId(value.id))
    || !validNumber(value.time) || value.time > 8.64e15
    || typeof value.model !== 'string' || typeof value.provider !== 'string'
    || typeof value.seed !== 'string' || typeof value.prompt !== 'string'
    || !['zh', 'en'].includes(value.language)) throw invalidArchive();
  const result = fields(value, ['id', 'model', 'provider', 'prompt', 'seed', 'language', 'time', 'text']);
  if (value.cloud !== undefined) result.cloud = cloudRecord(value.cloud, value.images.length);
  if (result.text !== undefined && typeof result.text !== 'string') throw invalidArchive();
  if (value.metrics !== undefined) result.metrics = imageMetrics(value.metrics);
  if (value.sources !== undefined) {
    if (!Array.isArray(value.sources)) throw invalidArchive();
    result.sources = value.sources.map(source => {
      if (!isObject(source) || typeof source.url !== 'string' || typeof source.title !== 'string') throw invalidArchive();
      return fields(source, ['url', 'title']);
    });
  }
  return {...result, images: value.images.map(mapImage)};
}

function historyMetadata(snapshot, mapImage) {
  if (!isObject(snapshot) || !Array.isArray(snapshot.images) || snapshot.images.length > 1000) throw invalidArchive();
  return {prompts: promptMetadata(snapshot.prompts), images: snapshot.images.map(group => imageGroup(group, mapImage))};
}

function checkBlob(blob, min, max = Number.MAX_SAFE_INTEGER) {
  if (!(blob instanceof Blob) || blob.size < min) throw invalidArchive();
  if (blob.size > max) throw new Error(t('历史备份超过大小限制。'));
}

function hasMagic(bytes, magic) {
  return bytes.length >= magicSize && [...magic].every((char, index) => bytes[index] === char.charCodeAt(0));
}

export function createHistoryArchive(snapshot) {
  const payloads = [];
  const metadata = historyMetadata(snapshot, blob => {
    if (!(blob instanceof Blob) || !mimeTypes.has(blob.type) || !blob.size) throw invalidArchive();
    if (payloads.length >= 10000) throw new Error(t('历史备份包含的图片过多。'));
    payloads.push(blob);
    return {size: blob.size, type: blob.type};
  });
  const manifest = encoder.encode(JSON.stringify({version: 1, ...metadata}));
  if (manifest.byteLength > metadataLimit) throw new Error(t('历史备份中的文本数据超过 16 MiB 限制。'));
  const header = new Uint8Array(archiveHeaderSize);
  header.set(encoder.encode(archiveMagic));
  new DataView(header.buffer).setUint32(magicSize, manifest.byteLength);
  // Construct from Blob parts to preserve original image bytes without Base64 or reading the image payloads.
  return new Blob([header, manifest, ...payloads], {type: mediaType});
}

export async function readHistoryArchive(blob) {
  checkBlob(blob, archiveHeaderSize);
  const header = new Uint8Array(await blob.slice(0, archiveHeaderSize).arrayBuffer());
  if (hasMagic(header, encryptedMagic)) throw new Error(t('此历史备份需要先解密。'));
  if (!hasMagic(header, archiveMagic)) throw invalidArchive();
  const length = new DataView(header.buffer).getUint32(magicSize);
  const payloadStart = archiveHeaderSize + length;
  if (!length || length > metadataLimit || payloadStart > blob.size) throw invalidArchive();
  let manifest;
  try {
    const bytes = await blob.slice(archiveHeaderSize, payloadStart).arrayBuffer();
    manifest = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch {
    throw invalidArchive();
  }
  if (!isObject(manifest) || manifest.version !== 1) throw new Error(t('此历史备份的版本不受支持。'));
  let offset = payloadStart;
  let count = 0;
  const snapshot = historyMetadata(manifest, descriptor => {
    if (++count > 10000 || !isObject(descriptor) || !mimeTypes.has(descriptor.type)
      || !Number.isSafeInteger(descriptor.size) || descriptor.size < 1 || descriptor.size > blob.size - offset) throw invalidArchive();
    const image = blob.slice(offset, offset + descriptor.size, descriptor.type);
    offset += descriptor.size;
    return image;
  });
  if (offset !== blob.size) throw invalidArchive();
  return snapshot;
}

export async function archiveIsEncrypted(blob) {
  if (!(blob instanceof Blob) || blob.size < magicSize) return false;
  return hasMagic(new Uint8Array(await blob.slice(0, magicSize).arrayBuffer()), encryptedMagic);
}

async function deriveKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || !passphrase.length || passphrase.length > 1024) {
    throw new Error(t('请输入有效的备份密码，最多 1024 个字符。'));
  }
  if (!globalThis.crypto?.subtle) throw new Error(t('此浏览器未提供备份加密功能，请通过安全连接打开应用。'));
  const password = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256'},
    password, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}

async function cryptBody(blob, passphrase, header, decrypting) {
  const saltEnd = magicSize + saltSize;
  const plainSize = new DataView(header.buffer).getUint32(encryptedHeaderSize - 4);
  const key = await deriveKey(passphrase, header.subarray(magicSize, saltEnd));
  const iv = new Uint8Array(noncePrefixSize + 4);
  iv.set(header.subarray(saltEnd, saltEnd + noncePrefixSize));
  const ivView = new DataView(iv.buffer);
  // Each GCM tag authenticates the entire header and this chunk's index, binding order and total length.
  const additionalData = new Uint8Array(encryptedHeaderSize + 4);
  additionalData.set(header);
  const aadView = new DataView(additionalData.buffer);
  const options = {name: 'AES-GCM', iv, additionalData, tagLength: tagSize * 8};
  const parts = decrypting ? [] : [new Blob([header])];
  let readOffset = decrypting ? encryptedHeaderSize : 0;
  for (let index = 0, remaining = plainSize; remaining > 0; index++) {
    const length = Math.min(remaining, chunkSize);
    const readLength = length + (decrypting ? tagSize : 0);
    const chunk = await blob.slice(readOffset, readOffset + readLength).arrayBuffer();
    ivView.setUint32(noncePrefixSize, index);
    aadView.setUint32(encryptedHeaderSize, index);
    try {
      const output = decrypting ? await crypto.subtle.decrypt(options, key, chunk) : await crypto.subtle.encrypt(options, key, chunk);
      // Keep each transformed part as a Blob so constructing the final Blob avoids concatenating byte arrays.
      parts.push(new Blob([output]));
    } catch (error) {
      if (!decrypting) throw error;
      throw new Error(t('备份密码不正确，或加密文件已损坏。'));
    }
    readOffset += readLength;
    remaining -= length;
  }
  return new Blob(parts, {type: mediaType});
}

export async function encryptHistoryArchive(blob, passphrase) {
  if (blob instanceof Blob && blob.size > archiveLimit) {
    throw new Error(t('历史超过单份 Drive 加密备份容量。可以导出本地备份，或用云图库分批同步生图。'));
  }
  checkBlob(blob, archiveHeaderSize, archiveLimit);
  if (!hasMagic(new Uint8Array(await blob.slice(0, magicSize).arrayBuffer()), archiveMagic)) throw invalidArchive();
  if (!globalThis.crypto?.subtle) throw new Error(t('此浏览器未提供备份加密功能，请通过安全连接打开应用。'));
  const header = new Uint8Array(encryptedHeaderSize);
  header.set(encoder.encode(encryptedMagic));
  crypto.getRandomValues(header.subarray(magicSize, encryptedHeaderSize - 4));
  new DataView(header.buffer).setUint32(encryptedHeaderSize - 4, blob.size);
  return cryptBody(blob, passphrase, header, false);
}

export async function decryptHistoryArchive(blob, passphrase) {
  checkBlob(blob, encryptedHeaderSize, encryptedLimit);
  const header = new Uint8Array(await blob.slice(0, encryptedHeaderSize).arrayBuffer());
  if (!hasMagic(header, encryptedMagic)) throw invalidArchive();
  const size = new DataView(header.buffer).getUint32(encryptedHeaderSize - 4);
  if (size < archiveHeaderSize || size > archiveLimit
    || blob.size !== encryptedHeaderSize + size + Math.ceil(size / chunkSize) * tagSize) throw invalidArchive();
  return cryptBody(blob, passphrase, header, true);
}
