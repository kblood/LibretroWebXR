// Unit tests for the in-world power / reset switches and their network sync
// ([[src/PowerMgr.js]]).
//
// WHY THIS SUITE EXISTS. Nothing under scripts/ imports src/main.js, so a green
// run says nothing about code that lives there. PowerMgr is step 2 of the P2 #12
// extraction and this is what makes the move checkable: it drives the REAL
// module against the REAL [[src/ConsoleRegistry.js]] (not a stub of it), so the
// two halves of this change are exercised together the way main.js wires them.
//
// Power is net-synced and host-authoritative, so the assertions below deliberately
// pin the parts other code depends on and that a refactor could silently rot:
//   * the STATE key format `power:<kind>:<id>` and the isPowerStateKey predicate
//     that classifies it — that key ACL is do-not-break surface;
//   * _applyRemotePower, which parses a key that arrived off the wire, and must
//     never re-broadcast (only the toggling peer broadcasts, or two peers echo
//     each other forever);
//   * the "a power switch is not a pause button" cold-boot rule, which is a
//     comment-documented deliberate behaviour and the easiest thing to lose.
//
// Pure logic: no ports, no browser. A tiny fake `document` is installed because
// makeControlButton draws its label into a 2D canvas — THREE's CanvasTexture only
// stores whatever object it is handed, so a no-op context is enough and no WebGL
// is ever touched.

import { createConsoleRegistry } from '../src/ConsoleRegistry.js';
import { createPowerMgr } from '../src/PowerMgr.js';

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
};

// --- Fake DOM, only deep enough for makeControlButton -------------------------
const noopCtx = new Proxy({}, { get: () => () => {} });
globalThis.document = {
  createElement() { return { width: 0, height: 0, getContext: () => noopCtx }; },
};

// --- Stubs --------------------------------------------------------------------
const makeBtn = () => {
  const b = { userData: {}, colors: [], labels: [] };
  b.userData.setColor = (c) => b.colors.push(c);
  b.userData.setLabel = (l) => b.labels.push(l);
  return b;
};
const makeRuntime = () => {
  const calls = [];
  return {
    calls,
    client: { reset: () => calls.push('reset') },
    resume: () => calls.push('resume'),
    pause: () => calls.push('pause'),
  };
};
const makeNet = () => {
  const states = [], wires = [];
  return {
    states, wires,
    setObjectState: (k, v) => states.push([k, v]),
    sendWire: (ch, d) => wires.push([ch, d]),
  };
};
const makeMenu = () => {
  const items = new Map();
  return { items, addItem: (obj, cb) => items.set(obj, cb) };
};

