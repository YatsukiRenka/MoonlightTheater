import {readHistoryLimits} from './history-limits.mjs';

const databaseName = 'moonlight-image-history';
const storeName = 'generations';
const mib = 1024 * 1024;

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

function historyRecord(record) {
  const {id, images, model, provider, prompt, seed, language, time, metrics, text, sources} = record;
  const size = images.reduce((total, image) => total + image.size, 0);
  return {id: id === undefined || id === null || id === '' ? legacyId(record) : String(id),
    images, model, provider, prompt, seed, language, time, size, metrics, text, sources};
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

  const maxBytes = limits.imageMiB * mib;
  const ordered = [...byId.values()].sort((a, b) => newestFirst(a.record, b.record));
  const kept = new Set();
  let bytes = 0;
  for (const entry of ordered) {
    const {size} = entry.record;
    if (size > maxBytes) continue;
    if (kept.size >= limits.imageCount || bytes + size > maxBytes) break;
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
            existing.push({key: cursor.primaryKey, record: historyRecord(cursor.value), legacy: !cursor.value.id});
            cursor.continue();
            return;
          }
          const {removed, added, migrated, summary} = retainImageHistory(existing, incoming, limits);
          for (const entry of removed) store.delete(entry.key);
          for (const entry of migrated) store.put(entry.record, entry.key);
          for (const entry of added) store.add(entry.record);
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
  const entry = historyRecord({...record, id: crypto.randomUUID()});
  if (entry.size > limits.imageMiB * mib) throw new Error('图片超过生图记录的存储上限。');
  const result = await writeImageHistory([entry], limits);
  return {saved: result.added === 1, disabled: false};
}

export function mergeImageHistory(records, limits = readHistoryLimits()) {
  return writeImageHistory(records.map(historyRecord), limits);
}

export function pruneImageHistory(limits = readHistoryLimits()) {
  return writeImageHistory([], limits);
}
