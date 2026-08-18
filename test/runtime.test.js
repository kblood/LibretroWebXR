import test from 'node:test';
import assert from 'node:assert/strict';

import { coreAssetBase, locateCoreAsset } from '../src/runtime/assetUrls.js';
import { FrameBridge } from '../src/runtime/FrameBridge.js';
import { FramePump } from '../src/runtime/FramePump.js';
import { JitRuntimeBridge } from '../src/runtime/JitRuntimeBridge.js';
import { classifyCoreLog } from '../src/runtime/coreLog.js';
import { WorkerEmulatorClient } from '../src/runtime/WorkerEmulatorClient.js';
import { RETROARCH_CFG, RETROARCH_CORE_OPTIONS } from '../src/RetroArchConfig.js';
import { resolveCoreBuildHash } from '../src/RuntimeEmulatorClient.js';
import {
  RUNTIME_PROTOCOL_VERSION,
  assertProtocolMessage,
  deserializeError,
  requestMessage,
  serializeError,
} from '../src/runtime/protocol.js';

test('core asset URLs remain relative to the selected core under a deploy subpath', () => {
  const urls = coreAssetBase('cores/psx/psx_libretro.js', 'https://example.test/apps/webxr/');
  assert.equal(urls.coreUrl, 'https://example.test/apps/webxr/cores/psx/psx_libretro.js');
  assert.equal(urls.assetBaseUrl, 'https://example.test/apps/webxr/cores/psx/');
  assert.equal(locateCoreAsset('psx_libretro.wasm', urls.assetBaseUrl), 'https://example.test/apps/webxr/cores/psx/psx_libretro.wasm');
  assert.equal(locateCoreAsset('psx_libretro.worker.js', urls.assetBaseUrl), 'https://example.test/apps/webxr/cores/psx/psx_libretro.worker.js');
  assert.equal(locateCoreAsset('blob:https://example.test/id', urls.assetBaseUrl), 'blob:https://example.test/id');
});

test('protocol rejects mismatched workers and preserves errors', () => {
  const request = requestMessage(4, 'reset');
  assert.equal(assertProtocolMessage(request), request);
  assert.equal(request.protocol, RUNTIME_PROTOCOL_VERSION);
  assert.throws(() => assertProtocolMessage({ protocol: 999 }), /protocol mismatch/);
  const source = Object.assign(new TypeError('bad block'), { stack: 'test stack' });
  const restored = deserializeError(serializeError(source));
  assert.equal(restored.name, 'TypeError');
  assert.equal(restored.message, 'bad block');
  assert.equal(restored.stack, 'test stack');
});

test('core stderr keeps RetroArch warning severity', () => {
  assert.equal(classifyCoreLog('[WARN] Canvas size should be set using CSS properties!', 'error'), 'warning');
  assert.equal(classifyCoreLog('warning: optional driver unavailable', 'error'), 'warning');
  assert.equal(classifyCoreLog('[ERROR] failed to initialize core', 'debug'), 'error');
  assert.equal(classifyCoreLog('unclassified stderr', 'error'), 'error');
});

// The Lightrec dynarec and the OpenGL renderer are both deliberately switched
// off: they crash / present nothing in the current core artifact. The long
// comment above RETROARCH_CORE_OPTIONS in src/RetroArchConfig.js has the
// evidence, and docs/PSX_CORE_BUILD.md tracks re-enabling them. Pin the values
// here so neither can be flipped back silently — flipping them is fine, but it
// has to come with a core rebuild and an update to this test.
test('PSX worker configuration pins the known-good CPU/renderer tiers', () => {
  assert.match(RETROARCH_CFG, /core_options_path = ".*retroarch-core-options\.cfg"/);
  assert.match(RETROARCH_CORE_OPTIONS, /beetle_psx_cpu_dynarec = "disabled"/);
  assert.match(RETROARCH_CORE_OPTIONS, /beetle_psx_hw_cpu_dynarec = "disabled"/);
  assert.match(RETROARCH_CORE_OPTIONS, /beetle_psx_renderer = "software"/);
  assert.match(RETROARCH_CORE_OPTIONS, /beetle_psx_hw_renderer = "software"/);
});

