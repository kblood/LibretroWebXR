// COR-5 (CODEX_REVIEW): retiring a console must actually RELEASE it.
//
// What shipped: ConsoleRuntime.dispose() paused the core and detached its
// canvas, and that was all. So every core swap (a gun/mouse arm-reboot, a
// cross-core drop on a rack console, a live primary reboot) left behind:
//   • the Worker of a worker-execution core, holding its whole Wasm memory —
//     the local manifests declare 512 MiB initial for PSX and 256 MiB for N64,
//     on a headset;
//   • that console's SpatialAudio branch, since branches were append-only;
//   • and, if the replacement's own boot threw, the half-built runtime too.
// RackMgr.maxLive bounded REGISTERED consoles, never accumulated heaps.
//
// WHAT WOULD MAKE THIS TEST WORTHLESS, and what is done about it:
//   • "dispose() calls stop()" is not the claim. The claim is that the resources
//     are gone: the worker terminated, the frame bridge disposed, the branch
//     unlinked from the graph. Assertions go through those observables.
//   • A teardown that fires on EVERYTHING would pass a naive suite and break a
//     running console — so every teardown assertion is paired with the case that
//     must NOT tear down (a core-reported error, a successor's audio branch).
//   • The 60s stop is a TIMING bug; asserting "stop resolves" cannot catch it.
//     It is measured against the request timeout instead.
//
// Pure logic: THREE runs headless, the Web Audio graph is a fake whose nodes
// record their own connect/disconnect, and the Worker is the FakeWorker pattern
// from test/runtime.test.js.
//
// Run: node scripts/test-runtime-dispose.mjs   (also in `npm test`)

import * as THREE from 'three';
import { ConsoleRuntime } from '../src/ConsoleRuntime.js';
import { WorkerEmulatorClient } from '../src/runtime/WorkerEmulatorClient.js';
import { installSpatialAudio } from '../src/SpatialAudio.js';

let passed = 0;
let failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const section = async (name, fn) => {
  console.log(`--- ${name} ---`);
  try { await fn(); } catch (e) { failed++; console.error(`  FAIL: section "${name}" threw — ${e.stack || e.message}`); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));

// A rejected lifecycle promise that nobody handles is an uncaught PAGE ERROR in
// the browser — PERF-2's failed-boot soak surfaced four of them, one per failed
// boot, all from pausing a client whose worker had already gone. Record them
// here instead of letting Node abort, and assert at the end that this suite
// produced none.
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(String(reason?.message || reason)));

// --- fakes ------------------------------------------------------------------

// A Web Audio node that remembers what it is wired to, so a test can ask the
// GRAPH whether a branch was really unlinked rather than trusting a flag.
function fakeNode(type) {
  return {
    type,
    outputs: [],
    gain: { value: 1 },
    connect(target) { this.outputs.push(target); return target; },
    disconnect(target) {
      if (target) this.outputs = this.outputs.filter((o) => o !== target);
      else this.outputs.length = 0;
    },
  };
}

function fakeAudioContext() {
  return {
    currentTime: 0,
    state: 'running',
    createGain: () => fakeNode('gain'),
    createPanner: () => Object.assign(fakeNode('panner'), {
      panningModel: '', distanceModel: '', refDistance: 1, maxDistance: 1,
      rolloffFactor: 1, coneInnerAngle: 360, coneOuterAngle: 0, coneOuterGain: 0,
      positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 },
      orientationX: { value: 0 }, orientationY: { value: 0 }, orientationZ: { value: 0 },
      setPosition() {}, setOrientation() {},
    }),
    createMediaStreamDestination: () => Object.assign(fakeNode('mediaStreamDestination'), { stream: { id: 'tap' } }),
    resume: () => Promise.resolve(),
  };
}

// installSpatialAudio replaces window.AudioContext and listens for the
// user-gesture resume, so give it just enough window to install into.
function withWindow(fn) {
  const previous = globalThis.window;
  globalThis.window = { AudioContext: function AudioContext() {}, addEventListener() {} };
  try { return fn(); } finally { globalThis.window = previous; }
}

