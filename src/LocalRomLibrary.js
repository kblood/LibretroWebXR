// LocalRomLibrary — persist the list of locally-picked ROMs (files the user
// loaded via the in-app file picker) so their shelf cartridges reappear after
// a page reload without requiring a re-pick.
//
// Two entry shapes, both content-addressed and resolvable from OPFS alone
// (no original File objects needed):
//
//   single-file: { file, system, core, title, sha1, sources: ['opfs', 'pick'] }
//     bytes cached by cacheRom (RomResolver.js), keyed by sha1.
//
//   multi-file (C4, 2026-07-27 — CUE+BIN, M3U+discs):
//     { file, system, core, title,
//       bundle: { contentId, entryPath, files: [path, ...] },
//       sources: ['opfs', 'pick'] }
//     companion files cached by cacheBundle (RomResolver.js), keyed by
//     contentId (a ContentBundle's own stable sha256 over every file).
//
// Pure serialize/parse (no THREE, no DOM — unit-tested in Node) + a thin
// localStorage I/O pair. Mirrors the pattern in src/RackPersistence.js.
//
// Storage key: 'libretrowebxr.localroms'   (localStorage)

export const LOCAL_ROMS_KEY = 'libretrowebxr.localroms';
const SCHEMA = 'libretrowebxr/localroms@1';

// --- Pure list helpers (no browser globals) ---------------------------------

function isBundleDescriptor(bundle) {
  return !!(bundle && typeof bundle.contentId === 'string' && bundle.contentId
    && Array.isArray(bundle.files) && bundle.files.length);
}

/**
 * Add or update an entry in the list. A `meta.bundle` descriptor (see file
 * header) mints/updates a multi-file entry, deduplicated by `contentId`;
 * otherwise `meta.sha1` mints/updates a single-file entry, deduplicated by
 * sha1 — same as before C4. Entries with neither are not persisted (they
 * can't be re-resolved after reload). The input list is NOT mutated; a new
 * array is returned.
 *
 * @param {Array} list   current list (may be [])
 * @param {object} meta  cart meta: { file, system, core, title, sha1|bundle, ... }
 * @returns {Array} new list
 */
export function addEntry(list, meta) {
  if (isBundleDescriptor(meta?.bundle)) {
    const entry = {
      file:    String(meta.file    || ''),
      system:  String(meta.system  || 'unknown'),
      core:    String(meta.core    || ''),
      title:   String(meta.title   || meta.file || ''),
      bundle:  {
        contentId: String(meta.bundle.contentId),
        entryPath: String(meta.bundle.entryPath || ''),
        files:     meta.bundle.files.map(String),
      },
      sources: ['opfs', 'pick'],
    };
    const idx = list.findIndex((e) => e.bundle?.contentId === entry.bundle.contentId);
    if (idx === -1) return [...list, entry];
    const next = [...list];
    next[idx] = entry;
    return next;
  }

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
 * Remove the entry with the given identity (a single-file sha1, or a
 * multi-file entry's bundle.contentId) from the list. Returns a new array.
 * A no-op (returns the same list) if the identity is not present.
 *
 * @param {Array}  list
 * @param {string} identity
 * @returns {Array}
 */
export function removeEntry(list, identity) {
  if (!identity) return list;
  const lc = String(identity).toLowerCase();
  return list.filter((e) => e.sha1 !== lc && e.bundle?.contentId !== identity);
}

/**
 * Serialize the list to a JSON-ready object for localStorage.
 * @param {Array} list
 * @returns {object}
 */
export function serialize(list) {
  return {
    schema: SCHEMA,
    roms: (list || []).map((e) => (e.bundle
      ? {
          file:    e.file,
          system:  e.system,
          core:    e.core,
          title:   e.title,
          bundle:  { contentId: e.bundle.contentId, entryPath: e.bundle.entryPath, files: e.bundle.files },
          sources: e.sources || ['opfs', 'pick'],
        }
      : {
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
      .filter((e) => e && typeof e.file === 'string' && e.file
                       && ((typeof e.sha1 === 'string' && e.sha1) || isBundleDescriptor(e.bundle)))
      .map((e) => {
        const base = {
          file:    String(e.file),
          system:  typeof e.system === 'string' ? e.system : 'unknown',
          core:    typeof e.core   === 'string' ? e.core   : '',
          title:   typeof e.title  === 'string' ? e.title  : e.file,
          sources: Array.isArray(e.sources) ? e.sources : ['opfs', 'pick'],
        };
        if (isBundleDescriptor(e.bundle)) {
          return {
            ...base,
            bundle: {
              contentId: String(e.bundle.contentId),
              entryPath: String(e.bundle.entryPath || ''),
              files:     e.bundle.files.map(String),
            },
          };
        }
        return { ...base, sha1: String(e.sha1).toLowerCase() };
      });
  } catch {
    return [];
  }
}

/**
 * Convert a stored entry back to the cart meta shape that addLocalRomToShelf
 * (and handleCartridgeInserted) expect.
 *
 * @param {object} entry  a parsed library entry
 * @returns {object}  { file, system, core, title, rom: { sha1|bundle, sources } }
 */
export function toCartMeta(entry) {
  const rom = entry.bundle
    ? { bundle: entry.bundle, sources: entry.sources || ['opfs', 'pick'] }
    : { sha1: entry.sha1, sources: entry.sources || ['opfs', 'pick'] };
  return {
    file:   entry.file,
    system: entry.system,
    core:   entry.core,
    title:  entry.title,
    rom,
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
