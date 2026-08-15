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
  HOST:  'host',    // M1.4 host election: server→clients, "peer <id> is now the room host"
});

// ---------------------------------------------------------------------------
// Protocol version + compatibility (CODEX_REVIEW COR-9)
// ---------------------------------------------------------------------------
//
// The static app and the room server are deployed by SEPARATE commands
// (`npm run deploy` publishes dist/; `npm run deploy-room` ships server/* plus
// THIS file). A version-skewed client/server pair is therefore the NORMAL state
// during a rollout, not an edge case — and on 2026-08-03 the live relay was
// running a Hub from two months earlier for five days without anyone noticing.
//
// Skew has always shown up as SILENTLY DROPPED messages: decode() rejects what
// it doesn't understand and both ends just stop hearing each other. That is
// exactly how the missing 'bye' SIGNAL kind hid for months (see SIGNAL_KINDS
// below). So both ends now STATE their version — the client on JOIN, the server
// in HELLO — and an incompatible pair fails loudly with a close code instead of
// quietly half-working.
//
// Format is `MAJOR.MINOR`, and the compatibility rule is: **same MAJOR = compatible.**
//   • MINOR goes up for a purely ADDITIVE change: a new MSG type, a new optional
//     field, a new SIGNAL kind. An older peer ignores what it doesn't know, so
//     the pair still works (degraded, not broken) — this is the common case and
//     it must NOT disconnect anyone.
//   • MAJOR goes up only when an existing message's MEANING or required shape
//     changes, i.e. when the old peer would misinterpret rather than ignore.
//
// One exported constant, imported by both ends (server/Hub.js and
// server/room-server.mjs import this same file), so the two can never drift.
export const PROTOCOL_VERSION = '1.0';

// Application close code (4000-4999 is the reserved private range; 4008 = rate
// limit and 4009 = backpressure are already taken by server/room-server.mjs).
// PERMANENT: retrying a 4010 with the same build can only ever produce another
// 4010, so the client's reconnect backoff must stop rather than loop forever.
export const PROTOCOL_CLOSE_CODE = 4010;

// Close codes a client must NEVER retry. Kept as a list because "which closes
// are permanent" is a protocol fact both NetMgr and DesktopNet need the same
// answer to — they each own a duplicate connection lifecycle (CODEX ARC-2), and
// a rule written twice is a rule that drifts.
const PERMANENT_CLOSE_CODES = Object.freeze([PROTOCOL_CLOSE_CODE]);

/** True if a WebSocket close code means "do not reconnect, the pair is broken". */
export function isPermanentClose(code) {
  return PERMANENT_CLOSE_CODES.includes(Number(code));
}

/** Parse `MAJOR.MINOR` (a bare `MAJOR` is accepted as `MAJOR.0`), else null. */
export function parseProtocolVersion(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,4})(?:\.(\d{1,6}))?$/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0) };
}

/**
 * Render an announced `v` — WHATEVER shape it arrived in — as text, without ever
 * throwing (2026-08-15). `v` comes off the wire as arbitrary JSON: a number, an
 * object, an array. checkProtocol is now the ONLY gate on it (validate() no
 * longer refuses a non-string — see the note there), and it is called from the
 * room server's synchronous `ws.on('message')` handler, where a throw is an
 * uncaught exception that takes the relay down.
 *
 * THE CATCH IS A LIVE PATH — DO NOT REMOVE IT. `String()` DOES throw on values
 * JSON.parse produces: `Array.prototype.toString` recurses, so a deeply nested
 * array raises RangeError ("Maximum call stack size exceeded"). And such a value
 * is cheap to send: `"[".repeat(20000) + "]".repeat(20000)` is a ~40 KB frame,
 * far under the relay's ROOM_MAX_PAYLOAD_BYTES (1 MiB, room-server.mjs), it
 * passes validate() (which deliberately does not type-gate `v` — see the JOIN
 * case there), and it lands here. Without this catch one 40 KB JOIN crashes the
 * room server. Asserted end-to-end in scripts/test-net.mjs — search for
 * "deeply nested array"; remove the try/catch and those assertions go red.
 */
function versionText(v) {
  try { return String(v); } catch { return '(unreadable)'; }
}

