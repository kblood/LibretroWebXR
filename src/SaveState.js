// IndexedDB wrapper for libretro save-state blobs, one per memory-card slot.
// Schema: object store 'states', keyed by slot id (e.g. "slot-1"), value
//   { data: Uint8Array, core, file, title, system, ts }
// Save-state binary sizes range from a few KB (NES) to ~256KB (SNES) to
// several MB (newer systems), well within IndexedDB's per-record limits.

const DB_NAME = 'libretrowebxr-saves';
const STORE = 'states';

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
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(payload, slotId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadState(slotId) {
  const conn = await db();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(slotId);
    req.onsuccess = () => resolve(req.result || null);
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
      if (cur) { out.push({ slotId: cur.key, ...cur.value }); cur.continue(); }
      else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}
