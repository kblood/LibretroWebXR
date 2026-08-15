// Unit tests for src/TestApi.js — the automation facade's own contract.
//
// TestApi.js is deliberately import-free and dependency-injected, so the parts
// that every headless test depends on (the dispatcher's result shape, the error
// codes, capability gating, the structured-clone sanitiser, the correlation
// maths) are testable in plain Node with fakes. The BROWSER behaviour is proved
// by scripts/demo-automation-api.mjs; this file guards the contract that sits
// between the two.
//
// Run: node scripts/test-testapi.mjs   (part of `npm test`)

import assert from 'node:assert/strict';
import { createTestApi, correlate, TestApiError, TEST_API_VERSION } from '../src/TestApi.js';
// Imported ONLY so the frame-counter fake below can be pinned to the real class
// (see 'the FrameBridge fake matches the real accessor').
import { FrameBridge } from '../src/runtime/FrameBridge.js';

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

// --- fakes -----------------------------------------------------------------
function fakeNet({ connected = true, isHost = true, serverElects = true } = {}) {
  const store = new Map();
  return {
    connected,
    room: 'testroom',
    sessionId: 'sid-1',
    _serverElects: serverElects,
    presence: { selfId: 'self', size: 1, peers: () => [{ id: 'other', nick: 'Other' }] },
    hostId: () => (isHost ? 'self' : 'other'),
    isHost: () => isHost,
    objects: { entries: () => [...store.entries()], ownerOf: () => 'self', get: (k) => store.get(k) ?? null },
    getObjectState: (k) => store.get(k) ?? null,
    setObjectState: (k, v) => { store.set(k, v); return true; },
    sendWire: (ch, data) => ({ ch, data }),
    forwardGameInput: () => true,
    debugApi: () => ({ recvInputs: () => [{ from: 'other', player: 2, btn: 'Up', down: true }] }),
  };
}

function fakeRuntime(id, { loaded = true, paused = false, frames = 0 } = {}) {
  return {
    id, coreName: 'fceumm', system: 'nes', title: 'Test',
    isLoaded: () => loaded, isLive: () => !paused, runAllowed: () => true,
    canvas: null,
    client: { frameBridge: { snapshot: () => ({ framesPresented: frames }) } },
    sendInput: () => true,
  };
}

// ---------------------------------------------------------------------------
console.log('TestApi');

await test(`exports a version (${TEST_API_VERSION})`, () => {
  assert.equal(typeof TEST_API_VERSION, 'number');
});

await test('call() resolves {ok:true,value} and never rejects on success', async () => {
  const api = createTestApi({ clientKind: 'vr', net: () => fakeNet() });
  const res = await api.call('session.isHost');
  assert.deepEqual(res, { ok: true, value: true });
});

await test('call() turns a thrown TestApiError into {ok:false,error:{code}}', async () => {
  const api = createTestApi({ clientKind: 'vr', net: () => null });
  const res = await api.call('session.objectState', ['tv']);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'unsupported');
  assert.match(res.error.message, /room session/);
});

await test('call() reports not-connected separately from unsupported', async () => {
  const api = createTestApi({ clientKind: 'vr', net: () => fakeNet({ connected: false }) });
  const res = await api.call('session.objectState', ['tv']);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'not-connected');
});

await test('call() on an unknown path is no-such-method, not a crash', async () => {
  const api = createTestApi({ clientKind: 'vr' });
  const res = await api.call('nope.nothing');
  assert.equal(res.error.code, 'no-such-method');
  const res2 = await api.call(null);
  assert.equal(res2.error.code, 'no-such-method');
});

await test('namespaced methods throw TestApiError (devtools ergonomics)', async () => {
  const api = createTestApi({ clientKind: 'vr', net: () => null });
  await assert.rejects(async () => api.session.objectState('tv'), (e) => {
    assert.ok(e instanceof TestApiError);
    assert.equal(e.code, 'unsupported');
    return true;
  });
});

