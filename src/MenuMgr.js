// MenuMgr: raycast-based "trigger click" for in-world UI buttons. Mirrors
// [[src/GrabMgr.js]]'s aim/hover but bound to selectstart (trigger)
// instead of squeezestart (grip), and never grabs — it only fires the
// item's onActivate callback.
//
// The trigger is shared with the emulator (when the gamepad is held BOTH
// triggers forward to the game — see [[src/GameInputMgr.js]]). To avoid
// eating fire input, MenuMgr disables itself entirely while the gamepad
// is held; the user has to drop it to open the menu.

import * as THREE from 'three';

const RAY_RANGE = 8.0;

// Effective visibility: a button in a hidden panel (group.visible = false) must
// not be hoverable/clickable. THREE's Raycaster does NOT skip invisible objects
// on its own, so the mode-switcher menu relies on this walk-up check to gate the
// per-mode sub-panels (Move/Change/Add).
function effVisible(obj) {
  let n = obj;
  while (n) { if (!n.visible) return false; n = n.parent; }
  return true;
}

export class MenuMgr {
  constructor({ controllers, isGamepadHeld }) {
    this.controllers = controllers;
    this.isGamepadHeld = isGamepadHeld || (() => false);
    this.items = []; // { mesh, onActivate }
    this._hover = new Map();
    this._ray = new THREE.Raycaster();
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._quat = new THREE.Quaternion();

    controllers.forEach((ctrl) => {
      ctrl.addEventListener('selectstart', () => this._tryClick(ctrl));
    });
  }

  addItem(mesh, onActivate) {
    this.items.push({ mesh, onActivate });
  }

  tick() {
    const gamepadHeld = this.isGamepadHeld();
    for (const ctrl of this.controllers) {
      if (gamepadHeld) {
        this._setHover(ctrl, null);
        continue;
      }
      const target = this._aim(ctrl);
      this._setHover(ctrl, target);
    }
  }

  _aim(ctrl) {
    if (!this.items.length) return null;
    ctrl.updateMatrixWorld();
    this._origin.setFromMatrixPosition(ctrl.matrixWorld);
    ctrl.getWorldQuaternion(this._quat);
    this._dir.set(0, 0, -1).applyQuaternion(this._quat).normalize();
    this._ray.set(this._origin, this._dir);
    this._ray.far = RAY_RANGE;
    // Only meshes in a currently-visible panel are aimable.
    const meshes = this.items.filter((i) => effVisible(i.mesh)).map((i) => i.mesh);
    if (!meshes.length) return null;
    const hits = this._ray.intersectObjects(meshes, true);
    if (!hits.length) return null;
    let n = hits[0].object;
    while (n && !meshes.includes(n)) n = n.parent;
    return n || null;
  }

  _setHover(ctrl, mesh) {
    if (this._hover.get(ctrl) === mesh) return;
    const prev = this._hover.get(ctrl);
    if (prev) prev.userData.setHover?.(false);
    this._hover.set(ctrl, mesh);
    if (mesh) mesh.userData.setHover?.(true);
  }

  _tryClick(ctrl) {
    if (this.isGamepadHeld()) return;
    const mesh = this._hover.get(ctrl);
    if (!mesh || !effVisible(mesh)) return;
    const item = this.items.find((i) => i.mesh === mesh);
    item?.onActivate(ctrl);
  }
}
