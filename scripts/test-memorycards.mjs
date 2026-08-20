// Unit tests for the memory-card save/load transaction ([[src/MemoryCardUI.js]]).
//
// WHY THIS SUITE EXISTS AT ALL. src/main.js has no test coverage — nothing in
// scripts/ imports it, so the "tests stayed green" that usually backs a refactor
// proves nothing about it. MemoryCardUI is the first region carved out of that
// file (P2 #12 step 1), and this is the safety net that makes the carve worth
// doing: it drives the REAL module, not a copy of its logic. Copied-logic tests
// are worse than none during a refactor — they keep passing while the copy and
// the original drift apart, which is exactly how three existing suites in this
// directory ended up describing code that has since moved.
//
// Pure logic: no DOM, no WebGL, no ports. build() is deliberately NOT exercised
// (it builds THREE meshes and a CanvasTexture, which needs a document); every
// assertion here is about handleInsert, which is where the correctness lives.

import { createMemoryCardUI } from '../src/MemoryCardUI.js';

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
};

// --- A minimal in-memory IndexedDB ------------------------------------------
//
// MemoryCardUI imports saveState/loadState from [[src/SaveState.js]] directly
// (they are real module imports, not injected), so the only honest way to assert
// what got PERSISTED is to give SaveState a database. This stub implements the
// exact three shapes SaveState uses — open + onupgradeneeded/onsuccess,
// transaction().objectStore().put() + tx.oncomplete, and .get() + req.onsuccess
// — and nothing else. Everything resolves on a later microtask, like the real
// thing, so the awaits under test are real awaits.
//
// The bonus of stubbing at this level rather than mocking saveState: the records
// asserted below have been through the real prepareSaveStatePayload, so the
// coreId/entryPath/byteLength stamping is under test too.
const stores = new Map();
const storeFor = (name) => {
  if (!stores.has(name)) stores.set(name, new Map());
  return stores.get(name);
};
globalThis.indexedDB = {
  open() {
    const req = {};
    queueMicrotask(() => {
      req.result = {
        createObjectStore: (name) => { storeFor(name); return {}; },
        transaction(name) {
          const map = storeFor(name);
          const tx = {};
          tx.objectStore = () => ({
            put(value, key) { map.set(key, value); queueMicrotask(() => tx.oncomplete?.()); },
            get(key) {
              const r = {};
              queueMicrotask(() => { r.result = map.get(key); r.onsuccess?.({ target: r }); });
              return r;
            },
          });
          return tx;
        },
      };
      req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  },
};

// --- Stubs -------------------------------------------------------------------
// A card is only ever touched through userData by the module under test.
const makeCard = (slot, savedMeta = null) => {
  const card = { userData: { slot, savedMeta, pulses: [], saved: null } };
  card.userData.pulse = (c) => card.userData.pulses.push(c);
  card.userData.setSaved = (meta) => { card.userData.saved = meta; };
  return card;
};
const RED = 0xcc2222, WHITE = 0xffffff;

// scene/grabMgr are only used by build(), which these tests do not call — but
// the module destructures them, so they must exist.
const stubScene = { addObject() {}, scene: { attach() {} } };
const stubGrab = { addGrabbable() {} };

// Never-superseded boot epoch unless a test says otherwise.
const neverSuperseded = () => () => false;

const setup = (opts = {}) => {
  const status = [];
  const ui = createMemoryCardUI({
    scene: stubScene,
    grabMgr: stubGrab,
    setStatus: (s) => status.push(s),
    getClient: opts.getClient || (() => opts.client),
    getMeta: opts.getMeta || (() => opts.meta ?? null),
    captureBootEpoch: opts.captureBootEpoch || neverSuperseded,
    CONSOLE_ID: 'console0',
  });
  return { ui, status };
};

const settle = async (ticks = 12) => { for (let i = 0; i < ticks; i++) await Promise.resolve(); };

const METAS = {
  A: { core: 'snes9x', file: 'gameA.sfc', title: 'Game A', system: 'snes' },
  B: { core: 'mesen', file: 'gameB.nes', title: 'Game B', system: 'nes' },
};
const clientWith = (over = {}) => ({
  canSerialize: () => true,
  buildHash: 'build-1',
  serializeState: async () => new Uint8Array([1, 2, 3]),
  unserializeState: async () => {},
  ...over,
});

// --- 1. Empty card, nothing running → refuse ---------------------------------
{
  const { ui, status } = setup({ client: clientWith(), meta: null });
  const card = makeCard(1);
  const r = ui.handleInsert(card);
  ok(r === false, 'empty card with no current game returns false');
  ok(status.at(-1) === 'insert a cartridge first', `refusal says why (got ${status.at(-1)})`);
  ok(card.userData.pulses.at(-1) === RED, 'refusal pulses red');
}

// --- 2. Filled card whose identity differs from the live game → refuse --------
{
  const { ui, status } = setup({ client: clientWith(), meta: METAS.A });
  // Same core, different file.
  const wrongFile = makeCard(2, { ...METAS.A, file: 'other.sfc', title: 'Other' });
  ok(ui.handleInsert(wrongFile) === false, 'a card saved from a different FILE is refused');
  ok(/load that cart first/.test(status.at(-1)), `refusal names the card's game (got ${status.at(-1)})`);
  // Same file, different core (a cross-core swap of the same dump).
  const wrongCore = makeCard(3, { ...METAS.A, core: 'bsnes' });
  ok(ui.handleInsert(wrongCore) === false, 'a card saved from a different CORE is refused');
  ok(wrongCore.userData.pulses.at(-1) === RED, 'wrong-core refusal pulses red');
  // Nothing running at all is a refusal too, not a crash.
  const { ui: ui2 } = setup({ client: clientWith(), meta: null });
  ok(ui2.handleInsert(makeCard(4, { ...METAS.A })) === false, 'a filled card with no game running is refused');
}

// --- 3. Matching identity but an incompatible core build → refuse ------------
//
// The subtle one the file/core guard cannot catch: same core id, rebuilt binary.
// Refusal comes from src/SaveState.js's checkSaveStateCompatibility, reached only
// AFTER the IndexedDB read, so this also proves the post-await path runs.
{
  // Seed slot-5 with a state stamped against a different build of the same core.
  storeFor('states').set('slot-5', {
    data: new Uint8Array([9, 9]), core: METAS.A.core, coreId: METAS.A.core,
    file: METAS.A.file, title: METAS.A.title, system: METAS.A.system,
    coreBuildHash: 'build-OLD', ts: 1,
  });
  let unserialized = 0;
  const { ui, status } = setup({
    client: clientWith({ buildHash: 'build-1', unserializeState: async () => { unserialized++; } }),
    meta: METAS.A,
  });
  const card = makeCard(5, { ...METAS.A });
  ok(ui.handleInsert(card) === true, 'a matching card is accepted for loading');
  await settle();
  ok(unserialized === 0, 'an incompatible build is never pushed into the core');
  ok(/incompatible with the loaded core build \(core-build-mismatch\)/.test(status.at(-1)),
    `the build mismatch is reported (got ${status.at(-1)})`);
  ok(card.userData.pulses.at(-1) === RED, 'build mismatch pulses red');
}

// --- 4. THE SAVE-IDENTITY RACE (ARC-1) ---------------------------------------
//
// serializeState resolves on a LATER tick. In between, the console boots another
// game, so the injected getMeta()/getClient() now describe Game B. The persisted
// record must still be Game A: those bytes came out of Game A's core, and a
// record stamped "Game B" would sail through both the file/core guard and
// checkSaveStateCompatibility on the next load and be fed to the wrong game.
{
  const bytesA = new Uint8Array([0xa, 0xa, 0xa, 0xa]);
  let releaseA;
  const clientA = clientWith({ serializeState: () => new Promise((res) => { releaseA = () => res(bytesA); }) });
  const clientB = clientWith({ serializeState: async () => new Uint8Array([0xb]) });

  let live = { client: clientA, meta: METAS.A };
  const { ui, status } = setup({ getClient: () => live.client, getMeta: () => live.meta });

  const card = makeCard(6);
  ok(ui.handleInsert(card) === true, 'saving to an empty card starts the transaction');
  ok(status.at(-1) === 'saving Game A to slot 6…', `the status names the game being saved (got ${status.at(-1)})`);

  // …the boot the race is about: Game B takes over the console mid-serialize.
  live = { client: clientB, meta: METAS.B };
  releaseA();
  await settle(20);

  const rec = storeFor('states').get('slot-6');
  ok(!!rec, 'the save landed in the slot');
  ok(rec.title === 'Game A' && rec.file === 'gameA.sfc' && rec.core === 'snes9x' && rec.system === 'snes',
    `the record keeps the ORIGINAL identity (got ${rec && rec.title}/${rec && rec.file}/${rec && rec.core})`);
  ok(rec.coreId === 'snes9x' && rec.entryPath === 'gameA.sfc',
    'the SaveState identity fields derived on write name Game A too');
  ok(rec.data === bytesA, "the bytes stored are the ones Game A's core produced");
  ok(card.userData.saved && card.userData.saved.title === 'Game A',
    'the card label shows the game it actually holds');
  ok(card.userData.pulses.at(-1) === WHITE, 'a successful save pulses white');
  ok(status.at(-1) === 'saved Game A to slot 6', `the final status names Game A (got ${status.at(-1)})`);
}

// --- 5. The load branch abandons when its console rebooted underneath it -----
//
// The other half of the same problem, and why the load branch needs the boot
// epoch on top of the capture: a reboot hands out a NEW client object, so the
// captured one is a retired core — and if the new game runs the same core,
// checkSaveStateCompatibility would happily say yes.
{
  storeFor('states').set('slot-7', {
    data: new Uint8Array([7]), core: METAS.A.core, coreId: METAS.A.core,
    file: METAS.A.file, title: METAS.A.title, system: METAS.A.system,
    coreBuildHash: 'build-1', ts: 1,
  });
  let unserialized = 0;
  let rebooted = false;
  const { ui, status } = setup({
    client: clientWith({ unserializeState: async () => { unserialized++; } }),
    meta: METAS.A,
    captureBootEpoch: () => () => rebooted,
  });
  const card = makeCard(7, { ...METAS.A });
  ok(ui.handleInsert(card) === true, 'the load transaction starts');
  rebooted = true;                       // a boot lands while IndexedDB is reading
  await settle();
  ok(unserialized === 0, 'a superseded load never writes into the live core');
  ok(/rebooted/.test(status.at(-1)), `the abandon is explained (got ${status.at(-1)})`);

  // Control: the identical insert with no reboot DOES load.
  let unserialized2 = 0;
  const { ui: ui2, status: status2 } = setup({
    client: clientWith({ unserializeState: async () => { unserialized2++; } }),
    meta: METAS.A,
  });
  const card2 = makeCard(7, { ...METAS.A });
  ui2.handleInsert(card2);
  await settle();
  ok(unserialized2 === 1, 'the same insert without a reboot loads the state');
  ok(status2.at(-1) === 'loaded Game A from slot 7', `the load reports success (got ${status2.at(-1)})`);
  ok(card2.userData.pulses.at(-1) === WHITE, 'a successful load pulses white');
}

// --- 6. A core with no save-state support is refused, not crashed ------------
{
  const { ui, status } = setup({ client: clientWith({ canSerialize: undefined }), meta: METAS.A });
  ok(ui.handleInsert(makeCard(8)) === false, 'a core without canSerialize() refuses the save');
  ok(/no save-state support/.test(status.at(-1)), `the refusal says why (got ${status.at(-1)})`);
}

// --- 7. An empty slot reads as empty, not as a corrupt load ------------------
{
  const { ui, status } = setup({ client: clientWith(), meta: METAS.A });
  const card = makeCard(9, { ...METAS.A });   // card claims a save the DB does not have
  ui.handleInsert(card);
  await settle();
  ok(status.at(-1) === 'slot 9 empty', `a missing record reports empty (got ${status.at(-1)})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
