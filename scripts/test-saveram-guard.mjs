// COR-6 (CODEX_REVIEW): native SaveRAM must belong to the RUNTIME that made it.
//
// The shipped bug this pins: persistence was one global function reading the
// PRIMARY console's `currentMeta` + `client`. Consequences, all reproduced below
// as negative controls against a faithful copy of that code:
//   • a game on a rack console restored its card at boot and NEVER wrote one;
//   • replacing a runtime (core swap, gun-arm reboot) dropped the old core with
//     no write at all;
//   • the write was keyed on the CARTRIDGE's core while the restore is keyed on
//     the core that actually booted — different for a light-gun boot, so the
//     bytes were filed where nothing reads them.
//
// WHAT WOULD MAKE THIS TEST WORTHLESS, and what is done about it:
//   • Asserting "a write happened" and nothing about WHERE. A guard that writes
//     every card under one key passes that and still loses saves, so every write
//     assertion checks the key a restore would read (coreId|contentId|slot).
//   • Asserting skips without the paired write. A dedup that skips EVERYTHING
//     passes "unchanged bytes are not rewritten" — so every skip case is paired
//     with the change that MUST be written.
//   • Testing only the guard. The three defects were in the WIRING, so the
//     controls re-run each scenario with the fix removed and require the old,
//     lossy outcome.
//
// Pure logic: no DOM, no IndexedDB, no ports. Run:
//   node scripts/test-saveram-guard.mjs   (also in `npm test`, via run-tests.mjs)

import { createSaveRamGuard, fingerprint } from '../src/SaveRamGuard.js';
import { RackMgr } from '../src/RackMgr.js';

let passed = 0;
let failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const section = async (name, fn) => {
  console.log(`--- ${name} ---`);
  try { await fn(); } catch (e) { failed++; console.error(`  FAIL: section "${name}" threw — ${e.stack || e.message}`); }
};

// --- fakes ------------------------------------------------------------------

// A SaveRamStore stand-in that records what a RESTORE would find: the key the
// real store builds (see SaveRamStore.saveRamKey) mapped to the last bytes
// written under it, plus the full write log and a concurrency watermark.
function fakeStore({ latency = null } = {}) {
  const cards = new Map();
  const writes = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    writes,
    cards,
    maxInFlight: () => maxInFlight,
    key: (coreId, contentId, slot = 1) => `${coreId}|${contentId}|${slot}`,
    read(coreId, contentId, slot = 1) { return cards.get(`${coreId}|${contentId}|${slot}`) ?? null; },
    async save({ coreId, contentId, slot = 1, data, coreBuildHash = null, entryPath = null }) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (latency) await latency();
        const key = `${coreId}|${contentId}|${slot}`;
        const bytes = Array.from(data);
        cards.set(key, bytes);
        writes.push({ key, coreId, contentId, slot, bytes, coreBuildHash, entryPath });
      } finally { inFlight--; }
    },
  };
}

// A worker-mode client: flushSaveRam() hands back whatever the emulated cart
// currently holds. `card` is mutable so a test can "play the game".
function fakeClient(card, { buildHash = 'hash-1' } = {}) {
  return {
    buildHash,
    card,
    reads: 0,
    flushSaveRam() { this.reads++; return Promise.resolve(this.card ? Uint8Array.from(this.card) : null); },
  };
}

// The code as it shipped before COR-6, verbatim in behaviour: one global meta,
// one global client, key on the CARTRIDGE core. Used as the negative control.
async function legacyFlush({ currentMeta, client, store }) {
  if (!currentMeta?.contentId) return;
  try {
    const data = await client.flushSaveRam?.();
    if (!data) return;
    await store.save({
      coreId: currentMeta.core,
      contentId: currentMeta.contentId,
      data,
      coreBuildHash: client.buildHash,
      entryPath: currentMeta.file,
    });
  } catch (_) { /* the old code warned and moved on */ }
}

// === A. Identity =============================================================

await section('a console is tracked only when it has a save identity', async () => {
  const store = fakeStore();
  const guard = createSaveRamGuard({ store });
  const client = fakeClient([1, 2, 3]);

  ok(guard.track('console1', { client, coreId: 'play', contentId: 'sha-abc' }) === true,
    'a worker-core boot with a content hash is tracked');
  // A main-thread core has no ContentBundle and so no contentId — and no native
  // SaveRAM path either. Tracking it would mean flushing `undefined` for ever.
  ok(guard.track('console2', { client, coreId: 'fceumm', contentId: null }) === false,
    'a boot with no content hash is not tracked');
  eq(guard.ids(), ['console1'], 'only the identifiable console is tracked');

  eq((await guard.flush('console2')).reason, 'untracked', 'flushing an untracked console is a no-op…');
  eq(store.writes.length, 0, '…and writes nothing');
});

