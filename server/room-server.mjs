// room-server: the M0 presence relay. A thin `ws` adapter over the pure
// [[server/Hub.js]] — it owns the peerId↔socket map and the actual sends; all
// roster/broadcast decisions live in Hub (and are unit-tested). Each WebSocket
// connection joins the room named by the `?room=` query param (default
// "lobby"), is assigned a server-side id, and gets the current roster (HELLO);
// thereafter JOIN (identity) and POSE messages are relayed to the rest of the
// room.
//
// This is NOT a static asset — it's a long-running Node process. Deploy it
// separately and reverse-proxy a path (e.g. /ws/) to it from Apache so the
// browser can reach wss://<host>/ws/ on the same origin (COOP/COEP friendly).
// See server/README.md.
//
//   PORT=8787 node server/room-server.mjs      (or: cd server && npm start)
//
// Also mounts the HTTP log server (server/log-server.mjs) on LOG_PORT (default
// 8788) so Quest sessions can POST /log and a developer can GET /logs. See
// deploy/log-proxy.conf for the Apache reverse-proxy snippet.

import { WebSocketServer } from 'ws';
// Log server: in-process HTTP companion for remote log ingestion + viewing.
// Import first so it starts listening before any WebSocket connections arrive.
// The handle is bound (not a bare side-effect import) because the graceful
// shutdown at the bottom of this file has to close it too — it is an HTTP
// listener in THIS process, so leaving it open would hold the unit alive past a
// SIGTERM and hand systemd a timeout kill instead of a clean stop.
import { logServer } from './log-server.mjs';
import { randomUUID } from 'node:crypto';
import { Hub, HUB_LIMITS } from './Hub.js';
import { decode, encode, MSG, PROTOCOL_VERSION, PROTOCOL_CLOSE_CODE, checkProtocol } from '../src/net/NetProtocol.js';

// ---------------------------------------------------------------------------
// Crash containment (CLAUDE_REVIEW §4.2 / P0-3).
//
// `import './log-server.mjs'` above puts the HTTP log server in THIS process, so
// an unhandled throw in a log handler kills netplay for everyone in every room
// until someone restarts the systemd unit — that exact one-request kill switch
// was reproduced live. Until the two are separate processes, a top-level handler
// is the containment: log it loudly and KEEP SERVING. A relay that has leaked one
// broken request is still infinitely more useful than a dead one.
//
// Registered before the server is constructed so a throw during startup is
// caught too. `wss.on('error')` below deliberately still exits on EADDRINUSE:
// "keep serving" must not mean "sit there having never bound the port".
process.on('uncaughtException', (err, origin) => {
  console.error(`[room-server] UNCAUGHT (${origin}) — staying up:`, err?.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[room-server] UNHANDLED REJECTION — staying up:', reason?.stack || reason);
});

const PORT = parseInt(process.env.PORT || '8787', 10);
// Bind address. UNSET (the default) keeps `ws`'s own behaviour — every
// interface, IPv4 *and* IPv6 — which LAN dev needs, because a Quest connects
// straight to the dev box. Defaulting to a literal '0.0.0.0' instead would have
// been a silent regression: it drops the IPv6 listener that a bare `port` gives
// you.
//
// The DEPLOYED unit sets ROOM_HOST=127.0.0.1 (RELAY-5). Apache proxies /ws/ from
// loopback (deploy/libretrowebxr-room.conf), so binding every interface there
// ALSO published :8787 to the internet unproxied — reachable without TLS
// termination and without anything the vhost enforces. Same binary, different
// ROOM_HOST.
const HOST = (process.env.ROOM_HOST || '').trim();

// --- Admission control (CLAUDE_REVIEW §4.4, CODEX_REVIEW SEC-3) -------------
//
// This process is PUBLIC (dionysus.dk proxies /ws/ to it and real headsets
// connect over the internet), so the caps below — not the bind address — are the
// defence: on the deployed box the relay is behind Apache, but in LAN dev it is
// open on every interface by design. Every one is env-tunable and defaults comfortably
// above what a real 4-player room with voice/video signalling and room-object
// sync actually sends. Measured against this tree:
//
//   • frame size — the largest real frame is a STATE carrying the host's `room`
//     snapshot or an inlined `shelf:collections` (committed room descriptors are
//     1.2-1.6 kB; the largest collection JSON in the tree is 10,842 B). 1 MiB is
//     ~100x that and 100x SMALLER than `ws`'s 100 MB default.
//   • message rate — per peer: POSE at 12 Hz (NetMgr `sendHz`), 'drag' WIRE
//     capped at 20 Hz, 'gp'/'kbd'/'insert' WIRE on-change only, and 'gun'/'mouse'
//     WIRE at frame rate (72-120 Hz on a Quest) — worst case one peer aiming a
//     gun AND moving a mouse while dragging a prop ≈ 120+120+20+12 ≈ 275 msg/s.
//     600/s sustained with a 1200 burst is >2x that peak.
//   • peers — the shipped multiplayer is 4-player (NES Four Score is the widest
//     input path); 16 leaves room for spectators and a rack demo.
//
// RETAINED memory (the room's STATE map, which is what an attacker actually wants
// to grow) is bounded separately and in AGGREGATE by server/Hub.js's
// stateBytesPerPeer/PerRoom/Total, in ACCOUNTED bytes (serialized characters plus
// a per-JSON-node charge) and with a structural cap on each value's node count
// and depth — read that comment before touching any number here, because the two
// sets multiply together. The per-axis caps on their own were measured allowing
// 512 x 250 KiB into one room (RSS 56.9 → 212.7 MiB, zero refusals), and the
// byte-only version of the aggregate budgets was measured allowing an array of
// empty objects to take the same server to 1515.3 MiB while refusing nothing.
// scripts/test-room-limits.mjs sections 0 and 0b are those two measurements,
// kept as regression tests.
const envInt = (name, def) => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};
/** Same, but 0 is accepted as a real value rather than read as "unset". */
const envIntZeroOk = (name, def) => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : def;
};
const MAX_PAYLOAD_BYTES  = envInt('ROOM_MAX_PAYLOAD_BYTES', 1024 * 1024);
const MAX_PEERS_PER_ROOM = envInt('ROOM_MAX_PEERS', 16);
const MAX_SOCKETS        = envInt('ROOM_MAX_SOCKETS', 256);
const MAX_ROOMS          = envInt('ROOM_MAX_ROOMS', 128);
// --- Per-remote-address admission (RELAY-3) --------------------------------
//
// MAX_SOCKETS and MAX_ROOMS are GLOBAL, so before these one client could hold
// all 256 sockets (every later headset is then turned away) or claim all 128 room
// names, and nothing bounded the RATE of upgrades at all — the per-socket token
// bucket is created fresh in the connection handler, so an attacker that
// connects, is served and disconnects had no sustained limit whatsoever.
//
// Churn is the expensive half, not occupancy: every join replays the room's
// whole STATE map (Hub.connect builds one message per key, room-server encodes
// and sends each), so against a room near its 4096-key / 2 MiB budget ONE TCP
// handshake buys ~2 MiB of serialization on a single-threaded relay. A few
// hundred joins a second stalls every other room in the process.
//
// The defaults are DERIVED, not guessed. The first pass guessed 8 concurrent
// ("well above a real household") and it was below this app's own normal case:
// MAX_PEERS_PER_ROOM is 16 and the app actively invites a room that size behind
// one NAT — a household of headsets, a LAN party, a rack demo driven from
// several tabs on one desktop — so the 9th of them was refused by a cap meant
// for an attacker. The concurrency cap therefore starts AT MAX_PEERS_PER_ROOM:
// it can never bite before the per-room cap does. That is still a real bound —
// one address holds 16 of the 256 global sockets, not all of them, which is the
// hazard this cap exists for.
//
const MAX_SOCKETS_PER_IP  = envInt('ROOM_MAX_SOCKETS_PER_IP', MAX_PEERS_PER_ROOM);
// The ADMISSION-CHURN budget: how many upgrades from one address may actually be
// ADMITTED per window. Charged on admission ONLY — see overChurnBudget() for why
// that changed, and why charging refused attempts to it was the mechanism of a
// household-wide lockout rather than a defence.
//
// Derived from the worst LEGITIMATE churn one address can produce: every device
// on it sitting in the client's reconnect backoff after a relay restart. That is
// NOT "MAX_SOCKETS_PER_IP x 7.5/minute", which is what the x8 default was
// justified with. The backoff chain is 500/1000/2000/4000/8000 ms, so a device
// that keeps failing spends 7.5 s on its first four attempts and 8 s on each one
// after — ~10.5 upgrades in the first minute, not 7.5. At MAX_SOCKETS_PER_IP = 16
// that is ~168/minute and the old default of 128 was BELOW it: the shipped budget
// refused the exact case its own comment claimed to cover "comfortably", which is
// I3 (a full room behind one NAT, everyone reconnecting after a Wi-Fi blip)
// failing by arithmetic. x16 = 256 puts that household at ~66% of the budget,
// which is the headroom that sentence always meant, and is still a tiny fraction
// of what a flooding client offers on one core.
const MAX_UPGRADES_PER_IP = envInt('ROOM_MAX_UPGRADES_PER_IP', MAX_SOCKETS_PER_IP * 16);
// The SOFT-REFUSAL budget: how many refusals per window this address is worth
// answering the EXPENSIVE way (accept the upgrade, close 1013 + reason — see
// refuseSoftly). Past it, a refusal that address was getting anyway is delivered
// as a bare HTTP 429 with no WebSocket object at all.
//
// This is the knob that makes a soft refusal safe to offer at all. A soft refusal
// is a full handshake and a real entry in wss.clients for ROOM_REFUSAL_GRACE_MS,
// so answering EVERY refusal that way made refusing STRICTLY MORE EXPENSIVE THAN
// ACCEPTING: one address at ~256 upgrades/second could hold hundreds of refused
// sockets resident. Nor is the traffic hypothetical — the clients already
// deployed to headsets reset their reconnect backoff on 'open', and a soft
// refusal is precisely what MAKES 'open' fire, so a refused deployed client knocks
// at 2 Hz for the life of its page and nothing client-side will ever stop it.
// That client cannot be updated, so the bound has to live on this side (I6).
//
// It can NEVER turn an admission into a refusal — it only decides how a refusal
// that was already happening is delivered. That separation is the whole design;
// see the addrState comment below and verifyClient.
//
// x4 of the concurrency cap = 64/minute at the defaults: a whole household of 16
// can be turned away four times a minute and still be told why, while a flood
// gets at most ~1 expensive answer per second and an HTTP error for the rest.
const MAX_SOFT_REFUSALS_PER_IP = envInt('ROOM_MAX_SOFT_REFUSALS_PER_IP', MAX_SOCKETS_PER_IP * 4);
const UPGRADE_WINDOW_MS   = envInt('ROOM_UPGRADE_WINDOW_MS', 60000);
// Whose address to bill. OFF by default: with nothing stripping a
// client-supplied X-Forwarded-For, trusting it lets any client spoof past both
// caps above, so a direct/LAN bind must key on the real socket address. ON in
// the deployed unit, because Apache proxies from 127.0.0.1 and keying on the
// socket address there would bill EVERY headset in the world to one key and
// refuse the 17th connection to the whole site (MAX_SOCKETS_PER_IP defaults to
// MAX_PEERS_PER_ROOM = 16) — a total outage, which is a far
// worse failure than the DoS this closes. See clientKey() for the
// header-missing case, which is exempted rather than lumped into one bucket.
const TRUST_PROXY = /^(1|true|yes|on)$/i.test((process.env.ROOM_TRUST_PROXY || '').trim());
const MSG_RATE_PER_SEC   = envInt('ROOM_MSG_RATE', 600);
const MSG_BURST          = envInt('ROOM_MSG_BURST', 1200);
const MAX_RATE_KILLS     = envInt('ROOM_MAX_RATE_VIOLATIONS', 600);
// MAX_RATE_KILLS is a SLIDING budget, not a lifetime one: the violation score
// decays linearly to zero over this window, so the close rule reads "more than
// MAX_RATE_KILLS over-budget messages within RATE_WINDOW_MS", not "the
// MAX_RATE_KILLS'th over-budget message this socket ever sent".
//
// The lifetime version was a real bug, not a nitpick: ws._dropped was set to 0
// at connect and only ever incremented, so a Quest parked in a room for an
// evening — dropping a handful of frames each time it woke from a compositor
// stall, a Wi-Fi roam or a core swap — would eventually accumulate 600 drops
// over hours of legitimate play and be closed with 4008 mid-game, with nothing
// in the client that retries a 4008. 10 s is ~17x the shipped 600 msg/s budget's
// own averaging period, so a genuine flood (which produces thousands of drops a
// second) still trips it within a fraction of a second.
const RATE_WINDOW_MS     = envInt('ROOM_RATE_VIOLATION_WINDOW_MS', 10000);
const MAX_BUFFERED_BYTES = envInt('ROOM_MAX_BUFFERED_BYTES', 4 * 1024 * 1024);
// Aggregate outbound budget. MAX_BUFFERED_BYTES is PER SOCKET, so on its own it
// multiplies out to ROOM_MAX_SOCKETS x 4 MiB = 1 GiB of queued frames — the same
// "individually defensible, jointly meaningless" shape as the STATE caps. The
// send path AND the heartbeat sweep sum bufferedAmount across every client and
// evict the most-backed-up sockets until the process total is under this.
const MAX_BUFFERED_TOTAL = envInt('ROOM_MAX_BUFFERED_TOTAL_BYTES', 32 * 1024 * 1024);
// How often the aggregate walk may run FROM THE SEND PATH (RELAY-1).
//
// Enforcing the total only on the heartbeat made 32 MiB a 10-SECOND AVERAGE
// rather than a ceiling. 256 sockets that stop reading while their peers fan out
// ~1 MiB WIRE frames (a WIRE carries no size check of its own beyond
// ROOM_MAX_PAYLOAD_BYTES, and one is amplified to 15 peers) reach 256 x 4 MiB
// ≈ 1.25 GiB resident in well under a second — up to ten of which pass before
// the heartbeat sweep ever looks. So the total is now checked where the bytes
// are actually queued.
//
// It stays cheap because the walk is gated on the socket being sent to already
// holding more than BUFFER_SWEEP_TRIGGER (a healthy peer's bufferedAmount is ~0,
// so a normal room never walks at all) and throttled to this interval for the
// case where EVERY socket is over the trigger, which is precisely the attack.
// 0 = walk on every over-trigger send (what the test uses for determinism); a
// value longer than the run restores heartbeat-only enforcement, which is the
// negative control that shows this is the code doing the work.
const BUFFER_SWEEP_MS = envIntZeroOk('ROOM_BUFFER_SWEEP_MS', 250);
// Per-socket queue depth at which a send starts checking the PROCESS total.
// Derived rather than a knob: it has no meaning apart from the two budgets it
// sits between — a quarter of the per-socket cap, so a socket well on its way to
// its own eviction triggers the aggregate check first, but never more than an
// eighth of the aggregate budget, so a deployment that lowers only the TOTAL
// still trips it long before the total is reached.
const BUFFER_SWEEP_TRIGGER = Math.max(1, Math.min(
  Math.floor(MAX_BUFFERED_BYTES / 4), Math.floor(MAX_BUFFERED_TOTAL / 8)));