// RetroArch 1.22 defaults these to "true", which redirects SRAM/save states
// into a per-core subdirectory that EmulatorWorkerRuntime's own path builder
// knows nothing about — every worker core's readSaveRam() then read a path
// that never existed. See the comment above EXTRA_CONFIG.
test('worker save/state paths are not redirected into per-core subdirectories', () => {
  assert.match(RETROARCH_CFG, /sort_savefiles_enable = "false"/);
  assert.match(RETROARCH_CFG, /sort_savestates_enable = "false"/);
  assert.match(RETROARCH_CFG, /sort_savefiles_by_content_enable = "false"/);
  assert.match(RETROARCH_CFG, /sort_savestates_by_content_enable = "false"/);
});

test('core build manifest supplies the exact Wasm hash used by saves', async () => {
  const digest = 'a'.repeat(64);
  const requested = [];
  const value = await resolveCoreBuildHash('cores/mednafen_psx_jit_libretro.js', 'fallback', async (url) => {
    requested.push(url);
    return { ok: true, json: async () => ({ artifacts: { 'mednafen_psx_jit_libretro.wasm': { sha256: digest } } }) };
  });
  assert.deepEqual(requested, ['cores/mednafen_psx_jit_libretro.build.json']);
  assert.equal(value, `sha256:${digest}`);
});

test('frame bridge keeps the newest frame and closes transferred bitmaps', () => {
  const draws = [];
  const canvas = {
    width: 1,
    height: 1,
    getContext: () => ({ drawImage: (...args) => draws.push(args) }),
  };
  const queue = [];
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => { queue.push(callback); return queue.length; };
  try {
    const closed = [];
    const bridge = new FrameBridge(canvas);
    bridge.receive({ width: 320, height: 240, close: () => closed.push('old') }, 320, 240);
    bridge.receive({ width: 640, height: 480, close: () => closed.push('new') }, 640, 480);
    assert.deepEqual(closed, ['old']);
    queue.shift()();
    assert.equal(canvas.width, 640);
    assert.equal(canvas.height, 480);
    assert.equal(draws.length, 1);
    assert.deepEqual(closed, ['old', 'new']);
    assert.deepEqual(bridge.snapshot(), { framesPresented: 1, framesDropped: 1 });
  } finally {
    globalThis.requestAnimationFrame = previousRaf;
  }
});

// PERF-4(a). The pump used to re-arm BEFORE checking `paused`, so an auto-paused
// rack console kept waking its worker thread ~62 times a second producing
// nothing — for as long as RackBudget kept it parked. The half of the fix that
// can go permanently wrong is the OTHER direction: if resume fails to re-arm,
// the console is black for the rest of the session with no recovery (the exact
// class of bug the FRAME_ACK watchdog exists for), so pause→resume→frames is
// asserted here, not just "pause stops".
test('frame pump sleeps while paused and produces again after resume', () => {
  // Fake clock: one pending callback at a time, fired by hand.
  let pending = null;
  let seq = 0;
  const clock = {
    setTimeout: (fn) => { pending = fn; return ++seq; },
    clearTimeout: () => { pending = null; },
  };
  const fire = () => { const fn = pending; pending = null; fn?.(); };

  let ticks = 0;
  const pump = new FramePump({ intervalMs: 16, onTick: () => { ticks++; }, ...clock });

  pump.start();
  assert.equal(ticks, 1, 'start produces a frame immediately (unchanged behaviour)');
  assert.equal(pump.running, true);
  fire();
  assert.equal(ticks, 2, 'and keeps producing on each wake');

  pump.setPaused(true);
  assert.equal(pump.running, false, 'a paused pump has NO wake scheduled');
  assert.equal(pending, null);
  fire();                       // nothing to fire — the wake is gone
  assert.equal(ticks, 2, 'a paused console produces nothing');

  pump.setPaused(false);
  assert.equal(pump.running, true, 'resume re-arms the pump');
  assert.equal(ticks, 2, 'resume does NOT capture in the same turn (a blank canvas would flash black)');
  fire();
  assert.equal(ticks, 3, 'frames flow again one interval after resume');

  // Idempotence: the client can send pause/resume twice (or a duplicate command
  // can arrive), and two chains of wakes must never end up running.
  pump.setPaused(false);
  pump.start();
  assert.equal(pump.running, true);
  fire();
  assert.equal(ticks, 5, 'start() ticks once and leaves exactly one chain armed');

  // A throwing capture must not kill the pump — the worker posts an error event
  // and expects the next frame to still come.
  const angry = new FramePump({ intervalMs: 16, onTick: () => { throw new Error('capture failed'); }, ...clock });
  assert.throws(() => angry.start(), /capture failed/);
  assert.equal(angry.running, true, 'the pump stays armed through a failed capture');

  // Teardown wins over resume: stop() must not be undone by a late resume.
  pump.stop();
  assert.equal(pump.running, false);
  pump.setPaused(false);
  assert.equal(pump.running, false, 'a stopped pump stays stopped');
});

