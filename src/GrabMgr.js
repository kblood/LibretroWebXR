// GrabMgr: VR grip-button pick-up/drop for grabbable objects (cartridges +
// gamepad). The grip button is **sacred** — it never reaches the emulator,
// always means "grab/release". This is the clear distinction the user asked
// for: grip = world interaction, trigger/face = game input (only when the
// gamepad is being held).
//
// Aiming: each controller casts a ray forward (-Z in its local frame); the
// first grabbable hit within RAY_RANGE is the hover target. When grip is
// pressed, the hover target is grabbed (or, if no hover, the nearest
// grabbable within ARM_RANGE). The controller's laser turns yellow while
// a target is in the crosshair so the user knows what's about to happen.
//
// Release rules:
//   - Cartridge released within DROP_RADIUS of the console slot →
//     snaps to the slot, calls onCartridgeInserted(meta).
//   - Cartridge released elsewhere → snaps back to its shelf home.
//   - Gamepad released → stays exactly where you let it go.

import * as THREE from 'three';
import {
  clampToRoom, snapToSurface, footprintForKind, SURFACE_KIND,
} from './Placement.js';

const ARM_RANGE  = 0.45;  // metres — fallback close-range grab when nothing aimed
const RAY_RANGE  = 5.0;   // metres — how far the aim ray reaches
const DROP_RADIUS = 0.22; // metres — console slot acceptance radius

const LASER_IDLE = 0x88aaff;
const LASER_HOVER = 0xffd060;

export class GrabMgr {
  constructor({ scene, controllers, console: consoleObj, getConsoles, cable, onCartridgeInserted, onGamepadHeldChanged, onMemoryCardInserted, onGamepadPlugged, onPlugReleased, isEditMode, onEditRelease, getMode, onSelectProp, onCartridgeGrabbed, onCartridgeReleased, onGamepadGrabbed, onGamepadReleased, isRemotelyHeld, getRoomBounds, isPreviewEnabled }) {
    this.scene = scene;
    this.controllers = controllers;
    this.console = consoleObj;
    // Multi-console rack: a cartridge can be dropped into ANY console's slot, so
    // cart-release scans every console returned here ([consoleId, Object3D] pairs)
    // and loads into the nearest one. Defaults to just the primary console so
    // tests / single-console callers keep working unchanged.
    this.getConsoles = getConsoles || (() => [[null, consoleObj]]);
    // Local-multiplayer cable system ([[src/CableMgr.js]]). Optional: when
    // absent the gamepad behaves as before (always player 1, never seats).
    this.cable = cable || null;
    this.onCartridgeInserted = onCartridgeInserted || (() => {});
    this.onGamepadHeldChanged = onGamepadHeldChanged || (() => {});
    this.onMemoryCardInserted = onMemoryCardInserted || (() => {});
    // Fired after a gamepad plugs into / unplugs from a port so main.js can
    // refresh input routing. Receives (gamepadObject).
    this.onGamepadPlugged = onGamepadPlugged || (() => {});
    // Fired when a patch-cord plug ([[src/Plug.js]]) is released, so main.js can
    // snap it to the nearest compatible jack and rewire the patch graph (or pull
    // it out if dropped in mid-air). Receives the plug Object3D.
    this.onPlugReleased = onPlugReleased || (() => {});
    // Edit mode (Phase E): when true, the only grab targets are room props
    // (userData.editable) and releasing one leaves it where dropped instead of
    // snapping home / inserting. onEditRelease lets the editor apply snapping.
    this.isEditMode = isEditMode || (() => false);
    this.onEditRelease = onEditRelease || (() => {});
    // Editor mode ([[src/RoomEditor.js]]): 'off'|'move'|'change'|'add'. In
    // 'change' mode a grip on an editable prop SELECTS it (onSelectProp) instead
    // of attaching/moving it — the menu then cycles the selected prop's options.
    this.getMode = getMode || (() => (this.isEditMode() ? 'move' : 'off'));
    this.onSelectProp = onSelectProp || (() => {});
    // Held-object sync (M0): fired when a cartridge is picked up / put down so
    // main.js can broadcast who is holding it. onCartridgeGrabbed gets
    // (cartObject, hand) where hand is 'left'|'right'|null (null = desktop).
    this.onCartridgeGrabbed = onCartridgeGrabbed || (() => {});
    this.onCartridgeReleased = onCartridgeReleased || (() => {});
    // Shared-gamepad sync: fired when we grab/release a shared gamepad so
    // main.js can broadcast the hold to peers (locking it from their grab).
    // onGamepadGrabbed gets (gamepadObject, hand); onGamepadReleased gets (gamepadObject).
    this.onGamepadGrabbed = onGamepadGrabbed || (() => {});
    this.onGamepadReleased = onGamepadReleased || (() => {});
    // isRemotelyHeld(obj): returns true when a gamepad is held by a remote peer
    // (supplied by main.js from GhostGamepadMgr). When true the gamepad is NOT
    // grabbable locally. No-op when null (single-player or pre-net).
    this._isRemotelyHeld = isRemotelyHeld || (() => false);
    // Placement preview: getRoomBounds() supplies the room extents (from SceneMgr);
    // isPreviewEnabled() gates whether the ghost box is shown while dragging.
    this._getRoomBounds = getRoomBounds || null;
    this._isPreviewEnabled = isPreviewEnabled || (() => false);
    this.grabbables = [];
    this.held = new Map();              // controller -> Object3D
    this._hover = new Map();            // controller -> Object3D (or null)
    this._ray = new THREE.Raycaster();
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._quat = new THREE.Quaternion();

    // Ghost preview: a single wireframe box reused across all held editable props.
    // Shown only when isPreviewEnabled() is true and exactly one editable prop is held.
    this._ghost = null;          // the THREE.LineSegments ghost mesh (created lazily)
    this._ghostKind = null;      // prop kind the ghost was sized for (reset on kind change)

    controllers.forEach((ctrl) => {
      ctrl.addEventListener('squeezestart', () => this._tryGrab(ctrl));
      ctrl.addEventListener('squeezeend', () => this._release(ctrl));
    });
  }