// How long an evicted slow client is given to flush the queue behind its close
// frame before the socket is destroyed. Without it, `ws.close(4009)` followed
// immediately by `ws.terminate()` meant the 4009 close code was UNREACHABLE —
// the close frame sits behind the >4 MiB that triggered the eviction and the
// peer always saw a bare 1006, so the code and its "slow client" reason string
// were decorative. With a grace period a client that is merely SLOW drains and
// gets a diagnosable 4009; one that is genuinely dead still gets destroyed on
// time, because nothing waits on the timer.
// (parsed with envIntZeroOk, not envInt: 0 is a meaningful setting here — it is
// exactly the pre-fix "terminate at once" behaviour, and scripts/test-room-limits.mjs
// uses it as the negative control that proves the grace is what makes 4009 arrive.)
const BACKPRESSURE_GRACE_MS = envIntZeroOk('ROOM_BACKPRESSURE_GRACE_MS', 2000);
// How long a SOFTLY REFUSED socket (see refuseSoftly) is given to flush its
// close frame before it is destroyed. Not optional: `ws.close()` waits for the
// peer's close REPLY — `ws` allows 30 s — and a socket waiting that long is
// still in wss.clients, so a client that simply never answers could park
// unlimited refused sockets in the process, which is the very thing the
// admission caps exist to stop. A refused socket has exactly one small frame
// queued, so a second is ample.
// (envIntZeroOk, the same idiom as the two graces around it: 0 means "destroy at
// once", which is the negative control — the client then sees a bare 1006 with
// no reason, i.e. what a killed upgrade used to produce.)
const REFUSAL_GRACE_MS = envIntZeroOk('ROOM_REFUSAL_GRACE_MS', 1000);
// How many softly-refused sockets may be resident PROCESS-WIDE at once. Derived,
// not a knob: it has no meaning apart from the two numbers it sits between, and
// it exists for exactly one purpose — to keep MAX_SOCKETS a real ceiling.
//
// MAX_SOFT_REFUSALS_PER_IP bounds a flood from ONE address. This bounds the SUM,
// including the connections that are exempt from per-address billing altogether
// (ROOM_TRUST_PROXY on with no X-Forwarded-For — see clientKey). With it, total
// resident sockets are MAX_SOCKETS + this and no arrival rate an attacker picks
// can change that; without it the real bound was (attacker's upgrade rate x
// ROOM_REFUSAL_GRACE_MS), a number the attacker chooses. An eighth of the global
// cap is 32 here, which at a 1 s grace is ~32 polite refusals a SECOND — no
// legitimate load refuses anything like that fast, and past it the answer is
// still correct, just cheap.
const MAX_REFUSALS_IN_FLIGHT = Math.max(8, Math.ceil(MAX_SOCKETS / 8));
// How long a SIGTERM/SIGINT drain is given before the process is forced out.
// systemd restarts this unit on every `npm run deploy-room`, and with no signal
// handler at all (the state before 2026-08-15, CODEX_REVIEW SEC-6) every headset
// in every room had its socket destroyed mid-frame and saw a bare 1006 — the same
// undiagnosable code a Wi-Fi drop produces. Draining with 1001 + a reason instead
// tells the client this was deliberate and that reconnecting will work.
//
// Parsed with envIntZeroOk, not envInt: 0 is a MEANINGFUL setting here — it is
// exactly the pre-fix behaviour (exit at once, everyone gets 1006), and
// scripts/test-room-protocol.mjs uses it as the negative control that proves the
// drain is what makes 1001 arrive. Same idiom as ROOM_BACKPRESSURE_GRACE_MS.
const SHUTDOWN_GRACE_MS  = envIntZeroOk('ROOM_SHUTDOWN_GRACE_MS', 5000);
const ROOM_ID_MAX_LEN    = envInt('ROOM_MAX_ROOM_ID_LEN', 40);
const SID_MAX_LEN        = envInt('ROOM_MAX_SID_LEN', 64);
const SWEEP_MS           = envInt('ROOM_SWEEP_MS', 60000);
// Origin allow-list. EMPTY (the default) = accept any origin, which is what
// production needs: the app is served from dionysus.dk but is also opened from
// localhost dev servers, `file://` builds and the headset's own origin, and a
// wrong guess here silently breaks every headset. Set
// ROOM_ALLOWED_ORIGINS=https://dionysus.dk to lock it down. A MISSING Origin is
// always allowed: browsers always send one on a WebSocket upgrade, so only
// non-browser clients (this repo's own `ws` smoke tests, curl) lack it — and
// those are not what an Origin check defends against.
const ALLOWED_ORIGINS = (process.env.ROOM_ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Application close codes (4000-4999 is the reserved private range).
// PROTOCOL (4010) comes from NetProtocol rather than being spelled out here: the
// CLIENT has to recognise it as permanent (its reconnect backoff must not retry
// it), so the number is part of the shared contract, not a server-local detail.
// TRY_AGAIN (1013) is the registered "service overloaded, retry later" code and
// is deliberately NOT in the 4000-4999 range: it is not an application verdict
// on this client, and it must never join NetProtocol's PERMANENT_CLOSE_CODES,
// because the whole point of it is that the client comes back. See refuseSoftly.
const CLOSE = { RATE: 4008, BACKPRESSURE: 4009, PROTOCOL: PROTOCOL_CLOSE_CODE, TRY_AGAIN: 1013 };
// Ping sweep. Two missed periods terminate a socket, so this is also how fast an
// UNCLEAN host death (Quest sleeping, Wi-Fi yanked, killed tab) is noticed and the
// host role migrates. 30s meant up to a minute of clients staring at a frozen
// picture while still forwarding input to a peer that was gone; 10s bounds that to
// ~20s, and the clients' own presence TTL (5s) reverts the dead video well before.
// Env-tunable so scripts/test-room-limits.mjs can exercise the sweep (which also
// enforces the AGGREGATE outbound budget) without a 10 s wait per assertion.
const HEARTBEAT_MS = envInt('ROOM_HEARTBEAT_MS', 10000);
// How long after a ping a silent socket stops counting toward its address's
// concurrency slot (see billable()). Derived, not a knob: it has no meaning
// apart from the ping period it sits inside, and a quarter of that period is
// still hundreds of times the round trip a headset on Wi-Fi answers a ping in,
// so nothing live is ever mistaken for a ghost.
const PING_GRACE_MS = Math.max(1000, Math.floor(HEARTBEAT_MS / 4));

const hub = new Hub();
const sockets = new Map(); // peerId -> ws

// Room ids come straight off the query string and become Map keys, so they are
// normalised server-side with the SAME rule the client uses
// (src/net/SessionUtils.js sanitiseRoom): trim, collapse anything outside
// [A-Za-z0-9_-] to a dash, strip edge dashes, truncate. Duplicated rather than
// imported ON PURPOSE — scripts/deploy.ps1 -Room ships only server/*, and
// src/net/NetProtocol.js to the box, so importing a second src/ file would
// crash-loop the live unit on a missing module. Keep the two in step.
const sanitiseRoomId = (raw) => {
  if (!raw || typeof raw !== 'string') return null;
  return raw.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, ROOM_ID_MAX_LEN) || null;
};

