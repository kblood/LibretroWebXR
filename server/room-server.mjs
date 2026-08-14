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
import './log-server.mjs';
import { randomUUID } from 'node:crypto';
import { Hub, HUB_LIMITS } from './Hub.js';
import { decode, encode, MSG } from '../src/net/NetProtocol.js';

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

// --- Admission control (CLAUDE_REVIEW §4.4, CODEX_REVIEW SEC-3) -------------
//
// This process is PUBLIC (dionysus.dk proxies /ws/ to it and real headsets
// connect over the internet), so it must not be bound to loopback — the caps
// below are the fix instead. Every one is env-tunable and defaults comfortably
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
// heartbeat sweep (which already walks every client) sums bufferedAmount and
// evicts the most-backed-up sockets until the process total is under this.
const MAX_BUFFERED_TOTAL = envInt('ROOM_MAX_BUFFERED_TOTAL_BYTES', 32 * 1024 * 1024);
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
const CLOSE = { RATE: 4008, BACKPRESSURE: 4009 };
// Ping sweep. Two missed periods terminate a socket, so this is also how fast an
// UNCLEAN host death (Quest sleeping, Wi-Fi yanked, killed tab) is noticed and the
// host role migrates. 30s meant up to a minute of clients staring at a frozen
// picture while still forwarding input to a peer that was gone; 10s bounds that to
// ~20s, and the clients' own presence TTL (5s) reverts the dead video well before.
// Env-tunable so scripts/test-room-limits.mjs can exercise the sweep (which also
// enforces the AGGREGATE outbound budget) without a 10 s wait per assertion.
const HEARTBEAT_MS = envInt('ROOM_HEARTBEAT_MS', 10000);

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
 * Handshake-time admission (runs BEFORE a peer exists, so a refused client never
 * shows up in a roster or a HELLO). Refusals are HTTP status codes on the
 * upgrade, which is what a browser/`ws` client surfaces as a connection error.
 */
function verifyClient({ origin, req }, cb) {
  if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
    console.log(`[room-server] x upgrade refused: origin "${origin}" not allowed`);
    return cb(false, 403, 'Forbidden origin');
  }
  if (wss.clients.size >= MAX_SOCKETS) {
    console.log(`[room-server] x upgrade refused: server at capacity (${wss.clients.size}/${MAX_SOCKETS} sockets)`);
    return cb(false, 503, 'Server at capacity');
  }
  const roomId = roomFromReq(req);
  if (!hub.rooms.has(roomId) && hub.roomCount() >= MAX_ROOMS) {
    console.log(`[room-server] x upgrade refused: too many rooms (${hub.roomCount()}/${MAX_ROOMS}), "${roomId}" would be new`);
    return cb(false, 503, 'Too many rooms');
  }
  if (hub.size(roomId) >= MAX_PEERS_PER_ROOM) {
    console.log(`[room-server] x upgrade refused: room "${roomId}" full (${hub.size(roomId)}/${MAX_PEERS_PER_ROOM})`);
    return cb(false, 429, 'Room full');
  }
  return cb(true);
}

const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_PAYLOAD_BYTES, verifyClient });

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
  const roomId = roomFromReq(req);
  const peerId = randomUUID();
  ws._peerId = peerId;
  ws._roomId = roomId;
  ws.isAlive = true;
  sockets.set(peerId, ws);

  const { hello, state, hostBroadcast } = hub.connect(roomId, peerId, { sid: sidFromReq(req) });
  ws.send(encode(hello));
  // M0.5: replay the room's current shared object state so a late joiner
  // converges (adopts the host's room layout, sees which game is on the TV).
  for (const msg of state || []) ws.send(encode(msg));
  // M1.4: a returning host reclaimed the role inside the grace window — tell the
  // peer that was holding it in the meantime.
  if (hostBroadcast) broadcast(roomId, { msg: hostBroadcast, exclude: peerId });
  console.log(`[room-server] + ${peerId.slice(0, 8)} → "${roomId}" (${hub.size(roomId)} in room, host=${String(hub.hostOf(roomId)).slice(0, 8)})`);

  ws.on('pong', () => { ws.isAlive = true; });

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
    if (msg.type === MSG.JOIN) broadcast(roomId, hub.identify(roomId, peerId, msg).broadcast);
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
// enforce the AGGREGATE outbound budget in the same pass.
//
// sendTo()'s per-socket check bounds one socket at MAX_BUFFERED_BYTES; with 256
// sockets that is still 1 GiB of queued frames, which is exactly the "each cap is
// fine, nobody multiplied them" mistake the STATE budgets fix. This walk is
// already O(clients) once per HEARTBEAT_MS, so summing bufferedAmount here is
// free, and evicting the biggest offenders first keeps the process total bounded
// without punishing a room full of healthy peers.
const heartbeat = setInterval(() => {
  const live = [];
  let totalBuffered = 0;
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
    // A socket already evicted (readyState CLOSING) is still holding its queue
    // until its grace timer fires, so it COUNTS toward the total — but it is not
    // an eviction candidate again.
    totalBuffered += ws.bufferedAmount;
    if (ws.readyState === ws.OPEN) live.push(ws);
  }
  if (totalBuffered <= MAX_BUFFERED_TOTAL) return;
  console.log(`[room-server] ! aggregate backpressure: ${totalBuffered} bytes queued across ${wss.clients.size} sockets > ${MAX_BUFFERED_TOTAL} (${live.length} evictable)`);
  live.sort((a, b) => b.bufferedAmount - a.bufferedAmount);
  for (const ws of live) {
    if (totalBuffered <= MAX_BUFFERED_TOTAL) break;
    totalBuffered -= ws.bufferedAmount;
    evictSlow(ws, ws._peerId, `${ws.bufferedAmount} bytes buffered, server total over ${MAX_BUFFERED_TOTAL}`);
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

// Reap rooms nobody is in (Hub.disconnect already does this on the normal path —
// this is the safety net so a missed teardown can't retain a room's state map,
// which every future joiner would be sent, for the process's lifetime).
const sweeper = setInterval(() => {
  const { rooms, orphans } = hub.sweepEmptyRooms();
  if (rooms || orphans) console.log(`[room-server] swept ${rooms} empty room(s), ${orphans} orphan record(s)`);
}, SWEEP_MS);
if (typeof sweeper.unref === 'function') sweeper.unref();
wss.on('close', () => clearInterval(sweeper));

console.log(`[room-server] listening on :${PORT} (rooms by ?room=, default "lobby")`);
console.log(`[room-server] limits: payload ${MAX_PAYLOAD_BYTES}B, ${MAX_PEERS_PER_ROOM} peers/room, ${MAX_ROOMS} rooms, ${MAX_SOCKETS} sockets, ${MSG_RATE_PER_SEC} msg/s (burst ${MSG_BURST}, kill at ${MAX_RATE_KILLS} drops per ${RATE_WINDOW_MS}ms), buffered ${MAX_BUFFERED_BYTES}B/socket + ${MAX_BUFFERED_TOTAL}B total (grace ${BACKPRESSURE_GRACE_MS}ms), origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(' ') : 'any'}`);
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
