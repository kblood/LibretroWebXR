// Unit tests for the M0.4 voice mesh's liveness rules ([[src/net/VoiceMgr.js]],
// CODEX_REVIEW COR-7, 2026-08-15): trickle-ICE buffering, the bound on that
// buffer, failed-connection rebuild with backoff, and the negotiation epoch that
// keeps a dead connection's stragglers off its replacement.
//
// Node has no WebRTC, so this drives a FakePC that reproduces the two browser
// behaviours the bug depended on: addIceCandidate() REJECTS before
// setRemoteDescription(), and close() fires onconnectionstatechange('closed').
// No browser, no socket, no port — this belongs in the `npm test` tier.
//
// Every claim here has a NEGATIVE CONTROL: the identical scenario re-run with
// exactly one part of the fix neutralised, asserting the old broken outcome. If
// a control ever starts agreeing with the fixed run, the test has gone false-green.
//
// Sections are run through section(), which turns a THROW into a reported
// failure. That matters here: when a fix is removed the very next line usually
// dereferences a connection that no longer exists, and a bare crash would hide
// every later section's verdict (checked by mutation-testing this file).
//
// Round 4 (2026-08-15) — sections G, H and I exist because an adversarial review showed
// the first cut of the recovery path RE-CREATED the bug it fixes, in its own
// teardown window: while the entry was absent, one inbound signal rebuilt the
// peer hard-coded as the ANSWERER, so the offerer lost its role and nobody ever
// offered again. Sections A..F never entered that window, which is why they were
// all green while voice was permanently dead.
//
// KNOWN FIDELITY LIMITS of FakePC, in full:
//  • It does not model signalingState, so it accepts setRemoteDescription(answer)
//    on a PC that has no local offer, where a real browser would throw
//    InvalidStateError. Assertions that a stale ANSWER was not installed are
//    therefore weaker than they look — a real browser would have rejected some of
//    them anyway. The load-bearing assertions in G/H are about what is left BEHIND
//    (which PCs exist, and with which role/epoch), which does not depend on that.
//    Anything relying purely on "the answer was not installed" is flagged inline.
//  • close() fires onconnectionstatechange('closed'); real browsers do not. That
//    is deliberate — it is what proves _closePeer()'s own teardown cannot be read
//    back as a failure — but it means 'closed' arrives here on paths where a
//    browser would be silent.
//  • Round 5: ICE gathering IS modelled to the extent that matters — _candidate()
//    emits nothing until setLocalDescription() has run, because gathering starts
//    there. Before that, the suite could drive candidates out of a PC in a state
//    no browser can produce (an answering PC that has not answered), and it did.
//    Gathering is not otherwise simulated: candidates only appear when a test asks
//    for one, and close() does not stop them (see FakePC._candidate).

import { VoiceMgr } from '../src/net/VoiceMgr.js';

let passed = 0;
let failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const section = async (name, fn) => {
  console.log(`--- ${name} ---`);
  try { await fn(); } catch (e) { failed++; console.error(`  FAIL: section "${name}" threw — ${e.message}`); }
};

// Let queued microtasks (the await chains inside handleSignal / the
// onnegotiationneeded offer) run to completion.
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// === A fake RTCPeerConnection ==============================================

let pcSeq = 0;
class FakePC {
  static created = [];
  static reset() { FakePC.created = []; pcSeq = 0; }
  constructor(cfg) {
    this.id = ++pcSeq;
    this.cfg = cfg;
    this.closed = false;
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.applied = [];        // candidates that actually reached ICE
    this.tracks = [];
    FakePC.created.push(this);
  }
  addTrack(t) {
    this.tracks.push(t);
    // Real PCs fire this asynchronously, AFTER the caller has finished wiring
    // its handlers — that ordering is what makes VoiceMgr's offer path run.
    queueMicrotask(() => this.onnegotiationneeded?.());
  }
  async createOffer() { return { type: 'offer', sdp: `offer-${this.id}` }; }
  async createAnswer() { return { type: 'answer', sdp: `answer-${this.id}` }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) {
    if (this.closed) throw new Error('InvalidStateError: connection closed');
    this.remoteDescription = d;
  }
  async addIceCandidate(c) {
    // The exact browser behaviour the old code tripped over.
    if (this.closed) throw new Error('InvalidStateError: connection closed');
    if (!this.remoteDescription) throw new Error('InvalidStateError: remote description was null');
    this.applied.push(c);
  }
  close() { this.closed = true; this._conn('closed'); }
  _conn(s) { this.connectionState = s; this.onconnectionstatechange?.(); }
  _ice(s) { this.iceConnectionState = s; this.oniceconnectionstatechange?.(); }
  // Local ICE gathering. Real candidates arrive as an event carrying an
  // RTCIceCandidate (which has toJSON()); VoiceMgr serialises it and stamps the
  // pair's epoch on the way out. Nothing drove this handler before round 4, so
  // the SENDING half of the epoch protocol had no coverage at all — see H.
  //
  // Round 5: gathering only STARTS at setLocalDescription(), so a PC with no
  // local description never fires onicecandidate. Modelled here (returns false
  // instead of emitting) because without it the suite could pin — and did pin —
  // behaviour of an answering PC that has not yet answered, a state a browser
  // cannot reach. close() is deliberately NOT modelled as stopping gathering: an
  // event already queued as a task can still be delivered after close(), which is
  // exactly the race the outgoing epoch stamp exists for (see I).
  _candidate(name) {
    if (!this.localDescription) return false;
    const init = { candidate: name, sdpMid: '0' };
    this.onicecandidate?.({ candidate: { ...init, toJSON: () => ({ ...init }) } });
    return true;
  }
}
globalThis.RTCPeerConnection = FakePC;

// A VoiceMgr wired to the fake, with a fake clock so backoff is testable without
// waiting. `enabled`/`localStream` are set directly: enable() needs getUserMedia.
function makeVoice({ selfId = 'aaa', ...opts } = {}) {
  const sent = [];
  const clock = { ms: 0 };
  const voice = new VoiceMgr({
    scene: {},
    avatars: { getHead: () => null }, // no avatar → _tryAttach bails, no THREE audio
    send: (m) => sent.push(m),
    getSelfId: () => selfId,
    now: () => clock.ms,
    disconnectGraceMs: 5,
    ...opts,
  });
  voice.enabled = true;
  voice.localStream = { getTracks: () => [{ kind: 'audio', stop() {} }] };
  return { voice, sent, clock };
}

const ice = (name, epoch) => ({ candidate: name, sdpMid: '0', ...(epoch ? { epoch } : {}) });
const applied = (pc) => pc.applied.map((c) => c.candidate);

// Read the round-4 state through structures that exist in EVERY version of the
// module, not through the debugApi() views added with the fix. Reverting the fix
// must make these assertions say something false, not die with "roles is not a
// function" — a TypeError is not a test result. The new debugApi() views get
// their own assertions in H, where that is the thing under test.
const roleOf = (v, id) => (v._pcs.has(id) ? v._pcs.get(id).initiator : '(no entry)');
const deadEpochOf = (v, id) => v._lastDeadEpoch?.get(id) ?? '(no watermark)';
const parkedOf = (v, id) => {
  const p = v._parkedIce?.get(id);
  return p ? { epoch: p.epoch, cands: p.cands.map((c) => c.candidate) } : '(no park)';
};
// Same reasoning: a build with no rebuild backoff at all must fail the ladder
// assertions with a value rather than blowing the section up on the first read.
const backoffOf = (v, id) => v._retry?.get(id) || { attempts: '(no backoff)', notBefore: 0 };

