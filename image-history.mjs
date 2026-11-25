const databaseName = 'moonlight-image-history';
const storeName = 'generations';
const recordLimit = 30;
const byteLimit = 64 * 1024 * 1024;

function openHistory() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, {autoIncrement: true});
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readImageHistory() {
  const db = await openHistory();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(storeName).objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result.reverse());
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function saveImageHistory({images, model, provider, prompt, seed, language, time, metrics, text, sources}) {
  const size = images.reduce((total, image) => total + image.size, 0);
  if (size > byteLimit) throw new Error('图片超过生图记录的存储上限。');
  const db = await openHistory();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const scan = store.openCursor(null, 'prev');
      let count = 1;
      let bytes = size;
      let prune = false;
      scan.onsuccess = () => {
        const cursor = scan.result;
        if (!cursor) {
          store.add({images, model, provider, prompt, seed, language, time, size, metrics, text, sources});
          return;
        }
        prune ||= count >= recordLimit || bytes + cursor.value.size > byteLimit;
        if (prune) cursor.delete();
        else {
          count++;
          bytes += cursor.value.size;
        }
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
