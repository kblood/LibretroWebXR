// Unit tests for the prop existence/placement sync helpers ([[src/net/PropSync.js]]).
// Pure logic only — no THREE / no socket / no DOM.

import {
  makePropStateKey,
  isPropStateKey,
  propIdFromStateKey,
  makePeerPropId,
  serializePropState,
  parsePropEntries,
  diffPropSync,
} from '../src/net/PropSync.js';

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
  ok(makePropStateKey('poster-1') === 'prop:poster-1', 'makePropStateKey(poster-1)');
  ok(makePropStateKey('prop-alice-1') === 'prop:prop-alice-1', 'makePropStateKey with peer id');
  ok(isPropStateKey('prop:poster-1'), 'isPropStateKey recognises prop: prefix');
  ok(!isPropStateKey('gamepad:gp-1'), 'isPropStateKey rejects gamepad: prefix');
  ok(!isPropStateKey('hold:gp:gp-1'), 'isPropStateKey rejects hold: prefix');
  ok(!isPropStateKey('tv'), 'isPropStateKey rejects tv');
  ok(!isPropStateKey(null), 'isPropStateKey rejects null');
  ok(propIdFromStateKey('prop:poster-1') === 'poster-1', 'propIdFromStateKey extracts poster-1');
  ok(propIdFromStateKey('prop:prop-alice-3') === 'prop-alice-3', 'propIdFromStateKey with peer id');
  ok(propIdFromStateKey('gamepad:gp-1') === null, 'propIdFromStateKey returns null for gamepad key');
  ok(propIdFromStateKey(null) === null, 'propIdFromStateKey returns null for null');
  ok(propIdFromStateKey('hold:prop:p1') === null, 'propIdFromStateKey returns null for hold key');
}

// ---------------------------------------------------------------------------
// 2. makePeerPropId
// ---------------------------------------------------------------------------
console.log('--- makePeerPropId');
{
  ok(makePeerPropId('peer1', 1) === 'prop-peer1-1', 'basic peer prop id');
  ok(makePeerPropId('peer1', 2) === 'prop-peer1-2', 'counter increments');
  ok(makePeerPropId('peer2', 1) === 'prop-peer2-1', 'different peer');
  ok(makePeerPropId('alice', 1) !== makePeerPropId('bob', 1), 'peer ids distinct');
  ok(/^prop-[a-zA-Z0-9_-]+-\d+$/.test(makePeerPropId('peer:with:colons', 1)),
    'colons in selfId are sanitised');
  ok(/^prop-[a-zA-Z0-9_-]+-\d+$/.test(makePeerPropId('peer with spaces', 1)),
    'spaces in selfId are sanitised');
}