// === A. ICE that beats the SDP is buffered, then applied in order ==========

await section('ICE-before-SDP is queued and flushed after setRemoteDescription', async () => {
  FakePC.reset();
  const { voice, sent } = makeVoice({ selfId: 'zzz' });  // 'zzz' > 'bbb' → we answer
  voice.syncPeers(['zzz', 'bbb']);
  const pc = FakePC.created[0];
  const entry = voice._pcs.get('bbb');
  await tick();
  ok(!sent.some((m) => m.kind === 'offer'), 'the answering side does not offer');

  for (const c of ['c1', 'c2', 'c3']) await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice(c, 7) });
  eq(applied(pc), [], 'no candidate is applied while the remote description is missing');
  ok(entry.pendingIce.length === 3, 'all three candidates are buffered');
  ok(pc.remoteDescription === null, 'sanity: the PC really had no remote description');

  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o', epoch: 7 } });
  await tick();
  eq(applied(pc), ['c1', 'c2', 'c3'], 'the buffered candidates are applied, in arrival order');
  ok(entry.pendingIce.length === 0, 'the queue is drained');
  const answer = sent.find((m) => m.kind === 'answer');
  ok(!!answer && answer.data.epoch === 7, "the answer mirrors the offerer's epoch back");

  // Post-SDP candidates keep taking the direct path.
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('c4', 7) });
  eq(applied(pc), ['c1', 'c2', 'c3', 'c4'], 'a candidate after the SDP is applied immediately');
});

await section('NEGATIVE CONTROL: without buffering the early candidates are lost', async () => {
  FakePC.reset();
  const { voice } = makeVoice({ selfId: 'zzz' });
  voice.syncPeers(['zzz', 'bbb']);
  const pc = FakePC.created[0];
  // Restore the pre-fix behaviour at the one point that changed: apply the
  // candidate the instant it arrives and swallow whatever the PC throws — which
  // is literally what the old `await pc.addIceCandidate(msg.data)` inside the
  // shared try/catch did.
  voice._queueIce = (e, _peerId, cand) => { e.pc.addIceCandidate(cand).catch(() => { /* swallowed, as before */ }); };

  for (const c of ['c1', 'c2', 'c3']) await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice(c, 7) });
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o', epoch: 7 } });
  await tick();
  eq(applied(pc), [], 'CONTROL: every pre-SDP candidate was silently discarded');
  ok(voice._pcs.get('bbb').pendingIce.length === 0, 'CONTROL: nothing was kept to replay');
});

// === B. The queue is bounded ==============================================

await section('the pre-SDP ICE queue is bounded', async () => {
  FakePC.reset();
  const { voice } = makeVoice({ selfId: 'zzz' });
  voice.syncPeers(['zzz', 'bbb']);
  const entry = voice._pcs.get('bbb');
  ok(voice.iceQueueMax === 64, 'the default bound is 64 candidates');
  for (let i = 0; i < 200; i++) await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice(`c${i}`, 7) });
  ok(entry.pendingIce.length === 64, `a flood is capped at the bound (got ${entry.pendingIce.length})`);
  ok(entry.iceDropped === 136, `the drops are counted (got ${entry.iceDropped})`);
  eq(entry.pendingIce[63].candidate, 'c199', 'the newest candidate survives');
  eq(entry.pendingIce[0].candidate, 'c136', 'the oldest candidates are the ones dropped');
});

await section('NEGATIVE CONTROL: with the bound removed the queue grows without limit', async () => {
  FakePC.reset();
  const { voice } = makeVoice({ selfId: 'zzz' });
  voice.syncPeers(['zzz', 'bbb']);
  voice.iceQueueMax = Infinity;   // the unbounded behaviour
  const entry = voice._pcs.get('bbb');
  for (let i = 0; i < 200; i++) await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice(`c${i}`, 7) });
  ok(entry.pendingIce.length === 200, 'CONTROL: a peer that never sends an SDP grows the queue forever');
});

// === C. A failed connection is closed, dropped and rebuilt ================

await section('a failed PC is closed, removed and rebuilt after a backoff', async () => {
  FakePC.reset();
  const { voice, clock } = makeVoice({ selfId: 'aaa' }); // 'aaa' < 'bbb' → we offer
  voice.syncPeers(['aaa', 'bbb']);
  const pc1 = FakePC.created[0];
  await tick();
  ok(voice._pcs.get('bbb')?.pc === pc1, 'a connection is opened for the peer');

  pc1._conn('failed');
  ok(!voice._pcs.has('bbb'), 'the failed peer is removed from the map');
  ok(pc1.closed === true, 'the failed PC is actually closed');

  voice.syncPeers(['aaa', 'bbb']);
  ok(FakePC.created.length === 1, 'the rebuild is held off during the backoff window');
  clock.ms = 999;
  voice.syncPeers(['aaa', 'bbb']);
  ok(FakePC.created.length === 1, 'still held off just before the window expires');
  clock.ms = 1001;
  voice.syncPeers(['aaa', 'bbb']);
  await tick();
  const pc2 = FakePC.created[1];
  ok(FakePC.created.length === 2 && voice._pcs.get('bbb')?.pc === pc2, 'a fresh PC is built once the backoff expires');
  ok(voice._pcs.get('bbb')?.epoch === 2, 'the rebuilt connection carries a new epoch');

  // Backoff is exponential and only cleared by a link that actually works.
  pc2?._conn('failed');
  ok(voice.debugApi().retries()[0]?.attempts === 2, 'a second failure increments the attempt count');
  ok(voice.debugApi().retries()[0]?.notBefore === 1001 + 2000, 'the backoff doubles (1s → 2s)');
  clock.ms += 2001;
  voice.syncPeers(['aaa', 'bbb']);
  FakePC.created[2]?._conn('connected');
  eq(voice.debugApi().retries(), [], 'a connected link clears the penalty');
});

await section('transient disconnect gets a grace window, permanent disconnect does not', async () => {
  FakePC.reset();
  const { voice } = makeVoice({ selfId: 'aaa', disconnectGraceMs: 5 });
  voice.syncPeers(['aaa', 'bbb']);
  const pc = FakePC.created[0];
  pc._conn('disconnected');
  ok(voice._pcs.has('bbb'), 'a disconnect does not tear down immediately');
  pc.connectionState = 'connected';   // recovered before the window closed
  await sleep(20);
  ok(voice._pcs.get('bbb')?.pc === pc, 'a recovered peer keeps its connection');

  pc._conn('disconnected');
  await sleep(20);
  ok(!voice._pcs.has('bbb'), 'a disconnect that never recovers is torn down');

  // ICE-level failure is a separate signal and must also act.
  FakePC.reset();
  const v2 = makeVoice({ selfId: 'aaa' }).voice;
  v2.syncPeers(['aaa', 'bbb']);
  FakePC.created[0]._ice('failed');
  ok(!v2._pcs.has('bbb'), 'iceConnectionState "failed" also tears the peer down');
});

