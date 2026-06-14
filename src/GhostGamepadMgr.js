// GhostGamepadMgr: the visible half of shared-gamepad sync. When a remote peer
// holds a gamepad, every other peer shows a ghost gamepad mesh in that peer's
// avatar hand, LOCKS the local copy from being grabbed (only one player can
// hold a given gamepad at a time), and HIDES the real local gamepad mesh so
// only the ghost in the holder's hand is visible (mirroring GhostCartMgr).
// Driven each frame from the `hold:gp:<cableId>` STATE keys via
// [[src/net/HoldState.js]] and [[src/net/AvatarMgr.js]].
//
// Mirror of [[src/GhostCartMgr.js]]: sync(holds) diffs desired holds against
// live ghosts, creating or removing meshes. The real local gamepad is hidden
// while remotely held (the ghost in the holder's hand replaces it visually),
// and shown again when the hold is cleared.
//
// isRemotelyHeld(cableId) is the lock predicate GrabMgr consults to refuse a
// grab on a gamepad that a remote peer is using.

import * as THREE from 'three';

// A small controller-pad silhouette for the ghost: thin rounded-ish box.
const GHOST_GEOM = new THREE.BoxGeometry(0.14, 0.06, 0.09);
const HAND_OFFSET = new THREE.Vector3(0, 0, -0.06);   // just past the hand cone
const HEAD_OFFSET = new THREE.Vector3(0.2, -0.1, -0.18); // desktop fallback

// Prefix used for gamepad hold keys (lives in the `hold:` namespace so the Hub
// auto-clears these when the owner disconnects, freeing the gamepad for others).
export const GP_HOLD_PREFIX = 'gp:';

/** STATE key for holding gamepad with the given cableId. */
export function makeGamepadHoldKey(cableId) {
  return `hold:${GP_HOLD_PREFIX}${cableId}`;
}

/** True if a STATE key refers to a held gamepad. */
export function isGamepadHoldKey(key) {
  return typeof key === 'string' && key.startsWith(`hold:${GP_HOLD_PREFIX}`);
}

/** Extract the cableId from a gamepad hold key, or null. */
export function cableIdFromHoldKey(key) {
  if (!isGamepadHoldKey(key)) return null;
  return key.slice(`hold:${GP_HOLD_PREFIX}`.length);
}

export class GhostGamepadMgr {
  /**
   * @param {object} opts
   * @param {AvatarMgr}   opts.avatars      - the scene's avatar manager
   * @param {Map}         opts.gamepadObjs  - cableId -> gamepad Object3D (from _gamepadObjs)
   */
  constructor({ avatars, gamepadObjs }) {
    this.avatars = avatars;
    this.gamepadObjs = gamepadObjs;      // cableId -> Object3D
    this._ghosts = new Map();            // cableId -> { mesh, holder }
    this._heldBy = new Map();            // cableId -> holder peerId (for isRemotelyHeld)
    this._hidden = new Map();            // cableId -> Object3D we hid (real local gamepad)
  }

  /**
   * Reconcile against the desired holds (already filtered: no self, present
   * holders). Each hold is { objId: cableId, holder, hand }.
   */
  sync(holds) {
    const want = new Map(holds.map((h) => [h.objId, h]));

    // Remove ghosts whose hold is gone or holder changed; unhide the real gamepad.
    for (const [cableId, g] of [...this._ghosts]) {
      const h = want.get(cableId);
      if (!h || h.holder !== g.holder) this._removeGhost(cableId);
    }

    // Update _heldBy map (all remote holds, including ones without a ghost yet).
    this._heldBy.clear();
    for (const h of holds) {
      this._heldBy.set(h.objId, h.holder);
    }

    for (const h of holds) {
      // Hide our local copy of the held gamepad the moment the hold is known,
      // even if the holder's avatar/hand isn't ready yet (ghost spawns a later tick).
      this._hideGamepad(h.objId);
      if (this._ghosts.has(h.objId)) continue;

      const attach = this._attachPoint(h.holder, h.hand);
      if (!attach) continue; // avatar not spawned yet — retry next tick (gamepad stays hidden)

      const mesh = new THREE.Mesh(GHOST_GEOM, this._ghostMat(h.objId));
      mesh.position.copy(h.hand ? HAND_OFFSET : HEAD_OFFSET);
      attach.add(mesh);
      this._ghosts.set(h.objId, { mesh, holder: h.holder });
    }
  }

  /** True if the gamepad with the given cableId is held by a remote peer. */
  isRemotelyHeld(cableId) {
    return this._heldBy.has(cableId);
  }

  _attachPoint(holder, hand) {
    const handObj = hand ? this.avatars.getHand(holder, hand) : null;
    return handObj || this.avatars.getHead(holder) || null;
  }

  _ghostMat(cableId) {
    // Tint by which port/player this pad drives (matching PLAYER_CORD_COLORS).
    const PLAYER_COLORS = [0x33cc55, 0x3388ff, 0xffaa33, 0xcc55dd];
    // cableId is 'gp-N', port = N-1
    const m = cableId.match(/^gp-(\d+)$/);
    const port = m ? (parseInt(m[1], 10) - 1) : 0;
    const hex = PLAYER_COLORS[port % PLAYER_COLORS.length];
    return new THREE.MeshStandardMaterial({
      color: new THREE.Color(hex),
      roughness: 0.5,
      metalness: 0.05,
      transparent: true,
      opacity: 0.65,
    });
  }

  _hideGamepad(cableId) {
    if (this._hidden.has(cableId)) return;
    const gp = this.gamepadObjs.get(cableId);
    if (gp) { gp.visible = false; this._hidden.set(cableId, gp); }
  }

  _unhideGamepad(cableId) {
    const gp = this._hidden.get(cableId);
    if (gp) gp.visible = true;
    this._hidden.delete(cableId);
  }

  _removeGhost(cableId) {
    const g = this._ghosts.get(cableId);
    if (g) {
      g.mesh.parent?.remove(g.mesh);
      g.mesh.material?.dispose();
      this._ghosts.delete(cableId);
    }
    this._heldBy.delete(cableId);
    this._unhideGamepad(cableId);
  }

  removeAll() {
    for (const cableId of [...this._ghosts.keys()]) this._removeGhost(cableId);
    for (const cableId of [...this._hidden.keys()]) this._unhideGamepad(cableId);
    this._heldBy.clear();
  }

  get ghostCount() { return this._ghosts.size; }
  get hiddenCount() { return this._hidden.size; }
  hasGhost(cableId) { return this._ghosts.has(cableId); }
  heldBy(cableId) { return this._heldBy.get(cableId) || null; }
  isHidden(cableId) { return this._hidden.has(cableId); }
}
