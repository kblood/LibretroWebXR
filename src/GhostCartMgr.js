// GhostCartMgr: the visible half of held-object sync (M0). When a remote peer
// grabs a cartridge, we hide OUR copy of that cart (it has "left the shelf" in
// the shared room) and show a small ghost cartridge in that peer's avatar hand.
// Imperative THREE, driven each frame from the pure hold rules
// ([[src/net/HoldState.js]]) over the shared STATE channel ([[src/net/RoomObjects.js]]).
//
// Mirrors the AvatarMgr.sync reconcile pattern: sync(entries) diffs the desired
// holds against the live ghosts, spawning/moving/removing meshes. Tick-based (not
// purely reactive) so it tolerates the avatar for a holder appearing a frame or
// two after its hold STATE arrives, and so a holder leaving (hold cleared +
// avatar removed) cleanly unhides the cart.
//
// Cart identity is the cartridge's `file` (every peer builds the same room.json,
// so files line up). Limitation: two shelves hosting the same file would alias —
// acceptable for M0 presence (no object authority yet).

import * as THREE from 'three';

const GHOST_GEOM = new THREE.BoxGeometry(0.09, 0.12, 0.02); // cartridge-ish
const HAND_OFFSET = new THREE.Vector3(0, 0, -0.04);          // sit just past the hand cone
const HEAD_OFFSET = new THREE.Vector3(0.18, -0.12, -0.15);   // desktop fallback: beside the head

export class GhostCartMgr {
  constructor({ avatars, getCartByObjId }) {
    this.avatars = avatars;
    this.getCartByObjId = getCartByObjId;       // (objId) => Object3D|null
    this._ghosts = new Map();                   // objId -> { mesh, holder }
    this._hidden = new Map();                   // objId -> cart Object3D we hid
  }

  /** Reconcile against the desired holds (already filtered: no self, present holders). */
  sync(holds) {
    const want = new Map(holds.map((h) => [h.objId, h]));

    // Remove ghosts whose hold is gone or whose holder changed; unhide the cart.
    for (const [objId, g] of [...this._ghosts]) {
      const h = want.get(objId);
      if (!h || h.holder !== g.holder) this._removeGhost(objId);
    }
    // Unhide anything still hidden whose hold has fully ended — checked
    // independently of the ghost lifecycle above. A hold can start and end
    // before the holder's avatar hand is ever available to attach a ghost to
    // (see the `if (!attach) continue` below), in which case no ghost is ever
    // created and the removal loop above never runs for it; without this
    // sweep the local cart would stay hidden forever.
    for (const objId of [...this._hidden.keys()]) {
      if (!want.has(objId)) this._unhideCart(objId);
    }

    for (const h of holds) {
      // Hide our local copy of the held cart the moment the hold is known, even
      // if the holder's avatar/hand isn't ready yet (ghost spawns a later tick).
      this._hideCart(h.objId);
      if (this._ghosts.has(h.objId)) continue;

      const attach = this._attachPoint(h.holder, h.hand);
      if (!attach) continue; // avatar not spawned yet — retry next tick (cart stays hidden)

      const mesh = new THREE.Mesh(GHOST_GEOM, this._ghostMat(h.objId));
      mesh.position.copy(h.hand ? HAND_OFFSET : HEAD_OFFSET);
      attach.add(mesh);
      this._ghosts.set(h.objId, { mesh, holder: h.holder });
    }
  }

  _attachPoint(holder, hand) {
    const handObj = hand ? this.avatars.getHand(holder, hand) : null;
    return handObj || this.avatars.getHead(holder) || null;
  }

  _ghostMat(objId) {
    const cart = this.getCartByObjId(objId);
    const color = cart?.userData?.color != null ? new THREE.Color(cart.userData.color) : new THREE.Color('#cfd2dc');
    return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 });
  }

  _hideCart(objId) {
    if (this._hidden.has(objId)) return;
    const cart = this.getCartByObjId(objId);
    if (cart) { cart.visible = false; this._hidden.set(objId, cart); }
  }

  _unhideCart(objId) {
    const cart = this._hidden.get(objId);
    if (cart) cart.visible = true;
    this._hidden.delete(objId);
  }

  _removeGhost(objId) {
    const g = this._ghosts.get(objId);
    if (g) {
      g.mesh.parent?.remove(g.mesh);
      g.mesh.material?.dispose();
      this._ghosts.delete(objId);
    }
    this._unhideCart(objId);
  }

  removeAll() {
    for (const objId of [...this._ghosts.keys()]) this._removeGhost(objId);
    for (const objId of [...this._hidden.keys()]) this._unhideCart(objId);
  }

  get ghostCount() { return this._ghosts.size; }
  get hiddenCount() { return this._hidden.size; }
  hasGhost(objId) { return this._ghosts.has(objId); }
}
