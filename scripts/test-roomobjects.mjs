// Unit tests for the per-frame cost of the shared room-state layer (PERF-4(b)):
// [[src/net/RoomObjects.js]]'s change version + prefix iterator,
// [[src/net/PresenceState.js]]'s roster version + cached id set, and the
// [[src/net/HoldState.js]] HoldView that memoises the four ghost-sync slices on
// both counters. Pure logic only — no THREE / no socket / no DOM.
//
// What these pin, and why each would be a real bug if it regressed:
//   • The version bumps EXACTLY when the map changes. Bump on an echo and the
//     memo is worthless (we are back to parsing every frame); fail to bump on a
//     real change and a hold is never rendered.
//   • rosterVersion moves on join/leave/prune but NOT on a pose. Poses are the
//     bulk of the traffic at 20 Hz per peer — memoising on a counter that moves
//     with them buys nothing. And a LEAVE must move it even though no state key
//     changed, or the sweep that unhides a local prop the departed peer was
//     holding never runs (the COR-2/COR-8 failure).
//   • N frames with no change cost ONE parse, and the parse is over the matching
//     prefix only — the peer-reachable 4096-key case is the whole point.

import { MSG } from '../src/net/NetProtocol.js';
import { RoomObjects } from '../src/net/RoomObjects.js';
import { PresenceState } from '../src/net/PresenceState.js';
import { HoldView, parseHolds } from '../src/net/HoldState.js';

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
};

const state = (key, value, id = 'peer1') => ({ type: MSG.STATE, key, value, id });

// ---------------------------------------------------------------------------
// 1. RoomObjects.version — bumps when the MAP changes, never on an echo
// ---------------------------------------------------------------------------
console.log('--- RoomObjects.version');
{
  const objs = new RoomObjects();
  const v0 = objs.version;
  ok(Number.isInteger(v0), 'version is an integer');

  const first = objs.apply(state('hold:cart-1', { holder: 'peer1', hand: 'left' }));
  ok(first.changed === true, 'first set reports changed');
  ok(objs.version === v0 + 1, 'first set bumps the version');

  // The echo case: the server replays our own set back to us, and late joiners
  // get the whole map again. Bumping here would defeat the memo entirely.
  const echo = objs.apply(state('hold:cart-1', { holder: 'peer1', hand: 'left' }));
  ok(echo.changed === false, 'identical re-set reports unchanged');
  ok(objs.version === v0 + 1, 'identical re-set does NOT bump the version');

  const moved = objs.apply(state('hold:cart-1', { holder: 'peer1', hand: 'right' }));
  ok(moved.changed === true, 'a real value change reports changed');
  ok(objs.version === v0 + 2, 'a real value change bumps the version');

  // Same value, different setter: ownerOf() is part of the map's content (the
  // leave-clear rules read it), so the version has to move even though the
  // value-level `changed` flag every existing consumer reads stays false.
  const rebound = objs.apply(state('hold:cart-1', { holder: 'peer1', hand: 'right' }, 'peer2'));
  ok(rebound.changed === false, 'owner-only change keeps changed=false (existing contract)');
  ok(objs.ownerOf('hold:cart-1') === 'peer2', 'owner-only change is stored');
  ok(objs.version === v0 + 3, 'owner-only change bumps the version');

  const cleared = objs.apply(state('hold:cart-1', null, 'peer2'));
  ok(cleared.changed === true, 'clearing an existing key reports changed');
  ok(objs.version === v0 + 4, 'clearing an existing key bumps the version');
  ok(objs.size === 0, 'cleared key is gone');

  // Clearing a key that was never here leaves the map identical. A peer can send
  // this at the socket rate limit; it must not force a re-parse every frame.
  const noop = objs.apply(state('hold:never-here', null));
  ok(noop.changed === true, 'clearing an absent key still reports changed (unchanged contract)');
  ok(objs.version === v0 + 4, 'clearing an absent key does NOT bump the version');

  // Non-STATE / malformed traffic must not move the counter either.
  objs.apply({ type: MSG.POSE, id: 'peer1' });
  objs.apply(null);
  ok(objs.version === v0 + 4, 'non-STATE messages do not bump the version');

  objs.apply(state('tv', { file: 'a.nes' }));
  const beforeClear = objs.version;
  objs.clear();
  ok(objs.version === beforeClear + 1, 'clear() of a non-empty map bumps the version');
  const afterClear = objs.version;
  objs.clear();
  ok(objs.version === afterClear, 'clear() of an empty map does not bump');
}

