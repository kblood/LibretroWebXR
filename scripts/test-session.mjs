// Unit tests for src/net/SessionUtils.js — pure helpers, no DOM, no THREE.
// Run: node scripts/test-session.mjs
// Exit 0 = all pass, 1 = any failure.

import { sanitiseRoom, randomRoomSuffix, spawnSeatOffset } from '../src/net/SessionUtils.js';

let passed = 0;
let failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
};
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; }
  else { failed++; console.error(`  FAIL: ${name}\n    got:  ${g}\n    want: ${w}`); }
};

// === sanitiseRoom ==========================================================
{
  // Valid names pass through unchanged (within 40 chars).
  eq('simple name',          sanitiseRoom('lobby'),            'lobby');
  eq('alphanumeric+dash',    sanitiseRoom('my-room-42'),       'my-room-42');
  eq('underscores',          sanitiseRoom('test_room'),        'test_room');
  eq('mixed case preserved', sanitiseRoom('MyRoom'),           'MyRoom');

  // Leading / trailing whitespace is stripped.
  eq('trims spaces',         sanitiseRoom('  lobby  '),        'lobby');

  // Special chars become dashes.
  eq('spaces become dashes', sanitiseRoom('hello world'),      'hello-world');
  eq('slashes become dashes',sanitiseRoom('room/1'),           'room-1');
  eq('multiple specials',    sanitiseRoom('a!!b##c'),          'a-b-c');

  // Leading/trailing dashes stripped after transformation.
  eq('no leading dash',      sanitiseRoom('  !!lobby'),        'lobby');
  eq('no trailing dash',     sanitiseRoom('lobby!!  '),        'lobby');

  // Truncation to 40 chars.
  const long = 'a'.repeat(50);
  ok(sanitiseRoom(long)?.length === 40, 'truncates to 40 chars');

  // Invalid / empty input returns null.
  eq('empty string → null',  sanitiseRoom(''),                 null);
  eq('blank string → null',  sanitiseRoom('   '),              null);
  eq('null → null',          sanitiseRoom(null),               null);
  eq('undefined → null',     sanitiseRoom(undefined),          null);
  eq('number → null',        sanitiseRoom(42),                 null);

  // Only special chars (all become dashes, then stripped) → null.
  eq('only specials → null', sanitiseRoom('!@#$'),             null);
}

// === randomRoomSuffix ======================================================
{
  const s = randomRoomSuffix();
  ok(typeof s === 'string',               'returns a string');
  ok(s.length === 4,                      'returns exactly 4 chars');
  ok(/^[a-z0-9]+$/.test(s),              'only lowercase alphanumeric');

  // Two calls should (almost certainly) differ — collision probability is 1/1296.
  const s2 = randomRoomSuffix();
  // We just check they're valid, not that they differ (flaky for pure randomness).
  ok(typeof s2 === 'string' && s2.length === 4, 'second call also valid');
}

// === spawnSeatOffset =======================================================
// The avatar-occlusion fix: every peer used to spawn on the room's origin, so a
// remote peer's head plane landed at the watcher's own camera and hid the TV.
{
  // Seat 0 (the room's senior peer / host) keeps the canonical origin, so solo
  // play and every single-peer expectation are untouched.
  eq('seat 0 = no offset', spawnSeatOffset(0), [0, 0, 0]);

  // Defensive: garbage in ⇒ the safe seat, never NaN into a THREE position.
  eq('negative index → seat 0', spawnSeatOffset(-3), [0, 0, 0]);
  eq('null → seat 0',           spawnSeatOffset(null), [0, 0, 0]);
  eq('NaN → seat 0',            spawnSeatOffset(NaN), [0, 0, 0]);
  eq('undefined → seat 0',      spawnSeatOffset(undefined), [0, 0, 0]);
  eq('fractional index floors', spawnSeatOffset(1.9), spawnSeatOffset(1));

  // THE POINT OF THE FIX: nobody after seat 0 stands on the origin.
  for (let i = 1; i <= 12; i++) {
    const [x, , z] = spawnSeatOffset(i);
    ok(Math.hypot(x, z) > 0.5, `seat ${i} is at least 0.5 m off the origin (got ${Math.hypot(x, z).toFixed(2)} m)`);
  }

  // …and no two of the first dozen seats coincide, or two joiners would still
  // occlude each other.
  const seen = new Map();
  for (let i = 0; i <= 12; i++) {
    const key = spawnSeatOffset(i).map((n) => n.toFixed(3)).join(',');
    ok(!seen.has(key), `seat ${i} does not collide with seat ${seen.get(key)}`);
    seen.set(key, i);
  }

  // Alternating sides, fanning out: odd left, even right.
  ok(spawnSeatOffset(1)[0] < 0, 'seat 1 goes left');
  ok(spawnSeatOffset(2)[0] > 0, 'seat 2 goes right');
  eq('seats 1 and 2 mirror', spawnSeatOffset(1)[0], -spawnSeatOffset(2)[0]);
  ok(Math.abs(spawnSeatOffset(3)[0]) > Math.abs(spawnSeatOffset(1)[0]), 'seat 3 sits further out than seat 1');
  ok(spawnSeatOffset(3)[2] > spawnSeatOffset(1)[2], 'later rings stand further back');

  // Pure + deterministic: the same index gives the same seat on every peer, which
  // is what lets two clients agree on where everyone is without negotiating.
  eq('deterministic', spawnSeatOffset(5), spawnSeatOffset(5));

  // Stay inside SceneMgr's 6 x 8 m room (rig home is z = 1.5, so |x| < 3 and
  // z < 2.5 keeps every seat off the walls).
  for (let i = 0; i <= 24; i++) {
    const [x, y, z] = spawnSeatOffset(i);
    ok(Math.abs(x) < 2.6 && z >= 0 && z < 2.4 && y === 0, `seat ${i} stays inside the room (${x}, ${y}, ${z})`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