/**
 * Decide whether a peer announcing protocol `theirs` may talk to an end running
 * `ours`. Pure, and used by BOTH ends (the server on JOIN, the client on HELLO),
 * so a mismatch is judged by one rule rather than two.
 *
 * Returns { verdict, major, reason }:
 *   'ok'           — same MAJOR. Minor differences are additive; carry on.
 *   'legacy'       — NO version announced at all. ACCEPTED, not refused: an app
 *                    built before this handshake existed is still deployed on
 *                    dionysus.dk, and shipping a server that bricks it would
 *                    turn a routine relay update into an outage. Caller logs it
 *                    once and continues.
 *   'incompatible' — different MAJOR, or an unparseable version.
 *
 * ANY TYPE is judged here, not just a string (2026-08-15). A peer whose `v` is a
 * number, an object or an array is an incompatible peer — but it must be told so
 * with a close code, which only happens if the message carrying it reaches this
 * function. Refusing it earlier (validate() used to) turned exactly the message
 * the handshake exists to make loud back into a silently dropped frame.
 *
 * `reason` is written to fit a WebSocket close reason (which is capped at 123
 * BYTES — exceeding it throws inside the send path), so the peer's version is
 * truncated before it is echoed back: `v` is attacker-controlled and an
 * unbounded one would turn a close into a RangeError in the message handler.
 */
export function checkProtocol(theirs, ours = PROTOCOL_VERSION) {
  const mine = parseProtocolVersion(ours);
  // Only `null`/`undefined`/`''` mean "announced nothing". Anything else was an
  // ATTEMPT to state a version, so a junk value is a refusal, not a free pass.
  if (theirs == null || theirs === '') {
    return { verdict: 'legacy', major: null, reason: `no protocol version (this end speaks ${mine.major}.x)` };
  }
  const text = versionText(theirs);
  const got = parseProtocolVersion(text);
  const shown = text.slice(0, 16);
  if (!got) {
    return { verdict: 'incompatible', major: null, reason: `unparseable protocol "${shown}" (this end speaks ${mine.major}.x)` };
  }
  if (got.major !== mine.major) {
    return { verdict: 'incompatible', major: got.major, reason: `protocol ${shown} incompatible (this end speaks ${mine.major}.x)` };
  }
  return { verdict: 'ok', major: got.major, reason: '' };
}

/**
 * The CLIENT half of the handshake, as one shared decision (COR-9 / CODEX ARC-2,
 * 2026-08-15).
 *
 * [[src/net/NetMgr.js]] (VR) and [[src/desktop/DesktopNet.js]] (flat screen) own
 * two separate copies of the connection lifecycle, and each used to map
 * checkProtocol's verdict onto "continue / warn once / go fatal with code 4010"
 * in its own hand-written `_checkServerProtocol`. That mapping is a protocol
 * fact, not a per-class detail: written twice it drifts, which is the ARC-2
 * finding this whole file's shared-rules note is about. Both now call THIS and
 * only supply the side effects (logging, closing their own socket).
 *
 * Returns:
 *   { action:'accept',        serverVersion, code:null, reason:'' }
 *   { action:'accept-legacy', serverVersion:null, code:null, reason }  ← warn once, carry on
 *   { action:'refuse',        serverVersion, code:PROTOCOL_CLOSE_CODE, reason }
 *
 * `serverVersion` is the version to record for diagnostics: the announced value
 * as TEXT (so a server that sent `v: 2` is reported as "2", not as an object
 * that prints as [object Object] in a log), or null when it announced nothing.
 */
export function judgeServerVersion(v, ours = PROTOCOL_VERSION) {
  const compat = checkProtocol(v, ours);
  if (compat.verdict === 'legacy') {
    return { action: 'accept-legacy', serverVersion: null, code: null, reason: compat.reason };
  }
  const serverVersion = versionText(v).slice(0, 16);
  if (compat.verdict === 'ok') return { action: 'accept', serverVersion, code: null, reason: '' };
  return { action: 'refuse', serverVersion, code: PROTOCOL_CLOSE_CODE, reason: compat.reason };
}

// WebRTC signaling kinds carried inside a SIGNAL message.
//
// 'bye' (M1.2 video teardown) is NOT a negotiation step: it's the host telling a
// client "I have stopped broadcasting — drop this connection now" so the client
// reverts its TV immediately instead of waiting ~30 s for ICE consent to expire.
// It was missing from this list until 2026-08-14, which made every bye fail
// validate() at BOTH ends (the client's own encode/decode and the server's
// decode() in room-server.mjs) — so VideoMgr.stopBroadcast() emitted a message
// that never crossed the wire and VideoMgr's bye handler was dead code.
export const SIGNAL_KINDS = Object.freeze(['offer', 'answer', 'ice', 'bye']);

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