function spatialAudio() {
  const ctx = fakeAudioContext();
  // Enough of a THREE.AudioListener for THREE.Audio's constructor: it reads
  // `.context` and connects its gain to `.getInput()`.
  const listener = { context: ctx, getInput: () => fakeNode('listener-input') };
  const defaultSource = new THREE.Object3D();
  return withWindow(() => ({
    ctx,
    defaultSource,
    router: installSpatialAudio({ listener, defaultSource }),
  }));
}

// A client that records the lifecycle calls made on it.
function fakeClient() {
  return {
    calls: [],
    paused: false,
    pause() { this.paused = true; this.calls.push('pause'); },
    resume() { this.paused = false; this.calls.push('resume'); },
    stop() { this.calls.push('stop'); return Promise.resolve(); },
  };
}

// A document stand-in for ConsoleRuntime's own-canvas mode.
function fakeDocument() {
  const body = { children: [], appendChild(c) { this.children.push(c); } };
  return {
    body,
    createElement: () => ({
      style: {}, width: 0, height: 0,
      removed: false,
      remove() { this.removed = true; body.children = body.children.filter((c) => c !== this); },
      getContext: () => ({ drawImage() {} }),
    }),
  };
}

// === A. ConsoleRuntime.dispose actually releases ============================

await section('dispose stops the client, drops the audio branch and the canvas', async () => {
  const { router } = spatialAudio();
  const doc = fakeDocument();
  const client = fakeClient();
  const runtime = new ConsoleRuntime({ id: 'console1', document: doc, audio: router });
  runtime.client = client;                       // stand in for the real client
  const tv = new THREE.Object3D();
  router.expect('console1', tv);
  router.ensureBranch('console1');
  runtime.noteLoaded('psx', { system: 'psx' });   // records which branch is ours

  eq(router.branches.length, 1, 'the console has an audio branch while it runs');
  const canvas = runtime.canvas;

  await runtime.dispose();
  ok(client.calls.includes('pause'), 'the core was paused');
  ok(client.calls.includes('stop'), 'and the client was STOPPED — the part that frees a worker');
  eq(router.branches.length, 0, 'its audio branch is gone from the graph');
  ok(canvas.removed === true, 'and its canvas is detached');
});

await section('dispose is idempotent', async () => {
  const { router } = spatialAudio();
  const client = fakeClient();
  const runtime = new ConsoleRuntime({ id: 'console1', document: fakeDocument(), audio: router });
  runtime.client = client;
  await runtime.dispose();
  await runtime.dispose();
  eq(client.calls.filter((c) => c === 'stop').length, 1, 'a second dispose does not stop twice');
});

await section('an ADOPTED runtime keeps the canvas it does not own', async () => {
  // The primary console adopts #canvas from main.js. Removing it would take the
  // element the whole app is built around out of the page.
  const { router } = spatialAudio();
  const canvas = { removed: false, remove() { this.removed = true; } };
  const client = fakeClient();
  const runtime = new ConsoleRuntime({ id: 'console0', adopt: { client, canvas }, audio: router });
  await runtime.dispose();
  ok(canvas.removed === false, 'the adopted canvas stays in the document');
  ok(client.calls.includes('stop'), 'but the client is still stopped');
});

await section('a retired runtime cannot take its SUCCESSOR\'s audio with it', async () => {
  // The real ordering: a replacement boots (and registers its own branch under
  // the same console id) BEFORE the old runtime is removed. An unguarded
  // removeBranch(id) there would silence the console that is now running.
  const { router } = spatialAudio();
  const tv = new THREE.Object3D();
  const oldRuntime = new ConsoleRuntime({ id: 'console1', document: fakeDocument(), audio: router });
  oldRuntime.client = fakeClient();
  router.expect('console1', tv);
  router.ensureBranch('console1');
  oldRuntime.noteLoaded('psx');

  // …the swap: the incumbent's registration is released (main.js's
  // bootFreshRuntime) and the new core registers its own branch under the id.
  router.detachBranch('console1');
  const newRuntime = new ConsoleRuntime({ id: 'console1', document: fakeDocument(), audio: router });
  newRuntime.client = fakeClient();
  router.expect('console1', tv);
  const fresh = router.ensureBranch('console1');
  newRuntime.noteLoaded('play');

  await oldRuntime.dispose();
  eq(router.branches.length, 1, 'the successor still has exactly one branch');
  ok(router.branchToken('console1') === fresh.token, 'and it is the successor\'s own');

  // NEGATIVE CONTROL: an unguarded removal (what removeBranch(id) with no token
  // does) takes the live console's audio out.
  router.removeBranch('console1');
  eq(router.branches.length, 0, 'without the token guard the live console goes silent');
});

