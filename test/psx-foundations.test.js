import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { ContentBundle, ContentBundleError, normalizeContentPath, parseCueReferences } = await import('../src/ContentBundle.js');
const { CORES, coreForFile } = await import('../src/systems.js');
const { md5Hex, validatePsxFirmware, mountNameFor, healUnrecognizedMountName, PSX_FIRMWARE } = await import('../src/FirmwareStore.js');
const { DiscControlBridge, discEntriesFromBundle } = await import('../src/DiscControl.js');
const { checkSaveStateCompatibility, prepareSaveStatePayload } = await import('../src/SaveState.js');

test('PSX registry is reachable by explicit override; bare .bin still defaults to Atari', () => {
  // .cue is ALSO a PS2 (`play`) extension — coreForFile can only go by filename,
  // so it defaults to `play` (see systems.js's AMBIGUOUS_EXT_DEFAULT comment).
  // src/DiscIdentity.js could do real byte-level disambiguation but is dead
  // code today — nothing in main.js calls it (2026-07-24 review finding).
  // An explicit override always wins regardless of that gap.
  assert.equal(coreForFile('Game.cue').name, 'play');
  assert.equal(coreForFile('Game.cue', 'mednafen_psx_hw').name, 'mednafen_psx_hw');
  assert.equal(coreForFile('Game.bin').name, 'stella2014');
  assert.equal(CORES.mednafen_psx_hw.multiFile, true);
});

test('ContentBundle preserves cue names, validates companions, and hashes stably', async () => {
  const sources = [
    { path: 'Disc/Game.cue', source: new Blob(['FILE "Track 01.BIN" BINARY\n TRACK 01 MODE2/2352']) },
    { path: 'Disc/Track 01.BIN', source: new Blob([new Uint8Array([1, 2, 3])]) },
  ];
  const first = await ContentBundle.fromNamedSources(sources, { entryPath: 'Disc/Game.cue' });
  const second = await ContentBundle.fromNamedSources(sources, { entryPath: 'disc/game.CUE' });
  assert.equal(first.entryPath, 'Disc/Game.cue');
  assert.deepEqual(first.dependencies, ['Disc/Game.cue', 'Disc/Track 01.BIN']);
  assert.equal(first.contentId, second.contentId);
  assert.deepEqual(parseCueReferences('FILE "a b.bin" BINARY'), ['a b.bin']);
});

test('ContentBundle reports traversal and missing tracks before runtime', async () => {
  assert.throws(() => normalizeContentPath('../bad.bin'), ContentBundleError);
  await assert.rejects(
    ContentBundle.fromNamedSources([{ path: 'game.cue', source: new Blob(['FILE "missing.bin" BINARY']) }]),
    (error) => error.code === 'MISSING_COMPANIONS',
  );
});

test('MD5 implementation matches RFC vectors', () => {
  assert.equal(md5Hex(new TextEncoder().encode('')), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5Hex(new TextEncoder().encode('abc')), '900150983cd24fb0d6963f7d28e17f72');
});

test('BIOS import: unrecognized-but-plausible dump imports with a warning, wrong size is rejected', async () => {
  // Real BIOS bytes are copyrighted and can't be shipped in this repo's test
  // suite, so the "recognized" match path can't be exercised with a genuine
  // scph MD5 here — this covers the two paths that matter for the
  // import-with-warning fix: a right-size-but-unmatched dump (imports with a
  // warning, region unknown) and a wrong-size file (rejected outright, since
  // there's no basis for treating it as any kind of BIOS).
  assert.equal(PSX_FIRMWARE.length > 0, true);

  const plausible = await validatePsxFirmware(new Blob([new Uint8Array(524288).fill(0x42)]), 'my-dump.bin');
  assert.equal(plausible.valid, true);
  assert.equal(plausible.recognized, false);
  assert.equal(plausible.region, null);
  assert.match(plausible.message, /importing anyway/);

  const wrongSize = await validatePsxFirmware(new Blob([new Uint8Array(100)]), 'not-a-bios.bin');
  assert.equal(wrongSize.valid, false);
  assert.match(wrongSize.message, /Not a PlayStation BIOS/);

  // Codex review finding (P1 on commit f2f30c9): mounting an unrecognized
  // dump under the USER'S filename means the core (which only probes a
  // fixed alias set — scph5500.bin/scph5501.bin/etc.) never finds it, so
  // import silently succeeds but has zero effect. mountNameFor must always
  // return one of the core's known-probed aliases, never the raw supplied name.
  assert.equal(mountNameFor(plausible), 'scph5501.bin');
  assert.notEqual(mountNameFor(plausible), plausible.suppliedName);
});

