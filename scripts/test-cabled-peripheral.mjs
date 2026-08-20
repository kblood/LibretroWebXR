// Unit tests for the peripheral collapse (CLAUDE_REVIEW §3.3): the descriptor
// table [[src/CabledPeripheral.js]] and the one manager it parameterises,
// [[src/GhostPeripheralMgr.js]].
//
// WHY THIS SUITE EXISTS, and what it is actually guarding.
// src/main.js has no test coverage at all, so "the tests are still green" says
// nothing about a refactor that reaches into it. What CAN be pinned is the
// SEAM: three managers, three sets of hold-key helpers, and a pile of string
// literals that used to be written out per device in main.js now come from one
// table. If a value in that table is wrong — a swapped prefix, a mouse pointing
// at the gun's registry function, a reworded status label — the app breaks in a
// way only a headset would show. So every field the collapse moved out of
// main.js is asserted here against the literal it had BEFORE the move, and
// every registry field is asserted to be the very same function object
// systems.js exports (identity, not behaviour, so a swap can't hide behind two
// functions that agree on the case a test happens to try).
//
// Pure logic + THREE math: no DOM, no WebGL, no socket, no port. Runs in
// `npm test`.

import * as THREE from 'three';

// The gamepad ghost is a real gamepad mesh, and that mesh bakes its button
// labels into a 2D canvas (src/Gamepad.js makeLabel). Node has no DOM, so this
// is the same minimal stand-in scripts/test-session-lifecycle.mjs uses: nothing
// here is asserted on — the labels are decoration — it exists purely so the
// real manager can build a real mesh headless. (Static imports are hoisted
// above this, which is fine: src/Gamepad.js only touches document when a mesh
// is actually built, which is inside the tests below.)
globalThis.document = globalThis.document || {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => new Proxy({}, { get: () => () => {} }),
  }),
};

import {
  GAMEPAD, LIGHTGUN, MOUSE, CABLED_PERIPHERALS, ARMABLE_PERIPHERALS,
  peripheralForKind, makeHoldKeyFor, isHoldKeyFor, cableIdFromHoldKeyFor,
} from '../src/CabledPeripheral.js';
import { GhostPeripheralMgr } from '../src/GhostPeripheralMgr.js';
import {
  isLightgunCapable, lightgunForSystem, lightgunLoadConfig,
  twoGunPortsForSystem, libretroGunPortFor,
  isMouseCapable, mouseForSystem, mouseLoadConfig,
  twoMousePortsForSystem, libretroMousePortFor,
} from '../src/systems.js';
import { GhostGamepadMgr, makeGamepadHoldKey, isGamepadHoldKey, cableIdFromHoldKey, GP_HOLD_PREFIX } from '../src/GhostGamepadMgr.js';
import { GhostLightGunMgr, makeGunHoldKey, isGunHoldKey, cableIdFromGunHoldKey, GUN_HOLD_PREFIX } from '../src/GhostLightGunMgr.js';
import { GhostMouseMgr, makeMouseHoldKey, isMouseHoldKey, cableIdFromMouseHoldKey, MOUSE_HOLD_PREFIX } from '../src/GhostMouseMgr.js';
import { createLightGun } from '../src/LightGun.js';

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
};

// ---------------------------------------------------------------------------
// 1. The table itself — exactly three port-bound devices, in the shipped order
// ---------------------------------------------------------------------------
console.log('--- the descriptor table');
{
  ok(CABLED_PERIPHERALS.length === 3, 'three port-bound peripherals');
  ok(CABLED_PERIPHERALS[0] === GAMEPAD && CABLED_PERIPHERALS[1] === LIGHTGUN && CABLED_PERIPHERALS[2] === MOUSE,
    'order is gamepad, lightgun, mouse (the ghost-slice + wiring order main.js relies on)');
  ok(CABLED_PERIPHERALS.map((d) => d.kind).join(',') === 'gamepad,lightgun,mouse',
    'kinds are exactly the three GrabMgr.NETWORK_LOCKABLE_KINDS is derived from');
  ok(ARMABLE_PERIPHERALS.length === 2 && ARMABLE_PERIPHERALS.every((d) => d !== GAMEPAD),
    'only the gun and the mouse are armable — a gamepad needs no reboot to attach');
  // The cartridge is deliberately NOT in here (it is not port-bound, not armable).
  ok(!CABLED_PERIPHERALS.some((d) => d.kind === 'cartridge'), 'the cartridge was left out on purpose');

  ok(peripheralForKind('lightgun') === LIGHTGUN, 'peripheralForKind maps a prop kind to its descriptor');
  ok(peripheralForKind('mouse') === MOUSE, 'peripheralForKind: mouse');
  ok(peripheralForKind('gamepad') === GAMEPAD, 'peripheralForKind: gamepad');
  ok(peripheralForKind('cartridge') === null, 'peripheralForKind: a cartridge has no descriptor');
  ok(peripheralForKind(undefined) === null, 'peripheralForKind: undefined kind is null, not a throw');
}

