// Unit tests for the shared-light-gun sync layer — pure logic in
// [[src/GhostLightGunMgr.js]] and [[src/net/HoldState.js]] (the gun: namespace).
// No THREE rendering / no socket / no DOM — runs in `npm test`.
// Mirrors scripts/test-gamepad-share.mjs.

import {
  makeGunHoldKey,
  isGunHoldKey,
  cableIdFromGunHoldKey,
} from '../src/GhostLightGunMgr.js';
import { makeHoldKey, isHoldKey, parseHolds } from '../src/net/HoldState.js';
import { makeGunStateKey } from '../src/net/GunSync.js';

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
  ok(makeGunHoldKey('gun-1') === 'hold:gun:gun-1', 'makeGunHoldKey produces hold:gun:<cableId>');
  ok(makeGunHoldKey('gun-alice-2') === 'hold:gun:gun-alice-2', 'makeGunHoldKey gun-alice-2');
  ok(isGunHoldKey('hold:gun:gun-1'), 'isGunHoldKey recognises a gun hold key');
  ok(!isGunHoldKey('hold:gp:gp-1'), 'isGunHoldKey rejects gamepad hold key');
  ok(!isGunHoldKey('hold:pong.nes'), 'isGunHoldKey rejects cart hold key');
  ok(!isGunHoldKey('tv'), 'isGunHoldKey rejects tv key');
  ok(!isGunHoldKey(null), 'isGunHoldKey rejects null');
  ok(cableIdFromGunHoldKey('hold:gun:gun-1') === 'gun-1', 'cableIdFromGunHoldKey extracts gun-1');
  ok(cableIdFromGunHoldKey('hold:gun:gun-alice-2') === 'gun-alice-2', 'cableIdFromGunHoldKey extracts gun-alice-2');
  ok(cableIdFromGunHoldKey('hold:pong.nes') === null, 'cableIdFromGunHoldKey returns null for non-gun key');
  ok(cableIdFromGunHoldKey(null) === null, 'cableIdFromGunHoldKey returns null for null');

  // Gun hold keys live in the hold: namespace, so Hub auto-clear applies.
  ok(isHoldKey(makeGunHoldKey('gun-1')), 'gun hold key lives in the hold: namespace (Hub auto-clears it)');
  ok(makeGunHoldKey('gun-1') !== makeHoldKey('gun-1'), 'gun hold key does not collide with a cart named gun-1');
  // Distinct from GunSync's bare port-binding channel (no hold: prefix).
  ok(makeGunHoldKey('gun-1') !== makeGunStateKey('gun-1'), 'gun hold key does not collide with the gun: port-binding key');
}

// ---------------------------------------------------------------------------
// 2. parseHolds filters gun hold entries correctly
// ---------------------------------------------------------------------------
console.log('--- parseHolds on gun holds');
{
  const entries = [
    ['tv', { file: 'g.nes' }],                                      // non-hold → ignored
    ['hold:pong.nes', { holder: 'alice', hand: 'left' }],           // cart hold → not a gun key
    ['hold:gp:gp-1', { holder: 'alice', hand: 'left' }],            // gamepad hold → not a gun key
    ['hold:gun:gun-1', { holder: 'alice', hand: 'right' }],         // gun hold by alice
    ['hold:gun:gun-2', { holder: 'self', hand: 'left' }],           // own hold → filtered by selfId
    ['hold:gun:gun-3', { holder: 'gone', hand: null }],             // stale holder
    ['hold:gun:gun-4', null],                                        // cleared → null value → ignored
  ];

  const gunEntriesAll = entries.filter(([k]) => isGunHoldKey(k));
  ok(gunEntriesAll.length === 4, 'filter keeps 4 gun entries (by key only, incl the null-value entry)');

  const holds = parseHolds(gunEntriesAll, { selfId: 'self', presentIds: new Set(['alice']) });
  ok(holds.length === 1, 'parseHolds keeps only the present non-self holder');
  ok(holds[0].objId === 'gun:gun-1', 'objId is gun:gun-1 (before final strip)');
  ok(holds[0].holder === 'alice', 'holder is alice');
  ok(holds[0].hand === 'right', 'hand is right');

  // Simulate the remap step (as in the main.js tick callback).
  const remapped = holds.map((h) => ({
    ...h,
    objId: cableIdFromGunHoldKey(`hold:${h.objId}`) || h.objId,
  }));
  ok(remapped[0].objId === 'gun-1', 'objId remapped to cableId gun-1');
}