test('BIOS import: legacy unrecognized records self-heal to the probed mount name on read', () => {
  // Codex review finding (P2 on commit 26d2ad4): a record written during the
  // brief f2f30c9-only window has `name` set to the user's raw uploaded
  // filename (the exact bug mountNameFor/UNRECOGNIZED_MOUNT_NAME fixed for
  // NEW imports) — list()/getPreferred() must self-heal it on read, not just
  // fix imports going forward.
  const legacy = { name: 'my-dump.bin', recognized: false, suppliedName: 'my-dump.bin' };
  const healed = healUnrecognizedMountName(legacy);
  assert.equal(healed.name, 'scph5501.bin');
  assert.equal(healed.displayName, 'my-dump.bin');

  // A record predating even `displayName` (before f2f30c9) has neither field
  // — falls back to its own (still-wrong) name for display, since that's the
  // only filename information such a record has.
  const preF2f30c9 = { name: 'old-dump.bin', recognized: false };
  const healedOld = healUnrecognizedMountName(preF2f30c9);
  assert.equal(healedOld.name, 'scph5501.bin');
  assert.equal(healedOld.displayName, 'old-dump.bin');

  // A recognized record, or one already mounted under the alias, is untouched.
  const recognized = { name: 'scph5500.bin', recognized: true, displayName: 'my dump.BIN' };
  assert.equal(healUnrecognizedMountName(recognized), recognized);
  const alreadyHealed = { name: 'scph5501.bin', recognized: false, displayName: 'x.bin' };
  assert.equal(healUnrecognizedMountName(alreadyHealed), alreadyHealed);
});

test('disc bridge ejects, selects, inserts, and rejects invalid indices', () => {
  const calls = [];
  const bridge = new DiscControlBridge({
    _cmd_disk_eject_toggle: () => calls.push('eject'),
    _cmd_disk_next: () => calls.push('next'),
  }, { discCount: 3 });
  bridge.setDisc(2);
  assert.deepEqual(calls, ['eject', 'next', 'next', 'eject']);
  assert.deepEqual(bridge.status().index, 2);
  assert.throws(() => bridge.setDisc(3), RangeError);
  assert.deepEqual(discEntriesFromBundle({ entryPath: 'set.m3u', dependencies: ['set.m3u', 'one.cue', 'one.bin', 'two.chd'] }), ['one.cue', 'two.chd']);
});

test('save-state metadata records compatibility boundaries', () => {
  const state = prepareSaveStatePayload({ data: new Uint8Array(7), core: 'mednafen_psx_hw', file: 'game.cue', contentId: 'sha256:x', coreBuildHash: 'build-a' });
  assert.equal(state.byteLength, 7);
  assert.equal(state.entryPath, 'game.cue');
  assert.equal(checkSaveStateCompatibility(state, { coreId: 'mednafen_psx_hw', contentId: 'sha256:x', coreBuildHash: 'build-a' }).compatible, true);
  assert.equal(checkSaveStateCompatibility(state, { coreId: 'mednafen_psx_hw', contentId: 'sha256:x', coreBuildHash: 'build-b' }).reason, 'core-build-mismatch');
});
