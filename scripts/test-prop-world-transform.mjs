// Two reported multiplayer bugs, pinned at the layer where they were caused.
//
// 1. "When one player releases a controller it falls below the floor for the
//    other player, but stays in the air for the player that released it."
//    GrabMgr re-parents a grabbed prop onto the CONTROLLER, and the live-drag
//    wire serialized the prop's LOCAL transform as its room position — so while
//    a prop was held every other peer was told it was a few centimetres from the
//    world origin, at floor level. For a gamepad that stayed invisible until the
//    moment it stopped: GhostGamepadMgr hides a remotely-held pad, so the bogus
//    pose was only revealed on release, when the real mesh was un-hidden
//    wherever the last drag packet had put it. Fixed by src/net/PropTransform.js.
//
// 2. "The room failed to sync when a player joins. If something was moved AFTER
//    the client joined, those moves sync correctly."
//    The host published its room DESCRIPTOR (authored positions) and nothing
//    else, so any placement made outside a networked edit — the layout the host
//    arranged solo, a restored local layout, a gamepad seated at boot — was
//    invisible to a joiner, while post-join moves rode `prop:` deltas and worked.
//    Fixed by diffPropBaseline + the host baseline publish in main.js.
//
// WHAT WOULD MAKE THIS SUITE WORTHLESS, and what is done about it:
//   • Re-implementing the world-transform maths here and testing THAT would
//     prove nothing about the app. Every assertion below runs the real
//     propWorldPayload/serializePropState/diffPropBaseline the app imports,
//     against a real THREE hierarchy built the way GrabMgr builds one
//     (ctrl.attach — the actual call in _finalizeAttach).
//   • "The payload is a world position" is not the claim on its own; the claim
//     is that a peer APPLYING it lands the prop where the holder left it. There
//     is a round-trip section that applies the payload exactly as main.js's
//     _applyRemotePropTransform does and compares world transforms.
//   • Every fix assertion is paired with the shipped behaviour as a negative
//     control, so a change that quietly reverts one fails here.
//
// Pure logic: THREE runs headless, no DOM, no sockets.
// Run: node scripts/test-prop-world-transform.mjs   (also in `npm test`)

import * as THREE from 'three';
import { serializePropState, diffPropBaseline } from '../src/net/PropSync.js';
import { propWorldPayload } from '../src/net/PropTransform.js';

