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

// OWNER-SCOPED STATE namespaces: a key here describes one peer's grip on a
// shared object, so it BELONGS to the peer that wrote it. Two server-side rules
// follow from that, and they are deliberately different (RELAY-6):
//   • disconnect() clears the departed peer's own keys — a held cartridge can't
//     stay stuck in a gone player's hand, and abandoned pads would pile up.
//   • a CLEAR (`value: null`) is accepted only from the key's current owner or
//     from the elected host. Before this, any room member could send
//     `{key:'hold:<cartId>', value:null}` and rip a cartridge out of another
//     player's hand — broadcast to the room as authoritative, and unrecoverable
//     from the victim's side, because a client only writes this key on its own
//     grab/release events and its next write is a release.
// An OVERWRITE stays open to anyone on purpose: shared gamepads are grab-any
// (d8ab0e6), and handing a cartridge from one player to another is exactly a
// `hold:` write by a DIFFERENT peer id. Only the destructive half is gated.
//
// ONE list, so the auto-clear and the ACL cannot drift: "owner-scoped" has to
// mean the same thing to both, or a namespace ends up with an owner on
// disconnect that it doesn't have while its owner is still connected.
// `gun:`/`mouse:`/`power:`/`prop:` are NOT here — they are collaborative room
// state (any peer may re-point a cable or flip a console's power), which is what
// the shipped clients already do.
export function isOwnerScopedKey(key) {
  return typeof key === 'string' && (key.startsWith('hold:') || key.startsWith('gamepad:'));
}

