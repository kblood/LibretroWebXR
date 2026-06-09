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

import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { Hub } from './Hub.js';
import { decode, encode, MSG } from '../src/net/NetProtocol.js';

const PORT = parseInt(process.env.PORT || '8787', 10);
const HEARTBEAT_MS = 30000;

const wss = new WebSocketServer({ port: PORT });
const hub = new Hub();
const sockets = new Map(); // peerId -> ws

const roomFromReq = (req) => {
  try { return new URL(req.url, 'http://localhost').searchParams.get('room') || 'lobby'; }
  catch { return 'lobby'; }
};

function sendTo(peerId, msg) {
  const ws = sockets.get(peerId);
  if (ws && ws.readyState === ws.OPEN) ws.send(encode(msg));
}

function broadcast(roomId, { msg, exclude } = {}) {
  if (!msg) return;
  for (const pid of hub.peerIds(roomId)) if (pid !== exclude) sendTo(pid, msg);
}

wss.on('connection', (ws, req) => {
  const roomId = roomFromReq(req);
  const peerId = randomUUID();
  ws._peerId = peerId;
  ws._roomId = roomId;
  ws.isAlive = true;
  sockets.set(peerId, ws);

  const { hello, state } = hub.connect(roomId, peerId);
  ws.send(encode(hello));
  // M0.5: replay the room's current shared object state so a late joiner
  // converges (e.g. boots the game already on the TV).
  for (const msg of state || []) ws.send(encode(msg));
  console.log(`[room-server] + ${peerId.slice(0, 8)} → "${roomId}" (${hub.size(roomId)} in room)`);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    const msg = decode(data.toString());
    if (!msg) return;
    if (msg.type === MSG.JOIN) broadcast(roomId, hub.identify(roomId, peerId, msg).broadcast);
    else if (msg.type === MSG.POSE) broadcast(roomId, hub.pose(roomId, peerId, msg).broadcast);
    else if (msg.type === MSG.SIGNAL) {
      const { direct } = hub.signal(roomId, peerId, msg);
      if (direct) sendTo(direct.to, direct.msg);
    } else if (msg.type === MSG.STATE) broadcast(roomId, hub.setState(roomId, peerId, msg).broadcast);
  });

  ws.on('close', () => {
    sockets.delete(peerId);
    const res = hub.disconnect(roomId, peerId);
    broadcast(roomId, res.broadcast);
    // Clear any objects the peer was holding so their ghosts disappear for others.
    for (const msg of res.stateClears || []) broadcast(roomId, { msg, exclude: peerId });
    console.log(`[room-server] - ${peerId.slice(0, 8)} ← "${roomId}" (${hub.size(roomId)} left)`);
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
