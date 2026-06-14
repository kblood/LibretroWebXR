// RomResolver — turn a normalized game entry into ROM bytes (an ArrayBuffer),
// resolving from one of four sources (see docs/ROOM_AND_COLLECTIONS.md §2):
//
//   url    fetch from the web (or a relative path under roms/) — the default,
//          and the only source our shipping CC0 games use.
//   local  a folder the user granted once via the File System Access API
//          ("my ROM library on this PC/headset"); the directory handle is
//          persisted in IndexedDB, so on return visits it's a one-click re-grant.
//          Games match by filename (rom.path/filename/file, basename, case-
//          insensitive), searched a few levels deep.
//   pick   a one-off <input type=file> — the always-available fallback.
//   opfs   the Origin-Private File System cache. Purely content-addressed:
//          we only cache (and serve) entries that declare a `sha1`, so a cache
//          hit can never be stale. Filename-only entries (like our relative CC0
//          games, which rebuild in place during dev) are never OPFS-cached.
//
// resolve(meta) tries the OPFS cache first (when a sha1 is known), then walks
// the declared/implied source order, and writes the result back to the cache
// (sha1 entries only). The pure helpers below are unit-tested in Node; the
// browser-API parts (FSA, OPFS, file picker) are exercised by the debug harness.

const HANDLE_DB = 'libretrowebxr-roms';
const HANDLE_STORE = 'handles';
const LIBRARY_KEY = 'library';

// --- Pure helpers (no browser APIs — unit-tested) --------------------------

/** Basename of a path (handles both / and \\ separators). */
export function fileBaseName(p) {
  return String(p || '').split(/[\\/]/).pop();
}

/** The filename a `local`/`pick` game should match against, basename only. */
export function wantedFileName(meta) {
  return fileBaseName(meta?.rom?.path || meta?.rom?.filename || meta?.file || '');
}

/** Case-insensitive basename equality (for matching files in a local folder). */
export function fileNameMatches(wanted, candidate) {
  const w = fileBaseName(wanted).toLowerCase();
  return w !== '' && w === fileBaseName(candidate).toLowerCase();
}

/**
 * Fetchable URL for a `url`-sourced (or legacy) entry, or null if none.
 * An absolute http(s) URL or a rooted path is used as-is (a collection hosted
 * elsewhere can point at its own ROMs); a bare relative path resolves under
 * `base` (default roms/). This is the logic that used to live in main.js.
 */
