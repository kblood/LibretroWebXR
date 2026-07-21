import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { ContentBundle, ContentBundleError, normalizeContentPath, parseCueReferences } = await import('../src/ContentBundle.js');
const { CORES, coreForFile } = await import('../src/systems.js');
const { md5Hex } = await import('../src/FirmwareStore.js');
const { DiscControlBridge, discEntriesFromBundle } = await import('../src/DiscControl.js');
const { checkSaveStateCompatibility, prepareSaveStatePayload } = await import('../src/SaveState.js');

test('PSX registry is reachable by explicit override; bare .bin still defaults to Atari', () => {
  // .cue is ALSO a PS2 (`play`) extension — coreForFile can only go by filename,
  // so it defaults to `play` (see systems.js's AMBIGUOUS_EXT_DEFAULT comment).
  // Real disambiguation happens in main.js via src/DiscIdentity.js before an
  // override reaches here; an explicit override always wins regardless.
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
