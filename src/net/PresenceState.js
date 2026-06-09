// PresenceState: the client-side registry of remote peers in a shared room —
// who's here, their nick/color, and their latest avatar pose. Pure bookkeeping
// (no THREE / no socket), so `npm test` covers it; [[src/net/AvatarMgr.js]]
// reads peers() each frame to create/update/remove avatar meshes, and
// [[src/net/NetMgr.js]] feeds it decoded messages from the wire.
//
// Mirrors the pure/imperative split used elsewhere (CableMgr, RoomLoader): all
// the "what should be shown" logic lives here and is testable; the THREE side
// just reflects it.
//
// Self is tracked by id and excluded from peers() — we never render our own
// avatar. Peers also expire: if POSE updates stop arriving for `ttlMs` (tab
// closed without a clean LEAVE, network drop), prune() drops them so stale
// avatars don't linger.

import { MSG } from './NetProtocol.js';

export class PresenceState {
  constructor({ selfId = null, ttlMs = 5000 } = {}) {
    this.selfId = selfId == null ? null : String(selfId);
    this.ttlMs = ttlMs;
    this._peers = new Map(); // id -> { id, nick, color, pose, lastSeen }
  }

  setSelfId(id) { this.selfId = id == null ? null : String(id); }

  _isSelf(id) { return this.selfId != null && String(id) === this.selfId; }

  _ensure(id, nowMs) {
    const key = String(id);
    let p = this._peers.get(key);
    if (!p) {
      p = { id: key, nick: 'Player', color: '#88aaff', pose: null, lastSeen: nowMs };
      this._peers.set(key, p);
    }
    return p;
  }

  /**
   * Dispatch a decoded NetProtocol message. `nowMs` is the caller's clock
   * (passed in so this stays pure / deterministic in tests). Returns the set of
   * peer ids that changed, for callers that want to react incrementally.
   */
  apply(msg, nowMs = 0) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case MSG.HELLO:
        this.setSelfId(msg.selfId);
        for (const p of msg.peers || []) this.applyJoin(p, nowMs);
        return;
      case MSG.JOIN:
        return this.applyJoin(msg, nowMs);
      case MSG.LEAVE:
        return this.applyLeave(msg.id);
      case MSG.POSE:
        return this.applyPose(msg, nowMs);
      default:
        return;
    }
  }

  applyJoin({ id, nick, color } = {}, nowMs = 0) {
    if (id == null || this._isSelf(id)) return;
    const p = this._ensure(id, nowMs);
    if (typeof nick === 'string') p.nick = nick;
    if (typeof color === 'string') p.color = color;
    p.lastSeen = nowMs;
  }

  applyLeave(id) {
    if (id == null) return;
    this._peers.delete(String(id));
  }

  applyPose(msg, nowMs = 0) {
    const { id } = msg;
    if (id == null || this._isSelf(id)) return;
    const p = this._ensure(id, nowMs);
    p.pose = { head: msg.head ?? null, left: msg.left ?? null, right: msg.right ?? null };
    p.lastSeen = nowMs;
  }

  /** Drop peers whose last update is older than ttlMs. Returns removed ids. */
  prune(nowMs = 0) {
    const removed = [];
    for (const [id, p] of this._peers) {
      if (nowMs - p.lastSeen > this.ttlMs) { this._peers.delete(id); removed.push(id); }
    }
    return removed;
  }

  /** All remote peers (self already excluded). */
  peers() { return [...this._peers.values()]; }

  get(id) { return this._peers.get(String(id)) || null; }

  get size() { return this._peers.size; }

  clear() { this._peers.clear(); }
}