// === B. SpatialAudio.removeBranch ==========================================

await section('removeBranch unlinks the branch from the audio graph', async () => {
  const { router } = spatialAudio();
  const tv = new THREE.Object3D();
  router.expect('console1', tv);
  const branch = router.ensureBranch('console1');
  const tap = router.captureStream('console1');           // netplay tap on the sink
  ok(!!tap, 'the branch had a netplay tap');
  ok(branch.positional.parent === tv, 'and its panner hangs off the TV');
  ok(branch.sink.outputs.length > 0, 'and its sink is connected to something');

  ok(router.removeBranch('console1') === true, 'removeBranch reports the removal');
  eq(branch.sink.outputs.length, 0, 'the sink is disconnected from everything');
  ok(branch.positional.parent === null, 'the panner is off the scene graph');
  ok(router.branchToken('console1') === null, 'and the console has no branch any more');
  ok(router.removeBranch('console1') === false, 'removing it again is a no-op, not a throw');
});

await section('a removed branch stops consuming pushed audio', async () => {
  const { router } = spatialAudio();
  const tv = new THREE.Object3D();
  router.expect('console1', tv);
  const branch = router.ensureBranch('console1');
  // pushSamples needs real buffer plumbing; stub the two calls it makes.
  router.context.createBuffer = (channels, frames) => ({
    duration: frames / 48000,
    getChannelData: () => new Float32Array(frames),
  });
  router.context.createBufferSource = () => Object.assign(fakeNode('bufferSource'), { buffer: null, start() { branch.started = (branch.started || 0) + 1; } });

  const samples = new Float32Array([0.1, 0.1, 0.2, 0.2]).buffer;
  router.pushSamples('console1', { samples });
  eq(branch.started, 1, 'audio pushed to a live console is scheduled');

  router.removeBranch('console1');
  router.pushSamples('console1', { samples });
  eq(branch.started, 1, 'audio pushed to a REMOVED console is dropped, not scheduled into a dead node');
});

// === B2. the boot-attempt window (PERF-2) ==================================
// A cross-core swap boots the replacement BEFORE retiring the incumbent, so
// there is a window in which the incumbent is still the console's running game
// while its console id has been handed to a boot that may yet fail. Everything
// here is about that window; the failed-boot soak
// (scripts/probe-swap-soak.mjs) is the same claims in a real browser.

// Give a router's context the two calls pushSamples makes, and report where
// audio actually landed by counting starts per branch.
function withPushablePlumbing(router) {
  router.context.createBuffer = (channels, frames) => ({
    duration: frames / 48000, getChannelData: () => new Float32Array(frames),
  });
  let current = null;
  router.context.createBufferSource = () => Object.assign(fakeNode('bufferSource'), {
    buffer: null, start() { if (current) current.started = (current.started || 0) + 1; },
  });
  // → true when the push actually reached `branch` and scheduled a buffer on it.
  return (branch, consoleId, token = null) => {
    const before = branch.started || 0;
    current = branch;
    router.pushSamples(consoleId, { samples: new Float32Array([0.1, 0.1]).buffer }, token);
    current = null;
    return (branch.started || 0) > before;
  };
}