await section('re-tracking a console with a new game forgets the old dedup mark', async () => {
  const store = fakeStore();
  const guard = createSaveRamGuard({ store });
  const client = fakeClient([7, 7]);
  guard.track('console1', { client, coreId: 'play', contentId: 'game-A' });
  await guard.flush('console1');

  // Same BYTES, different game. A fingerprint kept across the swap would call
  // this "unchanged" and never write game B's card at all.
  guard.track('console1', { client, coreId: 'play', contentId: 'game-B' });
  const r = await guard.flush('console1');
  ok(r.written === true, 'the new game writes even though the bytes are identical');
  ok(store.read('play', 'game-A') !== null && store.read('play', 'game-B') !== null,
    'both cards exist, under their own keys');
});

// === B. Every console persists, not just the primary =========================

await section('a rack console saves its own card — the defect COR-6 names', async () => {
  const store = fakeStore();
  const guard = createSaveRamGuard({ store });
  const primary = fakeClient([1, 1, 1]);
  const rack = fakeClient([9, 9, 9]);
  guard.track('console0', { client: primary, coreId: 'play', contentId: 'primary-game' });
  guard.track('console1', { client: rack, coreId: 'psx', contentId: 'rack-game' });

  await guard.flushAll('periodic');
  eq(store.read('play', 'primary-game'), [1, 1, 1], "the primary console's card is written");
  eq(store.read('psx', 'rack-game'), [9, 9, 9], "and so is the rack console's");

  // NEGATIVE CONTROL: the shipped code, same scenario. It knows only the primary.
  const legacyStore = fakeStore();
  await legacyFlush({
    currentMeta: { core: 'play', contentId: 'primary-game', file: 'a.cue' },
    client: primary, store: legacyStore,
  });
  eq(legacyStore.writes.length, 1, 'the old global flusher writes exactly one card…');
  ok(legacyStore.read('psx', 'rack-game') === null,
    '…and the rack console\'s save is simply lost — no code path ever wrote it');
});

await section('the card is keyed on the core that BOOTED, not the cartridge core', async () => {
  // A light-gun SMS boot runs genesis_plus_gx; the restore (buildStartOptions)
  // looks the card up under the core it is booting, so a write keyed on the
  // cartridge's declared core is filed where nothing will ever read it.
  const store = fakeStore();
  const guard = createSaveRamGuard({ store });
  const client = fakeClient([4, 2]);
  guard.track('console0', { client, coreId: 'genesis_plus_gx', contentId: 'sms-gun-game' });
  await guard.flush('console0');
  eq(store.read('genesis_plus_gx', 'sms-gun-game'), [4, 2], 'written where the restore looks');

  // NEGATIVE CONTROL: the old bookkeeping stored meta.core for exactly this boot.
  const legacyStore = fakeStore();
  await legacyFlush({
    currentMeta: { core: 'smsplus', contentId: 'sms-gun-game', file: 'g.sms' },
    client, store: legacyStore,
  });
  ok(legacyStore.read('genesis_plus_gx', 'sms-gun-game') === null,
    'the old key is invisible to the restore — the save exists but is unreachable');
  ok(legacyStore.read('smsplus', 'sms-gun-game') !== null, '(it went under the cartridge core)');
});

// === C. Replacement and removal ==============================================

await section('replacing a runtime writes the outgoing card first', async () => {
  const store = fakeStore();
  const guard = createSaveRamGuard({ store });
  const oldClient = fakeClient([5, 5, 5]);

  guard.track('console1', { client: oldClient, coreId: 'psx', contentId: 'game-A' });
  oldClient.card = [5, 5, 6];                      // the player got further

  // What main.js's bootFreshRuntime now does, in order.
  await guard.flush('console1', 'runtime-replaced');
  const newClient = fakeClient([0]);
  guard.track('console1', { client: newClient, coreId: 'play', contentId: 'game-B' });

  eq(store.read('psx', 'game-A'), [5, 5, 6], "the retired core's progress survived the swap");
  eq(guard.identity('console1'), { coreId: 'play', contentId: 'game-B', entryPath: null, slot: 1 },
    'and the console now owns the new game');

  // NEGATIVE CONTROL: the same swap without the pre-boot flush — the shipped
  // behaviour for every secondary console and every core-changing swap.
  const lossy = fakeStore();
  const lossyGuard = createSaveRamGuard({ store: lossy });
  const c = fakeClient([5, 5, 6]);
  lossyGuard.track('console1', { client: c, coreId: 'psx', contentId: 'game-A' });
  lossyGuard.track('console1', { client: fakeClient([0]), coreId: 'play', contentId: 'game-B' });
  ok(lossy.read('psx', 'game-A') === null, 'without the flush the retired card is gone for good');
});

