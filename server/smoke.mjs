// End-to-end smoke test for the room server: spins up the real room-server.mjs,
// connects two WebSocket clients to the same room, and asserts the relay does
// what M0 needs — roster on connect (HELLO), JOIN relayed to existing peers, and
// POSE relayed with the sender's server-stamped id. Lives in server/ so it
// resolves `ws` from server/node_modules.
//
//   cd server && node smoke.mjs        (exit 0 = relay works)

import { WebSocket } from 'ws';
import { encode, decode, makeJoin, makePose, MSG } from '../src/net/NetProtocol.js';

const PORT = 8799;
process.env.PORT = String(PORT);
await import('./room-server.mjs'); // starts listening on PORT

const URL = `ws://localhost:${PORT}/?room=smoke`;
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.error(`  FAIL: ${m}`); } };
const HEAD = [1, 1.6, -2, 0, 0, 0, 1];

// A client that records every decoded message and lets us await specific ones.
function client(name) {
  const ws = new WebSocket(URL);
  const msgs = [];
  const waiters = [];
  ws.on('message', (data) => {
    const m = decode(data.toString());
    if (!m) return;
    msgs.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) { waiters[i].resolve(m); waiters.splice(i, 1); }
    }
  });
  return {
    ws, name, msgs, selfId: null,
    open: () => new Promise((r) => ws.once('open', r)),
    send: (m) => ws.send(encode(m)),
    waitFor: (pred, ms = 1500) => new Promise((resolve, reject) => {
      const hit = msgs.find(pred);
      if (hit) return resolve(hit);
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`${name}: timeout waiting`)); } }, ms);
    }),
  };
}

try {
  const a = client('A');
  await a.open();
  const aHello = await a.waitFor((m) => m.type === MSG.HELLO);
  a.selfId = aHello.selfId;
  ok(aHello.peers.length === 0, 'A connects to an empty room (HELLO roster empty)');
  a.send(makeJoin({ nick: 'Alice', color: '#0f0' }));

  const b = client('B');
  await b.open();
  const bHello = await b.waitFor((m) => m.type === MSG.HELLO);
  b.selfId = bHello.selfId;
  ok(bHello.peers.some((p) => p.id === a.selfId && p.nick === 'Alice'),
    'B sees Alice in its HELLO roster');
  b.send(makeJoin({ nick: 'Bob', color: '#00f' }));

  // A should be told that Bob joined.
  const joinAtA = await a.waitFor((m) => m.type === MSG.JOIN && m.nick === 'Bob');
  ok(joinAtA.id === b.selfId, 'A receives a JOIN for Bob stamped with B\'s id');

  // A moves → B should receive A's pose, id-stamped, not echoed back to A.
  a.send(makePose({ head: HEAD }));
  const poseAtB = await b.waitFor((m) => m.type === MSG.POSE);
  ok(poseAtB.id === a.selfId, 'B receives A\'s POSE stamped with A\'s id');
  ok(poseAtB.head[1] === HEAD[1], 'POSE payload survives the relay');

  await new Promise((r) => setTimeout(r, 150));
  ok(!a.msgs.some((m) => m.type === MSG.POSE), 'A does not receive its own POSE back');

  // B leaves → A should be told.
  b.ws.close();
  const leaveAtA = await a.waitFor((m) => m.type === MSG.LEAVE && m.id === b.selfId);
  ok(!!leaveAtA, 'A receives a LEAVE when B disconnects');

  a.ws.close();
} catch (e) {
  failed++;
  console.error('  FAIL:', e.message);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
