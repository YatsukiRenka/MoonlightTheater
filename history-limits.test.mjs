import assert from 'node:assert/strict';
import {test} from 'node:test';
import {defaultHistoryLimits, historyLimitRanges, imageHistoryByteLimit, readHistoryLimits, saveHistoryLimits} from './history-limits.mjs';

function storageFixture(initial = null) {
  const data = new Map([['moonlight-history-limits-v1', initial]]);
  return {getItem: key => data.get(key), setItem: (key, value) => data.set(key, value)};
}

test('history retention supports decimal MB and GB above the previous cap and can disable either count', () => {
  const storage = storageFixture();
  assert.deepEqual(readHistoryLimits(storage), defaultHistoryLimits);

  const settings = {promptCount: 0, imageCount: 500, imageCapacity: 1.5, imageUnit: 'GB', imageBytes: 1_500_000_000};
  assert.deepEqual(saveHistoryLimits({promptCount: '0', imageCount: '500', imageCapacity: '1.5', imageUnit: 'GB'}, storage), settings);
  assert.deepEqual(readHistoryLimits(storage), settings);
  assert.deepEqual(saveHistoryLimits({...settings, imageCount: historyLimitRanges.imageCount.min}, storage), {...settings, imageCount: 0});
  assert.deepEqual(saveHistoryLimits({...settings, imageCapacity: 513.125, imageUnit: 'MB'}, storage), {
    ...settings, imageCapacity: 513.125, imageUnit: 'MB', imageBytes: 513_125_000,
  });
});

test('invalid limits leave saved values intact and damaged values fall back individually', () => {
  const storage = storageFixture('{"promptCount":600,"imageCount":4,"imageMiB":null}');
  const settings = {...defaultHistoryLimits, imageCount: 4};
  assert.deepEqual(readHistoryLimits(storage), settings);

  for (const value of ['', 0, -1, 0.0000001, Number.MAX_SAFE_INTEGER, Infinity, false, undefined]) {
    assert.throws(() => saveHistoryLimits({...settings, imageCapacity: value}, storage), /有效的生图历史大小/);
  }
  assert.throws(() => saveHistoryLimits({...settings, imageUnit: 'MiB'}, storage), /MB 或 GB/);
  assert.deepEqual(readHistoryLimits(storage), settings);
  assert.deepEqual(readHistoryLimits(storageFixture('{broken')), defaultHistoryLimits);
});

test('legacy MiB limits retain the exact byte cap on migration', () => {
  const storage = storageFixture('{"promptCount":20,"imageCount":5,"imageMiB":64}');
  const migrated = {promptCount: 20, imageCount: 5, imageCapacity: 67.108864, imageUnit: 'MB', imageBytes: 67_108_864};
  assert.deepEqual(readHistoryLimits(storage), migrated);
  assert.deepEqual(saveHistoryLimits(migrated, storage), migrated);
  assert.equal(imageHistoryByteLimit({imageMiB: 1}), 1_048_576);
});
