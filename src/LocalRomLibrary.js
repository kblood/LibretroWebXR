// LocalRomLibrary — persist the list of locally-picked ROMs (files the user
// loaded via the in-app file picker) so their shelf cartridges reappear after
// a page reload without requiring a re-pick.
//
// Each entry is the minimal meta needed to re-mint a cart and resolve the bytes
// from OPFS (content-addressed by sha1, written by cacheRom in RomResolver.js):
//
//   { file, system, core, title, sha1, sources: ['opfs', 'pick'] }
//
// Pure serialize/parse (no THREE, no DOM — unit-tested in Node) + a thin
// localStorage I/O pair. Mirrors the pattern in src/RackPersistence.js.
//
// Storage key: 'libretrowebxr.localroms'   (localStorage)

export const LOCAL_ROMS_KEY = 'libretrowebxr.localroms';
const SCHEMA = 'libretrowebxr/localroms@1';

// --- Pure list helpers (no browser globals) ---------------------------------

/**
 * Add or update an entry in the list. Deduplication is by sha1 — if an entry
 * with the same sha1 already exists it is replaced in place (same index),
 * otherwise the new entry is appended. The input list is NOT mutated; a new
 * array is returned.
 *
 * Only entries that carry a sha1 (OPFS-backed) may be persisted — callers
 * should not pass sha1-less entries (they can't be re-resolved after reload).
 *
 * @param {Array} list   current list (may be [])
 * @param {object} meta  cart meta: { file, system, core, title, sha1, ... }
 * @returns {Array} new list
 */
export function addEntry(list, meta) {
  if (!meta || typeof meta.sha1 !== 'string' || !meta.sha1) return list;
  const sha1 = meta.sha1.toLowerCase();
  const entry = {
    file:    String(meta.file    || ''),
    system:  String(meta.system  || 'unknown'),
    core:    String(meta.core    || ''),
    title:   String(meta.title   || meta.file || ''),
    sha1,
    sources: ['opfs', 'pick'],
  };
  const idx = list.findIndex((e) => e.sha1 === sha1);
  if (idx === -1) return [...list, entry];
  const next = [...list];
  next[idx] = entry;
  return next;
}

/**
 * Remove the entry with the given sha1 from the list. Returns a new array.
 * A no-op (returns the same list) if the sha1 is not present.
 *
 * @param {Array}  list
 * @param {string} sha1
 * @returns {Array}
 */
export function removeEntry(list, sha1) {
  if (!sha1) return list;
  const lc = sha1.toLowerCase();
  return list.filter((e) => e.sha1 !== lc);
}

/**
 * Serialize the list to a JSON-ready object for localStorage.
 * @param {Array} list
 * @returns {object}
 */
export function serialize(list) {
  return {
    schema: SCHEMA,
    roms: (list || []).map((e) => ({
      file:    e.file,
      system:  e.system,
      core:    e.core,
      title:   e.title,
      sha1:    e.sha1,
      sources: e.sources || ['opfs', 'pick'],
    })),
  };
}

/**
 * Parse a previously serialized object (or a raw JSON.parse result) back into
 * the canonical list form. Returns [] on any error, missing data, or corrupt
 * input so callers never have to guard against exceptions from this function.
 *
 * @param {*} raw  the parsed JSON object (or null / undefined)
 * @returns {Array}
 */
export function parse(raw) {
  try {
    if (!raw || typeof raw !== 'object') return [];
    if (typeof raw.schema !== 'string' || !raw.schema.startsWith('libretrowebxr/localroms')) return [];
    if (!Array.isArray(raw.roms)) return [];
    return raw.roms
      .filter((e) => e && typeof e.sha1 === 'string' && e.sha1
                       && typeof e.file === 'string' && e.file)
      .map((e) => ({
        file:    String(e.file),
        system:  typeof e.system === 'string' ? e.system : 'unknown',
        core:    typeof e.core   === 'string' ? e.core   : '',
        title:   typeof e.title  === 'string' ? e.title  : e.file,
        sha1:    String(e.sha1).toLowerCase(),
        sources: Array.isArray(e.sources) ? e.sources : ['opfs', 'pick'],
      }));
  } catch {
    return [];
  }
}

/**
 * Convert a stored entry back to the cart meta shape that addLocalRomToShelf
 * (and handleCartridgeInserted) expect.
 *
 * @param {object} entry  a parsed library entry
 * @returns {object}  { file, system, core, title, rom: { sha1, sources } }
 */
export function toCartMeta(entry) {
  return {
    file:   entry.file,
    system: entry.system,
    core:   entry.core,
    title:  entry.title,
    rom:    { sha1: entry.sha1, sources: entry.sources || ['opfs', 'pick'] },
  };
}

// --- localStorage I/O -------------------------------------------------------

/**
 * Load the persisted local-ROM list from localStorage.
 * Returns [] on failure, missing data, or corrupt storage.
 */
export function loadLocalRoms() {
  try {
    const raw = localStorage.getItem(LOCAL_ROMS_KEY);
    if (!raw) return [];
    return parse(JSON.parse(raw));
  } catch (e) {
    console.warn('[LocalRomLibrary] load failed:', e);
    return [];
  }
}

/**
 * Persist the local-ROM list to localStorage.
 * Silently no-ops if storage is unavailable (private mode, quota exceeded).
 * If the list is empty the key is removed rather than storing empty JSON.
 *
 * @param {Array} list
 */
export function saveLocalRoms(list) {
  try {
    if (!list || list.length === 0) {
      localStorage.removeItem(LOCAL_ROMS_KEY);
      return;
    }
    localStorage.setItem(LOCAL_ROMS_KEY, JSON.stringify(serialize(list)));
  } catch (e) {
    console.warn('[LocalRomLibrary] save failed:', e);
  }
}
