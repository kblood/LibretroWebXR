// COR-4 / TST-3: the per-launch BOOT CONFIGURATION is part of a loaded core's
// identity — and until this suite existed, nothing in CI said so.
//
// The bug it pins (§5.4 / COR-4, the most user-visible one the 2026-08 review
// found): a libretro peripheral (light gun, mouse, Four Score multitap), a
// core-option set and a remap file attach ONLY at a fresh core boot —
// EmulatorClient consumes them in _writeRetroArchConfig(), which the same-core
// hot-swap branch returns before ever reaching. So inserting a Super Scope game
// while a plain snes9x game was already running kept the OLD game's devices:
// main.js armed the gun UI while the core saw a plain pad. The reverse was just
// as wrong — the fields were only overwritten when the incoming value was
// non-empty, so a gun game's devices stuck to the client and were re-applied to
// the next plain game.
//
// The shipped fix is bootConfigSignature() + `bootConfig` + the throw in start()
// + clientNeedsFreshBoot()/needsFreshBoot() + main.js's bootFreshRuntime
// recovery. All of it was un-tested, and the regression that would bring the bug
// back is cheap: make bootConfigSignature() ignore `inputDevices` (a plausible
// slip when adding a field) and normal→gun stops throwing, needsFreshBoot()
// starts saying false, main.js hot-swaps, and the shipped bug is silently back.
//
// WHAT WOULD MAKE THIS SUITE WORTHLESS, and what is done about it:
//   • Asserting the signature against a hard-coded JSON string would pin the
//     FORMAT, not the rule. Every assertion below is about a DECISION: does this
//     pair of launches share a core, and does start() agree with the predicate
//     the callers ask first?
//   • "It always throws" would pass a broken-but-paranoid implementation, so the
//     plain→plain ROM swap (the common case the fast path exists for) is
//     asserted to STILL hot-swap, with the core neither reloaded nor re-booted.
//   • The peripheral configs are the real ones from systems.js
//     (lightgunLoadConfig / fourScoreLoadConfig), not hand-written lookalikes.
//
// COR-4b is here too: start() used to turn a failed boot into a RESOLVED promise,
// so main.js's catch never ran and a game that never booted was published to the
// room as playing. Both failing branches must reject now.
//
// Pure logic: no DOM, no core binary, no ports — EmulatorClient only touches the
// browser inside the four methods stubbed below.
// Run: node scripts/test-boot-config.mjs   (also in `npm test`)

import { EmulatorClient, BootConfigChangeError, bootConfigSignature } from '../src/EmulatorClient.js';
import { ConsoleRuntime, clientNeedsFreshBoot } from '../src/ConsoleRuntime.js';
import { lightgunLoadConfig, fourScoreLoadConfig, CORES } from '../src/systems.js';