// ---------------------------------------------------------------------------
// 2. Every literal the collapse moved out of main.js, pinned to its old value
// ---------------------------------------------------------------------------
console.log('--- per-device literals (each is what main.js hard-coded before)');
{
  // hold-key namespaces: these are ON THE WIRE. A change here silently splits a
  // room in two (old peers publish hold:gun:, new peers listen for something else).
  ok(GAMEPAD.holdKeyPrefix === 'gp:', 'gamepad hold prefix is gp:');
  ok(LIGHTGUN.holdKeyPrefix === 'gun:', 'gun hold prefix is gun:');
  ok(MOUSE.holdKeyPrefix === 'mouse:', 'mouse hold prefix is mouse:');

  // cableId prefixes: the default props are gp-1 / gun-1 / mouse-1 on EVERY peer.
  ok(GAMEPAD.cableIdPrefix === 'gp-', 'gamepad cableIds are gp-N');
  ok(LIGHTGUN.cableIdPrefix === 'gun-', 'gun cableIds are gun-N');
  ok(MOUSE.cableIdPrefix === 'mouse-', 'mouse cableIds are mouse-N');

  // sessionStorage keys: a rename silently drops every user's sticky arm state.
  ok(LIGHTGUN.sessionKey === 'libretrowebxr.lightgun', 'gun session key unchanged');
  ok(MOUSE.sessionKey === 'libretrowebxr.mouse', 'mouse session key unchanged');
  ok(GAMEPAD.sessionKey === null, 'a gamepad has no session arm key');

  // window flags: probes, the desktop harness and __gunArmedState all read these.
  ok(LIGHTGUN.armKey === '__lightgunArmed', 'gun arm flag is window.__lightgunArmed');
  ok(MOUSE.armKey === '__mouseArmed', 'mouse arm flag is window.__mouseArmed');

  // 'peripheral' wire device names (host-applied arm/disarm across the room).
  ok(LIGHTGUN.wireDevice === 'gun', "gun's wire device name is 'gun', not 'lightgun'");
  ok(MOUSE.wireDevice === 'mouse', "mouse's wire device name is 'mouse'");

  // ROM-meta flags: meta.lightgun / meta.mouse mean "this game declares it", and
  // that is what stops a disarm from taking the device off a curated gun title.
  ok(LIGHTGUN.metaFlag === 'lightgun', 'gun meta flag is meta.lightgun');
  ok(MOUSE.metaFlag === 'mouse', 'mouse meta flag is meta.mouse');

  // Status-line wording. Two labels per device on purpose: the shipped strings
  // are "no light gun connected" but "gun disarmed".
  ok(LIGHTGUN.label === 'light gun' && LIGHTGUN.shortLabel === 'gun', 'gun keeps BOTH of its shipped labels');
  ok(MOUSE.label === 'mouse' && MOUSE.shortLabel === 'mouse', 'the mouse reads the same either way');

  // Telemetry event names are built as `${desc.id}-arm-reboot` etc., so the id
  // is load-bearing for the headset logs that diagnose a gun boot.
  ok(LIGHTGUN.id === 'lightgun', "gun id is 'lightgun' (lightgun-arm-reboot, lightgun-grab, lightgun-disarm)");
  ok(MOUSE.id === 'mouse', "mouse id is 'mouse' (mouse-arm-reboot, mouse-grab, mouse-disarm)");
}