await section('retire() writes and then stops tracking', async () => {
  const store = fakeStore();
  const guard = createSaveRamGuard({ store });
  const client = fakeClient([3]);
  guard.track('console1', { client, coreId: 'psx', contentId: 'game-A' });

  const r = await guard.retire('console1', 'runtime-removed');
  ok(r.written === true, 'the removal wrote the card');
  eq(store.read('psx', 'game-A'), [3], 'with the bytes the core held');
  eq(guard.size(), 0, 'and the console is no longer tracked');
  eq((await guard.flush('console1')).reason, 'untracked', 'a later flush finds nothing to do');
});

await section('retire() cannot unhook the runtime that replaced it', async () => {
  // The real ordering hazard: bootFreshRuntime boots the NEW core, then removes
  // the old runtime (whose beforeRemove hook retires this console id). If retire
  // forgot the id unconditionally when its write finished, the console that is
  // now running would silently stop saving — the original bug, re-entered.
  let release;
  const gate = new Promise((r) => { release = r; });
  const store = fakeStore({ latency: () => gate });
  const guard = createSaveRamGuard({ store });
  guard.track('console1', { client: fakeClient([1]), coreId: 'psx', contentId: 'game-A' });

  const retiring = guard.retire('console1', 'runtime-removed');
  guard.track('console1', { client: fakeClient([2]), coreId: 'play', contentId: 'game-B' });
  release();
  await retiring;

  eq(guard.identity('console1'), { coreId: 'play', contentId: 'game-B', entryPath: null, slot: 1 },
    'the replacement is still tracked after the old write lands');
  const after = await guard.flush('console1');
  ok(after.written === true, 'and it still persists');
  eq(store.read('play', 'game-B'), [2], 'under its own key');
});

// === D. Doing no harm ========================================================

await section('unchanged bytes are not rewritten — and changed bytes always are', async () => {
  const store = fakeStore();
  const guard = createSaveRamGuard({ store });
  const client = fakeClient([1, 2, 3]);
  guard.track('console0', { client, coreId: 'play', contentId: 'g' });

  ok((await guard.flush('console0')).written === true, 'the first flush writes');
  eq((await guard.flush('console0')).reason, 'unchanged', 'an identical card is not written again');
  eq((await guard.flush('console0')).reason, 'unchanged', 'still not, on the next tick');
  eq(store.writes.length, 1, 'one write, not three (the store rotates a backup on every write)');

  client.card = [1, 2, 4];                          // the player saved in-game
  ok((await guard.flush('console0')).written === true, 'a changed card IS written');
  eq(store.read('play', 'g'), [1, 2, 4], 'with the new bytes');

  client.card = [1, 2, 4, 0];                       // same prefix, longer card
  ok((await guard.flush('console0')).written === true, 'a card that only grew is written too');
});

await section('a core with nothing to save is quiet, not broken', async () => {
  const store = fakeStore();
  const guard = createSaveRamGuard({ store });

  guard.track('a', { client: fakeClient(null), coreId: 'fceumm', contentId: 'no-battery' });
  eq((await guard.flush('a')).reason, 'empty', 'a game with no battery RAM resolves null → no write');

  guard.track('b', { client: { buildHash: 'x' }, coreId: 'stella', contentId: 'main-thread' });
  eq((await guard.flush('b')).reason, 'unsupported', 'a client with no flushSaveRam is skipped');

  eq(store.writes.length, 0, 'neither wrote anything');
});

await section('one failing console does not stop the others', async () => {
  const store = fakeStore();
  const seen = [];
  const guard = createSaveRamGuard({ store, onError: (e, id) => seen.push(`${id}:${e.message}`) });
  guard.track('bad', { client: { flushSaveRam: () => Promise.reject(new Error('worker gone')) }, coreId: 'psx', contentId: 'x' });
  guard.track('good', { client: fakeClient([8]), coreId: 'play', contentId: 'y' });

  const results = await guard.flushAll('pagehide');
  eq(results.length, 2, 'both consoles were attempted');
  eq(store.read('play', 'y'), [8], 'the healthy console still saved');
  eq(seen, ['bad:worker gone'], 'and the failure was REPORTED, not swallowed');
  eq(guard.stats().failures, 1, 'the failure is counted');
});

