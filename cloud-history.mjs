import {createCloudImageStore} from './cloud-image-store.mjs';
import {makeImageRenditions} from './image-renditions.mjs';
import {mergeImageHistory, readImageHistory, replaceImageHistoryWithCloud} from './image-history.mjs';
import {readHistoryLimits} from './history-limits.mjs';

const modeKey = 'moonlight-history-cloud-gallery';
const validInterval = value => Number.isInteger(value) && value >= 1 && value <= 1440;

export function createCloudHistory() {
  let store;
  let firstListing;
  let settings = {enabled: false, interval: 15};
  try {
    const saved = JSON.parse(localStorage.getItem(modeKey));
    if (saved && validInterval(saved.interval)) settings = {enabled: saved.enabled === true, interval: saved.interval};
  } catch {}

  function connected() {
    if (!store) throw new Error('请先在历史设置中连接并解锁 Google Drive。');
    return store;
  }

  async function transfer(record) {
    const session = connected();
    const renditions = [];
    for (const image of record.images) renditions.push(await makeImageRenditions(image));
    const cloud = await session.putBatch(record, renditions);
    if (store !== session) throw new Error('云图库连接已变更，本地原图已保留。');
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
      const listing = await candidate.listBatches();
      if (!listing.records.length && listing.skipped) throw new Error('此口令无法解锁现有云图库。');
      if (!listing.records.length && passphrase !== confirmation) throw new Error('首次使用云图库，请再输入一次相同的口令。');
      store = candidate;
      firstListing = settings.enabled ? listing : undefined;
    },
    lock() { store = undefined; firstListing = undefined; },
    transfer,
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
      const listing = firstListing ?? session.listBatches();
      firstListing = undefined;
      const {records, skipped} = await listing;
      const existing = new Set((await readImageHistory()).map(record => record.id));
      const limit = readHistoryLimits().imageCount;
      const selected = records.slice().sort((a, b) => b.time - a.time).slice(0, limit).filter(record => !existing.has(record.id));
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
      return {...await mergeImageHistory(restored), unavailable: skipped + failed};
    },
  };
}
