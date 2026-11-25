const storageKey = 'moonlight-history-limits-v1';
const binaryMiB = 1024 * 1024;
export const imageCapacityUnits = Object.freeze({MB: 1_000_000, GB: 1_000_000_000});

const defaultImageBytes = 64 * binaryMiB;
export const defaultHistoryLimits = Object.freeze({promptCount: 100, imageCount: 30,
  imageCapacity: defaultImageBytes / imageCapacityUnits.MB, imageUnit: 'MB', imageBytes: defaultImageBytes});
export const historyLimitRanges = Object.freeze({
  promptCount: Object.freeze({min: 0, max: 500}),
  imageCount: Object.freeze({min: 0, max: 500}),
});

const labels = {promptCount: '提示词历史条数', imageCount: '生图历史批次数'};

function parseImageCapacity(values) {
  if (values?.imageCapacity === undefined && values?.imageUnit === undefined) {
    const legacy = values?.imageMiB;
    const imageBytes = Number.isFinite(legacy) ? Math.floor(legacy * binaryMiB) : NaN;
    if (Number.isSafeInteger(imageBytes) && imageBytes > 0) {
      return {imageCapacity: imageBytes / imageCapacityUnits.MB, imageUnit: 'MB', imageBytes};
    }
    return null;
  }
  const {imageCapacity, imageUnit} = values;
  if (!Object.hasOwn(imageCapacityUnits, imageUnit)) return null;
  const numeric = typeof imageCapacity === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(imageCapacity.trim())
    ? Number(imageCapacity) : imageCapacity;
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const scaled = numeric * imageCapacityUnits[imageUnit];
  const imageBytes = Math.round(scaled);
  return scaled >= 1 && Number.isSafeInteger(imageBytes) ? {imageCapacity: numeric, imageUnit, imageBytes} : null;
}

export function imageHistoryByteLimit(limits) {
  if (Number.isSafeInteger(limits?.imageBytes) && limits.imageBytes > 0) return limits.imageBytes;
  return parseImageCapacity(limits)?.imageBytes ?? defaultImageBytes;
}

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
  const capacity = parseImageCapacity(values);
  if (capacity) return {...limits, ...capacity};
  if (strict) throw new Error('请用 MB 或 GB 填写有效的生图历史大小。容量需至少为 1 字节，且不能超过安全整数范围。');
  return {...defaultHistoryLimits, ...limits};
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