// ---------------------------------------------------------------------------
// 2b. The strings main.js now COMPOSES from those fields
// ---------------------------------------------------------------------------
// main.js builds its telemetry event names and status lines out of the
// descriptor now (`${desc.id}-arm-reboot`, `no ${desc.label} connected`, …)
// instead of writing each one twice. Spelled out here so the shipped text is
// visible in a test rather than only inside a template literal in an 8000-line
// file no suite can import.
console.log('--- the strings main.js composes from the descriptor');
{
  const ev = (d, suffix) => `${d.id}${suffix}`;
  ok(ev(LIGHTGUN, '-grab') === 'lightgun-grab', 'lightgun-grab');
  ok(ev(MOUSE, '-grab') === 'mouse-grab', 'mouse-grab');
  ok(ev(LIGHTGUN, '-arm-reboot-fallback') === 'lightgun-arm-reboot-fallback', 'lightgun-arm-reboot-fallback');
  ok(ev(MOUSE, '-arm-reboot-fallback') === 'mouse-arm-reboot-fallback', 'mouse-arm-reboot-fallback');
  ok(ev(LIGHTGUN, '-disarm') === 'lightgun-disarm', 'lightgun-disarm');
  ok(ev(MOUSE, '-disarm-fail') === 'mouse-disarm-fail', 'mouse-disarm-fail');

  ok(`no ${LIGHTGUN.label} connected` === 'no light gun connected', 'no light gun connected');
  ok(`no ${MOUSE.label} connected` === 'no mouse connected', 'no mouse connected');
  ok(`${LIGHTGUN.shortLabel} disarmed` === 'gun disarmed', 'gun disarmed (NOT "light gun disarmed")');
  ok(`${MOUSE.shortLabel} disarmed` === 'mouse disarmed', 'mouse disarmed');
  ok(`${LIGHTGUN.shortLabel} stays connected for this game` === 'gun stays connected for this game', 'gun stays connected for this game');
  ok(`disconnecting ${LIGHTGUN.label}…` === 'disconnecting light gun…', 'disconnecting light gun…');
  ok(`${LIGHTGUN.label} disconnected` === 'light gun disconnected', 'light gun disconnected');
  ok(`could not connect the ${MOUSE.label}` === 'could not connect the mouse', 'could not connect the mouse');
  ok(`could not disconnect the ${LIGHTGUN.label}` === 'could not disconnect the light gun', 'could not disconnect the light gun');
}