/**
 * Build a JOIN message body (a peer announcing itself).
 *
 * `v` is the sender's PROTOCOL_VERSION and is stamped BY DEFAULT — a client that
 * has to remember to announce its version is a client that will forget to, which
 * is the whole failure mode COR-9 is about. Pass `v: null` to omit it: the server
 * does exactly that when it RELAYS a roster JOIN for a peer that announced no
 * version, so a legacy peer is never mislabelled with the server's own version.
 */
export function makeJoin({ id, nick, color, v = PROTOCOL_VERSION } = {}) {
  const msg = { type: MSG.JOIN, nick: String(nick ?? 'Player'), color: String(color ?? '#88aaff') };
  if (id != null) msg.id = id;
  if (v != null) msg.v = String(v);
  return msg;
}

/**
 * Build a HELLO message (server → a freshly-connected client). `host` is the
 * room's current authoritative host (M1.4) — the peer that has been in the room
 * longest — so a joiner knows immediately whether IT is the host (first in) or
 * must behave as a display-only client. Never null in practice (the server
 * elects the connecting peer when the room was empty).
 *
 * `v` is the SERVER's PROTOCOL_VERSION (COR-9). It is the other half of the
 * handshake: the client announces itself on JOIN, but a NEW client talking to an
 * OLD server would otherwise have nothing to inspect — the old server simply
 * ignores the JOIN's `v` and the skew stays invisible until messages start
 * vanishing. With it in HELLO, the client can detect and report the mismatch
 * itself. Its ABSENCE means a server older than this handshake (accepted).
 */
export function makeHello({ selfId, room, peers = [], host = null, v = PROTOCOL_VERSION } = {}) {
  return {
    type: MSG.HELLO,
    selfId: String(selfId),
    room: room == null ? null : String(room),
    host: host == null ? null : String(host),
    v: v == null ? null : String(v),
    peers: peers.map((p) => ({ id: String(p.id), nick: String(p.nick ?? 'Player'), color: String(p.color ?? '#88aaff') })),
  };
}

/**
 * Build a HOST message (M1.4 host election, server → every client in the room).
 * Announces the room's authoritative host. The server is the sole author: it
 * elects the longest-present peer and only re-elects when the current host
 * disconnects (or reclaims its slot after a reload — see server/Hub.js), so the
 * role is STABLE and never changes as a side effect of an in-room action like
 * inserting a cartridge.
 */
export function makeHost({ id } = {}) {
  return { type: MSG.HOST, id: id == null ? null : String(id) };
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
 * captured game input to. `hostId` is the room's server-elected host (M1.4 —
 * NOT, as it was until 2026-08-03, "whoever last wrote the `tv` state"). Returns
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
      // `v` (COR-9) is DELIBERATELY UNVALIDATED — not "optional", *unchecked*,
      // including its type. See the JOIN case below for the whole reason; it
      // applies identically to HELLO, where the victim is the client.
      return { ok: true };
    case MSG.JOIN:
      if (typeof msg.nick !== 'string') return { ok: false, error: 'join.nick' };
      // `v` (COR-9) is DELIBERATELY UNVALIDATED. Between 2026-08-14 and
      // 2026-08-15 this line read `if (msg.v != null && typeof msg.v !== 'string')
      // return {ok:false,...}`, and a type check here is worse than no check:
      //   • decode() turns a failed validate() into `null`, and every consumer
      //     (room-server.mjs's message handler, NetMgr's and DesktopNet's) does
      //     `if (!msg) return`. So a JOIN carrying `v: 2` was DROPPED BEFORE
      //     checkProtocol ever saw it — the peer got no 4010, no close and no
      //     roster entry, and just sat connected and invisible. On HELLO the
      //     client got no selfId, no roster, no fatal and no reconnect.
      //   • That silent drop is the EXACT failure mode COR-9 exists to remove,
      //     reintroduced by the field added to remove it.
      // The version field must never be able to make a message unreadable. Its
      // acceptability is checkProtocol()'s job — it judges any type — and its
      // verdict is a diagnosable close, which is the point.
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
      // 'bye' belongs to the M1.2 host→client VIDEO connection only. Keeping it
      // off the voice channel is deliberate: [[src/net/VoiceMgr.js]] handleSignal
      // has no bye branch, and its fallthrough would _ensurePeer() a connection
      // for any peer that sent one. Widening SIGNAL_KINDS must not widen what the
      // voice mesh can be made to do. (If voice ever needs a teardown message,
      // add the branch there first, then relax this check.)
      if (msg.kind === 'bye' && msg.channel !== 'video') return { ok: false, error: 'signal.bye.channel' };
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
    case MSG.HOST:
      if (typeof msg.id !== 'string' || msg.id === '') return { ok: false, error: 'host.id' };
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
