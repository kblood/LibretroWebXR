// dummy-player.mjs — headless "dummy player" that joins a multiplayer room and
// logs everything it observes. Run from this PC while a developer wears a
// headset to confirm that presence, motion, voice signaling, game input,
// room-object/core sync, and held-object events are actually flowing.
//
// Usage:
//   node scripts/dummy-player.mjs --session=<room> [options]
//
// Options:
//   --session=<id>     Room/session id to join (required)
//   --url=<ws url>     WebSocket server URL (default: wss://dionysus.dk/ws/)
//   --nick=<name>      Avatar nickname (default: dummy)
//   --color=<hex>      Avatar colour (default: #ffaa33)
//   --move             Emit a slow sine/orbit pose every ~2 s so the headset
//                      user can SEE the dummy avatar move in the room
//
// The script:
//   1. Connects to the room server and sends a JOIN handshake
//   2. If --move, orbits the dummy's head/hands on a slow sine path at ~0.5 Hz
//   3. Logs EVERY inbound event with a timestamp (peer join/leave, pose delta,
//      STATE changes, SIGNAL signaling, INPUT, held-object changes)
//   4. Prints a heartbeat summary every 10 s (peers currently in the room)
//   5. Shuts down cleanly on Ctrl-C (socket close — no explicit LEAVE msg in M0)
//
// Protocol note: M0 has no LEAVE message FROM a client; the server detects
// a clean close (ws.close()) and broadcasts the LEAVE to others automatically.
// So shutting the socket is the correct leave gesture.

import { WebSocket } from 'ws';
import {
  makeJoin, makePose,
  encode, decode,
  MSG,
} from '../src/net/NetProtocol.js';
import { PresenceState } from '../src/net/PresenceState.js';
import { RoomObjects } from '../src/net/RoomObjects.js';
import { isHoldKey } from '../src/net/HoldState.js';

// ---------------------------------------------------------------------------
// CLI args  (--key or --key=value, no external dep)
// ---------------------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] !== '' ? m[2] : true] : [a, true];
  }),
);

if (!args.session) {
  console.error('Usage: node scripts/dummy-player.mjs --session=<room> [--url=wss://...] [--nick=dummy] [--color=#ffaa33] [--move]');
  process.exit(1);
}

const SESSION  = String(args.session);
const BASE_URL = String(args.url   || 'wss://dionysus.dk/ws/');
const NICK     = String(args.nick  || 'dummy');
const COLOR    = String(args.color || '#ffaa33');
const DO_MOVE  = !!args.move;

// Build the room URL: server expects ?room=<id>
const sep = BASE_URL.includes('?') ? '&' : '?';
const WS_URL = `${BASE_URL}${sep}room=${encodeURIComponent(SESSION)}`;

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------
const ts = () => new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm

function log(...parts)  { console.log(`[${ts()}]`, ...parts); }
function info(...parts) { console.log(`[${ts()}] ▶`, ...parts); }  // ▶
function warn(...parts) { console.warn(`[${ts()}] !`, ...parts); }

// ---------------------------------------------------------------------------
// State registries  (pure, from src/net/)
// ---------------------------------------------------------------------------
const presence = new PresenceState({ ttlMs: 15000 });
const objects  = new RoomObjects();

// ---------------------------------------------------------------------------
// Motion: slow sine orbit for the dummy's head and hands
// ---------------------------------------------------------------------------
const MOTION_PERIOD_S = 6; // full orbit in 6 s → one slow circle
const POSE_INTERVAL_MS = 500; // emit pose every 500 ms when --move

function orbitPose(tMs) {
  const t = (tMs / 1000) * (2 * Math.PI / MOTION_PERIOD_S);
  const r = 0.8; // radius in metres
  const head = [
    Math.cos(t) * r,
    1.6 + Math.sin(t * 0.3) * 0.05, // slight head bob
    Math.sin(t) * r,
    0, Math.sin(t / 2) * 0.1, 0, Math.cos(t / 2) * 0.1 + 0.9, // rough yaw
  ];
  const left  = [head[0] - 0.3, head[1] - 0.3, head[2], 0, 0, 0, 1];
  const right = [head[0] + 0.3, head[1] - 0.3, head[2], 0, 0, 0, 1];
  return makePose({ head, left, right });
}