// ---------------------------------------------------------------------------
// 3. The registry references point at THE SAME functions systems.js exports
// ---------------------------------------------------------------------------
console.log('--- registry wiring (identity, so a device cannot be cross-wired)');
{
  ok(LIGHTGUN.capableFor === isLightgunCapable, 'LIGHTGUN.capableFor IS isLightgunCapable');
  ok(LIGHTGUN.deviceFor === lightgunForSystem, 'LIGHTGUN.deviceFor IS lightgunForSystem');
  ok(LIGHTGUN.loadConfigFor === lightgunLoadConfig, 'LIGHTGUN.loadConfigFor IS lightgunLoadConfig');
  ok(LIGHTGUN.twoPortsFor === twoGunPortsForSystem, 'LIGHTGUN.twoPortsFor IS twoGunPortsForSystem');
  ok(LIGHTGUN.libretroPortFor === libretroGunPortFor, 'LIGHTGUN.libretroPortFor IS libretroGunPortFor');

  ok(MOUSE.capableFor === isMouseCapable, 'MOUSE.capableFor IS isMouseCapable');
  ok(MOUSE.deviceFor === mouseForSystem, 'MOUSE.deviceFor IS mouseForSystem');
  ok(MOUSE.loadConfigFor === mouseLoadConfig, 'MOUSE.loadConfigFor IS mouseLoadConfig');
  ok(MOUSE.twoPortsFor === twoMousePortsForSystem, 'MOUSE.twoPortsFor IS twoMousePortsForSystem');
  ok(MOUSE.libretroPortFor === libretroMousePortFor, 'MOUSE.libretroPortFor IS libretroMousePortFor');

  // The gamepad has no per-system registry pair and must not borrow one.
  ok(GAMEPAD.capableFor === null && GAMEPAD.loadConfigFor === null && GAMEPAD.twoPortsFor === null,
    'the gamepad has no registry functions to borrow');

  // And the hardware facts still arrive through the descriptor, not just the
  // module: SNES two-gun co-op seats its guns on libretro ports [1,2] (Justifier),
  // Amiga split-pointer on [0,1] — the numbers a jack-to-player mapping depends on.
  ok(JSON.stringify(LIGHTGUN.twoPortsFor('snes')) === '[1,2]', 'SNES Justifier still resolves to ports [1,2] through the descriptor');
  ok(JSON.stringify(MOUSE.twoPortsFor('amiga')) === '[0,1]', 'Amiga two-mouse still resolves to ports [0,1]');
  ok(LIGHTGUN.libretroPortFor(0, LIGHTGUN.twoPortsFor('snes')) === 1, 'first gun in jack order drives libretro port 1');
  ok(LIGHTGUN.libretroPortFor(1, LIGHTGUN.twoPortsFor('snes')) === 2, 'second gun in jack order drives libretro port 2');
  ok(LIGHTGUN.libretroPortFor(2, LIGHTGUN.twoPortsFor('snes')) === null, 'a third gun has no port (single-gun DOM path)');
  ok(LIGHTGUN.libretroPortFor(0, LIGHTGUN.twoPortsFor('nes')) === null, 'a single-gun system yields no two-gun port');
  ok(LIGHTGUN.deviceFor('nes')?.label === 'Zapper', 'the NES gun descriptor still comes back through deviceFor');
  ok(LIGHTGUN.capableFor('nes') === true && LIGHTGUN.capableFor('gb') === false, 'capableFor still gates by system');
  ok(MOUSE.capableFor('amiga') === true && MOUSE.capableFor('nes') === false, 'the mouse is not offered on the NES');
  ok(LIGHTGUN.loadConfigFor('nes')?.guns?.length === 1, 'the single-gun boot config still builds');
  ok(LIGHTGUN.loadConfigFor('snes', { twoGun: true })?.guns?.length === 2, 'the two-gun boot config still builds');
  ok(MOUSE.loadConfigFor('amiga', { twoMouse: true })?.mice?.length === 2, 'the two-mouse boot config still builds');
}

// ---------------------------------------------------------------------------
// 4. Hold-key helpers: one implementation, three namespaces that never collide
// ---------------------------------------------------------------------------
console.log('--- hold keys');
{
  ok(makeHoldKeyFor(GAMEPAD, 'gp-1') === 'hold:gp:gp-1', 'gamepad hold key');
  ok(makeHoldKeyFor(LIGHTGUN, 'gun-1') === 'hold:gun:gun-1', 'gun hold key');
  ok(makeHoldKeyFor(MOUSE, 'mouse-1') === 'hold:mouse:mouse-1', 'mouse hold key');

  ok(isHoldKeyFor(LIGHTGUN, 'hold:gun:gun-1'), 'a gun key is a gun key');
  ok(!isHoldKeyFor(LIGHTGUN, 'hold:gp:gp-1'), 'a gamepad key is not a gun key');
  ok(!isHoldKeyFor(MOUSE, 'hold:gun:gun-1'), 'a gun key is not a mouse key');
  ok(!isHoldKeyFor(MOUSE, null), 'a null key is nobody\'s key');
  ok(cableIdFromHoldKeyFor(LIGHTGUN, 'hold:gun:gun-alice-2') === 'gun-alice-2', 'peer-scoped cableId round-trips');
  ok(cableIdFromHoldKeyFor(LIGHTGUN, 'hold:pong.nes') === null, 'a cart hold is not a gun hold');

  // Cross-namespace: no two descriptors can claim the same key.
  const keys = CABLED_PERIPHERALS.map((d) => makeHoldKeyFor(d, 'x'));
  ok(new Set(keys).size === 3, 'the three namespaces are distinct for the same cableId');
  for (const d of CABLED_PERIPHERALS) {
    const mine = makeHoldKeyFor(d, 'x');
    ok(CABLED_PERIPHERALS.filter((o) => isHoldKeyFor(o, mine)).length === 1,
      `${d.id}'s hold key is claimed by exactly one descriptor`);
  }
}

