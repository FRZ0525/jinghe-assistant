(function (window) {
  "use strict";

  const NAME = "jinghe-assistant-recovery-v1";
  const STORE = "points";
  const LIMIT = 8;
  let opening;

  function database() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opening = undefined;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("恢复点存储被另一个页面占用"));
    }).catch((error) => {
      opening = undefined;
      throw error;
    });
    return opening;
  }

  async function operate(mode, work) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  function trim() {
    return operate("readwrite", (store) => {
      const keys = store.getAllKeys();
      keys.onsuccess = () => {
        for (const key of keys.result.slice(0, Math.max(0, keys.result.length - LIMIT))) {
          store.delete(key);
        }
      };
      return keys;
    });
  }

  window.JingheRecovery = {
    add: (point) => operate("readwrite", (store) => store.add(point)),
    trim,
    remove: (id) => operate("readwrite", (store) => store.delete(id)),
    list: async () => (await operate("readonly", (store) => store.getAll())).slice(-LIMIT),
  };
})(window);
