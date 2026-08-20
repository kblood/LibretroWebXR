// The three patch-cord blocks: video (console → TV), controller (gamepad /
// light gun / mouse → console port jack) and keyboard (keyboard → console DIN
// jack). One module, because they are one mechanism: they share the three snap
// tolerances below, and `handlePlugReleased` — the single GrabMgr release
// callback for every plug in the world — dispatches on plugKind into the
// controller and keyboard handlers. Splitting them into three files would put a
// dispatcher in one file and two of its three branches in others.
//
// Extracted VERBATIM from src/main.js (the P2 #12 / §3.1 extraction plan, step
// 4, following [[src/ConsoleRegistry.js]]'s prerequisite hoist, which is where
// `consoleObjs` and `_consoleSystems` now live). Same code, same order, same
// comments, same behaviour.
//
// ⚠ CORDS ARE NET-SYNCED, HEADSET-VALIDATED BEHAVIOUR, NOT DECORATION. A cord's
// port binding is what decides which player slot a peripheral drives: seating a
// controller plug calls cable.plugController(cableId, consoleId, port) and then
// _broadcastCablePort, which publishes the new port on the gun:/mouse:/gamepad:
// STATE key so every peer agrees on the port→player mapping. Nothing here may be
// "tidied" — in particular the `(seat?.port ?? 0) + 1` / `(port >= 0 ? port : 0) + 1`
// port→player-colour arithmetic and the per-console `keyboardJackRadius` snap
// (which deliberately does NOT use PLUG_SNAP_RADIUS) are load-bearing.
//
// THE ONLY EDITS MADE WHILE MOVING, all mechanical and all forced by the move:
//   * four late-bound `let`s in main.js are injected as GETTERS, because each is
//     assigned after this factory runs (`grabMgr`, `gameInput` and `c64kbd` when
//     buildCartridgeWorld runs; `net` on every connect/disconnect) and a value
//     captured at construction would be a permanently-stale null. Every function
//     that used one re-reads it with a single `const <name> = get<Name>();` line
//     at the top, so the body below it is character-for-character the original.
//     Same device as [[src/ConsoleRegistry.js]]'s registerMovableProp.
//   * `_kbdSendInputFor` is the ONE exception to that rule: it returns a closure
//     that runs on every keystroke, minutes later, so it calls `getNet()` INSIDE
//     the closure. Capturing `net` when the closure is BUILT would freeze a peer
//     to whatever session object existed at plug-in time and silently stop
//     forwarding after a reconnect.
//   * `_kbdTargetConsoleId` stays a `let` in main.js — it has readers and a
//     writer OUTSIDE the cord blocks, so it could not come along — and is
//     threaded in as getKbdTarget/setKbdTarget. Readers take
//     `const _kbdTargetConsoleId = getKbdTarget();`; the writers call
//     setKbdTarget(...). (Grep main.js for the symbol rather than trusting a
//     line number: this bullet used to cite five, and every one of them had
//     rotted by the time the first reader tried to check the claim.)
// Everything else injected (`scene`, `cable`, `rackMgr`, `routeVideo`,
// `persistRack`, `logger`, `cordColorForPlayer`, `_cabledObjFor`,
// `_lightGunObjsById`, `_mouseObjsById`, `amRoomHost`, `KBD_ID`, `CONSOLE_ID`) is
// a const or a hoisted function declaration in main.js by the time this factory
// is called, and is passed by value under its ORIGINAL name so the moved bodies
// did not have to change.

import * as THREE from 'three';
import { Cord } from './Cord.js';
import { Plug } from './Plug.js';
import { nearestAnchor, nearestAnchorAlongRay } from './Snap.js';
import { isKeyboardCapable } from './systems.js';
import { makeGamepadStateKey } from './net/GamepadSync.js';
import { makeGunStateKey } from './net/GunSync.js';
import { makeMouseStateKey } from './net/MouseSync.js';

