// Headless integration test for local-multiplayer input routing.
//
// This is the scriptable half of the "VR controller routing" smoke test: a real
// headset is only needed to produce live XR gamepads, but the decision a pressed
// button makes — which player's RetroPad keys reach the emulator — is pure logic.
// Here we wire the REAL [[src/CableMgr.js]] + [[src/Routing.js]] + [[src/
// GameInputMgr.js]] together with mock controllers/gamepads and a recording
// client, then assert: the right player gets the right keys, with zero cross-talk
// between pads, and presses lift cleanly on release.
//
// What still needs a headset (NOT covered here): that the Quest actually exposes
// one inputSource.gamepad per held controller, and the raycast menus.

import { CableMgr } from '../src/CableMgr.js';
import { computeRouting } from '../src/Routing.js';
// Routing's playerOf accessor returns { consoleId, player } | null (null when a
// pad is unplugged) — the multi-console contract. CableMgr is single-console, so
// adapt it: a plugged pad maps to console0 + (port+1); an unplugged one to null.
const seatOf = (cable, id) => {
  const p = cable.portOf(id);
  return p == null ? null : { consoleId: 'console0', player: p + 1 };
};
import { GameInputMgr } from '../src/GameInputMgr.js';
import { RETROPAD_KEYS, EXTRA_PLAYER_KEYS, mapForSystem } from '../src/ControllerMaps.js';

let passed = 0;
let failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } };
const eqSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// --- mocks -----------------------------------------------------------------