const roomFromReq = (req) => {
  try { return sanitiseRoomId(new URL(req.url, 'http://localhost').searchParams.get('room')) || 'lobby'; }
  catch { return 'lobby'; }
};

// M1.4: the client's stable per-tab session id, used only for the host-reclaim
// window (a host that reloads the page gets its role back). Absent → the peer
// simply joins as the most junior member. Length-capped: it is only ever
// compared for equality, so a 10 MB "sid" would be pure retained memory.
const sidFromReq = (req) => {
  try {
    const sid = new URL(req.url, 'http://localhost').searchParams.get('sid');
    return sid ? sid.slice(0, SID_MAX_LEN) : null;
  } catch { return null; }
};

/**
 * The address a connection is BILLED to for the per-IP caps, or null for
 * "unbillable — exempt from them".
 *
 * Behind Apache the direct peer is always 127.0.0.1, so the real client is the
 * LAST hop of X-Forwarded-For: a client that sends its own XFF has the proxy
 * APPEND the address it actually connected from, so the last entry is the one
 * hop nobody upstream of the proxy could forge. Reading the FIRST entry — the
 * usual "original client" convention — is what makes an XFF-keyed limiter
 * trivially evadable by a client that fabricates a fresh first hop per socket.
 *
 * Header missing while TRUST_PROXY is on ⇒ null ⇒ EXEMPT, deliberately. The
 * obvious alternative (fall back to remoteAddress) would bill every proxied
 * headset in the world to 127.0.0.1 and refuse the 17th connection to the entire
 * site (MAX_SOCKETS_PER_IP defaults to MAX_PEERS_PER_ROOM = 16), so a proxy that
 * turns out not to send XFF would take production down.
 * Exempting degrades to the pre-RELAY-3 behaviour — global caps only — and the
 * deployed unit closes the unproxied path anyway with ROOM_HOST=127.0.0.1.
 */
