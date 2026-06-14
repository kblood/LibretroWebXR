// Unit tests for the gamepad existence sync helpers ([[src/net/GamepadSync.js]]).
// Pure logic only — no THREE / no socket / no DOM.

import {
  makeGamepadStateKey,
  isGamepadStateKey,
  cableIdFromStateKey,
  makePeerGamepadId,
  parseGamepadEntries,
  diffGamepadSync,
} from '../src/net/GamepadSync.js';

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
  ok(makeGamepadStateKey('gp-1') === 'gamepad:gp-1', 'makeGamepadStateKey(gp-1)');
  ok(makeGamepadStateKey('gp-abc-1') === 'gamepad:gp-abc-1', 'makeGamepadStateKey with peer id');
  ok(isGamepadStateKey('gamepad:gp-1'), 'isGamepadStateKey recognises gamepad: prefix');
  ok(!isGamepadStateKey('hold:gp:gp-1'), 'isGamepadStateKey rejects hold: prefix');
  ok(!isGamepadStateKey('tv'), 'isGamepadStateKey rejects tv');
  ok(!isGamepadStateKey(null), 'isGamepadStateKey rejects null');
  ok(cableIdFromStateKey('gamepad:gp-1') === 'gp-1', 'cableIdFromStateKey extracts gp-1');
  ok(cableIdFromStateKey('gamepad:gp-abc-3') === 'gp-abc-3', 'cableIdFromStateKey with peer id');
  ok(cableIdFromStateKey('hold:gp:gp-1') === null, 'cableIdFromStateKey returns null for hold key');
  ok(cableIdFromStateKey(null) === null, 'cableIdFromStateKey returns null for null');
}

// ---------------------------------------------------------------------------
// 2. makePeerGamepadId
// ---------------------------------------------------------------------------
console.log('--- makePeerGamepadId');
{
  ok(makePeerGamepadId('peer1', 1) === 'gp-peer1-1', 'basic peer id');
  ok(makePeerGamepadId('peer1', 2) === 'gp-peer1-2', 'counter increments');
  ok(makePeerGamepadId('peer2', 1) === 'gp-peer2-1', 'different peer');
  // Ids from different peers must be distinct even with same counter.
  ok(makePeerGamepadId('alice', 1) !== makePeerGamepadId('bob', 1), 'peer ids distinct');
  // Sanitises special chars.
  ok(/^gp-[a-zA-Z0-9_-]+-\d+$/.test(makePeerGamepadId('peer:with:colons', 1)),
    'colons in selfId are sanitised');
  ok(/^gp-[a-zA-Z0-9_-]+-\d+$/.test(makePeerGamepadId('peer with spaces', 1)),
    'spaces in selfId are sanitised');
}

// ---------------------------------------------------------------------------
// 3. parseGamepadEntries
// ---------------------------------------------------------------------------
console.log('--- parseGamepadEntries');
{
  const entries = [
    ['tv', { file: 'g.nes' }],                            // non-gamepad → ignored
    ['hold:gp:gp-1', { holder: 'alice', hand: 'right' }], // hold key → ignored
    ['gamepad:gp-alice-1', { port: 1 }],                  // valid gamepad entry
    ['gamepad:gp-bob-1', { port: 2 }],                    // valid gamepad entry
    ['gamepad:gp-stale', null],                            // null value → ignored
    ['gamepad:gp-bad', { noPort: 'x' }],                  // missing port → ignored
  ];

  const result = parseGamepadEntries(entries);
  ok(result.length === 2, `parseGamepadEntries returns 2 valid entries (got ${result.length})`);
  ok(result.some((r) => r.cableId === 'gp-alice-1' && r.port === 1), 'alice entry parsed');
  ok(result.some((r) => r.cableId === 'gp-bob-1' && r.port === 2), 'bob entry parsed');
  ok(!result.some((r) => r.cableId === 'gp-stale'), 'null value entry excluded');
  ok(!result.some((r) => r.cableId === 'gp-bad'), 'missing port entry excluded');
}

