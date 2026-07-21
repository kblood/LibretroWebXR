// IndexedDB wrapper for libretro save-state blobs, one per memory-card slot.
// Schema: object store 'states', keyed by slot id (e.g. "slot-1"), value
//   { data: Uint8Array, core, file, title, system, ts }
// Save-state binary sizes range from a few KB (NES) to ~256KB (SNES) to
// several MB (newer systems), well within IndexedDB's per-record limits.

const DB_NAME = 'libretrowebxr-saves';
const STORE = 'states';
export const SAVE_STATE_SCHEMA_VERSION = 1;

let _dbPromise = null;

function db() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

export async function saveState(slotId, payload) {
  const conn = await db();
  const record = prepareSaveStatePayload(payload);
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record, slotId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadState(slotId) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(slotId);
    req.onsuccess = () => resolve(req.result ? prepareSaveStatePayload(req.result) : null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearState(slotId) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(slotId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listStates() {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const out = [];
    const tx = conn.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).openCursor();
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { out.push({ slotId: cur.key, ...prepareSaveStatePayload(cur.value) }); cur.continue(); }
      else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

export function prepareSaveStatePayload(payload) {
  if (!payload || !payload.data) throw new Error('Save state payload must include binary data');
  const byteLength = payload.data.byteLength ?? payload.data.length;
  return {
    ...payload,
    stateSchemaVersion: payload.stateSchemaVersion || SAVE_STATE_SCHEMA_VERSION,
    coreId: payload.coreId || payload.core || null,
    coreBuildHash: payload.coreBuildHash || 'unversioned',
    contentId: payload.contentId || null,
    entryPath: payload.entryPath || payload.file || null,
    ts: payload.ts || Date.now(),
    byteLength,
  };
}

export function checkSaveStateCompatibility(record, current) {
  if (!record) return { compatible: false, reason: 'missing-state' };
  const expectedCore = current.coreId || current.core;
  if (record.coreId && expectedCore && record.coreId !== expectedCore) {
    return { compatible: false, reason: 'core-mismatch' };
  }
  if (record.contentId && current.contentId && record.contentId !== current.contentId) {
    return { compatible: false, reason: 'content-mismatch' };
  }
  if (record.coreBuildHash && current.coreBuildHash && record.coreBuildHash !== 'unversioned' && current.coreBuildHash !== 'unversioned' && record.coreBuildHash !== current.coreBuildHash) {
    return { compatible: false, reason: 'core-build-mismatch' };
  }
  return { compatible: true, reason: null };
}
