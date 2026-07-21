// PS1-vs-PS2 optical disc classifier.
//
// Both consoles use the same container formats (.iso, .cue+.bin, .chd) and
// the same ISO9660 filesystem, so a file's extension or size alone can't
// tell a PS1 CD image from a PS2 DVD image once the disc is under the
// ~703 MiB CD-ROM ceiling. The one reliable, software-visible difference is
// Sony's own boot convention: every disc carries a SYSTEM.CNF file in its
// ISO9660 root directory, and the key line in it differs by console:
//   PS1:  BOOT  = cdrom:\SLUS_00XXX.XX;1
//   PS2:  BOOT2 = cdrom0:\SLUS_2XXXX.XX;1
// This module reads just enough of the image (a handful of 2 KB sectors,
// not the whole disc) to find and read that line. Layout offsets below are
// ECMA-119 (ISO9660) and Yellow Book/CD-ROM XA (Mode 1 / Mode 2 Form 1)
// standard structure, not project-specific.

const CD_SYNC = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];
const CD_RAW_SECTOR = 2352;
const ISO_SECTOR = 2048;
// Red Book 80-minute CD ceiling, measured in RAW 2352-byte sectors (not the
// ~703 MiB "700 MB" figure people usually quote, which is the smaller
// logical/2048-byte-sector capacity of the same disc). A raw .bin dump's file
// size reflects full 2352-byte sectors, so it's the larger number here
// (~807 MiB) that's the true ceiling for "no real CD image, raw or plain,
// exceeds this" — using the smaller figure would misclassify a legitimate
// raw CD dump in the 703-807 MiB range as a DVD.
export const CD_MAX_BYTES = 80 * 60 * 75 * CD_RAW_SECTOR; // 846,720,000

function bytesEqual(view, offset, pattern) {
  for (let i = 0; i < pattern.length; i++) {
    if (view[offset + i] !== pattern[i]) return false;
  }
  return true;
}

function readUInt32LE(view, offset) {
  return (view[offset] | (view[offset + 1] << 8) | (view[offset + 2] << 16) | (view[offset + 3] << 24)) >>> 0;
}

/** Read one 2048-byte logical (ISO9660) sector out of a raw or plain image. */
async function readLogicalSector(lba, layout, ctx) {
  if (layout.raw) {
    const physOffset = lba * CD_RAW_SECTOR;
    const sector = await ctx.readBytes(physOffset, CD_RAW_SECTOR);
    if (!sector || sector.length < CD_RAW_SECTOR) throw new Error(`short read at raw sector ${lba}`);
    if (!bytesEqual(sector, 0, CD_SYNC)) throw new Error(`missing CD sync pattern at raw sector ${lba}`);
    const mode = sector[15];
    // Mode 1: 12-byte sync + 4-byte header, then 2048 user bytes (offset 16).
    // Mode 2 Form 1 (CD-ROM XA, common for PS1 data tracks): + 8-byte subheader (offset 24).
    const dataOffset = mode === 2 ? 24 : 16;
    return sector.subarray(dataOffset, dataOffset + ISO_SECTOR);
  }
  const sector = await ctx.readBytes(lba * ISO_SECTOR, ISO_SECTOR);
  if (!sector || sector.length < ISO_SECTOR) throw new Error(`short read at logical sector ${lba}`);
  return sector;
}

/** Try raw-2352 and plain-2048 sector layouts; keep whichever has a valid ISO9660 PVD. */
async function detectSectorLayout(ctx) {
  const candidates = [];
  if (ctx.size >= 17 * CD_RAW_SECTOR) candidates.push({ raw: true });
  if (ctx.size >= 17 * ISO_SECTOR) candidates.push({ raw: false });
  for (const layout of candidates) {
    try {
      const pvd = await readLogicalSector(16, layout, ctx);
      // Volume Descriptor Type 1 (Primary) + Standard Identifier "CD001".
      if (pvd[0] === 0x01 && String.fromCharCode(...pvd.subarray(1, 6)) === 'CD001') return layout;
    } catch (_) {
      // Wrong layout guess (bad sync / short read) — try the next candidate.
    }
  }
  return null;
}

