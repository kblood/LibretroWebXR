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
function rig({ controllers, cable, grab, system }) {
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
      playerOf: (id) => cable.playerOf(id),
    }),
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
    playerOf: (id) => cable.playerOf(id),
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
  ok(computeRouting({ controllers: [c], heldObject: grab.heldObject, isControllerFree: grab.isControllerFree, playerOf: (id) => cable.playerOf(id) }).length === 0, 'no held pad → empty routing');
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