await test('methods() lists every dotted path and stays stable', () => {
  const api = createTestApi({ clientKind: 'vr' });
  const m = api.methods();
  for (const p of ['session.join', 'session.leave', 'session.becomeHost', 'props.move',
    'input.press', 'content.insert', 'rack.running', 'tv.sample', 'tv.profile',
    'video.progress', 'room.published']) {
    assert.ok(m.includes(p), `missing ${p}`);
  }
  assert.deepEqual(m, [...m].sort(), 'methods() must be sorted');
});

await test('supports()/capabilities() gate on injected subsystems, not on names', () => {
  const full = createTestApi({ clientKind: 'vr', net: () => fakeNet(), props: {}, rack: () => ({}) });
  const bare = createTestApi({ clientKind: 'desktop', net: () => fakeNet() });
  assert.equal(full.supports('props.list'), true);
  assert.equal(bare.supports('props.list'), false, 'a client without props must not claim support');
  assert.equal(bare.supports('session.join'), true);
  assert.equal(bare.capabilities().props, false);
  assert.equal(bare.capabilities().session, true);
});

await test('becomeHost() refuses to fake a promotion in a server-elected room', async () => {
  const api = createTestApi({
    clientKind: 'vr',
    net: () => fakeNet({ isHost: false, serverElects: true }),
    amRoomHost: () => false,
  });
  const res = await api.call('session.becomeHost', [{ timeoutMs: 50 }]);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'host-not-eligible');
  assert.equal(res.error.detail.hostId, 'other');
});

await test('becomeHost() claims the fallback election when the server does not elect', async () => {
  const net = fakeNet({ isHost: false, serverElects: false });
  let host = false;
  const api = createTestApi({
    clientKind: 'vr',
    net: () => net,
    amRoomHost: () => host,
    fallbackHostKey: 'hostClaim',
  });
  setTimeout(() => { host = true; }, 30);
  const res = await api.call('session.becomeHost', [{ timeoutMs: 3000 }]);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.value.via, 'fallback-claim');
  assert.equal(net.getObjectState('hostClaim').id, 'self');
});

await test('becomeHost() is a no-op when we already are the host', async () => {
  const api = createTestApi({ clientKind: 'vr', net: () => fakeNet(), amRoomHost: () => true });
  const res = await api.call('session.becomeHost');
  assert.equal(res.value.via, 'already-host');
});

await test('the FrameBridge fake matches the real accessor', () => {
  // This fake used to expose `stats()`, and TestApi read `stats()` — so the pair
  // agreed with each other and with nothing that ships. The real class has only
  // snapshot(), so every worker-hosted runtime reported frames:null and
  // rack.running() could never observe motion on the one path that HAS a frame
  // counter. Two green tests, zero coverage. Pin them together.
  assert.equal(typeof FrameBridge.prototype.snapshot, 'function', 'FrameBridge exposes snapshot()');
  assert.equal(FrameBridge.prototype.stats, undefined, 'and no stats() — the name the fake invented');
  const fb = fakeRuntime('console0', { frames: 3 }).client.frameBridge;
  assert.equal(typeof fb.snapshot, 'function', 'so the fake exposes snapshot() as well');
  assert.equal(fb.stats, undefined, 'and only that');
  assert.equal(fb.snapshot().framesPresented, 3, 'returning the same shape the real one does');
});

await test('rack.running() requires MOTION, not just !paused', async () => {
  // A loaded, unpaused console whose frame counter never moves is NOT running.
  // This is the exact false positive (`window.__client.paused === false`) that
  // made earlier multiplayer tests vacuously green.
  const stuck = fakeRuntime('console0', { frames: 7 });
  const api = createTestApi({
    clientKind: 'vr',
    rack: () => ({ runtimes: () => [stuck] }),
  });
  const res = await api.call('rack.running', [{ ms: 5 }]);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const [c] = res.value;
  assert.equal(c.live, true, 'the console is unpaused…');
  assert.equal(c.running, false, '…but must NOT be reported as running');
  assert.equal(c.framesDelta, 0);
});