// ---------------------------------------------------------------------------
// 3. serializePropState — plain-object mock of THREE Object3D
// ---------------------------------------------------------------------------
console.log('--- serializePropState');
{
  // Minimal mock of a THREE Object3D (pure position/rotation values).
  const makeObj = (px, py, pz, rx, ry, rz) => ({
    position: { x: px, y: py, z: pz },
    rotation: { x: rx, y: ry, z: rz },
  });
  const DEG = Math.PI / 180;

  // Poster prop with texture.
  const posterProp = { type: 'poster', id: 'poster-1', texture: 'builtin:poster-2', size: [0.8, 1.1], fit: 'contain', scale: 1 };
  const posterObj = makeObj(1.2, 1.5, -3.9, 0, 90 * DEG, 0);
  const ps = serializePropState(posterProp, posterObj);
  ok(ps.type === 'poster', 'serializePropState: type preserved');
  ok(Array.isArray(ps.pos) && ps.pos.length === 3, 'pos is a 3-tuple');
  ok(Math.abs(ps.pos[0] - 1.2) < 0.001, 'pos.x correct');
  ok(Math.abs(ps.rot[1] - 90) < 0.01, 'rot.y converted from radians to degrees');
  ok(ps.texture === 'builtin:poster-2', 'poster texture carried through');
  ok(ps.size !== undefined, 'poster size carried through');
  ok(ps.fit === 'contain', 'poster fit carried through');
  ok(ps.scale === 1, 'poster scale carried through');

  // Console prop — no extra fields.
  const consoleProp = { type: 'console', id: 'console-1' };
  const consoleObj = makeObj(0, 0.74, -2.4, 0, 0, 0);
  const cs = serializePropState(consoleProp, consoleObj);
  ok(cs.type === 'console', 'console type preserved');
  ok(cs.texture === undefined, 'console has no texture field');
  ok(Math.abs(cs.pos[2] - (-2.4)) < 0.001, 'console pos.z correct');

  // Rounding: check that non-finite values become 0.
  const badObj = makeObj(NaN, Infinity, -0, 0, 0, 0);
  const bs = serializePropState({ type: 'console', id: 'x' }, badObj);
  ok(bs.pos[0] === 0, 'NaN pos.x becomes 0');
  ok(bs.pos[1] === 0, 'Infinity pos.y becomes 0');
  ok(Object.is(bs.pos[2], 0), '-0 pos.z normalized to 0');

  // Rounding to 3 decimal places.
  const precObj = makeObj(1.23456789, 0, 0, 0, 0, 0);
  const pr = serializePropState({ type: 'console', id: 'x' }, precObj);
  ok(pr.pos[0] === 1.235, 'pos.x rounded to 3dp');

  // FIX 3c: imageFile carried through poster STATE payload when set.
  const posterWithFile = { type: 'poster', id: 'poster-2', texture: 'blob:fake', imageFile: 'art.png' };
  const pf = serializePropState(posterWithFile, makeObj(0, 1.5, -3.9, 0, 0, 0));
  ok(pf.imageFile === 'art.png', 'imageFile carried through poster STATE when set');

  // imageFile omitted when not present on prop.
  const posterNoFile = { type: 'poster', id: 'poster-3', texture: 'builtin:poster-1' };
  const pnf = serializePropState(posterNoFile, makeObj(0, 1.5, -3.9, 0, 0, 0));
  ok(pnf.imageFile === undefined, 'imageFile absent from STATE when prop has none');

  // imageFile NOT emitted for non-poster types.
  const shelfWithFile = { type: 'shelf', id: 'shelf-1', imageFile: 'art.png' };
  const sf = serializePropState(shelfWithFile, makeObj(0, 1, -3, 0, 0, 0));
  ok(sf.imageFile === undefined, 'imageFile not emitted for non-poster types');

  // lightgun cableId carried through so a remote peer registers the gun under the
  // SAME id its gun:<cableId> port binding is keyed by (links mesh ↔ port sync).
  const gunWithCable = { type: 'lightgun', id: 'prop-p1-2', cableId: 'gun-p1-1' };
  const gc = serializePropState(gunWithCable, makeObj(0, 1, -3, 0, 0, 0));
  ok(gc.cableId === 'gun-p1-1', 'lightgun cableId carried through prop STATE');
  // cableId absent when a gun prop has none (single-player / pre-session mesh).
  const gunNoCable = { type: 'lightgun', id: 'lightgun-1' };
  const gnc = serializePropState(gunNoCable, makeObj(0, 1, -3, 0, 0, 0));
  ok(gnc.cableId === undefined, 'cableId absent from STATE when gun has none');
  // cableId NOT emitted for non-lightgun types (channel hygiene).
  const consoleWithCable = { type: 'console', id: 'console-1', cableId: 'gun-x' };
  const cwc = serializePropState(consoleWithCable, makeObj(0, 1, -3, 0, 0, 0));
  ok(cwc.cableId === undefined, 'cableId not emitted for non-lightgun types');
}

// ---------------------------------------------------------------------------
// 4. parsePropEntries
// ---------------------------------------------------------------------------
console.log('--- parsePropEntries');
{
  const entries = [
    ['tv', { file: 'g.nes' }],                              // non-prop → ignored
    ['gamepad:gp-1', { port: 0 }],                          // gamepad key → ignored
    ['hold:poster-1', { holder: 'alice' }],                 // hold key → ignored
    ['prop:poster-1', { type: 'poster', pos: [0,1,0], rot: [0,0,0] }],   // valid
    ['prop:console-2', { type: 'console', pos: [1,0,-2], rot: [0,0,0] }], // valid
    ['prop:stale', null],                                    // null value → ignored
    ['prop:bad', { noType: 'x' }],                          // missing type → ignored
    ['prop:tv-0', { type: 'tv', pos: [0,1.5,-3.6], rot: [0,0,0] }],      // tv prop valid
  ];

  const result = parsePropEntries(entries);
  ok(result.length === 3, `parsePropEntries returns 3 valid entries (got ${result.length})`);
  ok(result.some((r) => r.propId === 'poster-1' && r.payload.type === 'poster'), 'poster-1 parsed');
  ok(result.some((r) => r.propId === 'console-2'), 'console-2 parsed');
  ok(result.some((r) => r.propId === 'tv-0'), 'tv-0 parsed');
  ok(!result.some((r) => r.propId === 'stale'), 'null value excluded');
  ok(!result.some((r) => r.propId === 'bad'), 'missing type excluded');
}

