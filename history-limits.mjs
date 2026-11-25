const storageKey = 'moonlight-history-limits-v1';

export const defaultHistoryLimits = Object.freeze({promptCount: 100, imageCount: 30, imageMiB: 64});
export const historyLimitRanges = Object.freeze({
  promptCount: Object.freeze({min: 0, max: 500}),
  imageCount: Object.freeze({min: 0, max: 500}),
  imageMiB: Object.freeze({min: 1, max: 512}),
});

const labels = {promptCount: '提示词历史条数', imageCount: '生图历史批次数', imageMiB: '生图历史大小（MiB）'};

function historyLimits(values, strict = false) {
  const limits = {};
  for (const [key, {min, max}] of Object.entries(historyLimitRanges)) {
    const value = values?.[key];
    const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
    if (!Number.isInteger(number) || number < min || number > max) {
      if (strict) throw new Error(labels[key] + '需填写 ' + min + ' 到 ' + max + ' 之间的整数。');
      limits[key] = defaultHistoryLimits[key];
    } else limits[key] = number;
  }
  return limits;
}

export function readHistoryLimits(storage) {
  try {
    return historyLimits(JSON.parse((storage ?? globalThis.localStorage).getItem(storageKey)));
  } catch {
    return {...defaultHistoryLimits};
  }
}

export function saveHistoryLimits(values, storage) {
  const limits = historyLimits(values, true);
  try {
    (storage ?? globalThis.localStorage).setItem(storageKey, JSON.stringify(limits));
  } catch {
    throw new Error('无法在此浏览器中保存记录保留设置。');
  }
  return limits;
}