// The ladder used to STOP after retryLimit, and its log line claimed "its next
// offer still works". It does not: the glare rule makes the larger id a pure
// answerer, so for the offering side that offer never comes and voice was dead
// for the rest of the session. The ladder now flattens to retryCooloffMs instead.
await section('the retry ladder flattens to a cool-off but never stops', async () => {
  FakePC.reset();
  const { voice, clock } = makeVoice({ selfId: 'aaa' });
  ok(voice.retryCooloffMs === 60000, 'the production cool-off is 60s');

  const waits = [];
  for (let i = 0; i < 9; i++) {
    voice.syncPeers(['aaa', 'bbb']);
    const at = clock.ms;
    voice._pcs.get('bbb')?.pc._conn('failed');
    const r = backoffOf(voice, 'bbb');
    waits.push(r.notBefore - at);
    clock.ms = r.notBefore;                 // wait exactly out the window it asked for
  }
  eq(waits, [1000, 2000, 4000, 8000, 15000, 15000, 60000, 60000, 60000],
    'the ladder is 1,2,4,8,15,15s and then flattens at the cool-off');
  ok(FakePC.created.length === 9, `every one of those windows produced a real attempt (got ${FakePC.created.length})`);
  eq(backoffOf(voice, 'bbb').attempts, 9, 'well past retryLimit, and still trying');

  voice.syncPeers(['aaa']);                 // the peer left the room
  voice.syncPeers(['aaa', 'bbb']);          // …and came back
  ok(FakePC.created.length === 10, 'a rejoining peer connects immediately (penalty forgotten)');
});

await section('NEGATIVE CONTROL: a terminal give-up leaves that peer silent for the session', async () => {
  FakePC.reset();
  // retryCooloffMs = Infinity IS the old behaviour: the first attempt past the
  // limit sets notBefore to infinity, i.e. _mayRebuild() never says yes again.
  const { voice, clock } = makeVoice({ selfId: 'aaa', retryCooloffMs: Infinity });
  for (let i = 0; i < 7; i++) {
    voice.syncPeers(['aaa', 'bbb']);
    voice._pcs.get('bbb')?.pc._conn('failed');
    const r = backoffOf(voice, 'bbb');
    if (Number.isFinite(r.notBefore)) clock.ms = r.notBefore;
  }
  ok(FakePC.created.length === 7, 'CONTROL: the ladder ran out after retryLimit+1 attempts');
  clock.ms += 3600 * 1000;                  // an hour later
  for (let i = 0; i < 100; i++) voice.syncPeers(['aaa', 'bbb']);
  ok(FakePC.created.length === 7, 'CONTROL: an hour and 100 syncs later it has still not tried again');

  // …and this is why that was terminal rather than merely slow: the peer on the
  // other side is the larger id, so it is a pure answerer and never offers. Real
  // module, real glare rule — not a claim about it.
  const other = makeVoice({ selfId: 'bbb' });
  other.voice.syncPeers(['bbb', 'aaa']);
  await tick();
  ok(!other.sent.some((m) => m.kind === 'offer'),
    'CONTROL: the peer never offers to rescue us — "its next offer still works" was false');
});

await section('NEGATIVE CONTROL: without failure handling the dead PC stays forever', async () => {
  FakePC.reset();
  const { voice, clock } = makeVoice({ selfId: 'aaa' });
  voice._onPeerBroken = () => { /* the pre-fix code had no state handlers at all */ };
  voice.syncPeers(['aaa', 'bbb']);
  const pc1 = FakePC.created[0];
  pc1._conn('failed');
  ok(voice._pcs.get('bbb')?.pc === pc1, 'CONTROL: the failed PC is still in the map');
  ok(pc1.closed === false, 'CONTROL: nothing closed it');
  clock.ms = 60000;
  voice.syncPeers(['aaa', 'bbb']);
  voice.syncPeers(['aaa', 'bbb']);
  ok(FakePC.created.length === 1, 'CONTROL: syncPeers never rebuilds it — that peer is silent forever');
});

// === D. Epoch keeps a dead connection's stragglers off its replacement =====

await section('a late answer/candidate from the OLD epoch is dropped', async () => {
  FakePC.reset();
  const { voice, sent, clock } = makeVoice({ selfId: 'aaa' });
  voice.syncPeers(['aaa', 'bbb']);
  const pc1 = FakePC.created[0];
  await tick();
  ok(sent.find((m) => m.kind === 'offer')?.data.epoch === 1, 'our offer is stamped with epoch 1');

  await voice.handleSignal({ from: 'bbb', kind: 'answer', data: { type: 'answer', sdp: 'a1', epoch: 1 } });
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('old-1', 1) });
  eq(applied(pc1), ['old-1'], 'epoch-1 traffic lands on the epoch-1 connection');

  pc1._conn('failed');
  clock.ms = 5000;
  voice.syncPeers(['aaa', 'bbb']);
  await tick();
  const pc2 = FakePC.created[1];
  const entry2 = voice._pcs.get('bbb');
  ok(entry2?.epoch === 2, 'the rebuilt connection is epoch 2');
  ok(sent.filter((m) => m.kind === 'offer').pop()?.data.epoch === 2, 'the new offer is stamped 2');

  // The dead PC's state events are tasks and can land AFTER its replacement is
  // live. Looked up by peer id alone, that death would take the healthy
  // connection with it (and earn the peer a backoff penalty it didn't deserve).
  // What actually stops it is the `entry.closing` flag _closePeer() sets before
  // it unmaps — _onPeerBroken() used to ALSO carry an identity check
  // (`_pcs.get(peerId) !== entry`) which the round-4 review proved unreachable
  // (deleting it changed no outcome here); it is gone, and these two assertions
  // now name the guard that is actually load-bearing.
  pc1._conn('failed');
  pc1._ice('failed');
  ok(voice._pcs.get('bbb') === entry2, 'a superseded PC reporting failure late does not kill its replacement');
  eq(voice.debugApi().retries()[0]?.attempts, 1, 'nor does it inflate the backoff');

  // The stragglers: produced by the peer against the connection that just died.
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('stale', 1) });
  await voice.handleSignal({ from: 'bbb', kind: 'answer', data: { type: 'answer', sdp: 'stale-sdp', epoch: 1 } });
  await tick();
  eq(applied(pc2), [], 'the stale candidate is NOT applied to the new connection');
  ok(entry2.pendingIce.length === 0, 'nor is it parked in the new queue for later');
  // FIDELITY: FakePC has no signalingState, so a real browser would likely have
  // thrown on this setRemoteDescription anyway. Kept as a contract check, not as
  // proof that the epoch gate is what stopped it; the candidate assertions above
  // (addIceCandidate is legal at any point once a remote description exists) are
  // the ones that isolate the gate.
  ok(pc2.remoteDescription === null, 'the stale answer is NOT installed');
  ok(entry2.remoteSet === false, 'the new connection is still waiting for its own answer');

  // …and the real epoch-2 traffic still works.
  await voice.handleSignal({ from: 'bbb', kind: 'answer', data: { type: 'answer', sdp: 'a2', epoch: 2 } });
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('new-1', 2) });
  ok(pc2.remoteDescription?.sdp === 'a2', 'the epoch-2 answer is installed');
  eq(applied(pc2), ['new-1'], 'the epoch-2 candidate is applied');
});

