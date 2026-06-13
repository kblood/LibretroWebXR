// ImageLibrary — grant + persist an "images" folder (File System Access API),
// list image files in it, and produce object URLs THREE.TextureLoader can load.
//
// Mirrors the RomResolver pattern exactly: one IndexedDB key stores the
// directory handle; `pickImagesDirectory` / `hasImagesDirectory` / `listImages`
// are the public API. Pure helpers (extension filtering, etc.) live below the
// IndexedDB section and are unit-tested in Node via scripts/test-imagelibrary.mjs.
//
// On-headset (Quest) path:
//   showDirectoryPicker works on Quest browser (Chromium-based) with a user
//   gesture — the folder browser appears over the VR compositor. This is the
//   ONLY reliable way to pick many files inside a WebXR session; <input type=file>
//   does NOT reliably show a picker while presenting in XR.
//
// Desktop fallback:
//   Where showDirectoryPicker is unavailable (non-Chromium, Safari, older Edge)
//   `fileSystemAccessSupported()` returns false and the caller can fall back to
//   a normal <input type=file accept="image/*"> for individual images.

const IMAGES_DB    = 'libretrowebxr-images';
const IMAGES_STORE = 'handles';
const IMAGES_KEY   = 'images-library';

// Image extensions we recognise as "image files" when listing a folder.
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg']);

// --- Pure helpers (no browser APIs — unit-tested in Node) ------------------

/**
 * Return the lowercased extension of a filename (without the dot), or '' if none.
 * Works with both '/' and '\' path separators.
 */
export function fileExtension(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * True if `name` looks like an image file we support.
 * Pure — safe to call in Node (used by the unit-test suite).
 */
export function isImageFile(name) {
  return IMAGE_EXTS.has(fileExtension(name));
}

/**
 * Filter a flat list of filenames to just the image files.
 * @param {string[]} names
 * @returns {string[]}
 */
export function filterImageNames(names) {
  return names.filter(isImageFile);
}

// --- Browser feature detection ---------------------------------------------

/** True when the File System Access API (showDirectoryPicker) is available. */
export function fileSystemAccessSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

// --- IndexedDB: persist the granted images directory handle ----------------
// Directory handles are structured-cloneable so IndexedDB is the right store
// (same pattern as RomResolver). Using a SEPARATE database so clearing the ROM
// library never accidentally clears the images library.

let _dbPromise = null;
function imageDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IMAGES_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IMAGES_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror  = () => reject(req.error);
  });
  return _dbPromise;
}

function putHandle(key, value) {
  return imageDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGES_STORE, 'readwrite');
    tx.objectStore(IMAGES_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  }));
}

function getHandle(key) {
  return imageDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGES_STORE, 'readonly');
    const req = tx.objectStore(IMAGES_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  }));
}

function delHandle(key) {
  return imageDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGES_STORE, 'readwrite');
    tx.objectStore(IMAGES_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  }));
}

// --- Permission helpers ----------------------------------------------------

async function ensureReadable(handle) {
  if (!handle.queryPermission) return true; // older impls grant implicitly
  let p = await handle.queryPermission({ mode: 'read' });
  if (p === 'granted') return true;
  // requestPermission needs a user gesture — the caller (a button click) satisfies this.
  p = await handle.requestPermission({ mode: 'read' });
  return p === 'granted';
}

// --- Public API: grant + query the images directory -----------------------

/**
 * Prompt the user to pick an images folder (must be called from a user gesture).
 * Persists the directory handle for future sessions. Returns the handle.
 * Throws if the API is unavailable or the user cancels.
 */
export async function pickImagesDirectory() {
  if (!fileSystemAccessSupported()) throw new Error('File System Access API unavailable');
  const handle = await window.showDirectoryPicker({ id: 'libretrowebxr-images', mode: 'read' });
  await putHandle(IMAGES_KEY, handle);
  return handle;
}

/** True if an images folder was previously granted (handle still persisted). */
export async function hasImagesDirectory() {
  try { return !!(await getHandle(IMAGES_KEY)); }
  catch { return false; }
}

/** Forget the granted images folder. */
export function forgetImagesDirectory() {
  return delHandle(IMAGES_KEY);
}

// --- List images in the granted folder ------------------------------------

/**
 * List all image files (first level only, non-recursive) in the persisted
 * images directory. Re-requests permission if needed.
 *
 * @returns {Promise<Array<{ name: string, handle: FileSystemFileHandle }>>}
 *   Sorted alphabetically by filename. Empty if no folder is granted or the
 *   folder contains no image files.
 */
export async function listImages() {
  const dirHandle = await getHandle(IMAGES_KEY);
  if (!dirHandle) return [];
  if (!(await ensureReadable(dirHandle))) return [];

  const entries = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file' && isImageFile(name)) {
      entries.push({ name, handle });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/**
 * Get an object URL for a file handle entry from listImages(). The caller is
 * responsible for revoking it (URL.revokeObjectURL) when done, typically when
 * the gallery is closed or a different folder is granted.
 *
 * @param {{ name: string, handle: FileSystemFileHandle }} entry
 * @returns {Promise<string>} blob: object URL
 */
export async function entryObjectUrl(entry) {
  const file = await entry.handle.getFile();
  return URL.createObjectURL(file);
}
