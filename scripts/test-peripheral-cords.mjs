// Unit tests for the three patch-cord blocks ([[src/PeripheralCords.js]]).
//
// WHY THIS SUITE EXISTS. Nothing under scripts/ imports src/main.js, so a green
// run says nothing about code that lives there — which is exactly why "tests
// green between extractions" was called vacuous. PeripheralCords is step 4 of
// the P2 #12 extraction and this is what makes the move checkable: it drives the
// REAL module against the REAL [[src/Patchbay.js]], the REAL [[src/Snap.js]] and
// the REAL [[src/ConsoleRegistry.js]] — no stub of any of them — over real
// THREE.Object3D scene graphs, so the world-transform maths the cords depend on
// is the same maths that runs in the headset.
//
// Cords are net-synced, headset-validated behaviour, not decoration, so the
// assertions below deliberately pin the parts that a "tidy-up" would break and
// that no other test covers:
//   * the port→player arithmetic `(seat?.port ?? 0) + 1` that colours a cord;
//   * WHICH state key a re-plug broadcasts on — gun:/mouse:/gamepad: is chosen by
//     which registry owns the cableId, and getting it wrong silently desyncs a
//     peer's port→player mapping;
//   * "one physical cable = one output" for video (a repatch drops the console's
//     prior TV edge FIRST);
//   * the free/`mine`/`activePorts` filter on controller port jacks;
//   * the keyboard's PER-CONSOLE `keyboardJackRadius`, which deliberately is NOT
//     PLUG_SNAP_RADIUS;
//   * the late-bound bindings the extraction had to turn into getters — grabMgr,
//     gameInput, c64kbd and (inside the keystroke closure, not around it) net.
//     A value captured at construction would be a permanently-stale null, and
//     _kbdSendInputFor freezing `net` would stop a peer forwarding after a
//     reconnect. Both are asserted directly.
//
// Pure logic: no ports, no browser, no WebGL. THREE builds geometry on the CPU
// and getWorldPosition only walks matrices, so nothing here needs a GL context.

