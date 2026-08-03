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
import { Hub } from './Hub.js';
import { decode, encode, MSG } from '../src/net/NetProtocol.js';

const PORT = parseInt(process.env.PORT || '8787', 10);
// Ping sweep. Two missed periods terminate a socket, so this is also how fast an
// UNCLEAN host death (Quest sleeping, Wi-Fi yanked, killed tab) is noticed and the
// host role migrates. 30s meant up to a minute of clients staring at a frozen
// picture while still forwarding input to a peer that was gone; 10s bounds that to
// ~20s, and the clients' own presence TTL (5s) reverts the dead video well before.
const HEARTBEAT_MS = 10000;

const wss = new WebSocketServer({ port: PORT });
const hub = new Hub();
const sockets = new Map(); // peerId -> ws

const roomFromReq = (req) => {
  try { return new URL(req.url, 'http://localhost').searchParams.get('room') || 'lobby'; }
  catch { return 'lobby'; }
};

// M1.4: the client's stable per-tab session id, used only for the host-reclaim
// window (a host that reloads the page gets its role back). Absent → the peer
// simply joins as the most junior member.
const sidFromReq = (req) => {
  try { return new URL(req.url, 'http://localhost').searchParams.get('sid') || null; }
  catch { return null; }
};

function sendTo(peerId, msg) {
  const ws = sockets.get(peerId);
  if (ws && ws.readyState === ws.OPEN) ws.send(encode(msg));
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

  ws.on('message', (data) => {
    const msg = decode(data.toString());
    if (!msg) return;
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
      if (res.rejected) console.log(`[room-server] ! ${peerId.slice(0, 8)} tried to set host-owned "${msg.key}" in "${roomId}" (${res.rejected})`);
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

// Drop sockets that stop answering pings (tab closed without a clean close).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

console.log(`[room-server] listening on :${PORT} (rooms by ?room=, default "lobby")`);
