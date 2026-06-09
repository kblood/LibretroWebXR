// Hub: the room-server's pure bookkeeping — which peers are in which room, and
// what to broadcast on connect / identify / pose / disconnect. No `ws`, no
// sockets, so `npm test` (scripts/test-net.mjs) covers the relay logic; the thin
// adapter (server/room-server.mjs) maps peerId↔socket and does the actual sends.
//
// Imports the SAME [[src/net/NetProtocol.js]] builders the browser client uses,
// so the two ends can't drift. The server is authoritative over peer `id`: it
// stamps the connection's id onto every rebroadcast, so a client can't forge a
// pose/join as someone else.

import { makeHello, makeJoin, makeLeave, MSG } from '../src/net/NetProtocol.js';

export class Hub {
  constructor() {
    this.rooms = new Map(); // roomId -> Map(peerId -> { id, nick, color })
  }

  _room(roomId) {
    if (!this.rooms.has(roomId)) this.rooms.set(roomId, new Map());
    return this.rooms.get(roomId);
  }

  /**
   * A socket joined `roomId` as `peerId`. Returns { hello } to send back to it
   * (the roster of everyone already present). Identity (nick/color) arrives
   * later via a JOIN message → identify().
   */
  connect(roomId, peerId) {
    const room = this._room(roomId);
    const others = [...room.values()].map((p) => ({ id: p.id, nick: p.nick, color: p.color }));
    room.set(peerId, { id: peerId, nick: 'Player', color: '#88aaff' });
    return { hello: makeHello({ selfId: peerId, room: roomId, peers: others }) };
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

  /** Peer's socket closed. Drop it (and the room if now empty) and LEAVE-broadcast. */
  disconnect(roomId, peerId) {
    const room = this.rooms.get(roomId);
    if (!room || !room.has(peerId)) return {};
    room.delete(peerId);
    if (room.size === 0) this.rooms.delete(roomId);
    return { broadcast: { msg: makeLeave({ id: peerId }), exclude: peerId } };
  }

  /** Peer ids currently in a room (for the adapter's broadcast loop). */
  peerIds(roomId) {
    const room = this.rooms.get(roomId);
    return room ? [...room.keys()] : [];
  }

  roomCount() { return this.rooms.size; }
  size(roomId) { return this.rooms.get(roomId)?.size ?? 0; }
}