await section('NEGATIVE CONTROL: unstamped signals let the dead epoch poison the new PC', async () => {
  FakePC.reset();
  const { voice, clock } = makeVoice({ selfId: 'aaa' });
  voice.syncPeers(['aaa', 'bbb']);
  const pc1 = FakePC.created[0];
  await tick();
  await voice.handleSignal({ from: 'bbb', kind: 'answer', data: { type: 'answer', sdp: 'a1' } }); // no epoch
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('old-1') });
  eq(applied(pc1), ['old-1'], 'CONTROL: same starting point as the stamped run');

  pc1._conn('failed');
  clock.ms = 5000;
  voice.syncPeers(['aaa', 'bbb']);
  await tick();
  const pc2 = FakePC.created[1];
  // Identical stragglers, but with the epoch stamp removed (i.e. the wire shape
  // before this fix): the gate has nothing to compare and lets them through.
  await voice.handleSignal({ from: 'bbb', kind: 'answer', data: { type: 'answer', sdp: 'stale-sdp' } });
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('stale') });
  await tick();
  ok(pc2.remoteDescription?.sdp === 'stale-sdp', "CONTROL: the dead connection's answer is installed on the new PC");
  eq(applied(pc2), ['stale'], "CONTROL: the dead connection's candidate is applied to the new PC");
});

// === E. The answering side rebuilds when the offerer's epoch moves on ======

await section("the answerer rebuilds on a newer epoch and rejects an older one", async () => {
  FakePC.reset();
  const { voice } = makeVoice({ selfId: 'zzz' });
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o1', epoch: 4 } });
  await tick();
  const pcA = FakePC.created[0];
  ok(voice._pcs.get('bbb')?.remoteEpoch === 4, 'the answerer records the offered epoch');

  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('older', 3) });
  eq(applied(pcA), [], 'a candidate from an older epoch is rejected');

  // A newer-epoch candidate can arrive BEFORE the newer offer does — that alone
  // proves the offerer rebuilt, so we rebuild too and buffer the candidate.
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('newer', 5) });
  const pcB = FakePC.created[1];
  ok(pcA.closed && voice._pcs.get('bbb')?.pc === pcB, 'a newer epoch rebuilds the answering PC');
  ok(voice._pcs.get('bbb')?.pendingIce.length === 1, 'the newer-epoch candidate is buffered for it');
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o2', epoch: 5 } });
  await tick();
  eq(applied(pcB), ['newer'], 'and applied once the new offer lands');
});

// === G. The teardown window: an inbound signal must not steal our role =====
// This is the round-4 defect. Sections A..F only ever fed signals to a peer that
// HAD a live entry; on the wire the stragglers arrive while it does not.

await section('OFFERER: a straggler during the backoff cannot demote us to answerer', async () => {
  FakePC.reset();
  const { voice, sent, clock } = makeVoice({ selfId: 'aaa' });   // 'aaa' < 'bbb' → we offer
  voice.syncPeers(['aaa', 'bbb']);
  await tick();
  eq(roleOf(voice, 'bbb'), true, 'we hold the offering role');
  const pc1 = FakePC.created[0];
  pc1._conn('failed');
  ok(!voice._pcs.has('bbb'), 'the backoff window is open — no entry exists');

  // Exactly one straggler each. Pre-round-4 the first of these ran
  // `_ensurePeer(msg.from, false)` and put the peer back in the map as ANSWERER.
  // The UNSTAMPED pair matter most: epoch 0 means "peer on an older build" and is
  // honoured unconditionally everywhere else, so the dead-epoch watermark cannot
  // reject them — the role rule is the only thing standing between them and a
  // permanently demoted offerer.
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('straggler', 1) });
  await voice.handleSignal({ from: 'bbb', kind: 'answer', data: { type: 'answer', sdp: 'stale', epoch: 1 } });
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('unstamped') });
  await voice.handleSignal({ from: 'bbb', kind: 'answer', data: { type: 'answer', sdp: 'stale-unstamped' } });
  await tick();
  ok(FakePC.created.length === 1, 'no connection is built out of an inbound signal during the backoff');
  ok(!voice._pcs.has('bbb'), 'the peer stays absent, so syncPeers() still owns the rebuild');
  eq(backoffOf(voice, 'bbb').attempts, 1, 'and the straggler did not disturb the backoff');

  // The rebuild then happens on our terms, with our role, and actually offers.
  clock.ms = 1001;
  voice.syncPeers(['aaa', 'bbb']);
  await tick();
  eq(roleOf(voice, 'bbb'), true, 'the rebuilt connection is the offerer again');
  eq(voice.debugApi().roles(), [{ id: 'bbb', initiator: true }], 'and the debug view reports that role (headset diagnosis)');
  const offers = sent.filter((m) => m.kind === 'offer');
  eq(offers.length, 2, 'a second offer really went out');
  eq(offers[1].data.epoch, 2, 'stamped with the new epoch');
  ok(FakePC.created[1]?.remoteDescription === null, "and the straggler's answer never reached it");
});

await section('OFFERER: the same holds long after the ladder has flattened', async () => {
  FakePC.reset();
  const { voice, sent, clock } = makeVoice({ selfId: 'aaa' });
  for (let i = 0; i < 8; i++) {                     // burn past retryLimit
    voice.syncPeers(['aaa', 'bbb']);
    voice._pcs.get('bbb')?.pc._conn('failed');
    clock.ms = backoffOf(voice, 'bbb').notBefore;
  }
  const built = FakePC.created.length;
  ok(backoffOf(voice, 'bbb').attempts > voice.retryLimit, 'we are past the retry limit');
  // The verifier's case (c): one inbound candidate walked straight past the
  // give-up and re-created the peer with the wrong role. Unstamped again, so the
  // watermark is not what rejects it.
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('walk-past') });
  ok(FakePC.created.length === built, 'an inbound signal does not sneak a connection past the backoff');
  ok(!voice._pcs.has('bbb'), 'nothing was left in the map to make syncPeers() skip the peer');
  // …and the cool-off still brings it back, with the right role.
  const offersBefore = sent.filter((m) => m.kind === 'offer').length;
  clock.ms += 60000;
  voice.syncPeers(['aaa', 'bbb']);
  await tick();
  eq(roleOf(voice, 'bbb'), true, 'the cool-off rebuild is still the offerer');
  eq(sent.filter((m) => m.kind === 'offer').length, offersBefore + 1, 'and it offers again');
});