// A static stand-still pose (hands at sides of a standing head)
function staticPose() {
  return makePose({
    head:  [0, 1.6, 0, 0, 0, 0, 1],
    left:  [-0.25, 1.2, 0.1, 0, 0, 0, 1],
    right: [ 0.25, 1.2, 0.1, 0, 0, 0, 1],
  });
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
function handleMessage(raw) {
  const msg = decode(raw);
  if (!msg) { warn('ignored unparseable/invalid message'); return; }
  const now = Date.now();

  switch (msg.type) {

    case MSG.HELLO: {
      // Server assigned our id and sent the existing roster.
      presence.apply(msg, now);
      selfId = msg.selfId;
      const peerList = (msg.peers || []).map((p) => `${p.nick}(${p.id.slice(0,6)})`).join(', ') || '(none)';
      info(`HELLO  selfId=${selfId.slice(0,8)}  room="${msg.room ?? SESSION}"  peers=[${peerList}]`);
      break;
    }

    case MSG.JOIN: {
      presence.apply(msg, now);
      log(`JOIN   peer ${msg.id?.slice(0,8) ?? '?'}  nick="${msg.nick}"  color=${msg.color}`);
      break;
    }

    case MSG.LEAVE: {
      const gone = presence.get(msg.id);
      presence.apply(msg, now);
      log(`LEAVE  peer ${msg.id?.slice(0,8) ?? '?'}` + (gone ? `  (was "${gone.nick}")` : ''));
      break;
    }

    case MSG.POSE: {
      const prev = presence.get(msg.id);
      presence.apply(msg, now);
      const peer = presence.get(msg.id);
      const nick = peer?.nick ?? msg.id?.slice(0,8) ?? '?';
      // Summarise head position if present
      const h = msg.head;
      const headStr = h ? `head=[${h[0].toFixed(2)},${h[1].toFixed(2)},${h[2].toFixed(2)}]` : 'head=null';
      const handsStr = (msg.left || msg.right)
        ? ` L=${msg.left ? 'ok' : 'null'} R=${msg.right ? 'ok' : 'null'}`
        : ' no-hands';
      log(`POSE   ${nick}(${msg.id?.slice(0,8) ?? '?'})  ${headStr}${handsStr}`);
      break;
    }

    case MSG.STATE: {
      const result = objects.apply(msg);
      if (!result) break;
      const { key, value, id, changed } = result;
      const setter = id ? id.slice(0,8) : 'server';

      if (key === 'tv') {
        // Most important: a game was booted/cleared on the shared TV
        if (value) {
          info(`STATE  core-synced  setter=${setter}  title="${value.title ?? '?'}"  core=${value.core ?? '?'}  system=${value.system ?? '?'}  file="${value.file ?? '?'}"`);
        } else {
          info(`STATE  tv cleared  (setter=${setter})`);
        }
      } else if (isHoldKey(key)) {
        // Held-object change
        if (value) {
          log(`STATE  held-object  key="${key}"  holder=${value.holder?.slice(0,8) ?? '?'}  hand=${value.hand ?? '?'}  setter=${setter}`);
        } else {
          log(`STATE  held-object released  key="${key}"  setter=${setter}`);
        }
      } else {
        // Generic shared key
        log(`STATE  key="${key}"  value=${JSON.stringify(value)}  setter=${setter}${changed ? '' : '  (no-change)'}`);
      }
      break;
    }

    case MSG.SIGNAL: {
      // Voice/video WebRTC signaling — we don't negotiate real WebRTC, just report it
      const channel = msg.channel ?? 'voice';
      const from    = msg.from ? msg.from.slice(0,8) : '?';
      const to      = msg.to  ? msg.to.slice(0,8)   : '?';
      log(`SIGNAL channel=${channel}  kind=${msg.kind}  from=${from}→to=${to}`);
      break;
    }

    case MSG.INPUT: {
      // Remote game input — directed to us if we were the host
      const from   = msg.from ? msg.from.slice(0,8) : '?';
      const action = msg.down ? 'press' : 'release';
      log(`INPUT  from=${from}  player=${msg.player}  btn=${msg.btn}  ${action}`);
      break;
    }

    default:
      warn(`unknown message type: ${msg.type}`);
  }
}

// ---------------------------------------------------------------------------
// Heartbeat summary
// ---------------------------------------------------------------------------
const HEARTBEAT_INTERVAL_MS = 10_000;

function printHeartbeat() {
  const peers = presence.peers();
  if (peers.length === 0) {
    log(`HEARTBEAT  no other peers in room "${SESSION}"`);
  } else {
    const names = peers.map((p) => `${p.nick}(${p.id.slice(0,6)})`).join(', ');
    log(`HEARTBEAT  ${peers.length} peer(s): ${names}`);
  }
  // Also prune stale peers (in case a LEAVE was missed)
  const pruned = presence.prune(Date.now());
  if (pruned.length) log(`HEARTBEAT  pruned ${pruned.length} stale peer(s): ${pruned.map((id) => id.slice(0,8)).join(', ')}`);

  // Summarise room objects if any
  const entries = objects.entries();
  if (entries.length) {
    for (const [k, v] of entries) {
      if (k === 'tv') {
        log(`HEARTBEAT  tv: "${v?.title ?? '?'}" (${v?.system ?? '?'}/${v?.core ?? '?'})`);
      } else if (isHoldKey(k)) {
        log(`HEARTBEAT  ${k}: holder=${v?.holder?.slice(0,8) ?? '?'} hand=${v?.hand ?? '?'}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Connect + run
// ---------------------------------------------------------------------------
let selfId = '(pending)';
let ws;
let poseTimer   = null;
let hbTimer     = null;
let shuttingDown = false;

function connect() {
  console.log('');
  console.log('='.repeat(60));
  console.log(' LibretroWebXR dummy player');
  console.log(`  url:     ${WS_URL}`);
  console.log(`  session: ${SESSION}`);
  console.log(`  nick:    ${NICK}  color: ${COLOR}`);
  console.log(`  motion:  ${DO_MOVE ? 'enabled (--move)' : 'static'}`);
  console.log('='.repeat(60));
  console.log('');

  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    info(`connected to ${WS_URL}`);

    // Send JOIN to announce our identity (server already added us to the room
    // on connect; this sets our nick/color so others see it in the roster).
    ws.send(encode(makeJoin({ nick: NICK, color: COLOR })));
    info(`sent JOIN  nick="${NICK}"  color="${COLOR}"`);

    // Send an initial pose so our avatar appears immediately
    ws.send(encode(staticPose()));
    info(`sent initial POSE (standing)`);

    // If --move, start the slow orbit loop
    if (DO_MOVE) {
      const startMs = Date.now();
      poseTimer = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
          ws.send(encode(orbitPose(Date.now() - startMs)));
        }
      }, POSE_INTERVAL_MS);
      info(`motion enabled — emitting pose every ${POSE_INTERVAL_MS} ms`);
    }

    // Heartbeat summary every 10 s
    hbTimer = setInterval(printHeartbeat, HEARTBEAT_INTERVAL_MS);

    info('listening for events… (Ctrl-C to quit)');
    console.log('');
  });

  ws.on('message', (data) => {
    try { handleMessage(data.toString()); }
    catch (e) { warn('handler error:', e.message); }
  });

  ws.on('close', (code, reason) => {
    clearInterval(poseTimer);
    clearInterval(hbTimer);
    const reasonStr = reason ? reason.toString() : '';
    if (shuttingDown) {
      info(`disconnected cleanly  code=${code}`);
    } else {
      warn(`connection closed unexpectedly  code=${code}  reason="${reasonStr}"`);
    }
  });

  ws.on('error', (err) => {
    warn(`WebSocket error: ${err.message}`);
  });
}

// ---------------------------------------------------------------------------
// Clean shutdown (Ctrl-C)
// ---------------------------------------------------------------------------
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(poseTimer);
  clearInterval(hbTimer);
  console.log('');
  info('shutting down (Ctrl-C)…');
  // Closing the socket is the M0 "leave" gesture — server will broadcast LEAVE
  // to remaining peers on the clean close.
  if (ws && ws.readyState === ws.OPEN) {
    ws.close(1000, 'dummy-player quit');
  } else {
    process.exit(0);
  }
  // Give the close a moment to flush, then exit
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------
connect();