  addGrabbable(object) {
    // Idempotent: the gamepad is registered both by main.js (as a play object)
    // and by RoomEditor (as an editable prop) — don't list it twice.
    if (!this.grabbables.includes(object)) this.grabbables.push(object);
  }

  // Drop an object from the grab set (e.g. the old shelf + its cartridges when
  // Change mode rebuilds a shelf for a new collection). Also clears any pending
  // hover that points at it so the laser doesn't linger on a freed object.
  removeGrabbable(object) {
    const i = this.grabbables.indexOf(object);
    if (i >= 0) this.grabbables.splice(i, 1);
    for (const [ctrl, hov] of this._hover) if (hov === object) this._setHover(ctrl, null);
  }

  // Which grabbables are valid targets right now.
  //  - The gamepad is DUAL-PURPOSE: grabbable in BOTH modes (to play, and to
  //    reposition while editing). Without this it'd be editable-only and games
  //    couldn't be played.
  //  - Everything else is modal: play mode targets the non-editable set
  //    (cartridges/cards), edit mode targets the editable props. This keeps
  //    furniture inert while playing and avoids an accidental ROM load while
  //    arranging.
  _isCandidate(obj) {
    if (obj.userData?.kind === 'gamepad') return true;
    // Patch-cord plugs are grabbable while playing (repatch cords any time), but
    // inert in edit mode so they don't compete with prop arranging.
    if (obj.userData?.kind === 'plug') return !this.isEditMode();
    return !!obj.userData?.editable === this.isEditMode();
  }

  isGamepadHeld() {
    for (const obj of this.held.values()) {
      if (obj.userData?.kind === 'gamepad') return true;
    }
    return false;
  }