export function romUrlFor(meta, { base = 'roms/' } = {}) {
  const f = meta?.rom?.url || meta?.file;
  if (!f) return null;
  if (/^https?:\/\//i.test(f) || f.startsWith('/')) return f;
  return base + f;
}

/**
 * Ordered list of fetch sources to attempt for an entry (OPFS fast-path is
 * handled separately). Explicit `rom.sources[]` wins, then a single
 * `rom.source`, else `url` if one is derivable, else `pick`.
 */
export function sourceOrder(meta) {
  const r = meta?.rom || {};
  if (Array.isArray(r.sources) && r.sources.length) return r.sources.slice();
  if (r.source) return [r.source];
  if (romUrlFor(meta)) return ['url'];
  return ['pick'];
}

/** Content-addressed OPFS cache key for an entry, or null if no sha1 declared. */
export function cacheKey(meta) {
  const sha1 = meta?.rom?.sha1;
  return sha1 ? `sha1-${String(sha1).toLowerCase()}` : null;
}

/**
 * True when the ROM is a locally-picked (or OPFS-cached) file that has no
 * server URL — re-resolving it via `url` would 404, so callers can surface a
 * more helpful "pick the file again" message instead of "ROM not installed".
 *
 * A ROM is considered local-only when `rom.sources` (or `rom.source`) is
 * explicitly set and contains ONLY opfs/pick entries. Entries that fall
 * through to the default (`['url']` or `['pick']`) because no explicit source
 * was declared are NOT considered local — the default pick fallback applies to
 * any entry with no URL, which is too broad.
 */
export function isLocalRomMeta(meta) {
  const r = meta?.rom;
  if (!r) return false; // no rom block → default url resolution, not a local pick
  if (Array.isArray(r.sources) && r.sources.length) {
    return r.sources.every((s) => s === 'opfs' || s === 'pick');
  }
  if (r.source) return r.source === 'opfs' || r.source === 'pick';
  return false; // no explicit source declared → not a known local-pick
}

/**
 * Diagnostic snapshot of how a ROM *would* be resolved — safe to call in Node
 * (no browser APIs touched). Intended for boot telemetry: log this object plus
 * opfsSupported() before/after resolve() so a headset failure can be diagnosed
 * from remote logs alone.
 *
 * Shape:
 *   { sha1, cacheKey, order, url, wantedFile }
 */
export function resolutionPlan(meta) {
  return {
    sha1: meta?.rom?.sha1 ?? null,
    cacheKey: cacheKey(meta),
    order: sourceOrder(meta),
    url: romUrlFor(meta),
    wantedFile: wantedFileName(meta) || null,
  };
}

// --- Browser feature detection ---------------------------------------------

/** Is the File System Access API (persistent local folder) available? */
export function fileSystemAccessSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/** Is the Origin-Private File System (OPFS cache) available? */
export function opfsSupported() {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
}

// --- IndexedDB: persist the granted library directory handle ---------------
// Directory handles are structured-cloneable, so IndexedDB is the documented
// way to remember a folder across sessions (mirrors SaveState.js's store).

let _dbPromise = null;
function handleDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(HANDLE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function putHandle(key, value) {
  return handleDb().then((conn) => new Promise((resolve, reject) => {
    const tx = conn.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function getHandle(key) {
  return handleDb().then((conn) => new Promise((resolve, reject) => {
    const tx = conn.transaction(HANDLE_STORE, 'readonly');
    const req = tx.objectStore(HANDLE_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

function delHandle(key) {
  return handleDb().then((conn) => new Promise((resolve, reject) => {
    const tx = conn.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// --- Library directory (the user's local ROM folder) -----------------------

/**
 * Prompt the user to grant a ROM library folder and persist the handle.
 * Must be called from a user gesture. Returns the directory handle.
 */
export async function pickLibraryDirectory() {
  if (!fileSystemAccessSupported()) throw new Error('File System Access API unavailable');
  const handle = await window.showDirectoryPicker({ id: 'libretrowebxr-roms', mode: 'read' });
  await putHandle(LIBRARY_KEY, handle);
  return handle;
}

/** True if a library folder was previously granted (handle persisted). */
export async function hasLibraryDirectory() {
  try { return !!(await getHandle(LIBRARY_KEY)); }
  catch { return false; }
}

/** Forget the granted library folder. */
export function forgetLibraryDirectory() {
  return delHandle(LIBRARY_KEY);
}

async function ensureReadable(handle) {
  if (!handle.queryPermission) return true; // older impls grant implicitly
  let p = await handle.queryPermission({ mode: 'read' });
  if (p === 'granted') return true;
  p = await handle.requestPermission({ mode: 'read' }); // needs a user gesture
  return p === 'granted';
}

// Depth-limited search of a directory handle for a file by basename.
async function findInDirectory(dir, wantLc, depth = 4) {
  const subdirs = [];
  for await (const [name, entry] of dir.entries()) {
    if (entry.kind === 'file') {
      if (name.toLowerCase() === wantLc) return entry;
    } else if (entry.kind === 'directory') {
      subdirs.push(entry);
    }
  }
  if (depth > 0) {
    for (const sub of subdirs) {
      const found = await findInDirectory(sub, wantLc, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

// --- OPFS cache (content-addressed by sha1) --------------------------------

async function opfsGet(key) {
  if (!key || !opfsSupported()) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(key);
    const file = await fh.getFile();
    return await file.arrayBuffer();
  } catch {
    return null; // not cached
  }
}

async function opfsPut(key, buf) {
  if (!key || !opfsSupported()) return;
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(key, { create: true });
  const w = await fh.createWritable();
  await w.write(buf);
  await w.close();
}

/** Lower-case hex SHA-1 of an ArrayBuffer (Web Crypto; needs a secure context). */
export async function sha1Hex(buf) {
  const digest = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Stash freshly-obtained ROM bytes (e.g. from a one-off file pick) into the
 * content-addressed OPFS cache and return their sha1 hex, so a cartridge minted
 * for the ROM can be re-resolved later via `source:'opfs'` without re-picking
 * the file. Returns null when OPFS is unavailable — the caller should then keep
 * `pick` as the fallback source.
 */
export async function cacheRom(buf) {
  if (!opfsSupported()) return null;
  try {
    const sha1 = await sha1Hex(buf);
    await opfsPut(`sha1-${sha1}`, buf);
    return sha1;
  } catch {
    return null;
  }
}

// --- Per-source fetchers ----------------------------------------------------

async function fromUrl(meta, { fetchImpl } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) throw new Error('fetch unavailable');
  const url = romUrlFor(meta);
  if (!url) throw new Error('no URL for ROM');
  const r = await f(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.arrayBuffer();
}

async function fromLocal(meta) {
  const handle = await getHandle(LIBRARY_KEY);
  if (!handle) throw new Error('no ROM library folder granted (pick one first)');
  if (!(await ensureReadable(handle))) throw new Error('permission to ROM library denied');
  const want = wantedFileName(meta);
  if (!want) throw new Error('local source needs a filename');
  const fileHandle = await findInDirectory(handle, want.toLowerCase());
  if (!fileHandle) throw new Error(`"${want}" not found in ROM library folder`);
  const file = await fileHandle.getFile();
  return file.arrayBuffer();
}

function fromPick(meta) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') return reject(new Error('file picker unavailable'));
    const input = document.createElement('input');
    input.type = 'file';
    const want = wantedFileName(meta);
    if (want) {
      const ext = want.includes('.') ? '.' + want.split('.').pop() : '';
      if (ext) input.accept = ext;
    }
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error('no file picked'));
      try { resolve(await file.arrayBuffer()); }
      catch (e) { reject(e); }
    }, { once: true });
    // Opening a picker requires a user gesture; the caller must invoke resolve()
    // from one (e.g. a cartridge-insert in response to a controller press).
    input.click();
  });
}

// --- Orchestrator -----------------------------------------------------------

/**
 * Resolve a game entry to ROM bytes.
 * @param {object} meta  normalized game entry (file/system/core/title + rom{})
 * @param {object} [opts]
 * @param {string} [opts.source]     force a single source (url|local|pick|opfs)
 * @param {Function} [opts.fetchImpl] inject fetch (for tests/harness)
 * @returns {Promise<ArrayBuffer>}
 */
export async function resolve(meta, opts = {}) {
  const key = cacheKey(meta);

  // Content-addressed OPFS fast path (never stale — keyed by sha1).
  if (key && opts.source !== 'url' && opts.source !== 'local' && opts.source !== 'pick') {
    const cached = await opfsGet(key);
    if (cached) return cached;
  }

  const order = opts.source ? [opts.source] : sourceOrder(meta);
  let buf = null;
  const srcErrors = []; // aggregated per-source diagnostics
  for (const src of order) {
    try {
      if (src === 'url') buf = await fromUrl(meta, opts);
      else if (src === 'local') buf = await fromLocal(meta);
      else if (src === 'pick') buf = await fromPick(meta);
      else if (src === 'opfs') buf = await opfsGet(key);
      else throw new Error(`unknown ROM source "${src}"`);
      if (buf) break;
      // Source returned a falsy value (e.g. opfsGet miss returns null).
      srcErrors.push(`${src}: not cached`);
    } catch (e) {
      srcErrors.push(`${src}: ${e.message}`);
    }
  }
  if (!buf) {
    const title = meta?.title || meta?.file || '?';
    const detail = srcErrors.length ? srcErrors.join('; ') : 'no sources attempted';
    throw new Error(`could not resolve ROM for "${title}": ${detail}`);
  }

  // Best-effort write-through cache, sha1 entries only (so never stale).
  if (key) opfsPut(key, buf).catch(() => {});
  return buf;
}