function clientKey(req) {
  if (!TRUST_PROXY) return req?.socket?.remoteAddress || null;
  const raw = req?.headers?.['x-forwarded-for'];
  const hops = String(Array.isArray(raw) ? raw.join(',') : (raw || ''))
    .split(',').map((s) => s.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : null;
}

// Per-address admission state: two leaky scores plus a hard-refusal counter, in
// ONE record per address so the sweeper has one thing to drop. Both scores drain
// their own budget per UPGRADE_WINDOW_MS, the same shape (and for the same
// reason) as the per-socket rate-violation score below — a list of upgrade
// timestamps would be simpler to read but retains one entry per attempt for a
// whole window, memory whose size the attacker picks.
//
//   churn — upgrades this address actually got ADMITTED, vs MAX_UPGRADES_PER_IP
//   soft  — refusals answered the EXPENSIVE way,     vs MAX_SOFT_REFUSALS_PER_IP
//
// They are two budgets, not one, and that split IS the design. The single bucket
// this replaces charged every attempt — admitted or refused — and refused once it
// went over. So a client stuck in a refusal loop drove its own address over the
// budget, and from then on EVERY upgrade from that address was refused: a device
// joining a different, half-empty room; any of the sixteen already-connected
// headsets reconnecting after a Wi-Fi blip. One stuck tab locked out the
// household, and because the rate refusal was itself soft the loop never slowed
// down, so the address stayed locked out until a human closed a tab. Now:
//
//   • only an ADMITTED upgrade is charged to `churn`, because only an admitted
//     upgrade buys the room-state replay this budget exists to bound;
//   • a REFUSED upgrade is charged to `soft`, which can never refuse anything —
//     it only decides whether that refusal costs a handshake or an HTTP error.
//
// A refused attempt therefore never makes the NEXT attempt likelier to be
// refused; it only makes the next REFUSAL cheaper. That is the invariant the two
// previous rounds of this fix each broke, in opposite directions.
const addrState = new Map(); // ip -> { churn, churnAt, soft, softAt, hard }

/** A leaky score, drained to `now` at `perWindow` points per UPGRADE_WINDOW_MS. */
const drain = (score, at, now, perWindow) =>
  Math.max(0, score - ((now - at) / UPGRADE_WINDOW_MS) * perWindow);

function addrRec(key) {
  let rec = addrState.get(key);
  if (!rec) {
    const now = Date.now();
    rec = { churn: 0, churnAt: now, soft: 0, softAt: now, hard: 0 };
    addrState.set(key, rec);
  }
  return rec;
}

/**
 * Would ADMITTING this upgrade put the address over its churn budget? True =
 * refuse it.
 *
 * Drain first, then compare the PROSPECTIVE score with `>`, which makes the rule
 * exactly "more than MAX_UPGRADES_PER_IP admissions within the window" and is
 * off-by-one-free: ten admissions in a row each drain a few thousandths of a
 * point, so a budget of 3 sits at 2.986 after three and 2.986 + 1 > 3 still
 * refuses the fourth.
 *
 * Nothing is charged when the answer is "refuse". The score counts joins this
 * address actually GOT, so a join it did not get must not appear in it — the old
 * bucket charged refusals here, which is what let a refusal loop sustain itself
 * and lock out everything else at the same address. The clamp that bucket needed
 * (two windows' worth, so a 10,000-attempt flood could not lock a NATted
 * household out for ~166 windows after it stopped) goes with it: a score never
 * charged past its own cap cannot overshoot in the first place.
 */
function overChurnBudget(key) {
  const now = Date.now();
  const rec = addrRec(key);
  const score = drain(rec.churn, rec.churnAt, now, MAX_UPGRADES_PER_IP);
  rec.churnAt = now;
  if (score + 1 > MAX_UPGRADES_PER_IP) { rec.churn = score; return true; }
  rec.churn = score + 1;
  return false;
}

/**
 * Charge one refusal and answer the only question left: is this address still
 * worth an EXPENSIVE refusal (accept the upgrade, close 1013 + reason) or has it
 * earned the cheap one (HTTP 429, no WebSocket object)?
 *
 * Note what this does NOT do: it never refuses. By the time it is called a
 * capacity cap has already said no, so the worst it can do to a legitimate peer
 * is make a "no" it was getting anyway less informative.
 */
function softRefusalAllowed(key) {
  // Unbillable (ROOM_TRUST_PROXY on, no X-Forwarded-For) has no per-address
  // budget by design — see clientKey(). MAX_REFUSALS_IN_FLIGHT is what bounds
  // those, and verifyClient checks it first.
  if (!key) return true;
  const now = Date.now();
  const rec = addrRec(key);
  const score = drain(rec.soft, rec.softAt, now, MAX_SOFT_REFUSALS_PER_IP);
  rec.softAt = now;
  if (score + 1 > MAX_SOFT_REFUSALS_PER_IP) { rec.soft = score; return false; }
  rec.soft = score + 1;
  return true;
}

// Hard refusals from clients with no per-address record to count them in. Only
// reachable through the MAX_REFUSALS_IN_FLIGHT backstop, since an unbillable
// client has no soft budget to run out of.
let unbilledHardRefusals = 0;

/**
 * The CHEAP door: kill the HTTP upgrade. No Sec-WebSocket-Accept, no extension
 * negotiation, no WebSocket object, no entry in wss.clients, no close frame and
 * no terminate timer — `ws` writes the status line and destroys the socket. This
 * has to stay cheaper than accepting, because it is the answer a flood gets, and
 * "every refusal is soft" made refusing strictly MORE expensive than admitting.
 *
 * The log is sparse BY CONSTRUCTION: this is the flood path, and a line per
 * refusal hands an attacker the disk. The first one is the operator-relevant
 * event (this address just crossed into the cheap tier); after that every 500th,
 * the same idiom the per-socket rate limiter uses.
 */
function refuseHard(cb, key, reason, why) {
  const n = key ? ++addrRec(key).hard : ++unbilledHardRefusals;
  if (n === 1 || n % 500 === 0) {
    console.log(`[room-server] x HARD refused ${key || 'unbillable client'} (#${n}): ${reason} — ${why}, answered 429 with no WebSocket`);
  }
  return cb(false, 429, 'Too many requests');
}

/**
 * Does this socket still occupy one of its address's concurrency slots?
 *
 * "Is it in wss.clients" was the wrong question. A Quest that sleeps, or whose
 * app is killed without a clean close, leaves a socket that answers nothing —
 * and the heartbeat only reaps it on the sweep AFTER the ping it missed, so for
 * up to two HEARTBEAT_MS periods a ghost was billed to a live household's
 * address and could refuse a real headset's rejoin. A socket that has been
 * pinged and has said nothing since for PING_GRACE_MS is already on its way out,
 * so it stops counting here instead of waiting for the sweep to agree.
 *
 * The other two cases are the same idea: a socket already CLOSING (an evicted
 * slow client draining behind its close frame, or one accepted purely so it
 * could be refused politely) is leaving, and must not make the NEXT admission
 * decision stricter.
 *
 * The `_refused` line is REDUNDANT TODAY and kept on purpose. surveyClients() —
 * the only caller — already `continue`s on a refused socket before it gets here,
 * so this can never be evaluated with `_refused` true. It stays because this
 * predicate answers a question about ONE socket and has to be right on its own
 * terms: a refused socket is leaving, so it is not billable, whoever asks. Read
 * it as belt-and-braces for a refactor that moves the refused check, not as the
 * mechanism that excludes refusals now (that is surveyClients, below).
 */
function billable(ws) {
  if (ws._refused) return false;                    // accepted only to say "try again"
  if (ws.readyState !== ws.OPEN) return false;      // closing / closed, just not reaped yet
  return !(ws._pingAt && Date.now() - ws._pingAt > PING_GRACE_MS);
}

/**
 * One walk of the client set per upgrade, answering the three questions
 * admission asks of it. `live` and `refused` are NOT the same question, and
 * conflating them was the outage.
 *
 * `live` counts sockets that ARE or CAN BECOME sessions, and therefore EXCLUDES
 * softly-refused ones. The global gate used to be `wss.clients.size >=
 * MAX_SOCKETS`, and a refused socket is a real entry in that set for
 * ROOM_REFUSAL_GRACE_MS — so ~256 upgrades a second from ONE address held the
 * count at the cap with zero peers in any room, and every real headset was then
 * refused too: a total relay outage at a trivial request rate, driven entirely by
 * sockets that could never become a session. A socket that cannot become a
 * session must not consume the budget for sockets that can.
 *
 * `refused` is the other half of that accounting — what MAX_REFUSALS_IN_FLIGHT is
 * compared against, so both numbers come out of one walk.
 *
 * `fromKey` is counted here rather than from a counter kept at accept time ON
 * PURPOSE: an upgrade verifyClient accepts can still fail before 'connection'
 * fires (a client that walks away mid-handshake), and a counter incremented at
 * accept time would leak a slot on every such attempt — a permanent,
 * attacker-triggerable ban on that address. It uses billable(), so a slept
 * Quest's ghost stops holding its household's slot PING_GRACE_MS after the ping
 * it missed instead of waiting for the heartbeat sweep to agree.
 *
 * The walk is O(clients ≤ MAX_SOCKETS + MAX_REFUSALS_IN_FLIGHT) and runs once per
 * upgrade — an upgrade that costs a full room-state replay if it is admitted, and
 * a bounded number of which are answered expensively at all.
 */
function surveyClients(key) {
  let live = 0, refused = 0, fromKey = 0;
  for (const ws of wss.clients) {
    if (ws._refused) { refused++; continue; }
    live++;
    if (key && ws._ipKey === key && billable(ws)) fromKey++;
  }
  return { live, refused, fromKey };
}

/**
 * Handshake-time admission (runs BEFORE a peer exists, so a refused client never
 * shows up in a roster or a HELLO).
 *
 * HOW a refusal is delivered matters as much as the decision, and there are two
 * ways. This is the third design of that, because each of the first two fixed
 * one side of it and broke the other.
 *
 * SOFT — accept the upgrade, then close at once with 1013 + the reason (see
 * refuseSoftly). Every cap here once answered `cb(false, 503|429)` instead,
 * which kills the HTTP upgrade — and a killed upgrade is TERMINAL for the
 * clients already deployed to headsets: their close handler only retries once a
 * socket has been open at least once (`wasConnected || this._reconnectTries` in
 * src/net/NetMgr.js and src/desktop/DesktopNet.js, both falsy on a fresh
 * client's FIRST connect), and only close code 4010 produces any status text.
 * So a TRANSIENT "we are busy, come back in a moment" left the multiplayer
 * widget on "Offline" for the rest of the page's life with nothing retrying
 * behind it — exactly the state COR-9 was written to eliminate. A soft refusal
 * costs the relay one handshake and nothing else: no peer, no roster entry, no
 * HELLO and, crucially, no state replay.
 *
 * HARD — `cb(false, 429)`, no WebSocket object at all (refuseHard). Reached when
 * this address has spent its MAX_SOFT_REFUSALS_PER_IP budget of expensive
 * answers, or the process is already holding MAX_REFUSALS_IN_FLIGHT of them. A
 * soft refusal is a real socket for ROOM_REFUSAL_GRACE_MS, so making EVERY
 * refusal soft made refusing strictly MORE expensive than admitting, and handed
 * one address a total relay outage for the price of ~256 upgrades a second.
 * Turning away an address that will not stop has to be the cheap path or it is
 * not a defence.
 *
 * WHERE THE TWO CONFLICT, and how it is settled. A deployed client that is
 * softly refused resets its backoff on the very 'open' the refusal produces, so
 * it knocks at 2 Hz for the life of its page, and we cannot ship it a fix.
 * Bounding that (server survival) and always telling a real user why (the only
 * way a deployed client escapes "Offline") cannot both hold in the limit. The
 * order is: SERVER SURVIVAL WINS — but a FULL ROOM IS A LEGITIMATE, COMMON STATE
 * and must never be the thing that trips the cheap path for everyone else at
 * that address. Hence the budget split (see addrState): a refusal is charged
 * only to `soft`, which sets the PRICE of a refusal and can never cause one,
 * while the churn budget that CAN refuse is charged only by admissions. Two tabs
 * stuck at a full room therefore burn their household's expensive answers and
 * get 429s, while the other fourteen devices join, play and reconnect untouched.
 * The residue is real and is written down rather than hidden: a brand-new
 * arrival at an address that has burned MAX_SOFT_REFUSALS_PER_IP refusals inside
 * one window is refused with a 429, and a pre-COR-9 client seeing that on its
 * very first connect shows "Offline" and does not retry — but only while that
 * address is being refused 64+ times a minute, i.e. while everything at it is
 * being turned away anyway.
 *
 * A disallowed Origin stays a killed upgrade for a different reason: it is an
 * operator's exclusion, so retrying can only produce the same answer, and such a
 * browser should not be handed a socket at all.
 */
function verifyClient({ origin, req }, cb) {
  if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
    console.log(`[room-server] x upgrade refused: origin "${origin}" not allowed`);
    return cb(false, 403, 'Forbidden origin');
  }
  const ipKey = clientKey(req);
  // ONE walk of the client set for all three counts this function needs — see
  // surveyClients, especially why `live` is not wss.clients.size.
  const seen = surveyClients(ipKey);
  /**
   * A capacity cap said no. Pick the tier and answer.
   *
   * The in-flight check comes FIRST and short-circuits, so an address that is
   * about to be hard-refused anyway does not spend a soft-budget point it will
   * never use. Order matters the other way too: softRefusalAllowed() charges,
   * so it must be called exactly once per refusal.
   */
  const refuse = (reason) => {
    if (seen.refused >= MAX_REFUSALS_IN_FLIGHT) {
      return refuseHard(cb, ipKey, reason, `${seen.refused} soft refusals already in flight (max ${MAX_REFUSALS_IN_FLIGHT})`);
    }
    if (!softRefusalAllowed(ipKey)) {
      return refuseHard(cb, ipKey, reason, `over ${MAX_SOFT_REFUSALS_PER_IP} soft refusals per ${UPGRADE_WINDOW_MS}ms`);
    }
    // Stashed on the request and carried out in the 'connection' handler, which
    // is the first moment there is a socket to close. `req` is the same object
    // `ws` hands that handler, so nothing else has to be threaded through.
    req._softRefusal = reason;
    return cb(true);
  };
  if (seen.live >= MAX_SOCKETS) {
    // A soft refusal accepts a socket in order to refuse it, so the process can
    // sit over MAX_SOCKETS while refused sockets flush their close frames — but
    // by a KNOWN amount now (MAX_REFUSALS_IN_FLIGHT, checked in refuse() above)
    // rather than by (arrival rate x ROOM_REFUSAL_GRACE_MS), which was a number
    // the attacker picked. Each of those holds one small queued frame rather
    // than a peer, a room membership and a state replay.
    return refuse(`server at capacity (${seen.live}/${MAX_SOCKETS} sockets)`);
  }
  // Per-address occupancy before the room lookups below: it is what stops one
  // client taking every global slot, and it must not be reachable only after the
  // global slots are already gone.
  if (ipKey && seen.fromKey >= MAX_SOCKETS_PER_IP) {
    return refuse(`too many connections from this address (${seen.fromKey}/${MAX_SOCKETS_PER_IP})`);
  }
  const roomId = roomFromReq(req);
  if (!hub.rooms.has(roomId) && hub.roomCount() >= MAX_ROOMS) {
    return refuse(`too many rooms (${hub.roomCount()}/${MAX_ROOMS}), "${roomId}" would be new`);
  }
  if (hub.size(roomId) >= MAX_PEERS_PER_ROOM) {
    return refuse(`room "${roomId}" full (${hub.size(roomId)}/${MAX_PEERS_PER_ROOM})`);
  }
  // CHURN LAST, and charged only if everything else said yes — the inversion of
  // the old order, which put the rate bucket first so that "EVERY attempt is
  // charged even when another cap is the one that answers". That rationale was
  // "a client already at the concurrency cap must not hammer the door for free",
  // and it is now served properly: hammering burns the SOFT budget and drops to
  // 429s, which is genuinely cheap, instead of poisoning a budget whose refusals
  // hit every other device at the same address.
  if (ipKey && overChurnBudget(ipKey)) {
    return refuse(`too many connection attempts (over ${MAX_UPGRADES_PER_IP} per ${UPGRADE_WINDOW_MS}ms)`);
  }
  return cb(true);
}

