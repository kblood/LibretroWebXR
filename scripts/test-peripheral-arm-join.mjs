// The peripheral arm must JOIN a cartridge load that is still in flight, never
// reboot over it. Executed against the REAL src/main.js text.
//
// THE BUG THIS PINS. Widening the ARC-2(c) boot epoch from "only loadCartridge
// bumps it" to "all five entry points bump it" made rebootPrimaryConsole — the
// light-gun / mouse arm-reboot — supersede an in-flight cartridge load. The
// sequence is the ordinary one for exactly the gun carts this project is built
// around:
//
//   1. drop a light-gun cart in the slot     → loadCartridge starts fetching a
//                                              multi-MB ROM over the headset's
//                                              Wi-Fi and captures its epoch
//   2. pick the light gun up (seconds later, ROM still downloading)
//                                            → armPeripheral → rebootPrimaryConsole
//                                              bumps the epoch synchronously
//   3. the fetch lands                       → loadCartridge reads 'newer-load'
//                                              and abandons — a branch that
//                                              deliberately prints NOTHING,
//                                              because normally the newer load
//                                              owns the status line
//
// Net effect: the console reboots the PREVIOUS game with the gun attached, the
// game the player just inserted is gone, the cart mesh is still in the slot, and
// nothing anywhere says so.
//
// THE FIX, and what this suite asserts: armPeripheral (and disarmPeripheral)
// wait for the in-flight load instead of racing it. The sticky arm flag is set
// BEFORE the wait and every primary boot resolves its peripherals AFTER its
// fetch, so the load usually seats the device itself and no reboot is needed at
// all — which is both correct and one boot cheaper.
//
// HOW IT RUNS REAL CODE. src/main.js cannot be imported (it builds a SceneMgr
// and reads document at module scope), so this uses the technique established by
// scripts/test-boot-transaction.mjs: SLICE the functions out of the source and
// compile that exact text with `new Function` + `with (env)`, injecting the
// bindings they close over. Nothing is re-implemented, so nothing can drift.
//
// Both cases have a NEGATIVE CONTROL that mechanically strips the join out of
// the same sliced text and REQUIRES the old, broken ordering back.
//
// Pure logic: no THREE, no DOM, no sockets, no ports.
// Run: node scripts/test-peripheral-arm-join.mjs   (also in `npm test`)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
let failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } };
const section = async (name, fn) => {
  console.log(`--- ${name} ---`);
  try { await fn(); } catch (e) { failed++; console.error(`  FAIL: section "${name}" threw — ${e.stack || e.message}`); }
};
// Enough turns for any .then/await chain these functions use.
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };

