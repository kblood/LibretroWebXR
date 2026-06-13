// Unit tests for src/net/SessionUtils.js — pure helpers, no DOM, no THREE.
// Run: node scripts/test-session.mjs
// Exit 0 = all pass, 1 = any failure.

import { sanitiseRoom, randomRoomSuffix } from '../src/net/SessionUtils.js';

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