  isControllerFree(ctrl) {
    return !this.held.has(ctrl);
  }

  isControllerHoldingGamepad(ctrl) {
    return this.held.get(ctrl)?.userData?.kind === 'gamepad';
  }

  // The object a controller currently holds (or null). Used by main.js to map
  // each hand to the gamepad → player it drives (local-multiplayer routing).
  heldObject(ctrl) {
    return this.held.get(ctrl) || null;
  }

  // True if `obj` is currently grabbed by ANY controller. Used by the per-frame
  // cord sync so a seated plug can be re-snapped to its (possibly moved) jack
  // every frame WITHOUT fighting the hand when the user is actively holding it.
  isHeld(obj) {
    for (const o of this.held.values()) if (o === obj) return true;
    return false;
  }

  insertedCartridge() {
    return this._insertedCart || null;
  }

  // Programmatically snap a cartridge into the slot — used by main.js after
  // a sessionStorage resume so the cart visually matches the loaded ROM.
  setInsertedCart(cart) {
    const slotAnchor = this.console.userData.slotAnchor;
    slotAnchor.updateMatrixWorld(true);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    slotAnchor.getWorldPosition(pos);
    slotAnchor.getWorldQuaternion(quat);
    cart.position.copy(pos);
    cart.quaternion.copy(quat);
    this._insertedCart = cart;
    this.console.userData.setInserted(true);
  }

  // Per-frame: update hover targets, laser colours, and placement ghost.
  // Wired up by main.js through SceneMgr.addTickCallback.
  tick() {
    for (const ctrl of this.controllers) {
      // While holding, we don't ray-cast for a new target (the held thing
      // would intersect the ray itself).
      if (this.held.has(ctrl)) {
        this._setHover(ctrl, null);
        continue;
      }
      const target = this._aimTarget(ctrl);
      this._setHover(ctrl, target);
    }
    this._updateGhost();
  }

  // --- Placement ghost (preview) -------------------------------------------