await test('rack.running() reports running when frames advance', async () => {
  let frames = 0;
  const live = fakeRuntime('console0');
  live.client = { frameBridge: { snapshot: () => ({ framesPresented: frames }) } };
  const api = createTestApi({ clientKind: 'vr', rack: () => ({ runtimes: () => [live] }) });
  const p = api.call('rack.running', [{ ms: 40 }]);
  setTimeout(() => { frames = 12; }, 10);
  const res = await p;
  assert.equal(res.value[0].running, true);
  assert.ok(res.value[0].framesDelta > 0);
});

await test('input.press auto-routes over the net when we are not the host', async () => {
  const sent = [];
  const net = fakeNet({ isHost: false });
  net.forwardGameInput = (m) => { sent.push(m); return true; };
  const api = createTestApi({
    clientKind: 'vr', net: () => net, amRoomHost: () => false,
    gameInput: () => ({ setRemoteButton: () => { throw new Error('must not inject locally'); } }),
    nextFrame: () => Promise.resolve(true),
  });
  const res = await api.call('input.press', ['Up', { player: 2 }]);
  assert.equal(res.value.via, 'net');
  assert.deepEqual(sent, [{ player: 2, btn: 'Up', down: true }]);
});

await test('input.press injects locally when we ARE the host', async () => {
  const injected = [];
  const api = createTestApi({
    clientKind: 'vr', net: () => fakeNet(), amRoomHost: () => true,
    gameInput: () => ({ setRemoteButton: (ev) => injected.push(ev) }),
    nextFrame: () => Promise.resolve(true),
  });
  const res = await api.call('input.press', ['Down', { player: 1, consoleId: 'console0' }]);
  assert.equal(res.value.via, 'local');
  assert.deepEqual(injected, [{ player: 1, btn: 'Down', down: true, consoleId: 'console0' }]);
});

await test('input.press honours an explicit route override', async () => {
  const injected = [];
  const net = fakeNet({ isHost: false });
  const api = createTestApi({
    clientKind: 'vr', net: () => net, amRoomHost: () => false,
    gameInput: () => ({ setRemoteButton: (ev) => injected.push(ev) }),
    nextFrame: () => Promise.resolve(true),
  });
  const res = await api.call('input.press', ['Down', { player: 2, route: 'local' }]);
  assert.equal(res.value.via, 'local');
  assert.equal(injected.length, 1);
});

await test('props.move runs the REAL release callback and reports the settled pose', async () => {
  const object = {
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    rotation: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    updateMatrixWorld() {},
    userData: { kind: 'poster' },
  };
  const entries = new Map([['p1', { prop: { id: 'p1', type: 'poster' }, object }]]);
  let released = 0;
  const api = createTestApi({
    clientKind: 'vr',
    net: () => null,
    nextFrame: () => Promise.resolve(true),
    props: {
      entries: () => entries,
      // Stand in for the editor's surface snap: the app is allowed to move the
      // prop on release, and the facade must report where it ENDED UP.
      editRelease: (o) => { released++; o.position.set(o.position.x, o.position.y, -3.9); },
      serialize: () => ({}),
      isStatic: () => false,
      holdKeyFor: () => null,
    },
  });
  const res = await api.call('props.move', ['p1', [1, 2, 3]]);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(released, 1, 'must go through the app release path exactly once');
  assert.deepEqual(res.value.pos, [1, 2, -3.9], 'reports the snapped pose, not the requested one');
});

await test('props.get on an unknown id is not-found with the known ids attached', async () => {
  const api = createTestApi({ clientKind: 'vr', props: { entries: () => new Map([['a', {}]]) } });
  const res = await api.call('props.get', ['zzz']);
  assert.equal(res.error.code, 'not-found');
  assert.deepEqual(res.error.detail.known, ['a']);
});

