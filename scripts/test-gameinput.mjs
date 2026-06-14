// Unit tests for src/GameInputMgr.js — console-aware input routing.
// Uses fakes (no browser/WebXR runtime needed).
//
// Run standalone:  node scripts/test-gameinput.mjs
// Or via npm test: wired into package.json test chain.

import { GameInputMgr } from '../src/GameInputMgr.js';

let pass = 0, fail = 0;
const ok  = (name, cond) => { if (cond) { pass++; } else { fail++; console.error(`FAIL  ${name}`); } };
const eq  = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`,
  JSON.stringify(got) === JSON.stringify(want));

// ---------------------------------------------------------------------------
// Fake helpers
// ---------------------------------------------------------------------------

/** Build a fake XR controller object. buttons[i] are {pressed:bool}; axes[4]. */
function fakeCtrl(buttons = [], axes = [0, 0, 0, 0]) {
  const fullButtons = Array.from({ length: 8 }, (_, i) => ({
    pressed: !!(buttons[i]?.pressed),
    value: buttons[i]?.value ?? 0,
  }));
  return {
    userData: {
      handedness: 'right',
      inputSource: {
        gamepad: {
          buttons: fullButtons,
          axes,
        },
      },
    },
  };
}

/** Press button at index `idx` on a fake controller. */
function withButton(idx) {
  const btns = [];
  btns[idx] = { pressed: true };
  return fakeCtrl(btns);
}

/** A fake dispatch recorder: stores [{consoleId, type, code}]. */
function makeDispatch() {
  const log = [];
  const fn = (consoleId, type, code) => log.push({ consoleId, type, code });
  fn.log = log;
  fn.clear = () => { log.length = 0; };
  return fn;
}

/** Find log entries matching a predicate. */
function find(log, pred) { return log.filter(pred); }

// ---------------------------------------------------------------------------
// Test 1: Single console — faceA (button 4) → keydown to console0; release → keyup
// ---------------------------------------------------------------------------
console.log('--- T1: single console, faceA press → keydown to console0 ---');
{
  const dispatch = makeDispatch();

  // Controller holding faceA (button index 4).
  const ctrlA = withButton(4);
  const controllers = [ctrlA];

  const mgr = new GameInputMgr({
    controllers,
    isGamepadHeld: () => true,
    isControllerHoldingGamepad: (c) => c === ctrlA,
    dispatch,
    defaultConsoleId: 'console0',
    getRouting: () => [{ ctrl: ctrlA, consoleId: 'console0', player: 1, hand: 'holding' }],
  });

  mgr.tick();

  const downs = find(dispatch.log, e => e.type === 'keydown' && e.consoleId === 'console0');
  ok('T1: keydown dispatched to console0', downs.length > 0);
  ok('T1: keydown has a code string', typeof downs[0]?.code === 'string' && downs[0].code.length > 0);
  ok('T1: no keyup yet', find(dispatch.log, e => e.type === 'keyup').length === 0);

  // Release: controller no longer pressing faceA.
  ctrlA.userData.inputSource.gamepad.buttons[4].pressed = false;
  dispatch.clear();
  mgr.tick();

  const ups = find(dispatch.log, e => e.type === 'keyup' && e.consoleId === 'console0');
  ok('T1: keyup dispatched to console0 on release', ups.length > 0);
  ok('T1: no keydown after release', find(dispatch.log, e => e.type === 'keydown').length === 0);
}

// ---------------------------------------------------------------------------
// Test 2: Two consoles — same button pressed simultaneously, no collision
// ---------------------------------------------------------------------------
console.log('--- T2: two consoles, same button, isolated per-console state ---');
{
  const dispatch = makeDispatch();

  const ctrlA = withButton(4); // faceA on console0
  const ctrlB = withButton(4); // faceA on console1

  const mgr = new GameInputMgr({
    controllers: [ctrlA, ctrlB],
    isGamepadHeld: () => true,
    isControllerHoldingGamepad: (c) => c === ctrlA,
    dispatch,
    defaultConsoleId: 'console0',
    getRouting: () => [
      { ctrl: ctrlA, consoleId: 'console0', player: 1, hand: 'holding' },
      { ctrl: ctrlB, consoleId: 'console1', player: 1, hand: 'holding' },
    ],
  });

  mgr.tick();

  const c0downs = find(dispatch.log, e => e.type === 'keydown' && e.consoleId === 'console0');
  const c1downs = find(dispatch.log, e => e.type === 'keydown' && e.consoleId === 'console1');
  ok('T2: keydown fired for console0', c0downs.length > 0);
  ok('T2: keydown fired for console1', c1downs.length > 0);
  ok('T2: both consoles got a code', c0downs[0]?.code === c1downs[0]?.code); // same logical btn → same code
  ok('T2: no keyups yet', find(dispatch.log, e => e.type === 'keyup').length === 0);

  // Drop ctrlB's routing (console1 no longer routed). console0 stays pressed.
  dispatch.clear();
  mgr.getRouting = () => [
    { ctrl: ctrlA, consoleId: 'console0', player: 1, hand: 'holding' },
  ];
  mgr.tick();

  const c1ups = find(dispatch.log, e => e.type === 'keyup' && e.consoleId === 'console1');
  const c0ups = find(dispatch.log, e => e.type === 'keyup' && e.consoleId === 'console0');
  ok('T2: console1 gets keyup when routing removed', c1ups.length > 0);
  ok('T2: console0 remains pressed (no keyup)', c0ups.length === 0);
  ok('T2: console0 has no spurious keydown', find(dispatch.log,
    e => e.type === 'keydown' && e.consoleId === 'console0').length === 0);
}

// ---------------------------------------------------------------------------
// Test 3: flushReleases() sends keyup to BOTH consoles
// ---------------------------------------------------------------------------
console.log('--- T3: flushReleases sends keyup to both consoles ---');
{
  const dispatch = makeDispatch();

  const ctrlA = withButton(4);
  const ctrlB = withButton(4);

  const mgr = new GameInputMgr({
    controllers: [ctrlA, ctrlB],
    isGamepadHeld: () => true,
    isControllerHoldingGamepad: (c) => c === ctrlA,
    dispatch,
    defaultConsoleId: 'console0',
    getRouting: () => [
      { ctrl: ctrlA, consoleId: 'console0', player: 1, hand: 'holding' },
      { ctrl: ctrlB, consoleId: 'console1', player: 1, hand: 'holding' },
    ],
  });

  mgr.tick(); // both pressed
  dispatch.clear();
  mgr.flushReleases();

  const c0ups = find(dispatch.log, e => e.type === 'keyup' && e.consoleId === 'console0');
  const c1ups = find(dispatch.log, e => e.type === 'keyup' && e.consoleId === 'console1');
  ok('T3: flushReleases emits keyup to console0', c0ups.length > 0);
  ok('T3: flushReleases emits keyup to console1', c1ups.length > 0);
  ok('T3: no keydowns during flush', find(dispatch.log, e => e.type === 'keydown').length === 0);
}

// ---------------------------------------------------------------------------
// Test 4: setRemoteButton with consoleId routes remote input correctly
// ---------------------------------------------------------------------------
console.log('--- T4: setRemoteButton({...consoleId}) routes to correct console ---');
{
  const dispatch = makeDispatch();
  const idleCtrl = fakeCtrl(); // no buttons pressed

  const mgr = new GameInputMgr({
    controllers: [idleCtrl],
    isGamepadHeld: () => false,
    isControllerHoldingGamepad: () => false,
    dispatch,
    defaultConsoleId: 'console0',
    getRouting: () => [],
  });

  // Remote player on console1 presses A.
  mgr.setRemoteButton({ player: 1, btn: 'A', down: true, consoleId: 'console1' });
  mgr.tick();

  const c1downs = find(dispatch.log, e => e.type === 'keydown' && e.consoleId === 'console1');
  const c0downs = find(dispatch.log, e => e.type === 'keydown' && e.consoleId === 'console0');
  ok('T4: remote keydown routed to console1', c1downs.length > 0);
  ok('T4: remote keydown not sent to console0', c0downs.length === 0);
  ok('T4: dispatched code is non-empty string', typeof c1downs[0]?.code === 'string' && c1downs[0].code.length > 0);

  // Release: down:false
  mgr.setRemoteButton({ player: 1, btn: 'A', down: false, consoleId: 'console1' });
  dispatch.clear();
  mgr.tick();

  const c1ups = find(dispatch.log, e => e.type === 'keyup' && e.consoleId === 'console1');
  ok('T4: remote keyup sent to console1 on release', c1ups.length > 0);
  ok('T4: no keyup to console0', find(dispatch.log, e => e.consoleId === 'console0').length === 0);
}

// ---------------------------------------------------------------------------
// Test 5: Back-compat — no `dispatch`, uses client.sendInput (N=1 path)
// ---------------------------------------------------------------------------
console.log('--- T5: back-compat N=1 — no dispatch, falls back to client.sendInput ---');
{
  const clientLog = [];
  const fakeClient = {
    sendInput: (...args) => clientLog.push(args),
  };

  const ctrlA = withButton(4); // faceA pressed

  const mgr = new GameInputMgr({
    controllers: [ctrlA],
    client: fakeClient,
    isGamepadHeld: () => true,
    isControllerHoldingGamepad: (c) => c === ctrlA,
    // No `dispatch` param — must fall back to client.sendInput
    getRouting: () => [{ ctrl: ctrlA, consoleId: 'console0', player: 1, hand: 'holding' }],
  });

  mgr.tick();

  ok('T5: client.sendInput was called (N=1 path)', clientLog.length > 0);
  ok('T5: first arg is event type string', clientLog[0]?.[0] === 'keydown');
  ok('T5: second arg is a code string', typeof clientLog[0]?.[1] === 'string' && clientLog[0][1].length > 0);
}

// ---------------------------------------------------------------------------
// Test 6: Default getRouting (no inject) uses defaultConsoleId — N=1 back-compat
// ---------------------------------------------------------------------------
console.log('--- T6: default getRouting injects defaultConsoleId into entries ---');
{
  const dispatch = makeDispatch();

  const ctrlA = withButton(4);
  const controllers = [ctrlA];

  // Use the DEFAULT getRouting (no injection) — it should use _defaultConsoleId.
  const mgr = new GameInputMgr({
    controllers,
    isGamepadHeld: () => true,
    isControllerHoldingGamepad: (c) => c === ctrlA,
    dispatch,
    defaultConsoleId: 'console0',
    // no getRouting injected
  });

  mgr.tick();

  const downs = find(dispatch.log, e => e.type === 'keydown' && e.consoleId === 'console0');
  ok('T6: default routing dispatches to defaultConsoleId', downs.length > 0);
}

// ---------------------------------------------------------------------------
// Test 7: onKeyDown receives consoleId as second argument
// ---------------------------------------------------------------------------
console.log('--- T7: onKeyDown(code, consoleId) — second arg is consoleId ---');
{
  const kd = [];
  const dispatch = makeDispatch();

  const ctrlA = withButton(4);

  const mgr = new GameInputMgr({
    controllers: [ctrlA],
    isGamepadHeld: () => true,
    isControllerHoldingGamepad: (c) => c === ctrlA,
    dispatch,
    defaultConsoleId: 'console0',
    onKeyDown: (code, consoleId) => kd.push({ code, consoleId }),
    getRouting: () => [{ ctrl: ctrlA, consoleId: 'console7', player: 1, hand: 'holding' }],
  });

  mgr.tick();

  ok('T7: onKeyDown fired', kd.length > 0);
  ok('T7: onKeyDown got consoleId as second arg', kd[0]?.consoleId === 'console7');
  ok('T7: onKeyDown got code as first arg', typeof kd[0]?.code === 'string');
}

// ---------------------------------------------------------------------------
// Test 8: Logical input M1.1 includes consoleId in emitted object
// ---------------------------------------------------------------------------
console.log('--- T8: _onLogicalInput includes consoleId in emitted object ---');
{
  const logicalEvents = [];
  const dispatch = makeDispatch();

  const ctrlA = withButton(4);

  const mgr = new GameInputMgr({
    controllers: [ctrlA],
    isGamepadHeld: () => true,
    isControllerHoldingGamepad: (c) => c === ctrlA,
    dispatch,
    defaultConsoleId: 'console0',
    onLogicalInput: (ev) => logicalEvents.push(ev),
    getRouting: () => [{ ctrl: ctrlA, consoleId: 'consoleX', player: 1, hand: 'holding' }],
  });

  mgr.tick();

  const downs = logicalEvents.filter(e => e.down === true);
  ok('T8: logical down event fired', downs.length > 0);
  ok('T8: logical event has consoleId', downs[0]?.consoleId === 'consoleX');
  ok('T8: logical event has player', typeof downs[0]?.player === 'number');
  ok('T8: logical event has btn', typeof downs[0]?.btn === 'string');

  // Release
  ctrlA.userData.inputSource.gamepad.buttons[4].pressed = false;
  mgr.tick();

  const ups = logicalEvents.filter(e => e.down === false);
  ok('T8: logical up event fired on release', ups.length > 0);
  ok('T8: logical up event has consoleId', ups[0]?.consoleId === 'consoleX');
}

// ---------------------------------------------------------------------------
// Test 9: clearRemote drops all remote keys; next tick emits keyups
// ---------------------------------------------------------------------------
console.log('--- T9: clearRemote() causes keyup on next tick ---');
{
  const dispatch = makeDispatch();

  const mgr = new GameInputMgr({
    controllers: [],
    isGamepadHeld: () => false,
    isControllerHoldingGamepad: () => false,
    dispatch,
    defaultConsoleId: 'console0',
    getRouting: () => [],
  });

  mgr.setRemoteButton({ player: 1, btn: 'B', down: true, consoleId: 'console0' });
  mgr.tick(); // keydown sent
  dispatch.clear();

  mgr.clearRemote();
  mgr.tick(); // should send keyup

  const ups = find(dispatch.log, e => e.type === 'keyup' && e.consoleId === 'console0');
  ok('T9: clearRemote causes keyup on next tick', ups.length > 0);
}

// ---------------------------------------------------------------------------
// Test 10: getDebugState pressedKeys shows bare codes (not composite keys)
// ---------------------------------------------------------------------------
console.log('--- T10: getDebugState pressedKeys are bare codes (no consoleId prefix) ---');
{
  const dispatch = makeDispatch();
  const ctrlA = withButton(4);

  const mgr = new GameInputMgr({
    controllers: [ctrlA],
    isGamepadHeld: () => true,
    isControllerHoldingGamepad: (c) => c === ctrlA,
    dispatch,
    defaultConsoleId: 'console0',
    getRouting: () => [{ ctrl: ctrlA, consoleId: 'console0', player: 1, hand: 'holding' }],
  });

  mgr.tick();

  const dbg = mgr.getDebugState();
  ok('T10: getDebugState returns non-null', dbg !== null);
  ok('T10: pressedKeys is an array', Array.isArray(dbg.pressedKeys));
  ok('T10: pressedKeys is non-empty after press', dbg.pressedKeys.length > 0);
  // No bare code should contain a space (which would indicate a composite key leaked through).
  const allBare = dbg.pressedKeys.every(c => !c.startsWith('console'));
  ok('T10: pressedKeys entries are bare codes (no consoleId prefix)', allBare);
  ok('T10: getDebugState has system field', typeof dbg.system === 'string');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