  /**
   * Create or resize the ghost box to match the footprint of `kind`.
   * The ghost is a translucent wireframe EdgesGeometry box painted in a
   * cyan tint so it's distinguishable from the prop itself.
   */
  _ensureGhost(kind) {
    if (this._ghost && this._ghostKind === kind) return; // already correct size

    // Dispose old ghost before replacing it.
    if (this._ghost) {
      this.scene.remove(this._ghost);
      this._ghost.geometry.dispose();
      this._ghost.material.dispose();
      this._ghost = null;
    }

    const fp = footprintForKind(kind);
    const isWall = SURFACE_KIND[kind] === 'wall';
    // For wall props use footprint.width × height × depth; for floor props a
    // flat 0.05 m tall slab shows where it will land without obscuring the prop.
    const ghostH = isWall ? 0.8 : 0.05;
    const geom = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(fp.width, ghostH, fp.depth),
    );
    const mat = new THREE.LineBasicMaterial({ color: 0x44ddff, transparent: true, opacity: 0.7 });
    this._ghost = new THREE.LineSegments(geom, mat);
    this._ghost.name = 'placement-ghost';
    this._ghostKind = kind;
    this.scene.add(this._ghost);
  }

  /**
   * Each frame: if preview is enabled and exactly one editable prop is held,
   * compute the snapped drop position and move the ghost there. Otherwise hide.
   */
  _updateGhost() {
    if (!this._isPreviewEnabled() || !this._getRoomBounds) {
      this._hideGhost();
      return;
    }

    // Find the one editable prop being held (not gamepads, not cartridges).
    let heldProp = null;
    for (const [, obj] of this.held) {
      if (obj.userData?.editable && obj.userData?.kind !== 'gamepad') {
        heldProp = obj;
        break;
      }
    }

    if (!heldProp) { this._hideGhost(); return; }

    const kind = heldProp.userData?.kind || 'shelf';
    this._ensureGhost(kind);

    // Compute the snapped world position for the prop's current location.
    const bounds = this._getRoomBounds();
    const wp = new THREE.Vector3();
    heldProp.getWorldPosition(wp);
    const clamped = clampToRoom({ x: wp.x, y: wp.y, z: wp.z }, bounds, 0.1);
    const { pos, yaw } = snapToSurface(clamped, bounds, kind);

    this._ghost.position.set(pos.x, pos.y, pos.z);
    this._ghost.rotation.set(0, yaw, 0);
    this._ghost.visible = true;
  }

  _hideGhost() {
    if (this._ghost) this._ghost.visible = false;
  }

  _setHover(ctrl, target) {
    if (this._hover.get(ctrl) === target) return;
    this._hover.set(ctrl, target);
    const mat = ctrl.userData.laserMat;
    if (mat) mat.color.setHex(target ? LASER_HOVER : LASER_IDLE);
  }

  _aimTarget(ctrl) {
    const candidates = this.grabbables.filter((g) => this._isCandidate(g));
    if (candidates.length === 0) return null;
    ctrl.updateMatrixWorld();
    this._origin.setFromMatrixPosition(ctrl.matrixWorld);
    ctrl.getWorldQuaternion(this._quat);
    this._dir.set(0, 0, -1).applyQuaternion(this._quat).normalize();
    this._ray.set(this._origin, this._dir);
    this._ray.far = RAY_RANGE;
    const hits = this._ray.intersectObjects(candidates, true);
    if (!hits.length) return null;
    // Walk up to find the registered grabbable root.
    let n = hits[0].object;
    while (n && !candidates.includes(n)) n = n.parent;
    if (!n) return null;
    // Skip if another controller is already holding it locally.
    for (const o of this.held.values()) if (o === n) return null;
    // Skip if a remote peer is holding this gamepad (exclusive network lock).
    if (n.userData?.kind === 'gamepad' && this._isRemotelyHeld(n.userData?.cableId)) return null;
    return n;
  }

  _nearestInArmRange(ctrl) {
    ctrl.updateMatrixWorld();
    this._origin.setFromMatrixPosition(ctrl.matrixWorld);
    let best = null, bestDist = ARM_RANGE;
    for (const obj of this.grabbables) {
      if (!this._isCandidate(obj)) continue;
      let busy = false;
      for (const o of this.held.values()) if (o === obj) { busy = true; break; }
      if (busy) continue;
      // Skip if a remote peer holds this gamepad (exclusive network lock).
      if (obj.userData?.kind === 'gamepad' && this._isRemotelyHeld(obj.userData?.cableId)) continue;
      const p = new THREE.Vector3();
      obj.getWorldPosition(p);
      const d = p.distanceTo(this._origin);
      if (d < bestDist) { best = obj; bestDist = d; }
    }
    return best;
  }

  _tryGrab(ctrl) {
    if (this.held.has(ctrl)) return;
    const target = this._hover.get(ctrl) || this._aimTarget(ctrl) || this._nearestInArmRange(ctrl);
    if (!target) return;

    // Change mode: grip SELECTS an editable prop (not the gamepad, which stays
    // playable) without attaching/moving it. The menu cycles its options.
    if (this.getMode() === 'change' && target.userData?.editable && target.userData?.kind !== 'gamepad') {
      this._setHover(ctrl, null);
      this.onSelectProp(target);
      return;
    }

    if (this._insertedCart === target) {
      this._insertedCart = null;
      this.console.userData.setInserted(false);
    }

    ctrl.attach(target);
    this.held.set(ctrl, target);
    this._setHover(ctrl, null);

    if (target.userData?.kind === 'gamepad') {
      // EmuVR-style: picking up a controller to play does NOT unplug it — the
      // port assignment is owned by the cord, not by holding the pad, so the
      // controller keeps driving its player and its cord simply stretches to
      // your hand. Repatch by dropping it near a different port (release path).
      target.userData.setHeld?.(true);
      this.onGamepadHeldChanged(true);
      // Shared-gamepad sync: broadcast the grab so remote peers lock this pad.
      this.onGamepadGrabbed(target, this._handFor(ctrl));
    } else if (target.userData?.kind === 'cartridge') {
      this.onCartridgeGrabbed(target, this._handFor(ctrl));
    }
  }

  // 'left'|'right' for the two XR controllers; null for the synthetic desktop one.
  _handFor(ctrl) {
    const i = this.controllers.indexOf(ctrl);
    return i === 0 ? 'left' : i === 1 ? 'right' : null;
  }

  _release(ctrl) {
    const obj = this.held.get(ctrl);
    if (!obj) return;
    this.held.delete(ctrl);
    this.scene.attach(obj);

    const kind = obj.userData?.kind;

    if (kind === 'gamepad') {
      // The gamepad is dual-purpose (grabbable in both play AND edit mode) so
      // the plug path must run regardless of which mode is active — the user
      // should be able to plug into a port even while editing the room.
      //
      // Strategy: always attempt the plug first.  _handleGamepadRelease does
      // nothing if no free port is within DROP_RADIUS (it just returns).
      // Afterwards, if the gamepad is STILL unplugged (plug didn't happen) and
      // we are in edit mode, hand it to onEditRelease so the editor can apply
      // its grid-snap / prop-bookkeeping as it would for any other editable
      // prop.  If it DID plug, edit-release is skipped (the snap-to-port
      // position already set the final resting place).
      const portBefore = this.cable?.portOf(obj.userData.cableId);
      this._handleGamepadRelease(obj);
      const plugged = this.cable && this.cable.portOf(obj.userData.cableId) !== portBefore
                      && this.cable.portOf(obj.userData.cableId) != null;
      if (!plugged && this.isEditMode() && obj.userData?.editable) {
        this.onEditRelease(obj);
      }
    } else if (this.isEditMode() && obj.userData?.editable) {
      // In edit mode, a non-gamepad editable prop is left exactly where dropped
      // (the editor may snap it to a grid) — never snapped home or inserted.
      this.onEditRelease(obj);
    } else if (kind === 'plug') {
      // Patch-cord plug: main.js snaps it to the nearest compatible jack and
      // rewires the patch graph, or pulls the edge if dropped in mid-air.
      this.onPlugReleased(obj);
    } else if (kind === 'cartridge') {
      this._handleCartridgeRelease(obj);
    } else if (kind === 'memory-card') {
      this._handleCardRelease(obj);
    }

    // The gamepad is grabbable in both modes, so always reconcile its held-state
    // on release (flush input, re-enable menu/locomotion) whichever branch ran.
    if (kind === 'gamepad' && !this.isGamepadHeld()) {
      obj.userData.setHeld?.(false);
      this.onGamepadHeldChanged(false);
    }
    // Shared-gamepad sync: clear our hold so peers can grab this pad again.
    if (kind === 'gamepad') this.onGamepadReleased(obj);

    // Held-object sync: a cartridge is no longer in hand (it snapped home, was
    // inserted, or was left in place) — clear our hold so peers drop the ghost.
    if (kind === 'cartridge') this.onCartridgeReleased(obj);
  }

  _handleCartridgeRelease(cart) {
    const cartWorld = new THREE.Vector3();
    cart.getWorldPosition(cartWorld);

    // Pick the nearest console slot across the WHOLE rack (each slotAnchor lives
    // in its console's group, so its world position tracks the console even after
    // it's been moved in Edit mode). Pre-fix this only ever checked the primary
    // console, so a cartridge could never be loaded into a second console.
    let best = null;                        // { consoleId, consoleObj, dist }
    const _p = new THREE.Vector3();
    for (const [consoleId, consoleObj] of this.getConsoles()) {
      const slotAnchor = consoleObj?.userData?.slotAnchor;
      if (!slotAnchor) continue;
      slotAnchor.getWorldPosition(_p);
      const dist = cartWorld.distanceTo(_p);
      if (dist < DROP_RADIUS && (!best || dist < best.dist)) {
        best = { consoleId, consoleObj, dist };
      }
    }

    if (best) {
      const slotAnchor = best.consoleObj.userData.slotAnchor;
      const anchorWorld = new THREE.Vector3();
      const anchorQuat = new THREE.Quaternion();
      slotAnchor.getWorldPosition(anchorWorld);
      slotAnchor.getWorldQuaternion(anchorQuat);
      cart.position.copy(anchorWorld);
      cart.quaternion.copy(anchorQuat);

      this._insertedCart = cart;
      best.consoleObj.userData.setInserted(true);
      this.onCartridgeInserted({
        file: cart.userData.file,
        system: cart.userData.system,
        core: cart.userData.core,
        title: cart.userData.title,
        // Carry ROM provenance so RomResolver re-resolves picked/local ROMs from
        // their real source (OPFS cache / folder), not a 404ing url fetch.
        rom: cart.userData.rom || undefined,
        cartObject: cart,
        // Which console received the cart, so main.js boots into THAT console's
        // runtime (its own canvas/core/TV) instead of always the primary.
        consoleId: best.consoleId,
      });
      return;
    }

    if (cart.userData.homePosition && cart.userData.homeQuaternion) {
      cart.position.copy(cart.userData.homePosition);
      cart.quaternion.copy(cart.userData.homeQuaternion);
    }
  }

  // Snap a released gamepad onto the nearest free, enabled controller port and
  // plug it into the cable system. No console/cable → leaves it where dropped.
  _handleGamepadRelease(gp) {
    const cu = this.console?.userData;
    if (!this.cable || !cu?.portAnchors || gp.userData.cableId == null) return;

    const gpWorld = new THREE.Vector3();
    gp.getWorldPosition(gpWorld);
    const radius = cu.portRadius || 0.16;

    let bestPort = -1, bestDist = radius;
    const aw = new THREE.Vector3();
    for (let i = 0; i < cu.portAnchors.length; i++) {
      if (i >= cu.activePorts) continue;        // port disabled for this system
      if (!this.cable.isPortFree(i)) continue;  // already occupied
      cu.portAnchors[i].getWorldPosition(aw);
      const d = aw.distanceTo(gpWorld);
      if (d < bestDist) { bestDist = d; bestPort = i; }
    }
    if (bestPort < 0) return;                    // not near a free port → stay put

    const anchor = cu.portAnchors[bestPort];
    const aq = new THREE.Quaternion();
    anchor.getWorldPosition(aw);
    anchor.getWorldQuaternion(aq);
    gp.position.copy(aw);
    gp.quaternion.copy(aq);
    this.cable.plug(gp.userData.cableId, bestPort);
    this.onGamepadPlugged(gp);
  }

  _handleCardRelease(card) {
    const anchor = this.console.userData.cardSlotAnchor;
    const radius = this.console.userData.cardSlotRadius || 0.14;
    const aw = new THREE.Vector3();
    anchor.getWorldPosition(aw);
    const cw = new THREE.Vector3();
    card.getWorldPosition(cw);
    if (cw.distanceTo(aw) < radius) {
      const aq = new THREE.Quaternion();
      anchor.getWorldQuaternion(aq);
      card.position.copy(aw);
      card.quaternion.copy(aq);
      // The save/load action and any "wrong game" bounce is owned by the
      // callback; on refusal it returns false and we snap the card back home.
      const accepted = this.onMemoryCardInserted(card);
      if (accepted === false && card.userData.homePosition && card.userData.homeQuaternion) {
        card.position.copy(card.userData.homePosition);
        card.quaternion.copy(card.userData.homeQuaternion);
      }
      return;
    }
    if (card.userData.homePosition && card.userData.homeQuaternion) {
      card.position.copy(card.userData.homePosition);
      card.quaternion.copy(card.userData.homeQuaternion);
    }
  }
}
