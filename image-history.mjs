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

function retainImageHistory(existing, incoming, limits) {
  const byId = new Map();
  // When a backup contains an existing generation, preserve the local version.
  for (const entry of existing) {
    if (!byId.has(entry.record.id)) byId.set(entry.record.id, entry);
  }
  let duplicates = 0;
  for (const record of incoming) {
    if (byId.has(record.id)) duplicates++;
    else byId.set(record.id, {record});
  }

  const maxBytes = imageHistoryByteLimit(limits);
  const ordered = [...byId.values()].sort((a, b) => newestFirst(a.record, b.record));
  const kept = new Set();
  let bytes = 0;
  for (const entry of ordered) {
    if (kept.size >= limits.imageCount) break;
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
  };
  return {removed, added, migrated, summary};
}

async function writeImageHistory(incoming, limits) {
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
            const {id, storageVersion} = cursor.value;
            existing.push({key: cursor.primaryKey, record: historyRecord(cursor.value), legacy: !id, storageVersion});
            cursor.continue();
            return;
          }
          const {removed, added, migrated, summary} = retainImageHistory(existing, incoming, limits);
          for (const entry of removed) store.delete(entry.key);
          for (const entry of migrated) store.put({...entry.record, storageVersion: entry.storageVersion}, entry.key);
          for (const entry of added) store.add({...entry.record, storageVersion: crypto.randomUUID()});
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
  const result = await writeImageHistory([entry], limits);
  return {saved: result.added === 1, disabled: false};
}

export function mergeImageHistory(records, limits = readHistoryLimits()) {
  return writeImageHistory(records.map(historyRecord), limits);
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
        resolve({key: cursor.primaryKey, record: historyRecord(row), storageVersion: row.storageVersion});
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
  if (thin.id !== original.id || original.cloud || !original.images.length || thin.cloud?.version !== 1
    || typeof thin.cloud.manifestId !== 'string' || !thin.cloud.manifestId
    || !Array.isArray(thin.cloud.renditions) || !thin.cloud.renditions.length
    || thin.size > original.size || thin.size > imageHistoryByteLimit(limits)) return false;

  const db = await openHistory();
  try {
    // Blob reads may take several tasks, so compare before opening the write transaction.
    const candidate = await findImageRecord(db, original.id);
    if (!candidate || candidate.record.cloud || !await sameImages(original.images, candidate.record.images)) return false;
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
          const replacement = {...candidate.record, images: thin.images, cloud: thin.cloud, size: thin.size};
          store.put({...replacement, storageVersion: crypto.randomUUID()}, candidate.key);
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