export function createPeripheralCords({
  registry, scene, cable, rackMgr, routeVideo, persistRack, logger,
  getGrabMgr, getNet, getGameInput, getC64kbd, getKbdTarget, setKbdTarget,
  cordColorForPlayer, _cabledObjFor, _lightGunObjsById, _mouseObjsById,
  amRoomHost, KBD_ID, CONSOLE_ID,
}) {
  const { consoleObjs, _consoleSystems } = registry;

  // ── Video patch cords (console → TV) ────────────────────────────────────────
  // Each console has ONE physical video-out cable whose grabbable plug
  // ([[src/Plug.js]]) seats into a TV's video-in jack. Seating rewires the patch
  // graph (cable.connectVideo) and re-routes the texture; pulling the plug out and
  // dropping it in mid-air clears the console's video edge (EmuVR repatch). The
  // pure snap decision is [[src/Snap.js]]; the graph is [[src/Patchbay.js]].
  const PLUG_SNAP_RADIUS = 0.26;                     // m — jack acceptance radius
  // Point-and-place (Mechanism B): released-while-aiming tolerance for plugs,
  // mirroring GrabMgr's own SOCKET_RAY_MAX_PERP/RAY_RANGE for the other socket
  // kinds (cart slot, controller port, memory card).
  const PLUG_RAY_MAX_PERP = 0.25;
  const PLUG_RAY_MAX_DIST = 5.0;
  // `consoleObjs` (consoleId -> physical Console Object3D) is now owned by
  // [[src/ConsoleRegistry.js]] and destructured above.
  const videoPlugs = new Map();                      // consoleId -> { plug:Plug, cord:Cord }
  const _vp = new THREE.Vector3();
  const _vq = new THREE.Quaternion();

  // Snap a console's video plug onto a TV's video-in jack (world transform), so it
  // visually sits in the socket. tvId null leaves the plug where it is (dangling).
  function seatVideoPlug(consoleId, tvId) {
    const rec = videoPlugs.get(consoleId);
    const tv = tvId ? scene.getTV(tvId) : null;
    if (!rec || !tv?.videoIn) return;
    tv.videoIn.getWorldPosition(_vp);
    tv.videoIn.getWorldQuaternion(_vq);
    rec.plug.group.position.copy(_vp);
    rec.plug.group.quaternion.copy(_vq);
  }

  // Build the video-out plug + cord for a console and seat it at its starting TV.
  function addVideoPlug(consoleId, tvId) {
    const grabMgr = getGrabMgr();
    if (videoPlugs.has(consoleId)) return;
    const plug = new Plug({ id: `vplug-${consoleId}`, plugKind: 'video', sourceId: consoleId });
    scene.addObject(plug.group);
    grabMgr?.addGrabbable(plug.group);
    const cord = new Cord({ color: 0xccaa22 });
    scene.addObject(cord.mesh);
    videoPlugs.set(consoleId, { plug, cord });
    seatVideoPlug(consoleId, tvId);
  }

  // GrabMgr release handler: snap the plug to the nearest TV jack and repatch, or
  // pull the console's video if dropped away from every jack. `ray` (the
  // releasing controller's aim ray, from GrabMgr._controllerRay) lets a plug be
  // point-and-placed into a jack it's aimed at even when far from it.
  const _plugWorld = new THREE.Vector3();
  function handlePlugReleased(plugObj, ray) {
    const ud = plugObj.userData || {};
    if (ud.plugKind === 'controller') { handleControllerPlugReleased(plugObj, ray); return; }
    if (ud.plugKind === 'keyboard')   { handleKeyboardPlugReleased(plugObj, ray);   return; }
    if (ud.plugKind !== 'video') return;
    const consoleId = ud.sourceId;
    plugObj.getWorldPosition(_plugWorld);
    const anchors = scene._tvs.map((tv) => {
      const p = new THREE.Vector3();
      tv.videoIn.getWorldPosition(p);
      return { id: tv.id, x: p.x, y: p.y, z: p.z };
    });
    let hit = nearestAnchor({ x: _plugWorld.x, y: _plugWorld.y, z: _plugWorld.z }, anchors, PLUG_SNAP_RADIUS);
    if (!hit && ray) {
      hit = nearestAnchorAlongRay(ray.origin, ray.dir, anchors, {
        maxDist: PLUG_RAY_MAX_DIST, maxPerp: PLUG_RAY_MAX_PERP,
      });
    }
    // One physical cable = one output: drop the console's prior TV edge(s) first.
    for (const tvId of cable.displaysOf(consoleId)) cable.disconnectVideo(tvId);
    if (hit) {
      cable.connectVideo(consoleId, hit.id);
      seatVideoPlug(consoleId, hit.id);
    }
    routeVideo();
    persistRack();
    logger?.event?.('video-repatch', { consoleId, tv: hit?.id || null });
  }

  // Per-frame: reshape each console's video cord from its console's video-out
  // anchor to its plug (seated in a jack or held in hand).
  const _cFrom = new THREE.Vector3();
  const _cTo = new THREE.Vector3();
  function syncVideoCords() {
    const grabMgr = getGrabMgr();
    for (const [consoleId, rec] of videoPlugs) {
      const conObj = consoleObjs.get(consoleId);
      const out = conObj?.userData?.videoOutAnchor;
      if (!out) { rec.cord.setVisible(false); continue; }
      // Re-snap the plug to its TV's video-in jack every frame (unless it's in
      // hand) so the cord follows when the console OR the TV is repositioned in
      // Edit mode. seatVideoPlug(_, undefined) no-ops for a dangling plug, so a
      // disconnected cable just stays where it was dropped.
      if (!grabMgr?.isHeld(rec.plug.group)) seatVideoPlug(consoleId, cable.displaysOf(consoleId)[0]);
      out.getWorldPosition(_cFrom);
      (rec.plug.cordAnchor || rec.plug.group).getWorldPosition(_cTo);
      rec.cord.update(_cFrom, _cTo);
      rec.cord.setVisible(true);
    }
  }

  // ── Controller patch cords (gamepad → console port) ─────────────────────────
  // Each gamepad has a grabbable plug ([[src/Plug.js]], plugKind 'controller') on
  // the end of its cord — the EmuVR repatch handle, the controller analogue of the
  // video plugs. Seating the plug in a console's port jack plugs that controller
  // into that console+port ([[src/Patchbay.js]] plugController); dropping it in
  // mid-air unplugs it. The cord ([[src/Cord.js]]) runs gamepad → plug each frame.
  // Works across ALL consoles in the rack (the snap searches every console's
  // jacks), which is what makes a second console actually controllable.
  const controllerPlugs = new Map(); // cableId -> { plug:Plug, cord:Cord }
  const _cordFrom = new THREE.Vector3();
  const _cordTo = new THREE.Vector3();
  const _cpPos = new THREE.Vector3();
  const _cpQuat = new THREE.Quaternion();

  // Build the grabbable plug + cord for a gamepad and seat it at its current port.
  function addControllerPlug(gpObj) {
    const grabMgr = getGrabMgr();
    const cableId = gpObj?.userData?.cableId;
    if (!cableId || controllerPlugs.has(cableId)) return;
    const seat = cable.portOf(cableId);                // { consoleId, port } | null
    const color = cordColorForPlayer((seat?.port ?? 0) + 1);
    const plug = new Plug({ id: `cplug-${cableId}`, plugKind: 'controller', sourceId: cableId, color });
    scene.addObject(plug.group);
    grabMgr?.addGrabbable(plug.group);
    const cord = new Cord({ color });
    scene.addObject(cord.mesh);
    controllerPlugs.set(cableId, { plug, cord });
    seatControllerPlug(cableId);
  }

  // Snap a controller plug onto the jack of the port it's plugged into; if it's
  // unplugged, park it just above its gamepad so the loose cord reads clearly.
  function seatControllerPlug(cableId) {
    const rec = controllerPlugs.get(cableId);
    if (!rec) return;
    const seat = cable.portOf(cableId);
    const conObj = seat ? consoleObjs.get(seat.consoleId) : null;
    const jack = conObj?.userData?.portJacks?.[seat?.port];
    if (jack) {
      jack.getWorldPosition(_cpPos);
      jack.getWorldQuaternion(_cpQuat);
      rec.plug.group.position.copy(_cpPos);
      rec.plug.group.quaternion.copy(_cpQuat);
    } else {
      const gp = _cabledObjFor(cableId);
      if (gp) {
        (gp.userData.cordAnchor || gp).getWorldPosition(_cpPos);
        rec.plug.group.position.copy(_cpPos);
        rec.plug.group.position.y += 0.08;
      }
    }
  }

  // Re-broadcast a cabled peripheral's current port so every peer agrees on its
  // port→player mapping after it (or its patch-cord plug) is dragged to a different
  // jack. Picks the channel by which kind owns the cableId: a light gun rides the
  // gun:<cableId> STATE (port-only; its mesh rides prop:*), a gamepad rides
  // gamepad:<cableId>. Both carry { port } (-1 = unplugged); RoomObjects dedups, so
  // an unchanged port is a no-op, as is a call outside a session. Call at discrete
  // re-plug events only — NOT from seatControllerPlug (that runs every frame).
  function _broadcastCablePort(cableId) {
    const net = getNet();
    if (!net || !cableId) return;
    const port = cable.portOf(cableId)?.port ?? -1;
    const key = _lightGunObjsById.has(cableId)
      ? makeGunStateKey(cableId)
      : _mouseObjsById.has(cableId)
        ? makeMouseStateKey(cableId)
        : makeGamepadStateKey(cableId);
    net.setObjectState(key, { port });
  }

  // GrabMgr release handler for a controller plug: snap to the nearest free port
  // jack across EVERY console and re-plug, or unplug if dropped in mid-air.
  const _ctrlPlugWorld = new THREE.Vector3();
  function handleControllerPlugReleased(plugObj, ray) {
    const gameInput = getGameInput();
    const cableId = plugObj.userData?.sourceId;
    if (!cableId) return;
    plugObj.getWorldPosition(_ctrlPlugWorld);
    const cur = cable.portOf(cableId);
    const anchors = [];
    const _j = new THREE.Vector3();
    for (const [consoleId, conObj] of consoleObjs) {
      const jacks = conObj.userData?.portJacks || [];
      const active = conObj.userData?.activePorts ?? jacks.length;
      for (let port = 0; port < jacks.length && port < active; port++) {
        const free = cable.isPortFree(consoleId, port);
        const mine = cur && cur.consoleId === consoleId && cur.port === port;
        if (!free && !mine) continue;          // taken by another pad → skip
        jacks[port].getWorldPosition(_j);
        anchors.push({ id: `${consoleId}#${port}`, consoleId, port, x: _j.x, y: _j.y, z: _j.z });
      }
    }
    let hit = nearestAnchor(
      { x: _ctrlPlugWorld.x, y: _ctrlPlugWorld.y, z: _ctrlPlugWorld.z },
      anchors, PLUG_SNAP_RADIUS,
    );
    if (!hit && ray) {
      hit = nearestAnchorAlongRay(ray.origin, ray.dir, anchors, {
        maxDist: PLUG_RAY_MAX_DIST, maxPerp: PLUG_RAY_MAX_PERP,
      });
    }
    if (hit) cable.plugController(cableId, hit.anchor.consoleId, hit.anchor.port);
    else cable.unplugController(cableId);
    seatControllerPlug(cableId);
    _broadcastCablePort(cableId);             // peers must agree on the new port→player
    gameInput?.flushReleases();               // drop keys held under the old seat
    logger?.event?.('controller-repatch', { cableId, seat: hit ? hit.id : null });
  }

  // Reshape each controller cord from its peripheral (gamepad OR light gun) to its
  // plug every frame.
  function syncControllerCords() {
    const grabMgr = getGrabMgr();
    for (const [cableId, rec] of controllerPlugs) {
      const gp = _cabledObjFor(cableId);
      if (!gp) { rec.cord.setVisible(false); continue; }
      // Re-snap the plug to its port jack every frame (unless it's in hand) so the
      // cord follows when the console it's plugged into is moved in Edit mode.
      if (!grabMgr?.isHeld(rec.plug.group)) seatControllerPlug(cableId);
      (gp.userData.cordAnchor || gp).getWorldPosition(_cordFrom);
      (rec.plug.cordAnchor || rec.plug.group).getWorldPosition(_cordTo);
      rec.cord.update(_cordFrom, _cordTo);
      rec.cord.setVisible(true);
    }
  }

  // ── Keyboard patch cord (keyboard → console DIN jack) ───────────────────────
  // Mirrors the controller cord pattern: a Plug (plugKind 'keyboard') on the
  // end of a Cord from the keyboard's cordAnchor.  Seating it in a console's
  // keyboardJack calls connectKeyboardTo(consoleId); mid-air drop disconnects.
  const keyboardPlugs = new Map(); // kbdId -> { plug:Plug, cord:Cord }
  const _kbdFrom = new THREE.Vector3();
  const _kbdTo = new THREE.Vector3();
  const _kbdPlugPos = new THREE.Vector3();
  const _kbdPlugQuat = new THREE.Quaternion();

  // Build the grabbbable plug + cord for the keyboard device and seat it at the
  // connected console's keyboardJack (or dangling if not yet connected).
  function addKeyboardPlug(kbdObj) {
    const grabMgr = getGrabMgr();
    if (!kbdObj || keyboardPlugs.has(KBD_ID)) return;
    const plug = new Plug({ id: `kplug-${KBD_ID}`, plugKind: 'keyboard', sourceId: KBD_ID });
    scene.addObject(plug.group);
    grabMgr?.addGrabbable(plug.group);
    const cord = new Cord({ color: 0xddcc88 }); // cream/off-white, matches the plug tint
    scene.addObject(cord.mesh);
    keyboardPlugs.set(KBD_ID, { plug, cord });
    seatKeyboardPlug();
  }

  // Snap the keyboard plug onto the keyboardJack of the connected console; if
  // disconnected, park it just behind the keyboard body so the loose cord reads clearly.
  function seatKeyboardPlug() {
    const c64kbd = getC64kbd();
    const _kbdTargetConsoleId = getKbdTarget();
    const rec = keyboardPlugs.get(KBD_ID);
    if (!rec) return;
    const conObj = _kbdTargetConsoleId ? consoleObjs.get(_kbdTargetConsoleId) : null;
    const jack = conObj?.userData?.keyboardJack;
    if (jack) {
      jack.getWorldPosition(_kbdPlugPos);
      jack.getWorldQuaternion(_kbdPlugQuat);
      rec.plug.group.position.copy(_kbdPlugPos);
      rec.plug.group.quaternion.copy(_kbdPlugQuat);
    } else if (c64kbd) {
      (c64kbd.cordAnchor || c64kbd.object3d).getWorldPosition(_kbdPlugPos);
      rec.plug.group.position.copy(_kbdPlugPos);
      rec.plug.group.position.y += 0.08;
    }
  }

  // GrabMgr release handler for a keyboard plug: snap to nearest keyboardJack
  // across all consoles (within keyboardJackRadius) and connect, else disconnect.
  const _kbdPlugWorld = new THREE.Vector3();
  function handleKeyboardPlugReleased(plugObj, ray) {
    if (plugObj.userData?.sourceId !== KBD_ID) return;
    plugObj.getWorldPosition(_kbdPlugWorld);
    const anchors = [];
    const _j = new THREE.Vector3();
    for (const [consoleId, conObj] of consoleObjs) {
      const jack = conObj.userData?.keyboardJack;
      const radius = conObj.userData?.keyboardJackRadius ?? 0.19;
      if (!jack) continue;
      jack.getWorldPosition(_j);
      anchors.push({ id: consoleId, consoleId, radius, x: _j.x, y: _j.y, z: _j.z });
    }
    // Use the per-console keyboardJackRadius for the snap.
    let hit = null;
    let hitDist = Infinity;
    for (const a of anchors) {
      const dx = _kbdPlugWorld.x - a.x, dy = _kbdPlugWorld.y - a.y, dz = _kbdPlugWorld.z - a.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < a.radius && dist < hitDist) { hitDist = dist; hit = a; }
    }
    // Point-and-place: aiming at a console's keyboard jack connects it even
    // from far away (Mechanism B).
    if (!hit && ray) {
      const rayHit = nearestAnchorAlongRay(ray.origin, ray.dir, anchors, {
        maxDist: PLUG_RAY_MAX_DIST, maxPerp: PLUG_RAY_MAX_PERP,
      });
      if (rayHit) hit = rayHit.anchor;
    }
    if (hit) {
      connectKeyboardTo(hit.consoleId);
    } else {
      disconnectKeyboard();
    }
    seatKeyboardPlug();
    logger?.event?.('keyboard-repatch', { seat: hit?.consoleId || null });
  }

  // Reshape the keyboard cord from the keyboard body to its plug every frame.
  function syncKeyboardCord() {
    const c64kbd = getC64kbd();
    const grabMgr = getGrabMgr();
    const rec = keyboardPlugs.get(KBD_ID);
    if (!rec) return;
    // The plug + cord only exist while the keyboard is shown — hide both (and the
    // grabbable plug, so it can't be caught) when there's no keyboard on screen.
    const kbShown = !!c64kbd && c64kbd.object3d.visible;
    rec.plug.group.visible = kbShown;
    rec.cord.setVisible(kbShown);
    if (!kbShown) return;
    // Re-snap the plug to the connected console's keyboard jack every frame
    // (unless it's in hand) so the cord follows when that console is moved.
    if (!grabMgr?.isHeld(rec.plug.group)) seatKeyboardPlug();
    (c64kbd.cordAnchor || c64kbd.object3d).getWorldPosition(_kbdFrom);
    (rec.plug.cordAnchor || rec.plug.group).getWorldPosition(_kbdTo);
    rec.cord.update(_kbdFrom, _kbdTo);
  }

  // Route keyboard input to the given console's emulator core, updating the
  // Patchbay, sendInput closure, and the layout to match the booted system.
  // `_consoleSystems` — and the sentence that explained it — moved to
  // [[src/ConsoleRegistry.js]]; destructured above.

  // M1.3: build the primary keyboard's sendInput callback for `consoleId`. Always
  // dispatches locally (unchanged); when we're a non-host peer in a session, ALSO
  // forwards over the 'kbd' WIRE channel so the keystroke reaches the host's
  // authoritative core (mirrors clientForGun/clientForMouse's WIRE shim, and the
  // "still dispatch locally too" rationale of onLogicalInput's gamepad forwarding
  // — this peer keeps seeing its own game until host video replaces the canvas).
  // The host applies a received 'kbd' message to ITS OWN _kbdTargetConsoleId, not
  // the sender's, so no consoleId needs to ride along (see onWire in connectToRoom).
  function _kbdSendInputFor(consoleId) {
    return (type, code, key, keyCode, location) => {
      rackMgr.get(consoleId)?.sendInput(type, code, key, keyCode, location);
      // !amRoomHost() implies we're in a session and not (yet) the host.
      if (!amRoomHost()) getNet().sendWire('kbd', { type, code, key, keyCode, location });
    };
  }

  function connectKeyboardTo(consoleId) {
    const c64kbd = getC64kbd();
    if (!c64kbd) return;
    // Flush any held keys on the old target before switching.
    c64kbd.flushReleases();
    setKbdTarget(consoleId || CONSOLE_ID);
    const _kbdTargetConsoleId = getKbdTarget();
    cable.plugKeyboard(KBD_ID, _kbdTargetConsoleId);
    // Re-wire sendInput to target the new console.
    c64kbd.setSendInput(_kbdSendInputFor(_kbdTargetConsoleId));
    // Switch layout: c64 layout for keyboard-capable Commodore systems, standard otherwise.
    const sys = _consoleSystems.get(_kbdTargetConsoleId);
    c64kbd.setLayout(isKeyboardCapable(sys) ? 'c64' : 'standard');
    seatKeyboardPlug();
  }

  function disconnectKeyboard() {
    const c64kbd = getC64kbd();
    if (!c64kbd) return;
    c64kbd.flushReleases();
    cable.unplugKeyboard(KBD_ID);
    // FIX C: a mid-air drop is a TRUE disconnect — null target + no-op sendInput
    // so no console receives keystrokes until the keyboard is re-plugged. The
    // startup path (buildCartridgeWorld) still calls connectKeyboardTo(CONSOLE_ID)
    // so out-of-the-box the keyboard is wired; only an explicit unplug disconnects.
    // seatKeyboardPlug() reads _kbdTargetConsoleId===null and parks the plug behind
    // the keyboard body (safe: consoleObjs.get(null) returns undefined → no jack).
    setKbdTarget(null);
    c64kbd.setSendInput(() => {});
  }

  return {
    // Video cords
    videoPlugs, seatVideoPlug, addVideoPlug, handlePlugReleased, syncVideoCords,
    // Controller cords
    controllerPlugs, addControllerPlug, seatControllerPlug, _broadcastCablePort,
    syncControllerCords,
    // Keyboard cord
    addKeyboardPlug, syncKeyboardCord, _kbdSendInputFor, connectKeyboardTo,
  };
}
