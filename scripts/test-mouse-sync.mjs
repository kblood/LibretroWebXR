// Unit tests for the in-world mouse port-binding sync helpers
// ([[src/net/MouseSync.js]]). Pure logic only — no THREE / no socket / no DOM.
// Run: node scripts/test-mouse-sync.mjs   Exit 0 = pass, 1 = any failure.

import {
  MOUSE_STATE_PREFIX,
  makeMouseStateKey,
  isMouseStateKey,
  cableIdFromMouseStateKey,
  makePeerMouseId,
  parseMouseEntries,
} from '../src/net/MouseSync.js';
import { isGamepadStateKey } from '../src/net/GamepadSync.js';
import { isGunStateKey } from '../src/net/GunSync.js';

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { failed++; console.error(`  FAIL: ${msg}`); } };

console.log('--- key helpers');
{
  ok(MOUSE_STATE_PREFIX === 'mouse:', 'prefix is mouse:');
  ok(makeMouseStateKey('mouse-1') === 'mouse:mouse-1', 'makeMouseStateKey(mouse-1)');
  ok(makeMouseStateKey('mouse-abc-2') === 'mouse:mouse-abc-2', 'makeMouseStateKey with peer id');
  ok(isMouseStateKey('mouse:mouse-1'), 'isMouseStateKey recognises mouse: prefix');
  ok(!isMouseStateKey('gun:gun-1'), 'isMouseStateKey rejects gun: prefix');
  ok(!isMouseStateKey('gamepad:gp-1'), 'isMouseStateKey rejects gamepad: prefix');
  ok(!isMouseStateKey('tv'), 'isMouseStateKey rejects tv');
  ok(!isMouseStateKey(null), 'isMouseStateKey rejects null');
  ok(cableIdFromMouseStateKey('mouse:mouse-1') === 'mouse-1', 'cableIdFromMouseStateKey extracts mouse-1');
  ok(cableIdFromMouseStateKey('gun:gun-1') === null, 'cableIdFromMouseStateKey rejects non-mouse key');
}

console.log('--- channel isolation (mouse vs gun vs gamepad)');
{
  ok(!isGamepadStateKey('mouse:mouse-1'), 'gamepad reconciler ignores a mouse: key');
  ok(!isGunStateKey('mouse:mouse-1'), 'gun reconciler ignores a mouse: key');
  ok(!isMouseStateKey('gun:gun-1'), 'mouse reconciler ignores a gun: key');
  ok(!isMouseStateKey('gamepad:gp-1'), 'mouse reconciler ignores a gamepad: key');
}

console.log('--- peer id');
{
  ok(makePeerMouseId('abc', 3) === 'mouse-abc-3', 'makePeerMouseId basic');
  ok(makePeerMouseId('a:b c', 1) === 'mouse-a_b_c-1', 'makePeerMouseId sanitises colons/spaces');
  ok(makePeerMouseId('p1', 1) !== makePeerMouseId('p2', 1), 'different peers → different ids');
}

console.log('--- parseMouseEntries');
{
  const entries = [
    ['mouse:mouse-1', { port: 1 }],
    ['mouse:mouse-host-2', { port: 0 }],
    ['mouse:mouse-stale', null],
    ['mouse:mouse-bad', { foo: 1 }],
    ['mouse:mouse-unplugged', { port: -1 }],
    ['gun:gun-1', { port: 0 }],
    ['gamepad:gp-1', { port: 0 }],
    ['prop:mouse-1', { type: 'mouse' }],
    ['tv', { on: true }],
  ];
  const out = parseMouseEntries(entries);
  const byId = Object.fromEntries(out.map((e) => [e.cableId, e.port]));
  ok(out.length === 3, `3 valid mouse entries (got ${out.length})`);
  ok(byId['mouse-1'] === 1, 'mouse-1 → port 1');
  ok(byId['mouse-host-2'] === 0, 'mouse-host-2 → port 0');
  ok(byId['mouse-unplugged'] === -1, 'mouse-unplugged → port -1');
  ok(!('mouse-stale' in byId), 'null entry skipped');
  ok(!('mouse-bad' in byId), 'non-numeric port skipped');
  ok(!('gun-1' in byId), 'gun key skipped');
  ok(!('gp-1' in byId), 'gamepad key skipped');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
