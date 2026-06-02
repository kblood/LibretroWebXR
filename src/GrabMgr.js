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

const ARM_RANGE  = 0.45;  // metres — fallback close-range grab when nothing aimed
const RAY_RANGE  = 5.0;   // metres — how far the aim ray reaches
const DROP_RADIUS = 0.22; // metres — console slot acceptance radius

const LASER_IDLE = 0x88aaff;
const LASER_HOVER = 0xffd060;

export class GrabMgr {
  constructor({ scene, controllers, console: consoleObj, onCartridgeInserted, onGamepadHeldChanged, onMemoryCardInserted, isEditMode, onEditRelease }) {
    this.scene = scene;
    this.controllers = controllers;
    this.console = consoleObj;
    this.onCartridgeInserted = onCartridgeInserted || (() => {});
    this.onGamepadHeldChanged = onGamepadHeldChanged || (() => {});
    this.onMemoryCardInserted = onMemoryCardInserted || (() => {});
    // Edit mode (Phase E): when true, the only grab targets are room props
    // (userData.editable) and releasing one leaves it where dropped instead of
    // snapping home / inserting. onEditRelease lets the editor apply snapping.
    this.isEditMode = isEditMode || (() => false);
    this.onEditRelease = onEditRelease || (() => {});
    this.grabbables = [];
    this.held = new Map();              // controller -> Object3D
    this._hover = new Map();            // controller -> Object3D (or null)
    this._ray = new THREE.Raycaster();
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._quat = new THREE.Quaternion();

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

  // Per-frame: update hover targets and laser colours. Wired up by main.js
  // through SceneMgr.addTickCallback.
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
    // Skip if another controller is already holding it.
    for (const o of this.held.values()) if (o === n) return null;
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

    if (this._insertedCart === target) {
      this._insertedCart = null;
      this.console.userData.setInserted(false);
    }

    ctrl.attach(target);
    this.held.set(ctrl, target);
    this._setHover(ctrl, null);

    if (target.userData?.kind === 'gamepad') {
      target.userData.setHeld?.(true);
      this.onGamepadHeldChanged(true);
    }
  }

  _release(ctrl) {
    const obj = this.held.get(ctrl);
    if (!obj) return;
    this.held.delete(ctrl);
    this.scene.attach(obj);

    const kind = obj.userData?.kind;

    // In edit mode, an editable prop is left exactly where dropped (the editor
    // may snap it to a grid) — never snapped home or inserted. The gamepad is
    // editable too, but still needs its held-state reconciled below.
    if (this.isEditMode() && obj.userData?.editable) {
      this.onEditRelease(obj);
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
  }

  _handleCartridgeRelease(cart) {
    const slotAnchor = this.console.userData.slotAnchor;
    const anchorWorld = new THREE.Vector3();
    slotAnchor.getWorldPosition(anchorWorld);

    const cartWorld = new THREE.Vector3();
    cart.getWorldPosition(cartWorld);

    if (cartWorld.distanceTo(anchorWorld) < DROP_RADIUS) {
      const anchorQuat = new THREE.Quaternion();
      slotAnchor.getWorldQuaternion(anchorQuat);
      cart.position.copy(anchorWorld);
      cart.quaternion.copy(anchorQuat);

      this._insertedCart = cart;
      this.console.userData.setInserted(true);
      this.onCartridgeInserted({
        file: cart.userData.file,
        system: cart.userData.system,
        core: cart.userData.core,
        title: cart.userData.title,
        cartObject: cart,
      });
      return;
    }

    if (cart.userData.homePosition && cart.userData.homeQuaternion) {
      cart.position.copy(cart.userData.homePosition);
      cart.quaternion.copy(cart.userData.homeQuaternion);
    }
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