// A controller exposing one XR-style gamepad (6 buttons, 4 axes), like the
// Quest's inputSource.gamepad. Helpers flip a button / nudge a stick axis.
function mockController(handedness) {
  const gamepad = {
    buttons: Array.from({ length: 6 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0, 0, 0],
  };
  return {
    userData: { handedness, inputSource: { gamepad } },
    press(i)   { gamepad.buttons[i] = { pressed: true, value: 1 }; },
    release(i) { gamepad.buttons[i] = { pressed: false, value: 0 }; },
    stick(x, y) { gamepad.axes[2] = x; gamepad.axes[3] = y; },
  };
}
// Button indices GameInputMgr reads: 0=trigger, 3=stickClick, 4=faceA, 5=faceB.
const FACE_A = 4;
const FACE_B = 5;

const gamepadObj = (cableId) => ({ userData: { kind: 'gamepad', cableId } });

// Mock grab state: which controller holds which object.
function mockGrab() {
  const held = new Map(); // ctrl -> object
  return {
    held,
    hold(ctrl, obj) { held.set(ctrl, obj); },
    drop(ctrl) { held.delete(ctrl); },
    heldObject: (ctrl) => held.get(ctrl) || null,
    isControllerFree: (ctrl) => !held.has(ctrl),
  };
}

// Recording emulator client: capture every sendInput so we can assert keydowns.
function recordingClient() {
  const events = [];
  return {
    events,
    sendInput(type, code) { events.push({ type, code }); },
    keydownCodes() { return new Set(events.filter((e) => e.type === 'keydown').map((e) => e.code)); },
    keyupCodes() { return new Set(events.filter((e) => e.type === 'keyup').map((e) => e.code)); },
    clear() { events.length = 0; },
  };
}

// Build a GameInputMgr bound to a cable + grab via the REAL Routing.computeRouting.
// onLogicalInput (optional) records the M1.1 client→host logical transitions.
function rig({ controllers, cable, grab, system, onLogicalInput }) {
  const client = recordingClient();
  const gim = new GameInputMgr({
    controllers,
    client,
    isControllerHoldingGamepad: (ctrl) => grab.heldObject(ctrl)?.userData?.kind === 'gamepad',
    isGamepadHeld: () => [...grab.held.values()].some((o) => o.userData?.kind === 'gamepad'),
    getRouting: () => computeRouting({
      controllers,
      heldObject: grab.heldObject,
      isControllerFree: grab.isControllerFree,
      playerOf: (id) => seatOf(cable, id),
    }),
    onLogicalInput,
  });
  gim.setSystem(system);
  return { gim, client };
}

// === 1. Routing policy: one held gamepad → both hands drive its player =======
{
  const cable = new CableMgr();
  cable.plug('gp-1', 0); // port 0 → player 1
  const grab = mockGrab();
  const right = mockController('right');
  const left = mockController('left');
  grab.hold(right, gamepadObj('gp-1')); // right hand holds the pad, left is free

  const routing = computeRouting({
    controllers: [right, left],
    heldObject: grab.heldObject,
    isControllerFree: grab.isControllerFree,
    playerOf: (id) => seatOf(cable, id),
  });
  ok(routing.length === 2, '1 held pad routes both hands');
  ok(routing.every((r) => r.player === 1), 'both hands drive player 1');
  ok(routing.find((r) => r.ctrl === right)?.hand === 'holding', 'holding hand tagged holding');
  ok(routing.find((r) => r.ctrl === left)?.hand === 'free', 'free hand tagged free');
}

// === 2. No held gamepad → no routing, no input ==============================
{
  const cable = new CableMgr();
  const grab = mockGrab();
  const c = mockController('right');
  const { gim, client } = rig({ controllers: [c], cable, grab, system: 'snes' });
  c.press(FACE_A); // pressing with nothing held must do nothing
  gim.tick();
  ok(computeRouting({ controllers: [c], heldObject: grab.heldObject, isControllerFree: grab.isControllerFree, playerOf: (id) => seatOf(cable, id) }).length === 0, 'no held pad → empty routing');
  ok(client.keydownCodes().size === 0, 'no input dispatched when nothing is held');
}

// === 3. Two pads, two ports: each player gets ONLY its own keys (no crosstalk)
{
  const cable = new CableMgr();
  cable.plug('gp-1', 0); // player 1
  cable.plug('gp-2', 1); // player 2
  const grab = mockGrab();
  const padA = mockController('right'); // → player 1
  const padB = mockController('left');  // → player 2
  grab.hold(padA, gamepadObj('gp-1'));
  grab.hold(padB, gamepadObj('gp-2'));
  const { gim, client } = rig({ controllers: [padA, padB], cable, grab, system: 'snes' });

  // SNES holding map: faceA→logical A, faceB→logical B.
  padA.press(FACE_A); // P1 presses A
  padB.press(FACE_B); // P2 presses B
  gim.tick();

  const got = client.keydownCodes();
  const expected = new Set([
    ...RETROPAD_KEYS.A,            // P1 A → ['KeyH','KeyX'] (double-dispatch)
    EXTRA_PLAYER_KEYS[2].B,        // P2 B → 'Digit6'
  ]);
  ok(eqSet(got, expected), `two-pad dispatch is exactly P1.A + P2.B (got ${[...got].join(',')})`);
  ok(!got.has(EXTRA_PLAYER_KEYS[2].A), 'P2 did NOT receive P1\'s A press (no crosstalk A→P2)');
  ok(!RETROPAD_KEYS.B.some((c) => got.has(c)), 'P1 did NOT receive P2\'s B press (no crosstalk B→P1)');
}

// === 4. Port index determines the player (port 1 → player 2 keys) ===========
{
  const cable = new CableMgr();
  cable.plug('gp-1', 1); // SAME pad, but plugged into port 1 → player 2
  const grab = mockGrab();
  const pad = mockController('right');
  grab.hold(pad, gamepadObj('gp-1'));
  const { gim, client } = rig({ controllers: [pad], cable, grab, system: 'snes' });

  pad.press(FACE_A); // logical A
  gim.tick();
  const got = client.keydownCodes();
  ok(got.has(EXTRA_PLAYER_KEYS[2].A), 'pad in port 1 dispatches player-2 keys');
  ok(!RETROPAD_KEYS.A.some((c) => got.has(c)), 'pad in port 1 does NOT dispatch player-1 keys');
}

// === 5. Stick direction routes to the holding player too ====================
{
  const cable = new CableMgr();
  cable.plug('gp-2', 1); // player 2
  const grab = mockGrab();
  const pad = mockController('left');
  grab.hold(pad, gamepadObj('gp-2'));
  const { gim, client } = rig({ controllers: [pad], cable, grab, system: 'nes' });

  pad.stick(0, -1); // full up (axis 3 ≤ -0.55) → logical Up
  gim.tick();
  ok(client.keydownCodes().has(EXTRA_PLAYER_KEYS[2].Up), 'player-2 stick-up dispatches player-2 Up key');
}

// === 6. Release lifts the keys (keyup for everything pressed) ================
{
  const cable = new CableMgr();
  cable.plug('gp-1', 0);
  const grab = mockGrab();
  const pad = mockController('right');
  grab.hold(pad, gamepadObj('gp-1'));
  const { gim, client } = rig({ controllers: [pad], cable, grab, system: 'snes' });

  pad.press(FACE_A);
  gim.tick();
  const downs = client.keydownCodes();
  pad.release(FACE_A);
  gim.tick();
  const ups = client.keyupCodes();
  ok(downs.size > 0 && eqSet(ups, downs), 'releasing the button lifts exactly the keys it pressed');
}

// === M1.1: networked client forwards LOGICAL transitions to the host =========
// A non-host captures its controller as logical RetroPad buttons (pre-keycode)
// and emits one event per press/release — that's what main.js relays to the host.
{
  const cable = new CableMgr();
  cable.plug('gp-1', 0); // player 1
  const grab = mockGrab();
  const pad = mockController('right');
  grab.hold(pad, gamepadObj('gp-1'));
  const logical = [];
  const { gim } = rig({ controllers: [pad], cable, grab, system: 'snes', onLogicalInput: (e) => logical.push(e) });

  pad.press(FACE_A);   // SNES holding map: faceA → logical 'A'
  gim.tick();
  pad.stick(0, -1);    // full up → logical 'Up'
  gim.tick();
  pad.release(FACE_A); // logical 'A' up
  gim.tick();
  pad.stick(0, 0);     // stick recentred → logical 'Up' up
  gim.tick();

  ok(logical.some((e) => e.player === 1 && e.btn === 'A' && e.down === true), 'client emits A press as a logical down');
  ok(logical.some((e) => e.player === 1 && e.btn === 'Up' && e.down === true), 'client emits stick-up as a logical Up down');
  ok(logical.some((e) => e.player === 1 && e.btn === 'A' && e.down === false), 'client emits A release as a logical up');
  ok(logical.some((e) => e.player === 1 && e.btn === 'Up' && e.down === false), 'client emits stick-recentre as a logical Up up');
  // Edge-triggered: one down + one up per button, no repeats while held.
  const aDowns = logical.filter((e) => e.btn === 'A' && e.down === true).length;
  ok(aDowns === 1, `A press is sent exactly once, not every frame (got ${aDowns})`);
}

// === M1.1: host injects a remote player's logical button into its core =======
// setRemoteButton resolves the remote player's key code(s); the next tick()
// dispatches them on the host's client exactly like a local press.
{
  const grab = mockGrab(); // host holds nothing locally
  const { gim, client } = rig({ controllers: [], cable: new CableMgr(), grab, system: 'snes' });

  gim.setRemoteButton({ player: 2, btn: 'A', down: true });
  gim.tick();
  ok(client.keydownCodes().has(EXTRA_PLAYER_KEYS[2].A), 'host injects remote P2 A as a keydown');

  client.clear();
  gim.tick(); // still held → must NOT be lifted by the local keyup sweep
  ok(client.keyupCodes().size === 0, 'a still-held remote key is not lifted by the local sweep');

  client.clear();
  gim.setRemoteButton({ player: 2, btn: 'A', down: false });
  gim.tick();
  ok(client.keyupCodes().has(EXTRA_PLAYER_KEYS[2].A), 'releasing the remote button lifts the key');
}

// === M1.1: remote (P2) and local (P1) inputs coexist with no crosstalk =======
{
  const cable = new CableMgr();
  cable.plug('gp-1', 0); // local pad → player 1
  const grab = mockGrab();
  const pad = mockController('right');
  grab.hold(pad, gamepadObj('gp-1'));
  const { gim, client } = rig({ controllers: [pad], cable, grab, system: 'snes' });

  pad.press(FACE_A);                                  // local P1 A
  gim.setRemoteButton({ player: 2, btn: 'B', down: true }); // remote P2 B
  gim.tick();

  const got = client.keydownCodes();
  ok(RETROPAD_KEYS.A.every((c) => got.has(c)), 'local P1 A still dispatched alongside a remote input');
  ok(got.has(EXTRA_PLAYER_KEYS[2].B), 'remote P2 B dispatched alongside the local input');
  ok(!got.has(EXTRA_PLAYER_KEYS[2].A), 'remote injection did not leak P1\'s button onto P2');
}

// === clearRemote: setRemoteButton(down) → clearRemote() → keyup emitted =======
// Mirrors the onPeerLeave use-case: a remote peer disconnects mid-keypress; the
// host calls clearRemote() which causes the next tick() to lift all latched keys.
{
  const grab = mockGrab();
  const { gim, client } = rig({ controllers: [], cable: new CableMgr(), grab, system: 'snes' });

  // Remote P2 holds button A down.
  gim.setRemoteButton({ player: 2, btn: 'A', down: true });
  gim.tick();
  ok(client.keydownCodes().has(EXTRA_PLAYER_KEYS[2].A), 'remote P2 A latched via setRemoteButton');

  client.clear();
  // Simulate peer disconnecting: clearRemote drops all remote state.
  gim.clearRemote();
  ok([...gim._remoteDesired].length === 0, 'clearRemote empties _remoteDesired immediately');

  // Next tick should emit the keyup (the normal sweep sees it was pressed, now absent).
  gim.tick();
  ok(client.keyupCodes().has(EXTRA_PLAYER_KEYS[2].A), 'clearRemote → next tick emits keyup (no latch)');
  ok(client.keydownCodes().size === 0, 'no spurious keydown after clearRemote');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