await section('NEGATIVE CONTROL: the pre-round-4 creation site kills the call permanently', async () => {
  FakePC.reset();
  const { voice, sent, clock } = makeVoice({ selfId: 'aaa' });
  voice.syncPeers(['aaa', 'bbb']);
  await tick();
  FakePC.created[0]._conn('failed');
  const offersBefore = sent.filter((m) => m.kind === 'offer').length;
  // The pre-round-4 module, in the two places it differed. syncPeers() had no
  // role reconciliation, so pin _isOfferer() to the answer the old creation site
  // hard-coded…
  voice._isOfferer = () => false;
  // …and then run the old line itself: handleSignal's
  // `entry = this._ensurePeer(msg.from, false)`. Real method, real argument —
  // this is exactly what one straggler used to do inside the backoff window.
  voice._ensurePeer('bbb', false);
  await tick();
  eq(roleOf(voice, 'bbb'), false, 'CONTROL: we are now the answerer');
  for (let i = 0; i < 10; i++) { clock.ms += 60000; voice.syncPeers(['aaa', 'bbb']); await tick(); }
  ok(FakePC.created.length === 2, 'CONTROL: syncPeers never rebuilds — the id is back in _pcs');
  eq(sent.filter((m) => m.kind === 'offer').length, offersBefore, 'CONTROL: ten minutes on, we never offer again');
  eq(FakePC.created[1]?.connectionState, 'new', 'CONTROL: the PC never even leaves "new", so nothing reports a failure');
});

await section('a peer built before we knew our own id has its role corrected', async () => {
  FakePC.reset();
  // getSelfId() may legally return null (VoiceMgr._isOfferer handles it by taking
  // the passive role). In the current NetMgr wiring HELLO sets selfId before any
  // peer exists, so this ordering is not observed in the app — the reconciliation
  // is here so a wrong role can never be permanent, and this is its test.
  const me = { id: null };
  const { voice, sent } = makeVoice({ getSelfId: () => me.id });
  voice.syncPeers(['bbb']);
  await tick();
  eq(roleOf(voice, 'bbb'), false, 'with no self id we take the passive role');
  ok(!sent.some((m) => m.kind === 'offer'), 'and nothing is offered');
  me.id = 'aaa';                                    // the join ack lands: we sort first
  voice.syncPeers(['aaa', 'bbb']);
  await tick();
  eq(roleOf(voice, 'bbb'), true, 'the next roster sync corrects the role');
  ok(sent.some((m) => m.kind === 'offer' && m.to === 'bbb'), 'and the corrected connection offers');
});

// The reconciliation above is a repair, and a repair that fires on the wrong
// input is worse than the fault: it runs on EVERY roster tick (~60 Hz), outside
// _mayRebuild(), on connections that are working. Its two sub-mechanisms — the
// `self != null` guard and deriving the new role from _isOfferer() — had no
// assertion at all until round 5; both could be deleted with the suite green.

await section('a transient null self id does not churn a live call', async () => {
  FakePC.reset();
  const me = { id: 'aaa' };
  const { voice, sent } = makeVoice({ getSelfId: () => me.id });
  voice.syncPeers(['aaa', 'bbb']);
  await tick();
  const pc1 = FakePC.created[0];
  pc1._conn('connected');
  eq(roleOf(voice, 'bbb'), true, 'we hold the offering role on a connected call');
  const offersBefore = sent.filter((m) => m.kind === 'offer').length;

  // getSelfId() returns null again mid-session (a reconnect in flight). _isOfferer()
  // answers "answerer" then BY DESIGN, which reads as a disagreement with the live
  // role — so the `self != null` guard is the only thing between a momentary null
  // and tearing down a connected call. NOTE: the roster here deliberately omits our
  // own id, because with a null self id syncPeers' `id === self` skip cannot match
  // anything; that is a separate, unchanged property and not what this section is
  // about.
  me.id = null;
  voice.syncPeers(['bbb']);
  await tick();
  ok(voice._pcs.get('bbb')?.pc === pc1, 'the live connection is kept');
  ok(pc1.closed === false, 'it is not closed');
  eq(FakePC.created.length, 1, 'and nothing is rebuilt');
  eq(roleOf(voice, 'bbb'), true, 'the role is not demoted to answerer');
  eq(sent.filter((m) => m.kind === 'offer').length, offersBefore, 'no renegotiation is provoked');

  me.id = 'aaa';                                    // the reconnect completes
  voice.syncPeers(['aaa', 'bbb']);
  await tick();
  eq(FakePC.created.length, 1, 'and the call is still the same one afterwards');
});

await section('the role reconciliation takes the glare-rule role, and converges', async () => {
  FakePC.reset();
  const me = { id: 'aaa' };
  const { voice, sent } = makeVoice({ getSelfId: () => me.id });
  voice.syncPeers(['aaa', 'bbb']);
  await tick();
  eq(roleOf(voice, 'bbb'), true, 'we start out as the offerer');

  // Force the disagreement the block exists to repair, from the other direction:
  // our id now sorts AFTER the peer's, so the glare rule makes us a pure answerer.
  // (An id changing under us is synthetic — as the block's own comment says, no
  // observed path holds a wrong role today. What is under test is that the repair
  // derives the new role from _isOfferer() and therefore STOPS, instead of
  // close+rebuilding on every roster tick outside _mayRebuild().)
  me.id = 'zzz';
  for (let i = 0; i < 5; i++) { voice.syncPeers(['zzz', 'bbb']); await tick(); }
  eq(roleOf(voice, 'bbb'), false, 'the rebuilt connection takes the role _isOfferer() gives it');
  eq(FakePC.created.length, 2, 'exactly one rebuild — the four further roster ticks change nothing');
  eq(sent.filter((m) => m.kind === 'offer').length, 1, 'and no offer storm (an answerer does not offer)');
});

// === H. Stragglers that arrive while NO entry exists ======================

await section('ANSWERER: a dead epoch cannot resurrect itself through an absent entry', async () => {
  FakePC.reset();
  const { voice } = makeVoice({ selfId: 'zzz' });   // 'zzz' > 'bbb' → we answer
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o1', epoch: 4 } });
  await tick();
  FakePC.created[0]._conn('failed');
  ok(!voice._pcs.has('bbb'), 'the answering side is torn down too');
  eq(deadEpochOf(voice, 'bbb'), 4, 'the epoch it died on is remembered');
  eq(voice.debugApi().deadEpochs(), [{ id: 'bbb', epoch: 4 }], 'and the debug view reports it (headset diagnosis)');

  // Both epoch gates in handleSignal need a live entry; this is the case they
  // cannot see, and it is the one that happens on the wire.
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('stale', 4) });
  await voice.handleSignal({ from: 'bbb', kind: 'answer', data: { type: 'answer', sdp: 'stale-sdp', epoch: 4 } });
  await tick();
  ok(FakePC.created.length === 1, "no PC is built to receive the dead epoch's leftovers");
  ok(!voice._pcs.has('bbb'), 'and nothing is parked in the map for syncPeers() to skip');

  // The offerer's NEXT negotiation is unaffected: the watermark only rejects what
  // is <= the epoch it killed, including a candidate that beats the new offer here.
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('fresh', 5) });
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o2', epoch: 5 } });
  await tick();
  const pcB = FakePC.created[1];
  ok(!!pcB && voice._pcs.get('bbb')?.pc === pcB, 'a newer epoch is accepted with no entry present');
  eq(pcB ? applied(pcB) : '(no PC was built)', ['fresh'], 'and the candidate that arrived before its offer is applied to it');
});