let passed = 0;
let failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ${b} ±${tol})`);
const section = (name, fn) => {
  console.log(`--- ${name} ---`);
  try { fn(); } catch (e) { failed++; console.error(`  FAIL: section "${name}" threw — ${e.stack || e.message}`); }
};

const DEG = Math.PI / 180;

// The scene the app builds: props hang off the scene root, controllers hang off
// the player rig. Mirrors SceneMgr (playerRig.add(ctrl), scene.add(prop)).
function world() {
  const root = new THREE.Scene();
  const rig = new THREE.Group();
  rig.position.set(1.2, 0, -0.5);
  rig.rotation.set(0, 35 * DEG, 0);
  root.add(rig);
  const ctrl = new THREE.Group();          // an XR controller
  ctrl.position.set(0.25, 1.15, -0.2);
  ctrl.rotation.set(-20 * DEG, 10 * DEG, 5 * DEG);
  rig.add(ctrl);
  return { root, rig, ctrl };
}

// A gamepad prop where the default room puts it (public/roms/bedroom.room.json).
function gamepadProp(root) {
  const obj = new THREE.Group();
  obj.position.set(0.55, 0.78, -2.15);
  obj.rotation.set(0, -25 * DEG, 0);
  root.add(obj);
  return { prop: { type: 'gamepad', id: 'gamepad-1' }, object: obj };
}

const worldPosOf = (o) => o.getWorldPosition(new THREE.Vector3());

// A real grab: GrabMgr only picks up what the hand is touching, so move the
// controller onto the prop first. That is what makes the LOCAL transform of a
// held prop tiny — a few centimetres from the controller's origin — and so what
// makes the shipped payload read as "at the world origin, on the floor".
function reachAndGrab({ rig, ctrl }, object) {
  const target = worldPosOf(object);
  rig.position.set(0, 0, 0);
  rig.rotation.set(0, 0, 0);
  ctrl.position.copy(target).add(new THREE.Vector3(0.04, -0.02, 0.03));
  ctrl.parent.updateMatrixWorld(true);
  ctrl.attach(object);                    // exactly what GrabMgr._finalizeAttach does
}

// === A. a prop in a hand ====================================================

section('a prop at rest serializes to its room position', () => {
  const { root } = world();
  const { prop, object } = gamepadProp(root);
  const payload = propWorldPayload(prop, object, { root });
  eq(payload.pos, [0.55, 0.78, -2.15], 'the pose in the payload is where the prop is in the room');
  eq(payload, serializePropState(prop, object), 'and is byte-identical to the local serialization (world == local at rest)');
});

section('GRABBING a prop destroys its local transform as a room position', () => {
  const w = world();
  const { prop, object } = gamepadProp(w.root);
  const root = w.root;
  const before = propWorldPayload(prop, object, { root });
  const roomPos = worldPosOf(object);

  reachAndGrab(w, object);
  ok(object.parent === w.ctrl, 'the prop is now a child of the controller');

  // NEGATIVE CONTROL — the shipped serialization. This is the payload that went
  // out on the drag wire ~20 Hz while the prop was held.
  const local = serializePropState(prop, object);
  const localVec = new THREE.Vector3(local.pos[0], local.pos[1], local.pos[2]);
  ok(localVec.length() < 0.2,
    `the local transform is a few centimetres from the ORIGIN (${localVec.length().toFixed(3)}m), not a room position`);
  ok(localVec.distanceTo(roomPos) > 2,
    `which is ${localVec.distanceTo(roomPos).toFixed(2)}m from where the prop actually is`);
  ok(Math.abs(local.pos[1]) < 0.15,
    `and its height collapses from 0.78m to y=${local.pos[1]} — the floor, which is where peers saw it land`);

  // THE FIX: attach() preserves the world transform, so the prop has not moved
  // in the room at all — and the payload says so.
  const held = propWorldPayload(prop, object, { root });
  eq(held, before, 'the world payload is UNCHANGED by the grab — the prop did not move in the room');
});

section('a carried prop reports where it is carried TO', () => {
  const w = world();
  const { root, rig, ctrl } = w;
  const { prop, object } = gamepadProp(root);
  reachAndGrab(w, object);
  const atGrab = propWorldPayload(prop, object, { root });
  const localAtGrab = serializePropState(prop, object);

  rig.position.set(-1.5, 0, 2.0);        // the holder walks across the room
  ctrl.position.set(0.1, 1.4, -0.35);    // and raises their hand
  root.updateMatrixWorld(true);

  const carried = propWorldPayload(prop, object, { root });
  const truth = worldPosOf(object);
  near(carried.pos[0], Math.round(truth.x * 1000) / 1000, 1e-6, 'the carried payload tracks the prop in the room (x)');
  near(carried.pos[1], Math.round(truth.y * 1000) / 1000, 1e-6, '…(y)');
  near(carried.pos[2], Math.round(truth.z * 1000) / 1000, 1e-6, '…(z)');
  ok(JSON.stringify(carried.pos) !== JSON.stringify(atGrab.pos), 'and it changed as the holder moved');

  // NEGATIVE CONTROL: the local transform is rigidly fixed to the hand, so it
  // reports the SAME pose no matter where in the room the holder walks. A peer
  // driving off it can only ever place the prop at the origin.
  eq(serializePropState(prop, object).pos, localAtGrab.pos,
    'while the local transform never changes, however far the holder walks');
});

section('the payload a peer APPLIES puts the prop where the holder left it', () => {
  // The receiver's rule, copied from main.js _applyRemotePropTransform: set the
  // LOCAL position/rotation of its own scene-parented copy.
  const applyRemote = (object, payload) => {
    object.position.set(payload.pos[0], payload.pos[1], payload.pos[2]);
    object.rotation.set(payload.rot[0] * DEG, payload.rot[1] * DEG, payload.rot[2] * DEG);
    object.updateMatrixWorld(true);
  };

  const w = world();
  const { root, ctrl } = w;
  const { prop, object } = gamepadProp(root);
  reachAndGrab(w, object);
  ctrl.position.set(-0.4, 1.35, 0.8);          // held out in front of the player
  root.updateMatrixWorld(true);
  const holderSees = worldPosOf(object);

  const peerRoot = new THREE.Scene();
  const peerCopy = new THREE.Group();
  peerRoot.add(peerCopy);

  applyRemote(peerCopy, propWorldPayload(prop, object, { root }));
  const peerSees = worldPosOf(peerCopy);
  near(peerSees.x, holderSees.x, 0.002, 'the peer puts the prop where the holder has it (x)');
  near(peerSees.y, holderSees.y, 0.002, '…(y)');
  near(peerSees.z, holderSees.z, 0.002, '…(z)');
  ok(peerSees.y > 0.5, `and it is up in the room, not on the floor (y=${peerSees.y.toFixed(2)})`);

  // NEGATIVE CONTROL: the shipped payload, applied by the same rule.
  applyRemote(peerCopy, serializePropState(prop, object));
  const peerSeesOld = worldPosOf(peerCopy);
  ok(peerSeesOld.distanceTo(holderSees) > 1,
    `the shipped payload lands it ${peerSeesOld.distanceTo(holderSees).toFixed(2)}m away from the holder's prop`);
  ok(peerSeesOld.y < 0.5,
    `down at the floor — y=${peerSeesOld.y.toFixed(2)} — which is the bug as reported`);
});

