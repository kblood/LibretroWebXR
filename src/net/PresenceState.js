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
    // PERF-4(b): the ROSTER half of the per-frame memo key. Bumped when WHO is
    // here changes (join / leave / prune / self-id / clear) — never on a POSE,
    // which is the overwhelming majority of traffic and changes a peer's
    // contents, not the set. Consumers that only care about the set (the four
    // ghost-sync ticks, each of which built its own `new Set(peers().map(...))`
    // every rendered frame) memoise on this.
    //
    // This axis is load-bearing on its own: a peer LEAVING changes the present
    // set without touching a single STATE key, and the ghost managers' sweep
    // over the shrunken hold list is what unhides a LOCAL prop that peer was
    // holding (COR-2/COR-8). Memoise on room state alone and that prop stays
    // invisible for the rest of the build.
    this._rosterVersion = 0;
    this._idsCache = null;      // { version, ids: string[], set: Set<string> }
  }

  /** Bumped when the set of peers (or our own id) changes — not on pose. */
  get rosterVersion() { return this._rosterVersion; }

  _bumpRoster() { this._rosterVersion++; this._idsCache = null; }

  setSelfId(id) {
    const next = id == null ? null : String(id);
    // Our own id decides which holds are OURS (parseHolds drops them), so a
    // change here invalidates every memoised view exactly like a join does.
    if (next !== this.selfId) { this.selfId = next; this._bumpRoster(); }
  }

  _isSelf(id) { return this.selfId != null && String(id) === this.selfId; }

  _ensure(id, nowMs) {
    const key = String(id);
    let p = this._peers.get(key);
    if (!p) {
      p = { id: key, nick: 'Player', color: '#88aaff', pose: null, lastSeen: nowMs };
      this._peers.set(key, p);
      this._bumpRoster();
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
    if (this._peers.delete(String(id))) this._bumpRoster();
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
    if (removed.length) this._bumpRoster();
    return removed;
  }

  /** All remote peers (self already excluded). */
  peers() { return [...this._peers.values()]; }

  /**
   * The peer ids, as arrays/sets that are REBUILT ONLY WHEN THE ROSTER CHANGES
   * — the callers below run every rendered frame and each used to build its own
   * copy (PERF-4(b)). Treat both as READ-ONLY: they are shared between every
   * caller until the next join/leave, so mutating either corrupts the others.
   */
  _ids() {
    if (!this._idsCache || this._idsCache.version !== this._rosterVersion) {
      const ids = [...this._peers.keys()];
      this._idsCache = { version: this._rosterVersion, ids, set: new Set(ids) };
    }
    return this._idsCache;
  }

  /** Read-only array of peer ids (see _ids). */
  ids() { return this._ids().ids; }

  /** Read-only Set of peer ids (see _ids) — what parseHolds wants for presentIds. */
  idSet() { return this._ids().set; }

  get(id) { return this._peers.get(String(id)) || null; }

  get size() { return this._peers.size; }

  clear() {
    if (this._peers.size) this._bumpRoster();
    this._peers.clear();
  }
}