/** Read a directory extent and return { name, lba, length } for every entry. */
async function readDirectoryEntries(lba, length, layout, ctx) {
  const sectorCount = Math.ceil(length / ISO_SECTOR);
  const entries = [];
  for (let i = 0; i < sectorCount; i++) {
    const sector = await readLogicalSector(lba + i, layout, ctx);
    let pos = 0;
    while (pos < ISO_SECTOR) {
      const recLen = sector[pos];
      if (recLen === 0) break; // rest of this sector is padding; next entry (if any) starts fresh in the next sector
      const idLen = sector[pos + 32];
      const flags = sector[pos + 25];
      let name = '';
      if (idLen === 1 && (sector[pos + 33] === 0 || sector[pos + 33] === 1)) {
        name = sector[pos + 33] === 0 ? '.' : '..';
      } else {
        name = String.fromCharCode(...sector.subarray(pos + 33, pos + 33 + idLen)).replace(/;\d+$/, '');
      }
      entries.push({
        name,
        isDirectory: (flags & 0x02) !== 0,
        lba: readUInt32LE(sector, pos + 2),
        length: readUInt32LE(sector, pos + 10),
      });
      pos += recLen;
    }
  }
  return entries;
}

/** Locate and read SYSTEM.CNF's contents as text, or throw if it isn't present. */
async function readSystemCnf(layout, ctx) {
  const pvd = await readLogicalSector(16, layout, ctx);
  const rootLba = readUInt32LE(pvd, 156 + 2);
  const rootLength = readUInt32LE(pvd, 156 + 10);
  const rootEntries = await readDirectoryEntries(rootLba, rootLength, layout, ctx);
  const entry = rootEntries.find((e) => !e.isDirectory && e.name.toUpperCase() === 'SYSTEM.CNF');
  if (!entry) throw new Error('SYSTEM.CNF not found in ISO9660 root directory');

  const sectorCount = Math.ceil(entry.length / ISO_SECTOR);
  const chunks = [];
  for (let i = 0; i < sectorCount; i++) chunks.push(await readLogicalSector(entry.lba + i, layout, ctx));
  const bytes = new Uint8Array(sectorCount * ISO_SECTOR);
  chunks.forEach((chunk, i) => bytes.set(chunk, i * ISO_SECTOR));
  return new TextDecoder('latin1').decode(bytes.subarray(0, entry.length));
}

function extractLine(text, key) {
  const match = new RegExp(`^\\s*${key}\\s*=.*$`, 'im').exec(text);
  return match ? match[0].trim() : null;
}

/**
 * Classify an optical disc image as a PS1 or PS2 title.
 * ctx: { size: number, readBytes(offset, length): Promise<Uint8Array> }
 * Returns { console: 'ps1'|'ps2'|null, confidence: 'certain'|'none', reason, bootLine? }
 */
export async function identifyPlayStationDisc(ctx) {
  if (ctx.size > CD_MAX_BYTES) {
    return {
      console: 'ps2',
      confidence: 'certain',
      reason: `${ctx.size} bytes exceeds the ${CD_MAX_BYTES}-byte Red Book CD-ROM ceiling — must be a DVD image`,
    };
  }

  const layout = await detectSectorLayout(ctx);
  if (!layout) {
    return { console: null, confidence: 'none', reason: 'no valid ISO9660 volume descriptor found (not a disc image, or an unsupported sector layout)' };
  }

  let bootText;
  try {
    bootText = await readSystemCnf(layout, ctx);
  } catch (error) {
    return { console: null, confidence: 'none', reason: `SYSTEM.CNF unreadable: ${error.message}` };
  }

  const boot2Line = extractLine(bootText, 'BOOT2');
  if (boot2Line) return { console: 'ps2', confidence: 'certain', reason: 'SYSTEM.CNF declares BOOT2 (Sony’s PS2 boot key)', bootLine: boot2Line };
  const boot1Line = extractLine(bootText, 'BOOT');
  if (boot1Line) return { console: 'ps1', confidence: 'certain', reason: 'SYSTEM.CNF declares BOOT (Sony’s PS1 boot key)', bootLine: boot1Line };
  return { console: null, confidence: 'none', reason: 'SYSTEM.CNF found but has neither a BOOT nor a BOOT2 line', bootLine: bootText.trim().slice(0, 200) };
}

/** Adapter for an in-browser File/Blob — reads only the byte ranges actually needed. */
export function readerForBlob(blob) {
  return {
    size: blob.size,
    async readBytes(offset, length) {
      const buf = await blob.slice(offset, offset + length).arrayBuffer();
      return new Uint8Array(buf);
    },
  };
}

/** Adapter for content already fully in memory (a fetched/decoded Uint8Array or ArrayBuffer). */
export function readerForBytes(source) {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  return {
    size: bytes.length,
    async readBytes(offset, length) {
      return bytes.subarray(offset, Math.min(offset + length, bytes.length));
    },
  };
}