await section('a detached branch keeps playing — it is still the console\'s game', async () => {
  const { router } = spatialAudio();
  const push = withPushablePlumbing(router);
  router.expect('console1', new THREE.Object3D());
  const incumbent = router.ensureBranch('console1');

  const detached = router.detachBranch('console1');
  ok(detached === incumbent, 'detachBranch hands back the branch it unregistered');
  ok(router.branchToken('console1') === null, 'the console id is free for the replacement');
  ok(router.branches.includes(incumbent), 'but the branch itself is still in the graph');
  ok(push(incumbent, 'console1', incumbent.token) === true, 'and audio addressed BY TOKEN still reaches it');
  // NEGATIVE CONTROL: addressed by console id alone — the pre-token lookup —
  // nothing is registered, so the incumbent would go silent for the whole boot.
  ok(push(incumbent, 'console1', null) === false, 'while a console-id lookup finds nothing to play into');

  ok(router.reattachBranch(detached) === true, 'reattachBranch restores the registration');
  ok(router.branchToken('console1') === incumbent.token, 'and the console answers to it again');
});

await section('a FAILED replacement gives the incumbent its audio back', async () => {
  // main.js's bootFreshRuntime, step for step, with a core that throws on boot.
  const { router } = spatialAudio();
  const tv = new THREE.Object3D();
  const incumbentRt = new ConsoleRuntime({ id: 'console1', document: fakeDocument(), audio: router });
  incumbentRt.client = fakeClient();
  router.expect('console1', tv);
  const incumbent = router.ensureBranch('console1');
  incumbentRt.noteLoaded('mupen64plus_next');

  const outgoing = router.detachBranch('console1');
  const next = new ConsoleRuntime({ id: 'console1', document: fakeDocument(), audio: router });
  next.client = { ...fakeClient(), start: () => Promise.reject(new Error('core died on boot')) };
  router.expect('console1', tv);
  let threw = null;
  try {
    await next.load(new ArrayBuffer(4), { name: 'fceumm', url: 'x', style: 'module' }, { execution: 'worker' });
  } catch (e) { threw = e; }
  ok(!!threw, 'the boot failed, as arranged');
  ok(next._audioToken != null, 'the half-booted runtime still knows which branch IT created');
  ok(next._audioToken !== incumbent.token, 'and it is not the incumbent\'s');

  router.reattachBranch(outgoing);
  await next.dispose();

  eq(router.branches.length, 1, 'exactly one branch survives the failed swap');
  ok(router.branchToken('console1') === incumbent.token, 'and it is the INCUMBENT\'s — the console is still audible');
  ok(incumbent.sink.outputs.length > 0, 'its sink is still wired into the graph');

  // NEGATIVE CONTROL: dispose the failed runtime WITHOUT handing the
  // registration back first — the shipped order before this fix — and the
  // running console loses its audio for the rest of the session.
  const control = spatialAudio().router;
  control.expect('console1', tv);
  const keep = control.ensureBranch('console1');
  control.detachBranch('console1');
  const bad = new ConsoleRuntime({ id: 'console1', document: fakeDocument(), audio: control });
  bad.client = { ...fakeClient(), start: () => Promise.reject(new Error('boom')) };
  control.expect('console1', tv);
  await bad.load(new ArrayBuffer(4), { name: 'fceumm', url: 'x', style: 'module' }, { execution: 'worker' }).catch(() => {});
  await bad.dispose();
  control.removeBranch('console1');          // the untokened removal that shipped
  ok(!control.branches.includes(keep) || control.branchToken('console1') === null,
    'without the hand-back the console ends up with no registered branch');
});

await section('a runtime that never got a branch takes none with it', async () => {
  // dispose() used to pass its token through unconditionally, and a null token
  // meant "remove whatever is registered" — so a boot that failed before it
  // could create a branch would tear down the incumbent it failed to replace.
  const { router } = spatialAudio();
  router.expect('console1', new THREE.Object3D());
  const incumbent = router.ensureBranch('console1');

  const neverBooted = new ConsoleRuntime({ id: 'console1', document: fakeDocument(), audio: router });
  neverBooted.client = fakeClient();
  ok(neverBooted._audioToken === null, 'it has no branch token');
  await neverBooted.dispose();
  eq(router.branches.length, 1, 'the incumbent\'s branch is untouched');
  ok(router.branchToken('console1') === incumbent.token, 'and still registered to the incumbent');
});

