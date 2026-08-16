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

  // …the swap: the old branch is retired, the new core registers its own.
  router.removeBranch('console1');
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

globalThis.OffscreenCanvas = OFFSCREEN;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
