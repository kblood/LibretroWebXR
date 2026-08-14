// Signal-path contract test (M0.4 voice + M1.2 video teardown).
//
// WHY THIS FILE EXISTS
// --------------------
// VideoMgr.stopBroadcast() has always sent `{ kind:'bye' }` to every client so
// the picture reverts immediately instead of hanging until ICE consent expires
// (~30 s). But 'bye' was never in NetProtocol.SIGNAL_KINDS, so validate()
// rejected it — at BOTH ends: the client's own encode()/decode() and the room
// server's decode() in room-server.mjs. The message never crossed the wire and
// VideoMgr's bye handler was unreachable dead code (CLAUDE_REVIEW §5.2 / CODEX
// COR-1). Nothing in the suite noticed, because nothing round-tripped the kinds.
//
// So this test round-trips EVERY signal kind through the real validator, then
// through a REAL room server on :8894 with two real ws clients, and asserts each
// one is both accepted and delivered — with negative controls that a bogus kind
// is still rejected end to end (so the fix can't degenerate into "accept
// anything") and that the never-executed bye handler behaves under a stale epoch
// and a forged bye from a receiving peer.
//
// AND THEN (section 6) it drives the REAL managers. Making 'bye' a valid kind
// was not enough: NetMgr/DesktopNet.disconnect() closed the socket and cleared
// `_connected` BEFORE tearing the video down, and the send closure they hand
// VideoMgr is gated on exactly that pair — so leaving a room emitted zero byes
// while a VideoMgr-level test built with `send: (m) => sent.push(m)` reported a
// clean pass. That shim-passes/real-path-broken shape is a documented failure
// mode in this repo (docs/HANDOFF.md, the P0-1 RuntimeEmulatorClient facade), so
// the teardown assertions now measure what a REAL second client receives over a
// REAL socket, and the "connection lost" path is asserted to stay silent.
//
// Run:  node scripts/test-net-signal.mjs
// Ports: 8894 (room server) + 8895 (its log-server companion). Nothing else.
// Flags: --no-server  skip the live room-server section (pure checks only)

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  MSG, SIGNAL_KINDS, makeSignal, makeJoin, validate, encode, decode,
} from '../src/net/NetProtocol.js';
import { Hub } from '../server/Hub.js';
import { VideoMgr } from '../src/net/VideoMgr.js';
import { VoiceMgr } from '../src/net/VoiceMgr.js';
import { NetMgr } from '../src/net/NetMgr.js';
import { DesktopNet } from '../src/desktop/DesktopNet.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8894;
const LOG_PORT = 8895;
const ROOM = 'signaltest';
const LIVE = !process.argv.includes('--no-server');

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll a predicate instead of sleeping a magic number (bounded, so a hang fails
// the assertion rather than the run).
const untilTrue = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fn()) return true; } catch { /* not ready */ }
    await sleep(20);
  }
  return false;
};