// ---------------------------------------------------------------------------
// Admission limits (CLAUDE_REVIEW §4.4 / CODEX_REVIEW SEC-3)
//
// The room server is deployed PUBLICLY (dionysus.dk) and rooms are joinable by
// name, so `Hub.setState`'s per-room `Map` used to be unbounded memory owned by
// anyone who could open a socket: `validate()` only checks `typeof key ===
// 'string'` and `'value' in msg`, and every accepted key is persisted for the
// life of the room AND replayed to every future joiner.
//
// The numbers below are deliberately far above what the shipped client sends.
// Measured against this tree:
//   • the biggest real STATE value is the host's `shelf:collections` (inlined
//     dropped collections, boxart lists stripped — 12,502 B / 290 nodes with
//     every collection in this tree inlined at once, of which the biggest single
//     one is `public/roms/local/local.collection.json` at 9,603 B on the wire for
//     18 games) and `room` (a serialized room snapshot; the committed room
//     descriptors are 1.0-1.4 kB / 69-93 nodes). 256 KiB is ~21x the largest real
//     one — room for a ~490-game inlined collection at the ~533 B per game this
//     tree's collections actually serialize to.
//   • a live room's key set is `tv`, `room`, `shelf:collections`, `shelf:local`,
//     one `prop:<id>` per room prop, one `hold:`/`gamepad:`/`gun:`/`mouse:` key
//     per held peripheral and one `power:` key per console — order tens, not
//     hundreds, even for a full patchable rack. 512 keys per peer / 4096 per
//     room is >10x that.
// Every one is env-tunable so a deployment can tighten or loosen without a code
// change; a Hub can also be constructed with explicit `limits` (used by
// scripts/test-room-limits.mjs so the test doesn't have to allocate 256 KiB).
//
// ---------------------------------------------------------------------------
// WHY THE PER-AXIS CAPS ABOVE ARE NOT ENOUGH — the aggregate budget
// ---------------------------------------------------------------------------
// Each cap above is individually defensible and they are JOINTLY MEANINGLESS,
// because nothing multiplied them out. MEASURED against the shipped defaults
// before this budget existed (scripts/test-room-limits.mjs section 0, one
// socket, 512 x 250 KiB STATE writes into one room):
//
//     rssBefore 56.9 MiB → rssAfter 212.7 MiB, corrections to client 0,
//     server refusal log lines 0.
//
// Nothing refused anything, because 512 keys x 256 KiB is 128 MiB PER SOCKET and
// every individual write was inside every individual cap. Multiplied out that
// was 256 sockets x 128 MiB ≈ 32 GiB, or per room 4096 keys x 256 KiB = 1 GiB
// x 128 rooms = 128 GiB. So three AGGREGATE budgets are enforced on every
// write, on top of the per-axis caps:
//
//   stateBytesPerPeer  1 MiB   what ONE peer may hold in ONE room
//   stateBytesPerRoom  2 MiB   what a whole room may hold, across all peers
//   stateBytesTotal   64 MiB   what this PROCESS may hold, across all rooms
//
// ---------------------------------------------------------------------------
// WHY A BYTE COUNT IS NOT THE ACCOUNTING UNIT — the structural budget
// ---------------------------------------------------------------------------
// The first version of those three budgets counted `JSON.stringify(value).length`
// and nothing else. It worked (508 of 512 writes refused, RSS flat) and it was
// still ~20x optimistic, because THE DEFENDER PICKED THE UNIT AND THE ATTACKER
// PICKS THE SHAPE. Retained heap is not paid per character, it is paid per
// allocated OBJECT, and JSON's cheapest heap object is three characters wide:
//
//     `[{},{},{},…]`   3 chars per V8 JSObject
//     `[[],[],[],…]`   3 chars per V8 JSArray
//
// MEASURED (scripts/test-room-limits.mjs section 0b, 64 sockets in 64 rooms
// filling the entire 64 MiB byte budget, every per-axis and every aggregate cap
// honoured, ZERO refusals): arrays of empty objects took the server from
// 57.4 MiB to 1515.3 MiB — a 22.78x heap multiplier, ~1.5 GB, where the same
// harness with one plain string blob is 1.24x. So the honest ceiling of a
// byte-only budget was not "336 MiB, fits a 1 GB VPS" but "~1.5 GB, does not".
//
// The fix is to account for what is actually allocated. Two things now bound a
// value's SHAPE, not just its length:
//
//   stateValueNodes  8192   JSON nodes in ONE value — one per container and
//                           one per array element / object property, counted by
//                           measureValue()
//   stateValueDepth    16   nesting levels in ONE value
//
// …and every accepted value is charged against the three aggregate budgets in
// ACCOUNTED BYTES, not raw characters:
//
//   cost = JSON.stringify(value).length + nodes x stateNodeCostBytes   (128)
//
// 128 B/node is measured, not guessed: parsing 1,000,000-node values of each
// shape and reading RSS gives 121 B per empty object, 68 B per empty array,
// 110 B per `"k123":1` property and 15 B per number element.
//
// LIMIT OF THE UNIT — an accounted byte is NOT a hard upper bound on a resident
// byte, and an earlier version of this comment claimed it was. Two known gaps,
// both measured:
//
//   1. UTF-16. `JSON.stringify(value).length` counts code UNITS, but V8 stores
//      any string containing a code point > U+00FF as a TWO-BYTE string. Filling
//      the pool to 63.8 MiB accounted with 256 KiB values retains 64.2 MiB live
//      heap of ASCII (1.01x) but 128.2 MiB of U+4E2D (2.01x) — same code path,
//      one character swapped. Latin-1 (e.g. U+00E9) is NOT the attack; CJK and
//      emoji are. Charging 2 bytes/char would fix it and would also halve every
//      legitimate budget, so the cost is documented rather than paid.
//   2. Inbound parse churn. decode() JSON.parse()s a frame BEFORE setState()
//      can refuse it, so REFUSED values are never accounted yet are briefly
//      resident. 32 sockets sending 900 kB `[{},{},…]` frames (all refused,
//      zero retained) peak the relay at ~354 MiB RSS before settling back to
//      ~58 MiB. Bounded by ROOM_MAX_PAYLOAD x concurrent frames, not by the
//      structural cap.
//
// Worst case, multiplied out (see server/README.md for the same table):
//
//   per peer   1 MiB x 256 sockets (ROOM_MAX_SOCKETS)      = 256 MiB
//   per room   2 MiB x 128 rooms   (ROOM_MAX_ROOMS)        = 256 MiB
//   global                                                 =  64 MiB  ← binds
//
// The global budget is the binding one, so retained STATE can never cost more
// than 64 MiB accounted no matter how the sockets/rooms are arranged.
//
// MEASURED MULTIPLIERS, worst-first, all against the real relay on shipped
// defaults with RSS read externally (never the process's self-report):
//
//     two-byte strings (U+4E2D), whole pool     2.30x   ← worst found
//     one-byte strings (ASCII),  whole pool     2.15x
//     values just under the node cap            1.36-1.47x
//     arrays of empty objects / empty arrays    2.4-2.5x
//     the same attacks with node cost disabled  23-36x  ← what this replaced
//
// Do NOT read 2.30x as proven-final: it is the worst over the shapes ANYONE HAS
// TRIED, which is exactly the caveat the previous version of this comment failed
// to state and was then caught by. Treat it as a floor on the true worst case.
//
// So the ceiling, taking 2.30x on a completely full pool (64 x 2.30 ≈ 147 MiB):
//
//   ~57 MiB baseline + ~147 MiB state + 32 MiB outbound  ≈  236 MiB steady
//   + inbound parse churn of refused frames              ≈  ~354 MiB transient
//
// (outbound is bounded separately in room-server.mjs by
// ROOM_MAX_BUFFERED_TOTAL_BYTES). That still fits a 1 GB VPS, which is the
// operational conclusion that matters — but the number is 236/354, not the
// 183 an earlier version of this comment asserted.
//
// And they stay far above REAL traffic — MEASURED against this tree, not
// estimated (scripts/test-room-limits.mjs section 4c asserts it, from the real
// files). A host holds `tv` (~200 B), `room` (1,318 B / 93 nodes / depth 7 for
// the biggest committed descriptor — the deepest real value there is),
// `shelf:collections` (12,502 B / 290 nodes / depth 6 with EVERY collection in
// this tree inlined at once) and `shelf:local`, plus tens of
// `prop:`/`hold:`/`gamepad:`/`power:` keys at ~120 B and ~19 nodes each. That
// whole set is 34 keys, 19,289 raw characters and 869 nodes = 130,521 B
// ACCOUNTED — 12.4% of the 1 MiB per-peer budget. A 4-player room is that host
// plus three clients holding a handful of `hold:`/`prop:` keys, well under
// 200 kB accounted against 2 MiB; 128 such rooms — every room this server will
// create — is ~16 MiB accounted against the 64 MiB pool.
//
// The structural caps have more room still: the biggest real value in the tree
// is 290 nodes at depth 6 against caps of 8192 and 16, and the largest value
// the 256 KiB byte cap admits at all — a ~490-game inlined collection — is
// ~4,800 nodes, so for collection-shaped data the BYTE cap still binds first
// and the node cap never fires on anything legitimate.
//
// What the node charge DOES cost a legitimate host: that maxed ~490-game
// collection is ~880 kB accounted (256 kB raw + ~4,800 nodes x 128), so ONE
// fits the 1 MiB per-peer budget where the byte-only accounting fitted two.
// Nothing in this tree is within 15x of that.
//
// The per-room budget is also deliberately kept BELOW room-server.mjs's
// ROOM_MAX_BUFFERED_BYTES (4 MiB): a late joiner is sent the room's whole state
// map in one go, so a room that could legally hold more state than a socket may
// buffer would evict its own legitimate late joiners as "slow clients".
const envInt = (name, def) => {
  const v = Number.parseInt(process.env?.[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};
// Same, but 0 is a real setting rather than "unset". Only ROOM_STATE_NODE_COST_BYTES
// needs it: 0 turns the structural charge off, which is exactly the pre-fix
// byte-only accounting and is what scripts/test-room-limits.mjs uses as the
// negative control that proves the charge is what bounds the heap.
const envIntZeroOk = (name, def) => {
  const v = Number.parseInt(process.env?.[name] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
};

export const HUB_LIMITS = Object.freeze({
  /** Max characters in a STATE key. Real keys are `prop:<uuid>`-shaped (~45). */
  stateKeyLen: envInt('ROOM_MAX_STATE_KEY_LEN', 128),
  /** Max JSON characters in one STATE value (see the measurement note above). */
  stateValueBytes: envInt('ROOM_MAX_STATE_VALUE_BYTES', 256 * 1024),
  /** STRUCTURAL: max JSON nodes in one value (one per container / leaf). */
  stateValueNodes: envInt('ROOM_MAX_STATE_VALUE_NODES', 8192),
  /** STRUCTURAL: max nesting levels in one value (real room descriptors: 7). */
  stateValueDepth: envInt('ROOM_MAX_STATE_VALUE_DEPTH', 16),
  /** Accounted bytes charged per JSON node, on top of the serialized length. */
  stateNodeCostBytes: envIntZeroOk('ROOM_STATE_NODE_COST_BYTES', 128),
  /** Max distinct STATE keys one peer may own in one room. */
  stateKeysPerPeer: envInt('ROOM_MAX_STATE_KEYS_PER_PEER', 512),
  /** Max distinct STATE keys in one room, across all peers. */
  stateKeysPerRoom: envInt('ROOM_MAX_STATE_KEYS_PER_ROOM', 4096),
  /** AGGREGATE: max ACCOUNTED bytes one peer may hold in one room. */
  stateBytesPerPeer: envInt('ROOM_MAX_STATE_BYTES_PER_PEER', 1024 * 1024),
  /** AGGREGATE: max ACCOUNTED bytes one room may hold, across all peers. */
  stateBytesPerRoom: envInt('ROOM_MAX_STATE_BYTES_PER_ROOM', 2 * 1024 * 1024),
  /** AGGREGATE: max ACCOUNTED bytes this whole process may hold, all rooms. */
  stateBytesTotal: envInt('ROOM_MAX_STATE_BYTES_TOTAL', 64 * 1024 * 1024),
  /** Max characters kept from a JOIN nick / color (the rest is truncated). */
  nickLen: envInt('ROOM_MAX_NICK_LEN', 64),
  colorLen: envInt('ROOM_MAX_COLOR_LEN', 32),
  // --- EPHEMERAL RELAY CAPS (RELAY-2) --------------------------------------
  // Everything above bounds RETAINED state. WIRE and SIGNAL are relayed and
  // FORGOTTEN, so not one of those budgets applies to them, and until these two
  // existed the only bound on either was `ws`'s own maxPayload
  // (ROOM_MAX_PAYLOAD_BYTES, 1 MiB) — four times the largest STATE value this
  // same server will accept. A 1 MiB WIRE was legal, was fanned out to every
  // other peer in the room (x15 at ROOM_MAX_PEERS) and is the INGRESS half of
  // the outbound-buffer attack RELAY-1 bounds at the other end.
  //
  // POSE needs no knob and got none: pose() rebuilds the message from the
  // format's own fields instead of spreading the sender's, so its body is a
  // fixed ~200 B whatever was attached to it. Same for INPUT in input().
  //
  // An over-cap body is DROPPED and NOT answered with a correction, unlike a
  // refused STATE write: both kinds are fire-and-forget, so there is no
  // authoritative value to re-converge onto — the sender just loses that frame,
  // which for per-frame ephemera the next frame replaces anyway.
  /**
   * Max JSON characters in one relayed WIRE. Real channels are tiny — 'gun' and
   * 'mouse' ~80 B, 'gp' ~60 B, 'drag' one serialized prop (~150-400 B),
   * 'insert' a game descriptor (~200 B) — so 8 KiB is ~20x the largest.
   */
  wireBytes: envInt('ROOM_MAX_WIRE_BYTES', 8 * 1024),
  /**
   * Max JSON characters in one relayed SIGNAL. The biggest real one is a WebRTC
   * offer's SDP (a few kB even with every codec); ICE candidates are ~200 B.
   * Kept an order of magnitude looser than WIRE because an SDP's size is the
   * browser's choice, not ours, and a dropped offer costs a whole call.
   */
  signalBytes: envInt('ROOM_MAX_SIGNAL_BYTES', 64 * 1024),
});

/**
 * Serialized length of a message about to be relayed, or Infinity if it cannot
 * be serialized at all.
 *
 * Measured AFTER the projection each relay path does, so an attacker's junk
 * fields are never stringified — the walk only ever covers the bytes that would
 * really go back out on the wire, and a 1 MiB field attached to a 60 B WIRE
 * costs the relay nothing beyond the JSON.parse it already paid.
 *
 * The try/catch cannot fire for anything that came off the wire (JSON.parse
 * produces neither cycles nor BigInt), but this runs inside the room server's
 * synchronous message handler, where one throw is an uncaught exception in the
 * relay — the same reasoning as versionText() in NetProtocol.js.
 */
function relayBytes(msg) {
  try { return JSON.stringify(msg)?.length ?? 0; }
  catch { return Infinity; }
}

/**
 * Walk a JSON-shaped value and report { nodes, depth, over }.
 *
 * `nodes` counts every JSON VALUE the parsed result retains — each container and
 * each primitive leaf, i.e. one per array element and one per object property.
 * `over` is 'nodes' or 'depth' when the corresponding cap was passed, else null.
 *
 * Object KEYS are deliberately NOT counted separately. A property's own overhead
 * (the key string, the dictionary slot) is paid for twice already: by the key's
 * characters in the byte count, and by the 128 B charged for the property's
 * VALUE node. Measured, that is still an over-estimate — an object of 8,192
 * `"k123":1` properties costs 110 B per property resident against 128 B charged
 * — while counting keys as well would charge structured real traffic (a game
 * descriptor is 4 short properties) roughly twice what it costs.
 *
 * ITERATIVE, and it bails the moment the node cap is provably exceeded. Both
 * matter, because the value is attacker-shaped: recursion here would turn a
 * 100k-deep array into a RangeError inside the relay's message handler, and
 * walking to the end of a 131,072-element array before deciding to refuse it
 * would hand the attacker the CPU cost he was refused the memory for. The
 * pending stack is included in the bail test (`nodes + pending`), so the check
 * fires while expanding a wide container rather than after it.
 *
 * Cycles cannot reach here — setState() JSON.stringify()s the value first and
 * refuses what throws — and with a finite `maxNodes` (setState always passes
 * one) even a cyclic value terminates: `over` trips long before the walk could
 * loop forever.
 */
export function measureValue(value, { maxNodes = Infinity, maxDepth = Infinity } = {}) {
  let nodes = 0;
  let depth = 0;
  const vals = [value];
  const depths = [1];
  while (vals.length) {
    const v = vals.pop();
    const d = depths.pop();
    nodes++;
    if (d > depth) depth = d;
    if (depth > maxDepth) return { nodes, depth, over: 'depth' };
    if (nodes > maxNodes) return { nodes, depth, over: 'nodes' };
    if (v === null || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        vals.push(v[i]); depths.push(d + 1);
        if (nodes + vals.length > maxNodes) return { nodes: nodes + vals.length, depth, over: 'nodes' };
      }
    } else {
      for (const k of Object.keys(v)) {
        vals.push(v[k]); depths.push(d + 1);
        if (nodes + vals.length > maxNodes) return { nodes: nodes + vals.length, depth, over: 'nodes' };
      }
    }
  }
  return { nodes, depth, over: null };
}

export class Hub {
  constructor({ limits = {} } = {}) {
    this.rooms = new Map();      // roomId -> Map(peerId -> { id, nick, color, sid, seq, v })
    this.roomState = new Map();  // roomId -> Map(key -> { value, id, bytes, nodes, cost })  (M0.5)
    this.roomHosts = new Map();  // roomId -> peerId  (M1.4 — the elected host)
    this.hostGrace = new Map();  // roomId -> { sid, at }  (reclaim window, M1.4)
    // Aggregate accounting (see HUB_LIMITS). The unit is ACCOUNTED BYTES —
    // serialized characters PLUS stateNodeCostBytes per JSON node — not raw
    // characters; `cost`, never `bytes`, is what the budgets compare. Maintained
    // INCREMENTALLY by _setEntry/_delEntry so a write is O(1) rather than a scan
    // of a 4096-key room; every mutation of a roomState map must go through
    // those two.
    this.roomCost = new Map();  // roomId -> total accounted bytes held by the room
    this.peerOwn = new Map();   // roomId -> Map(peerId -> { keys, cost })
    this._seq = 0;               // monotonic join counter → seniority ordering
    this.limits = { ...HUB_LIMITS, ...limits };
  }

  _room(roomId) {
    if (!this.rooms.has(roomId)) this.rooms.set(roomId, new Map());
    return this.rooms.get(roomId);
  }

  _state(roomId) {
    if (!this.roomState.has(roomId)) this.roomState.set(roomId, new Map());
    return this.roomState.get(roomId);
  }

  // --- aggregate accounting ------------------------------------------------
  // Kept incremental (not recomputed by scanning) so the caps cost nothing at
  // write time, and funnelled through these three helpers so the totals cannot
  // drift away from roomState — the one failure mode an incremental counter has.

  /** This peer's { keys, cost } tally in this room, created on demand. */
  _own(roomId, peerId) {
    let m = this.peerOwn.get(roomId);
    if (!m) { m = new Map(); this.peerOwn.set(roomId, m); }
    let o = m.get(peerId);
    if (!o) { o = { keys: 0, cost: 0 }; m.set(peerId, o); }
    return o;
  }

  /** A peer's current tally WITHOUT creating one (read path). */
  _ownRO(roomId, peerId) {
    return this.peerOwn.get(roomId)?.get(peerId) || { keys: 0, cost: 0 };
  }

  /** Write `key` = entry, moving the cost/key tallies off any previous owner. */
  _setEntry(roomId, key, entry) {
    const state = this._state(roomId);
    const prev = state.get(key);
    if (prev) {
      const po = this._own(roomId, prev.id);
      po.keys--; po.cost -= prev.cost;
      if (po.keys <= 0 && po.cost <= 0) this.peerOwn.get(roomId)?.delete(prev.id);
    }
    state.set(key, entry);
    const o = this._own(roomId, entry.id);
    o.keys++; o.cost += entry.cost;
    this.roomCost.set(roomId, Math.max(0, (this.roomCost.get(roomId) || 0) - (prev ? prev.cost : 0) + entry.cost));
  }

  /** Clear `key`, releasing its cost back to the peer/room/global budgets. */
  _delEntry(roomId, key) {
    const state = this.roomState.get(roomId);
    const prev = state?.get(key);
    if (!prev) return false;
    state.delete(key);
    const po = this._own(roomId, prev.id);
    po.keys--; po.cost -= prev.cost;
    if (po.keys <= 0 && po.cost <= 0) this.peerOwn.get(roomId)?.delete(prev.id);
    this.roomCost.set(roomId, Math.max(0, (this.roomCost.get(roomId) || 0) - prev.cost));
    return true;
  }

  /** Whole-room teardown: drop the state map AND its accounting together. */
  _dropRoomState(roomId) {
    this.roomState.delete(roomId);
    this.roomCost.delete(roomId);
    this.peerOwn.delete(roomId);
  }

  /** Total ACCOUNTED bytes of STATE this process is holding, across all rooms. */
  totalStateCost() {
    let n = 0;
    for (const b of this.roomCost.values()) n += b;
    return n;
  }

  /** Cost/key usage snapshot for a room (diagnostics + tests). */
  usage(roomId) {
    let rawBytes = 0, nodes = 0;
    for (const s of this.roomState.get(roomId)?.values() || []) { rawBytes += s.bytes; nodes += s.nodes; }
    return {
      roomCost: this.roomCost.get(roomId) || 0,   // accounted bytes (what the budgets use)
      roomBytes: rawBytes,                        // raw serialized characters
      roomNodes: nodes,
      roomKeys: this.roomState.get(roomId)?.size || 0,
      totalCost: this.totalStateCost(),
    };
  }

  /**
   * The authoritative current value of `key`, addressed back to the peer whose
   * write was refused, so its optimistic local copy re-converges instead of
   * silently diverging. Same shape the host-owned-key rejection already used.
   */
  _correction(state, key, peerId) {
    const cur = state.get(key);
    return { to: peerId, msg: makeState({ key, value: cur ? cur.value : null, id: cur ? cur.id : peerId }) };
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
    // `v` is the peer's announced protocol version (COR-9) — unknown until its
    // JOIN arrives, and possibly never (a pre-handshake client).
    room.set(peerId, { id: peerId, nick: 'Player', color: '#88aaff', sid: sid == null ? null : String(sid), seq: ++this._seq, v: null });

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
  identify(roomId, peerId, { nick, color, v } = {}) {
    const room = this.rooms.get(roomId);
    const p = room?.get(peerId);
    if (!p) return {};
    // Truncate rather than reject: an over-long nick is cosmetic abuse, not an
    // attack on the room, and dropping the JOIN would leave the peer nameless
    // for everyone else. NetProtocol.validate() has no length bound of its own.
    if (typeof nick === 'string') p.nick = nick.slice(0, this.limits.nickLen);
    if (typeof color === 'string') p.color = color.slice(0, this.limits.colorLen);
    // COR-9: remember the protocol version this peer announced, and relay THAT
    // one — not the server's own — so the roster JOIN the other peers receive
    // describes the peer it is about. `v: null` (a peer that announced nothing)
    // makes makeJoin omit the field, which is how a legacy peer stays visibly
    // legacy instead of being credited with whatever the relay happens to run.
    // Capped for the same reason nick is: it is attacker-controlled and retained.
    //
    // Coerced rather than type-gated (2026-08-15): NetProtocol.validate() no
    // longer refuses a non-string `v` (a type check there silently dropped the
    // whole JOIN — see the note in its JOIN case), so a peer that announces
    // `v: 1` as a NUMBER now reaches here with a version checkProtocol judged
    // compatible. `typeof v === 'string'` would drop it on the floor and relay
    // that peer to the room as version-less, i.e. mislabel a modern peer as
    // legacy. An incompatible peer never gets this far: room-server.mjs closes
    // it with 4010 before calling identify().
    if (v != null && v !== '') p.v = String(v).slice(0, 16);
    return { broadcast: { msg: makeJoin({ id: peerId, nick: p.nick, color: p.color, v: p.v ?? null }), exclude: peerId } };
  }

  /**
   * Peer sent a POSE. Stamp the server-side id (anti-spoof) and return a
   * broadcast to everyone else in the room.
   *
   * PROJECTED, not spread (RELAY-2). `{ ...poseMsg }` rebroadcast whatever the
   * sender attached: validate() bounds head/left/right to 7-number tuples but
   * says nothing about any OTHER property, so a 900 kB junk field rode a 12 Hz
   * message out to every peer in the room. No consumer ever read it —
   * PresenceState.applyPose takes exactly id/head/left/right — it was pure
   * amplification. Rebuilding the message from the format makes a POSE's size a
   * property of the protocol instead of a choice the sender makes, which is a
   * stronger bound than any byte cap. ADD A FIELD HERE if the POSE format gains
   * one; `t` is carried only when it is a real number, for the same reason.
   */
  pose(roomId, peerId, poseMsg) {
    const room = this.rooms.get(roomId);
    if (!room || !room.has(peerId)) return {};
    const msg = {
      type: MSG.POSE,
      head: poseMsg.head ?? null,
      left: poseMsg.left ?? null,
      right: poseMsg.right ?? null,
      id: peerId,
    };
    if (typeof poseMsg.t === 'number' && Number.isFinite(poseMsg.t)) msg.t = poseMsg.t;
    return { broadcast: { msg, exclude: peerId } };
  }

  /**
   * Peer sent a SIGNAL (M0.4 voice). Stamp the real sender id and return
   * { direct: { to, msg } } — a DIRECTED relay to a single peer (not a
   * broadcast). Dropped if sender or target isn't in the room.
   *
   * Projected to the fields makeSignal defines and capped at `signalBytes`
   * (RELAY-2): `data` is opaque SDP/ICE passed through verbatim, so it is the
   * one relayed field whose size nothing else bounds — it used to inherit the
   * 1 MiB frame limit and nothing tighter. Over-cap is dropped, not corrected;
   * see the HUB_LIMITS note.
   */
  signal(roomId, fromPeerId, msg) {
    const room = this.rooms.get(roomId);
    if (!room || !room.has(fromPeerId) || !room.has(msg.to)) return {};
    const out = { type: MSG.SIGNAL, to: msg.to, kind: msg.kind, data: msg.data, from: fromPeerId };
    if (msg.channel != null) out.channel = String(msg.channel);
    const bytes = relayBytes(out);
    if (bytes > this.limits.signalBytes) return { rejected: 'signal-too-large', bytes };
    return { direct: { to: msg.to, msg: out } };
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
    // --- admission limits (see HUB_LIMITS) --------------------------------
    // An over-long key is dropped outright and NOT echoed back: the correction
    // message would just carry the abusive key straight back onto the wire.
    if (key.length > this.limits.stateKeyLen) return { rejected: 'key-too-long' };
    const state = this._state(roomId);
    // A `null` value CLEARS a key — always allowed (it frees memory, and a peer
    // that is over its key OR byte budget must still be able to release what it
    // holds; a budget you cannot climb back out of is a self-inflicted DoS).
    let bytes = 0, nodes = 0, cost = 0;
    if (value != null) {
      try { bytes = JSON.stringify(value)?.length ?? 0; }
      catch { return { rejected: 'value-unserializable' }; }   // cycles / BigInt
      if (bytes > this.limits.stateValueBytes) {
        return { rejected: 'value-too-large', direct: this._correction(state, key, peerId) };
      }
      // --- STRUCTURAL cap. Byte length is not a proxy for retained heap: an
      // array of empty objects is 3 characters per V8 allocation, so a value
      // inside every byte cap can still buy ~20x the heap a string of the same
      // length does (measured: 22.78x, ~1.5 GB across a full byte budget).
      // Bound the SHAPE too, then charge the nodes into the aggregate budgets
      // below so the process-wide ceiling is a memory number and not a
      // character count.
      const shape = measureValue(value, {
        maxNodes: this.limits.stateValueNodes,
        maxDepth: this.limits.stateValueDepth,
      });
      if (shape.over === 'depth') {
        return { rejected: 'value-too-deep', direct: this._correction(state, key, peerId) };
      }
      if (shape.over === 'nodes') {
        return { rejected: 'value-too-complex', direct: this._correction(state, key, peerId) };
      }
      nodes = shape.nodes;
      cost = bytes + nodes * this.limits.stateNodeCostBytes;
      if (!state.has(key)) {
        // Only a NEW key can grow the room; overwriting an existing one cannot.
        if (state.size >= this.limits.stateKeysPerRoom) {
          return { rejected: 'room-key-limit', direct: this._correction(state, key, peerId) };
        }
        if (this._ownRO(roomId, peerId).keys >= this.limits.stateKeysPerPeer) {
          return { rejected: 'peer-key-limit', direct: this._correction(state, key, peerId) };
        }
      }
      // --- AGGREGATE budgets (the cap the per-axis ones didn't add up to), in
      // ACCOUNTED bytes = serialized characters + stateNodeCostBytes per node.
      // Computed as "what the totals WOULD BE after this write": an overwrite
      // releases the previous value's cost first, so replacing a 200 kB value
      // with a 1 kB one is always allowed even at the ceiling.
      const prev = state.get(key);
      const prevCost = prev ? prev.cost : 0;
      const prevMine = prev && prev.id === peerId ? prev.cost : 0;
      if (this._ownRO(roomId, peerId).cost - prevMine + cost > this.limits.stateBytesPerPeer) {
        return { rejected: 'peer-byte-limit', direct: this._correction(state, key, peerId) };
      }
      if ((this.roomCost.get(roomId) || 0) - prevCost + cost > this.limits.stateBytesPerRoom) {
        return { rejected: 'room-byte-limit', direct: this._correction(state, key, peerId) };
      }
      if (this.totalStateCost() - prevCost + cost > this.limits.stateBytesTotal) {
        return { rejected: 'server-byte-limit', direct: this._correction(state, key, peerId) };
      }
    }
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
    // RELAY-6: an owner-scoped key may only be CLEARED by its current owner or by
    // the elected host. See isOwnerScopedKey for why the overwrite half stays
    // open (a cartridge handoff and a grab-any gamepad are both legitimate writes
    // by a different peer) and why only the destructive half is gated. The
    // refused peer gets the authoritative value back, the same shape every other
    // refusal uses, so a client that thought it had dropped the object
    // re-converges on "someone else is still holding it" instead of diverging.
    if (value == null && isOwnerScopedKey(key)) {
      const prev = state.get(key);
      if (prev && prev.id !== peerId && this.hostOf(roomId) !== peerId) {
        return { rejected: 'not-key-owner', direct: this._correction(state, key, peerId) };
      }
    }
    if (value == null) this._delEntry(roomId, key);
    else this._setEntry(roomId, key, { value, id: peerId, bytes, nodes, cost });
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
        // The namespace list is isOwnerScopedKey's, shared with the RELAY-6 clear
        // ACL: a key the server clears FOR its owner is exactly a key only that
        // owner may clear, and writing the two lists separately is how one gains
        // a namespace the other doesn't have.
        if (s.id === peerId && isOwnerScopedKey(key)) {
          this._delEntry(roomId, key);   // NOT state.delete — keeps the byte tallies honest
          stateClears.push(makeState({ key, value: null, id: peerId }));
        }
      }
    }
    if (room.size === 0) {
      this.rooms.delete(roomId);
      this._dropRoomState(roomId);
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
   * { direct: { to, msg } } — a DIRECTED relay to THE ELECTED HOST (not a
   * broadcast, and not to any member the sender names). Mirrors signal().
   *
   * RELAY-4: the docstring said "directed to the host peer" from the start; the
   * code only checked that `to` was A MEMBER. In a room where a peer had booted
   * a game and then joined as a non-host, any other member could aim an INPUT at
   * it and drive its core — src/desktop/DesktopNet.js routes an INPUT straight to
   * _applyGameInput with no host check of its own, and src/desktop/main.js's
   * handler guards only on `booted`. (The VR client is safe: src/main.js gates on
   * amRoomHost().) It is also what let a non-host peer be given an unbounded
   * stream of distinct `player` values to key a Map on. One line closes all of it
   * at the relay, for clients already in the field that will never be rebuilt.
   *
   * DURING THE HOST-RECLAIM WINDOW hostOf() is null by design (see
   * HOST_RECLAIM_MS) and every INPUT is therefore dropped for up to 15 s. That is
   * the correct reading of that window rather than a side effect of it: nobody is
   * running the room's core, so there is nothing an input could reach — and the
   * peer that is about to be promoted must NOT start receiving inputs before it
   * has the role, which is exactly the transient-stand-in bug the window exists
   * to prevent. Clients keep sending; the buttons they hold are re-asserted by
   * GameInputMgr's next tick once a host exists again.
   *
   * The relayed message is PROJECTED to the fields makeInput defines, for the
   * same reason pose() is: `{ ...msg }` forwarded any junk field the sender
   * attached, at 1 MiB a frame, straight into the host's tab.
   */
  input(roomId, fromPeerId, msg) {
    const room = this.rooms.get(roomId);
    if (!room || !room.has(fromPeerId) || !room.has(msg.to)) return {};
    const host = this.hostOf(roomId);
    if (!host || msg.to !== host) return { rejected: 'input-not-host' };
    const out = {
      type: MSG.INPUT, to: host, player: msg.player, btn: msg.btn, down: !!msg.down, from: fromPeerId,
    };
    if (typeof msg.seq === 'number' && Number.isFinite(msg.seq)) out.seq = msg.seq;
    return { direct: { to: host, msg: out } };
  }

  /**
   * Peer sent a WIRE (M2 transient relay). Stamp the real sender id and return a
   * broadcast to everyone else — exactly like pose(), but for arbitrary per-frame
   * ephemera (live drag, pad button bitmasks). Deliberately NOT persisted: late
   * joiners don't replay it (it would be stale by the next frame). Dropped if the
   * sender isn't in the room.
   *
   * Projected to { ch, data } and capped at `wireBytes` (RELAY-2). This is the
   * kind that most needed it: `data` is passed through verbatim, a WIRE is
   * BROADCAST (so one frame is amplified to every other peer in the room), and
   * the channel runs at frame rate — a 1 MiB WIRE at 120 Hz was the cheapest way
   * to fill the process's whole outbound budget from a single socket.
   */
  wire(roomId, peerId, msg) {
    const room = this.rooms.get(roomId);
    if (!room || !room.has(peerId)) return {};
    const out = { type: MSG.WIRE, ch: msg.ch, data: msg.data ?? null, id: peerId };
    const bytes = relayBytes(out);
    if (bytes > this.limits.wireBytes) return { rejected: 'wire-too-large', bytes };
    return { broadcast: { msg: out, exclude: peerId } };
  }

  /** Peer ids currently in a room (for the adapter's broadcast loop). */
  peerIds(roomId) {
    const room = this.rooms.get(roomId);
    return room ? [...room.keys()] : [];
  }

  /**
   * Drop every trace of a room that has no peers left, plus reclaim windows and
   * state maps whose room is gone. disconnect() already tears an emptied room
   * down, so in normal operation this finds nothing — it exists because a leaked
   * room is unbounded memory that is replayed to the next joiner, and one missed
   * teardown path (an exception between `room.delete()` and the size check, a
   * future code path that creates a room without a socket) would otherwise
   * accumulate silently for the process's whole lifetime. Returns how many rooms
   * and orphan records it removed. Safe to call on a timer.
   */
  sweepEmptyRooms({ now = Date.now() } = {}) {
    let rooms = 0, orphans = 0;
    for (const [roomId, peers] of [...this.rooms]) {
      if (peers.size > 0) continue;
      this.rooms.delete(roomId);
      this._dropRoomState(roomId);
      this.roomHosts.delete(roomId);
      this.hostGrace.delete(roomId);
      rooms++;
    }
    for (const map of [this.roomState, this.roomHosts]) {
      for (const roomId of [...map.keys()]) if (!this.rooms.has(roomId)) { map.delete(roomId); orphans++; }
    }
    // The aggregate cost tallies are not "orphan records" in their own right —
    // they are the accounting FOR roomState, so they follow it silently rather
    // than being counted twice in the swept total. Dropping them matters: a
    // leaked roomCost entry is a permanent tax on the global budget, which
    // would slowly starve every future room of its write budget.
    for (const map of [this.roomCost, this.peerOwn]) {
      for (const roomId of [...map.keys()]) if (!this.roomState.has(roomId)) map.delete(roomId);
    }
    // An elapsed reclaim window for a room nobody ever came back to.
    for (const [roomId, grace] of [...this.hostGrace]) {
      if (!this.rooms.has(roomId) || now - grace.at > HOST_RECLAIM_MS * 4) { this.hostGrace.delete(roomId); orphans++; }
    }
    return { rooms, orphans };
  }

  roomCount() { return this.rooms.size; }
  size(roomId) { return this.rooms.get(roomId)?.size ?? 0; }
}