await section('removeBranch by token reaches a branch the console no longer answers to', async () => {
  const { router } = spatialAudio();
  const tv = new THREE.Object3D();
  router.expect('console1', tv);
  const oldBranch = router.ensureBranch('console1');
  router.detachBranch('console1');
  router.expect('console1', tv);
  const newBranch = router.ensureBranch('console1');

  ok(router.removeBranch('console1', oldBranch.token) === true, 'the detached branch is still removable by token');
  eq(router.branches.length, 1, 'only it was removed');
  ok(router.branchToken('console1') === newBranch.token, 'the live branch is still registered');
  eq(oldBranch.sink.outputs.length, 0, 'and the removed one is unwired');
  ok(router.removeBranch('console1', oldBranch.token) === false, 'removing it twice is a no-op');
});

await section('retiring a branch does not un-mute a console its successor keeps powered off', async () => {
  const { router } = spatialAudio();
  const tv = new THREE.Object3D();
  router.expect('console1', tv);
  const oldBranch = router.ensureBranch('console1');
  router.detachBranch('console1');
  router.expect('console1', tv);
  const live = router.ensureBranch('console1');
  router.setPower('console1', false);
  eq(live.sink.gain.value, 0, 'the powered-off console is silent');

  router.removeBranch('console1', oldBranch.token);
  router.setFocus(null);                       // any gain re-application
  eq(live.sink.gain.value, 0, 'and stays silent after the RETIRED branch is torn down');
});

// === C. WorkerEmulatorClient teardown ======================================

const OFFSCREEN = globalThis.OffscreenCanvas;
globalThis.OffscreenCanvas = class {};
const workerCanvas = () => ({ width: 640, height: 480, getContext: () => ({ drawImage() {} }) });

// A worker that answers whatever it is asked, unless told to ignore a method.
function fakeWorkerClass({ ignore = [], failStart = false } = {}) {
  return class FakeWorker extends EventTarget {
    constructor() { super(); this.terminated = false; FakeWorker.last = this; }
    postMessage(message) {
      if (!message?.id) return;
      if (ignore.includes(message.method)) return;             // never responds
      const error = failStart && message.method === 'start' ? { message: 'core died on boot' } : null;
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
        data: {
          protocol: 1, type: 'response', id: message.id,
          result: error ? undefined : { capabilities: { saveState: true } },
          error,
        },
      })));
    }
    terminate() { this.terminated = true; }
  };
}

const startClient = async (WorkerClass, opts = {}) => {
  const client = new WorkerEmulatorClient({ workerFactory: () => new WorkerClass(), ...opts });
  await client.start(workerCanvas(), new Uint8Array([1, 2, 3]), {
    coreUrl: 'cores/mednafen_psx_jit_libretro.js', coreName: 'psx', requiresThreads: false, baseUrl: 'https://example.test/',
  });
  return client;
};

await section('stop terminates the worker and releases the frame bridge', async () => {
  const WorkerClass = fakeWorkerClass();
  const client = await startClient(WorkerClass);
  ok(client.ready === true, 'the core started');
  const worker = WorkerClass.last;
  ok(!!client.frameBridge, 'and the frame bridge exists while it runs');

  await client.stop();
  ok(worker.terminated === true, 'the Worker is terminated — this is what frees the Wasm memory');
  ok(client.worker === null, 'the client no longer references it');
  ok(client.frameBridge === null, 'the frame bridge is released');
  ok(client.ready === false, 'and the client reports itself not ready');
});

await section('a wedged core cannot hold the teardown for the request timeout', async () => {
  // THE bug: stop() awaited a 'stop' request that inherited requestTimeoutMs
  // (60s by default), so a core that never answered kept its heap for a minute
  // while its replacement was already booting. Measured, not asserted-by-flag.
  const WorkerClass = fakeWorkerClass({ ignore: ['stop'] });
  const client = await startClient(WorkerClass, { requestTimeoutMs: 5000, stopTimeoutMs: 30 });
  const worker = WorkerClass.last;
  const t0 = Date.now();
  await client.stop();
  const elapsed = Date.now() - t0;
  ok(worker.terminated === true, 'the unresponsive worker is terminated anyway');
  ok(elapsed < 1000, `and promptly — ${elapsed}ms, nowhere near the 5000ms request timeout`);

  const shipped = new WorkerEmulatorClient();
  ok(shipped.stopTimeoutMs < shipped.requestTimeoutMs,
    `the shipped stop timeout (${shipped.stopTimeoutMs}ms) is shorter than the request timeout (${shipped.requestTimeoutMs}ms)`);
});