// ---------------------------------------------------------------------------
// Minimal browser/WebRTC fakes: only what VideoMgr + AvatarMgr actually touch.
// Module-scope because BOTH the pure section 4 and the real-path section 6 (a
// real NetMgr talking to a real room server) need them.
// ---------------------------------------------------------------------------
class FakeTrack {
  constructor(kind, id) { this.kind = kind; this.id = id; this.readyState = 'live'; this._l = {}; }
  stop() { this.readyState = 'ended'; }
  addEventListener(ev, fn) { (this._l[ev] ||= []).push(fn); }
  fire(ev) { for (const fn of this._l[ev] || []) fn(); }
}
class FakeStream {
  constructor(tracks = []) { this._t = [...tracks]; }
  getTracks() { return [...this._t]; }
  getVideoTracks() { return this._t.filter((t) => t.kind === 'video'); }
  getAudioTracks() { return this._t.filter((t) => t.kind === 'audio'); }
  addTrack(t) { if (!this._t.includes(t)) this._t.push(t); }
  removeTrack(t) { this._t = this._t.filter((x) => x !== t); }
}
class FakePC {
  constructor() {
    this.closed = false; this.connectionState = 'new'; this.iceConnectionState = 'new';
    this.senders = []; this.remote = null; this.local = null;
  }
  async createOffer() { return { type: 'offer', sdp: 'offer-sdp' }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; }
  async setLocalDescription(d) { if (this.closed) throw new Error('closed'); this.local = d; }
  async setRemoteDescription(d) { if (this.closed) throw new Error('closed'); this.remote = d; }
  async addIceCandidate(c) { if (this.closed) throw new Error('closed'); this.ice = c; }
  addTrack(track) {
    const s = { track, replaceTrack: async (t) => { s.track = t; } };
    this.senders.push(s);
    // Real PCs never fire negotiationneeded once closed.
    queueMicrotask(() => { if (!this.closed && this.onnegotiationneeded) this.onnegotiationneeded(); });
    return s;
  }
  getSenders() { return this.senders; }
  close() { this.closed = true; }
}
// A 2D context whose every method is a no-op and whose every property is
// writable — enough for Avatar's nameplate (AvatarMgr runs for real inside
// NetMgr.tick(), and faking AvatarMgr instead would hollow out the path).
const fakeCtx = new Proxy({}, { get: () => () => {}, set: () => true });
function installBrowserFakes() {
  globalThis.RTCPeerConnection = FakePC;
  globalThis.MediaStream = FakeStream;
  globalThis.document = {
    createElement: (tag) => (String(tag).toLowerCase() === 'canvas'
      ? { width: 0, height: 0, getContext: () => fakeCtx }
      : { play: () => Promise.resolve(), srcObject: null }),
  };
}

