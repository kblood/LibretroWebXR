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
  STATE: 'state',   // M0.5 room-object sync: a shared key→value (e.g. the loaded game)
  INPUT: 'input',   // M1 game sync: a remote player's RetroPad button, directed to the host
  WIRE:  'wire',    // M2 transient relay: per-frame ephemera (live drag, pad buttons) — NOT persisted
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
export function makeSignal({ from, to, kind, data, channel } = {}) {
  const msg = { type: MSG.SIGNAL, to: String(to), kind, data };
  // M1.2: an optional channel multiplexes independent peer connections over the
  // one SIGNAL relay. Absent === 'voice' (the M0.4 mesh, untouched); 'video' is
  // the M1.2 host→client game-stream connection. The Hub relays it opaquely, so
  // NetMgr can route an incoming SIGNAL to the right manager by this tag.
  if (channel != null) msg.channel = String(channel);
  if (from != null) msg.from = String(from);
  return msg;
}

/**
 * Build a STATE message (M0.5 room-object sync). Sets a shared room key to a
 * value everyone in the room sees — e.g. `key:'tv'` → the loaded game descriptor,
 * or `key:'hold:<cartId>'` → who is holding a cartridge. `value:null` clears the
 * key. The server persists the latest value per room (last-writer-wins) and
 * replays it to late joiners, then stamps `id` (the setter) on rebroadcast.
 */
export function makeState({ key, value = null, id } = {}) {
  const msg = { type: MSG.STATE, key: String(key), value: value ?? null };
  if (id != null) msg.id = String(id);
  return msg;
}

/**
 * Build an INPUT message (M1 host-authoritative game sync). Carries one logical
 * RetroPad button transition for `player` (a console port slot, 1-based) as
 * pressed/released, addressed to the host peer `to`. The server relays it
 * directly to that peer (like SIGNAL) and stamps `from` with the real sender id,
 * so the host can trust who an input came from. The host resolves `btn` to that
 * player's key codes and feeds its core — non-deterministic-core friendly.
 */
export function makeInput({ to, player, btn, down = false, seq, from } = {}) {
  const msg = { type: MSG.INPUT, to: String(to), player: Number(player), btn: String(btn), down: !!down };
  if (seq != null) msg.seq = Number(seq);
  if (from != null) msg.from = String(from);
  return msg;
}

/**
 * Build a WIRE message (M2 transient relay). Carries per-frame ephemeral data on
 * a named channel `ch` (e.g. 'gp' for a held pad's pressed-button bitmask, 'drag'
 * for a live prop transform). Unlike STATE, the server does NOT persist it — it
 * relays-but-forgets, so high-rate updates never pile up for late joiners. The
 * server stamps `id` (the sender) on rebroadcast. `data` is passed through
 * verbatim (any JSON value).
 */
export function makeWire({ ch, data = null, id } = {}) {
  const msg = { type: MSG.WIRE, ch: String(ch), data: data ?? null };
  if (id != null) msg.id = String(id);
  return msg;
}

/**
 * M1.1 host-routing decision (pure): who, if anyone, a peer should forward its
 * captured game input to. The host is the owner of the shared `tv` state. Returns
 * the host id to send to, or null when there is no host yet, or when THIS peer is
 * the host (it drives its own core locally — no self-send). Kept here, pure, so
 * the client/host split is unit-tested rather than buried in main.js wiring.
 */
export function hostInputTarget({ hostId, selfId } = {}) {
  if (!hostId) return null;
  if (selfId != null && String(hostId) === String(selfId)) return null;
  return String(hostId);
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
      if (msg.channel != null && msg.channel !== 'voice' && msg.channel !== 'video') return { ok: false, error: 'signal.channel' };
      return { ok: true };
    case MSG.STATE:
      if (typeof msg.key !== 'string' || msg.key === '') return { ok: false, error: 'state.key' };
      if (!('value' in msg)) return { ok: false, error: 'state.value' };
      return { ok: true };
    case MSG.INPUT:
      if (typeof msg.to !== 'string') return { ok: false, error: 'input.to' };
      if (typeof msg.player !== 'number' || !Number.isFinite(msg.player)) return { ok: false, error: 'input.player' };
      if (typeof msg.btn !== 'string' || msg.btn === '') return { ok: false, error: 'input.btn' };
      if (typeof msg.down !== 'boolean') return { ok: false, error: 'input.down' };
      return { ok: true };
    case MSG.WIRE:
      if (typeof msg.ch !== 'string' || msg.ch === '') return { ok: false, error: 'wire.ch' };
      if (!('data' in msg)) return { ok: false, error: 'wire.data' };
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

/**
 * Build an RTCConfiguration `iceServers` list (M0 hardening — TURN). Always
 * includes a STUN server (covers same-LAN / most NATs); appends a TURN relay
 * only when a `turn` URL is supplied (needed for symmetric NAT, where STUN
 * alone fails). Pure so it's unit-tested; the WebRTC managers (VoiceMgr/
 * VideoMgr) take the result as their `iceServers`. Returns the STUN-only list
 * when no TURN is configured — identical to the managers' built-in default.
 */
export function buildIceServers({
  stun = 'stun:stun.l.google.com:19302',
  turn = null,
  turnUsername = null,
  turnCredential = null,
} = {}) {
  const servers = stun ? [{ urls: stun }] : [];
  if (turn) {
    const entry = { urls: turn };
    if (turnUsername != null) entry.username = String(turnUsername);
    if (turnCredential != null) entry.credential = String(turnCredential);
    servers.push(entry);
  }
  return servers;
}