test('JIT bridge compiles, publishes and removes a Wasm block in one realm', () => {
  // (module (func (export "block")))
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x09, 0x01, 0x05, 0x62, 0x6c, 0x6f, 0x63, 0x6b, 0x00, 0x00,
    0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
  ]);
  let publishedFunction = null;
  let removedIndex = null;
  const bridge = new JitRuntimeBridge();
  bridge.attachModule({
    addFunction(fn, signature) {
      assert.equal(signature, 'v');
      publishedFunction = fn;
      return 17;
    },
    removeFunction(index) { removedIndex = index; },
  });
  const handle = bridge.publish({ bytes, signature: 'v' });
  assert.deepEqual(handle, { id: 1, tableIndex: 17 });
  assert.equal(typeof publishedFunction, 'function');
  publishedFunction();
  assert.equal(bridge.snapshot().liveBlocks, 1);
  assert.equal(bridge.invalidate(handle.id), true);
  assert.equal(removedIndex, 17);
  assert.equal(bridge.snapshot().liveBlocks, 0);
});

test('worker client transfers multi-file content, firmware, and SaveRAM in one launch', async () => {
  const previousOffscreen = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = class {};
  const messages = [];
  class FakeWorker extends EventTarget {
    postMessage(message, transfer) {
      messages.push({ message, transfer });
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: {
        protocol: RUNTIME_PROTOCOL_VERSION,
        type: 'response',
        id: message.id,
        result: { capabilities: { saveState: true, saveRam: true } },
      } })));
    }
    terminate() {}
  }
  try {
    const client = new WorkerEmulatorClient({ workerFactory: () => new FakeWorker() });
    const canvas = { width: 640, height: 480, getContext: () => ({ drawImage() {} }) };
    const content = {
      entryPath: 'Disc/Game.cue',
      dependencies: ['Disc/Game.cue', 'Disc/Track.bin'],
      files: new Map([
        ['Disc/Game.cue', new Blob(['FILE "Track.bin" BINARY'])],
        ['Disc/Track.bin', new Uint8Array([1, 2, 3])],
      ]),
    };
    await client.start(canvas, content, {
      baseUrl: 'https://example.test/app/',
      coreUrl: 'cores/mednafen_psx_jit_libretro.js',
      coreName: 'mednafen_psx_hw',
      requiresThreads: false,
      firmware: { name: 'scph5501.bin', data: new Uint8Array([4]) },
      restoredSaves: { slot: 1, data: new Uint8Array([5, 6]) },
    });
    const launch = messages[0];
    assert.equal(launch.message.method, 'start');
    assert.equal(launch.message.payload.content.entryPath, 'Disc/Game.cue');
    assert.deepEqual(launch.message.payload.content.files.map((file) => file.path), ['Disc/Game.cue', 'Disc/Track.bin']);
    assert.equal(launch.message.payload.firmware[0].name, 'scph5501.bin');
    assert.equal(launch.message.payload.restoredSaves[0].slot, 1);
    assert.equal(launch.message.payload.discCount, 1);
    // Blob-shaped content files are handed to the worker as-is (structured
    // clone hands over a reference to the same backing storage, not a copy)
    // rather than read+sliced+transferred — the exact original Blob instance
    // survives untouched (C1, 2026-07-27 review followup). Only the already-
    // materialized Uint8Array file, plus firmware and restoredSaves (also
    // already-materialized), still go through the copy+transfer path — 3
    // transferred buffers, not 4 (the cue file no longer being one of them).
    assert.equal(launch.message.payload.content.files[0].data, content.files.get('Disc/Game.cue'));
    assert.equal(launch.transfer.length, 3);
    assert.equal(client.canSerialize(), true);
  } finally {
    globalThis.OffscreenCanvas = previousOffscreen;
  }
});

test('worker client dispatches each runtime event exactly once', () => {
  const client = new WorkerEmulatorClient();
  const received = [];
  client.addEventListener('audio', (event) => received.push(event.detail));
  const detail = { format: 'f32', channels: 2, sampleRate: 44100 };
  client._onMessage({
    protocol: RUNTIME_PROTOCOL_VERSION,
    type: 'event',
    event: 'audio',
    detail,
  });
  assert.deepEqual(received, [detail]);
});
