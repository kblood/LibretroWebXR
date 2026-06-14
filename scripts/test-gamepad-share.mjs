// Unit tests for the shared-gamepad sync layer — pure logic in
// [[src/GhostGamepadMgr.js]] and [[src/net/HoldState.js]] (the gp: namespace).
// No THREE / no socket / no DOM — runs in `npm test`.

import {
  makeGamepadHoldKey,
  isGamepadHoldKey,
  cableIdFromHoldKey,
} from '../src/GhostGamepadMgr.js';
import { makeHoldKey, isHoldKey, parseHolds } from '../src/net/HoldState.js';

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
};

// ---------------------------------------------------------------------------
// 1. Key helpers
// ---------------------------------------------------------------------------
console.log('--- key helpers');
{
  ok(makeGamepadHoldKey('gp-1') === 'hold:gp:gp-1', 'makeGamepadHoldKey produces hold:gp:<cableId>');
  ok(makeGamepadHoldKey('gp-2') === 'hold:gp:gp-2', 'makeGamepadHoldKey gp-2');
  ok(isGamepadHoldKey('hold:gp:gp-1'), 'isGamepadHoldKey recognises a gamepad hold key');
  ok(!isGamepadHoldKey('hold:pong.nes'), 'isGamepadHoldKey rejects cart hold key');
  ok(!isGamepadHoldKey('tv'), 'isGamepadHoldKey rejects tv key');
  ok(!isGamepadHoldKey(null), 'isGamepadHoldKey rejects null');
  ok(cableIdFromHoldKey('hold:gp:gp-1') === 'gp-1', 'cableIdFromHoldKey extracts gp-1');
  ok(cableIdFromHoldKey('hold:gp:gp-4') === 'gp-4', 'cableIdFromHoldKey extracts gp-4');
  ok(cableIdFromHoldKey('hold:pong.nes') === null, 'cableIdFromHoldKey returns null for non-gp key');
  ok(cableIdFromHoldKey(null) === null, 'cableIdFromHoldKey returns null for null');

  // Gamepad hold keys live in the hold: namespace, so Hub auto-clear applies.
  ok(isHoldKey(makeGamepadHoldKey('gp-1')), 'gamepad hold key lives in the hold: namespace (Hub auto-clears it)');
  ok(makeGamepadHoldKey('gp-1') !== makeHoldKey('gp-1'), 'gamepad hold key does not collide with a cart named gp-1');
}

// ---------------------------------------------------------------------------
// 2. parseHolds filters gamepad hold entries correctly
// ---------------------------------------------------------------------------
console.log('--- parseHolds on gamepad holds');
{
  const entries = [
    ['tv', { file: 'g.nes' }],                                      // non-hold → ignored
    ['hold:pong.nes', { holder: 'alice', hand: 'left' }],           // cart hold → not a gp key
    ['hold:gp:gp-1', { holder: 'alice', hand: 'right' }],          // gamepad hold by alice
    ['hold:gp:gp-2', { holder: 'self', hand: 'left' }],            // own hold → filtered by selfId
    ['hold:gp:gp-3', { holder: 'gone', hand: null }],              // stale holder
    ['hold:gp:gp-4', null],                                         // cleared → null value → ignored
  ];

  // Filter to gamepad entries only (simulates the tick callback filter).
  // The filter is key-based only; parseHolds handles null values internally.
  const gpEntriesAll = entries.filter(([k]) => isGamepadHoldKey(k));
  ok(gpEntriesAll.length === 4, 'filter keeps 4 gp entries (by key only, incl the null-value entry)');

  const holds = parseHolds(gpEntriesAll, { selfId: 'self', presentIds: new Set(['alice']) });
  ok(holds.length === 1, 'parseHolds keeps only the present non-self holder');
  ok(holds[0].objId === 'gp:gp-1', 'objId is gp:gp-1 (before final strip)');
  ok(holds[0].holder === 'alice', 'holder is alice');
  ok(holds[0].hand === 'right', 'hand is right');

  // Simulate the remap step (as in the main.js tick callback).
  const remapped = holds.map((h) => ({
    ...h,
    objId: cableIdFromHoldKey(`hold:${h.objId}`) || h.objId,
  }));
  ok(remapped[0].objId === 'gp-1', 'objId remapped to cableId gp-1');
}