let passed = 0;
let failed = 0;
// Bound up front: quiet() below swaps console.error out while the failure
// sections provoke _fail(), and our own FAIL lines must survive that.
const stderr = console.error.bind(console);
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; stderr(`  FAIL: ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const section = (name, fn) => {
  console.log(`--- ${name} ---`);
  return Promise.resolve()
    .then(fn)
    .catch((e) => { failed++; stderr(`  FAIL: section "${name}" threw — ${e.stack || e.message}`); });
};

// ── a bootable EmulatorClient with no browser under it ─────────────────────
//
// Only the four methods that genuinely need a page are replaced (core fetch,
// cfg/BIOS writes, and the Emscripten Module). Everything the suite is about —
// the signature, the guard at the top of start(), the hot-swap branch, `ready`,
// the error event — is the real shipped code.
class TestClient extends EmulatorClient {
  constructor(opts = {}) {
    super(opts);
    this.callMainCount = 0;
    this.resetCount = 0;
    this.romWrites = 0;
    this.cfgWrites = 0;
    this.errors = [];
    this.addEventListener('error', (e) => this.errors.push(e.detail));
    this.throwOnCallMain = null;
    const self = this;
    this._module = {
      FS: { mkdirTree() {}, writeFile() { self.romWrites++; }, unlink() {}, analyzePath: () => ({ exists: false }) },
      callMain() {
        self.callMainCount++;
        if (self.throwOnCallMain) throw self.throwOnCallMain;
      },
      _cmd_reset() { self.resetCount++; },
      pauseMainLoop() {}, resumeMainLoop() {},
    };
  }
  async _loadCore() { this._runtimeReady = true; }     // no <script>/import()
  _getModule() { return this._module; }                 // no window.Module
  _writeRetroArchConfig() { this.cfgWrites++; }          // covered by test-retroarch-config
  async _provisionSystemFiles() {}                       // no fetch
}

const rom = () => new Uint8Array([1, 2, 3, 4]).buffer;

// The failure sections below deliberately provoke _fail(), which console.errors.
// Swallow only that expected noise (not our own FAIL lines, which go through the
// captured original) so a real regression stands out in the runner's output.
async function quiet(fn) {
  const real = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = real; }
}

// The three real launch shapes the review named, built from systems.js so a
// registry change that alters them shows up here rather than being re-typed.
const NES_CORE = { name: 'nestopia', url: CORES.nestopia.url, style: CORES.nestopia.style };
const PLAIN_NES = { coreName: 'nestopia', remapName: CORES.nestopia.remapName };
const gunCfg = lightgunLoadConfig('nes');
const GUN_NES = { coreName: 'nestopia', coreOptions: gunCfg.coreOptions, inputDevices: gunCfg.inputDevices, remapName: gunCfg.remapName };
const fsCfg = fourScoreLoadConfig('nes', 'fceumm');
const PLAIN_FCEUMM = { coreName: 'fceumm', remapName: CORES.fceumm.remapName };
const FOURSCORE_FCEUMM = { coreName: 'fceumm', inputDevices: fsCfg.inputDevices, remapName: fsCfg.remapName };

// === A. the signature is a canonical answer to "same boot configuration?" ===

await section('bootConfigSignature ignores key order but not content', () => {
  eq(bootConfigSignature({ coreOptions: { b: '1', a: '2' }, inputDevices: { 2: 260, 1: 1 } }),
     bootConfigSignature({ inputDevices: { 1: 1, 2: 260 }, coreOptions: { a: '2', b: '1' } }),
     'two launches that differ only in key order share a core');

  ok(bootConfigSignature({}) === bootConfigSignature({ coreOptions: {}, inputDevices: null, systemFiles: [], remapName: '' }),
     'absent, null, empty-object and empty-array all mean "nothing requested"');

  const base = bootConfigSignature(PLAIN_NES);
  ok(base !== bootConfigSignature(GUN_NES), 'arming the gun CHANGES the signature — the term COR-4 turns on');
  ok(base !== bootConfigSignature({ ...PLAIN_NES, coreOptions: { nestopia_show_crosshair: 'enabled' } }),
     'a core-option change is a different configuration');
  ok(base !== bootConfigSignature({ ...PLAIN_NES, remapName: 'FCEUmm' }),
     'a remap change is a different configuration (the remap is what CONNECTS a port device)');
  ok(base !== bootConfigSignature({ ...PLAIN_NES, systemFiles: [{ name: 'kick.rom', url: '/bios/kick.rom' }] }),
     'a BIOS/system file is part of the configuration');
  ok(bootConfigSignature(PLAIN_FCEUMM) !== bootConfigSignature(FOURSCORE_FCEUMM),
     'the Four Score multitap changes it too (it is an inputDevices override like any other)');

  // Deliberately NOT order-insensitive: systemFiles are provisioned in order
  // into one directory, so a different order is a different boot.
  ok(bootConfigSignature({ systemFiles: [{ name: 'a' }, { name: 'b' }] })
     !== bootConfigSignature({ systemFiles: [{ name: 'b' }, { name: 'a' }] }),
     'systemFiles ORDER is significant');

  // NEGATIVE CONTROL for the whole suite: the signature must not be reachable
  // from the ROM. A different game with the same peripherals shares a core.
  eq(bootConfigSignature({ ...PLAIN_NES, contentExt: 'nes', coreUrl: 'cores/x.js' }),
     bootConfigSignature({ ...PLAIN_NES, contentExt: 'zip', coreUrl: 'cores/y.js' }),
     'content/url are NOT part of the boot configuration — a plain→plain swap must stay a hot swap');
});

// === B. start() refuses a same-core boot whose configuration changed =========

for (const style of ['classic', 'module']) {
  await section(`normal → gun → normal on one ${style}-style core`, async () => {
    const client = new TestClient({ coreName: 'nestopia', coreUrl: CORES.nestopia.url, moduleStyle: style });
    ok(client.bootConfig === null, 'no core loaded yet → no boot configuration to be stale');

    await client.start({}, rom(), PLAIN_NES);
    ok(client.ready === true, 'the plain game booted');
    ok(client.bootConfig === bootConfigSignature(PLAIN_NES), 'the client records what its live core booted with');

    let thrown = null;
    try { await client.start({}, rom(), GUN_NES); } catch (e) { thrown = e; }
    ok(thrown instanceof BootConfigChangeError, 'inserting the Zapper game REFUSES the hot swap');
    ok(thrown?.code === 'BOOT_CONFIG_CHANGED', 'structured so main.js can recover onto a fresh runtime');
    eq([thrown?.from, thrown?.to], [bootConfigSignature(PLAIN_NES), bootConfigSignature(GUN_NES)],
       'and says which configuration it has vs which was asked for');
    ok(client.bootConfig === bootConfigSignature(PLAIN_NES),
       'the refused start left the client untouched — still the previous game (it is checked before anything mutates)');
    ok(client.callMainCount === 1, 'no second boot happened');

    // The reverse direction — the "sticky peripheral" half of COR-4.
    const gunClient = new TestClient({ coreName: 'nestopia' });
    await gunClient.start({}, rom(), GUN_NES);
    let back = null;
    try { await gunClient.start({}, rom(), PLAIN_NES); } catch (e) { back = e; }
    ok(back instanceof BootConfigChangeError, 'gun → plain is refused too: the devices would otherwise stick');
  });
}

await section('2-player → Four Score → 2-player on one core', async () => {
  const client = new TestClient({ coreName: 'fceumm' });
  await client.start({}, rom(), PLAIN_FCEUMM);
  let thrown = null;
  try { await client.start({}, rom(), FOURSCORE_FCEUMM); } catch (e) { thrown = e; }
  ok(thrown instanceof BootConfigChangeError, 'seating the multitap needs a fresh core');

  const four = new TestClient({ coreName: 'fceumm' });
  await four.start({}, rom(), FOURSCORE_FCEUMM);
  let back = null;
  try { await four.start({}, rom(), PLAIN_FCEUMM); } catch (e) { back = e; }
  ok(back instanceof BootConfigChangeError, 'and dropping it back to 2 players does too');
});

await section('NEGATIVE CONTROL: an unchanged configuration still takes the fast hot swap', async () => {
  const client = new TestClient({ coreName: 'nestopia' });
  await client.start({}, rom(), PLAIN_NES);
  const romWritesAfterBoot = client.romWrites;
  // Same peripherals, different game — the common case, and the whole reason the
  // in-place swap exists (a fresh core costs a Wasm heap that never comes back).
  await client.start({}, rom(), { ...PLAIN_NES, contentExt: 'nes' });
  ok(client.callMainCount === 1, 'the core was NOT re-booted');
  ok(client.cfgWrites === 1, 'and its cfg was NOT rewritten (the hot-swap branch returns before that)');
  ok(client.resetCount === 1, 'the running core was reset onto the new content instead');
  ok(client.romWrites === romWritesAfterBoot + 1, 'and the new ROM was written');
});

// === C. the predicate the callers ask FIRST agrees with what start() does ====
//
// main.js and ConsoleRuntime ask needsFreshBoot()/clientNeedsFreshBoot() and take
// the bootFreshRuntime path when it says yes; start()'s throw is only the
// backstop. A disagreement in either direction is a real bug: "false + throws"
// is an unhandled boot failure in the user's face, "true + would not have thrown"
// is a needless fresh core (a leaked Wasm heap) on every ordinary game change.
await section('needsFreshBoot() and start() never disagree', async () => {
  const cases = [
    ['plain → plain', PLAIN_NES, { ...PLAIN_NES, contentExt: 'nes' }],
    ['plain → gun', PLAIN_NES, GUN_NES],
    ['gun → plain', GUN_NES, PLAIN_NES],
    ['gun → gun', GUN_NES, { ...GUN_NES }],
    ['plain → core option', PLAIN_NES, { ...PLAIN_NES, coreOptions: { nestopia_show_crosshair: 'enabled' } }],
    ['plain → BIOS', PLAIN_NES, { ...PLAIN_NES, systemFiles: [{ name: 'disksys.rom', url: '/bios/disksys.rom' }] }],
  ];
  for (const [label, first, next] of cases) {
    const client = new TestClient({ coreName: 'nestopia' });
    await client.start({}, rom(), first);
    const predicted = clientNeedsFreshBoot(client, next);
    let threw = false;
    try { await client.start({}, rom(), next); } catch (e) { threw = e instanceof BootConfigChangeError; }
    ok(predicted === threw, `${label}: clientNeedsFreshBoot said ${predicted}, start() ${threw ? 'threw' : 'accepted'}`);
  }
});

await section('ConsoleRuntime.needsFreshBoot() answers the same question for the rack', async () => {
  const client = new TestClient({ coreName: 'nestopia' });
  const runtime = new ConsoleRuntime({ id: 'console1', adopt: { client, canvas: {} } });
  ok(runtime.needsFreshBoot(NES_CORE, {}) === false, 'a console with no core never needs a FRESH one');

  await runtime.load(rom(), NES_CORE, { system: 'nes', title: 'plain' });
  ok(runtime.needsFreshBoot(NES_CORE, { system: 'nes' }) === false,
     'the same plain game shape hot-swaps on a rack console too');
  ok(runtime.needsFreshBoot(NES_CORE, {
    system: 'nes', coreOptions: gunCfg.coreOptions, inputDevices: gunCfg.inputDevices, remapName: gunCfg.remapName,
  }) === true, 'a light-gun cartridge dropped on a rack console needs a fresh runtime');
  ok(runtime.needsFreshBoot({ name: 'fceumm', url: CORES.fceumm.url, style: CORES.fceumm.style }, { system: 'nes' }) === true,
     'a different core needs one whatever the configuration says');

  // A WorkerEmulatorClient exposes no `bootConfig`: it tears its worker down and
  // rebuilds it for EVERY content swap, so the configuration is always re-applied
  // and demanding a fresh runtime would leak one per game change.
  const workerish = { coreName: 'mednafen_psx_hw', ready: true, async start() {}, pause() {}, resume() {} };
  ok(clientNeedsFreshBoot(workerish, GUN_NES) === false,
     'a client with no bootConfig (worker topology) never demands a fresh boot');
});

// === D. COR-4b: a boot that did not happen must not resolve ==================

await section('start() rejects when callMain throws', () => quiet(async () => {
  const client = new TestClient({ coreName: 'nestopia' });
  client.throwOnCallMain = new Error('core aborted: out of memory');
  let thrown = null;
  try { await client.start({}, rom(), PLAIN_NES); } catch (e) { thrown = e; }
  ok(thrown instanceof Error, 'the failed boot REJECTS instead of resolving');
  ok(thrown?.message === 'core aborted: out of memory', "and rethrows the core's own error, not a summary of it");
  ok(client.ready === false, '`ready` stays false — nothing is running');
  eq(client.errors.length, 1, 'the `error` event still fired exactly once (the status-line listener is unchanged)');
  ok(/callMain threw/.test(client.errors[0] || ''), 'with the diagnostic message');
}));

await section('start() rejects a core switch it cannot service', () => quiet(async () => {
  const client = new TestClient({ coreName: 'nestopia' });
  await client.start({}, rom(), PLAIN_NES);
  let thrown = null;
  // Same boot configuration, different core name — past the BootConfigChangeError
  // guard, into the branch that used to `_fail(); return;`.
  try { await client.start({}, rom(), { ...PLAIN_NES, coreName: 'fceumm' }); } catch (e) { thrown = e; }
  ok(thrown instanceof Error, 'a same-client core switch rejects rather than resolving');
  ok(/requires page reload/.test(thrown?.message || ''), 'and says what actually fixes it');
  eq(client.errors.length, 1, 'the `error` event fired once');
  ok(client.callMainCount === 1, 'the previous core was left running, not re-entered');
}));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