// `host` is spread in only when ROOM_HOST is set: passing `host: undefined` is
// not the same as omitting it in every Node version, and omitting it is what
// keeps the dual-stack (IPv4 + IPv6) listener LAN dev has always had.
const wss = new WebSocketServer({
  ...(HOST ? { host: HOST } : {}), port: PORT, maxPayload: MAX_PAYLOAD_BYTES, verifyClient,
});

// A listen failure (EADDRINUSE) must NOT be swallowed by the uncaughtException
// handler above into a process that is up but serving nothing.
wss.on('error', (err) => {
  console.error('[room-server] server error:', err?.stack || err);
  if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) process.exit(1);
});

/**
 * Evict a socket whose outbound queue has run away, telling it WHY.
 *
 * The close code has to survive the queue that caused the eviction. `ws.close()`
 * appends a close frame after everything already pending, so on a socket holding
 * >4 MiB the peer only ever sees the 4009 if it drains first. The old code called
 * `terminate()` on the very next line, which destroyed the socket before any of
 * that could happen — every evicted peer got a bare 1006 and the 4009/"slow
 * client" pair was unreachable dead code. So: close, then destroy on a timer.
 *
 * The timer is `unref`'d and nothing awaits it — a genuinely dead peer is still
 * gone within BACKPRESSURE_GRACE_MS and the process can still exit. Setting
 * ROOM_BACKPRESSURE_GRACE_MS=0 restores the old destroy-immediately behaviour.
 */
function evictSlow(ws, peerId, why) {
  console.log(`[room-server] x evicting ${String(peerId).slice(0, 8)}: ${why} (grace ${BACKPRESSURE_GRACE_MS}ms before terminate)`);
  try { ws.close(CLOSE.BACKPRESSURE, 'slow client'); } catch { /* already gone */ }
  if (BACKPRESSURE_GRACE_MS <= 0) { try { ws.terminate(); } catch { /* gone */ } return; }
  const t = setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, BACKPRESSURE_GRACE_MS);
  if (typeof t.unref === 'function') t.unref();
}

/**
 * Turn away a connection an admission cap refused, in a way the ALREADY DEPLOYED
 * client recovers from: accept the upgrade, then close at once with 1013 ("try
 * again later") and the reason it was refused for.
 *
 * The close code is the whole trick. Because the client saw an 'open' first, its
 * close handler is on the ORDINARY unexpected-drop path — backoff, retry, get in
 * when a slot frees — rather than the first-connect path that gives up silently.
 * 1013 is also not permanent, so a client new enough to read the reason can show
 * it without latching a fatal. See verifyClient for why the refusal moved here.
 *
 * This is the EXPENSIVE tier and is rationed: a full handshake, a real entry in
 * wss.clients for ROOM_REFUSAL_GRACE_MS, an error listener, a log line and a
 * terminate timer, all to say no. verifyClient only reaches it while the address
 * is inside MAX_SOFT_REFUSALS_PER_IP and the process is inside
 * MAX_REFUSALS_IN_FLIGHT; past either, refuseHard() answers instead and none of
 * this runs. The sockets it does create are excluded from the global capacity
 * gate by surveyClients() — a socket accepted purely so it could be refused must
 * never displace one that can become a session.
 *
 * The terminate timer is NOT optional; see ROOM_REFUSAL_GRACE_MS.
 */