// ---------------------------------------------------------------------------
// 2. Structural compare replaces the double JSON.stringify
// ---------------------------------------------------------------------------
console.log('--- structural value compare');
{
  const objs = new RoomObjects();
  objs.apply(state('prop:poster-1', { p: [1, 2, 3], r: { x: 0, y: 1.5 }, tag: 'a' }));
  const v = objs.version;
  ok(objs.apply(state('prop:poster-1', { p: [1, 2, 3], r: { x: 0, y: 1.5 }, tag: 'a' })).changed === false,
    'deep-equal nested value is unchanged');
  ok(objs.version === v, 'deep-equal nested value does not bump');
  ok(objs.apply(state('prop:poster-1', { p: [1, 2, 4], r: { x: 0, y: 1.5 }, tag: 'a' })).changed === true,
    'a nested array element difference is a change');
  ok(objs.apply(state('prop:poster-1', { p: [1, 2, 4], r: { x: 0, y: 1.5 } })).changed === true,
    'a missing key is a change');
  ok(objs.apply(state('prop:poster-1', { p: [1, 2, 4], r: { x: 0, y: 1.5 }, tag: 'b' })).changed === true,
    'a changed leaf is a change');
  // Order of keys is not a change (JSON.stringify said it was, which only ever
  // caused extra reconciles — this is strictly better, and cheaper).
  objs.apply(state('prop:poster-1', { a: 1, b: 2 }));
  ok(objs.apply(state('prop:poster-1', { b: 2, a: 1 })).changed === false, 'key order is not a change');
  // Primitives and null round-trip.
  objs.apply(state('flag', true));
  ok(objs.apply(state('flag', true)).changed === false, 'primitive echo is unchanged');
  ok(objs.apply(state('flag', false)).changed === true, 'primitive flip is a change');

  // Over-budget values answer "changed" — the SAFE direction (a consumer
  // re-applies idempotently), and O(1) instead of O(256 KiB) on the render
  // thread for a value a peer chose the size of.
  const huge = () => ({ blob: Array.from({ length: 4000 }, (_, i) => i) });
  objs.apply(state('big', huge()));
  ok(objs.apply(state('big', huge())).changed === true,
    'an over-budget value reports changed rather than walking it all');
}

// ---------------------------------------------------------------------------
// 3. entriesWithPrefix — the same pairs entries().filter() gave, lazily
// ---------------------------------------------------------------------------
console.log('--- entriesWithPrefix');
{
  const objs = new RoomObjects();
  objs.apply(state('hold:cart-1', { holder: 'p1' }));
  objs.apply(state('hold:gp:gp-2', { holder: 'p1' }));
  objs.apply(state('hold:gun:gun-2', { holder: 'p1' }));
  objs.apply(state('hold:mouse:m-2', { holder: 'p1' }));
  objs.apply(state('prop:poster-1', { x: 1 }));

  const all = [...objs.entriesWithPrefix('hold:')];
  ok(all.length === 4, 'hold: prefix yields every hold key');
  const gp = [...objs.entriesWithPrefix('hold:gp:')];
  ok(gp.length === 1 && gp[0][0] === 'hold:gp:gp-2', 'hold:gp: prefix yields only the gamepad hold');
  ok(gp[0][1].holder === 'p1', 'prefix iterator yields the VALUE, not the {value,id} record');
  // Must agree with the array path it replaced, key for key.
  const viaFilter = objs.entries().filter(([k]) => k.startsWith('hold:gun:'));
  const viaPrefix = [...objs.entriesWithPrefix('hold:gun:')];
  ok(JSON.stringify(viaFilter) === JSON.stringify(viaPrefix), 'prefix iterator matches entries().filter()');
  ok([...objs.entriesWithPrefix('nope:')].length === 0, 'a prefix with no keys yields nothing');
  // Lazy: it is a generator, so nothing is materialised until it is drained.
  const it = objs.entriesWithPrefix('hold:');
  ok(typeof it[Symbol.iterator] === 'function' && !Array.isArray(it), 'entriesWithPrefix returns an iterator');
  // parseHolds must accept it directly (that is how the hot path uses it).
  ok(parseHolds(objs.entriesWithPrefix('hold:gp:'), { selfId: 'me' }).length === 1,
    'parseHolds consumes the generator');
}

