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

export async function validatePsxFirmware(source, suppliedName = source?.name || '') {
  const data = await readBytes(source);
  const md5 = md5Hex(data);
  const match = PSX_FIRMWARE.find((firmware) => firmware.md5 === md5) || null;
  const expectedByName = PSX_FIRMWARE.find((firmware) => firmware.name === suppliedName.toLowerCase()) || null;
  return {
    profile: 'psx',
    valid: !!match,
    recognized: !!match,
    suppliedName,
    canonicalName: match?.name || null,
    region: match?.region || null,
    size: data.byteLength,
    md5,
    filenameMatches: !!match && suppliedName.toLowerCase() === match.name,
    sizeMatches: match ? data.byteLength === match.size : expectedByName ? data.byteLength === expectedByName.size : data.byteLength === 524288,
    message: match
      ? (suppliedName.toLowerCase() === match.name ? `Recognized ${match.region} PlayStation BIOS` : `Recognized ${match.region} BIOS; it will be mounted as ${match.name}`)
      : `Unrecognized PlayStation BIOS (${data.byteLength} bytes, MD5 ${md5})`,
  };
}

export class FirmwareStore {
  async import(source, { profile = 'psx' } = {}) {
    if (profile !== 'psx') throw new FirmwareValidationError(`Unsupported firmware profile: ${profile}`, { profile, valid: false });
    const validation = await validatePsxFirmware(source);
    if (!validation.valid) throw new FirmwareValidationError(validation.message, validation);
    const data = await readBytes(source);
    const record = {
      key: `${profile}:${validation.canonicalName}`,
      profile,
      name: validation.canonicalName,
      suppliedName: validation.suppliedName,
      region: validation.region,
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
    return records.filter((record) => record.profile === profile).sort((a, b) => b.importedAt - a.importedAt);
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

  async remove(profile, name) {
    const conn = await openDb();
    return transactionPromise(conn, 'readwrite', (store) => store.delete(`${profile}:${name.toLowerCase()}`));
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