await section('overlapping flushes for one console never interleave', async () => {
  // The 30s timer, a pagehide and a replacement can all fire within a frame. The
  // real store does read-modify-write (it rotates backups), so two concurrent
  // writes would rotate a good backup out for nothing.
  let release;
  const gate = new Promise((r) => { release = r; });
  const client = fakeClient([1]);
  let first = true;
  // The player saves in-game WHILE the first write is still in flight — the only
  // way to make the two flushes genuinely see different cards, and the case a
  // read-modify-write store must not race on.
  const store = fakeStore({ latency: () => (first ? (first = false, client.card = [2], gate) : Promise.resolve()) });
  const guard = createSaveRamGuard({ store });
  guard.track('console0', { client, coreId: 'play', contentId: 'g' });

  const a = guard.flush('console0', 'periodic');
  const b = guard.flush('console0', 'pagehide');
  release();
  await Promise.all([a, b]);

  eq(store.maxInFlight(), 1, 'the store never saw two writes at once');
  eq(store.writes.map((w) => w.bytes), [[1], [2]], 'both landed, in order');
  eq(client.reads, 2, 'the second flush re-read the card rather than reusing the first read');
});

await section('the client is resolved late, so a live reboot keeps saving', async () => {
  // main.js passes a thunk that reads rackMgr.get(id).client, because the primary
  // console's client OBJECT is replaced by a live reboot. A captured reference
  // would flush the retired core for ever after (the COR-2 lesson, applied here).
  const store = fakeStore();
  const guard = createSaveRamGuard({ store });
  let live = fakeClient([1]);
  guard.track('console0', { client: () => live, coreId: 'play', contentId: 'g' });
  await guard.flush('console0');

  live = fakeClient([2]);                            // rebindPrimaryClient
  await guard.flush('console0');
  eq(store.read('play', 'g'), [2], 'the NEW client\'s card is what gets written');
  eq(store.writes.length, 2, 'and the write actually happened (not "unchanged")');
});

// === E. The rack wiring ======================================================

await section('RackMgr gives SaveRAM its last chance before dispose', async () => {
  const order = [];
  const runtime = (id) => ({ id, dispose() { order.push(`dispose:${id}`); }, isLoaded: () => true });
  const rack = new RackMgr({ beforeRemove: (r) => order.push(`before:${r.id}`) });
  rack.add(runtime('console1'));
  rack.remove('console1');
  eq(order, ['before:console1', 'dispose:console1'],
    'the hook runs BEFORE dispose — after it, the core is paused and detached');

  order.length = 0;
  rack.add(runtime('a'));
  rack.add(runtime('b'));
  rack.dispose();
  eq(order, ['before:a', 'dispose:a', 'before:b', 'dispose:b'],
    'and for every runtime in a whole-rack teardown');

  // A save write must never be able to strand a console undisposed.
  const disposed = [];
  const angry = new RackMgr({ beforeRemove: () => { throw new Error('store closed'); } });
  angry.add({ id: 'c', dispose: () => disposed.push('c') });
  angry.remove('c');
  eq(disposed, ['c'], 'a throwing hook still leaves the runtime disposed');
  eq(angry.count(), 0, 'and removed');

  // NEGATIVE CONTROL: no hook configured — the pre-COR-6 RackMgr — silently
  // drops the runtime with nothing given a chance to persist it.
  const silent = [];
  const plain = new RackMgr();
  plain.add({ id: 'd', dispose: () => silent.push('dispose:d') });
  plain.remove('d');
  eq(silent, ['dispose:d'], 'without the hook, teardown is all that happens');
});

// === F. The dedup mark itself ================================================

await section('fingerprint distinguishes the cards it must', () => {
  const a = Uint8Array.from([1, 2, 3]);
  eq(fingerprint(a), fingerprint(Uint8Array.from([1, 2, 3])), 'identical bytes → identical mark');
  ok(fingerprint(a) !== fingerprint(Uint8Array.from([1, 2, 4])), 'one changed byte → different mark');
  ok(fingerprint(a) !== fingerprint(Uint8Array.from([1, 2, 3, 0])), 'a longer card → different mark');
  ok(fingerprint(a) !== fingerprint(Uint8Array.from([3, 2, 1])), 'reordered bytes → different mark');
  eq(fingerprint(a), fingerprint(new Uint8Array([1, 2, 3]).buffer), 'an ArrayBuffer marks like its view');
  // Unknown shape ⇒ null ⇒ the caller writes unconditionally. Skipping a write
  // we are not SURE is redundant is how a save gets lost.
  eq(fingerprint({ size: 3 }), null, 'anything not readable as bytes has no mark');
  eq(fingerprint(null), null, 'and neither has nothing');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
