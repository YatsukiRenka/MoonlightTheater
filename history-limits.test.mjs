import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  defaultHistoryLimits, formatImageCapacity, historyLimitRanges, imageHistoryByteLimit, parseImageCapacityInput,
  readHistoryLimits, saveHistoryLimits,
} from './history-limits.mjs';

function storageFixture(initial = null) {
  const data = new Map([['moonlight-history-limits-v1', initial]]);
  return {getItem: key => data.get(key), setItem: (key, value) => data.set(key, value)};
}

function submitDisplayedCapacity(limits, edits) {
  const displayed = formatImageCapacity(limits);
  return parseImageCapacityInput({
    imageCapacity: Number(displayed.imageCapacity), imageUnit: displayed.imageUnit, ...edits,
  }, limits);
}

function saveDisplayedLimits({promptCount, imageCount, ...capacity}, storage) {
  return saveHistoryLimits({promptCount, imageCount, ...submitDisplayedCapacity(capacity)}, storage);
}

test('default capacity displays as 64 MiB and an unchanged save retains the same bytes', () => {
  const storage = storageFixture();
  const limits = readHistoryLimits(storage);
  assert.equal(limits.imageBytes, 67_108_864);
  assert.deepEqual(formatImageCapacity(limits), {imageCapacity: '64', imageUnit: 'MiB', approximate: false});
  assert.deepEqual(saveDisplayedLimits(limits, storage), limits);
  assert.deepEqual(readHistoryLimits(storage), limits);
});

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

test('a rounded display preserves a previously saved decimal limit unless the capacity is edited', () => {
  const storage = storageFixture('{"promptCount":20,"imageCount":5,"imageCapacity":67.108864,"imageUnit":"MB","imageBytes":67108864}');
  const limits = readHistoryLimits(storage);
  assert.deepEqual(formatImageCapacity(limits), {imageCapacity: '67.109', imageUnit: 'MB', approximate: true});
  const saved = saveHistoryLimits({...submitDisplayedCapacity(limits), promptCount: 10, imageCount: 5}, storage);
  assert.deepEqual(saved, {...limits, promptCount: 10, imageBytes: 67_108_864});
  assert.deepEqual(readHistoryLimits(storage), saved);
  assert.equal(submitDisplayedCapacity(saved, {imageCapacity: 67.11}).imageBytes, 67_110_000);
  assert.equal(submitDisplayedCapacity(saved, {imageUnit: 'GB'}).imageBytes, 67_109_000_000);
});

test('invalid limits leave saved values intact and damaged values fall back individually', () => {
  const storage = storageFixture('{"promptCount":600,"imageCount":4,"imageMiB":null}');
  const settings = {...defaultHistoryLimits, imageCount: 4};
  assert.deepEqual(readHistoryLimits(storage), settings);

  for (const value of ['', 0, -1, 0.0000001, Number.MAX_SAFE_INTEGER, Infinity, false, undefined]) {
    assert.throws(() => saveHistoryLimits({...settings, imageCapacity: value}, storage), /有效的生图历史大小/);
  }
  assert.throws(() => saveHistoryLimits({...settings, imageUnit: 'KiB'}, storage), /MB、GB 或 MiB/);
  assert.deepEqual(readHistoryLimits(storage), settings);
  assert.deepEqual(readHistoryLimits(storageFixture('{broken')), defaultHistoryLimits);
});

test('legacy MiB limits retain the exact byte cap on migration', () => {
  const storage = storageFixture('{"promptCount":20,"imageCount":5,"imageMiB":64}');
  const migrated = {promptCount: 20, imageCount: 5, imageCapacity: 64, imageUnit: 'MiB', imageBytes: 67_108_864};
  assert.deepEqual(readHistoryLimits(storage), migrated);
  assert.deepEqual(formatImageCapacity(migrated), {imageCapacity: '64', imageUnit: 'MiB', approximate: false});
  assert.deepEqual(saveDisplayedLimits(migrated, storage), migrated);
  assert.deepEqual(readHistoryLimits(storage), migrated);
  assert.equal(imageHistoryByteLimit({imageMiB: 1}), 1_048_576);
});

test('capacity bounds keep a compact, positive display and preserve the exact byte limit', () => {
  const storage = storageFixture();
  const ranges = [
    {imageUnit: 'MB', unitBytes: 1_000_000, oneByteDisplay: '1e-6'},
    {imageUnit: 'GB', unitBytes: 1_000_000_000, oneByteDisplay: '1e-9'},
    {imageUnit: 'MiB', unitBytes: 1_048_576, oneByteDisplay: '9.54e-7'},
  ];
  for (const {imageUnit, unitBytes, oneByteDisplay} of ranges) {
    const input = {...defaultHistoryLimits, imageUnit, imageCapacity: 1 / unitBytes};
    const limits = saveHistoryLimits(input, storage);
    assert.equal(limits.imageBytes, 1);
    assert.equal(formatImageCapacity(limits).imageCapacity, oneByteDisplay);
    assert.equal(saveDisplayedLimits(limits, storage).imageBytes, 1);
    assert.throws(() => saveHistoryLimits({...input, imageCapacity: 0.99 / unitBytes}, storage), /至少为 1 字节/);
  }
  const largest = saveHistoryLimits({...defaultHistoryLimits, imageCapacity: Number.MAX_SAFE_INTEGER / 1_048_576}, storage);
  assert.equal(largest.imageBytes, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(formatImageCapacity(largest), {imageCapacity: '8589934592', imageUnit: 'MiB', approximate: true});
  assert.deepEqual(saveDisplayedLimits(largest, storage), largest);
  assert.deepEqual(readHistoryLimits(storage), largest);
  assert.throws(() => saveHistoryLimits({...largest, imageCapacity: 8589934592}, storage), /安全整数范围/);
});