await section('a failed start does not leak the worker it already created', async () => {
  const WorkerClass = fakeWorkerClass({ failStart: true });
  const client = new WorkerEmulatorClient({ workerFactory: () => new WorkerClass() });
  let threw = null;
  try {
    await client.start(workerCanvas(), new Uint8Array([1]), {
      coreUrl: 'cores/x.js', coreName: 'psx', requiresThreads: false, baseUrl: 'https://example.test/',
    });
  } catch (e) { threw = e; }
  ok(!!threw, 'the failed boot still rejects — the caller must know');
  ok(WorkerClass.last.terminated === true, 'and the worker it had already spawned is terminated');
  ok(client.worker === null && client.frameBridge === null, 'nothing is left referencing the dead boot');
  ok(client.ready === false, 'and it never claims to be ready');
});

await section('a dead WORKER is torn down; a core-reported error is not', async () => {
  // Terminal: the worker itself failed, so no response is ever coming and it
  // cannot be reused.
  const WorkerClass = fakeWorkerClass();
  const client = await startClient(WorkerClass);
  const worker = WorkerClass.last;
  const pending = client.readSaveRam(1).then(() => 'resolved', (e) => `rejected: ${e.message}`);
  worker.dispatchEvent(Object.assign(new Event('error'), { message: 'worker exploded', filename: 'w.js', lineno: 1, colno: 1 }));
  ok(worker.terminated === true, 'a worker error terminates the worker');
  ok((await pending).startsWith('rejected'), 'and rejects what was in flight instead of leaving it hanging');

  // NOT terminal: the CORE said something went wrong. It is still running, and
  // callers may reset it or read from it — tearing it down here would kill a
  // console over a recoverable complaint.
  const WorkerClass2 = fakeWorkerClass();
  const client2 = await startClient(WorkerClass2);
  const worker2 = WorkerClass2.last;
  const seen = [];
  client2.addEventListener('error', (e) => seen.push(e.detail));
  client2._onMessage({ protocol: 1, type: 'event', event: 'error', detail: { message: 'disc read failed' } });
  await tick();
  // Two entries, not one: _fatal dispatches its own 'error' (detail = the
  // message) and _onMessage then re-dispatches the core's raw event. That
  // duplication predates COR-5 and is left alone here — what this asserts is
  // that the app is still told at all.
  ok(seen.length >= 1 && JSON.stringify(seen).includes('disc read failed'), 'the error is still reported to the app');
  ok(worker2.terminated === false, 'but the worker survives it');
  ok(client2.worker !== null, 'and the client can still be used');
});

await section('pausing a client whose worker is already gone is not an error', async () => {
  const WorkerClass = fakeWorkerClass();
  const client = await startClient(WorkerClass);
  await client.stop();
  let rejected = null;
  await client.pause().catch((e) => { rejected = e; });
  ok(rejected === null, 'pause() on a stopped client resolves — nothing is running, so it is already paused');
  ok(client.paused === true, 'and it still reports itself paused');

  // ConsoleRuntime.dispose() pauses on its way to stopping and does NOT await
  // what it gets back, so a rejection there escapes entirely. Anything a client
  // returns from pause() has to be settled for it.
  const rt = new ConsoleRuntime({ id: 'console1', document: fakeDocument() });
  rt.client = {
    paused: false,
    pause: () => Promise.reject(new Error('execution worker is not running')),
    stop: () => Promise.resolve(),
  };
  await rt.dispose();
  await tick();
});

globalThis.OffscreenCanvas = OFFSCREEN;

// unhandledRejection lands on a later macrotask than the code that caused it.
await new Promise((r) => setTimeout(r, 50));
ok(unhandled.length === 0, `an unhandled rejection escaped this suite: ${JSON.stringify(unhandled)}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
