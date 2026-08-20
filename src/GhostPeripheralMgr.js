// GhostPeripheralMgr: the visible half of shared-peripheral sync, for every
// PORT-BOUND device (gamepad / light gun / mouse). One manager, parameterised
// by a descriptor from [[src/CabledPeripheral.js]]; it replaces the three
// hand-maintained copies GhostGamepadMgr / GhostLightGunMgr / GhostMouseMgr
// (CLAUDE_REVIEW §3.3 — those three files are now thin shims over this one).
//
// When a remote peer holds a peripheral, every other peer shows a ghost mesh in
// that peer's avatar hand, LOCKS the local copy from being grabbed (only one
// player can hold a given device at a time), and HIDES the real local mesh so
// only the ghost in the holder's hand is visible (mirroring GhostCartMgr).
//
// Attaching the ghost to the holder's AVATAR HAND is what makes it track the
// holder's real aim for free: the hand already carries a full synced 6dof pose,
// and GrabMgr's alignToController convention (see [[src/GrabMgr.js]]) is
// exactly what makes a hand-attached gun point the same way the holder is
// actually aiming.
//
// sync(holds) diffs desired holds against live ghosts, creating or removing
// meshes. The real local prop is hidden while remotely held (the ghost in the
// holder's hand replaces it visually), and shown again when the hold is cleared.
//
// isRemotelyHeld(cableId) is the lock predicate GrabMgr consults to refuse a
// grab on a device that a remote peer is using.
//
// Driven each frame from the `hold:<prefix><cableId>` STATE keys via
// [[src/net/HoldState.js]] and [[src/net/AvatarMgr.js]].
//
// Per-device differences live in the DESCRIPTOR, never here: the mesh factory,
// the hand/head offsets, and the ghost tint (the gamepad's is emissively keyed
// to the player it drives; the gun's and mouse's are a plain translucency).
// The one behavioural difference — only the gamepad mirrors live INPUT (the
// 'gp' wire channel) — needs no branch at all: applyInput() is simply never
// called for a gun or a mouse, so their `_lastInput` stays empty and the replay
// below is unreachable for them. `desc.mirrorsInput` documents which is which.

export class GhostPeripheralMgr {
  /**
   * @param {object} desc                 - a [[src/CabledPeripheral.js]] descriptor
   * @param {object} opts
   * @param {AvatarMgr} opts.avatars      - the scene's avatar manager
   * @param {Map}       opts.objs         - cableId -> prop Object3D (the local index:
   *                                        _gamepadObjs / _lightGunObjsById / _mouseObjsById)
   */
  constructor(desc, { avatars, objs }) {
    this.desc = desc;
    this.avatars = avatars;
    this.objs = objs;                    // cableId -> Object3D
    this._ghosts = new Map();            // cableId -> { group, holder }
    this._heldBy = new Map();            // cableId -> holder peerId (for isRemotelyHeld)
    this._hidden = new Map();            // cableId -> Object3D we hid (the real local prop)
    // Last button state received for a pad (M2 'gp' wire). Replayed onto a ghost
    // the moment it spawns, so a ghost created after the first packet isn't blank.
    this._lastInput = new Map();         // cableId -> input object for setInput
  }

  /**
   * Reconcile against the desired holds (already filtered: no self, present
   * holders). Each hold is { objId: cableId, holder, hand }.
   */
  sync(holds) {
    const want = new Map(holds.map((h) => [h.objId, h]));

    // Remove ghosts whose hold is gone or holder changed; unhide the real prop.
    for (const [cableId, g] of [...this._ghosts]) {
      const h = want.get(cableId);
      if (!h || h.holder !== g.holder) this._removeGhost(cableId);
    }
    // Unhide anything still hidden whose hold has fully ended — checked
    // independently of the ghost lifecycle above. A hold can start and end
    // before the holder's avatar hand is ever available to attach a ghost to
    // (see the `if (!attach) continue` below), in which case no ghost is ever
    // created and the removal loop above never runs for it; without this
    // sweep the local prop would stay hidden forever.
    for (const cableId of [...this._hidden.keys()]) {
      if (!want.has(cableId)) this._unhideObj(cableId);
    }

    // Update _heldBy map (all remote holds, including ones without a ghost yet).
    this._heldBy.clear();
    for (const h of holds) {
      this._heldBy.set(h.objId, h.holder);
    }

    for (const h of holds) {
      // Hide our local copy of the held prop the moment the hold is known, even
      // if the holder's avatar/hand isn't ready yet (ghost spawns a later tick).
      this._hideObj(h.objId);
      if (this._ghosts.has(h.objId)) continue;

      const attach = this._attachPoint(h.holder, h.hand);
      if (!attach) continue; // avatar not spawned yet — retry next tick (prop stays hidden)

      const group = this.desc.ghostFactory({
        position: h.hand ? this.desc.ghostHandOffset : this.desc.ghostHeadOffset,
      });
      this.desc.tintGhost(group, h.objId);
      attach.add(group);
      this._ghosts.set(h.objId, { group, holder: h.holder });
      // Replay the last-known button state so it isn't blank for a frame.
      const last = this._lastInput.get(h.objId);
      if (last) group.userData.setInput?.(last);
    }
  }

  /**
   * Drive a remotely-held pad's button visuals from a 'gp' wire payload
   * ({ a, b, start, select, axisX, axisY }). Stored so a not-yet-spawned ghost
   * picks it up on creation; applied immediately if the ghost exists.
   */
  applyInput(cableId, input) {
    if (!input) return;
    this._lastInput.set(cableId, input);
    const g = this._ghosts.get(cableId);
    if (g) g.group.userData.setInput?.(input);
  }

  /** True if the prop with the given cableId is held by a remote peer. */
  isRemotelyHeld(cableId) {
    return this._heldBy.has(cableId);
  }

  _attachPoint(holder, hand) {
    const handObj = hand ? this.avatars.getHand(holder, hand) : null;
    return handObj || this.avatars.getHead(holder) || null;
  }

  _hideObj(cableId) {
    if (this._hidden.has(cableId)) return;
    const obj = this.objs.get(cableId);
    if (obj) { obj.visible = false; this._hidden.set(cableId, obj); }
  }

  _unhideObj(cableId) {
    const obj = this._hidden.get(cableId);
    if (obj) obj.visible = true;
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
    this._lastInput.delete(cableId);
    this._unhideObj(cableId);
  }

  removeAll() {
    for (const cableId of [...this._ghosts.keys()]) this._removeGhost(cableId);
    for (const cableId of [...this._hidden.keys()]) this._unhideObj(cableId);
    this._heldBy.clear();
  }

  get ghostCount() { return this._ghosts.size; }
  get hiddenCount() { return this._hidden.size; }
  hasGhost(cableId) { return this._ghosts.has(cableId); }
  heldBy(cableId) { return this._heldBy.get(cableId) || null; }
  isHidden(cableId) { return this._hidden.has(cableId); }
}