// The channel each kind legitimately travels on. 'bye' is video-only by design:
// VoiceMgr has no bye branch, and its fallthrough would _ensurePeer() a peer
// connection for anyone who sent one — widening the kinds must not widen that.
const CHANNEL_FOR = { offer: 'video', answer: 'video', ice: 'video', bye: 'video' };
// Iterate over what the contract MUST carry, not over SIGNAL_KINDS itself —
// looping over the list under test would make a dropped kind silently shrink the
// test instead of failing it (exactly how 'bye' went unnoticed).
const EXPECTED_KINDS = ['offer', 'answer', 'ice', 'bye'];
const DATA_FOR = {
  offer: { type: 'offer', sdp: 'v=0\r\n', epoch: 3 },
  answer: { type: 'answer', sdp: 'v=0\r\n' },
  ice: { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
  bye: { epoch: 3 },
};

// ===========================================================================
// 1. The regression sentinel + the validator round-trip, per kind
// ===========================================================================
console.log('== validator round-trip ==');
{
  // This single line is what would have caught the shipped bug.
  ok(SIGNAL_KINDS.includes('bye'), "SIGNAL_KINDS carries 'bye' (video teardown)");
  ok(SIGNAL_KINDS.includes('offer') && SIGNAL_KINDS.includes('answer') && SIGNAL_KINDS.includes('ice'),
    'SIGNAL_KINDS still carries offer/answer/ice');

  ok(SIGNAL_KINDS.length === EXPECTED_KINDS.length && EXPECTED_KINDS.every((k) => SIGNAL_KINDS.includes(k)),
    `SIGNAL_KINDS is exactly ${JSON.stringify(EXPECTED_KINDS)} (got ${JSON.stringify([...SIGNAL_KINDS])})`);

  for (const kind of EXPECTED_KINDS) {
    const data = DATA_FOR[kind];
    ok(data != null, `test covers every declared kind (missing fixture for '${kind}')`);
    const msg = makeSignal({ to: 'peer-b', kind, data, channel: CHANNEL_FOR[kind] });
    const v = validate(msg);
    ok(v.ok, `validate accepts kind '${kind}' (${v.error || ''})`);
    const round = decode(encode(msg));
    ok(round !== null, `encode→decode survives kind '${kind}'`);
    ok(round && round.kind === kind, `kind '${kind}' preserved across the wire`);
    ok(round && round.channel === CHANNEL_FOR[kind], `channel preserved for kind '${kind}'`);
    ok(round && JSON.stringify(round.data) === JSON.stringify(data), `data preserved verbatim for '${kind}'`);
  }

  // The negotiation kinds must still work on the voice mesh (default channel).
  for (const kind of ['offer', 'answer', 'ice']) {
    ok(validate(makeSignal({ to: 'b', kind, data: DATA_FOR[kind] })).ok, `'${kind}' still valid with no channel (voice)`);
    ok(validate(makeSignal({ to: 'b', kind, data: DATA_FOR[kind], channel: 'voice' })).ok, `'${kind}' still valid on channel 'voice'`);
  }
}

// ===========================================================================
// 2. NEGATIVE CONTROLS — over-permissiveness must still be rejected
// ===========================================================================
console.log('== negative controls ==');
{
  const bogus = ['byebye', 'BYE', ' bye', 'bye ', 'goodbye', 'close', 'hangup', '', 'offer2', 'candidate'];
  for (const kind of bogus) {
    const msg = { type: MSG.SIGNAL, to: 'b', kind, data: {}, channel: 'video' };
    ok(!validate(msg).ok, `bogus kind ${JSON.stringify(kind)} rejected`);
    ok(decode(encode(msg)) === null, `bogus kind ${JSON.stringify(kind)} does not survive decode`);
  }
  for (const kind of [null, undefined, 42, {}, ['bye']]) {
    ok(!validate({ type: MSG.SIGNAL, to: 'b', kind, data: {}, channel: 'video' }).ok,
      `non-string kind ${JSON.stringify(kind) ?? String(kind)} rejected`);
  }
  // 'bye' is video-only.
  ok(!validate({ type: MSG.SIGNAL, to: 'b', kind: 'bye', data: { epoch: 1 } }).ok, "'bye' with no channel rejected (voice default)");
  ok(!validate({ type: MSG.SIGNAL, to: 'b', kind: 'bye', data: { epoch: 1 }, channel: 'voice' }).ok, "'bye' on channel 'voice' rejected");
  ok(!validate({ type: MSG.SIGNAL, to: 'b', kind: 'bye', data: { epoch: 1 }, channel: 'chat' }).ok, "'bye' on an unknown channel rejected");
  // The rest of the SIGNAL contract is unchanged.
  ok(!validate({ type: MSG.SIGNAL, kind: 'bye', data: {}, channel: 'video' }).ok, "'bye' without a `to` rejected");
  ok(!validate({ type: MSG.SIGNAL, to: 'b', kind: 'bye', data: null, channel: 'video' }).ok, "'bye' with null data rejected");
  ok(!validate({ type: MSG.SIGNAL, to: 'b', kind: 'bye', data: 'epoch', channel: 'video' }).ok, "'bye' with non-object data rejected");
}

// ===========================================================================
// 3. Hub relay (pure): every kind is relayed directly + `from`-stamped
// ===========================================================================
console.log('== hub relay (pure) ==');
{
  const hub = new Hub();
  hub.connect(ROOM, 'A', {});
  hub.connect(ROOM, 'B', {});
  for (const kind of EXPECTED_KINDS) {
    const msg = makeSignal({ to: 'B', kind, data: DATA_FOR[kind], channel: CHANNEL_FOR[kind] });
    const { direct } = hub.signal(ROOM, 'A', msg);
    ok(!!direct && direct.to === 'B', `hub relays '${kind}' to the addressed peer`);
    ok(direct?.msg?.from === 'A', `hub stamps the real sender on '${kind}'`);
    ok(direct?.msg?.kind === kind, `hub does not mangle kind '${kind}'`);
  }
  // Negative control: an unknown peer is dropped, not relayed.
  ok(!hub.signal(ROOM, 'A', makeSignal({ to: 'nobody', kind: 'bye', data: { epoch: 1 }, channel: 'video' })).direct,
    'hub drops a bye addressed to a peer that is not in the room');
}

// ===========================================================================
// 4. The VideoMgr bye handler — code that had NEVER executed
// ===========================================================================
console.log('== VideoMgr bye handler (fake WebRTC) ==');
{
  installBrowserFakes();

  const makeClient = () => {
    const sent = []; const ended = []; const shown = [];
    const mgr = new VideoMgr({
      send: (m) => sent.push(m),
      getSelfId: () => 'C1',
      onHostVideo: (el, id) => shown.push(id),
      onHostVideoEnded: (id) => ended.push(id),
    });
    return { mgr, sent, ended, shown };
  };
  // Drive a client to the "receiving the host's picture" state.
  const receiveFrom = async (mgr, host, epoch) => {
    await mgr.handleSignal({ from: host, kind: 'offer', channel: 'video', data: { type: 'offer', sdp: 's', epoch } });
    const entry = mgr._pcs.get(host);
    const track = new FakeTrack('video', `v${epoch}`);
    entry.pc.ontrack({ track, streams: [new FakeStream([track])] });
    return entry;
  };

  // --- happy path: a bye that matches the live connection tears it down -----
  {
    const { mgr, ended } = makeClient();
    mgr.update({ peerIds: ['H', 'C1'], selfId: 'C1', hostId: 'H' });
    const entry = await receiveFrom(mgr, 'H', 3);
    ok(mgr.debugApi().receivingCount() === 1, 'client is receiving the host picture before the bye');
    await mgr.handleSignal({ from: 'H', kind: 'bye', channel: 'video', data: { epoch: 3 } });
    ok(ended.length === 1 && ended[0] === 'H', 'bye fires onHostVideoEnded → the TV reverts');
    ok(!mgr._pcs.has('H'), 'bye removes the peer entry');
    ok(entry.pc.closed === true, 'bye closes the RTCPeerConnection');
    ok(mgr.debugApi().receivingCount() === 0, 'nothing is reported as receiving after the bye');
    ok(mgr.hostVideoEl() === null, 'no stale host <video> is left behind');
  }

  // --- NEGATIVE CONTROL: a stale-epoch bye must NOT kill a live picture -----
  {
    const { mgr, ended } = makeClient();
    mgr.update({ peerIds: ['H', 'C1'], selfId: 'C1', hostId: 'H' });
    await receiveFrom(mgr, 'H', 3);
    // Host rebuilt its PC → new offer, new epoch. A bye for the OLD epoch is
    // about a connection that no longer exists here.
    await mgr.handleSignal({ from: 'H', kind: 'offer', channel: 'video', data: { type: 'offer', sdp: 's', epoch: 4 } });
    ok(mgr._pcs.get('H')?.remoteEpoch === 4, 'client tracked the new offer epoch');
    // (The epoch-4 offer itself legitimately closes the epoch-3 PC — that's the
    // existing rebuild path. Measure only what the stale BYE adds on top.)
    const endedBeforeBye = ended.length;
    await mgr.handleSignal({ from: 'H', kind: 'bye', channel: 'video', data: { epoch: 3 } });
    ok(mgr._pcs.has('H'), 'a stale-epoch bye is ignored (live connection survives)');
    ok(ended.length === endedBeforeBye, 'a stale-epoch bye does not revert the TV');
    // The current epoch's bye still works.
    await mgr.handleSignal({ from: 'H', kind: 'bye', channel: 'video', data: { epoch: 4 } });
    ok(!mgr._pcs.has('H'), 'the current-epoch bye still tears the connection down');
  }

  // --- NEGATIVE CONTROL: a client cannot bye the HOST's sender PC -----------
  {
    const sent = [];
    const canvas = { id: 'canvas', captureStream: () => new FakeStream([new FakeTrack('video', 'src')]) };
    const host = new VideoMgr({ send: (m) => sent.push(m), getSelfId: () => 'H', getCaptureCanvas: () => canvas });
    ok(host.startBroadcast() === true, 'host captured its canvas');
    host.update({ peerIds: ['H', 'C1'], selfId: 'H', hostId: 'H' });
    ok(host._pcs.get('C1')?.initiator === true, 'host holds a sender PC for the client');
    await host.handleSignal({ from: 'C1', kind: 'bye', channel: 'video', data: { epoch: host._pcs.get('C1').epoch } });
    ok(host._pcs.has('C1'), 'a bye from a CLIENT does not tear down the host sender PC');
    // `?.` on purpose: when this assertion FAILS the entry is gone, and a hard
    // TypeError here would abort the run before the later sections report.
    ok(host._pcs.get('C1')?.pc.closed === false, 'the host sender PC stays open');

    // --- host teardown really emits a bye per client, on the video channel ---
    await sleep(0);   // let the fake PC's negotiationneeded settle first
    sent.length = 0;
    host.stopBroadcast();
    const byes = sent.filter((m) => m.kind === 'bye');
    ok(byes.length === 1 && byes[0].to === 'C1', 'stopBroadcast sends exactly one bye, to the client');
    ok(typeof byes[0]?.data?.epoch === 'number', 'the bye carries the sender epoch');
    // And that emitted message must survive the real validator (the whole bug).
    const wire = makeSignal({ to: byes[0]?.to ?? 'C1', kind: byes[0]?.kind ?? 'bye', data: byes[0]?.data ?? {}, channel: 'video', from: 'H' });
    ok(decode(encode(wire)) !== null, 'the bye VideoMgr actually emits survives encode/decode');
  }

  // --- "connection lost" teardown: local only, no pretend announcement ------
  //
  // NOTE ON WHAT THIS BLOCK IS *NOT*. It used to also assert
  //   host.disable() → exactly one bye
  // against a VideoMgr built with `send: (m) => sent.push(m)`. That shim has no
  // `_connected && ws` gate, so it passed identically whether or not the app
  // could ever deliver the bye — and the app could NOT: NetMgr.disconnect()
  // closed the socket first, so on the real path disable() emitted nothing. That
  // assertion now lives in section 6, driven through a real NetMgr, a real
  // socket and a real room server. Only the announce:false half — which is about
  // VideoMgr's own contract, not about delivery — is still a unit check.
  {
    const sent = [];
    const canvas = { id: 'canvas', captureStream: () => new FakeStream([new FakeTrack('video', 'src')]) };
    const host = new VideoMgr({ send: (m) => sent.push(m), getSelfId: () => 'H', getCaptureCanvas: () => canvas });
    host.startBroadcast();
    host.update({ peerIds: ['H', 'C1'], selfId: 'H', hostId: 'H' });
    await sleep(0);   // let the fake PC's negotiationneeded settle first
    sent.length = 0;
    host.disable({ announce: false });
    ok(sent.filter((m) => m.kind === 'bye').length === 0,
      'disable({announce:false}) sends NO bye (the socket is already gone)');
    ok(host._pcs.size === 0, 'disable({announce:false}) still tears the local connections down');
    ok(!host.sourceStream, 'disable({announce:false}) still stops the local capture');
  }
}

// ===========================================================================
// 4b. VoiceMgr must not be steerable by a video-channel kind
// ===========================================================================
// 'bye' is a valid SIGNAL kind now. NetProtocol keeps it off the voice channel,
// but VoiceMgr must not DEPEND on a validator elsewhere staying correct: its old
// handleSignal fell through every unknown kind into _ensurePeer(), so one stray
// bye opened an RTCPeerConnection and published the local mic into it.
console.log('== VoiceMgr ignores non-negotiation kinds ==');
{
  installBrowserFakes();
  const sent = [];
  const voice = new VoiceMgr({
    scene: {}, avatars: { getHead: () => null }, getSelfId: () => 'me',
    send: (m) => sent.push(m),
  });
  voice.enabled = true;                                   // as if the mic was granted
  voice.localStream = new FakeStream([new FakeTrack('audio', 'mic')]);
  await voice.handleSignal({ from: 'X', kind: 'bye', data: { epoch: 1 } });
  ok(voice._pcs.size === 0, "a 'bye' on the voice mesh opens NO peer connection");
  ok(sent.length === 0, "a 'bye' on the voice mesh sends nothing back");
  for (const kind of ['goodbye', 'close', '', 'BYE', undefined]) {
    await voice.handleSignal({ from: 'X', kind, data: {} });
  }
  ok(voice._pcs.size === 0, 'no unknown kind opens a voice peer connection');
  // POSITIVE CONTROL: the real negotiation kinds must still build the mesh, or
  // the check above would pass simply by breaking voice altogether.
  await voice.handleSignal({ from: 'X', kind: 'offer', data: { type: 'offer', sdp: 's' } });
  ok(voice._pcs.size === 1, "a real 'offer' still opens the voice peer connection");
  ok(sent.some((m) => m.kind === 'answer'), "a real 'offer' is still answered");
}

// ===========================================================================
// 5. LIVE: a real room-server on :8894 relays every kind between two clients
// ===========================================================================
if (LIVE) {
  console.log(`== live room-server on :${PORT} ==`);
  const srv = spawn(process.execPath, [join(ROOT, 'server', 'room-server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), LOG_PORT: String(LOG_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const srvLog = [];
  srv.stdout.on('data', (d) => srvLog.push(String(d)));
  srv.stderr.on('data', (d) => srvLog.push(String(d)));

  const open = (nick, room = ROOM) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?room=${room}&nick=${nick}`);
    ws.inbox = [];
    ws.on('message', (d) => { const m = decode(d.toString()); if (m) ws.inbox.push(m); });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
  const waitFor = async (ws, pred, ms = 2500) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = ws.inbox.find(pred);
      if (hit) return hit;
      await sleep(20);
    }
    return null;
  };

  let A = null, B = null;
  try {
    // Wait for the port to accept.
    for (let i = 0; i < 60 && !A; i++) {
      try { A = await open('alice'); } catch { await sleep(100); }
    }
    ok(!!A, 'room-server accepted a connection');
    B = await open('bob');
    const helloA = await waitFor(A, (m) => m.type === MSG.HELLO);
    const helloB = await waitFor(B, (m) => m.type === MSG.HELLO);
    ok(!!helloA && !!helloB, 'both clients got HELLO');
    const idA = helloA?.selfId, idB = helloB?.selfId;

    // Every kind, host(A) → client(B), through the real server's decode().
    for (const kind of EXPECTED_KINDS) {
      B.inbox.length = 0;
      A.send(encode(makeSignal({ to: idB, kind, data: DATA_FOR[kind], channel: CHANNEL_FOR[kind] })));
      const got = await waitFor(B, (m) => m.type === MSG.SIGNAL && m.kind === kind);
      ok(!!got, `LIVE: '${kind}' was relayed to the addressed peer`);
      ok(got?.from === idA, `LIVE: '${kind}' arrives stamped with the real sender`);
      ok(got?.channel === 'video', `LIVE: '${kind}' keeps its channel`);
      ok(JSON.stringify(got?.data) === JSON.stringify(DATA_FOR[kind]), `LIVE: '${kind}' data passes through verbatim`);
    }
    // Voice-channel negotiation still flows the other way.
    A.inbox.length = 0;
    B.send(encode(makeSignal({ to: idA, kind: 'answer', data: DATA_FOR.answer })));
    ok(!!(await waitFor(A, (m) => m.type === MSG.SIGNAL && m.kind === 'answer')), 'LIVE: voice-channel answer still relayed');

    // NEGATIVE CONTROLS against the real server: it must still drop these.
    for (const [label, raw] of [
      ['bogus kind', { type: MSG.SIGNAL, to: idB, kind: 'byebye', data: {}, channel: 'video' }],
      ["'bye' on the voice channel", { type: MSG.SIGNAL, to: idB, kind: 'bye', data: { epoch: 1 } }],
      ['non-object data', { type: MSG.SIGNAL, to: idB, kind: 'bye', data: 'x', channel: 'video' }],
    ]) {
      B.inbox.length = 0;
      A.send(JSON.stringify(raw));
      await sleep(300);
      ok(!B.inbox.some((m) => m.type === MSG.SIGNAL), `LIVE: ${label} is NOT relayed`);
    }
    // …and the server is still alive and relaying after all that garbage.
    B.inbox.length = 0;
    A.send(encode(makeSignal({ to: idB, kind: 'bye', data: { epoch: 9 }, channel: 'video' })));
    ok(!!(await waitFor(B, (m) => m.type === MSG.SIGNAL && m.kind === 'bye')), 'LIVE: server still relays a valid bye after rejecting garbage');

    // =======================================================================
    // 6. THE REAL PATH — a leaving HOST's bye must reach a real client
    // =======================================================================
    // Everything above (and every bye assertion this file used to make) drove
    // VideoMgr directly with `send: (m) => sent.push(m)`. The app does not: it
    // hands VideoMgr a closure gated on `this._connected && this.ws`, and
    // NetMgr.disconnect() used to close the socket and clear _connected BEFORE
    // calling video.disable() — so on the real path the bye was swallowed and
    // the shim test still went green. Same in DesktopNet.
    //
    // So this section drives the REAL managers: real WebSocket, real room
    // server, real client inbox. The only fakes are WebRTC/DOM, which the wire
    // never sees. Measured evidence = "did a bye arrive at the other socket".
    console.log('== real NetMgr / DesktopNet teardown over the live socket ==');
    globalThis.WebSocket = WebSocket;          // the managers call `new WebSocket`
    installBrowserFakes();

    let srcN = 0;
    const makeCanvas = () => ({ id: 'emu', captureStream: () => new FakeStream([new FakeTrack('video', `src${++srcN}`)]) });
    const stubScene = { addObject() {}, removeObject() {}, playerRig: null, renderer: null, camera: null, controllers: [] };
    const url = `ws://127.0.0.1:${PORT}/`;
    // A raw socket is in the room but is only ANNOUNCED to the others once it
    // identifies itself with a JOIN — without it the host's roster stays empty
    // and it would never open a sender connection to stream (or bye) to.
    const openWatcher = async (nick, room) => {
      const ws = await open(nick, room);
      ws.send(encode(makeJoin({ nick })));
      return ws;
    };

    // --- VR NetMgr: clean leave MUST announce -------------------------------
    {
      const room = 'byetest-vr';
      const net = new NetMgr({ scene: stubScene, room, serverUrl: url, nick: 'vrhost', videoCanvas: makeCanvas() });
      let watcher = null;
      try {
        net.connect();
        ok(await untilTrue(() => !!net.selfId), 'REAL: NetMgr connected to the live room server');
        ok(net.isHost(), 'REAL: NetMgr is the host (first peer into an empty room)');
        watcher = await openWatcher('watcher', room);
        ok(await untilTrue(() => net.presence.size === 1), 'REAL: NetMgr sees the watching client on its roster');
        const hostId = net.selfId;

        const stream = async () => {
          if (net.startVideoBroadcast() !== true) return false;
          net.tick(0);                         // video.update() opens the sender PC
          return untilTrue(() => net.debugApi().video.sendingCount() === 1);
        };

        // PATH A — stopVideoBroadcast() while connected. This one already worked;
        // it is here so a fix that merely moved the breakage around is visible.
        ok(await stream(), 'REAL: host is streaming to the client (path A)');
        watcher.inbox.length = 0;
        net.stopVideoBroadcast();
        const byeA = await waitFor(watcher, (m) => m.type === MSG.SIGNAL && m.kind === 'bye');
        ok(!!byeA, 'REAL PATH A: stopVideoBroadcast() puts a bye on the wire');

        // PATH B — the defect: leaving the room. Pre-fix this was 0 byes.
        ok(await stream(), 'REAL: host is streaming again before the leave (path B)');
        watcher.inbox.length = 0;
        net.disconnect();
        const byeB = await waitFor(watcher, (m) => m.type === MSG.SIGNAL && m.kind === 'bye');
        ok(!!byeB, 'REAL PATH B: NetMgr.disconnect() delivers the bye to the client');
        ok(byeB?.channel === 'video', 'REAL PATH B: the leave bye arrives on the video channel');
        ok(byeB?.from === hostId, 'REAL PATH B: the leave bye is stamped with the leaving host');
        ok(typeof byeB?.data?.epoch === 'number', 'REAL PATH B: the leave bye carries the sender epoch');
        // …and the leave is still a real leave.
        ok(net.connected === false, 'REAL PATH B: the socket is closed after disconnect()');
        ok(net.video._pcs.size === 0 && !net.video.sourceStream, 'REAL PATH B: the leaving host still tore its own video down');
        ok(!!(await waitFor(watcher, (m) => m.type === MSG.LEAVE)), 'REAL PATH B: the client still gets the LEAVE (nothing blocked the close)');
      } finally {
        try { net.disconnect(); } catch { /* ok */ }
        try { watcher?.close(); } catch { /* ok */ }
      }
    }

    // --- VR NetMgr: a LOST connection is not a clean leave ------------------
    // The reconnect path must still tear local state down, must NOT pretend to
    // announce (nothing can be delivered through a dead socket), and must still
    // come back.
    {
      const room = 'byetest-drop';
      const net = new NetMgr({ scene: stubScene, room, serverUrl: url, nick: 'droppy', videoCanvas: makeCanvas() });
      let watcher = null;
      try {
        net.connect();
        ok(await untilTrue(() => !!net.selfId), 'REAL: NetMgr connected (drop case)');
        watcher = await openWatcher('watcher2', room);
        ok(await untilTrue(() => net.presence.size === 1), 'REAL: roster has the watcher (drop case)');
        ok(net.startVideoBroadcast() === true, 'REAL: host captured its canvas (drop case)');
        net.tick(0);
        ok(await untilTrue(() => net.debugApi().video.sendingCount() === 1), 'REAL: host is streaming (drop case)');

        watcher.inbox.length = 0;
        // Hard-kill the socket with no close frame — the closest thing to a
        // Wi-Fi drop. `_closing` stays false, so this is NetMgr's unexpected-
        // close path, not disconnect().
        if (typeof net.ws.terminate === 'function') net.ws.terminate(); else net.ws.close();
        ok(await untilTrue(() => net.connected === false), 'REAL: NetMgr noticed the dropped socket');
        await sleep(500);
        ok(!watcher.inbox.some((m) => m.type === MSG.SIGNAL && m.kind === 'bye'),
          'REAL: a LOST connection sends no bye (it could not be delivered anyway)');
        ok(!net.video.sourceStream, 'REAL: a lost connection still stops the local capture');
        ok(await untilTrue(() => net.connected === true, 5000), 'REAL: the reconnect chain still re-opens the socket');
        ok(net.video._pcs.size === 0, 'REAL: the reconnect teardown left no stale video connections');
      } finally {
        try { net.disconnect(); } catch { /* ok */ }
        try { watcher?.close(); } catch { /* ok */ }
      }
    }

    // --- Desktop build: identical defect, identical fix ---------------------
    {
      const room = 'byetest-desktop';
      const dnet = new DesktopNet({ room, serverUrl: url, nick: 'dhost', getCaptureCanvas: makeCanvas() });
      let watcher = null;
      try {
        dnet.connect();
        ok(await untilTrue(() => !!dnet.selfId), 'REAL: DesktopNet connected to the live room server');
        ok(dnet.isHost(), 'REAL: DesktopNet is the host');
        watcher = await openWatcher('dwatcher', room);
        ok(await untilTrue(() => dnet.peerCount() === 1), 'REAL: DesktopNet sees the watching client');
        ok(dnet.startVideoBroadcast() === true, 'REAL: DesktopNet captured its canvas');
        dnet.tick(0);
        ok(await untilTrue(() => dnet.debugApi().video.sendingCount() === 1), 'REAL: DesktopNet is streaming to the client');
        watcher.inbox.length = 0;
        dnet.disconnect();
        const bye = await waitFor(watcher, (m) => m.type === MSG.SIGNAL && m.kind === 'bye');
        ok(!!bye, 'REAL PATH B: DesktopNet.disconnect() delivers the bye to the client');
        ok(bye?.channel === 'video', 'REAL PATH B: the desktop leave bye is on the video channel');
        ok(dnet.connected === false, 'REAL PATH B: the desktop socket is closed after disconnect()');
      } finally {
        try { dnet.disconnect(); } catch { /* ok */ }
        try { watcher?.close(); } catch { /* ok */ }
      }
    }
  } finally {
    try { A?.close(); } catch { /* ok */ }
    try { B?.close(); } catch { /* ok */ }
    await sleep(100);
    srv.kill();                    // only the child we spawned — never by name
    await sleep(150);
    if (failed) console.log(srvLog.join(''));
  }
} else {
  console.log('== live room-server: SKIPPED (--no-server) ==');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