// ---------------------------------------------------------------------------
// 5. The old per-device helpers (the shims) still produce identical keys
// ---------------------------------------------------------------------------
console.log('--- the Ghost*Mgr shims keep the old API');
{
  ok(GP_HOLD_PREFIX === 'gp:' && GUN_HOLD_PREFIX === 'gun:' && MOUSE_HOLD_PREFIX === 'mouse:', 'the exported prefixes are unchanged');
  ok(makeGamepadHoldKey('gp-2') === makeHoldKeyFor(GAMEPAD, 'gp-2'), 'makeGamepadHoldKey == makeHoldKeyFor(GAMEPAD)');
  ok(makeGunHoldKey('gun-2') === makeHoldKeyFor(LIGHTGUN, 'gun-2'), 'makeGunHoldKey == makeHoldKeyFor(LIGHTGUN)');
  ok(makeMouseHoldKey('mouse-2') === makeHoldKeyFor(MOUSE, 'mouse-2'), 'makeMouseHoldKey == makeHoldKeyFor(MOUSE)');
  ok(isGamepadHoldKey('hold:gp:gp-1') && !isGamepadHoldKey('hold:gun:gun-1'), 'isGamepadHoldKey still discriminates');
  ok(isGunHoldKey('hold:gun:gun-1') && !isGunHoldKey('hold:mouse:mouse-1'), 'isGunHoldKey still discriminates');
  ok(isMouseHoldKey('hold:mouse:mouse-1') && !isMouseHoldKey('hold:gp:gp-1'), 'isMouseHoldKey still discriminates');
  ok(cableIdFromHoldKey('hold:gp:gp-3') === 'gp-3', 'cableIdFromHoldKey still extracts');
  ok(cableIdFromGunHoldKey('hold:gun:gun-3') === 'gun-3', 'cableIdFromGunHoldKey still extracts');
  ok(cableIdFromMouseHoldKey('hold:mouse:mouse-3') === 'mouse-3', 'cableIdFromMouseHoldKey still extracts');

  // main.js's session cleanup registers removeAll() on each of these by name;
  // scripts/test-session-lifecycle.mjs asserts the same thing from the other side.
  for (const [name, cls] of [['GhostGamepadMgr', GhostGamepadMgr], ['GhostLightGunMgr', GhostLightGunMgr], ['GhostMouseMgr', GhostMouseMgr]]) {
    ok(typeof cls.prototype.removeAll === 'function', `${name}.removeAll() survives the shim`);
    ok(cls.prototype instanceof GhostPeripheralMgr || Object.getPrototypeOf(cls.prototype) === GhostPeripheralMgr.prototype,
      `${name} is the one manager underneath`);
  }
  // …and the shims still take their OLD constructor option name.
  const shim = new GhostLightGunMgr({ avatars: stubAvatars(), lightGunObjs: new Map() });
  ok(shim.objs instanceof Map && shim.lightGunObjs === shim.objs, 'GhostLightGunMgr({lightGunObjs}) still wires the index');
  ok(shim.desc === LIGHTGUN, 'and carries the right descriptor');
}

// ---------------------------------------------------------------------------
// 6. GhostPeripheralMgr behaves the same for all three descriptors
// ---------------------------------------------------------------------------
function stubAvatars(hands = {}) {
  return {
    getHand: (peer, hand) => hands[`${peer}:${hand}`] || null,
    getHead: (peer) => hands[`${peer}:head`] || null,
  };
}
function fakeProp() { const o = new THREE.Group(); o.visible = true; return o; }

