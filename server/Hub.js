// Hub: the room-server's pure bookkeeping — which peers are in which room, and
// what to broadcast on connect / identify / pose / disconnect. No `ws`, no
// sockets, so `npm test` (scripts/test-net.mjs) covers the relay logic; the thin
// adapter (server/room-server.mjs) maps peerId↔socket and does the actual sends.
//
// Imports the SAME [[src/net/NetProtocol.js]] builders the browser client uses,
// so the two ends can't drift. The server is authoritative over peer `id`: it
// stamps the connection's id onto every rebroadcast, so a client can't forge a
// pose/join as someone else.

import { makeHello, makeHost, makeJoin, makeLeave, makeState, MSG } from '../src/net/NetProtocol.js';

// M1.4 host election: how long the room stays HOSTLESS after its host's socket
// drops, so that host can reclaim the role by reconnecting with the same session
// id. Covers the app's own cross-core `location.reload()` (a host that swaps to a
// different-core cartridge, or arms the light gun via the reload fallback, is gone
// for ~2-5s) and a Wi-Fi blip.
//
// Migration is DEFERRED for this whole window rather than promoting a stand-in
// immediately, because a stand-in gets promoted → boots the room's cartridge into
// its own core → is demoted ~150ms later when the real host returns, leaving every
// client with its own extra core instance. That transient promotion on every
// ordinary host game-switch was one of the "each computer runs its own game"
// causes. Deferring also means a reclaim can never steal the role from a peer
// that has already taken over and started playing: during the window nobody has
// it, and once it expires the grace record is dropped for good.
// See docs/MULTIPLAYER.md "Host election".
export const HOST_RECLAIM_MS = 15000;

// Shared STATE keys only the HOST may write. Enforced server-side (a client-side
// check alone is worthless: an older deployed build still writes `tv` on every
// local boot, and the host's own convergence path would then boot whatever that
// client wrote — i.e. a stale client could hijack what the room is playing).
//   tv       — which game is on the room's screen
//   room     — the host's serialized room layout
//   shelf:*  — the host's shelf contents (inlined collections + local carts)
export function isHostOwnedKey(key) {
  return key === 'tv' || key === 'room' || (typeof key === 'string' && key.startsWith('shelf:'));
}

export class Hub {
  constructor() {
    this.rooms = new Map();      // roomId -> Map(peerId -> { id, nick, color, sid, seq })
    this.roomState = new Map();  // roomId -> Map(key -> { value, id })  (M0.5)
    this.roomHosts = new Map();  // roomId -> peerId  (M1.4 — the elected host)
    this.hostGrace = new Map();  // roomId -> { sid, at }  (reclaim window, M1.4)
    this._seq = 0;               // monotonic join counter → seniority ordering
  }

  _room(roomId) {
    if (!this.rooms.has(roomId)) this.rooms.set(roomId, new Map());
    return this.rooms.get(roomId);
  }

  _state(roomId) {
    if (!this.roomState.has(roomId)) this.roomState.set(roomId, new Map());
    return this.roomState.get(roomId);
  }

  /**
   * The room's current authoritative host (M1.4), or null for an empty/unknown
   * room. Read-only: election happens in connect()/disconnect() only, so the
   * role never flips as a side effect of any in-room action (inserting a
   * cartridge, moving a prop, …).
   */
  hostOf(roomId) {
    const host = this.roomHosts.get(roomId) ?? null;
    if (host && this.rooms.get(roomId)?.has(host)) return host;
    return null;
  }

  /**
   * The room's live reclaim window, or null once it has elapsed.
   *
   * READ-ONLY on purpose. An earlier version deleted the expired record here, but
   * this is called from setState() too — so an ordinary client STATE write arriving
   * just after the window elapsed would drop the record before the adapter's timer
   * fired, and expireHostGrace() would then find nothing to expire and promote
   * NOBODY: the room would stay permanently hostless. Deletion belongs to the two
   * places that also decide who hosts next: connect() (a reclaim) and
   * expireHostGrace() (the timer), plus the whole-room teardown in disconnect().
   */
  _activeGrace(roomId, now = Date.now()) {
    const grace = this.hostGrace.get(roomId);
    if (!grace) return null;
    return (now - grace.at > HOST_RECLAIM_MS) ? null : grace;
  }

