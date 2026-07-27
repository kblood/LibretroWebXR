const ENTRY_PRIORITY = ['m3u', 'cue', 'chd', 'ccd', 'pbp', 'exe'];

function extensionOf(path) {
  const name = String(path || '').replace(/\\/g, '/').split('/').pop();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export class ContentBundleError extends Error {
  constructor(message, code = 'INVALID_CONTENT_BUNDLE', details = {}) {
    super(message);
    this.name = 'ContentBundleError';
    this.code = code;
    this.details = details;
  }
}

export class ContentBundle {
  constructor({ entryPath, files, contentId, displayName, dependencies = [] }) {
    this.entryPath = entryPath;
    this.files = files;
    this.contentId = contentId;
    this.displayName = displayName;
    this.dependencies = Object.freeze([...dependencies]);
    Object.freeze(this);
  }

  static async fromFiles(fileList, options = {}) {
    const named = Array.from(fileList || [], (file) => ({
      path: file.webkitRelativePath || file.name,
      source: file,
    }));
    return ContentBundle.fromNamedSources(named, options);
  }

  static async fromNamedSources(namedSources, { entryPath, entryExtensions } = {}) {
    const files = new Map();
    for (const item of namedSources || []) {
      const path = normalizeContentPath(item.path || item.name);
      if (!path) throw new ContentBundleError('A selected file has no filename', 'MISSING_PATH');
      if (files.has(path)) throw new ContentBundleError(`Duplicate content path: ${path}`, 'DUPLICATE_PATH', { path });
      files.set(path, item.source ?? item.data ?? item.file);
    }
    if (!files.size) throw new ContentBundleError('Select at least one content file', 'EMPTY_BUNDLE');

    const selectedEntry = chooseEntry(files, entryPath, entryExtensions);
    const dependencies = await validateDependencies(selectedEntry, files);
    const contentId = await computeContentId(selectedEntry, files);
    const leaf = selectedEntry.split('/').pop();
    const displayName = leaf.replace(/\.[^.]+$/, '') || leaf;
    return new ContentBundle({ entryPath: selectedEntry, files, contentId, displayName, dependencies });
  }

  /**
   * Build a ContentBundle for an entry whose companion files are NOT already
   * in hand — only the entry's own bytes are (e.g. a collection/cartridge-
   * insert boot that fetched a lone `.cue`/`.m3u` by URL, unlike the desktop
   * multi-file picker's `fromFiles`, which already has every File selected up
   * front). Recursively parses cue/m3u FILE references (the same
   * parseCueReferences/parseM3uReferences validateDependencies below uses),
   * resolving each reference relative to its parent with the identical rule
   * `validateDependencies` applies, and fetches it lazily via the injected
   * `fetchCompanion(path)` callback — kept as a callback rather than a
   * hardcoded `fetch()` call so this stays Node-testable and reusable by any
   * future multi-track worker core (PS2) with its own URL-resolution rule.
   * `fetchCompanion` should resolve to a source `readBytes()` can consume, or
   * null/undefined for "not found" — a genuinely missing companion is still
   * surfaced as the normal MISSING_COMPANIONS error, via fromNamedSources'
   * own validateDependencies below, not thrown here. The resulting bundle is
   * built through `fromNamedSources`, so it has EXACTLY the same shape
   * (files Map, entryPath, dependencies, contentId) as `fromFiles` produces.
   */
  static async fromEntryFetch(entryPath, entrySource, fetchCompanion, options = {}) {
    const path = normalizeContentPath(entryPath);
    const files = new Map([[path, entrySource]]);
    const queue = [path];
    while (queue.length) {
      const current = queue.shift();
      const ext = extensionOf(current);
      if (ext !== 'cue' && ext !== 'm3u') continue;
      const text = await readText(files.get(current));
      const refs = ext === 'cue' ? parseCueReferences(text) : parseM3uReferences(text);
      for (const ref of refs) {
        let resolved;
        try { resolved = resolveRelative(current, ref); }
        catch (error) {
          if (error instanceof ContentBundleError) throw error;
          throw new ContentBundleError(`Unsafe reference in ${current}: ${ref}`, 'UNSAFE_REFERENCE', { entry: current, reference: ref });
        }
        if (files.has(resolved)) continue;
        const source = await fetchCompanion(resolved);
        if (source == null) continue; // let fromNamedSources' validateDependencies report it missing
        files.set(resolved, source);
        queue.push(resolved);
      }
    }
    const named = [...files].map(([p, source]) => ({ path: p, source }));
    return ContentBundle.fromNamedSources(named, { entryPath: path, ...options });
  }
}

export function normalizeContentPath(input) {
  const raw = String(input || '').replace(/\\/g, '/');
  if (!raw) return '';
  if (raw.includes('\0')) throw new ContentBundleError('Content paths cannot contain NUL characters', 'UNSAFE_PATH', { path: raw });
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('//') || raw.startsWith('/')) {
    throw new ContentBundleError(`Absolute paths and URLs are not allowed: ${raw}`, 'UNSAFE_PATH', { path: raw });
  }
  const parts = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new ContentBundleError(`Parent traversal is not allowed: ${raw}`, 'UNSAFE_PATH', { path: raw });
    parts.push(part);
  }
  return parts.join('/');
}