// ---------------------------------------------------------------------------
// 3. GhostGamepadMgr: isRemotelyHeld tracks holds correctly
// ---------------------------------------------------------------------------
console.log('--- GhostGamepadMgr: isRemotelyHeld');
{
  // Stub AvatarMgr and gamepadObjs for unit testing (no THREE needed for the
  // lock predicate — we only call sync() and isRemotelyHeld()).
  const stubAvatars = {
    getHand: () => null,
    getHead: () => null,
  };

  // Import via dynamic import to avoid THREE at module evaluation time.
  // GhostGamepadMgr uses THREE for the mesh geometry but we can stub the
  // attach path by making getHead/getHand always return null (no ghost spawned,
  // but _heldBy is updated regardless, so isRemotelyHeld() works correctly).
  const { GhostGamepadMgr } = await import('../src/GhostGamepadMgr.js');
  const mgr = new GhostGamepadMgr({ avatars: stubAvatars, gamepadObjs: new Map() });

  ok(!mgr.isRemotelyHeld('gp-1'), 'initially nothing is held');
  ok(!mgr.isRemotelyHeld('gp-2'), 'initially gp-2 not held');

  // Sync with alice holding gp-1.
  mgr.sync([{ objId: 'gp-1', holder: 'alice', hand: 'right' }]);
  ok(mgr.isRemotelyHeld('gp-1'), 'gp-1 is remotely held after sync');
  ok(!mgr.isRemotelyHeld('gp-2'), 'gp-2 is still free');
  ok(mgr.heldBy('gp-1') === 'alice', 'heldBy returns alice');

  // Sync with alice releasing gp-1 (empty holds).
  mgr.sync([]);
  ok(!mgr.isRemotelyHeld('gp-1'), 'gp-1 freed after release sync');
  ok(mgr.heldBy('gp-1') === null, 'heldBy returns null after release');

  // Two simultaneous holds by different peers.
  mgr.sync([
    { objId: 'gp-1', holder: 'alice', hand: 'left' },
    { objId: 'gp-2', holder: 'bob', hand: 'right' },
  ]);
  ok(mgr.isRemotelyHeld('gp-1'), 'gp-1 held by alice');
  ok(mgr.isRemotelyHeld('gp-2'), 'gp-2 held by bob');
  ok(!mgr.isRemotelyHeld('gp-3'), 'gp-3 still free');

  // Remove alice's hold; bob's persists.
  mgr.sync([{ objId: 'gp-2', holder: 'bob', hand: 'right' }]);
  ok(!mgr.isRemotelyHeld('gp-1'), 'gp-1 freed when alice releases');
  ok(mgr.isRemotelyHeld('gp-2'), 'gp-2 still held by bob');

  // removeAll clears everything.
  mgr.removeAll();
  ok(!mgr.isRemotelyHeld('gp-2'), 'gp-2 freed after removeAll');
  ok(mgr.ghostCount === 0, 'ghost count is 0 after removeAll');
}

// ---------------------------------------------------------------------------
// 4. Key namespace does not collide with cart holds
// ---------------------------------------------------------------------------
console.log('--- namespace isolation');
{
  // A cart file could be named 'gp-1.nes' — its hold key must not be confused
  // with a gamepad hold.
  const cartKey = makeHoldKey('gp-1.nes');
  const gpKey = makeGamepadHoldKey('gp-1');
  ok(cartKey !== gpKey, 'cart and gamepad hold keys are distinct');
  ok(!isGamepadHoldKey(cartKey), 'cart key is not a gamepad key');
  ok(isHoldKey(gpKey), 'gamepad key IS a hold key (Hub auto-clears it)');
  ok(isHoldKey(cartKey), 'cart key is also a hold key');
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