// ---------------------------------------------------------------------------
// 3. GhostLightGunMgr: isRemotelyHeld tracks holds correctly
// ---------------------------------------------------------------------------
console.log('--- GhostLightGunMgr: isRemotelyHeld');
{
  // Stub AvatarMgr for unit testing (no THREE rendering needed for the lock
  // predicate — we only call sync() and isRemotelyHeld()). getHand/getHead
  // return null so no ghost mesh is actually built, but _heldBy still updates.
  const stubAvatars = {
    getHand: () => null,
    getHead: () => null,
  };

  const { GhostLightGunMgr } = await import('../src/GhostLightGunMgr.js');
  const mgr = new GhostLightGunMgr({ avatars: stubAvatars, lightGunObjs: new Map() });

  ok(!mgr.isRemotelyHeld('gun-1'), 'initially nothing is held');
  ok(!mgr.isRemotelyHeld('gun-2'), 'initially gun-2 not held');

  mgr.sync([{ objId: 'gun-1', holder: 'alice', hand: 'right' }]);
  ok(mgr.isRemotelyHeld('gun-1'), 'gun-1 is remotely held after sync');
  ok(!mgr.isRemotelyHeld('gun-2'), 'gun-2 is still free');
  ok(mgr.heldBy('gun-1') === 'alice', 'heldBy returns alice');

  mgr.sync([]);
  ok(!mgr.isRemotelyHeld('gun-1'), 'gun-1 freed after release sync');
  ok(mgr.heldBy('gun-1') === null, 'heldBy returns null after release');

  // Two simultaneous holds by different peers (two-gun co-op).
  mgr.sync([
    { objId: 'gun-1', holder: 'alice', hand: 'left' },
    { objId: 'gun-2', holder: 'bob', hand: 'right' },
  ]);
  ok(mgr.isRemotelyHeld('gun-1'), 'gun-1 held by alice');
  ok(mgr.isRemotelyHeld('gun-2'), 'gun-2 held by bob');
  ok(!mgr.isRemotelyHeld('gun-3'), 'gun-3 still free');

  mgr.sync([{ objId: 'gun-2', holder: 'bob', hand: 'right' }]);
  ok(!mgr.isRemotelyHeld('gun-1'), 'gun-1 freed when alice releases');
  ok(mgr.isRemotelyHeld('gun-2'), 'gun-2 still held by bob');

  mgr.removeAll();
  ok(!mgr.isRemotelyHeld('gun-2'), 'gun-2 freed after removeAll');
  ok(mgr.ghostCount === 0, 'ghost count is 0 after removeAll');
}

// ---------------------------------------------------------------------------
// 4. GhostLightGunMgr: hides the real local gun while remotely held
// ---------------------------------------------------------------------------
console.log('--- hides/unhides the real local gun mesh');
{
  const stubAvatars = { getHand: () => null, getHead: () => null };
  const { GhostLightGunMgr } = await import('../src/GhostLightGunMgr.js');
  const fakeGun = { visible: true };
  const mgr = new GhostLightGunMgr({ avatars: stubAvatars, lightGunObjs: new Map([['gun-1', fakeGun]]) });

  mgr.sync([{ objId: 'gun-1', holder: 'alice', hand: 'right' }]);
  ok(fakeGun.visible === false, 'the real local gun is hidden once remotely held (even with no avatar hand yet)');

  mgr.sync([]);
  ok(fakeGun.visible === true, 'the real local gun reappears once the remote hold clears');
}

// ---------------------------------------------------------------------------
// 5. Key namespace does not collide with cart/gamepad holds
// ---------------------------------------------------------------------------
console.log('--- namespace isolation');
{
  const cartKey = makeHoldKey('gun-1.nes');
  const gunKey = makeGunHoldKey('gun-1');
  ok(cartKey !== gunKey, 'cart and gun hold keys are distinct');
  ok(!isGunHoldKey(cartKey), 'cart key is not a gun key');
  ok(isHoldKey(gunKey), 'gun key IS a hold key (Hub auto-clears it)');
  ok(isHoldKey(cartKey), 'cart key is also a hold key');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