export function parseCueReferences(text) {
  const refs = [];
  for (const line of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^\s*FILE\s+(?:"([^"]+)"|([^\s]+))\s+/i.exec(line);
    if (match) refs.push(match[1] || match[2]);
  }
  return refs;
}

export function parseM3uReferences(text) {
  return String(text).replace(/^\uFEFF/, '').split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function chooseEntry(files, requested, allowedExtensions) {
  if (requested) {
    const path = normalizeContentPath(requested);
    const actual = findPath(files, path);
    if (!actual) throw new ContentBundleError(`Entry file is missing: ${path}`, 'MISSING_ENTRY', { path });
    return actual;
  }

  const allowed = allowedExtensions?.map((ext) => ext.toLowerCase());
  const candidates = [...files.keys()].filter((path) => !allowed || allowed.includes(extensionOf(path)));
  if (files.size === 1 && candidates.length === 1) return candidates[0];
  for (const ext of ENTRY_PRIORITY) {
    const matches = candidates.filter((path) => extensionOf(path) === ext);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new ContentBundleError(`Multiple .${ext} entry files selected; choose one explicitly`, 'AMBIGUOUS_ENTRY', { candidates: matches });
    }
  }
  if (candidates.length === 1) return candidates[0];
  throw new ContentBundleError('Could not determine the content entry file', 'AMBIGUOUS_ENTRY', { candidates });
}

async function validateDependencies(entryPath, files) {
  const visited = new Set();
  const ordered = [];
  const missing = [];

  async function visit(path) {
    if (visited.has(path)) return;
    visited.add(path);
    ordered.push(path);
    const ext = extensionOf(path);
    if (ext !== 'cue' && ext !== 'm3u') return;
    const text = await readText(files.get(path));
    const refs = ext === 'cue' ? parseCueReferences(text) : parseM3uReferences(text);
    for (const ref of refs) {
      let resolved;
      try { resolved = resolveRelative(path, ref); }
      catch (error) {
        if (error instanceof ContentBundleError) throw error;
        throw new ContentBundleError(`Unsafe reference in ${path}: ${ref}`, 'UNSAFE_REFERENCE', { entry: path, reference: ref });
      }
      const actual = findPath(files, resolved);
      if (!actual) missing.push({ from: path, reference: ref, expectedPath: resolved });
      else await visit(actual);
    }
  }

  await visit(entryPath);
  if (missing.length) {
    const summary = missing.map((item) => `${item.reference} (from ${item.from})`).join(', ');
    throw new ContentBundleError(`Missing companion file${missing.length === 1 ? '' : 's'}: ${summary}`, 'MISSING_COMPANIONS', { missing });
  }
  return ordered;
}

