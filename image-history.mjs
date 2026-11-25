import {imageHistoryByteLimit, readHistoryLimits} from './history-limits.mjs';

const databaseName = 'moonlight-image-history';
const storeName = 'generations';
const equalityChunkBytes = 1024 * 1024;

function openHistory() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, {autoIncrement: true});
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function legacyId({images, model, provider, prompt, seed, language, time}) {
  // A backup may assign different IndexedDB keys to the same generation.
  const identity = JSON.stringify([time, provider, model, seed, language, prompt, images.map(image => [image.type, image.size])]);
  let hash = 14695981039346656037n;
  for (let i = 0; i < identity.length; i++) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(identity.charCodeAt(i))) * 1099511628211n);
  }
  return 'legacy-' + hash.toString(16).padStart(16, '0');
}

function recordId(record) {
  const {id} = record;
  return id === undefined || id === null || id === '' ? legacyId(record) : String(id);
}

function historyRecord(record) {
  const {images = [], model, provider, prompt, seed, language, time, metrics, text, sources, cloud} = record;
  if (!Array.isArray(images) || images.some(image => !(image instanceof Blob))) throw new Error('生图记录中的图片格式无效。');
  const size = images.reduce((total, image) => total + image.size, 0);
  return {id: recordId({...record, images}), images, model, provider, prompt, seed, language, time, size, metrics, text, sources,
    ...(cloud && {cloud})};
}

function newestFirst(a, b) {
  return b.time - a.time || a.id.localeCompare(b.id, 'en');
}

export async function readImageHistory() {
  const db = await openHistory();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(storeName).objectStore(storeName).getAll();
      request.onsuccess = () => {
        try {
          resolve(request.result.map(historyRecord).sort(newestFirst));
        } catch (error) {
          reject(error);
        }
      };
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

function cloudBacked(record) {
  const cloud = record.cloud;
  return cloud?.version === 1 && typeof cloud.manifestId === 'string' && Boolean(cloud.manifestId)
    && Array.isArray(cloud.renditions) && cloud.renditions.length > 0;
}

function retainImageHistory(existing, incoming, limits, {preserveOriginals, preserveStaged, cloudOnly, stageOriginal}) {
  // Cloud sync may only reclaim space from the cache. Local originals can be the only copy.
  const protectedRows = existing.filter(entry => (preserveOriginals && !cloudBacked(entry.record))
    || (preserveStaged && entry.stagedOriginal));
  const kept = new Set(protectedRows);
  const byId = new Map(protectedRows.map(entry => [entry.record.id, entry]));
  // When a backup contains an existing generation, preserve the local version.
  for (const entry of existing) {
    if (!byId.has(entry.record.id)) byId.set(entry.record.id, entry);
  }
  let duplicates = 0;
  for (const record of incoming) {
    if (cloudOnly && !cloudBacked(record)) continue;
    if (byId.has(record.id)) {
      duplicates++;
      continue;
    }
    const entry = {record, stagedOriginal: stageOriginal};
    byId.set(record.id, entry);
    if (stageOriginal) kept.add(entry);
  }

  const maxBytes = imageHistoryByteLimit(limits);
  const ordered = [...byId.values()].sort((a, b) => newestFirst(a.record, b.record));
  let bytes = [...kept].reduce((total, entry) => total + entry.record.size, 0);
  if (cloudOnly && limits.imageCount > 0) {
    // Keep the latest locally generated thumbnail visible when the originals alone leave no room for it.
    const latestLocalCloud = ordered.find(entry => entry.localCloud);
    if (latestLocalCloud && !kept.has(latestLocalCloud)
      && (kept.size >= limits.imageCount || latestLocalCloud.record.size > maxBytes - bytes)) {
      kept.add(latestLocalCloud);
      bytes += latestLocalCloud.record.size;
    }
  }
  for (const entry of ordered) {
    if (kept.size >= limits.imageCount) break;
    if (kept.has(entry)) continue;
    const {size} = entry.record;
    if (size > maxBytes - bytes) continue;
    kept.add(entry);
    bytes += size;
  }

  const removed = existing.filter(entry => !kept.has(entry));
  const added = [...kept].filter(entry => entry.key === undefined);
  const migrated = [...kept].filter(entry => entry.legacy);
  const summary = {
    added: added.length,
    duplicates,
    skipped: incoming.length - duplicates - added.length,
    removed: removed.length,
    total: kept.size,
    ...(stageOriginal && {overLimit: kept.size > limits.imageCount || bytes > maxBytes}),
  };
  return {removed, added, migrated, summary};
}

async function writeImageHistory(incoming, limits, policy = {}) {
  const db = await openHistory();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const scan = store.openCursor();
      const existing = [];
      let result;
      let failure;
      scan.onsuccess = () => {
        try {
          const cursor = scan.result;
          if (cursor) {
            const {id, storageVersion, stagedOriginal, localCloud} = cursor.value;
            existing.push({key: cursor.primaryKey, record: historyRecord(cursor.value), legacy: !id, storageVersion,
              stagedOriginal: stagedOriginal === true, localCloud: localCloud === true});
            cursor.continue();
            return;
          }
          const {removed, added, migrated, summary} = retainImageHistory(existing, incoming, limits, policy);
          for (const entry of removed) store.delete(entry.key);
          for (const entry of migrated) store.put({...entry.record, storageVersion: entry.storageVersion,
            ...(entry.stagedOriginal && {stagedOriginal: true}), ...(entry.localCloud && {localCloud: true})}, entry.key);
          for (const entry of added) store.add({...entry.record, storageVersion: crypto.randomUUID(),
            ...(entry.stagedOriginal && {stagedOriginal: true})});
          result = summary;
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('无法保存生图记录。'));
    });
  } finally {
    db.close();
  }
}