// ---------------------------------------------------------------------------
// 5. diffPropSync
// ---------------------------------------------------------------------------
console.log('--- diffPropSync');
{
  const staticIds = new Set(['console-1', 'tv0', 'poster-1']);

  const makePayload = (type, x = 0, y = 0, z = 0) => ({ type, pos: [x, y, z], rot: [0, 0, 0] });

  // Nothing desired, nothing local → nothing to do.
  const d0 = diffPropSync({ desired: [], localProps: new Map(), staticIds });
  ok(d0.toCreate.length === 0, 'empty desired + empty local → nothing to create');
  ok(d0.toUpdate.length === 0, 'empty desired + empty local → nothing to update');
  ok(d0.toRemove.length === 0, 'empty desired + empty local → nothing to remove');

  // New peer-spawned prop (poster from alice not yet in our local set).
  const d1 = diffPropSync({
    desired: [{ propId: 'prop-alice-1', payload: makePayload('poster', 1, 1, -3) }],
    localProps: new Map(),
    staticIds,
  });
  ok(d1.toCreate.length === 1, 'new prop goes to toCreate');
  ok(d1.toCreate[0].propId === 'prop-alice-1', 'correct propId to create');
  ok(d1.toUpdate.length === 0, 'nothing to update');
  ok(d1.toRemove.length === 0, 'nothing to remove');

  // Static prop that was moved (first time we see its sync state).
  const d2 = diffPropSync({
    desired: [{ propId: 'poster-1', payload: makePayload('poster', 0.5, 1.5, -3.9) }],
    localProps: new Map(),
    staticIds,
  });
  ok(d2.toCreate.length === 0, 'static prop not added to toCreate');
  ok(d2.toUpdate.length === 1, 'static prop update goes to toUpdate');
  ok(d2.toUpdate[0].propId === 'poster-1', 'correct static propId in toUpdate');
  ok(d2.toRemove.length === 0, 'static prop never removed');

  // Static prop that did NOT change (same payload already known locally).
  const staticPayload = makePayload('poster', 0.5, 1.5, -3.9);
  const d3 = diffPropSync({
    desired: [{ propId: 'poster-1', payload: staticPayload }],
    localProps: new Map([['poster-1', staticPayload]]),
    staticIds,
  });
  ok(d3.toCreate.length === 0, 'unchanged static: nothing to create');
  ok(d3.toUpdate.length === 0, 'unchanged static: nothing to update');
  ok(d3.toRemove.length === 0, 'unchanged static: nothing to remove');

  // Prop moved (same propId, different position).
  const moved = diffPropSync({
    desired: [{ propId: 'prop-alice-1', payload: makePayload('poster', 2, 1, -3) }],
    localProps: new Map([['prop-alice-1', makePayload('poster', 1, 1, -3)]]),
    staticIds,
  });
  ok(moved.toCreate.length === 0, 'moved prop not in toCreate');
  ok(moved.toUpdate.length === 1, 'moved prop in toUpdate');
  ok(moved.toUpdate[0].propId === 'prop-alice-1', 'correct moved propId');
  ok(moved.toRemove.length === 0, 'nothing to remove');

  // State cleared for a peer-spawned prop (key set to null → propId absent from desired).
  const removed = diffPropSync({
    desired: [],
    localProps: new Map([['prop-alice-1', makePayload('poster', 1, 1, -3)]]),
    staticIds,
  });
  ok(removed.toRemove.length === 1, 'cleared prop in toRemove');
  ok(removed.toRemove[0] === 'prop-alice-1', 'correct propId to remove');

  // Static props are NEVER removed even when absent from desired (they always exist locally).
  const staticRemoved = diffPropSync({
    desired: [],
    localProps: new Map([['console-1', makePayload('console', 0, 0.74, -2.4)]]),
    staticIds,
  });
  ok(staticRemoved.toRemove.length === 0, 'static prop never removed (always in staticIds)');

  // Two peers add different props simultaneously; both end up in desired.
  const concurrent = diffPropSync({
    desired: [
      { propId: 'prop-alice-1', payload: makePayload('poster') },
      { propId: 'prop-bob-1',   payload: makePayload('console') },
    ],
    localProps: new Map(),
    staticIds,
  });
  ok(concurrent.toCreate.length === 2, 'both concurrent props in toCreate');
  ok(concurrent.toRemove.length === 0, 'nothing to remove in concurrent case');

  // Already have it + it hasn't changed → no diff.
  const noDiff = diffPropSync({
    desired: [{ propId: 'prop-alice-1', payload: makePayload('poster', 1, 1, -3) }],
    localProps: new Map([['prop-alice-1', makePayload('poster', 1, 1, -3)]]),
    staticIds,
  });
  ok(noDiff.toCreate.length === 0, 'already local + unchanged → not in toCreate');
  ok(noDiff.toUpdate.length === 0, 'already local + unchanged → not in toUpdate');
}

// ---------------------------------------------------------------------------
// 6. Key namespace isolation
// ---------------------------------------------------------------------------
console.log('--- namespace isolation');
{
  ok(isPropStateKey('prop:poster-1'), 'prop key recognised');
  ok(!isPropStateKey('gamepad:gp-1'), 'gamepad key not confused with prop key');
  ok(!isPropStateKey('hold:poster-1'), 'hold key not confused with prop key');
  ok(!makePropStateKey('poster-1').startsWith('hold:'), 'prop key is not a hold key');
  ok(!makePropStateKey('poster-1').startsWith('gamepad:'), 'prop key is not a gamepad key');
  ok(makePropStateKey('poster-1').startsWith('prop:'), 'prop key starts with prop:');
  // The Hub does NOT auto-clear prop: on disconnect (unlike hold: and gamepad:).
  // Verify the prefix is distinct from the cleared ones.
  ok('prop:poster-1'.startsWith('prop:'), 'prop: prefix recognised');
  ok(!'prop:poster-1'.startsWith('hold:'), 'prop: is not hold:');
  ok(!'prop:poster-1'.startsWith('gamepad:'), 'prop: is not gamepad:');
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
