import {createCloudImageStore} from './cloud-image-store.mjs';
import {makeImageRenditions} from './image-renditions.mjs';
import {mergeCloudImageHistory, readImageHistory, replaceImageHistoryWithCloud} from './image-history.mjs';
import {imageHistoryByteLimit, readHistoryLimits} from './history-limits.mjs';

const modeKey = 'moonlight-history-cloud-gallery';
const validInterval = value => Number.isInteger(value) && value >= 1 && value <= 1440;

export function createCloudHistory() {
  let store;
  let settings = {enabled: false, interval: 15};
  try {
    const saved = JSON.parse(localStorage.getItem(modeKey));
    if (saved && validInterval(saved.interval)) settings = {enabled: saved.enabled === true, interval: saved.interval};
  } catch {}

  function connected() {
    if (!store) throw new Error('请先在历史设置中连接并解锁 Google Drive。');
    return store;
  }

  async function transfer(record, session = connected()) {
    if (store !== session) throw new Error('云图库连接已变更。');
    const renditions = [];
    for (const image of record.images) renditions.push(await makeImageRenditions(image));
    if (store !== session) throw new Error('云图库连接已变更。');
    const cloud = await session.putBatch(record, renditions);
    if (store !== session) throw new Error('云图库连接已变更。');
    return {...record, images: renditions.map(image => image.thumbnail), cloud};
  }

  return {
    get ready() { return Boolean(store); },
    get enabled() { return settings.enabled; },
    get interval() { return settings.interval; },
    configure({enabled, interval}) {
      if (!validInterval(interval)) throw new Error('同步间隔需填写 1 到 1440 分钟。');
      const next = {enabled, interval};
      localStorage.setItem(modeKey, JSON.stringify(next));
      settings = next;
    },
    async unlock(auth, passphrase, confirmation) {
      const candidate = createCloudImageStore(auth, passphrase);
      const result = await candidate.probePassword();
      if (result === 'invalid') throw new Error('此口令无法解锁现有云图库。');
      if (result === 'empty' && passphrase !== confirmation) throw new Error('首次使用云图库，请再输入一次相同的口令。');
      store = candidate;
    },
    lock() { store = undefined; },
    prepareUpload() {
      const session = connected();
      return async record => {
        if (!settings.enabled) throw new Error('自动同步已关闭。');
        const saved = await transfer(record, session);
        if (!settings.enabled) throw new Error('自动同步已关闭。');
        return saved;
      };
    },
    image(record, index, tier) {
      return record.cloud ? connected().getImage(record.cloud, index, tier) : Promise.resolve(record.images[index]);
    },
    async optimize(onProgress) {
      connected();
      const originals = (await readImageHistory()).filter(record => !record.cloud);
      let replaced = 0;
      for (const record of originals) {
        onProgress(replaced, originals.length);
        try {
          if (await replaceImageHistoryWithCloud(record, await transfer(record))) replaced++;
        } catch (error) {
          const failure = new Error('已将 ' + replaced + ' 批换为缩略图。本次遇到错误，余下本地原图继续保留。' + error.message, {cause: error});
          failure.status = error.status ?? error.cause?.status;
          throw failure;
        }
      }
      return {replaced};
    },
    async restore(onProgress) {
      const session = connected();
      const limits = readHistoryLimits();
      const local = await readImageHistory();
      const originals = local.filter(record => !record.cloud);
      let slots = limits.imageCount - originals.length;
      let bytes = imageHistoryByteLimit(limits) - originals.reduce((total, record) => total + record.size, 0);
      if (slots <= 0 || bytes <= 0) {
        return {added: 0, removed: 0, unavailable: 0, limited: true};
      }
      const {records, skipped} = await session.listBatches({limit: limits.imageCount});
      const cached = new Set(local.map(record => record.id));
      const ranked = [...local.filter(record => record.cloud), ...records.filter(record => !cached.has(record.id))]
        .sort((a, b) => b.time - a.time || a.id.localeCompare(b.id, 'en'));
      const selected = [];
      let limited = false;
      for (const record of ranked) {
        const localRecord = cached.has(record.id);
        const size = localRecord ? record.size : record.cloud.renditions
          .reduce((total, image) => total + image.details.thumbnail.bytes, 0);
        if (!slots || size > bytes) {
          limited ||= !localRecord;
          continue;
        }
        if (!localRecord) selected.push(record);
        slots--;
        bytes -= size;
      }
      const restored = [];
      let failed = 0;
      for (const record of selected) {
        onProgress(restored.length + failed, selected.length);
        try {
          const images = await Promise.all(record.cloud.renditions.map((_, index) => session.getImage(record.cloud, index, 'thumbnail')));
          restored.push({...record, images});
        } catch (error) {
          if (error.status === 401) throw error;
          failed++;
        }
      }
      if (store !== session) throw new Error('云图库连接已变更，请重新合并。');
      const result = await mergeCloudImageHistory(restored);
      return {...result, limited: limited || result.skipped > 0, unavailable: skipped + failed};
    },
  };
}