export async function saveImageHistory(record, limits = readHistoryLimits()) {
  if (!limits.imageCount) return {saved: false, disabled: true};
  const id = record.id === null || record.id === undefined || record.id === '' ? crypto.randomUUID() : record.id;
  const entry = historyRecord({...record, id});
  if (entry.size > imageHistoryByteLimit(limits)) throw new Error('图片超过生图记录的存储上限。');
  const result = await writeImageHistory([entry], limits, {preserveStaged: true});
  return {saved: result.added === 1, disabled: false};
}

export async function stageCloudImageHistory(record, limits = readHistoryLimits()) {
  if (!limits.imageCount) return {saved: false, disabled: true, overLimit: false, removed: 0};
  const id = record.id === null || record.id === undefined || record.id === '' ? crypto.randomUUID() : record.id;
  const entry = historyRecord({...record, id, cloud: undefined});
  if (!entry.images.length) throw new Error('生图记录中的图片格式无效。');
  const result = await writeImageHistory([entry], limits, {preserveOriginals: true, stageOriginal: true});
  return {saved: result.added === 1, disabled: false, overLimit: result.overLimit, removed: result.removed};
}

export function mergeImageHistory(records, limits = readHistoryLimits()) {
  return writeImageHistory(records.map(historyRecord), limits);
}

export function mergeCloudImageHistory(records, limits = readHistoryLimits()) {
  return writeImageHistory(records.map(historyRecord), limits, {preserveOriginals: true, cloudOnly: true});
}

export function pruneImageHistory(limits = readHistoryLimits()) {
  return writeImageHistory([], limits);
}

function findImageRecord(db, id) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).openCursor();
    request.onsuccess = () => {
      try {
        const cursor = request.result;
        if (!cursor) return resolve(null);
        const row = cursor.value;
        if (recordId(row) !== id) return cursor.continue();
        resolve({key: cursor.primaryKey, record: historyRecord(row), storageVersion: row.storageVersion,
          stagedOriginal: row.stagedOriginal === true});
      } catch (error) {
        reject(error);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

async function sameImages(expected, actual) {
  if (expected.length !== actual.length) return false;
  for (let index = 0; index < expected.length; index++) {
    const left = expected[index];
    const right = actual[index];
    if (left === right) continue;
    if (left.type !== right.type || left.size !== right.size) return false;
    for (let offset = 0; offset < left.size; offset += equalityChunkBytes) {
      const end = offset + equalityChunkBytes;
      const [a, b] = await Promise.all([left.slice(offset, end).arrayBuffer(), right.slice(offset, end).arrayBuffer()]);
      const aBytes = new Uint8Array(a);
      const bBytes = new Uint8Array(b);
      if (aBytes.some((byte, position) => byte !== bBytes[position])) return false;
    }
  }
  return true;
}

export async function replaceImageHistoryWithCloud(originalRecord, thinRecord, limits = readHistoryLimits()) {
  if (!limits.imageCount) return false;
  const original = historyRecord(originalRecord);
  const thin = historyRecord(thinRecord);
  if (thin.id !== original.id || original.cloud || !original.images.length || !cloudBacked(thin)) return false;

  const db = await openHistory();
  try {
    // Blob reads may take several tasks, so compare before opening the write transaction.
    const candidate = await findImageRecord(db, original.id);
    const keepOriginal = thin.size > original.size;
    if (!candidate || candidate.record.cloud || (!candidate.stagedOriginal && (keepOriginal || thin.size > imageHistoryByteLimit(limits)))
      || !await sameImages(original.images, candidate.record.images)) return false;
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.get(candidate.key);
      let replaced = false;
      let failure;
      request.onsuccess = () => {
        try {
          const current = request.result;
          if (!current || current.cloud || current.storageVersion !== candidate.storageVersion || recordId(current) !== original.id) return;
          // A tiny original can be smaller than its thumbnail. Once backed up, it can serve as the cache.
          const cache = keepOriginal ? candidate.record : thin;
          const replacement = {...candidate.record, images: cache.images, cloud: thin.cloud, size: cache.size};
          store.put({...replacement, storageVersion: crypto.randomUUID(),
            ...(candidate.stagedOriginal && {localCloud: true})}, candidate.key);
          replaced = true;
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(replaced);
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('无法更新生图记录的云端位置。'));
    });
  } finally {
    db.close();
  }
}