// ---------------------------------------------------------------------------
// 4. PresenceState.rosterVersion — the OTHER half of the memo key
// ---------------------------------------------------------------------------
console.log('--- PresenceState.rosterVersion');
{
  const pres = new PresenceState({ selfId: 'me', ttlMs: 1000 });
  const v0 = pres.rosterVersion;
  pres.applyJoin({ id: 'a', nick: 'A' }, 0);
  ok(pres.rosterVersion === v0 + 1, 'join bumps rosterVersion');
  pres.applyJoin({ id: 'a', nick: 'A2' }, 10);
  ok(pres.rosterVersion === v0 + 1, 'a re-join of a known peer does not bump (same set)');

  // Poses are the bulk of the traffic; memoising on a counter they move is a
  // memo that never hits.
  pres.applyPose({ id: 'a', head: [0, 1, 0, 0, 0, 0, 1] }, 20);
  pres.applyPose({ id: 'a', head: [0, 1.1, 0, 0, 0, 0, 1] }, 30);
  ok(pres.rosterVersion === v0 + 1, 'a pose update does NOT bump rosterVersion');

  pres.applyJoin({ id: 'b' }, 30);
  ok(pres.rosterVersion === v0 + 2, 'a second peer bumps');
  pres.applyLeave('b');
  ok(pres.rosterVersion === v0 + 3, 'leave bumps');
  pres.applyLeave('b');
  ok(pres.rosterVersion === v0 + 3, 'leaving twice does not bump again');

  // Prune is the silent leave (tab closed, network drop) and must count too.
  pres.prune(40);
  ok(pres.rosterVersion === v0 + 3, 'prune that removes nobody does not bump');
  const removed = pres.prune(5000);
  ok(removed.length === 1 && pres.rosterVersion === v0 + 4, 'prune that drops a peer bumps');

  // Our own id decides which holds are OURS, so it invalidates the same views.
  const beforeSelf = pres.rosterVersion;
  pres.setSelfId('me');
  ok(pres.rosterVersion === beforeSelf, 'setting the same selfId does not bump');
  pres.setSelfId('me2');
  ok(pres.rosterVersion === beforeSelf + 1, 'a new selfId bumps');

  pres.applyJoin({ id: 'c' }, 0);
  const beforeClear = pres.rosterVersion;
  pres.clear();
  ok(pres.rosterVersion === beforeClear + 1, 'clear() of a non-empty roster bumps');
  const afterClear = pres.rosterVersion;
  pres.clear();
  ok(pres.rosterVersion === afterClear, 'clear() of an empty roster does not bump');
}

// ---------------------------------------------------------------------------
// 5. Cached id array/set — same instance until the roster moves
// ---------------------------------------------------------------------------
console.log('--- PresenceState.ids/idSet caching');
{
  const pres = new PresenceState({ selfId: 'me' });
  pres.applyJoin({ id: 'a' }, 0);
  pres.applyJoin({ id: 'b' }, 0);
  const set1 = pres.idSet();
  const ids1 = pres.ids();
  ok(set1.has('a') && set1.has('b') && set1.size === 2, 'idSet holds every peer');
  ok(ids1.length === 2 && ids1.includes('a'), 'ids() lists every peer');
  ok(!set1.has('me'), 'self is not in the roster (peers() already excludes it)');
  pres.applyPose({ id: 'a', head: [0, 0, 0, 0, 0, 0, 1] }, 5);
  ok(pres.idSet() === set1, 'a pose does not rebuild the id set');
  ok(pres.ids() === ids1, 'a pose does not rebuild the id array');
  pres.applyLeave('b');
  ok(pres.idSet() !== set1, 'a leave rebuilds the id set');
  ok(pres.idSet().size === 1 && !pres.idSet().has('b'), 'the rebuilt set reflects the leave');
  ok(pres.ids().length === 1, 'the rebuilt array reflects the leave');
  // Same contents as the array the four ticks used to build for themselves.
  ok(JSON.stringify(pres.ids()) === JSON.stringify(pres.peers().map((p) => p.id)),
    'ids() matches peers().map(p => p.id)');
}