// ---------------------------------------------------------------------------
// 4. diffGamepadSync
// ---------------------------------------------------------------------------
console.log('--- diffGamepadSync');
{
  const defaultIds = new Set(['gp-1']);

  // Nothing to add or remove when empty.
  const d0 = diffGamepadSync({ desired: [], localIds: [], defaultIds });
  ok(d0.toAdd.length === 0, 'empty desired + empty local → nothing to add');
  ok(d0.toRemove.length === 0, 'empty desired + empty local → nothing to remove');

  // Add a new gamepad (peer spawned one we don't have).
  const d1 = diffGamepadSync({
    desired: [{ cableId: 'gp-alice-1', port: 1 }],
    localIds: ['gp-1'],
    defaultIds,
  });
  ok(d1.toAdd.length === 1, 'add alice-1 (not in local set)');
  ok(d1.toAdd[0].cableId === 'gp-alice-1', 'correct id to add');
  ok(d1.toRemove.length === 0, 'nothing to remove (gp-1 is default)');

  // Remove a gamepad (spawner disconnected, state cleared).
  const d2 = diffGamepadSync({
    desired: [],
    localIds: ['gp-1', 'gp-alice-1'],
    defaultIds,
  });
  ok(d2.toAdd.length === 0, 'nothing to add');
  ok(d2.toRemove.length === 1, 'remove alice-1 (state cleared)');
  ok(d2.toRemove[0] === 'gp-alice-1', 'correct id to remove');

  // Default gamepad (gp-1) is NEVER removed even if desired is empty.
  const d3 = diffGamepadSync({
    desired: [],
    localIds: ['gp-1'],
    defaultIds,
  });
  ok(d3.toRemove.length === 0, 'default gp-1 never removed');

  // Already have it → don't add again.
  const d4 = diffGamepadSync({
    desired: [{ cableId: 'gp-alice-1', port: 1 }],
    localIds: ['gp-1', 'gp-alice-1'],
    defaultIds,
  });
  ok(d4.toAdd.length === 0, 'already have alice-1 → not in toAdd');
  ok(d4.toRemove.length === 0, 'nothing to remove');

  // Two peers spawn simultaneously; both end up in desired; local has neither.
  const d5 = diffGamepadSync({
    desired: [
      { cableId: 'gp-alice-1', port: 1 },
      { cableId: 'gp-bob-1', port: 2 },
    ],
    localIds: ['gp-1'],
    defaultIds,
  });
  ok(d5.toAdd.length === 2, 'add both alice-1 and bob-1');
  ok(d5.toRemove.length === 0, 'gp-1 not removed');

  // One peer's pad cleared, another's stays.
  const d6 = diffGamepadSync({
    desired: [{ cableId: 'gp-bob-1', port: 2 }],
    localIds: ['gp-1', 'gp-alice-1', 'gp-bob-1'],
    defaultIds,
  });
  ok(d6.toAdd.length === 0, 'bob-1 already present → nothing to add');
  ok(d6.toRemove.length === 1 && d6.toRemove[0] === 'gp-alice-1',
    'alice-1 removed (state cleared), bob-1 stays');
}

// ---------------------------------------------------------------------------
// 5. Key namespace isolation
// ---------------------------------------------------------------------------
console.log('--- namespace isolation');
{
  // A cart file called 'gamepad:weirdname.nes' should not be confused with a
  // gamepad state key (the `gamepad:` prefix is never a valid cart file path).
  ok(isGamepadStateKey('gamepad:gp-alice-1'), 'gamepad key recognised');
  ok(!isGamepadStateKey('hold:gp:gp-alice-1'), 'hold key not confused with gamepad key');

  // The gamepad state key does NOT start with 'hold:', so Hub auto-clear for
  // 'hold:' alone would NOT catch it — Hub.js disconnect was extended to also
  // clear 'gamepad:' keys. Verify the prefixes are disjoint:
  ok(!makeGamepadStateKey('gp-1').startsWith('hold:'), 'gamepad key is not a hold key');
  ok(makeGamepadStateKey('gp-alice-1').startsWith('gamepad:'), 'gamepad key starts with gamepad:');
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