const setup = (opts = {}) => {
  const registry = createConsoleRegistry({ getGrabMgr: () => null });
  const runtimes = new Map();
  const tvs = new Map();
  const audio = [];
  const events = [];
  let routed = 0, persisted = 0;
  let net = opts.net === undefined ? makeNet() : opts.net;
  let menuMgr = opts.menuMgr === undefined ? makeMenu() : opts.menuMgr;
  const pm = createPowerMgr({
    registry,
    scene: { getTV: (id) => tvs.get(id) },
    getNet: () => net,
    getMenuMgr: () => menuMgr,
    audioRouter: { setPower: (id, on) => audio.push([id, on]) },
    rackMgr: { get: (id) => runtimes.get(id) },
    routeVideo: () => { routed++; },
    persistRack: () => { persisted++; },
    logger: { event: (name, data) => events.push([name, data]) },
  });
  return {
    pm, registry, runtimes, tvs, audio, events,
    counts: () => ({ routed, persisted }),
    setNet: (n) => { net = n; },
    setMenu: (m) => { menuMgr = m; },
    getNet: () => net,
    getMenu: () => menuMgr,
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1. The nine-name surface -------------------------------------------------
{
  const { pm } = setup();
  const surface = ['setConsolePower', 'setTvPower', 'isPowerStateKey', '_broadcastPower',
    '_broadcastReset', 'resetConsole', '_applyRemotePower', 'addConsoleControls', 'addTvControls'];
  ok(surface.every((n) => typeof pm[n] === 'function'), 'all nine exports are functions');
  ok(Object.keys(pm).length === 9, 'the module exposes exactly nine names, no accidental extras');
}

// --- 2. isPowerStateKey — the key ACL predicate -------------------------------
{
  const { pm } = setup();
  ok(pm.isPowerStateKey('power:console:console0') === true, 'console power key matches');
  ok(pm.isPowerStateKey('power:tv:tv0') === true, 'tv power key matches');
  ok(pm.isPowerStateKey('prop:abc') === false, 'a prop key does not match');
  ok(pm.isPowerStateKey('gamepad:1') === false, 'a gamepad key does not match');
  ok(pm.isPowerStateKey('xpower:console:c0') === false, 'the prefix must be at the START');
  ok(pm.isPowerStateKey(null) === false, 'null is not a power key');
  ok(pm.isPowerStateKey(undefined) === false, 'undefined is not a power key');
  ok(pm.isPowerStateKey(42) === false, 'a number is not a power key');
  ok(pm.isPowerStateKey({ startsWith: () => true }) === false,
    'a non-string object is rejected on typeof, before startsWith is ever called');
}

// --- 3. Broadcast key format + boolean coercion -------------------------------
// isPowerStateKey and _applyRemotePower's parser both depend on this exact shape.
{
  const h = setup();
  h.pm._broadcastPower('console', 'console1', true);
  h.pm._broadcastPower('tv', 'tv0', 0);
  const [k1, v1] = h.getNet().states[0];
  const [k2, v2] = h.getNet().states[1];
  ok(k1 === 'power:console:console1', 'console key is power:console:<id>');
  ok(v1.on === true, 'value is { on: true }');
  ok(k2 === 'power:tv:tv0', 'tv key is power:tv:<id>');
  ok(v2.on === false, 'truthiness is coerced to a real boolean');
  h.pm._broadcastReset('console1');
  ok(h.getNet().wires.length === 1 && h.getNet().wires[0][0] === 'reset',
    'reset rides the transient WIRE channel');
  ok(h.getNet().wires[0][1].consoleId === 'console1', 'reset carries the consoleId');
  ok(h.getNet().states.length === 2,
    'reset is NOT persisted as state — a late joiner must not replay it onto a fresh core');
}

// --- 4. Broadcasting is late-bound to the CURRENT net -------------------------
// main.js reassigns `net` on every connect/disconnect, which is why it is
// injected as a getter. Offline (net === null) must be silent, not a throw.
{
  const h = setup({ net: null });
  let threw = false;
  try { h.pm._broadcastPower('console', 'console0', true); h.pm._broadcastReset('console0'); }
  catch { threw = true; }
  ok(!threw, 'broadcasting with no session does not throw');
  const later = makeNet();
  h.setNet(later);
  h.pm._broadcastPower('console', 'console0', true);
  ok(later.states.length === 1, 'a net connected AFTER construction still receives broadcasts');
}

// --- 5. "A power switch is not a pause button" --------------------------------
// Flipping OFF then ON is a COLD BOOT (client.reset), but an on->on call — which
// happens right after a fresh ROM load marks the console on — must NOT reset, or
// the user sees a surprise flicker.
{
  const h = setup();
  const rt = makeRuntime();
  h.runtimes.set('console0', rt);
  h.pm.setConsolePower('console0', true);          // absent == on, so this is on->on
  ok(rt.calls.join(',') === 'resume', 'on->on resumes but does NOT reset');
  h.pm.setConsolePower('console0', false);
  ok(rt.calls.join(',') === 'resume,pause', 'powering off pauses the core');
  ok(h.registry.isConsoleOn('console0') === false, 'registry reflects the off state');
  h.pm.setConsolePower('console0', true);
  ok(rt.calls.join(',') === 'resume,pause,reset,resume', 'off->on cold-boots: reset THEN resume');
  ok(h.registry.isConsoleOn('console0') === true, 'registry reflects the on state again');
}

// --- 6. Every side effect of a console power change ---------------------------
{
  const h = setup();
  h.runtimes.set('console0', makeRuntime());
  const btn = makeBtn();
  const before = h.counts();
  h.pm.setConsolePower('console0', false, btn);
  const after = h.counts();
  ok(after.routed === before.routed + 1, 'routeVideo() ran (the only place power is honoured)');
  ok(after.persisted === before.persisted + 1, 'the rack was persisted');
  ok(h.audio.length === 1 && h.audio[0][0] === 'console0' && h.audio[0][1] === false,
    'audio is forced silent regardless of whether the core honours pauseMainLoop');
  ok(btn.labels.join(',') === 'OFF' && btn.colors.join(',') === '#7a2222', 'switch tinted OFF/red');
  ok(h.events.some(([n, d]) => n === 'console-power' && d.consoleId === 'console0' && d.on === false),
    'a console-power event was logged');
  h.pm.setConsolePower('console0', true, btn);
  ok(btn.labels.join(',') === 'OFF,ON' && btn.colors.join(',') === '#7a2222,#2a6e2a',
    'switch tinted ON/green');
}

// --- 7. A console with no runtime yet is not a crash --------------------------
// rackMgr.get() returns undefined for a console that has not booted; the whole
// chain is optional-chained on purpose.
{
  const h = setup();
  let threw = false;
  try { h.pm.setConsolePower('nosuch', false); h.pm.setConsolePower('nosuch', true); }
  catch { threw = true; }
  ok(!threw, 'powering a console with no runtime does not throw');
  ok(h.registry.isConsoleOn('nosuch') === true, 'its state is still tracked');
}

// --- 8. TV power ---------------------------------------------------------------
{
  const h = setup();
  const btn = makeBtn();
  const before = h.counts();
  h.pm.setTvPower('tv0', false, btn);
  const after = h.counts();
  ok(h.registry.isTvOn('tv0') === false, 'tv is off');
  ok(after.routed === before.routed + 1 && after.persisted === before.persisted + 1,
    'routeVideo + persistRack ran');
  ok(btn.labels.join(',') === 'OFF', 'tv switch tinted OFF');
  ok(h.events.some(([n, d]) => n === 'tv-power' && d.tvId === 'tv0' && d.on === false),
    'a tv-power event was logged');
  ok(h.audio.length === 0, 'a TV toggle does not touch the audio router (that is per-console)');
}

// --- 9. resetConsole flashes the button, and never broadcasts -----------------
{
  const h = setup();
  const rt = makeRuntime();
  h.runtimes.set('console0', rt);
  const rst = makeBtn();
  h.registry.consoleObjs.set('console0', { userData: { resetBtn: rst } });
  h.pm.resetConsole('console0');
  ok(rt.calls.join(',') === 'reset', 'the core was reset');
  ok(rst.colors.join(',') === '#5a7fb0', 'the RESET button lit immediately');
  ok(h.events.some(([n, d]) => n === 'console-reset' && d.consoleId === 'console0'),
    'a console-reset event was logged');
  ok(h.getNet().states.length === 0 && h.getNet().wires.length === 0,
    'resetConsole itself never broadcasts — the caller decides, so a REMOTE reset cannot echo back');
  await sleep(300);
  ok(rst.colors.join(',') === '#5a7fb0,#33506e', 'the flash reverts to the resting colour');
}

// --- 10. resetConsole on an unknown console -----------------------------------
{
  const h = setup();
  let threw = false;
  try { h.pm.resetConsole('ghost'); } catch { threw = true; }
  ok(!threw, 'resetting a console with no object/runtime does not throw');
}

// --- 11. _applyRemotePower — the remote-input parser --------------------------
{
  const h = setup();
  const rt = makeRuntime();
  h.runtimes.set('console1', rt);
  const pwr = makeBtn();
  h.registry.consoleObjs.set('console1', { userData: { powerBtn: pwr } });

  h.pm._applyRemotePower('power:console:console1', null);
  ok(h.registry.isConsoleOn('console1') === true && h.counts().routed === 0, 'a null value is ignored');
  h.pm._applyRemotePower('power:console:console1', undefined);
  ok(h.counts().routed === 0, 'an undefined value is ignored');
  h.pm._applyRemotePower('power:console', { on: false });
  ok(h.counts().routed === 0, 'a key with no second separator is ignored');
  h.pm._applyRemotePower('power:bogus:x', { on: false });
  ok(h.counts().routed === 0, 'an unknown kind is ignored');

  h.pm._applyRemotePower('power:console:console1', { on: false });
  ok(h.registry.isConsoleOn('console1') === false, 'a remote off is applied');
  ok(rt.calls.join(',') === 'pause', 'the remote off paused the core');
  ok(pwr.labels.join(',') === 'OFF', 'the physical switch on the console object was tinted');
  ok(h.getNet().states.length === 0,
    'applying a remote state NEVER re-broadcasts (only the toggling peer broadcasts)');

  const routedAfterApply = h.counts().routed;
  h.pm._applyRemotePower('power:console:console1', { on: false });
  ok(h.counts().routed === routedAfterApply, 'an already-matching state is a no-op, not a re-route');
}

// --- 12. _applyRemotePower for a TV resolves the switch through the scene ------
{
  const h = setup();
  const pwr = makeBtn();
  h.tvs.set('tv0', { group: { userData: { powerBtn: pwr } } });
  h.pm._applyRemotePower('power:tv:tv0', { on: false });
  ok(h.registry.isTvOn('tv0') === false, 'a remote tv off is applied');
  ok(pwr.labels.join(',') === 'OFF', 'the TV switch was tinted via scene.getTV()');
  h.pm._applyRemotePower('power:tv:missing', { on: false });
  ok(h.registry.isTvOn('missing') === false, 'a TV with no scene object still tracks state (no throw)');
}

// --- 13. A broadcast round-trips through the parser ---------------------------
// The strongest guard on the key format: whatever _broadcastPower emits must be
// something isPowerStateKey accepts and _applyRemotePower can decode back.
{
  const a = setup();
  const b = setup();
  a.pm._broadcastPower('console', 'console7', false);
  a.pm._broadcastPower('tv', 'tv3', false);
  for (const [k, v] of a.getNet().states) {
    ok(b.pm.isPowerStateKey(k), `${k} is classified as a power key`);
    b.pm._applyRemotePower(k, v);
  }
  ok(b.registry.isConsoleOn('console7') === false, 'the peer decoded the console toggle');
  ok(b.registry.isTvOn('tv3') === false, 'the peer decoded the tv toggle');
}

// --- 14. addConsoleControls: mounts, wires, and is idempotent -----------------
{
  const h = setup();
  h.runtimes.set('console0', makeRuntime());
  const conObj = { userData: {}, children: [], add(o) { this.children.push(o); } };
  h.pm.addConsoleControls('console0', conObj);
  ok(conObj.children.length === 2, 'a power switch and a reset button were mounted');
  ok(!!conObj.userData.powerBtn && !!conObj.userData.resetBtn,
    'both are stashed on userData so a load can keep the tint in sync and the wire can flash RESET');
  ok(h.getMenu().items.size === 2,
    'both were registered with MenuMgr — the same raycast that drives the menu activates them');

  h.pm.addConsoleControls('console0', conObj);
  ok(conObj.children.length === 2, 'a second call mounts nothing (the _hasControls guard)');

  // Fire the power item exactly as a VR trigger / desktop left-click would.
  h.getMenu().items.get(conObj.userData.powerBtn)();
  ok(h.registry.isConsoleOn('console0') === false, 'clicking the switch powered the console off');
  ok(h.getNet().states[0][0] === 'power:console:console0', 'and synced it to the room');
  h.getMenu().items.get(conObj.userData.resetBtn)();
  ok(h.getNet().wires[0][0] === 'reset', 'clicking RESET synced a reset to the room');
}

// --- 15. addConsoleControls before MenuMgr exists ------------------------------
// menuMgr is null until buildCartridgeWorld runs. The early call must be a clean
// no-op that does NOT set _hasControls, or the console would be left switchless
// forever once the menu does arrive.
{
  const h = setup({ menuMgr: null });
  const conObj = { userData: {}, children: [], add(o) { this.children.push(o); } };
  h.pm.addConsoleControls('console0', conObj);
  ok(conObj.children.length === 0, 'no menuMgr → nothing mounted');
  ok(conObj.userData._hasControls === undefined, 'and the guard flag was NOT burned');
  h.setMenu(makeMenu());
  h.pm.addConsoleControls('console0', conObj);
  ok(conObj.children.length === 2, 'the retry after menuMgr exists mounts the controls');
  h.pm.addConsoleControls('console0', null);
  ok(h.getMenu().items.size === 2, 'a null console object is a no-op');
}

// --- 16. addTvControls ---------------------------------------------------------
{
  const h = setup();
  const tv = { group: { userData: {}, children: [], add(o) { this.children.push(o); } } };
  h.pm.addTvControls('tv0', tv);
  ok(tv.group.children.length === 1, 'one power switch on the TV (no reset button)');
  ok(tv.group.userData.powerBtn === tv.group.children[0], 'stashed for later tinting');
  h.pm.addTvControls('tv0', tv);
  ok(tv.group.children.length === 1, 'idempotent');
  h.getMenu().items.get(tv.group.userData.powerBtn)();
  ok(h.registry.isTvOn('tv0') === false, 'clicking it powered the TV off');
  ok(h.getNet().states[0][0] === 'power:tv:tv0', 'and synced it to the room');
  let threw = false;
  try { h.pm.addTvControls('tvX', null); h.pm.addTvControls('tvX', {}); } catch { threw = true; }
  ok(!threw, 'a missing TV / missing group is a no-op');
}

console.log(`test-powermgr: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