function resolveRelative(parentPath, reference) {
  const clean = String(reference).trim().replace(/\\/g, '/');
  const base = parentPath.includes('/') ? parentPath.slice(0, parentPath.lastIndexOf('/') + 1) : '';
  return normalizeContentPath(base + clean);
}

function findPath(files, requested) {
  if (files.has(requested)) return requested;
  const lower = requested.toLocaleLowerCase('en-US');
  const matches = [...files.keys()].filter((path) => path.toLocaleLowerCase('en-US') === lower);
  return matches.length === 1 ? matches[0] : null;
}

async function readText(source) {
  if (typeof source === 'string') return source;
  if (source?.text) return source.text();
  return new TextDecoder().decode(await readBytes(source));
}

export async function readBytes(source) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  if (source?.arrayBuffer) return new Uint8Array(await source.arrayBuffer());
  throw new ContentBundleError('Unsupported content source', 'UNSUPPORTED_SOURCE');
}

// Real CD/DVD tracks (a PSX .bin can be 600MB+) are too large to read in
// full just to mint an identity string — above this size, computeContentId
// hashes size+sampled prefix/suffix instead of the whole file (C1,
// 2026-07-27 review followup). Every ROM/cue/m3u file that actually exists
// below this line still gets the old exact full-byte hash, unchanged.
const STREAM_HASH_THRESHOLD = 8 * 1024 * 1024;
const STREAM_HASH_SAMPLE = 65536;

function sourceByteLength(source) {
  if (source instanceof Blob) return source.size;
  if (source instanceof ArrayBuffer) return source.byteLength;
  if (ArrayBuffer.isView(source)) return source.byteLength;
  return null;
}

async function readSourceSlice(source, start, end) {
  if (source instanceof Blob) return new Uint8Array(await source.slice(start, end).arrayBuffer());
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(start, end));
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset + start, end - start);
  throw new ContentBundleError('Unsupported content source', 'UNSUPPORTED_SOURCE');
}

// Below STREAM_HASH_THRESHOLD: exact full-byte hash (identical to the old
// unconditional behavior — every existing small ROM/cue/m3u contentId is
// unaffected). Above it: size + a 64KB prefix + 64KB suffix sample, so a
// 600MB disc track never gets fully read just to be identified. This is a
// deliberate, narrow collision-resistance tradeoff (two same-size files
// with identical prefix/suffix but differing interior bytes would collide)
// scoped only to large tracks, where full-byte hashing was the actual cost
// problem; it does NOT apply to the vast majority of already-persisted
// content (anything under 8MB keeps its old, byte-exact contentId).
async function hashFileForIdentity(path, source) {
  const knownSize = sourceByteLength(source);
  if (knownSize === null || knownSize <= STREAM_HASH_THRESHOLD) {
    const bytes = await readBytes(source);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return `${path}\0${bytes.byteLength}\0full:${toHex(digest)}`;
  }
  const sample = Math.min(STREAM_HASH_SAMPLE, Math.floor(knownSize / 2));
  const prefix = await readSourceSlice(source, 0, sample);
  const suffix = await readSourceSlice(source, knownSize - sample, knownSize);
  const combined = new Uint8Array(prefix.byteLength + suffix.byteLength);
  combined.set(prefix, 0);
  combined.set(suffix, prefix.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', combined));
  return `${path}\0${knownSize}\0sampled:${toHex(digest)}`;
}

async function computeContentId(entryPath, files) {
  if (!globalThis.crypto?.subtle) throw new ContentBundleError('Web Crypto is required to identify content', 'CRYPTO_UNAVAILABLE');
  const records = [];
  for (const path of [...files.keys()].sort((a, b) => a.localeCompare(b))) {
    records.push(await hashFileForIdentity(path, files.get(path)));
  }
  const manifest = new TextEncoder().encode(`entry\0${entryPath}\0${records.join('\n')}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', manifest));
  return `sha256:${toHex(digest)}`;
}

function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
