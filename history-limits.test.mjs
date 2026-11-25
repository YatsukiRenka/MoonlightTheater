import assert from 'node:assert/strict';
import {test} from 'node:test';
import {defaultHistoryLimits, historyLimitRanges, readHistoryLimits, saveHistoryLimits} from './history-limits.mjs';

function storageFixture(initial = null) {
  const data = new Map([['moonlight-history-limits-v1', initial]]);
  return {getItem: key => data.get(key), setItem: (key, value) => data.set(key, value)};
}

test('history retention can disable either count and persists validated limits', () => {
  const storage = storageFixture();
  assert.deepEqual(readHistoryLimits(storage), defaultHistoryLimits);

  const settings = {promptCount: 0, imageCount: 500, imageMiB: 512};
  assert.deepEqual(saveHistoryLimits({promptCount: '0', imageCount: '500', imageMiB: '512'}, storage), settings);
  assert.deepEqual(readHistoryLimits(storage), settings);
  assert.deepEqual(saveHistoryLimits({...settings, imageCount: historyLimitRanges.imageCount.min}, storage), {...settings, imageCount: 0});
});

test('invalid limits leave saved values intact and damaged values fall back individually', () => {
  const storage = storageFixture('{"promptCount":600,"imageCount":4,"imageMiB":null}');
  const settings = {...defaultHistoryLimits, imageCount: 4};
  assert.deepEqual(readHistoryLimits(storage), settings);

  for (const value of ['', 0, 513, 1.5, false, undefined]) {
    assert.throws(() => saveHistoryLimits({...settings, imageMiB: value}, storage), /1 到 512/);
  }
  assert.deepEqual(readHistoryLimits(storage), settings);
  assert.deepEqual(readHistoryLimits(storageFixture('{broken')), defaultHistoryLimits);
});
