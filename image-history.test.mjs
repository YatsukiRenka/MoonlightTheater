import assert from 'node:assert/strict';
import test from 'node:test';
import {mergeImageHistory, pruneImageHistory, retainImageHistory, saveImageHistory} from './image-history.mjs';

const cloud = {version: 1, manifestId: 'manifest', renditions: [{}]};
const limits = {imageCount: 2, imageBytes: 10};

function record(id, size, time, metadata = {}) {
  return {id, size, time, ...metadata};
}

function keptIds(existing, result) {
  return [...existing.filter(row => !result.removed.includes(row)), ...result.added].map(row => row.record.id).sort();
}

const staged = {key: 1, record: record('upload', 8, 1), stagedOriginal: true};
const completed = {key: 1, record: record('upload', 2, 1, {cloud}), localCloud: true};
const cache = {key: 2, record: record('cache', 8, 2, {cloud})};
const original = record('new', 2, 3);
const thumbnail = record('new', 2, 3, {cloud});
const stages = [
  {name: 'upload active', row: staged, activeUploads: new Set(['upload'])},
  {name: 'upload succeeded', row: completed, activeUploads: new Set()},
  {name: 'upload failed', row: staged, activeUploads: new Set()},
];
const operations = [
  {name: 'ordinary save', incoming: [original], policy: {}, expected: [['new', 'upload'], ['cache', 'new'], ['cache', 'new']]},
  {name: 'stage for upload', incoming: [original], policy: {preserveOriginals: true, stageOriginal: true},
    expected: [['new', 'upload'], ['cache', 'new'], ['new', 'upload']]},
  {name: 'cloud sync', incoming: [thumbnail], policy: {preserveOriginals: true, cloudOnly: true},
    expected: [['new', 'upload'], ['cache', 'new'], ['new', 'upload']]},
  {name: 'import', incoming: [original], policy: {}, expected: [['new', 'upload'], ['cache', 'new'], ['cache', 'new']]},
  {name: 'prune', incoming: [], policy: {}, limits: {...limits, imageCount: 1}, expected: [['upload'], ['cache'], ['cache']]},
];

for (const operation of operations) {
  for (const [index, {name, row, activeUploads}] of stages.entries()) {
    test(`${operation.name} retention when ${name}`, () => {
      const existing = [row, cache];
      const result = retainImageHistory(existing, operation.incoming, operation.limits ?? limits,
        {...operation.policy, activeUploads});
      assert.deepEqual(keptIds(existing, result), operation.expected[index]);
    });
  }
}

test('keeps batches exactly at both retention limits', () => {
  const result = retainImageHistory([cache], [original], limits);
  assert.deepEqual(keptIds([cache], result), ['cache', 'new']);
});

test('drops the oldest eligible batch when one over the batch limit', () => {
  const older = {key: 1, record: record('older', 1, 1)};
  const existing = [older, cache];
  const result = retainImageHistory(existing, [original], {...limits, imageBytes: 11});
  assert.deepEqual(result.removed, [older]);
  assert.deepEqual(keptIds(existing, result), ['cache', 'new']);
});

test('drops the oldest eligible batch when one byte over the byte limit', () => {
  const result = retainImageHistory([cache], [original], {...limits, imageBytes: 9});
  assert.deepEqual(result.removed, [cache]);
  assert.deepEqual(keptIds([cache], result), ['new']);
});

test('empty history and empty input leave nothing to write or remove', () => {
  assert.deepEqual(retainImageHistory([], [], limits), {
    removed: [], added: [], migrated: [],
    summary: {added: 0, duplicates: 0, skipped: 0, removed: 0, total: 0},
  });
});

test('skips an import that cannot fit by itself without evicting existing history', () => {
  const result = retainImageHistory([cache], [record('oversized', 11, 3)], limits);
  assert.deepEqual(keptIds([cache], result), ['cache']);
  assert.equal(result.summary.skipped, 1);
});

test('ordinary save rejects a batch that cannot fit by itself', async () => {
  await assert.rejects(saveImageHistory({id: 'oversized', images: [new Blob(['12345678901'])]}, limits),
    {message: '图片超过生图记录的存储上限。'});
});

test('staging saves a new batch even when local originals already fill both limits', () => {
  const result = retainImageHistory([staged], [original], {imageCount: 1, imageBytes: 8},
    {preserveOriginals: true, stageOriginal: true});
  assert.deepEqual(keptIds([staged], result), ['new', 'upload']);
  assert.equal(result.added[0].stagedOriginal, true);
  assert.equal(result.summary.overLimit, true);
});

test('staging saves a batch even when it cannot fit by itself', () => {
  const result = retainImageHistory([], [record('oversized', 11, 3)], limits,
    {preserveOriginals: true, stageOriginal: true});
  assert.deepEqual(keptIds([], result), ['oversized']);
  assert.equal(result.summary.overLimit, true);
});

