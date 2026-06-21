// Unit tests for the light-gun port-binding sync helpers ([[src/net/GunSync.js]]).
// Pure logic only — no THREE / no socket / no DOM.
// Run: node scripts/test-gun-sync.mjs   Exit 0 = pass, 1 = any failure.

import {
  GUN_STATE_PREFIX,
  makeGunStateKey,
  isGunStateKey,
  cableIdFromGunStateKey,
  makePeerGunId,
  parseGunEntries,
} from '../src/net/GunSync.js';
import { isGamepadStateKey } from '../src/net/GamepadSync.js';

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
  ok(GUN_STATE_PREFIX === 'gun:', 'prefix is gun:');
  ok(makeGunStateKey('gun-1') === 'gun:gun-1', 'makeGunStateKey(gun-1)');
  ok(makeGunStateKey('gun-abc-2') === 'gun:gun-abc-2', 'makeGunStateKey with peer id');
  ok(isGunStateKey('gun:gun-1'), 'isGunStateKey recognises gun: prefix');
  ok(!isGunStateKey('gamepad:gp-1'), 'isGunStateKey rejects gamepad: prefix');
  ok(!isGunStateKey('hold:gp:gp-1'), 'isGunStateKey rejects hold: prefix');
  ok(!isGunStateKey('tv'), 'isGunStateKey rejects tv');
  ok(!isGunStateKey(null), 'isGunStateKey rejects null');
  ok(cableIdFromGunStateKey('gun:gun-1') === 'gun-1', 'cableIdFromGunStateKey extracts gun-1');
  ok(cableIdFromGunStateKey('gamepad:gp-1') === null, 'cableIdFromGunStateKey rejects non-gun key');
}

// ---------------------------------------------------------------------------
// 2. Channels do NOT collide — a gun key is not a gamepad key and vice-versa.
//    This is load-bearing: the gun mesh rides prop:*, only its port rides gun:*,
//    so the gamepad existence reconciler must never see a gun key.
// ---------------------------------------------------------------------------
console.log('--- channel isolation');
{
  ok(!isGamepadStateKey('gun:gun-1'), 'gamepad reconciler ignores a gun: key');
  ok(!isGunStateKey('gamepad:gp-1'), 'gun reconciler ignores a gamepad: key');
}

// ---------------------------------------------------------------------------
// 3. Peer id scheme — globally unique + sanitised
// ---------------------------------------------------------------------------
console.log('--- peer id');
{
  ok(makePeerGunId('abc', 3) === 'gun-abc-3', 'makePeerGunId basic');
  ok(makePeerGunId('a:b c', 1) === 'gun-a_b_c-1', 'makePeerGunId sanitises colons/spaces');
  ok(makePeerGunId('p1', 1) !== makePeerGunId('p2', 1), 'different peers → different ids');
}

// ---------------------------------------------------------------------------
// 4. parseGunEntries — only numeric-port gun keys survive
// ---------------------------------------------------------------------------
console.log('--- parseGunEntries');
{
  const entries = [
    ['gun:gun-1', { port: 1 }],
    ['gun:gun-host-2', { port: 0 }],
    ['gun:gun-stale', null],            // cleared on disconnect → skipped
    ['gun:gun-bad', { foo: 1 }],        // no numeric port → skipped
    ['gun:gun-unplugged', { port: -1 }],// unplugged is still a valid binding
    ['gamepad:gp-1', { port: 0 }],      // other channel → skipped
    ['prop:lightgun-1', { type: 'lightgun' }], // mesh sync → skipped
    ['tv', { on: true }],
  ];
  const out = parseGunEntries(entries);
  const byId = Object.fromEntries(out.map((e) => [e.cableId, e.port]));
  ok(out.length === 3, `3 valid gun entries (got ${out.length})`);
  ok(byId['gun-1'] === 1, 'gun-1 → port 1');
  ok(byId['gun-host-2'] === 0, 'gun-host-2 → port 0');
  ok(byId['gun-unplugged'] === -1, 'gun-unplugged → port -1');
  ok(!('gun-stale' in byId), 'null entry skipped');
  ok(!('gun-bad' in byId), 'non-numeric port skipped');
  ok(!('gp-1' in byId), 'gamepad key skipped');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