await test('content.insert resolves a shelf ref by file, title, or substring', async () => {
  const inserted = [];
  const shelf = [{ file: 'lwx-nes-pong.nes', title: 'LWX Pong', system: 'nes', core: 'fceumm' }];
  const api = createTestApi({
    clientKind: 'vr',
    content: { shelf: () => shelf, insert: (m) => inserted.push(m) },
  });
  assert.equal((await api.call('content.insert', ['lwx-nes-pong.nes'])).ok, true);
  assert.equal((await api.call('content.insert', ['LWX Pong'])).ok, true);
  assert.equal((await api.call('content.insert', ['nes-pong'])).ok, true);
  assert.equal(inserted.length, 3);
  assert.equal(inserted[0].core, 'fceumm');
  const miss = await api.call('content.insert', ['not-a-game']);
  assert.equal(miss.error.code, 'not-found');
});

await test('content.insert targets a specific console id', async () => {
  const inserted = [];
  const api = createTestApi({
    clientKind: 'vr',
    content: { shelf: () => [{ file: 'a.nes', core: 'fceumm', system: 'nes' }], insert: (m) => inserted.push(m) },
  });
  await api.call('content.insert', ['a.nes', { consoleId: 'console1' }]);
  assert.equal(inserted[0].consoleId, 'console1');
});

await test('a wait* method that never satisfies reports code:timeout', async () => {
  const api = createTestApi({
    clientKind: 'vr',
    props: { entries: () => new Map() },
  });
  const res = await api.call('props.waitForProp', ['nope', { timeoutMs: 40 }]);
  assert.equal(res.error.code, 'timeout');
});

await test('session.recvInputs surfaces the host-side relay log', async () => {
  const api = createTestApi({ clientKind: 'vr', net: () => fakeNet() });
  const res = await api.call('session.recvInputs');
  assert.equal(res.value[0].btn, 'Up');
});

await test('the sanitiser keeps plain data and drops what cannot be cloned', async () => {
  const cyclic = { a: 1 }; cyclic.self = cyclic;
  const api = createTestApi({
    clientKind: 'vr',
    roomDescriptor: () => ({ name: 'r', props: [1, 2], fn() {}, cyclic, three: { isObject3D: true, name: 'TV' } }),
  });
  const res = await api.call('room.descriptor');
  assert.equal(res.ok, true);
  assert.equal(res.value.name, 'r');
  assert.equal(res.value.props, 2);
  assert.equal(res.value.raw.fn, undefined, 'functions must be dropped');
  assert.equal(res.value.raw.three.object3D, 'TV', 'THREE objects become an identity stub');
  // The cycle must not throw or hang.
  assert.ok(typeof res.value.raw.cyclic === 'object');
  assert.equal(JSON.stringify(res.value).length > 0, true);
});

await test('correlate(): 1 for identical, ~-1 for inverted, null for flat', () => {
  const a = [1, 2, 3, 4, 5];
  assert.ok(Math.abs(correlate(a, a) - 1) < 1e-9);
  assert.ok(correlate(a, [5, 4, 3, 2, 1]) < -0.99);
  assert.equal(correlate(a, [1, 1, 1, 1, 1]), null, 'a flat signature carries no evidence');
  assert.equal(correlate(a, [1, 2]), null, 'length mismatch → null');
  assert.equal(correlate(null, a), null);
});

await test('ready() rejects with code:timeout rather than hanging forever', async () => {
  const api = createTestApi({ clientKind: 'vr', ready: () => new Promise(() => {}) });
  const res = await api.call('ready', [{ timeoutMs: 30 }]);
  assert.equal(res.error.code, 'timeout');
});

console.log(`\n${process.exitCode ? 'FAIL' : 'PASS'} — ${passed} checks`);
