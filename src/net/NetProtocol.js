// NetProtocol: the wire format for M0 shared-room presence (see
// docs/MULTIPLAYER.md, "Layer 1 — Presence"). Pure — no THREE, no WebSocket, no
// DOM — so the message shapes, validation, and pose compaction are unit-tested
// in `npm test`. Both the browser client ([[src/net/NetMgr.js]]) and the Node
// room server (server/room-server.mjs) import these so the two ends can never
// drift on the format.
//
// Presence is low-rate and non-deterministic: we sync avatar head+hand poses,
// nicknames/colors, and join/leave — NOT game state. So plain JSON is fine
// (a handful of users at ~12 Hz); we only round coordinates to keep packets
// small. Binary/quantized encoding is a later optimization, not M0.

// Message types. Server→client: HELLO (you connected, here's the roster),
// JOIN/LEAVE (roster deltas), POSE (someone moved). Client→server: JOIN (I'm
// here, my nick/color) and POSE (my transform). The server stamps `id` on
// rebroadcast so a client can't spoof another peer's id.
export const MSG = Object.freeze({
  HELLO: 'hello',
  JOIN: 'join',
  LEAVE: 'leave',
  POSE: 'pose',
  SIGNAL: 'signal', // M0.4 voice: WebRTC offer/answer/ICE, relayed peer→peer
});

// WebRTC signaling kinds carried inside a SIGNAL message.
export const SIGNAL_KINDS = Object.freeze(['offer', 'answer', 'ice']);

// A pose part (head / left hand / right hand) is either null (not tracked —
// e.g. a controller that isn't connected) or [px,py,pz, qx,qy,qz,qw]:
// position in metres (room space) + a unit quaternion.
export const POSE_LEN = 7;

const isFiniteNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** True if a pose part is a valid 7-tuple or null. */
export function isValidPart(part) {
  if (part === null) return true;
  return Array.isArray(part) && part.length === POSE_LEN && part.every(isFiniteNum);
}

/** Round every number in a pose part to `decimals` places (null passes through). */
export function roundPart(part, decimals = 3) {
  if (part === null) return null;
  const f = 10 ** decimals;
  return part.map((n) => Math.round(n * f) / f);
}

/**
 * Build a POSE message body. `head/left/right` are 7-tuples or null. Rounds
 * coordinates to keep the JSON small. `id` is filled by the server on
 * rebroadcast, so the client may omit it.
 */
export function makePose({ head = null, left = null, right = null, t, id, decimals = 3 } = {}) {
  const msg = {
    type: MSG.POSE,
    head: roundPart(head, decimals),
    left: roundPart(left, decimals),
    right: roundPart(right, decimals),
  };
  if (id != null) msg.id = id;
  if (t != null) msg.t = t;
  return msg;
}

/** Build a JOIN message body (a peer announcing itself). */
export function makeJoin({ id, nick, color } = {}) {
  const msg = { type: MSG.JOIN, nick: String(nick ?? 'Player'), color: String(color ?? '#88aaff') };
  if (id != null) msg.id = id;
  return msg;
}

/** Build a HELLO message (server → a freshly-connected client). */
export function makeHello({ selfId, room, peers = [] } = {}) {
  return {
    type: MSG.HELLO,
    selfId: String(selfId),
    room: room == null ? null : String(room),
    peers: peers.map((p) => ({ id: String(p.id), nick: String(p.nick ?? 'Player'), color: String(p.color ?? '#88aaff') })),
  };
}

/** Build a LEAVE message body. */
export function makeLeave({ id } = {}) {
  return { type: MSG.LEAVE, id: String(id) };
}

/**
 * Build a SIGNAL message (M0.4 voice). Carries one WebRTC negotiation step
 * (`offer`/`answer`/`ice`) addressed to a single peer `to`. The server relays it
 * directly to that peer and stamps `from` with the real sender id (so a client
 * can't forge who an offer came from). `data` is the SDP description or ICE
 * candidate, passed through verbatim.
 */
export function makeSignal({ from, to, kind, data } = {}) {
  const msg = { type: MSG.SIGNAL, to: String(to), kind, data };
  if (from != null) msg.from = String(from);
  return msg;
}

/**
 * Validate a decoded message. Returns { ok:true } or { ok:false, error }.
 * Keeps the server/client from acting on malformed packets.
 */
export function validate(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, error: 'not an object' };
  switch (msg.type) {
    case MSG.HELLO:
      if (typeof msg.selfId !== 'string') return { ok: false, error: 'hello.selfId' };
      if (!Array.isArray(msg.peers)) return { ok: false, error: 'hello.peers' };
      return { ok: true };
    case MSG.JOIN:
      if (typeof msg.nick !== 'string') return { ok: false, error: 'join.nick' };
      return { ok: true };
    case MSG.LEAVE:
      if (typeof msg.id !== 'string') return { ok: false, error: 'leave.id' };
      return { ok: true };
    case MSG.POSE:
      if (!isValidPart(msg.head) || !isValidPart(msg.left) || !isValidPart(msg.right)) {
        return { ok: false, error: 'pose part' };
      }
      return { ok: true };
    case MSG.SIGNAL:
      if (typeof msg.to !== 'string') return { ok: false, error: 'signal.to' };
      if (!SIGNAL_KINDS.includes(msg.kind)) return { ok: false, error: 'signal.kind' };
      if (msg.data == null || typeof msg.data !== 'object') return { ok: false, error: 'signal.data' };
      return { ok: true };
    default:
      return { ok: false, error: `unknown type: ${msg && msg.type}` };
  }
}

/** Serialize a message to a string for the socket. */
export function encode(msg) {
  return JSON.stringify(msg);
}

/** Parse a socket string back to a message, or null if it isn't valid JSON/shape. */
export function decode(str) {
  let msg;
  try { msg = JSON.parse(str); } catch { return null; }
  return validate(msg).ok ? msg : null;
}