import * as THREE from 'three';
import { createPeripheralCords } from '../src/PeripheralCords.js';
import { createConsoleRegistry } from '../src/ConsoleRegistry.js';
import { Patchbay } from '../src/Patchbay.js';

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
};
const eq = (a, b, msg) => ok(Object.is(a, b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const near = (a, b, msg, tol = 1e-6) => ok(Math.abs(a - b) < tol, `${msg} (got ${a}, want ${b})`);

// --- Scene-graph fixtures -----------------------------------------------------
const world = (obj) => { const v = new THREE.Vector3(); obj.getWorldPosition(v); return v; };

function makeConsoleObj(root, id, { ports = 2, activePorts, kbdRadius, x = 0 } = {}) {
  const obj = new THREE.Object3D();
  obj.name = id;
  obj.position.set(x, 0.75, -2);
  const portJacks = [];
  for (let i = 0; i < ports; i++) {
    const j = new THREE.Object3D();
    j.position.set(i * 0.6, 0, 0.15);     // 0.6 m apart: far outside PLUG_SNAP_RADIUS
    obj.add(j);
    portJacks.push(j);
  }
  const videoOutAnchor = new THREE.Object3D();
  videoOutAnchor.position.set(0, 0, -0.15);
  obj.add(videoOutAnchor);
  const keyboardJack = new THREE.Object3D();
  keyboardJack.position.set(-0.2, 0.04, -0.15);
  obj.add(keyboardJack);
  obj.userData = { portJacks, activePorts, videoOutAnchor, keyboardJack, keyboardJackRadius: kbdRadius };
  root.add(obj);
  return obj;
}

function makeTV(root, id, x) {
  const group = new THREE.Object3D();
  group.position.set(x, 1.5, -3.6);
  const videoIn = new THREE.Object3D();
  videoIn.position.set(-0.9, -0.7, 0.03);
  group.add(videoIn);
  root.add(group);
  return { id, group, videoIn };
}

function makeCabledObj(root, cableId) {
  const obj = new THREE.Object3D();
  obj.position.set(0.4, 0.9, -1.2);
  const cordAnchor = new THREE.Object3D();
  cordAnchor.position.set(0, -0.03, 0.05);
  obj.add(cordAnchor);
  obj.userData = { cableId, cordAnchor };
  root.add(obj);
  return obj;
}

// --- The rig main.js builds, with every injected dep observable ---------------
function makeRig({ isHost = true } = {}) {
  const root = new THREE.Object3D();
  const calls = { routeVideo: 0, persistRack: 0, flushReleases: 0, events: [], grabbables: [] };

  let grabMgr = null;                 // assigned late, exactly like main.js
  let gameInput = null;
  let c64kbd = null;
  let net = null;
  let kbdTarget = null;
  let host = isHost;

  const cable = new Patchbay();
  const registry = createConsoleRegistry({ getGrabMgr: () => grabMgr });
  const heldSet = new Set();

  const scene = {
    _tvs: [],
    addObject: (o) => { root.add(o); },
    getTV: (id) => scene._tvs.find((t) => t.id === id) || null,
  };

  const sentInputs = [];
  const rackMgr = {
    get: (id) => ({ sendInput: (...a) => sentInputs.push([id, ...a]) }),
  };

  const cordColorRequests = [];
  const cabledObjs = new Map();
  const lightGunObjsById = new Map();
  const mouseObjsById = new Map();

  const cords = createPeripheralCords({
    registry,
    scene,
    cable,
    rackMgr,
    routeVideo: () => { calls.routeVideo++; },
    persistRack: () => { calls.persistRack++; },
    logger: { event: (name, data) => calls.events.push([name, data]) },
    getGrabMgr: () => grabMgr,
    getNet: () => net,
    getGameInput: () => gameInput,
    getC64kbd: () => c64kbd,
    getKbdTarget: () => kbdTarget,
    setKbdTarget: (v) => { kbdTarget = v; },
    cordColorForPlayer: (player) => { cordColorRequests.push(player); return 0x100000 + player; },
    _cabledObjFor: (cableId) => cabledObjs.get(cableId) || null,
    _lightGunObjsById: lightGunObjsById,
    _mouseObjsById: mouseObjsById,
    amRoomHost: () => host,
    KBD_ID: 'kbd-primary',
    CONSOLE_ID: 'console0',
  });

  const rig = {
    root, cords, cable, registry, scene, calls, cordColorRequests,
    cabledObjs, lightGunObjsById, mouseObjsById, sentInputs, heldSet,
    kbdTarget: () => kbdTarget,
    setHost: (v) => { host = v; },
    net: () => net,
    useNet: (n) => { net = n; return n; },
    useGameInput: () => {
      gameInput = { flushReleases: () => { calls.flushReleases++; } };
      return gameInput;
    },
    useGrabMgr: () => {
      grabMgr = {
        addGrabbable: (o) => calls.grabbables.push(o),
        isHeld: (o) => heldSet.has(o),
      };
      return grabMgr;
    },
    useKeyboard: () => {
      const object3d = new THREE.Object3D();
      object3d.position.set(-0.35, 0.72, -2.15);
      object3d.visible = true;
      root.add(object3d);
      c64kbd = {
        object3d,
        cordAnchor: null,
        layouts: [],
        flushes: 0,
        sendInput: null,
        flushReleases() { c64kbd.flushes++; },
        setSendInput(fn) { c64kbd.sendInput = fn; },
        setLayout(l) { c64kbd.layouts.push(l); },
      };
      return c64kbd;
    },
    addConsole: (id, opts) => {
      const obj = makeConsoleObj(root, id, opts);
      registry.consoleObjs.set(id, obj);
      cable.addConsole(id, { ports: obj.userData.portJacks.length });
      return obj;
    },
    addTV: (id, x) => { const tv = makeTV(root, id, x); scene._tvs.push(tv); cable.addTV(id); return tv; },
    addCabled: (cableId) => { const o = makeCabledObj(root, cableId); cabledObjs.set(cableId, o); return o; },
  };
  return rig;
}

const makeNet = () => {
  const states = [], wires = [];
  return { states, wires, setObjectState: (k, v) => states.push([k, v]), sendWire: (k, v) => wires.push([k, v]) };
};

// A release with no ray = "dropped here"; the position IS the decision.
function releaseAt(cords, plugGroup, pos, ray = undefined) {
  plugGroup.position.copy(pos);
  cords.handlePlugReleased(plugGroup, ray);
}

// ── Video cords ───────────────────────────────────────────────────────────────
{
  const rig = makeRig();
  rig.addConsole('console0');
  const tv0 = rig.addTV('tv0', 0);
  rig.addTV('tv1', 3);
  rig.cable.connectVideo('console0', 'tv0');

  // grabMgr is null at construction and assigned later (buildCartridgeWorld).
  // If the extraction had captured it by value, this plug would never become
  // grabbable — the whole cord feature would be dead in the headset.
  rig.useGrabMgr();
  rig.cords.addVideoPlug('console0', 'tv0');
  const rec = rig.cords.videoPlugs.get('console0');
  ok(!!rec?.plug && !!rec?.cord, 'video: addVideoPlug builds a plug + cord');
  eq(rig.calls.grabbables.length, 1, 'video: the plug was registered as grabbable through the late-bound grabMgr');
  const jack0 = world(tv0.videoIn);
  near(rec.plug.group.position.distanceTo(jack0), 0, 'video: the new plug is seated exactly on its TV jack');

  // Re-adding the same console must not build a second cable.
  rig.cords.addVideoPlug('console0', 'tv1');
  eq(rig.cords.videoPlugs.size, 1, 'video: addVideoPlug is idempotent per console');

  // One physical cable = one output: seating on tv1 drops the tv0 edge FIRST.
  const jack1 = world(rig.scene.getTV('tv1').videoIn);
  releaseAt(rig.cords, rec.plug.group, jack1.clone().add(new THREE.Vector3(0.05, 0, 0)));
  ok(rig.cable.displaysOf('console0').join(',') === 'tv1', 'video: repatch moved the feed to tv1 and dropped tv0');
  eq(rig.cable.sourceOf('tv0'), null, 'video: the old TV lost its source');
  ok(rig.calls.routeVideo > 0 && rig.calls.persistRack > 0, 'video: repatch re-routed and persisted');
  const ev = rig.calls.events.at(-1);
  ok(ev[0] === 'video-repatch' && ev[1].tv === 'tv1', 'video: logged video-repatch with the new TV');
  near(rec.plug.group.position.distanceTo(jack1), 0, 'video: the plug snapped onto the tv1 jack');

  // Dropped in mid-air = pull the cable out.
  releaseAt(rig.cords, rec.plug.group, new THREE.Vector3(0, 0.2, 0));
  eq(rig.cable.displaysOf('console0').length, 0, 'video: a mid-air drop clears the console video edge');
  eq(rig.calls.events.at(-1)[1].tv, null, 'video: the mid-air drop logged tv:null');

  // Point-and-place (Mechanism B): far from the jack, but aimed at it.
  const origin = new THREE.Vector3(0, 1.6, 0);
  const dir = jack0.clone().sub(origin);
  ok(dir.length() > 0.26, 'video: the point-and-place case really is outside the 0.26 m snap radius');
  releaseAt(rig.cords, rec.plug.group, origin.clone(), { origin, dir });
  ok(rig.cable.displaysOf('console0').join(',') === 'tv0', 'video: aiming at a jack from 3 m away repatches it');

  // Per-frame reshape: a held plug must NOT be re-seated (you are dragging it).
  rig.heldSet.add(rec.plug.group);
  rec.plug.group.position.set(0, 0.2, 0);
  rig.cords.syncVideoCords();
  near(rec.plug.group.position.y, 0.2, 'video: syncVideoCords leaves a HELD plug where the hand has it');
  rig.heldSet.delete(rec.plug.group);
  rig.cords.syncVideoCords();
  near(rec.plug.group.position.distanceTo(jack0), 0, 'video: syncVideoCords re-seats a released plug on its jack');
}

// ── Controller cords ──────────────────────────────────────────────────────────
{
  const rig = makeRig();
  const con = rig.addConsole('console0', { ports: 2 });
  rig.useGrabMgr();
  rig.useGameInput();
  const net = rig.useNet(makeNet());
  rig.addCabled('pad-a');
  rig.addCabled('pad-b');

  rig.cords.addControllerPlug(rig.cabledObjs.get('pad-a'));
  eq(rig.cordColorRequests.at(-1), 1, 'controller: an unplugged pad gets the player-1 cord colour ((port ?? 0) + 1)');
  const recA = rig.cords.controllerPlugs.get('pad-a');
  ok(!!recA, 'controller: addControllerPlug built the plug + cord');
  rig.cords.addControllerPlug(rig.cabledObjs.get('pad-a'));
  eq(rig.cords.controllerPlugs.size, 1, 'controller: addControllerPlug is idempotent per cableId');

  // The other half of `(seat?.port ?? 0) + 1`: a pad built while ALREADY seated
  // in port 1 is player 2. Asserting only the unplugged case above would let
  // `?? 1` through unnoticed, and every cord would then be miscoloured by one.
  const preSeated = rig.addCabled('pad-preseated');
  rig.cable.plugController('pad-preseated', 'console0', 1);
  rig.cords.addControllerPlug(preSeated);
  eq(rig.cordColorRequests.at(-1), 2, 'controller: a pad already seated in port 1 gets the player-2 cord colour');
  rig.cable.unplugController('pad-preseated');
  rig.cords.controllerPlugs.delete('pad-preseated');
  rig.cabledObjs.delete('pad-preseated');

  // Seat pad-a in port 1 by dropping its plug on that jack.
  const jack1 = world(con.userData.portJacks[1]);
  releaseAt(rig.cords, recA.plug.group, jack1.clone());
  const seatA = rig.cable.portOf('pad-a');
  ok(seatA && seatA.consoleId === 'console0' && seatA.port === 1, 'controller: the plug seated in console0 port 1');
  eq(rig.calls.flushReleases, 1, 'controller: a re-plug flushed keys held under the old seat');
  const st = net.states.at(-1);
  eq(st[0], 'gamepad:pad-a', 'controller: a gamepad re-plug broadcasts on the gamepad: STATE key');
  eq(st[1].port, 1, 'controller: the broadcast carries the new port');

  // A port already taken by ANOTHER pad is skipped; `mine` is not.
  rig.cords.addControllerPlug(rig.cabledObjs.get('pad-b'));
  const recB = rig.cords.controllerPlugs.get('pad-b');
  releaseAt(rig.cords, recB.plug.group, jack1.clone());
  eq(rig.cable.portOf('pad-b'), null, 'controller: a jack occupied by another pad is not offered');
  eq(net.states.at(-1)[1].port, -1, 'controller: the failed seat broadcast port -1 (unplugged)');
  releaseAt(rig.cords, recA.plug.group, jack1.clone());
  eq(rig.cable.portOf('pad-a').port, 1, 'controller: a pad may be re-seated in the port it already holds');

  // activePorts caps how many of a console's jacks are live (e.g. a 2-port core
  // on a 4-jack cabinet). Jack 3 exists in the mesh but must not be offered.
  const wide = rig.addConsole('console1', { ports: 4, activePorts: 1, x: 2 });
  const jack3 = world(wide.userData.portJacks[3]);
  releaseAt(rig.cords, recB.plug.group, jack3.clone());
  eq(rig.cable.portOf('pad-b'), null, 'controller: activePorts hides the jacks past the cap');
  const jackW0 = world(wide.userData.portJacks[0]);
  releaseAt(rig.cords, recB.plug.group, jackW0.clone());
  eq(rig.cable.portOf('pad-b')?.consoleId, 'console1', 'controller: the snap searches EVERY console in the rack');

  // Which STATE key a re-plug rides is decided by which registry owns the
  // cableId. This is the net-synced port binding; a wrong key desyncs a peer.
  const gun = rig.addCabled('gun-1');
  rig.lightGunObjsById.set('gun-1', gun);
  rig.cords.addControllerPlug(gun);
  releaseAt(rig.cords, rig.cords.controllerPlugs.get('gun-1').plug.group, world(con.userData.portJacks[0]));
  eq(net.states.at(-1)[0], 'gun:gun-1', 'controller: a light gun re-plug rides the gun: STATE key');
  const mouse = rig.addCabled('mouse-1');
  rig.mouseObjsById.set('mouse-1', mouse);
  rig.cords.addControllerPlug(mouse);
  releaseAt(rig.cords, rig.cords.controllerPlugs.get('mouse-1').plug.group, new THREE.Vector3(0, 0.2, 0));
  eq(net.states.at(-1)[0], 'mouse:mouse-1', 'controller: a mouse re-plug rides the mouse: STATE key');

  // Unplugged: the plug parks 8 cm above its peripheral, and the cord hides
  // entirely when the peripheral object is gone (a retired console's pad).
  rig.cords.syncControllerCords();
  const padA = rig.cabledObjs.get('pad-a');
  rig.cabledObjs.delete('pad-a');
  let hidden = null;
  recA.cord.setVisible = (v) => { hidden = v; };
  rig.cords.syncControllerCords();
  eq(hidden, false, 'controller: a cord with no peripheral at the other end is hidden');
  rig.cabledObjs.set('pad-a', padA);
}

// ── Keyboard cord ─────────────────────────────────────────────────────────────
{
  const rig = makeRig();
  // console0 keeps the default 0.19 m keyboard-jack radius; console1 declares a
  // deliberately tight 0.05 m one. Neither is PLUG_SNAP_RADIUS (0.26).
  const con0 = rig.addConsole('console0');
  const con1 = rig.addConsole('console1', { kbdRadius: 0.05, x: 2 });
  rig.useGrabMgr();
  const kbd = rig.useKeyboard();
  rig.cable.addKeyboard('kbd-primary');
  rig.registry._consoleSystems.set('console0', 'c64');
  rig.registry._consoleSystems.set('console1', 'nes');

  rig.cords.addKeyboardPlug(kbd.object3d);
  rig.cords.addKeyboardPlug(kbd.object3d);
  eq(rig.calls.grabbables.length, 1, 'keyboard: addKeyboardPlug is idempotent');

  // Boot wiring: connectKeyboardTo picks the layout from the console's system.
  rig.cords.connectKeyboardTo('console0');
  eq(rig.cable.consoleOfKeyboard('kbd-primary'), 'console0', 'keyboard: connect plugged it into console0 in the patchbay');
  eq(rig.kbdTarget(), 'console0', 'keyboard: connect set the shared _kbdTargetConsoleId through the injected setter');
  eq(kbd.layouts.at(-1), 'c64', 'keyboard: a keyboard-capable system selects the c64 layout');
  rig.cords.connectKeyboardTo('console1');
  eq(kbd.layouts.at(-1), 'standard', 'keyboard: a non-keyboard system falls back to the standard layout');
  rig.cords.connectKeyboardTo(null);
  eq(rig.kbdTarget(), 'console0', 'keyboard: connectKeyboardTo(null) falls back to CONSOLE_ID');

  // The snap uses the PER-CONSOLE keyboardJackRadius, not PLUG_SNAP_RADIUS.
  const kplug = rig.calls.grabbables[0];   // the keyboard plug's Object3D
  const jack1 = world(con1.userData.keyboardJack);
  releaseAt(rig.cords, kplug, jack1.clone().add(new THREE.Vector3(0.12, 0, 0)));
  eq(rig.cable.consoleOfKeyboard('kbd-primary'), null,
    'keyboard: 0.12 m from a jack whose radius is 0.05 does NOT connect (the 0.26 plug radius must not leak in)');
  eq(rig.kbdTarget(), null, 'keyboard: that miss was a true disconnect — null target');
  kbd.sendInput('keydown', 'KeyA', 'a', 65, 0);
  eq(rig.sentInputs.length, 0, 'keyboard: a disconnected keyboard drives no console at all');

  const jack0 = world(con0.userData.keyboardJack);
  releaseAt(rig.cords, kplug, jack0.clone().add(new THREE.Vector3(0.12, 0, 0)));
  eq(rig.cable.consoleOfKeyboard('kbd-primary'), 'console0',
    'keyboard: 0.12 m from a jack whose radius is the 0.19 default DOES connect');
  near(kplug.position.distanceTo(jack0), 0, 'keyboard: connecting seated the plug on the jack');
  eq(rig.calls.events.at(-1)[0], 'keyboard-repatch', 'keyboard: the repatch was logged');

  // Point-and-place across the room, using the ray path.
  const origin = new THREE.Vector3(0, 1.6, 0.5);
  const dir = jack1.clone().sub(origin);
  releaseAt(rig.cords, kplug, origin.clone(), { origin, dir });
  eq(rig.cable.consoleOfKeyboard('kbd-primary'), 'console1', 'keyboard: aiming at a DIN jack from across the room connects it');

  // Per-frame: the plug and cord only exist while the keyboard is on screen.
  rig.cords.syncKeyboardCord();
  ok(kplug.visible, 'keyboard: the plug is visible while the keyboard is shown');
  kbd.object3d.visible = false;
  rig.cords.syncKeyboardCord();
  eq(kplug.visible, false, 'keyboard: hiding the keyboard hides its grabbable plug too');
}

// ── _kbdSendInputFor: local dispatch + host forwarding, with a LIVE net ───────
{
  const rig = makeRig({ isHost: true });
  rig.addConsole('console0');
  rig.useGrabMgr();
  const kbd = rig.useKeyboard();
  rig.cable.addKeyboard('kbd-primary');
  const netA = rig.useNet(makeNet());

  const send = rig.cords._kbdSendInputFor('console0');
  send('keydown', 'KeyA', 'a', 65, 0);
  eq(rig.sentInputs.length, 1, 'kbd input: the host dispatches to its own console runtime');
  eq(netA.wires.length, 0, 'kbd input: the host does not forward its own keystrokes over the wire');

  rig.setHost(false);
  send('keydown', 'KeyB', 'b', 66, 0);
  eq(netA.wires.at(-1)?.[0], 'kbd', 'kbd input: a non-host peer ALSO forwards the keystroke on the kbd WIRE channel');
  eq(rig.sentInputs.length, 2, 'kbd input: a non-host peer still dispatches locally too');

  // THE RECONNECT CASE. `net` is reassigned on every connect/disconnect, so the
  // closure must read it at keystroke time, not at build time. If the extraction
  // had hoisted `const net = getNet()` to the top of _kbdSendInputFor like the
  // other getters, this keystroke would go to the DEAD session.
  const netB = rig.useNet(makeNet());
  send('keydown', 'KeyC', 'c', 67, 0);
  eq(netA.wires.length, 1, 'kbd input: the stale session got nothing after the reconnect');
  eq(netB.wires.length, 1, 'kbd input: the closure reads `net` live, so the new session got the keystroke');
  void kbd;
}

console.log(`test-peripheral-cords: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