console.log('--- one manager, three devices: hold tracking + hide/unhide');
for (const desc of CABLED_PERIPHERALS) {
  const id = `${desc.cableIdPrefix}1`;
  const prop = fakeProp();
  const hand = new THREE.Group();
  const mgr = new GhostPeripheralMgr(desc, {
    avatars: stubAvatars({ 'alice:right': hand }),
    objs: new Map([[id, prop]]),
  });

  ok(!mgr.isRemotelyHeld(id), `${desc.id}: nothing is held to begin with`);

  mgr.sync([{ objId: id, holder: 'alice', hand: 'right' }]);
  ok(mgr.isRemotelyHeld(id), `${desc.id}: a remote hold locks the local prop`);
  ok(mgr.heldBy(id) === 'alice', `${desc.id}: heldBy names the holder`);
  ok(mgr.hasGhost(id) && mgr.ghostCount === 1, `${desc.id}: a ghost is attached`);
  ok(hand.children.length === 1, `${desc.id}: the ghost hangs off the holder's HAND (so it tracks their aim)`);
  ok(prop.visible === false && mgr.isHidden(id), `${desc.id}: the real local prop is hidden`);

  // Idempotent: syncing the same hold again must not spawn a second ghost.
  mgr.sync([{ objId: id, holder: 'alice', hand: 'right' }]);
  ok(mgr.ghostCount === 1 && hand.children.length === 1, `${desc.id}: re-syncing the same hold is idempotent`);

  mgr.sync([]);
  ok(!mgr.isRemotelyHeld(id) && mgr.ghostCount === 0, `${desc.id}: releasing clears the lock and the ghost`);
  ok(prop.visible === true && !mgr.isHidden(id), `${desc.id}: and un-hides the real prop`);
  ok(hand.children.length === 0, `${desc.id}: the ghost is detached from the hand`);
}

console.log('--- the hide-without-ghost sweep (hold ends before the avatar exists)');
for (const desc of CABLED_PERIPHERALS) {
  const id = `${desc.cableIdPrefix}1`;
  const prop = fakeProp();
  // No hands, no head: the ghost can never attach…
  const mgr = new GhostPeripheralMgr(desc, { avatars: stubAvatars(), objs: new Map([[id, prop]]) });
  mgr.sync([{ objId: id, holder: 'ghosty', hand: 'right' }]);
  ok(prop.visible === false, `${desc.id}: hidden even though no ghost could be created`);
  ok(mgr.ghostCount === 0, `${desc.id}: …and no ghost was created`);
  mgr.sync([]);
  ok(prop.visible === true, `${desc.id}: the independent sweep still un-hides it (else it is invisible forever)`);
}

console.log('--- removeAll (the Leave path) and holder handover');
for (const desc of CABLED_PERIPHERALS) {
  const id = `${desc.cableIdPrefix}1`;
  const prop = fakeProp();
  const aliceHand = new THREE.Group();
  const bobHand = new THREE.Group();
  const mgr = new GhostPeripheralMgr(desc, {
    avatars: stubAvatars({ 'alice:right': aliceHand, 'bob:left': bobHand }),
    objs: new Map([[id, prop]]),
  });
  mgr.sync([{ objId: id, holder: 'alice', hand: 'right' }]);
  mgr.sync([{ objId: id, holder: 'bob', hand: 'left' }]);
  ok(aliceHand.children.length === 0 && bobHand.children.length === 1, `${desc.id}: a holder change moves the ghost`);
  ok(mgr.heldBy(id) === 'bob', `${desc.id}: heldBy follows the new holder`);

  mgr.removeAll();
  ok(mgr.ghostCount === 0 && mgr.hiddenCount === 0, `${desc.id}: removeAll drops every ghost`);
  ok(prop.visible === true, `${desc.id}: and un-hides the local prop — the whole point of the Leave cleanup`);
  ok(mgr.removeAll() === undefined && mgr.ghostCount === 0, `${desc.id}: removeAll is repeatable`);
}