// === B. the fast path =======================================================

section('a prop at rest is never re-normalised into a spurious move', () => {
  // rot [0,180,0] — a poster on the back wall, about as common as it gets —
  // decomposes through a quaternion as [-180,0,-180]. Same orientation, DIFFERENT
  // payload: every peer would see "it moved" on a prop nobody touched, and (with
  // the host baseline publish) the host would re-broadcast it every 2 seconds.
  const root = new THREE.Scene();
  const object = new THREE.Group();
  object.position.set(0, 1.6, 3.9);
  object.rotation.set(0, 180 * DEG, 0);
  root.add(object);
  const prop = { type: 'poster', id: 'poster-1', texture: 'x.png' };

  eq(propWorldPayload(prop, object, { root }), serializePropState(prop, object),
    'the scene-parented fast path returns the local serialization untouched');
  eq(propWorldPayload(prop, object, { root }).rot, [0, 180, 0], 'the authored rotation survives verbatim');

  // NEGATIVE CONTROL: take the world path for the same object and the numbers
  // change even though nothing moved. This is what the fast path exists to stop.
  const viaWorld = propWorldPayload(prop, object, {});   // no root → world path
  eq(viaWorld.rot, [-180, 0, -180], 'the world path re-normalises the SAME orientation to different numbers');
  ok(JSON.stringify(viaWorld) !== JSON.stringify(serializePropState(prop, object)),
    'so an unconditional world path would report a move that never happened');
});

section('an unparented object is treated as already being in room space', () => {
  const object = new THREE.Group();
  object.position.set(1, 2, 3);
  const prop = { type: 'console', id: 'console0' };
  eq(propWorldPayload(prop, object, { root: new THREE.Scene() }).pos, [1, 2, 3],
    'no parent → serialized verbatim, not dropped');
});

// === C. the host's join-time baseline =======================================

section('the baseline publishes what room state does not already know', () => {
  const current = new Map([
    ['poster-1', { type: 'poster', pos: [0, 1.6, 3.9], rot: [0, 180, 0] }],
    ['console0', { type: 'console', pos: [0.2, 0, -2.2], rot: [0, 0, 0] }],
    ['gamepad-1', { type: 'gamepad', pos: [0.55, 0.78, -2.15], rot: [0, -25, 0] }],
  ]);
  // Room state holds the console (someone moved it during a session) and nothing
  // else — the room as authored is invisible to a joiner.
  const published = new Map([
    ['console0', { type: 'console', pos: [0.2, 0, -2.2], rot: [0, 0, 0] }],
  ]);

  const out = diffPropBaseline({ current, published });
  eq(out.map((e) => e.propId).sort(), ['gamepad-1', 'poster-1'],
    'the two props room state never heard about are published');
  eq(out.find((e) => e.propId === 'poster-1').payload, current.get('poster-1'),
    'with their real current pose');

  eq(diffPropBaseline({ current, published: current }), [],
    'a settled room publishes nothing at all — this runs every 2s while hosting');
});

section('the baseline re-publishes a prop whose pose drifted from room state', () => {
  const moved = { type: 'tv', pos: [1.5, 1.2, -3.0], rot: [0, 0, 0] };
  const stale = { type: 'tv', pos: [0, 1.2, -3.0], rot: [0, 0, 0] };
  const out = diffPropBaseline({ current: new Map([['tv0', moved]]), published: new Map([['tv0', stale]]) });
  eq(out, [{ propId: 'tv0', payload: moved }], 'a prop moved outside a networked edit is corrected');
});

section('a prop in a hand is left to the drag wire', () => {
  const current = new Map([
    ['gamepad-1', { type: 'gamepad', pos: [0.1, 1.3, 0.4], rot: [0, 0, 0] }],
    ['poster-1', { type: 'poster', pos: [0, 1.6, 3.9], rot: [0, 180, 0] }],
  ]);
  const out = diffPropBaseline({ current, published: new Map(), skip: new Set(['gamepad-1']) });
  eq(out.map((e) => e.propId), ['poster-1'], 'the held prop is skipped; the resting one is published');

  // NEGATIVE CONTROL: without the skip, the 2s baseline would fight the ~20Hz
  // drag wire for the pose of a prop that is still in somebody's hand.
  const unguarded = diffPropBaseline({ current, published: new Map() });
  eq(unguarded.map((e) => e.propId).sort(), ['gamepad-1', 'poster-1'],
    'unguarded, the baseline would publish the held prop too');
});

section('the baseline ignores entries with no payload', () => {
  const out = diffPropBaseline({
    current: new Map([['ghost-1', null], ['poster-1', { type: 'poster', pos: [0, 0, 0], rot: [0, 0, 0] }]]),
    published: new Map(),
  });
  eq(out.map((e) => e.propId), ['poster-1'], 'a prop that failed to serialize is skipped, not published as null');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