function refuseSoftly(ws, reason) {
  // Marked BEFORE the close, so surveyClients() skips this socket from the very
  // next upgrade on — its `if (ws._refused) { refused++; continue; }` is what
  // keeps a refusal out of BOTH the global `live` count and the per-address
  // `fromKey` one, in the same tick, while the socket is still OPEN and still in
  // wss.clients. (billable() refuses it too, but never gets asked: surveyClients
  // has already skipped it. Naming billable() here as the mechanism is what an
  // earlier revision of this comment did, and it points a refactor at the wrong
  // line.) A refusal must never make the next admission decision stricter.
  ws._refused = true;
  // A refused socket gets no other listeners, and an EventEmitter with no
  // 'error' handler THROWS — e.g. if the heartbeat pings it in the window
  // between the close frame and the terminate.
  ws.on('error', () => { /* nothing to clean up — this socket is already leaving */ });
  console.log(`[room-server] x refused ${ws._ipKey || 'unbillable client'}: ${reason} (soft ${CLOSE.TRY_AGAIN}, the client may retry)`);
  // A close reason is capped at 123 bytes by the protocol and `ws` THROWS past
  // that — and a room id inside one is caller-supplied, so clamp rather than
  // trust every future call site.
  try { ws.close(CLOSE.TRY_AGAIN, String(reason).slice(0, 100)); } catch { /* already gone */ }
  if (REFUSAL_GRACE_MS <= 0) { try { ws.terminate(); } catch { /* gone */ } return; }
  const t = setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, REFUSAL_GRACE_MS);
  if (typeof t.unref === 'function') t.unref();
}

/**
 * Enforce the AGGREGATE outbound budget: sum every client's queue and evict the
 * most-backed-up sockets until the process total is back under
 * MAX_BUFFERED_TOTAL. Called from the send path (throttled, see
 * maybeEnforceAggregateBudget) and unconditionally from the heartbeat.
 *
 * Evicting the biggest offenders first keeps the process total bounded without
 * punishing a room full of healthy peers — a late joiner draining a 2 MiB state
 * replay is nowhere near the top of the list.
 */
function enforceAggregateBudget(where) {
  const live = [];
  let totalBuffered = 0;
  for (const ws of wss.clients) {
    // A socket already evicted (readyState CLOSING) is still holding its queue
    // until its grace timer fires, so it COUNTS toward the total — but it is not
    // an eviction candidate again.
    totalBuffered += ws.bufferedAmount;
    if (ws.readyState === ws.OPEN) live.push(ws);
  }
  if (totalBuffered <= MAX_BUFFERED_TOTAL) return;
  console.log(`[room-server] ! aggregate backpressure (${where}): ${totalBuffered} bytes queued across ${wss.clients.size} sockets > ${MAX_BUFFERED_TOTAL} (${live.length} evictable)`);
  live.sort((a, b) => b.bufferedAmount - a.bufferedAmount);
  for (const ws of live) {
    if (totalBuffered <= MAX_BUFFERED_TOTAL) break;
    totalBuffered -= ws.bufferedAmount;
    evictSlow(ws, ws._peerId, `${ws.bufferedAmount} bytes buffered, server total over ${MAX_BUFFERED_TOTAL}`);
  }
}
// Seeded with `now`, not 0: an unset-or-huge ROOM_BUFFER_SWEEP_MS must mean "the
// send path never sweeps" (the negative control), and a 0 seed would let the
// very first over-trigger send through the throttle regardless.
let lastAggregateSweep = Date.now();
function maybeEnforceAggregateBudget() {
  const now = Date.now();
  if (BUFFER_SWEEP_MS > 0 && now - lastAggregateSweep < BUFFER_SWEEP_MS) return;
  lastAggregateSweep = now;
  enforceAggregateBudget('send');
}

function sendTo(peerId, msg) {
  const ws = sockets.get(peerId);
  if (!ws || ws.readyState !== ws.OPEN) return;
  // Backpressure eviction: a client that has stopped reading (a suspended Quest
  // tab, a half-open TCP connection the heartbeat has not caught yet) makes every
  // broadcast queue in THIS process's memory. Past the threshold, drop it — the
  // close handler does the normal cleanup, so the room simply sees it leave.
  // (readyState is checked above, so a socket already evicted here is skipped and
  // cannot be closed twice.)
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    evictSlow(ws, peerId, `${ws.bufferedAmount} bytes buffered > ${MAX_BUFFERED_BYTES}`);
    return;
  }
  // RELAY-1: the cap above bounds ONE queue; what an attacker actually grows is
  // the PROCESS total, by stalling many sockets at once — none of which is
  // individually over its 4 MiB. Checking that only on the heartbeat made the
  // 32 MiB total a ten-second average that ~1.25 GiB fits inside, so it is
  // checked here too, gated on this socket already being backed up and throttled
  // to ROOM_BUFFER_SWEEP_MS.
  if (ws.bufferedAmount > BUFFER_SWEEP_TRIGGER) {
    maybeEnforceAggregateBudget();
    // The sweep may have evicted THIS socket — it is by definition one of the
    // most-backed-up. Sending now would queue more bytes BEHIND the close frame
    // the eviction just wrote, which is exactly what made 4009 unreachable.
    if (ws.readyState !== ws.OPEN) return;
  }
  ws.send(encode(msg));
}

function broadcast(roomId, { msg, exclude } = {}) {
  if (!msg) return;
  for (const pid of hub.peerIds(roomId)) if (pid !== exclude) sendTo(pid, msg);
}

// M1.4: after a host's socket drops, the room stays hostless for HOST_RECLAIM_MS
// so that host can reclaim on reconnect (its own reload). This timer closes the
// window and promotes the longest-present remaining peer if it never came back.
// One timer per room; a later disconnect re-arms it (Hub.expireHostGrace no-ops
// for a window that has since been replaced).
const graceTimers = new Map(); // roomId -> timeout
function scheduleHostGrace(roomId, ms) {
  const prev = graceTimers.get(roomId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    graceTimers.delete(roomId);
    const { hostChange } = hub.expireHostGrace(roomId);
    if (!hostChange) return;
    broadcast(roomId, { msg: hostChange });
    console.log(`[room-server] host reclaim window expired in "${roomId}" → host=${hostChange.id.slice(0, 8)} (seniority)`);
  }, ms + 50);
  if (typeof t.unref === 'function') t.unref();
  graceTimers.set(roomId, t);
}