await section('a peer that LEAVES and rejoins is not locked out by the watermark', async () => {
  FakePC.reset();
  const { voice } = makeVoice({ selfId: 'zzz' });
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o1', epoch: 4 } });
  await tick();
  FakePC.created[0]._conn('failed');
  eq(deadEpochOf(voice, 'bbb'), 4, 'watermarked at 4');
  voice.syncPeers(['zzz']);                          // the peer left the room
  eq(deadEpochOf(voice, 'bbb'), '(no watermark)', 'leaving clears the watermark');
  // A rejoined peer mints epochs from 1 again — a watermark of 4 would reject
  // every offer it will ever send, which is the same permanent silence.
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o-new', epoch: 1 } });
  await tick();
  ok(FakePC.created.length === 2 && voice._pcs.get('bbb')?.pc === FakePC.created[1], 'its fresh epoch-1 offer is answered');

  // The same thing without a LEAVE to clear the watermark: a peer that reloads
  // and is re-issued the same id restarts its epoch counter while still in our
  // roster. This is why an 'offer' is exempt from the watermark — a rule of
  // "epoch <= the one that died is stale" would reject every offer it can ever
  // send, and its voice would never come back.
  FakePC.created[1]._conn('failed');
  eq(deadEpochOf(voice, 'bbb'), 1, 'watermarked again, with no leave in between');
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o-reload', epoch: 1 } });
  await tick();
  ok(FakePC.created.length === 3 && voice._pcs.get('bbb')?.pc === FakePC.created[2], 'a restarted epoch-1 offer is still answered');
  ok(FakePC.created[2]?.remoteDescription?.sdp === 'o-reload', 'and its SDP is installed');
});

// Round 5. The exemption above rescues the reloaded peer's OFFER — and only the
// offer. Its CANDIDATES carry the restarted numbers too, they routinely beat the
// offer through the relay (COR-7 bullet 1: "one lost relay candidate on a lossy
// link is a call that never connects"), and the round-4 watermark deleted them on
// arrival: not applied, not queued, not logged. At the moment one arrives it is
// genuinely indistinguishable from a straggler, so the fix cannot be a smarter
// test — it has to stop destroying the evidence. They are parked until a
// negotiation claims them by epoch.

await section('RELOAD: candidates that beat the reloaded peer\'s offer are not eaten by the watermark', async () => {
  FakePC.reset();
  const { voice } = makeVoice({ selfId: 'zzz' });    // 'zzz' > 'bbb' → we answer
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o1', epoch: 4 } });
  await tick();
  FakePC.created[0]._conn('failed');
  eq(deadEpochOf(voice, 'bbb'), 4, 'the epoch it died on is watermarked');

  // The peer reloads in place: same id, still in our roster (so nothing clears the
  // watermark), fresh page, epoch counter back at 1.
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('reload-1', 1) });
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('reload-2', 1) });
  ok(FakePC.created.length === 1, 'a bare candidate at/below the watermark still builds no connection');
  eq(parkedOf(voice, 'bbb'), { epoch: 1, cands: ['reload-1', 'reload-2'] }, 'but they are parked, not discarded');

  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o-reload', epoch: 1 } });
  await tick();
  const pcB = FakePC.created[1];
  ok(!!pcB && voice._pcs.get('bbb')?.pc === pcB, 'the restarted epoch-1 offer is answered');
  eq(pcB ? applied(pcB) : '(no PC was built)', ['reload-1', 'reload-2'],
    'and the candidates that beat it through the relay reach it, in arrival order');
  eq(parkedOf(voice, 'bbb'), '(no park)', 'the park is drained');
  eq(voice.debugApi().parkedIce(), [], 'and the debug view reports it (headset diagnosis)');
});

await section('the park is bounded, like the per-entry queue', async () => {
  FakePC.reset();
  const { voice } = makeVoice({ selfId: 'zzz' });
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o1', epoch: 9 } });
  await tick();
  FakePC.created[0]._conn('failed');                 // watermark 9
  // Same threat as the pre-SDP queue in B, one layer earlier: a peer that trickles
  // for ever and never offers must not be able to grow this without limit.
  for (let i = 0; i < 200; i++) await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice(`c${i}`, 1) });
  const park = parkedOf(voice, 'bbb');
  eq(park.cands?.length, 64, 'a flood is capped at the same bound as the per-entry queue');
  eq(park.cands?.[63], 'c199', 'the newest candidate survives');
  eq(park.cands?.[0], 'c136', 'the oldest candidates are the ones dropped');
});

await section('…while a straggler from the dead epoch is still never applied to anything', async () => {
  FakePC.reset();
  const { voice } = makeVoice({ selfId: 'zzz' });
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o1', epoch: 4 } });
  await tick();
  FakePC.created[0]._conn('failed');
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('stale', 4) });
  ok(FakePC.created.length === 1, 'the straggler builds nothing');

  // The peer did NOT reload — it just negotiated again, so its next epoch is a
  // different number. The parked straggler belongs to no live negotiation and is
  // dropped when that one starts, rather than lingering until some later epoch
  // happens to collide with it.
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o2', epoch: 5 } });
  await tick();
  const pcB = FakePC.created[1];
  eq(pcB ? applied(pcB) : '(no PC was built)', [], "the dead epoch's candidate never reaches the new connection");
  eq(voice._pcs.get('bbb')?.pendingIce.length, 0, 'nor is it parked in the new queue for later');
  eq(parkedOf(voice, 'bbb'), '(no park)', 'and it is not held for ever either');
});

await section('the park holds one negotiation, not a pile of them', async () => {
  FakePC.reset();
  const { voice } = makeVoice({ selfId: 'zzz' });
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o1', epoch: 4 } });
  await tick();
  FakePC.created[0]._conn('failed');                 // watermark 4
  // A straggler from the dead negotiation, and then the reloaded peer's first
  // candidate. Both are below the watermark, both are parked — but they belong to
  // DIFFERENT negotiations, and only one of them has an offer coming.
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('dead-epoch-4', 4) });
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('reload-epoch-1', 1) });
  eq(parkedOf(voice, 'bbb'), { epoch: 1, cands: ['reload-epoch-1'] },
    'the later negotiation replaces the earlier park rather than being lumped in with it');

  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o-reload', epoch: 1 } });
  await tick();
  const pcB = FakePC.created[1];
  eq(pcB ? applied(pcB) : '(no PC was built)', ['reload-epoch-1'],
    'so the epoch-4 straggler cannot ride into the epoch-1 negotiation on its coat-tails');
});

await section('a peer that LEAVES does not bring its parked candidates back with it', async () => {
  FakePC.reset();
  const { voice } = makeVoice({ selfId: 'zzz' });
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o1', epoch: 4 } });
  await tick();
  FakePC.created[0]._conn('failed');
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('from-old-session', 1) });
  eq(parkedOf(voice, 'bbb'), { epoch: 1, cands: ['from-old-session'] }, 'a candidate is parked');

  voice.syncPeers(['zzz']);                          // the peer left the room
  eq(parkedOf(voice, 'bbb'), '(no park)', 'leaving clears the park, as it clears the watermark');
  // Both sessions mint epochs from 1, so without that clear the previous session's
  // candidate would match the new negotiation's epoch and be injected into it —
  // ICE credentials from a connection that no longer exists, which is the exact
  // corruption the epoch protocol is for.
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o-rejoin', epoch: 1 } });
  await tick();
  const pcB = FakePC.created[1];
  ok(!!pcB && voice._pcs.get('bbb')?.pc === pcB, 'the rejoined peer is answered');
  eq(pcB ? applied(pcB) : '(no PC was built)', [], 'and nothing from its previous session is applied to it');
});