// ---------------------------------------------------------------------------
// 7. The per-device differences the collapse had to KEEP
// ---------------------------------------------------------------------------
console.log('--- per-device differences that must survive');
{
  // (a) Only the gamepad mirrors live input. The other two carry the same code
  //     path but are never fed, which is exactly how it behaved before.
  ok(GAMEPAD.mirrorsInput === true, 'the gamepad mirrors button state (the gp wire channel)');
  ok(LIGHTGUN.mirrorsInput === false, "a remote gun's trigger-pull is deliberately NOT mirrored");
  ok(MOUSE.mirrorsInput === false, "a remote mouse's cursor motion is deliberately NOT mirrored");

  const hand = new THREE.Group();
  const mgr = new GhostPeripheralMgr(GAMEPAD, { avatars: stubAvatars({ 'alice:right': hand }), objs: new Map() });
  // Input that arrives BEFORE the ghost exists is replayed onto it on spawn.
  mgr.applyInput('gp-1', { a: true });
  let sawInput = null;
  mgr.sync([{ objId: 'gp-1', holder: 'alice', hand: 'right' }]);
  const ghost = hand.children[0];
  ghost.userData.setInput = (v) => { sawInput = v; };
  mgr.applyInput('gp-1', { b: true });
  ok(sawInput && sawInput.b === true, 'applyInput reaches a live ghost');
  mgr.applyInput('gp-1', null);
  ok(sawInput.b === true, 'a null payload is ignored rather than blanking the ghost');

  // (b) The gamepad ghost is tinted by WHICH PLAYER the pad drives; the gun and
  //     mouse ghosts are plain translucent. Both tints are per-instance, so a
  //     ghost never mutates the real prop's materials.
  const mat = (o) => { let m = null; o.traverse((c) => { if (!m && c.material && !Array.isArray(c.material) && c.material.emissive) m = c.material; }); return m; };
  const gpMat = mat(ghost);
  ok(gpMat && gpMat.transparent === true && gpMat.opacity === 0.7, 'the gamepad ghost is translucent');
  ok(gpMat && gpMat.emissiveIntensity >= 0.35, 'the gamepad ghost is emissively tinted by its player');

  const gunHand = new THREE.Group();
  const gunMgr = new GhostPeripheralMgr(LIGHTGUN, { avatars: stubAvatars({ 'alice:right': gunHand }), objs: new Map() });
  gunMgr.sync([{ objId: 'gun-1', holder: 'alice', hand: 'right' }]);
  const realGun = createLightGun({});
  const realMat = mat(realGun);
  ok(realMat && realMat.transparent === false, 'a REAL gun is opaque — the ghost tint did not leak into the shared material');

  // (c) Head fallback (desktop, no hands) uses the descriptor's head offset, and
  //     the two families of offsets are genuinely different values.
  const head = new THREE.Group();
  const deskMgr = new GhostPeripheralMgr(MOUSE, { avatars: stubAvatars({ 'alice:head': head }), objs: new Map() });
  deskMgr.sync([{ objId: 'mouse-1', holder: 'alice', hand: null }]);
  ok(head.children.length === 1, 'with no hand the ghost falls back to the head (desktop peer)');
  ok(head.children[0].position.equals(MOUSE.ghostHeadOffset), 'and sits at the descriptor HEAD offset');
  ok(!GAMEPAD.ghostHandOffset.equals(LIGHTGUN.ghostHandOffset), 'the gamepad keeps its own hand offset (-0.06, not -0.05)');
  ok(LIGHTGUN.ghostHandOffset.equals(MOUSE.ghostHandOffset), 'gun and mouse share theirs, as they did before');
}

// ---------------------------------------------------------------------------
// 8. Each descriptor builds ITS OWN mesh (a cross-wired factory would be silent)
// ---------------------------------------------------------------------------
console.log('--- ghost meshes come from the right factory');
{
  const shapes = new Map();
  for (const desc of CABLED_PERIPHERALS) {
    const hand = new THREE.Group();
    const mgr = new GhostPeripheralMgr(desc, { avatars: stubAvatars({ 'alice:right': hand }), objs: new Map() });
    mgr.sync([{ objId: `${desc.cableIdPrefix}1`, holder: 'alice', hand: 'right' }]);
    let tris = 0;
    hand.children[0].traverse((o) => { if (o.geometry) tris += o.geometry.attributes?.position?.count || 0; });
    shapes.set(desc.id, `${hand.children[0].children.length}:${tris}`);
    ok(tris > 0, `${desc.id}: the ghost is a real mesh, not an empty group`);
  }
  ok(new Set(shapes.values()).size === 3,
    'the three ghosts are three DIFFERENT meshes (a swapped ghostFactory would collapse this)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
