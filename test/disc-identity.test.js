import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyPlayStationDisc, pickPlayStationCore, readerForBytes, CD_MAX_BYTES } from '../src/DiscIdentity.js';

// Synthetic ISO9660 image builder — mirrors real PS1/PS2 disc layout just
// enough to exercise identifyPlayStationDisc's sector-layout detection and
// SYSTEM.CNF read, with no real disc content needed. Was previously only a
// gitignored tmp/ scratch script (tmp/verify-disc-identity.mjs); promoted
// here since DiscIdentity.js was otherwise completely uncovered by the real
// suite (C2, 2026-07-27 review followup — this module was dead code with no
// wired-in caller AND no committed tests until this pass).
const ISO_SECTOR = 2048;
const CD_RAW_SECTOR = 2352;
const CD_SYNC = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];

function writeUInt32BothEndian(view, offset, value) {
  view[offset] = value & 0xff;
  view[offset + 1] = (value >>> 8) & 0xff;
  view[offset + 2] = (value >>> 16) & 0xff;
  view[offset + 3] = (value >>> 24) & 0xff;
  view[offset + 4] = (value >>> 24) & 0xff;
  view[offset + 5] = (value >>> 16) & 0xff;
  view[offset + 6] = (value >>> 8) & 0xff;
  view[offset + 7] = value & 0xff;
}

function buildDirRecord({ id, lba, length, isDirectory, special }) {
  const idBytes = special !== undefined ? [special] : Array.from(id, (c) => c.charCodeAt(0));
  const idLen = idBytes.length;
  let recLen = 33 + idLen;
  if (recLen % 2 !== 0) recLen += 1;
  const rec = new Uint8Array(recLen);
  rec[0] = recLen;
  writeUInt32BothEndian(rec, 2, lba);
  writeUInt32BothEndian(rec, 10, length);
  rec[25] = isDirectory ? 0x02 : 0x00;
  rec[28] = 1; rec[29] = 0; rec[30] = 0; rec[31] = 1;
  rec[32] = idLen;
  rec.set(idBytes, 33);
  return rec;
}

/** Minimal spec-valid ISO9660 image: sector 16 = PVD, 17 = root dir, 18 = SYSTEM.CNF. */
function buildIso({ mode, systemCnfText }) {
  const raw = mode !== 'plain';
  const sectorSize = raw ? CD_RAW_SECTOR : ISO_SECTOR;
  const image = new Uint8Array(sectorSize * 20);

  function writeLogicalSector(lba, data2048) {
    const base = lba * sectorSize;
    if (!raw) { image.set(data2048, base); return; }
    image.set(CD_SYNC, base);
    image[base + 15] = mode === 'mode2form1' ? 2 : 1;
    image.set(data2048, base + (mode === 'mode2form1' ? 24 : 16));
  }

  const dot = buildDirRecord({ special: 0, lba: 17, length: ISO_SECTOR, isDirectory: true });
  const dotdot = buildDirRecord({ special: 1, lba: 17, length: ISO_SECTOR, isDirectory: true });
  const cnfEntry = buildDirRecord({ id: 'SYSTEM.CNF;1', lba: 18, length: systemCnfText.length, isDirectory: false });
  const rootDirSector = new Uint8Array(ISO_SECTOR);
  rootDirSector.set(dot, 0);
  rootDirSector.set(dotdot, dot.length);
  rootDirSector.set(cnfEntry, dot.length + dotdot.length);
  writeLogicalSector(17, rootDirSector);

  const cnfSector = new Uint8Array(ISO_SECTOR);
  cnfSector.set(Array.from(systemCnfText, (c) => c.charCodeAt(0)));
  writeLogicalSector(18, cnfSector);

  const pvd = new Uint8Array(ISO_SECTOR);
  pvd[0] = 0x01;
  pvd.set(Array.from('CD001', (c) => c.charCodeAt(0)), 1);
  pvd[6] = 0x01;
  pvd.set(buildDirRecord({ special: 0, lba: 17, length: ISO_SECTOR, isDirectory: true }), 156);
  writeLogicalSector(16, pvd);

  return image;
}

test('identifyPlayStationDisc: plain and raw sector layouts, BOOT vs BOOT2', async () => {
  const ps2 = buildIso({ mode: 'plain', systemCnfText: 'BOOT2 = cdrom0:\\SLUS_20000.02;1\r\nVER = 1.00\r\n' });
  assert.equal((await identifyPlayStationDisc(readerForBytes(ps2))).console, 'ps2');

  const ps1 = buildIso({ mode: 'plain', systemCnfText: 'BOOT = cdrom:\\SLUS_00100.01;1\r\nTCB = 4\r\n' });
  assert.equal((await identifyPlayStationDisc(readerForBytes(ps1))).console, 'ps1');

  const rawMode1 = buildIso({ mode: 'mode1', systemCnfText: 'BOOT = cdrom:\\SLES_00500.01;1\r\n' });
  assert.equal((await identifyPlayStationDisc(readerForBytes(rawMode1))).console, 'ps1');

  const rawMode2 = buildIso({ mode: 'mode2form1', systemCnfText: 'BOOT2 = cdrom0:\\SLES_50000.02;1\r\n' });
  assert.equal((await identifyPlayStationDisc(readerForBytes(rawMode2))).console, 'ps2');
});

test('identifyPlayStationDisc: size shortcut and graceful non-classification', async () => {
  let readCalled = false;
  const oversized = { size: CD_MAX_BYTES + 1, async readBytes() { readCalled = true; throw new Error('should not be called'); } };
  const oversizedResult = await identifyPlayStationDisc(oversized);
  assert.equal(oversizedResult.console, 'ps2');
  assert.equal(readCalled, false);

  const garbage = new Uint8Array(ISO_SECTOR * 20).fill(0xaa);
  assert.equal((await identifyPlayStationDisc(readerForBytes(garbage))).console, null);

  const neither = buildIso({ mode: 'plain', systemCnfText: 'HELLO = world\r\n' });
  assert.equal((await identifyPlayStationDisc(readerForBytes(neither))).console, null);
});

test('pickPlayStationCore: maps a certain verdict to the right core, falls back to play when unclassifiable', async () => {
  const ps1 = buildIso({ mode: 'plain', systemCnfText: 'BOOT = cdrom:\\SLUS_00100.01;1\r\n' });
  const ps1Pick = await pickPlayStationCore(readerForBytes(ps1));
  assert.equal(ps1Pick.core, 'mednafen_psx_hw');
  assert.equal(ps1Pick.certain, true);

  const ps2 = buildIso({ mode: 'plain', systemCnfText: 'BOOT2 = cdrom0:\\SLUS_20000.02;1\r\n' });
  const ps2Pick = await pickPlayStationCore(readerForBytes(ps2));
  assert.equal(ps2Pick.core, 'play');
  assert.equal(ps2Pick.certain, true);

  // A .chd's compressed container never parses as a raw ISO9660 image — this
  // is the same "can't classify" path a real .chd pick hits (C2's stated
  // scope: it must fall back gracefully, not throw or hang).
  const garbage = new Uint8Array(ISO_SECTOR * 20).fill(0xaa);
  const unclassifiable = await pickPlayStationCore(readerForBytes(garbage));
  assert.equal(unclassifiable.core, 'play');
  assert.equal(unclassifiable.certain, false);
});