// ---------------------------------------------------------------------------
// 6. HoldView — one parse per change, not one per rendered frame
// ---------------------------------------------------------------------------
console.log('--- HoldView memo');
{
  const slices = [
    { name: 'carts', prefix: 'hold:' },
    { name: 'gamepads', prefix: 'hold:gp:', remap: (id) => id.slice('gp:'.length) },
  ];
  const objs = new RoomObjects();
  const pres = new PresenceState({ selfId: 'me' });
  const view = new HoldView(slices);

  pres.applyJoin({ id: 'peer1' }, 0);
  objs.apply(state('hold:cart-1', { holder: 'peer1', hand: 'left' }));
  objs.apply(state('hold:gp:gp-2', { holder: 'peer1', hand: 'right' }));

  const first = view.update(objs, pres);
  ok(view.recomputes === 1, 'first update parses');
  ok(first.carts.length === 2, 'carts slice takes EVERY hold: key (unchanged input)');
  ok(first.gamepads.length === 1 && first.gamepads[0].objId === 'gp-2',
    'gamepad slice is remapped to the bare cableId');
  ok(first.gamepads[0].hand === 'right', 'hand survives the remap');

  // 100 rendered frames with nothing happening: exactly one parse, and the same
  // arrays handed back (the managers only read them).
  const cartsRef = first.carts;
  for (let i = 0; i < 100; i++) view.update(objs, pres);
  ok(view.recomputes === 1, '100 unchanged frames cost ONE parse');
  ok(view.update(objs, pres).carts === cartsRef, 'the memo hands back the same array');

  // A pose is the common case and must not invalidate it.
  pres.applyPose({ id: 'peer1', head: [0, 1, 0, 0, 0, 0, 1] }, 10);
  view.update(objs, pres);
  ok(view.recomputes === 1, 'a pose does not re-parse');

  // A state change does.
  objs.apply(state('hold:cart-1', { holder: 'peer1', hand: 'right' }));
  ok(view.update(objs, pres).carts[0].hand === 'right', 'a state change is picked up');
  ok(view.recomputes === 2, 'a state change re-parses exactly once');
  for (let i = 0; i < 10; i++) view.update(objs, pres);
  ok(view.recomputes === 2, 'and then goes quiet again');

  // THE COR-2/COR-8 TRAP: the holder leaves. No STATE key changes (the server's
  // owner-clear arrives later, or never if the socket died), so a memo keyed on
  // room state alone would keep reporting the hold — and the local prop the peer
  // was holding stays hidden for the rest of the build.
  pres.applyLeave('peer1');
  const afterLeave = view.update(objs, pres);
  ok(view.recomputes === 3, 'a peer leaving re-parses even with no state change');
  ok(afterLeave.carts.length === 0 && afterLeave.gamepads.length === 0,
    'holds by a departed peer disappear from every slice');

  // A prune (silent drop) is the same story.
  pres.applyJoin({ id: 'peer2' }, 0);
  objs.apply(state('hold:cart-9', { holder: 'peer2' }));
  ok(view.update(objs, pres).carts.length === 1, 'a new peer hold shows up');
  const beforePrune = view.recomputes;
  pres.prune(1e9);
  ok(view.update(objs, pres).carts.length === 0, 'a pruned peer\'s hold disappears');
  ok(view.recomputes === beforePrune + 1, 'the prune re-parsed exactly once');

  // Rejoin builds a FRESH NetMgr: new RoomObjects/PresenceState whose counters
  // restart at 0. That must not read as "unchanged" against the old ones.
  const objs2 = new RoomObjects();
  const pres2 = new PresenceState({ selfId: 'me' });
  pres2.applyJoin({ id: 'peer3' }, 0);
  objs2.apply(state('hold:cart-3', { holder: 'peer3' }));
  const rejoined = view.update(objs2, pres2);
  ok(rejoined.carts.length === 1 && rejoined.carts[0].holder === 'peer3',
    'a fresh session\'s state is not mistaken for the old one');
}

// ---------------------------------------------------------------------------
// 7. HoldView at the peer-reachable key count: prefix slices stay small
// ---------------------------------------------------------------------------
console.log('--- HoldView with a 4096-key room');
{
  const objs = new RoomObjects();
  const pres = new PresenceState({ selfId: 'me' });
  pres.applyJoin({ id: 'peer1' }, 0);
  // What one hostile (or buggy) peer can put in every other client's map: the
  // server's per-room key cap. None of it is a hold.
  for (let i = 0; i < 4096; i++) objs.apply(state(`junk:${i}`, i));
  objs.apply(state('hold:gp:gp-2', { holder: 'peer1', hand: 'left' }));

  const view = new HoldView([
    { name: 'carts', prefix: 'hold:' },
    { name: 'gamepads', prefix: 'hold:gp:', remap: (id) => id.slice('gp:'.length) },
  ]);
  const holds = view.update(objs, pres);
  ok(holds.gamepads.length === 1, 'the one real hold is found among 4096 junk keys');
  ok(holds.carts.length === 1, 'the junk namespace never reaches a hold slice');
  ok(objs.size === 4097, 'the junk really is in the map');

  // The claim: 72 rendered frames of this room cost ONE walk of the map per
  // slice, not four walks + four full array copies per frame.
  for (let i = 0; i < 72; i++) view.update(objs, pres);
  ok(view.recomputes === 1, '72 frames over a 4096-key map cost one parse');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