wss.on('connection', (ws, req) => {
  // Stamped here (not in verifyClient) because this is the first moment the
  // socket exists: surveyClients() counts these, so a socket that never got
  // this far can never hold a per-address slot.
  ws._ipKey = clientKey(req);
  // An admission cap said no. Close before any peer exists — no roster entry, no
  // HELLO, no state replay — but CLOSE, rather than having killed the upgrade, so
  // the deployed client retries instead of showing "Offline" forever. See
  // verifyClient.
  if (req._softRefusal) return refuseSoftly(ws, req._softRefusal);

  const roomId = roomFromReq(req);
  const peerId = randomUUID();
  ws._peerId = peerId;
  ws._roomId = roomId;
  ws.isAlive = true;
  ws._pingAt = 0;        // set by the heartbeat, cleared by 'pong' — see billable()
  sockets.set(peerId, ws);

  const { hello, state, hostBroadcast } = hub.connect(roomId, peerId, { sid: sidFromReq(req) });
  // Through sendTo(), not a raw ws.send() (RELAY-1). This is the single largest
  // outbound write the relay makes — HELLO plus one frame per key of the room's
  // STATE map, up to the room's whole 2 MiB budget — and it was the one path that
  // went through NEITHER the per-socket cap NOR the aggregate budget, even though
  // RELAY-3's comment above names exactly this replay as the expensive thing one
  // handshake buys. Sockets that join a full room and then read nothing queued
  // ~2 MiB each with only the 10 s heartbeat behind them: the same
  // ten-second-average hole RELAY-1 closed on the send path, reached through the
  // one path it did not cover.
  sendTo(peerId, hello);
  // M0.5: replay the room's current shared object state so a late joiner
  // converges (adopts the host's room layout, sees which game is on the TV).
  for (const msg of state || []) {
    // The aggregate sweep can evict THIS socket part-way through the replay — it
    // is by definition one of the biggest queues in the process while it drains.
    // sendTo() would drop each remaining frame anyway; stopping here also skips
    // encoding them.
    if (ws.readyState !== ws.OPEN) break;
    sendTo(peerId, msg);
  }
  // M1.4: a returning host reclaimed the role inside the grace window — tell the
  // peer that was holding it in the meantime.
  if (hostBroadcast) broadcast(roomId, { msg: hostBroadcast, exclude: peerId });
  console.log(`[room-server] + ${peerId.slice(0, 8)} → "${roomId}" (${hub.size(roomId)} in room, host=${String(hub.hostOf(roomId)).slice(0, 8)})`);

  ws.on('pong', () => { ws.isAlive = true; ws._pingAt = 0; });

  // Token bucket, one per socket: MSG_BURST tokens, refilled at MSG_RATE_PER_SEC.
  // Over-budget messages are DROPPED (not fatal — a legitimate client that bursts
  // once loses a pose frame, not its session); a client that keeps hammering past
  // MAX_RATE_KILLS dropped messages is closed.
  ws._tokens = MSG_BURST;
  ws._lastRefill = Date.now();
  ws._dropped = 0;        // LIFETIME count — diagnostics/logging only, never a kill trigger
  ws._violations = 0;     // DECAYING score — this is what closes the socket
  ws._violAt = Date.now();
  ws._invalid = 0;
  const takeToken = () => {
    const now = Date.now();
    ws._tokens = Math.min(MSG_BURST, ws._tokens + ((now - ws._lastRefill) / 1000) * MSG_RATE_PER_SEC);
    ws._lastRefill = now;
    if (ws._tokens < 1) return false;
    ws._tokens -= 1;
    return true;
  };
  // Leaky-bucket violation score. Drains MAX_RATE_KILLS points per RATE_WINDOW_MS
  // and gains 1 per over-budget message, so it crosses MAX_RATE_KILLS only when a
  // socket sustains more than that many drops INSIDE one window. An idle-ish peer
  // that drips a few drops an hour decays to 0 between them and is never closed —
  // which is the whole point: ws._dropped, the counter this replaces, only ever
  // went up, so a long session was closed with 4008 for its cumulative history.
  const scoreViolation = () => {
    const now = Date.now();
    const drained = ((now - ws._violAt) / RATE_WINDOW_MS) * MAX_RATE_KILLS;
    ws._violAt = now;
    ws._violations = Math.max(0, ws._violations - drained) + 1;
    return ws._violations;
  };

  ws.on('message', (data) => {
    if (!takeToken()) {
      ws._dropped++;
      const score = scoreViolation();
      if (ws._dropped === 1 || ws._dropped % 500 === 0) {
        console.log(`[room-server] ! rate limit: ${peerId.slice(0, 8)} in "${roomId}" over ${MSG_RATE_PER_SEC}/s (${ws._dropped} dropped lifetime, score ${score.toFixed(0)}/${MAX_RATE_KILLS} in ${RATE_WINDOW_MS}ms)`);
      }
      if (score >= MAX_RATE_KILLS) {
        console.log(`[room-server] x closing ${peerId.slice(0, 8)}: ${score.toFixed(0)} rate-limited messages within ${RATE_WINDOW_MS}ms`);
        ws.close(CLOSE.RATE, 'rate limit');
      }
      return;
    }
    // NOTE: decode() runs NetProtocol.validate() — the SHARED client/server
    // contract. Never re-implement the type/kind lists here; a second copy is how
    // the two ends drift (e.g. a 'bye' SIGNAL kind added to NetProtocol would be
    // rejected by a hardcoded server list). Malformed frames are dropped and
    // counted for diagnostics only — deliberately NOT fatal, so an app built
    // against a newer protocol than this server cannot be disconnected by it.
    const msg = decode(data.toString());
    if (!msg) {
      ws._invalid++;
      if (ws._invalid === 1 || ws._invalid % 500 === 0) {
        console.log(`[room-server] ! ${peerId.slice(0, 8)} sent ${ws._invalid} undecodable message(s) in "${roomId}"`);
      }
      return;
    }
    if (msg.type === MSG.JOIN) {
      // --- protocol compatibility handshake (CODEX_REVIEW COR-9) -----------
      // The app and this server are deployed by SEPARATE commands, so a skewed
      // pair is the normal state during a rollout. The rule (NetProtocol
      // checkProtocol) is deliberately asymmetric:
      //   • NO version   → a client older than this handshake. ACCEPTED — a
      //     deployed app must never be bricked by deploying a new relay — but
      //     logged ONCE per socket so an operator can see the skew. (Once per
      //     socket, not per JOIN: a client that spams JOIN would otherwise spam
      //     the journal at the full 600 msg/s budget.)
      //   • different MAJOR → closed with 4010 and a human-readable reason,
      //     because the alternative is what this fixes: messages the other end
      //     silently drops, for months, with everything looking healthy.
      const compat = checkProtocol(msg.v);
      if (compat.verdict === 'incompatible') {
        console.log(`[room-server] x closing ${peerId.slice(0, 8)} in "${roomId}": ${compat.reason}`);
        ws.close(CLOSE.PROTOCOL, compat.reason);
        return;
      }
      if (compat.verdict === 'legacy' && !ws._legacyLogged) {
        ws._legacyLogged = true;
        console.log(`[room-server] ! ${peerId.slice(0, 8)} in "${roomId}" announced no protocol version — pre-COR-9 client, accepted (server speaks ${PROTOCOL_VERSION})`);
      }
      broadcast(roomId, hub.identify(roomId, peerId, msg).broadcast);
    }
    else if (msg.type === MSG.POSE) broadcast(roomId, hub.pose(roomId, peerId, msg).broadcast);
    else if (msg.type === MSG.SIGNAL) {
      const { direct } = hub.signal(roomId, peerId, msg);
      if (direct) sendTo(direct.to, direct.msg);
    } else if (msg.type === MSG.STATE) {
      // M1.4: host-owned keys (tv/room/shelf:*) are rejected from non-hosts; the
      // writer gets the authoritative value back so it can't diverge.
      const res = hub.setState(roomId, peerId, msg);
      if (res.direct) sendTo(res.direct.to, res.direct.msg);
      if (res.rejected) {
        const what = (res.rejected === 'not-host' || res.rejected === 'host-reclaim-window')
          ? `tried to set host-owned "${String(msg.key).slice(0, 64)}"`
          : `STATE "${String(msg.key).slice(0, 64)}" refused by an admission limit`;
        console.log(`[room-server] ! ${peerId.slice(0, 8)} ${what} in "${roomId}" (${res.rejected})`);
      }
      broadcast(roomId, res.broadcast);
    }
    else if (msg.type === MSG.INPUT) {
      const { direct } = hub.input(roomId, peerId, msg);
      if (direct) sendTo(direct.to, direct.msg);
    }
    else if (msg.type === MSG.WIRE) broadcast(roomId, hub.wire(roomId, peerId, msg).broadcast);
  });

  ws.on('close', () => {
    sockets.delete(peerId);
    const res = hub.disconnect(roomId, peerId);
    broadcast(roomId, res.broadcast);
    // Clear any objects the peer was holding so their ghosts disappear for others.
    for (const msg of res.stateClears || []) broadcast(roomId, { msg, exclude: peerId });
    // M1.4: the host left. Either it migrates straight away (no sid / nobody to
    // reclaim for) …
    if (res.hostChange) broadcast(roomId, { msg: res.hostChange });
    // … or the room is deliberately hostless for the reclaim window, and the
    // longest-present remaining peer only takes over if the old host doesn't come
    // back. Promoting a stand-in immediately is what made every ordinary host
    // game-switch (a cross-core `location.reload()`) briefly promote a client,
    // which then booted the room's cartridge into its own core.
    if (res.hostGraceMs) scheduleHostGrace(roomId, res.hostGraceMs);
    console.log(`[room-server] - ${peerId.slice(0, 8)} ← "${roomId}" (${hub.size(roomId)} left${res.hostChange ? `, host→${res.hostChange.id.slice(0, 8)}` : ''}${res.hostGraceMs ? `, host reclaim window ${res.hostGraceMs}ms` : ''})`);
  });

  ws.on('error', () => { /* close handler does the cleanup */ });
});

// Drop sockets that stop answering pings (tab closed without a clean close), and
// re-check the AGGREGATE outbound budget in the same pass.
//
// The aggregate walk is NOT this timer's job any more (RELAY-1 — a ten-second
// period made the budget an average rather than a ceiling; the send path is
// where it is really enforced now). It stays here as the backstop for the one
// case the send path cannot see: a room that has gone quiet while a stalled
// socket still holds its queue, where no further send ever runs the check.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    // Timestamped as well as flagged: billable() uses it to stop counting a
    // silent socket against its address long before this sweep reaps it.
    ws._pingAt = Date.now();
    ws.ping();
  }
  enforceAggregateBudget('heartbeat');
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

// Reap rooms nobody is in (Hub.disconnect already does this on the normal path —
// this is the safety net so a missed teardown can't retain a room's state map,
// which every future joiner would be sent, for the process's lifetime).
const sweeper = setInterval(() => {
  const { rooms, orphans } = hub.sweepEmptyRooms();
  // Same idea for the per-address upgrade buckets: an entry whose score has
  // fully drained is indistinguishable from no entry at all, and keeping them
  // would retain one record per address that ever connected for the process's
  // lifetime — a slow leak in a key space the attacker chooses.
  const now = Date.now();
  let ips = 0;
  for (const [key, rec] of addrState) {
    // BOTH scores have to be spent before the record may go. Dropping it while
    // the soft-refusal score still stands would hand a flooding address a fresh
    // budget of EXPENSIVE refusals every sweep — the leak this reaps is a slow
    // one, and undoing a live limit to close it would be the worse trade.
    if (drain(rec.churn, rec.churnAt, now, MAX_UPGRADES_PER_IP) <= 0
      && drain(rec.soft, rec.softAt, now, MAX_SOFT_REFUSALS_PER_IP) <= 0) { addrState.delete(key); ips++; }
  }
  if (rooms || orphans || ips) console.log(`[room-server] swept ${rooms} empty room(s), ${orphans} orphan record(s), ${ips} drained address record(s)`);
}, SWEEP_MS);
if (typeof sweeper.unref === 'function') sweeper.unref();
wss.on('close', () => clearInterval(sweeper));

