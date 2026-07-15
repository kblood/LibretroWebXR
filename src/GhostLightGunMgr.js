// GhostLightGunMgr: the visible half of shared-light-gun sync. When a remote
// peer holds a light gun, every other peer hides their own local copy of that
// gun and shows a ghost gun mesh attached to the holder's synced avatar hand —
// so the ghost automatically tracks the holder's real aim (the avatar hand
// already carries a full synced 6dof pose, and GrabMgr's alignToController
// convention, see [[src/GrabMgr.js]], is exactly what makes a hand-attached
// gun point the same way the holder is actually aiming).
//
// Mirror of [[src/GhostGamepadMgr.js]]. One deliberate scope limit: unlike a
// gamepad's button state (mirrored via the 'gp' wire channel), a remote gun's
// trigger-pull / muzzle-flash is NOT mirrored here — this covers presence and
// aim direction only, not live fire feedback.
//
// Driven each frame from the `hold:gun:<cableId>` STATE keys via
// [[src/net/HoldState.js]] and [[src/net/AvatarMgr.js]].

import * as THREE from 'three';
import { createLightGun } from './LightGun.js';

const HAND_OFFSET = new THREE.Vector3(0, 0, -0.05);     // just past the hand cone
const HEAD_OFFSET = new THREE.Vector3(0.2, -0.1, -0.2);  // desktop fallback

// Prefix used for gun hold keys (lives in the `hold:` namespace so the Hub
// auto-clears these when the owner disconnects, freeing the gun for others).
// Distinct from [[src/net/GunSync.js]]'s bare `gun:<cableId>` port-binding
// channel — that one has no `hold:` prefix, so the two never collide.
export const GUN_HOLD_PREFIX = 'gun:';

/** STATE key for holding the gun with the given cableId. */
export function makeGunHoldKey(cableId) {
  return `hold:${GUN_HOLD_PREFIX}${cableId}`;
}

/** True if a STATE key refers to a held light gun. */
export function isGunHoldKey(key) {
  return typeof key === 'string' && key.startsWith(`hold:${GUN_HOLD_PREFIX}`);
}

/** Extract the cableId from a gun hold key, or null. */
export function cableIdFromGunHoldKey(key) {
  if (!isGunHoldKey(key)) return null;
  return key.slice(`hold:${GUN_HOLD_PREFIX}`.length);
}

export class GhostLightGunMgr {
  /**
   * @param {object} opts
   * @param {AvatarMgr} opts.avatars      - the scene's avatar manager
   * @param {Map}       opts.lightGunObjs - cableId -> gun Object3D (from _lightGunObjsById)
   */
  constructor({ avatars, lightGunObjs }) {
    this.avatars = avatars;
    this.lightGunObjs = lightGunObjs;    // cableId -> Object3D
    this._ghosts = new Map();            // cableId -> { group, holder }
    this._heldBy = new Map();            // cableId -> holder peerId (for isRemotelyHeld)
    this._hidden = new Map();            // cableId -> Object3D we hid (real local gun)
  }

  /**
   * Reconcile against the desired holds (already filtered: no self, present
   * holders). Each hold is { objId: cableId, holder, hand }.
   */
  sync(holds) {
    const want = new Map(holds.map((h) => [h.objId, h]));

    // Remove ghosts whose hold is gone or holder changed; unhide the real gun.
    for (const [cableId, g] of [...this._ghosts]) {
      const h = want.get(cableId);
      if (!h || h.holder !== g.holder) this._removeGhost(cableId);
    }
    // Unhide anything still hidden whose hold has fully ended — checked
    // independently of the ghost lifecycle above. A hold can start and end
    // before the holder's avatar hand is ever available to attach a ghost to
    // (see the `if (!attach) continue` below), in which case no ghost is ever
    // created and the removal loop above never runs for it; without this
    // sweep the local gun would stay hidden forever.
    for (const cableId of [...this._hidden.keys()]) {
      if (!want.has(cableId)) this._unhideGun(cableId);
    }

    // Update _heldBy map (all remote holds, including ones without a ghost yet).
    this._heldBy.clear();
    for (const h of holds) {
      this._heldBy.set(h.objId, h.holder);
    }

    for (const h of holds) {
      // Hide our local copy of the held gun the moment the hold is known, even
      // if the holder's avatar/hand isn't ready yet (ghost spawns a later tick).
      this._hideGun(h.objId);
      if (this._ghosts.has(h.objId)) continue;

      const attach = this._attachPoint(h.holder, h.hand);
      if (!attach) continue; // avatar not spawned yet — retry next tick (gun stays hidden)

      const group = createLightGun({ position: h.hand ? HAND_OFFSET : HEAD_OFFSET });
      this._tintGhost(group);
      attach.add(group);
      this._ghosts.set(h.objId, { group, holder: h.holder });
    }
  }

  /** True if the gun with the given cableId is held by a remote peer. */
  isRemotelyHeld(cableId) {
    return this._heldBy.has(cableId);
  }

  _attachPoint(holder, hand) {
    const handObj = hand ? this.avatars.getHand(holder, hand) : null;
    return handObj || this.avatars.getHead(holder) || null;
  }

  // Semi-transparent, so a ghost reads as "someone else's gun" even though it's
  // built from the same createLightGun() geometry as the real prop. createLightGun
  // builds fresh per-instance materials, so mutating them here never touches any
  // other gun (real or ghost).
  _tintGhost(group) {
    group.traverse((o) => {
      const mat = o.material;
      if (!mat) return;
      for (const mm of Array.isArray(mat) ? mat : [mat]) {
        mm.transparent = true;
        mm.opacity = 0.7;
        mm.depthWrite = false;
      }
    });
  }

  _hideGun(cableId) {
    if (this._hidden.has(cableId)) return;
    const gun = this.lightGunObjs.get(cableId);
    if (gun) { gun.visible = false; this._hidden.set(cableId, gun); }
  }

  _unhideGun(cableId) {
    const gun = this._hidden.get(cableId);
    if (gun) gun.visible = true;
    this._hidden.delete(cableId);
  }

  _removeGhost(cableId) {
    const g = this._ghosts.get(cableId);
    if (g) {
      g.group.parent?.remove(g.group);
      g.group.traverse((o) => {
        o.geometry?.dispose?.();
        const mat = o.material;
        if (mat) for (const mm of Array.isArray(mat) ? mat : [mat]) mm.dispose?.();
      });
      this._ghosts.delete(cableId);
    }
    this._heldBy.delete(cableId);
    this._unhideGun(cableId);
  }

  removeAll() {
    for (const cableId of [...this._ghosts.keys()]) this._removeGhost(cableId);
    for (const cableId of [...this._hidden.keys()]) this._unhideGun(cableId);
    this._heldBy.clear();
  }

  get ghostCount() { return this._ghosts.size; }
  get hiddenCount() { return this._hidden.size; }
  hasGhost(cableId) { return this._ghosts.has(cableId); }
  heldBy(cableId) { return this._heldBy.get(cableId) || null; }
  isHidden(cableId) { return this._hidden.has(cableId); }
}
