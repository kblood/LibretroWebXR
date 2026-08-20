// CODEX ARC-1 (the save-identity race) and ARC-2(c) (boot-transaction epochs).
// The epoch machinery lives in src/main.js — the one file in this repo that no
// test imports. The memory-card transaction ARC-1 is about USED to live there
// too; it has since been extracted VERBATIM to src/MemoryCardUI.js (the P2 #12 /
// §3.1 extraction, step 1), so this suite slices it from its new home. The two
// halves are still tested together because the load branch consults main.js's
// epoch counters, so the seam between the two files is part of what is pinned.
//
// WHY THIS SUITE IS SHAPED THE WAY IT IS
// main.js cannot be imported: it builds a SceneMgr, reads document.querySelector
// and installs spatial audio at module scope. The existing precedent for pinning
// something inside it (scripts/test-authority-epoch.mjs, section C) reads the
// source and asserts on its TEXT. That catches an edit that undoes a fix, but it
// cannot catch a fix that never worked, and the whole point of ARC-1 is a timing
// bug — you cannot see a race in a regex.
//
// So section A goes one step further: it SLICES the functions under test out of
// their source files and compiles that exact text with `new Function` + `with`,
// injecting the bindings they close over (`getClient`, `getMeta`, setStatus,
// saveState, loadState, …) as properties of an object the test can mutate
// BETWEEN TICKS. Nothing is re-implemented and nothing can drift: the code that
// runs here is the code that ships, byte for byte, and the injected bindings
// behave exactly like the real ones. If a slice ever stops matching, the suite
// fails loudly rather than passing on air.
//
// WHY STILL SLICE MemoryCardUI.js RATHER THAN IMPORT IT? It is importable under
// plain node now, and that was tried. But it takes `saveState`/`loadState` as
// hard module imports from [[src/SaveState.js]], which reach for `indexedDB` —
// absent in node, so every save case would collapse into the module's own
// `.catch` and assert nothing. `with (env)` is what still lets the test stand in
// for the store AND release the worker round-trip on its own schedule, which is
// the entire point of a race suite. Import the module here the day the store is
// injectable, and not before.
//
// Every race case has a NEGATIVE CONTROL that mechanically strips the fix out of
// the same sliced text (drop the captures, read the live bindings again) and
// REQUIRES the old, broken outcome. Without that, a test of an async path proves
// only that the test's own timing never triggered anything.
//
// THE TWO BUGS
//
// 1. ARC-1, the save-identity race. handleMemoryCardInserted() called
//    client.serializeState() and then built the save payload INSIDE the .then,
//    reading `currentMeta` at RESOLVE time. Both bindings are reassigned by every
//    boot path, and a worker-execution core's serializeState() crosses the worker
//    boundary (hundreds of ms for PSX/PS2). Insert a card while Game A runs, drop
//    Game B's cart in during that window, and slot-N got A's state BYTES stamped
//    with B's core/file/title. Nothing downstream can catch it — the filename+core
//    guard and checkSaveStateCompatibility both PASS, because the record claims to
//    be B — so A's state is fed to B's core. Same class as COR-6
//    ([[src/SaveRamGuard.js]]): saved bytes belong to the runtime that made them.
//
// 2. ARC-2(c), the class rather than the instance. Five entry points boot a
//    console (loadCartridge, bootOnPrimary, rebootPrimaryConsole,
//    loadCartridgeIntoConsole, spawnConsole) and each hand-sequenced its own
//    awaits against the shared globals; only loadCartridge ordered itself against
//    anything, and only against another loadCartridge. Each now opens a per-console
//    boot transaction and its post-await continuations bail when it is stale.
//
// NOT THE SAME THING AS THE AUTHORITY EPOCH. src/net/AuthorityEpoch.js (COR-3,
// pinned by scripts/test-authority-epoch.mjs) answers "may this machine run a core
// at all". The boot epoch answers "is this continuation still the current boot".
// Section C pins that they stay two separate mechanisms with two separate names.
//
// Pure logic: no THREE, no DOM, no sockets, no ports.
// Run: node scripts/test-boot-transaction.mjs   (also in `npm test`)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkSaveStateCompatibility, prepareSaveStatePayload } from '../src/SaveState.js';