const MAIN = readFileSync(fileURLToPath(new URL('../src/main.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

// A top-level declaration runs from its header to the first `}` at column 0.
function sliceFn(header) {
  const start = MAIN.indexOf(`\n${header}`);
  if (start < 0) throw new Error(`src/main.js no longer contains "${header}" — this suite slices it, so update the header here`);
  const end = MAIN.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`could not find the end of "${header}"`);
  return MAIN.slice(start + 1, end + 2);
}
function sliceLine(prefix) {
  const line = MAIN.split('\n').find((l) => l.startsWith(prefix));
  if (!line) throw new Error(`src/main.js no longer declares "${prefix}"`);
  return line;
}

const SRC_FLAG = sliceLine('let _primaryLoadInFlight = null;');
const SRC_AWAIT = sliceFn('async function awaitPrimaryLoad() {');
const SRC_ARM = sliceFn('async function armPeripheral(desc) {');
const SRC_DISARM = sliceFn('async function disarmPeripheral(desc) {');

// The pre-fix shape, derived MECHANICALLY from the shipped text: delete the
// whole `if (_primaryLoadInFlight) { … }` join block and nothing else. What is
// left is what shipped in the extraction — an arm that reboots the moment the
// prop is grabbed, in flight or not.
const stripJoin = (src) => src.replace(/ {2}if \(_primaryLoadInFlight\) \{[\s\S]*?\n {2}\}\n/, '');
const SRC_ARM_PREFIX = stripJoin(SRC_ARM);
const SRC_DISARM_PREFIX = stripJoin(SRC_DISARM);

function compile(armSrc, disarmSrc) {
  const body = [SRC_FLAG, SRC_AWAIT, armSrc, disarmSrc].join('\n\n');
  // Sloppy mode (a `new Function` body always is), which is what makes `with`
  // legal. Names present on `env` resolve to it — live, on every read, exactly
  // like the module bindings do. The three accessors at the end are the test's
  // own handle on the module-scope `let` the slice declares.
  // eslint-disable-next-line no-new-func
  const factory = new Function('env', `with (env) {\n${body}\nreturn {
    armPeripheral, disarmPeripheral, awaitPrimaryLoad,
    setLoadInFlight: (p) => { _primaryLoadInFlight = p; },
    getLoadInFlight: () => _primaryLoadInFlight,
  };\n}`);
  return (env) => factory(env);
}

const makeFixed = compile(SRC_ARM, SRC_DISARM);
const makePreFix = compile(SRC_ARM_PREFIX, SRC_DISARM_PREFIX);

// The real LIGHTGUN descriptor fields these two functions touch.
const GUN = {
  id: 'lightgun',
  label: 'light gun',
  shortLabel: 'gun',
  sessionKey: 'libretrowebxr.lightgun',
  armKey: '__lightgunArmed',
  metaFlag: 'lightgun',
  wireDevice: 'lightgun',
  capableFor: () => true,
};
const GAME_A = { file: 'a.nes', core: 'fceumm', system: 'nes', title: 'Game A' };
const GAME_B = { file: 'b.nes', core: 'fceumm', system: 'nes', title: 'Game B' };

function makeEnv() {
  const rec = { statuses: [], boots: [], events: [], reloaded: 0 };
  const env = {
    CONSOLE_ID: 'console0',
    PENDING_KEY: 'libretrowebxr.pending',
    window: {},
    sessionStorage: { setItem() {}, removeItem() {} },
    location: { reload: () => { rec.reloaded++; } },
    console,
    editor: null,
    cartridges: [],
    grabMgr: null,
    logger: { event: (name, detail) => rec.events.push({ name, detail }) },
    setStatus: (s) => rec.statuses.push(s),
    amRoomHost: () => true,
    _forwardPeripheralArm: () => {},
    syncPeripheralArmButtons: () => {},
    stashRoomBridge: () => {},
    stashSessionRejoin: () => {},
    // Mutable world state, reassigned by the test to model a boot landing.
    currentMeta: { ...GAME_A },
    _lastLoadedMeta: { ...GAME_A },
    armedConsole: false,
    _armedConsoleFor: () => env.armedConsole,
    // Stands in for rebootPrimaryConsole via the real _ARM_PLANS shape.
    rebootResult: {},
    _ARM_PLANS: {
      lightgun: (desc, m) => ({
        boot: async () => { rec.boots.push(m.file); return env.rebootResult; },
        okStatus: 'light gun connected',
        pending: { lightgun: true },
      }),
    },
    _DISARM_HOOKS: {},
    rebootPrimaryConsole: async (m) => { rec.boots.push(m.file); return env.rebootResult; },
  };
  return { env, rec };
}

// A load that the test releases by hand — the multi-MB fetch, made explicit.
function gatedLoad() {
  let release;
  const promise = new Promise((r) => { release = r; });
  return { promise, release };
}

await section('the slices are real code, and the control really is the pre-fix code', () => {
  ok(/await awaitPrimaryLoad\(\);/.test(SRC_ARM), 'the shipped arm waits for the load in flight');
  ok(/await awaitPrimaryLoad\(\);/.test(SRC_DISARM), 'and so does the shipped disarm');
  ok(!/_primaryLoadInFlight/.test(SRC_ARM_PREFIX), 'the control has no join left in the arm');
  ok(!/_primaryLoadInFlight/.test(SRC_DISARM_PREFIX), 'nor in the disarm');
  ok(SRC_ARM_PREFIX.includes('const plan = _ARM_PLANS[desc.id](desc, m, sys);'),
     'and the control is otherwise the same function (stripping removed only the join)');
});

await section('arming mid-download does not boot until the load has landed', async () => {
  const { env, rec } = makeEnv();
  const api = makeFixed(env);
  const load = gatedLoad();
  api.setLoadInFlight(load.promise);

  const armed = api.armPeripheral(GUN);
  await settle();
  ok(rec.boots.length === 0,
     'no reboot while the ROM is still downloading — this is the whole fix: a reboot here bumps '
     + 'the boot epoch and the in-flight loadCartridge abandons SILENTLY');
  ok(env.window.__lightgunArmed === true,
     'but the sticky arm flag is already set, so the load in flight seats the device itself');
  ok(rec.statuses.some((s) => s.includes('finishes loading')), 'and the player is told what is happening');

  // The load lands, having booted Game B WITH the gun (it resolves its
  // peripherals after its fetch, and reads the flag set above).
  env._lastLoadedMeta = { ...GAME_B };
  env.currentMeta = { ...GAME_B };
  env.armedConsole = true;
  api.setLoadInFlight(null);
  load.release();
  await armed;

  ok(rec.boots.length === 0, 'and STILL no reboot — the arriving game already has the gun on it');
  ok(rec.statuses[rec.statuses.length - 1] === 'light gun connected', 'the arm reports success');
});

await section('…and it does reboot once the load lands without the device', async () => {
  const { env, rec } = makeEnv();
  const api = makeFixed(env);
  const load = gatedLoad();
  api.setLoadInFlight(load.promise);

  const armed = api.armPeripheral(GUN);
  await settle();
  // The load landed on a boot path that ignores the arm flag (the #rom-input
  // picker does exactly this), so the device is NOT attached.
  env._lastLoadedMeta = { ...GAME_B };
  env.currentMeta = { ...GAME_B };
  api.setLoadInFlight(null);
  load.release();
  await armed;

  ok(rec.boots.length === 1, 'exactly one reboot');
  ok(rec.boots[0] === GAME_B.file,
     'and it re-boots the game that ARRIVED, not the stale one the arm saw when the prop was grabbed');
});

await section('NEGATIVE CONTROL: the pre-fix arm reboots over the download', async () => {
  const { env, rec } = makeEnv();
  const api = makePreFix(env);
  const load = gatedLoad();
  api.setLoadInFlight(load.promise);

  api.armPeripheral(GUN);
  await settle();
  ok(rec.boots.length === 1 && rec.boots[0] === GAME_A.file,
     'the shipped extraction rebooted the PREVIOUS game immediately — the bump that made the '
     + 'in-flight load abandon, and the cart the player just inserted disappear');
});

await section('a superseded reboot never claims the device is connected', async () => {
  const { env, rec } = makeEnv();
  const api = makeFixed(env);
  env.rebootResult = null;                 // rebootPrimaryConsole abandoned at its checkpoint
  await api.armPeripheral(GUN);
  ok(rec.boots.length === 1, 'the reboot was attempted');
  ok(!rec.statuses.includes('light gun connected'),
     'but nothing claims success for a boot that was abandoned before it stood anything up');
  ok(rec.events.some((e) => e.name === 'lightgun-arm-superseded'),
     'and the abandon is logged, so it is never invisible in a trace');
});

await section('disarming mid-download waits the same way', async () => {
  const { env, rec } = makeEnv();
  const api = makeFixed(env);
  env.window.__lightgunArmed = true;
  env.armedConsole = true;
  const load = gatedLoad();
  api.setLoadInFlight(load.promise);

  const done = api.disarmPeripheral(GUN);
  await settle();
  ok(rec.boots.length === 0, 'no disarm-reboot over an in-flight load either');
  ok(env.window.__lightgunArmed === false, 'the sticky flag is already cleared, so the arriving game boots without it');

  env._lastLoadedMeta = { ...GAME_B };
  env.currentMeta = { ...GAME_B };
  env.armedConsole = false;                // the load booted B with no gun
  api.setLoadInFlight(null);
  load.release();
  await done;
  ok(rec.boots.length === 0, 'and nothing to reboot for once it lands');
});

await section('awaitPrimaryLoad drains a load that is followed by another', async () => {
  const { env } = makeEnv();
  const api = makeFixed(env);
  const first = gatedLoad();
  const second = gatedLoad();
  api.setLoadInFlight(first.promise);

  let done = false;
  const waiting = api.awaitPrimaryLoad().then((waited) => { done = waited; });
  await settle();
  // A second insert replaces the marker before the first finishes.
  api.setLoadInFlight(second.promise);
  first.release();
  await settle();
  ok(done === false, 'still waiting: the newer load is the one an arm must join');
  api.setLoadInFlight(null);
  second.release();
  await waiting;
  ok(done === true, 'and it returns only once nothing is loading');
});

await section('a load that throws does not take the arm down with it', async () => {
  const { env, rec } = makeEnv();
  const api = makeFixed(env);
  api.setLoadInFlight(Promise.reject(new Error('404')));
  await api.armPeripheral(GUN);
  ok(rec.boots.length === 1,
     'a failed load leaves the previous game running, so the arm falls through to rebooting it');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
