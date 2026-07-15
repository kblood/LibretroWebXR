// GhostMouseMgr: the visible half of shared-mouse sync. When a remote peer
// holds the in-world mouse, every other peer hides their own local copy of that
// mouse and shows a ghost mesh attached to the holder's synced avatar hand — so
// the ghost automatically tracks the holder's real hand pose (mirrors the gun's
// alignToController convention, see [[src/GrabMgr.js]]).
//
// Mirror of [[src/GhostLightGunMgr.js]] (itself a mirror of
// [[src/GhostGamepadMgr.js]]). Same deliberate scope limit as the gun: a remote
// peer's live cursor motion / button state is NOT mirrored here — this covers
// presence and hand-pose only, not live pointer feedback.
//
// Driven each frame from the `hold:mouse:<cableId>` STATE keys via
// [[src/net/HoldState.js]] and [[src/net/AvatarMgr.js]].

import * as THREE from 'three';
import { createMouse } from './Mouse.js';

const HAND_OFFSET = new THREE.Vector3(0, 0, -0.05);     // just past the hand cone
const HEAD_OFFSET = new THREE.Vector3(0.2, -0.1, -0.2);  // desktop fallback

// Prefix used for mouse hold keys (lives in the `hold:` namespace so the Hub
// auto-clears these when the owner disconnects, freeing the mouse for others).
// Distinct from the bare `mouse:<cableId>` port-binding channel — that one has
// no `hold:` prefix, so the two never collide.
export const MOUSE_HOLD_PREFIX = 'mouse:';

/** STATE key for holding the mouse with the given cableId. */
export function makeMouseHoldKey(cableId) {
  return `hold:${MOUSE_HOLD_PREFIX}${cableId}`;
}

/** True if a STATE key refers to a held mouse. */
export function isMouseHoldKey(key) {
  return typeof key === 'string' && key.startsWith(`hold:${MOUSE_HOLD_PREFIX}`);
}

/** Extract the cableId from a mouse hold key, or null. */
export function cableIdFromMouseHoldKey(key) {
  if (!isMouseHoldKey(key)) return null;
  return key.slice(`hold:${MOUSE_HOLD_PREFIX}`.length);
}

export class GhostMouseMgr {
  /**
   * @param {object} opts
   * @param {AvatarMgr} opts.avatars   - the scene's avatar manager
   * @param {Map}       opts.mouseObjs - cableId -> mouse Object3D (from _mouseObjsById)
   */
  constructor({ avatars, mouseObjs }) {
    this.avatars = avatars;
    this.mouseObjs = mouseObjs;          // cableId -> Object3D
    this._ghosts = new Map();            // cableId -> { group, holder }
    this._heldBy = new Map();            // cableId -> holder peerId (for isRemotelyHeld)
    this._hidden = new Map();            // cableId -> Object3D we hid (real local mouse)
  }

  /**
   * Reconcile against the desired holds (already filtered: no self, present
   * holders). Each hold is { objId: cableId, holder, hand }.
   */
  sync(holds) {
    const want = new Map(holds.map((h) => [h.objId, h]));

    // Remove ghosts whose hold is gone or holder changed; unhide the real mouse.
    for (const [cableId, g] of [...this._ghosts]) {
      const h = want.get(cableId);
      if (!h || h.holder !== g.holder) this._removeGhost(cableId);
    }
    // Unhide anything still hidden whose hold has fully ended — checked
    // independently of the ghost lifecycle above (mirrors GhostLightGunMgr: a
    // hold can start and end before the holder's avatar hand is ever available).
    for (const cableId of [...this._hidden.keys()]) {
      if (!want.has(cableId)) this._unhideMouse(cableId);
    }

    // Update _heldBy map (all remote holds, including ones without a ghost yet).
    this._heldBy.clear();
    for (const h of holds) {
      this._heldBy.set(h.objId, h.holder);
    }

    for (const h of holds) {
      // Hide our local copy of the held mouse the moment the hold is known, even
      // if the holder's avatar/hand isn't ready yet (ghost spawns a later tick).
      this._hideMouse(h.objId);
      if (this._ghosts.has(h.objId)) continue;

      const attach = this._attachPoint(h.holder, h.hand);
      if (!attach) continue; // avatar not spawned yet — retry next tick (mouse stays hidden)

      const group = createMouse({ position: h.hand ? HAND_OFFSET : HEAD_OFFSET });
      this._tintGhost(group);
      attach.add(group);
      this._ghosts.set(h.objId, { group, holder: h.holder });
    }
  }

  /** True if the mouse with the given cableId is held by a remote peer. */
  isRemotelyHeld(cableId) {
    return this._heldBy.has(cableId);
  }

  _attachPoint(holder, hand) {
    const handObj = hand ? this.avatars.getHand(holder, hand) : null;
    return handObj || this.avatars.getHead(holder) || null;
  }

  // Semi-transparent, so a ghost reads as "someone else's mouse" even though
  // it's built from the same createMouse() geometry as the real prop.
  // createMouse builds fresh per-instance materials, so mutating them here
  // never touches any other mouse (real or ghost).
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

  _hideMouse(cableId) {
    if (this._hidden.has(cableId)) return;
    const mouse = this.mouseObjs.get(cableId);
    if (mouse) { mouse.visible = false; this._hidden.set(cableId, mouse); }
  }

  _unhideMouse(cableId) {
    const mouse = this._hidden.get(cableId);
    if (mouse) mouse.visible = true;
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
    this._unhideMouse(cableId);
  }

  removeAll() {
    for (const cableId of [...this._ghosts.keys()]) this._removeGhost(cableId);
    for (const cableId of [...this._hidden.keys()]) this._unhideMouse(cableId);
    this._heldBy.clear();
  }

  get ghostCount() { return this._ghosts.size; }
  get hiddenCount() { return this._hidden.size; }
  hasGhost(cableId) { return this._ghosts.has(cableId); }
  heldBy(cableId) { return this._heldBy.get(cableId) || null; }
  isHidden(cableId) { return this._hidden.has(cableId); }
}
