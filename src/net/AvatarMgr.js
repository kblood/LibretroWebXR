// AvatarMgr: reflects the pure [[src/net/PresenceState.js]] peer list into the
// THREE scene — one [[src/net/Avatar.js]] per remote peer, created/updated/
// removed as peers come and go. The imperative half of the presence layer; all
// the "who is here" logic lives in PresenceState (and is unit-tested), this just
// mirrors it into meshes.
//
// Wiring (in main.js): one scene tick callback calls sync(presence.peers())
// then tick(dt). [[src/net/NetMgr.js]] keeps PresenceState fed from the wire.

import { Avatar } from './Avatar.js';

export class AvatarMgr {
  constructor({ scene }) {
    this.scene = scene;            // SceneMgr (addObject/removeObject)
    this._avatars = new Map();     // peerId -> Avatar
  }

  /**
   * Reconcile against the current peer list: spawn avatars for new peers, push
   * the latest pose to existing ones, and remove avatars whose peer is gone.
   */
  sync(peers) {
    const seen = new Set();
    for (const peer of peers) {
      seen.add(peer.id);
      let av = this._avatars.get(peer.id);
      if (!av) {
        av = new Avatar({ nick: peer.nick, color: peer.color });
        this._avatars.set(peer.id, av);
        this.scene.addObject(av.group);
      }
      if (peer.pose) av.update(peer.pose);
    }
    for (const [id, av] of this._avatars) {
      if (!seen.has(id)) this._remove(id, av);
    }
  }

  /** Ease every avatar toward its latest target (call each frame). */
  tick(dtMs) {
    for (const av of this._avatars.values()) av.tick(dtMs);
  }

  /** The head Object3D for a peer (for VoiceMgr's positional audio), or null. */
  getHead(peerId) {
    const av = this._avatars.get(peerId);
    return av ? av.head : null;
  }

  /**
   * A hand Object3D for a peer ('left'|'right'), for attaching a held-object
   * ghost ([[src/GhostCartMgr.js]]). Returns null if the avatar or that hand
   * isn't present. The hand is only *visible* when its pose is tracked (a VR
   * controller); on desktop callers fall back to getHead().
   */
  getHand(peerId, which) {
    const av = this._avatars.get(peerId);
    if (!av) return null;
    return which === 'right' ? av.rightHand : which === 'left' ? av.leftHand : null;
  }

  _remove(id, av) {
    this.scene.removeObject(av.group);
    av.dispose();
    this._avatars.delete(id);
  }

  removeAll() {
    for (const [id, av] of [...this._avatars]) this._remove(id, av);
  }

  get count() { return this._avatars.size; }
}
