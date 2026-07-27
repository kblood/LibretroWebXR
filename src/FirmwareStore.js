import { readBytes } from './ContentBundle.js';

const DB_NAME = 'libretrowebxr-firmware';
const STORE = 'firmware';

export const PSX_FIRMWARE = Object.freeze([
  { name: 'scph5500.bin', region: 'Japan', size: 524288, md5: '8dd7d5296a650fac7319bce665a6a53c' },
  { name: 'scph5501.bin', region: 'North America', size: 524288, md5: '490f666e1afb15b7362b406ed1cea246' },
  { name: 'scph5502.bin', region: 'Europe', size: 524288, md5: '32736f17079d0b2b7024407c39bd3050' },
]);

let dbPromise;

export class FirmwareValidationError extends Error {
  constructor(message, validation) {
    super(message);
    this.name = 'FirmwareValidationError';
    this.validation = validation;
  }
}

// A real retail PS1 BIOS is always exactly 512KB across every known
// SCPH/DTL revision and region — used below to distinguish "a plausible but
// unrecognized BIOS dump" (importable, with a warning) from "not a PS1 BIOS
// at all" (rejected outright; nothing meaningful could be mounted).
const PSX_FIRMWARE_SIZE = 524288;

export async function validatePsxFirmware(source, suppliedName = source?.name || '') {
  const data = await readBytes(source);
  const md5 = md5Hex(data);
  const match = PSX_FIRMWARE.find((firmware) => firmware.md5 === md5) || null;
  const expectedByName = PSX_FIRMWARE.find((firmware) => firmware.name === suppliedName.toLowerCase()) || null;
  const plausibleSize = data.byteLength === PSX_FIRMWARE_SIZE;
  return {
    profile: 'psx',
    valid: !!match || plausibleSize,
    recognized: !!match,
    suppliedName,
    canonicalName: match?.name || null,
    region: match?.region || null,
    size: data.byteLength,
    md5,
    filenameMatches: !!match && suppliedName.toLowerCase() === match.name,
    sizeMatches: match ? data.byteLength === match.size : expectedByName ? data.byteLength === expectedByName.size : plausibleSize,
    message: match
      ? (suppliedName.toLowerCase() === match.name ? `Recognized ${match.region} PlayStation BIOS` : `Recognized ${match.region} BIOS; it will be mounted as ${match.name}`)
      : plausibleSize
        ? `Unrecognized PlayStation BIOS (${data.byteLength} bytes, MD5 ${md5}) — importing anyway; region is unknown, so a region-specific game may not boot correctly`
        : `Not a PlayStation BIOS: expected ${PSX_FIRMWARE_SIZE} bytes, got ${data.byteLength}`,
  };
}

// Beetle PSX HW (Mednafen's PSX core) only PROBES a fixed set of filenames
// in the system directory when looking for a usable BIOS — it does not scan
// for "any 512KB file". A recognized dump's canonicalName (scph5500.bin
// etc., from PSX_FIRMWARE above) is already one of these, so it was always
// found. An unrecognized-but-plausible dump has no canonical name — mounting
// it under the user's own original filename (Codex review finding, P1 on
// commit f2f30c9) means the core never discovers it at all: import silently
// "succeeds" but the core still falls back to its bundled OpenBIOS, exactly
// the failure mode import-with-warning was meant to avoid. Mount every
// unrecognized-but-plausible dump under this fixed, known-probed alias
// instead — its actual identity/region is unknown anyway, so there's no
// better name to pick, and this matches the same North-America default
// getPreferred() already falls back to when no region hint matches.
const UNRECOGNIZED_MOUNT_NAME = 'scph5501.bin';

/** The filename a validated BIOS should be mounted under for the core to actually find it. */
export function mountNameFor(validation) {
  return validation.canonicalName || UNRECOGNIZED_MOUNT_NAME;
}

// Self-heals records written by the brief window (commit f2f30c9, same
// review cycle) where an unrecognized-but-plausible dump was stored under
// the user's own uploaded filename instead of UNRECOGNIZED_MOUNT_NAME —
// exactly the bug mountNameFor's comment above describes, just already
// persisted in IndexedDB (Codex review finding, P2 on commit 26d2ad4). Read
// time, not a DB version bump: cheaper, and every list()/getPreferred() call
// benefits immediately rather than only after a real migration step. A
// record predating even displayName (pre-f2f30c9) falls back to its own name
// for display, since that field didn't exist yet either.
export function healUnrecognizedMountName(record) {
  if (record.recognized || record.name === UNRECOGNIZED_MOUNT_NAME) return record;
  return { ...record, name: UNRECOGNIZED_MOUNT_NAME, displayName: record.displayName || record.suppliedName || record.name };
}

