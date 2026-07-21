import { readBytes } from './ContentBundle.js';

const DB_NAME = 'libretrowebxr-save-ram';
const STORE = 'cards';
const SCHEMA_VERSION = 1;
const DEFAULT_BACKUP_COUNT = 3;
let dbPromise;

export function saveRamKey(coreId, contentId, slot = 1) {
  if (!coreId || !contentId) throw new Error('SaveRAM requires a core ID and content ID');
  if (!Number.isInteger(slot) || slot < 1) throw new Error('SaveRAM slot must be a positive integer');
  return `${encodeURIComponent(coreId)}|${encodeURIComponent(contentId)}|${slot}`;
}

export class SaveRamStore {
  constructor({ backupCount = DEFAULT_BACKUP_COUNT } = {}) {
    this.backupCount = backupCount;
  }

  async load({ coreId, contentId, slot = 1 }) {
    const conn = await openDb();
    return request(conn.transaction(STORE, 'readonly').objectStore(STORE).get(saveRamKey(coreId, contentId, slot)));
  }

  async save({ coreId, contentId, slot = 1, data, coreBuildHash = 'unversioned', entryPath = null }) {
    const bytes = await readBytes(data);
    const key = saveRamKey(coreId, contentId, slot);
    const conn = await openDb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const get = store.get(key);
      let next;
      get.onsuccess = () => {
        const previous = get.result;
        const backups = previous?.data ? [
          { data: previous.data, savedAt: previous.savedAt, byteLength: previous.byteLength, coreBuildHash: previous.coreBuildHash },
          ...(previous.backups || []),
        ].slice(0, this.backupCount) : [];
        next = {
          key,
          schemaVersion: SCHEMA_VERSION,
          coreId,
          coreBuildHash,
          contentId,
          entryPath,
          slot,
          data: bytes,
          byteLength: bytes.byteLength,
          savedAt: Date.now(),
          backups,
        };
        store.put(next);
      };
      tx.oncomplete = () => resolve(next);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('SaveRAM transaction aborted'));
    });
  }

  async restoreBackup({ coreId, contentId, slot = 1, backupIndex = 0 }) {
    const current = await this.load({ coreId, contentId, slot });
    const backup = current?.backups?.[backupIndex];
    if (!backup) throw new Error(`SaveRAM backup ${backupIndex} does not exist`);
    return this.save({
      coreId,
      contentId,
      slot,
      data: backup.data,
      coreBuildHash: backup.coreBuildHash || current.coreBuildHash,
      entryPath: current.entryPath,
    });
  }

  async remove({ coreId, contentId, slot = 1 }) {
    const conn = await openDb();
    const tx = conn.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(saveRamKey(coreId, contentId, slot));
    return transaction(tx);
  }
}

function openDb() {
  if (dbPromise) return dbPromise;
  if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable'));
  dbPromise = new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: 'key' });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return dbPromise;
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function transaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