// ---------------------------------------------------------------------------
// Graceful shutdown (CODEX_REVIEW SEC-6)
//
// Before this there was NO SIGTERM/SIGINT handler at all, so `systemctl restart`
// — which `npm run deploy-room` does on every server update — killed the process
// with sockets wide open. Every connected headset saw an abrupt 1006, which is
// indistinguishable from a Wi-Fi drop or a crash, and (because the peer never
// sent a close frame) the room kept its ghost for a heartbeat period.
//
// The drain, in order:
//   1. stop the timers, so nothing new is scheduled while we're leaving;
//   2. wss.close() — stop ACCEPTING, without touching live sockets (`ws` does
//      not close clients for you);
//   3. close every live socket with 1001 "going away" + a reason, so the client
//      knows this was deliberate and its ordinary reconnect backoff applies;
//   4. close the in-process log server (an HTTP listener with keep-alive
//      connections that would otherwise hold the event loop open);
//   5. a forced-exit timer, UNREF'd — it cannot keep the loop alive by itself,
//      so a clean drain exits early and naturally, but if anything is stuck (a
//      peer that never answers the close frame — `ws` would wait 30 s for it —
//      or an open NDJSON write stream in the log server) the process still goes
//      within SHUTDOWN_GRACE_MS instead of hanging the systemd unit forever.
//
// Idempotent: systemd sends SIGTERM and then, if the unit lingers, SIGKILL, but a
// human hitting Ctrl-C twice (or a SIGINT racing a SIGTERM) must not restart the
// drain and re-arm a second forced-exit timer.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) {
    console.log(`[room-server] ${signal} ignored — already shutting down`);
    return;
  }
  shuttingDown = true;
  if (SHUTDOWN_GRACE_MS <= 0) {
    // ROOM_SHUTDOWN_GRACE_MS=0 restores the pre-fix behaviour on purpose: no
    // drain, every peer gets a bare 1006. It is the negative control in
    // scripts/test-room-protocol.mjs — the thing that proves the 1001 the other
    // half of that test observes comes from THIS code and not from `ws` being
    // polite on its own.
    console.log(`[room-server] ${signal} — ROOM_SHUTDOWN_GRACE_MS=0, exiting immediately (${wss.clients.size} socket(s) dropped as 1006)`);
    process.exit(0);
  }
  console.log(`[room-server] ${signal} — draining ${wss.clients.size} socket(s) with 1001, ${SHUTDOWN_GRACE_MS}ms before forced exit`);
  clearInterval(heartbeat);
  clearInterval(sweeper);
  for (const t of graceTimers.values()) clearTimeout(t);
  graceTimers.clear();
  try { wss.close(); } catch { /* never listened */ }
  for (const ws of wss.clients) {
    try { ws.close(1001, 'server restarting'); } catch { /* already gone */ }
  }
  try { logServer.closeAllConnections?.(); logServer.close(); } catch { /* never listened */ }
  const forced = setTimeout(() => {
    console.error(`[room-server] shutdown grace elapsed with ${wss.clients.size} socket(s) still open — forcing exit`);
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
  if (typeof forced.unref === 'function') forced.unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// The banner is printed from the 'listening' EVENT, not at module scope.
//
// It used to be a bare console.log at the end of the file, which runs while the
// bind is still in flight — so "listening on :8787" was printed even when the
// bind then failed with EADDRINUSE and the process exited a tick later. Every
// harness in this repo (scripts/test-room-limits.mjs, scripts/test-room-protocol.mjs)
// waits for exactly that line to decide the server is up, so a port collision
// silently produced a "ready" server that was already dead, and the assertions
// that followed measured whatever else was still listening on that port. Emitting
// it from the event makes the line mean what everyone already reads it as.
wss.on('listening', () => {
  console.log(`[room-server] listening on :${PORT} (bind ${HOST || 'all interfaces'}, rooms by ?room=, default "lobby")`);
  // Print the protocol version the same way the limits are printed: the whole point
  // of COR-9 is that a version skew must be VISIBLE, and the journal is where an
  // operator looks first after a deploy.
  console.log(`[room-server] protocol ${PROTOCOL_VERSION} (same MAJOR = compatible; mismatch closes with ${CLOSE.PROTOCOL}, no version = legacy client, accepted), shutdown grace ${SHUTDOWN_GRACE_MS}ms`);
  console.log(`[room-server] limits: payload ${MAX_PAYLOAD_BYTES}B, ${MAX_PEERS_PER_ROOM} peers/room, ${MAX_ROOMS} rooms, ${MAX_SOCKETS} sockets, ${MSG_RATE_PER_SEC} msg/s (burst ${MSG_BURST}, kill at ${MAX_RATE_KILLS} drops per ${RATE_WINDOW_MS}ms), buffered ${MAX_BUFFERED_BYTES}B/socket + ${MAX_BUFFERED_TOTAL}B total (grace ${BACKPRESSURE_GRACE_MS}ms, aggregate check on send past ${BUFFER_SWEEP_TRIGGER}B every ${BUFFER_SWEEP_MS}ms), origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(' ') : 'any'}`);
  // Per-address caps print separately because the KEY matters as much as the
  // numbers: read as "billed to the socket address" vs "billed to the last
  // X-Forwarded-For hop", an operator can tell at a glance whether the unit is
  // keyed correctly for the proxy in front of it — the difference between a
  // working cap and a site-wide outage.
  console.log(`[room-server] per-address: ${MAX_SOCKETS_PER_IP} sockets, ${MAX_UPGRADES_PER_IP} upgrades per ${UPGRADE_WINDOW_MS}ms, ${MAX_SOFT_REFUSALS_PER_IP} soft refusals per ${UPGRADE_WINDOW_MS}ms, keyed on ${TRUST_PROXY ? 'the last X-Forwarded-For hop (ROOM_TRUST_PROXY set; no header = exempt)' : 'the socket address (X-Forwarded-For ignored)'}`);
  // …and HOW a cap refuses, which is the difference between "come back in a
  // moment" and a deployed headset stuck on "Offline" for the rest of the page's
  // life. Printed because this is the line an operator reads when a user reports
  // the latter.
  console.log(`[room-server] refusals are two-tier: SOFT (upgrade accepted, then closed ${CLOSE.TRY_AGAIN} + reason, ${REFUSAL_GRACE_MS}ms before terminate) so a client retries on its own backoff and knows why — until an address has spent ${MAX_SOFT_REFUSALS_PER_IP} of those per ${UPGRADE_WINDOW_MS}ms or ${MAX_REFUSALS_IN_FLIGHT} are in flight process-wide, after which it is HARD (429, no WebSocket). Only admitted upgrades are charged to the ${MAX_UPGRADES_PER_IP}/window churn budget, so a client stuck in a refusal loop cannot lock out its own household. A disallowed Origin is still refused at the handshake, and a silent socket stops holding its address's slot ${PING_GRACE_MS}ms after a missed ping.`);
  // The aggregate STATE budget is the cap that makes the per-axis ones add up to a
  // number instead of 32 GiB — print it, so a deployment's real ceiling is visible
  // in the journal rather than only in a comment. Worst case = the smallest of
  // (peer x sockets), (room x rooms), total; see server/Hub.js and server/README.md.
  //
  // The unit is ACCOUNTED bytes: serialized characters plus a charge per JSON node
  // (ROOM_STATE_NODE_COST_BYTES). Printing the node charge and the structural caps
  // matters as much as printing the budgets — with the charge set to 0 the budgets
  // are back to counting characters, which an array of empty objects can inflate
  // ~23x, and nothing else in the log would show that.
  console.log(`[room-server] state budget: ${HUB_LIMITS.stateValueBytes}B + ${HUB_LIMITS.stateValueNodes} nodes + depth ${HUB_LIMITS.stateValueDepth} /value, `
    + `${HUB_LIMITS.stateKeysPerPeer} keys + ${HUB_LIMITS.stateBytesPerPeer}B/peer, `
    + `${HUB_LIMITS.stateKeysPerRoom} keys + ${HUB_LIMITS.stateBytesPerRoom}B/room, `
    + `${HUB_LIMITS.stateBytesTotal}B process-wide, ${HUB_LIMITS.stateNodeCostBytes}B charged per JSON node `
    + `(worst case ${Math.round(Math.min(HUB_LIMITS.stateBytesPerPeer * MAX_SOCKETS, HUB_LIMITS.stateBytesPerRoom * MAX_ROOMS, HUB_LIMITS.stateBytesTotal) / 1048576)} MiB of retained STATE)`);
});