await section('NEGATIVE CONTROL: dropping those candidates instead of parking them loses the call', async () => {
  FakePC.reset();
  const { voice } = makeVoice({ selfId: 'zzz' });
  // The round-4 line, restored at the one point that changed: the watermark
  // branch returned and the candidate simply ceased to exist.
  voice._parkIce = () => { /* discarded on arrival, as before */ };
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o1', epoch: 4 } });
  await tick();
  FakePC.created[0]._conn('failed');
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('reload-1', 1) });
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('reload-2', 1) });
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o-reload', epoch: 1 } });
  await tick();
  const pcB = FakePC.created[1];
  ok(!!pcB, 'CONTROL: the offer itself is still answered (it is exempt)');
  eq(pcB ? applied(pcB) : '(no PC was built)', [],
    "CONTROL: every candidate of the reloaded peer's new negotiation is gone — not applied, not queued");
});

await section('a later teardown at a LOWER epoch does not lower the watermark', async () => {
  FakePC.reset();
  const { voice } = makeVoice({ selfId: 'zzz' });
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o1', epoch: 5 } });
  await tick();
  FakePC.created[0]._conn('failed');
  eq(deadEpochOf(voice, 'bbb'), 5, 'watermarked at the epoch that died');

  // An offer is exempt from the watermark, so a stale one really does build a PC —
  // here at epoch 3. When THAT one dies, the watermark must not fall back to 3:
  // the epoch-4/5 leftovers of the connection that died first are still in flight.
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o-old', epoch: 3 } });
  await tick();
  eq(voice._pcs.get('bbb')?.remoteEpoch, 3, 'the exempt offer is answered at its own epoch');
  FakePC.created[1]._conn('failed');
  eq(deadEpochOf(voice, 'bbb'), 5, 'the watermark stays at the highest epoch ever torn down');

  const built = FakePC.created.length;
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('epoch-4-straggler', 4) });
  eq(FakePC.created.length, built, 'so an epoch-4 straggler still cannot open a connection');
  ok(!voice._pcs.has('bbb'), 'and nothing is left in the map for syncPeers() to skip');
});

await section('disable() forgets the watermarks and the park', async () => {
  FakePC.reset();
  const { voice } = makeVoice({ selfId: 'zzz' });
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o1', epoch: 4 } });
  await tick();
  FakePC.created[0]._conn('failed');
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('parked', 1) });
  eq(deadEpochOf(voice, 'bbb'), 4, 'a watermark exists while running');
  eq(parkedOf(voice, 'bbb'), { epoch: 1, cands: ['parked'] }, 'and so does a park');

  voice.disable();
  // disable() closes every PC, and _closePeer() WRITES a watermark — so this also
  // pins that the clear happens after the teardown, not before it.
  eq(deadEpochOf(voice, 'bbb'), '(no watermark)', 'disable() drops every watermark');
  eq(parkedOf(voice, 'bbb'), '(no park)', 'and every parked candidate');

  // Voice off and on again is a fresh mesh: the peer is treated as brand new, so
  // its next candidate opens the answering connection instead of being held
  // against a watermark from a session that is over.
  voice.enabled = true;
  voice.localStream = { getTracks: () => [{ kind: 'audio', stop() {} }] };
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('after-reenable', 1) });
  ok(voice._pcs.has('bbb'), 're-enabled, the peer starts from nothing again');
});

await section('ANSWERER: an offer is never rejected as stale, even during our own backoff', async () => {
  FakePC.reset();
  const { voice, sent, clock } = makeVoice({ selfId: 'zzz' });
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o1', epoch: 4 } });
  await tick();
  FakePC.created[0]._conn('failed');
  ok(clock.ms < backoffOf(voice, 'bbb').notBefore, 'our own backoff window is running');
  // The offerer is the only side that can start a negotiation, so an inbound
  // offer deliberately bypasses _mayRebuild() — refusing it here would deadlock
  // the pair for as long as our backoff lasts (and forever, once flattened).
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o2', epoch: 5 } });
  await tick();
  ok(FakePC.created.length === 2 && voice._pcs.get('bbb')?.pc === FakePC.created[1], 'the new offer is answered during the backoff');
  eq(sent.filter((m) => m.kind === 'answer').length, 2, 'and we really answered it');
  eq(backoffOf(voice, 'bbb').attempts, '(no backoff)', 'a fresh negotiation retires the penalty our dead PC earned');
});

// === J. The reload case with our entry still LIVE (round 6) ===============
// Section H covers a reloaded peer whose signals land while our entry is ABSENT
// (the backoff window). The same peer reloading while our answering entry is
// still in the map hits a different gate — the live-entry epoch comparison — and
// that one dropped everything below the epoch we were talking to, offers
// included. A reloaded peer mints epochs from 1 again, so "lower" is exactly what
// its first offer looks like. Nothing errors on either side when it is dropped,
// which is why this was silent: no failure event, no rebuild, no log.

await section('RELOAD: a LOWER-epoch offer rebuilds the live answering PC, and its early candidates are parked', async () => {
  FakePC.reset();
  const { voice, sent } = makeVoice({ selfId: 'zzz' });   // 'zzz' > 'bbb' → we answer
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o1', epoch: 4 } });
  await tick();
  const pcA = FakePC.created[0];
  eq(voice._pcs.get('bbb')?.remoteEpoch, 4, 'we are answering a live epoch-4 negotiation');

  // The peer reloads in place. Its first candidates beat its offer through the
  // relay, carrying the restarted number.
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('reload-1', 1) });
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('reload-2', 1) });
  eq(applied(pcA), [], 'a lower-epoch candidate is never applied to the live PC');
  ok(!pcA.closed, 'nor does a bare candidate tear that PC down');
  ok(FakePC.created.length === 1, 'and it builds nothing of its own');
  eq(parkedOf(voice, 'bbb'), { epoch: 1, cands: ['reload-1', 'reload-2'] },
    'it is parked against the epoch it claims, not deleted');

  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o-reload', epoch: 1 } });
  await tick();
  const pcB = FakePC.created[1];
  ok(pcA.closed, 'the lower-epoch OFFER tears down the PC the peer no longer has');
  ok(!!pcB && voice._pcs.get('bbb')?.pc === pcB, 'and a fresh PC answers the restarted negotiation');
  eq(voice._pcs.get('bbb')?.remoteEpoch, 1, 'recorded at the restarted epoch');
  eq(roleOf(voice, 'bbb'), false, 'the glare rule still leaves us the answerer');
  eq(pcB ? applied(pcB) : '(no PC was built)', ['reload-1', 'reload-2'],
    'the parked candidates reach it, in arrival order');
  eq(parkedOf(voice, 'bbb'), '(no park)', 'and the park is drained');
  eq(sent.filter((m) => m.kind === 'answer').pop()?.data.epoch, 1,
    "our answer mirrors the restarted epoch back, so the peer's gate accepts it");
});