export class FirmwareStore {
  async import(source, { profile = 'psx' } = {}) {
    if (profile !== 'psx') throw new FirmwareValidationError(`Unsupported firmware profile: ${profile}`, { profile, valid: false });
    const validation = await validatePsxFirmware(source);
    if (!validation.valid) throw new FirmwareValidationError(validation.message, validation);
    const data = await readBytes(source);
    // A recognized BIOS is keyed by its canonical name (scph5500.bin etc.,
    // shared across re-imports of the same dump). An unrecognized-but-
    // plausible one has no canonical name to key by, so fall back to its
    // MD5 — still stable across re-imports of the same exact file, but
    // distinct from every other unrecognized dump instead of colliding.
    const key = validation.canonicalName || `unrecognized-${validation.md5}`;
    const record = {
      key: `${profile}:${key}`,
      profile,
      // The MOUNT filename (what the core actually looks for) — see
      // mountNameFor's comment. `displayName` below keeps the user's real
      // filename for UI purposes without conflating the two.
      name: mountNameFor(validation),
      displayName: validation.suppliedName || validation.canonicalName || UNRECOGNIZED_MOUNT_NAME,
      suppliedName: validation.suppliedName,
      region: validation.region,
      recognized: validation.recognized,
      size: validation.size,
      md5: validation.md5,
      importedAt: Date.now(),
      data,
    };
    await put(record);
    return record;
  }

  async list(profile = 'psx') {
    const records = await all();
    return records
      .filter((record) => record.profile === profile)
      .map(healUnrecognizedMountName)
      .sort((a, b) => b.importedAt - a.importedAt);
  }

  async getPreferred(profile = 'psx', region = null) {
    const records = await this.list(profile);
    if (region) {
      const normalized = region.toLowerCase();
      const preferred = records.find((record) => record.region?.toLowerCase().includes(normalized));
      if (preferred) return preferred;
    }
    return records[0] || null;
  }

  /** Remove a previously-imported record by its `key` (as returned by `import()`/`list()`). */
  async remove(key) {
    const conn = await openDb();
    return transactionPromise(conn, 'readwrite', (store) => store.delete(key));
  }
}

function openDb() {
  if (dbPromise) return dbPromise;
  if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable'));
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function put(record) {
  const conn = await openDb();
  return transactionPromise(conn, 'readwrite', (store) => store.put(record));
}

async function all() {
  const conn = await openDb();
  return requestPromise(conn.transaction(STORE, 'readonly').objectStore(STORE).getAll());
}

function transactionPromise(conn, mode, action) {
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(STORE, mode);
    action(tx.objectStore(STORE));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Compact RFC 1321 implementation. MD5 is used only to identify a known BIOS,
// not as a security primitive.
export function md5Hex(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = BigInt(bytes.length) * 8n;
  view.setUint32(paddedLength - 8, Number(bitLength & 0xffffffffn), true);
  view.setUint32(paddedLength - 4, Number(bitLength >> 32n), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const shifts = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const words = Array.from({ length: 16 }, (_, index) => view.getUint32(offset + index * 4, true));
    let a = a0, b = b0, c = c0, d = d0;
    for (let index = 0; index < 64; index++) {
      let f, word;
      if (index < 16) { f = (b & c) | (~b & d); word = index; }
      else if (index < 32) { f = (d & b) | (~d & c); word = (5 * index + 1) % 16; }
      else if (index < 48) { f = b ^ c ^ d; word = (3 * index + 5) % 16; }
      else { f = c ^ (b | ~d); word = (7 * index) % 16; }
      const sum = (a + f + constants[index] + words[word]) >>> 0;
      const rotated = ((sum << shifts[index]) | (sum >>> (32 - shifts[index]))) >>> 0;
      [a, b, c, d] = [d, (b + rotated) >>> 0, b, c];
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true); outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true); outView.setUint32(12, d0, true);
  return [...out].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