  /** The longest-present peer in a room (lowest join seq), or null. */
  _senior(roomId, { exclude = null } = {}) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    let best = null;
    for (const p of room.values()) {
      if (p.id === exclude) continue;
      if (!best || p.seq < best.seq) best = p;
    }
    return best ? best.id : null;
  }

  /**
   * A socket joined `roomId` as `peerId`. Returns { hello, state, hostBroadcast }:
   *  - `hello` — the roster of everyone already present, plus the room's elected
   *    host (M1.4) so the joiner knows at once whether it is the host.
   *  - `state` — a snapshot of the room's shared object state (M0.5) as STATE
   *    messages to replay directly to the new peer, so a late joiner converges
   *    (e.g. adopts the host's room layout and sees which game is on the TV).
   *  - `hostBroadcast` — set only when this connect CHANGED the host (an empty
   *    room's first peer with nobody to tell → null; a returning host reclaiming
   *    its role inside HOST_RECLAIM_MS → a HOST message for the others).
   *
   * `sid` is the client's stable per-tab session id (sent as `?sid=` on the
   * WebSocket URL). It is what makes the reclaim window work across a reload;
   * omit it and a reconnecting host simply joins as the most junior peer.
   *
   * Identity (nick/color) arrives later via a JOIN message → identify().
   */
  connect(roomId, peerId, { sid = null, now = Date.now() } = {}) {
    const room = this._room(roomId);
    const others = [...room.values()].map((p) => ({ id: p.id, nick: p.nick, color: p.color }));
    room.set(peerId, { id: peerId, nick: 'Player', color: '#88aaff', sid: sid == null ? null : String(sid), seq: ++this._seq });

    const prevHost = this.hostOf(roomId);
    const grace = this._activeGrace(roomId, now);
    let host = prevHost;
    if (grace) {
      // A departed host's reclaim window is open. Either this IS that host coming
      // back (same sid → hand the role straight back, so its own reload doesn't
      // strand the room), or the room stays deliberately HOSTLESS until the window
      // expires — promoting this joiner would give it the role for a second and
      // then take it away again.
      if (sid && grace.sid === String(sid)) {
        host = peerId;
        this.hostGrace.delete(roomId);
      } else {
        host = null;
      }
    } else if (!host) {
      host = peerId;                                   // first in → the host
    }
    if (host) this.roomHosts.set(roomId, host); else this.roomHosts.delete(roomId);

    const state = [...this._state(roomId).entries()].map(([key, s]) => makeState({ key, value: s.value, id: s.id }));
    const res = { hello: makeHello({ selfId: peerId, room: roomId, peers: others, host }), state };
    // Only tell the rest of the room when the role actually moved to the joiner.
    if (host && host !== prevHost && others.length) res.hostBroadcast = makeHost({ id: host });
    return res;
  }

  /**
   * Peer announced its nick/color (client→server JOIN). Records it and returns
   * { broadcast: { msg, exclude } } — a JOIN to relay to everyone else.
   */
  identify(roomId, peerId, { nick, color } = {}) {
    const room = this.rooms.get(roomId);
    const p = room?.get(peerId);
    if (!p) return {};
    if (typeof nick === 'string') p.nick = nick;
    if (typeof color === 'string') p.color = color;
    return { broadcast: { msg: makeJoin({ id: peerId, nick: p.nick, color: p.color }), exclude: peerId } };
  }

  /**
   * Peer sent a POSE. Stamp the server-side id (anti-spoof) and return a
   * broadcast to everyone else in the room.
   */
  pose(roomId, peerId, poseMsg) {
    const room = this.rooms.get(roomId);
    if (!room || !room.has(peerId)) return {};
    const msg = { ...poseMsg, type: MSG.POSE, id: peerId };
    return { broadcast: { msg, exclude: peerId } };
  }

  /**
   * Peer sent a SIGNAL (M0.4 voice). Stamp the real sender id and return
   * { direct: { to, msg } } — a DIRECTED relay to a single peer (not a
   * broadcast). Dropped if sender or target isn't in the room.
   */
  signal(roomId, fromPeerId, msg) {
    const room = this.rooms.get(roomId);
    if (!room || !room.has(fromPeerId) || !room.has(msg.to)) return {};
    return { direct: { to: msg.to, msg: { ...msg, from: fromPeerId } } };
  }

  /**
   * Peer set a shared room-object value (M0.5). Persists it (last-writer-wins;
   * a null value clears the key), stamps the real setter id, and returns a
   * broadcast to everyone else. Dropped if the sender isn't in the room.
   *
   * M1.4: the HOST-OWNED keys (`tv`, `room`, `shelf:*` — see isHostOwnedKey) are
   * rejected from anyone but the elected host, and the writer gets the current
   * authoritative value back as a `direct` correction so its optimistic local copy
   * doesn't diverge. Enforcing this only client-side would be meaningless: an
   * older deployed build still writes `tv` on every local boot, and the host's own
   * convergence path would dutifully boot whatever a client wrote.
   */
  setState(roomId, peerId, { key, value, now = Date.now() } = {}) {
    const room = this.rooms.get(roomId);
    if (!room || !room.has(peerId) || typeof key !== 'string' || key === '') return {};
    const state = this._state(roomId);
    if (isHostOwnedKey(key)) {
      const host = this.hostOf(roomId);
      // A room in its reclaim window has NO host on purpose. Accepting host-owned
      // writes then would let any client redefine what the room is playing / how it
      // is laid out in the few seconds a host takes to reload — and the returning
      // host's own convergence path would then adopt it. Treat "hostless because a
      // host is coming back" as "the absent host still owns these keys".
      if (!host && this._activeGrace(roomId, now)) {
        const cur = state.get(key);
        return {
          rejected: 'host-reclaim-window',
          direct: { to: peerId, msg: makeState({ key, value: cur ? cur.value : null, id: cur ? cur.id : peerId }) },
        };
      }
      if (host && host !== peerId) {
        const cur = state.get(key);
        return {
          rejected: 'not-host',
          direct: { to: peerId, msg: makeState({ key, value: cur ? cur.value : null, id: cur ? cur.id : host }) },
        };
      }
    }
    if (value == null) state.delete(key);
    else state.set(key, { value, id: peerId });
    return { broadcast: { msg: makeState({ key, value: value ?? null, id: peerId }), exclude: peerId } };
  }

  /**
   * Peer's socket closed. Drop it (and the room if now empty), and return a
   * LEAVE broadcast plus `stateClears` — STATE-null messages for every
   * owner-scoped key the peer set (the `hold:` namespace), so a held object
   * can't stay stuck in a departed player's hand. Persistent room state (e.g.
   * the loaded game on `tv`) is deliberately left in place.
   *
   * M1.4 host migration. If the departing peer was the HOST:
   *   • with a known `sid` and peers left behind → the room goes HOSTLESS and
   *     `hostGraceMs` (HOST_RECLAIM_MS) is returned so the adapter can schedule an
   *     expireHostGrace() call. Inside that window the same sid reconnecting gets
   *     the role back (its own reload), and nobody else is promoted — see
   *     HOST_RECLAIM_MS's comment for why an immediate stand-in is harmful.
   *   • with no sid (or once the window expires, via expireHostGrace) → the role
   *     migrates to the LONGEST-PRESENT remaining peer (seniority) and
   *     `hostChange` carries the HOST message for everyone still in the room.
   */
  disconnect(roomId, peerId, { now = Date.now() } = {}) {
    const room = this.rooms.get(roomId);
    if (!room || !room.has(peerId)) return {};
    const wasHost = this.hostOf(roomId) === peerId;
    const sid = room.get(peerId)?.sid ?? null;
    room.delete(peerId);
    let hostChange = null;
    let hostGraceMs = 0;
    if (wasHost) {
      this.roomHosts.delete(roomId);
      if (sid && room.size > 0) {
        this.hostGrace.set(roomId, { sid, at: now });
        hostGraceMs = HOST_RECLAIM_MS;
      } else {
        this.hostGrace.delete(roomId);
        const next = this._senior(roomId);
        if (next) { this.roomHosts.set(roomId, next); hostChange = makeHost({ id: next }); }
      }
    }
    const stateClears = [];
    const state = this.roomState.get(roomId);
    if (state) {
      for (const [key, s] of [...state]) {
        // Auto-clear owner-scoped ephemeral keys on disconnect:
        //   hold:*    — held carts/gamepads (can't stay in a gone player's hand)
        //   gamepad:* — dynamically-spawned gamepads (abandoned pads would pile up)
        if (s.id === peerId && (key.startsWith('hold:') || key.startsWith('gamepad:'))) {
          state.delete(key);
          stateClears.push(makeState({ key, value: null, id: peerId }));
        }
      }
    }
    if (room.size === 0) {
      this.rooms.delete(roomId);
      this.roomState.delete(roomId);
      this.roomHosts.delete(roomId);
      this.hostGrace.delete(roomId);   // nobody left to host for; next in is host
    }
    return { broadcast: { msg: makeLeave({ id: peerId }), exclude: peerId }, stateClears, hostChange, hostGraceMs };
  }

  /**
   * The reclaim window for `roomId` has elapsed: the departed host did not come
   * back, so promote the longest-present remaining peer. Returns { hostChange }
   * with the HOST message to broadcast, or {} when there is nothing to do (the
   * host reclaimed the role, a NEWER grace record replaced this one, or the room
   * is gone). Safe to call late/twice — the adapter just schedules a timer.
   */
  expireHostGrace(roomId, { now = Date.now() } = {}) {
    const grace = this.hostGrace.get(roomId);
    if (!grace) return {};
    // A newer disconnect re-armed the window; its own timer will handle it.
    if (now - grace.at < HOST_RECLAIM_MS) return {};
    this.hostGrace.delete(roomId);
    if (this.hostOf(roomId)) return {};            // already reclaimed/held
    const next = this._senior(roomId);
    if (!next) { this.roomHosts.delete(roomId); return {}; }
    this.roomHosts.set(roomId, next);
    return { hostChange: makeHost({ id: next }) };
  }

  /**
   * Peer sent an INPUT (M1 game sync). Stamp the real sender id and return
   * { direct: { to, msg } } — a DIRECTED relay to the host peer (not a
   * broadcast). Dropped if sender or target isn't in the room. Mirrors signal().
   */
  input(roomId, fromPeerId, msg) {
    const room = this.rooms.get(roomId);
    if (!room || !room.has(fromPeerId) || !room.has(msg.to)) return {};
    return { direct: { to: msg.to, msg: { ...msg, from: fromPeerId } } };
  }

  /**
   * Peer sent a WIRE (M2 transient relay). Stamp the real sender id and return a
   * broadcast to everyone else — exactly like pose(), but for arbitrary per-frame
   * ephemera (live drag, pad button bitmasks). Deliberately NOT persisted: late
   * joiners don't replay it (it would be stale by the next frame). Dropped if the
   * sender isn't in the room.
   */
  wire(roomId, peerId, msg) {
    const room = this.rooms.get(roomId);
    if (!room || !room.has(peerId)) return {};
    return { broadcast: { msg: { ...msg, type: MSG.WIRE, id: peerId }, exclude: peerId } };
  }

  /** Peer ids currently in a room (for the adapter's broadcast loop). */
  peerIds(roomId) {
    const room = this.rooms.get(roomId);
    return room ? [...room.keys()] : [];
  }

  roomCount() { return this.rooms.size; }
  size(roomId) { return this.rooms.get(roomId)?.size ?? 0; }
}