await section('NEGATIVE CONTROL: dropping the lower-epoch offer leaves the pair permanently silent', async () => {
  FakePC.reset();
  const { voice, sent } = makeVoice({ selfId: 'zzz' });
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o1', epoch: 4 } });
  await tick();
  const pcA = FakePC.created[0];
  const answersBefore = sent.filter((m) => m.kind === 'answer').length;

  // Restore the pre-round-6 gate at the one point that changed: on the answering
  // side, ANY signal below the epoch we hold is dropped outright — offer, answer
  // and candidate alike. (Applied as a pre-filter rather than by editing the
  // branch, because the branch is mid-method; the observable effect is identical.)
  const inner = voice.handleSignal.bind(voice);
  voice.handleSignal = async (msg) => {
    const e = voice._pcs.get(msg.from);
    const ep = Number(msg.data?.epoch) || 0;
    if (e && ep && !e.initiator && e.remoteEpoch && ep < e.remoteEpoch) return;
    return inner(msg);
  };

  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('reload-1', 1) });
  eq(parkedOf(voice, 'bbb'), '(no park)', 'the reloaded peer\'s candidate is destroyed on arrival');
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o-reload', epoch: 1 } });
  await tick();
  ok(FakePC.created.length === 1, 'its offer builds nothing');
  ok(!pcA.closed && voice._pcs.get('bbb')?.pc === pcA, 'we keep answering into a PC the peer has thrown away');
  eq(sent.filter((m) => m.kind === 'answer').length, answersBefore, 'and we send no answer, so the peer waits for ever');

  // And it never recovers by itself: the peer can retry as often as it likes, and
  // nothing on our side fails, so no rebuild is ever scheduled.
  for (let i = 0; i < 5; i++) await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: `retry-${i}`, epoch: 1 } });
  await tick();
  eq(sent.filter((m) => m.kind === 'answer').length, answersBefore, 'five more offers change nothing');
  eq(backoffOf(voice, 'bbb').attempts, '(no backoff)', 'and nothing ever registered a failure to retry from');
});

await section('a parked candidate is still only adopted by the negotiation that claims it', async () => {
  FakePC.reset();
  const { voice } = makeVoice({ selfId: 'zzz' });
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o1', epoch: 4 } });
  await tick();

  // A genuine straggler from a negotiation that is over — same shape as the
  // reloaded peer's first candidate, and indistinguishable from it here.
  await voice.handleSignal({ from: 'bbb', kind: 'ice', data: ice('straggler', 3) });
  eq(parkedOf(voice, 'bbb'), { epoch: 3, cands: ['straggler'] }, 'parked, because it cannot be told apart yet');

  // The peer did not reload — it renegotiated, so its next offer carries a NEW
  // number. That resolves the ambiguity: the parked candidate belongs to nothing
  // live and is dropped when this negotiation starts, not carried into it.
  await voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o2', epoch: 6 } });
  await tick();
  const pcB = FakePC.created[1];
  eq(pcB ? applied(pcB) : '(no PC was built)', [], 'the straggler never reaches the new connection');
  eq(voice._pcs.get('bbb')?.pendingIce.length, 0, 'nor is it queued for it');
  eq(parkedOf(voice, 'bbb'), '(no park)', 'and it is not held for ever either');
});

// === I. The SENDING half of the epoch protocol ============================
// Every inbound signal in this file is hand-written, so nothing here used to
// exercise pc.onicecandidate at all: the outgoing stamp could be deleted, or set
// to any nonsense, with the whole suite still green.

await section('outgoing ICE candidates carry the epoch of the PC that gathered them', async () => {
  FakePC.reset();
  const { voice, sent, clock } = makeVoice({ selfId: 'aaa' });   // offerer
  voice.syncPeers(['aaa', 'bbb']);
  await tick();
  const pc1 = FakePC.created[0];
  pc1._candidate('host-1');
  const out1 = sent.filter((m) => m.kind === 'ice').pop();
  eq(out1?.data.candidate, 'host-1', 'the candidate itself is serialised through toJSON()');
  eq(out1?.data.epoch, 1, 'the offerer stamps the epoch it minted');

  pc1._conn('failed');
  clock.ms = 1001;
  voice.syncPeers(['aaa', 'bbb']);
  await tick();
  FakePC.created[1]._candidate('host-2');
  eq(sent.filter((m) => m.kind === 'ice').pop()?.data.epoch, 2, 'the rebuilt PC stamps its NEW epoch');
  // A dead PC can still deliver a gathered candidate for a moment. It must keep
  // stamping the DEAD number, or the peer's epoch gate would wave it onto the
  // live connection — which is the whole point of the protocol.
  pc1._candidate('late-from-dead');
  eq(sent.filter((m) => m.kind === 'ice').pop()?.data.epoch, 1, 'a late candidate from the dead PC still carries epoch 1');

  // The answering side. This used to assert that a PC which predates the offer
  // stamps epoch 0 — a state a real RTCPeerConnection cannot be in: gathering
  // starts at setLocalDescription(), and an answering PC that has not received an
  // offer has no local description, so onicecandidate never fires there. FakePC
  // now models that (see _candidate), so what is pinned is the real behaviour:
  // nothing is emitted at all until we have answered, and from then on the
  // offerer's epoch is mirrored.
  FakePC.reset();
  const b = makeVoice({ selfId: 'zzz' });
  b.voice.syncPeers(['zzz', 'bbb']);
  ok(FakePC.created[0]._candidate('early') === false,
    'an answering PC with no local description gathers nothing (no setLocalDescription → no onicecandidate)');
  eq(b.sent.filter((m) => m.kind === 'ice').length, 0, 'so it sends no candidate before the offer arrives');
  await b.voice.handleSignal({ from: 'bbb', kind: 'offer', data: { type: 'offer', sdp: 'o', epoch: 9 } });
  await tick();
  FakePC.created[0]._candidate('after');
  eq(b.sent.filter((m) => m.kind === 'ice').pop()?.data.epoch, 9, "and mirrors the offerer's epoch once it has one");
});

// === F. Regressions the recovery work must not break ======================

await section('unchanged guarantees', async () => {
  FakePC.reset();
  const { voice } = makeVoice({ selfId: 'zzz' });
  await voice.handleSignal({ from: 'bbb', kind: 'bye', data: {} });
  ok(FakePC.created.length === 0, "a stray 'bye' still opens no connection (NEGOTIATION_KINDS gate)");

  voice.syncPeers(['zzz', 'bbb']);
  ok(voice._pcs.has('bbb'), 'a roster peer connects');
  voice.syncPeers(['zzz']);
  ok(!voice._pcs.has('bbb'), 'a peer that left is closed');
  ok(FakePC.created[0].closed, 'and its PC is closed');
  eq(voice.debugApi().retries(), [], 'leaving is not a failure — no backoff penalty');

  voice.syncPeers(['zzz', 'bbb']);
  voice.disable();
  ok(voice._pcs.size === 0 && voice.enabled === false, 'disable() tears everything down');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