test('cloud sync keeps the latest local thumbnail when protected originals fill the quota', () => {
  const localThumbnail = {key: 2, record: record('local', 2, 1, {cloud}), localCloud: true};
  const olderThumbnail = {key: 3, record: record('older', 1, 0, {cloud}), localCloud: true};
  const existing = [staged, localThumbnail, olderThumbnail];
  const result = retainImageHistory(existing, [thumbnail], {imageCount: 1, imageBytes: 8},
    {preserveOriginals: true, cloudOnly: true});
  assert.deepEqual(keptIds(existing, result), ['local', 'upload']);
});

test('cloud sync skips incoming originals and still keeps stored originals', () => {
  const result = retainImageHistory([staged], [original], limits, {preserveOriginals: true, cloudOnly: true});
  assert.deepEqual(keptIds([staged], result), ['upload']);
  assert.equal(result.summary.skipped, 1);
});

test('cloud sync skips a thumbnail that cannot fit by itself', () => {
  const result = retainImageHistory([cache], [record('oversized', 11, 3, {cloud})], limits,
    {preserveOriginals: true, cloudOnly: true});
  assert.deepEqual(keptIds([cache], result), ['cache']);
  assert.equal(result.summary.skipped, 1);
});

test('an import of the same generation keeps the local original', () => {
  const duplicate = record('upload', 2, 3, {cloud});
  const result = retainImageHistory([staged], [duplicate], limits);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.equal(result.summary.duplicates, 1);
});

function replaceGlobal(t, name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {value, configurable: true});
  t.after(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete globalThis[name];
  });
}

function backupRecord(id, size, time) {
  return {id, time, images: [new Blob([new Uint8Array(size)])]};
}

function mockHistoryWithActiveUploads(t) {
  const rows = new Map(Array.from({length: 4}, (_, index) => {
    const key = index + 1;
    return [key, {...backupRecord(`upload-${key}`, 15, key), stagedOriginal: true}];
  }));
  const held = [...rows.values()].map(({id}) => ({name: `moonlight-image-history:upload:${id}`}));
  let retaining = false;
  replaceGlobal(t, 'navigator', {locks: {
    async request(name, action) {
      assert.equal(name, 'moonlight-image-history:retention');
      retaining = true;
      try {
        return await action();
      } finally {
        retaining = false;
      }
    },
    async query() {
      assert.ok(retaining);
      return {held};
    },
  }});

  let nextKey = rows.size + 1;
  replaceGlobal(t, 'indexedDB', {
    open() {
      const request = {result: {
        close() {},
        transaction() {
          const transaction = {objectStore: () => store};
          const store = {
            openCursor() {
              const scan = {};
              const cursor = rows.entries();
              function advance() {
                const next = cursor.next();
                scan.result = next.done ? null : {
                  primaryKey: next.value[0], value: next.value[1], continue: () => queueMicrotask(advance),
                };
                scan.onsuccess();
                if (next.done) transaction.oncomplete();
              }
              queueMicrotask(advance);
              return scan;
            },
            add(row) { rows.set(nextKey++, row); },
            delete(key) { rows.delete(key); },
          };
          return transaction;
        },
      }};
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  });
  return {rows, held};
}

test('import leaves all four batches held by another tab in storage', async t => {
  const {rows, held} = mockHistoryWithActiveUploads(t);
  const imported = backupRecord('imported', 8, 5);
  const capacity = {imageCount: 30, imageBytes: 64};
  const active = await mergeImageHistory([imported], capacity);
  assert.deepEqual(active, {added: 0, duplicates: 0, skipped: 1, removed: 0, total: 4});
  assert.deepEqual([...rows.values()].map(row => row.id), ['upload-1', 'upload-2', 'upload-3', 'upload-4']);

  held.shift();
  const ended = await mergeImageHistory([imported], capacity);
  assert.deepEqual(ended, {added: 1, duplicates: 0, skipped: 0, removed: 1, total: 4});
  assert.deepEqual([...rows.values()].map(row => row.id), ['upload-2', 'upload-3', 'upload-4', 'imported']);
});

test('pruning after retention is disabled leaves uploads held by another tab in storage', async t => {
  const {rows, held} = mockHistoryWithActiveUploads(t);
  const disabled = {imageCount: 0, imageBytes: 1};
  const active = await pruneImageHistory(disabled);
  assert.equal(active.removed, 0);
  assert.equal(rows.size, 4);

  held.length = 0;
  const ended = await pruneImageHistory(disabled);
  assert.equal(ended.removed, 4);
  assert.equal(rows.size, 0);
});