let passed = 0;
let failed = 0;
const stderr = console.error.bind(console);
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; stderr(`  FAIL: ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const section = (name, fn) => {
  console.log(`--- ${name} ---`);
  return Promise.resolve()
    .then(fn)
    .catch((e) => { failed++; stderr(`  FAIL: section "${name}" threw — ${e.stack || e.message}`); });
};
// Two macrotask turns: enough for a .then chain of any depth this code uses.
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

// Read with the line endings NORMALISED to LF. Every text operation below is
// written against LF — the slice terminators, the ^-anchored strips that build
// the negative control, the section-C body scans — and a Windows checkout with
// core.autocrlf=true (this repo ships no .gitattributes) hands these files over
// as CRLF. A header lookup still matched there, because '\n' + header matches
// the LF half of a CRLF, but the terminator never did, so sliceFn threw and the
// suite died before a single assertion ran. LF vs CRLF is invisible to JS, so
// normalising changes nothing about the code under test; it only makes the
// slices mean the same thing on every checkout.
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const MAIN = read('../src/main.js');
const MEMCARD_SRC = read('../src/MemoryCardUI.js');

// --- slicing the real source ------------------------------------------------
// A declaration runs from its header to the first `}` at its OWN indent (every
// brace nested inside it is indented further). `indent` is '' for a top-level
// function in main.js and '  ' for one nested in MemoryCardUI.js's factory.
// Throws rather than returning '' — a silently empty slice would make every
// assertion below vacuous.
function sliceFn(src, label, header, indent = '') {
  const start = src.indexOf(`\n${indent}${header}`);
  if (start < 0) throw new Error(`${label} no longer contains "${header}" — this suite slices it, so update the header here`);
  const close = `\n${indent}}\n`;
  const end = src.indexOf(close, start);
  if (end < 0) throw new Error(`could not find the end of "${header}" in ${label}`);
  return src.slice(start + 1, end + close.length - 1);
}
function sliceLine(prefix) {
  const line = MAIN.split('\n').find((l) => l.startsWith(prefix));
  if (!line) throw new Error(`src/main.js no longer declares "${prefix}"`);
  return line;
}

const SRC_EPOCHS = sliceLine('const _bootEpochs = new Map();');
const SRC_CAPTURE = sliceFn(MAIN, 'src/main.js', 'function captureBootEpoch(consoleId) {');
const SRC_BEGIN = sliceFn(MAIN, 'src/main.js', "function beginBootTransaction(consoleId, reason = '') {");
// Nested one level inside createMemoryCardUI(), which is why it needs the indent.
const SRC_MEMCARD = sliceFn(MEMCARD_SRC, 'src/MemoryCardUI.js', 'function handleMemoryCardInserted(card) {', '  ');

// The pre-fix shape of handleMemoryCardInserted, derived MECHANICALLY from the
// shipped text: drop the three captures and the epoch bail, then rename the
// captured names back to the live reads they replaced. Before the extraction
// those reads were the module globals `client`/`currentMeta` directly; the
// module takes them as the getters `getClient()`/`getMeta()` now, which is the
// same live read through one more layer — so the control reinstates THOSE, and
// still reproduces exactly the old resolve-time behaviour. This is what the
// function did before ARC-1 was fixed, and the race cases below require it to
// still lose.
const SRC_MEMCARD_PREFIX = SRC_MEMCARD
  .replace(/^ *const ownerClient = getClient\(\);\n/gm, '')
  .replace(/^ *const ownerMeta = getMeta\(\);\n/gm, '')
  .replace(/^ *const supersededByNewerBoot = captureBootEpoch\(CONSOLE_ID\);\n/gm, '')
  .replace(/ *if \(supersededByNewerBoot\(\)\) \{[\s\S]*?\n {6}\}\n/, '')
  .replace(/\bownerMeta\b/g, 'getMeta()')
  .replace(/\bownerClient\b/g, 'getClient()');

function compile(memcardSrc) {
  const body = [SRC_EPOCHS, SRC_CAPTURE, SRC_BEGIN, memcardSrc].join('\n\n');
  // Sloppy mode (a `new Function` body always is), which is what makes `with`
  // legal. Names present on `env` resolve to it — live, on every read, exactly
  // like the module `let`s do — and everything else (Promise, Date, console)
  // falls through to the real global scope.
  // eslint-disable-next-line no-new-func
  const factory = new Function('env', `with (env) {\n${body}\nreturn { handleMemoryCardInserted, captureBootEpoch, beginBootTransaction };\n}`);
  return (env) => factory(env);
}

const makeFixed = compile(SRC_MEMCARD);
const makePreFix = compile(SRC_MEMCARD_PREFIX);

const META_A = { core: 'fceumm', file: 'gallery.nes', title: 'NES Gallery', system: 'nes' };
const META_B = { core: 'snes9x', file: 'scope.sfc', title: 'Scope Gallery', system: 'snes' };

function makeEnv() {
  const rec = { statuses: [], stored: new Map(), unserialized: [] };
  const env = {
    CONSOLE_ID: 'console0',
    logger: null,
    // `client`/`currentMeta` are still the test's own mutable state — every case
    // below reassigns them mid-flight to model a boot landing during an await.
    // The module reaches them through getters, exactly as main.js wires it
    // (`getClient: () => client`), so the read is live on every call and the two
    // lines below are the whole reason a captured owner and a resolve-time read
    // can be told apart here at all.
    client: null,
    currentMeta: null,
    getClient: () => env.client,
    getMeta: () => env.currentMeta,
    setStatus: (s) => rec.statuses.push(s),
    // The real record shape (coreId/coreBuildHash/entryPath defaults), so the
    // compatibility check below is the one the app actually runs.
    saveState: async (slotId, payload) => { rec.stored.set(slotId, prepareSaveStatePayload(payload)); },
    loadState: async (slotId) => rec.stored.get(slotId) ?? null,
    checkSaveStateCompatibility,
  };
  return { env, rec };
}

function fakeCard(slot, savedMeta = null) {
  const rec = { pulses: [], saved: null };
  return {
    rec,
    userData: {
      slot,
      savedMeta,
      pulse: (c) => rec.pulses.push(c),
      setSaved: (m) => { rec.saved = m; },
    },
  };
}

// A client whose serializeState() is held open until the test releases it — the
// worker-boundary round trip, made explicit.
function gatedClient(name, { buildHash = `hash-${name}`, bytes = [1, 2, 3] } = {}) {
  let release;
  const gate = new Promise((r) => { release = r; });
  const unserialized = [];
  return {
    name,
    buildHash,
    unserialized,
    release: () => release(new Uint8Array(bytes)),
    canSerialize: () => true,
    serializeState: () => gate,
    unserializeState: async (data) => { unserialized.push(data); },
  };
}

// === A. the real handleMemoryCardInserted, executed =========================

await section('the slices are real code, and the negative control really is the old code', () => {
  ok(SRC_MEMCARD.includes('const ownerMeta = getMeta();'), 'the shipped function captures the meta before the await');
  ok(/core: ownerMeta\.core,/.test(SRC_MEMCARD), 'and stamps the payload from the capture');
  ok(!/\bownerMeta\b/.test(SRC_MEMCARD_PREFIX), 'the control has no captures left');
  ok(!/supersededByNewerBoot/.test(SRC_MEMCARD_PREFIX), 'nor the boot-epoch guard');
  ok(/core: getMeta\(\)\.core,/.test(SRC_MEMCARD_PREFIX), 'and reads the live binding at resolve time, as it used to');
  ok(SRC_MEMCARD_PREFIX.length < SRC_MEMCARD.length, 'the control is strictly the smaller, older shape');
});

await section('an empty card with no game refuses', () => {
  const { env, rec } = makeEnv();
  const api = makeFixed(env);
  const card = fakeCard(1);
  eq(api.handleMemoryCardInserted(card), false, 'the insert is refused');
  eq(rec.statuses, ['insert a cartridge first'], 'and says why');
  eq(card.rec.pulses, [0xcc2222], 'red pulse, card bounces home');
});

await section('a core with no save-state support refuses', () => {
  const { env, rec } = makeEnv();
  env.currentMeta = META_A;
  env.client = { canSerialize: () => false };
  const api = makeFixed(env);
  eq(api.handleMemoryCardInserted(fakeCard(1)), false, 'refused');
  ok(rec.statuses[0].includes('fceumm'), 'named the core that cannot serialize');
});

await section('ARC-1: a boot that lands mid-save cannot steal the save state’s identity', async () => {
  const { env, rec } = makeEnv();
  const api = makeFixed(env);
  const clientA = gatedClient('A');
  env.client = clientA;
  env.currentMeta = META_A;

  const card = fakeCard(2);
  eq(api.handleMemoryCardInserted(card), true, 'the save is accepted while Game A is running');

  // …and now Game B boots while the worker is still serialising A.
  api.beginBootTransaction('console0', 'loadCartridge');
  env.client = gatedClient('B');
  env.currentMeta = META_B;

  clientA.release();
  await settle();

  const row = rec.stored.get('slot-2');
  ok(!!row, 'the state was persisted');
  eq(row.core, META_A.core, 'the record names the core that produced the bytes');
  eq(row.file, META_A.file, 'and its file');
  eq(row.title, META_A.title, 'and its title');
  eq(row.system, META_A.system, 'and its system');
  eq(card.rec.saved?.file, META_A.file, 'the CARD is labelled with Game A too — it is what is on it');
  ok(rec.statuses.some((s) => s.includes('saved NES Gallery')), 'and the confirmation names Game A');
  // The save itself is deliberately NOT abandoned by the epoch: the bytes are
  // real and now correctly attributed, and the user asked for this save.
  ok(!card.rec.pulses.includes(0xcc2222), 'the save is not thrown away just because a boot happened');
  eq(card.rec.pulses, [0xffffff], 'it completes normally, with the white confirm pulse');
});

await section('NEGATIVE CONTROL: the pre-fix text loses that race', async () => {
  const { env, rec } = makeEnv();
  const api = makePreFix(env);
  const clientA = gatedClient('A');
  env.client = clientA;
  env.currentMeta = META_A;

  api.handleMemoryCardInserted(fakeCard(2));
  env.client = gatedClient('B');
  env.currentMeta = META_B;
  clientA.release();
  await settle();

  const row = rec.stored.get('slot-2');
  ok(!!row, 'the old code also persisted something');
  eq(row.core, META_B.core, 'but stamped it with the game that booted DURING the save');
  eq(row.file, META_B.file, 'file too — this record is a lie about bytes it does not describe');
  ok(rec.statuses.some((s) => s.includes('saved Scope Gallery')),
     'and it even told the user it saved the wrong game');
  // The corruption is only dangerous because it then passes every guard.
  const compat = checkSaveStateCompatibility(row, { coreId: META_B.core, coreBuildHash: undefined });
  ok(compat.compatible === true,
     'and checkSaveStateCompatibility waves it through, so Game A’s state reaches Game B’s core');
});

await section('a filled card whose game is not loaded refuses before touching anything', () => {
  const { env, rec } = makeEnv();
  env.currentMeta = META_B;
  env.client = gatedClient('B');
  const api = makeFixed(env);
  const card = fakeCard(3, META_A);
  eq(api.handleMemoryCardInserted(card), false, 'refused');
  ok(rec.statuses[0].includes('load that cart first'), 'and asks for the right cart');
});

await section('a matching filled card loads into the client that was captured', async () => {
  const { env, rec } = makeEnv();
  const api = makeFixed(env);
  const clientA = gatedClient('A');
  env.client = clientA;
  env.currentMeta = META_A;
  rec.stored.set('slot-1', prepareSaveStatePayload({
    data: new Uint8Array([9, 9]), core: META_A.core, file: META_A.file,
    title: META_A.title, system: META_A.system, coreBuildHash: 'hash-A',
  }));
  const card = fakeCard(1, META_A);
  eq(api.handleMemoryCardInserted(card), true, 'accepted');
  await settle();
  eq(clientA.unserialized.length, 1, 'the state reached the running core');
  eq(card.rec.pulses, [0xffffff], 'confirmed with the white pulse');
});

await section('an incompatible core build refuses the load', async () => {
  const { env, rec } = makeEnv();
  const api = makeFixed(env);
  const clientA = gatedClient('A', { buildHash: 'rebuilt-jit' });
  env.client = clientA;
  env.currentMeta = META_A;
  rec.stored.set('slot-1', prepareSaveStatePayload({
    data: new Uint8Array([9, 9]), core: META_A.core, file: META_A.file,
    title: META_A.title, system: META_A.system, coreBuildHash: 'old-jit',
  }));
  api.handleMemoryCardInserted(fakeCard(1, META_A));
  await settle();
  eq(clientA.unserialized.length, 0, 'nothing was fed to the core');
  ok(rec.statuses.some((s) => s.includes('incompatible')), 'and the refusal names the reason');
});

await section('ARC-2(c): a reboot during the IndexedDB read voids the load', async () => {
  const { env, rec } = makeEnv();
  const api = makeFixed(env);
  const clientA = gatedClient('A');
  env.client = clientA;
  env.currentMeta = META_A;
  rec.stored.set('slot-1', prepareSaveStatePayload({
    data: new Uint8Array([9, 9]), core: META_A.core, file: META_A.file,
    title: META_A.title, system: META_A.system, coreBuildHash: 'hash-A',
  }));
  // Hold the read open, and boot the SAME core with a fresh client in the middle
  // — the light-gun arm-reboot shape. Same core means the compatibility check
  // cannot save us; only the epoch can.
  let releaseRead;
  env.loadState = (slotId) => new Promise((r) => { releaseRead = () => r(rec.stored.get(slotId) ?? null); });

  api.handleMemoryCardInserted(fakeCard(1, META_A));
  const clientA2 = gatedClient('A2', { buildHash: 'hash-A' });
  api.beginBootTransaction('console0', 'reboot-gun');
  env.client = clientA2;
  releaseRead();
  await settle();

  eq(clientA.unserialized.length, 0, 'the RETIRED client is not written to');
  eq(clientA2.unserialized.length, 0, 'and neither is the fresh core that never asked for this state');
  ok(rec.statuses.some((s) => s.includes('rebooted')), 'the user is told why nothing happened');
});

await section('NEGATIVE CONTROL: the pre-fix text writes into the wrong core', async () => {
  const { env, rec } = makeEnv();
  const api = makePreFix(env);
  const clientA = gatedClient('A');
  env.client = clientA;
  env.currentMeta = META_A;
  rec.stored.set('slot-1', prepareSaveStatePayload({
    data: new Uint8Array([9, 9]), core: META_A.core, file: META_A.file,
    title: META_A.title, system: META_A.system, coreBuildHash: 'hash-A',
  }));
  let releaseRead;
  env.loadState = (slotId) => new Promise((r) => { releaseRead = () => r(rec.stored.get(slotId) ?? null); });

  api.handleMemoryCardInserted(fakeCard(1, META_A));
  const clientA2 = gatedClient('A2', { buildHash: 'hash-A' });
  env.client = clientA2;
  releaseRead();
  await settle();

  eq(clientA2.unserialized.length, 1,
     'the old code unserialised into whatever client happened to be live when the read landed');
});

// === B. the boot epoch itself, also the real source =========================

await section('a capture is fresh until a boot for THAT console begins', () => {
  const { env } = makeEnv();
  const api = makeFixed(env);
  const guard = api.captureBootEpoch('console0');
  ok(guard() === false, 'nothing has happened, so the continuation may commit');
  api.beginBootTransaction('console0', 'loadCartridge');
  ok(guard() === true, 'a boot for this console voids it');
});

await section('the epoch is per console — a rack boot must not abandon the primary', () => {
  const { env } = makeEnv();
  const api = makeFixed(env);
  const primary = api.captureBootEpoch('console0');
  api.beginBootTransaction('console2', 'loadCartridgeIntoConsole');
  ok(primary() === false,
     'dropping a cart on console2 leaves an in-flight console0 boot alone — a global counter '
     + 'here would drop legitimate boots on a busy rack, a worse bug than the one being fixed');
  const secondary = api.captureBootEpoch('console2');
  ok(secondary() === false, 'and the capture taken after that boot is itself clean');
});

await section('opening a transaction captures it, and the next one supersedes it', () => {
  const { env } = makeEnv();
  const api = makeFixed(env);
  const first = api.beginBootTransaction('console0', 'loadCartridge');
  ok(first() === false, 'the boot that just opened the transaction owns it');
  const second = api.beginBootTransaction('console0', 'bootOnPrimary');
  ok(first() === true, 'the older boot is superseded…');
  ok(second() === false, '…and the newer one owns the console');
  // Three-deep: the middle boot must not be resurrected by the third one's bump.
  const third = api.beginBootTransaction('console0', 'reboot-gun');
  ok(first() === true && second() === true && third() === false,
     'only the newest boot may commit, however many piled up');
});

await section('a joined transaction does not supersede its own caller', () => {
  // bootOnPrimary takes `bootTxn` for exactly this: loadCartridge hands over the
  // predicate it captured at entry, so the nested call cannot make the caller
  // stale. Modelled here on the real helpers; section C pins the wiring.
  const { env } = makeEnv();
  const api = makeFixed(env);
  const outer = api.beginBootTransaction('console0', 'loadCartridge');
  const joined = (bootTxn) => bootTxn || api.beginBootTransaction('console0', 'bootOnPrimary');
  const inner = joined(outer);
  ok(inner === outer, 'the nested boot reuses the caller’s transaction');
  ok(outer() === false, 'so the caller’s own checkpoints still say "go" after it returns');
  ok(joined(null)() === false && outer() === true,
     'while a BARE call (the local-ROM pickers) opens its own and supersedes whatever was loading');
});

await section('an unknown console starts at zero rather than throwing', () => {
  const { env } = makeEnv();
  const api = makeFixed(env);
  ok(api.captureBootEpoch('console9')() === false, 'a console nothing has ever booted is not stale');
});

// === C. the wiring in src/main.js ===========================================
//
// Section A proves the sliced functions behave. These pin that main.js actually
// CALLS them, at all five entry points, and that the two epochs stay distinct.
const fnBody = (header) => {
  const start = MAIN.indexOf(header);
  if (start < 0) return '';
  const end = MAIN.indexOf('\n}\n', start);
  return end < 0 ? MAIN.slice(start) : MAIN.slice(start, end);
};

await section('all five boot entry points open a transaction', () => {
  const entries = [
    ['loadCartridge', 'async function loadCartridge(', /beginBootTransaction\(CONSOLE_ID, 'loadCartridge'\)/],
    ['bootOnPrimary', 'async function bootOnPrimary(', /bootTxn \|\| beginBootTransaction\(CONSOLE_ID, 'bootOnPrimary'\)/],
    ['rebootPrimaryConsole', 'async function rebootPrimaryConsole(', /beginBootTransaction\(CONSOLE_ID, /],
    ['loadCartridgeIntoConsole', 'async function loadCartridgeIntoConsole(', /beginBootTransaction\(consoleId, 'loadCartridgeIntoConsole'\)/],
    ['spawnConsole', 'async function spawnConsole(', /beginBootTransaction\(consoleId, 'spawnConsole'\)/],
  ];
  for (const [name, header, re] of entries) {
    const body = fnBody(header);
    ok(body.length > 0, `${name} was found`);
    ok(re.test(body), `${name} opens a boot transaction at entry`);
  }
});

await section('every entry point re-checks it after its awaits', () => {
  for (const [name, header] of [
    ['loadCartridge', 'async function loadCartridge('],
    ['bootOnPrimary', 'async function bootOnPrimary('],
    ['rebootPrimaryConsole', 'async function rebootPrimaryConsole('],
    ['loadCartridgeIntoConsole', 'async function loadCartridgeIntoConsole('],
    ['spawnConsole', 'async function spawnConsole('],
  ]) {
    const body = fnBody(header);
    const capture = body.indexOf('supersededByNewerBoot = ');
    const check = body.indexOf('supersededByNewerBoot()', capture);
    ok(check > capture, `${name} consults the transaction after capturing it`);
  }
});

await section('loadCartridge hands its transaction DOWN to bootOnPrimary', () => {
  const body = fnBody('async function loadCartridge(');
  ok(/bootTxn: supersededByNewerBoot/.test(body),
     'the nested boot joins this one — opening a second transaction there would bump the epoch '
     + 'loadCartridge captured at entry and abandon the boot it is in the middle of');
});

await section('the guarded continuations are commits, never installs or disposals', () => {
  const reboot = fnBody('async function rebootPrimaryConsole(');
  const bail = reboot.indexOf('if (supersededByNewerBoot())');
  const install = reboot.indexOf('await bootFreshRuntime(');
  ok(bail > 0 && install > bail,
     'rebootPrimaryConsole bails BEFORE it stands a runtime up — bailing after would strand an '
     + 'unbound runtime, which is the COR-5 shape (an orphan nobody disposes), not a safe refusal');

  const boot = fnBody('async function bootOnPrimary(');
  const bootBail = boot.indexOf('if (supersededByNewerBoot())');
  ok(bootBail > 0 && boot.indexOf('trackConsoleSaveRam(') > bootBail && boot.indexOf('publishTvAndBroadcast(') > bootBail,
     'and bootOnPrimary guards exactly the two SHARED commits (SaveRAM identity, the room’s tv key)');

  const into = fnBody('async function loadCartridgeIntoConsole(');
  const intoBail = into.indexOf('if (supersededByNewerBoot())');
  ok(intoBail > 0 && into.indexOf('await bootFreshRuntime(') > intoBail && into.indexOf('await runtime.load(') > intoBail,
     'the secondary path bails before either of its two ways of touching the console’s core');
});

await section('the boot epoch and the room-authority epoch stay two separate things', () => {
  const capture = fnBody('function captureBootEpoch(');
  ok(capture.length > 0, 'captureBootEpoch was found');
  ok(!/hostAuthority|mayRunLocalCore|_authorityHandoffs/.test(capture),
     'the boot epoch knows nothing about who is allowed to run a core (that is COR-3’s question)');
  const authority = fnBody('function captureBootAuthority(');
  ok(authority.length > 0, 'captureBootAuthority is still there');
  ok(!/_bootEpochs|beginBootTransaction/.test(authority),
     'and the authority epoch knows nothing about which boot is current');
  const load = fnBody('async function loadCartridge(');
  ok(/const authorityLost = captureBootAuthority\(\);/.test(load) && /const supersededByNewerBoot = beginBootTransaction\(/.test(load),
     'loadCartridge captures BOTH, under two names a reader cannot confuse');
  ok(/supersededByNewerBoot\(\) \? 'newer-load' : authorityLost\(\) \? 'authority-lost'/.test(load),
     'and reports which of the two abandoned a boot, because the fixes are different');
});

await section('the memory-card transaction reads no live binding after its await', () => {
  // SRC_MEMCARD, not a main.js scan: the function lives in MemoryCardUI.js now.
  const body = SRC_MEMCARD;
  ok(body.length > 0, 'handleMemoryCardInserted was found');
  // Everything from the first await onwards must go through the captures — bar
  // the capture lines themselves, which are the one legitimate read of each
  // binding and are what the rest of the function then uses. (The load branch's
  // pair sits textually after the save branch's serialize call, so it is those
  // two lines this strips.)
  const afterAwait = body.slice(body.indexOf('ownerClient.serializeState()'))
    .replace(/^ *const owner(Client = getClient|Meta = getMeta)\(\);\n/gm, '');
  ok(afterAwait.length > 0, 'the serialize call was found');
  ok(!/\bgetMeta\(\)/.test(afterAwait),
     'no continuation reads the live meta at resolve time — that IS the ARC-1 bug');
  ok(!/\bgetClient\(\)/.test(afterAwait),
     'nor reaches for the live client');
});

await section('main.js hands the module GETTERS, not the values it had at build time', () => {
  // The extraction moved the race fix into MemoryCardUI.js but left its premise
  // in main.js: the module can only capture a per-transaction owner if what it
  // was handed still reads through to the reassignable `client`/`currentMeta`.
  // Passing `client` and `currentMeta` directly here would type-check, run, and
  // silently reinstate ARC-1 with every line of MemoryCardUI.js untouched — and
  // section A could not see it, because section A injects its own bindings. This
  // is the seam, so it is pinned here.
  ok(/getClient: \(\) => client,/.test(MAIN),
     'the client is passed as a getter, evaluated per transaction');
  ok(/getMeta: \(\) => currentMeta,/.test(MAIN),
     'and so is the meta');
  ok(/captureBootEpoch,/.test(MAIN) && /CONSOLE_ID,\n {2}\}\);/.test(MAIN),
     'and the load branch gets main.js’s real epoch counters, for the console it runs on');
});

await section('main.js kept only the wiring — the transaction itself is gone from it', () => {
  // Guards the other half of the extraction: if handleMemoryCardInserted is ever
  // copied back into main.js, this suite would be slicing MemoryCardUI.js while
  // the app ran a second, unpinned copy.
  ok(!/\nfunction handleMemoryCardInserted\(/.test(MAIN),
     'main.js no longer defines the transaction');
  ok(/memoryCardUI\.handleInsert\(card\)/.test(MAIN),
     'it calls the extracted module instead');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
