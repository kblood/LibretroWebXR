import { WorkerEmulatorClient } from '../../src/runtime/WorkerEmulatorClient.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, description, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  let lastError = null;
  while (performance.now() < deadline) {
    try {
      const result = predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

function frameEvidence(canvas) {
  if (!canvas.width || !canvas.height) return null;
  const context = canvas.getContext('2d', { alpha: false });
  const points = [
    [0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75],
  ];
  const samples = points.map(([x, y]) => {
    const pixel = context.getImageData(
      Math.min(canvas.width - 1, Math.floor(canvas.width * x)),
      Math.min(canvas.height - 1, Math.floor(canvas.height * y)),
      1,
      1,
    ).data;
    return [...pixel];
  });
  const lit = samples.filter(([r, g, b]) => r + g + b > 30).length;
  return lit ? { width: canvas.width, height: canvas.height, lit, samples } : null;
}

// Phase N0 is interpreter-only (no dynarec — see docs/N64_CORE_BUILD.md), so
// unlike the PSX probe this has no native-JIT evidence to wait for.
export async function runN64CoreE2E({ coreUrl, contentUrl, romFilename = 'lwx-n64-smoke.z64', bootTimeoutMs = 30000 }) {
  assert(crossOriginIsolated, 'N64 worker page is not cross-origin isolated');
  const response = await fetch(contentUrl, { cache: 'no-store' });
  assert(response.ok, `N64 smoke ROM request failed with HTTP ${response.status}`);
  const rom = new Uint8Array(await response.arrayBuffer());
  assert(rom.byteLength >= 0x1000, 'N64 smoke ROM is truncated');
  const magic = (rom[0] << 24 | rom[1] << 16 | rom[2] << 8 | rom[3]) >>> 0;
  assert(magic === 0x80371240, `smoke content has no native .z64 header (got 0x${magic.toString(16)})`);

  const output = document.querySelector('#output');
  const client = new WorkerEmulatorClient({ requestTimeoutMs: bootTimeoutMs });
  const logs = [];
  const workerErrors = [];
  const audio = { events: 0, frames: 0, channels: 0, sampleRate: 0, format: null };
  client.addEventListener('log', ({ detail }) => logs.push({ level: detail?.level || 'unknown', text: String(detail?.text || '') }));
  client.addEventListener('error', ({ detail }) => workerErrors.push(String(detail)));
  client.addEventListener('audio', ({ detail }) => {
    audio.events++;
    audio.channels = Number(detail?.channels || 0);
    audio.sampleRate = Number(detail?.sampleRate || 0);
    audio.format = detail?.format || null;
    const bytesPerSample = audio.format === 's16' ? 2 : 4;
    audio.frames += audio.channels > 0 ? Math.floor((detail?.samples?.byteLength || 0) / bytesPerSample / audio.channels) : 0;
  });

  const content = {
    entryPath: romFilename,
    dependencies: [romFilename],
    files: new Map([[romFilename, rom]]),
  };

  const startedAt = performance.now();
  try {
    await client.start(output, content, {
      coreName: 'mupen64plus_next',
      coreUrl,
      moduleStyle: 'module',
      entrypoint: 'retroarch',
      requiresThreads: true,
      width: 640,
      height: 480,
      frameIntervalMs: 16,
    });

    await waitFor(() => client.frameBridge.framesPresented >= 3, 'three presented N64 frames', bootTimeoutMs);
    const video = await waitFor(() => frameEvidence(output), 'non-blank N64 smoke-test video', bootTimeoutMs);
    const errorLogs = logs.filter((record) => record.level === 'error');
    const fatalText = logs.filter((record) => /(?:abort|exception|failed to load|fatal|runtimeerror)/i.test(record.text));
    assert(workerErrors.length === 0, `worker runtime errors: ${workerErrors.join('; ')}`);
    assert(errorLogs.length === 0, `core emitted error output: ${errorLogs.map((record) => record.text).join('; ')}`);
    assert(fatalText.length === 0, `core startup log contains a fatal marker: ${fatalText.map((record) => record.text).join('; ')}`);

    return {
      crossOriginIsolated,
      contentBytes: rom.byteLength,
      bootMs: performance.now() - startedAt,
      capabilities: client.capabilities,
      frames: {
        presented: client.frameBridge.framesPresented,
        dropped: client.frameBridge.framesDropped,
        produced: client.metrics?.framesProduced || 0,
        skipped: client.metrics?.framesSkipped || 0,
      },
      video,
      audio,
      logCount: logs.length,
      errorLogCount: errorLogs.length,
      workerErrors,
    };
  } finally {
    await client.stop();
  }
}

globalThis.runN64CoreE2E = runN64CoreE2E;

// Fps measurement against a real 3D scene (not the flat-fill smoke ROM) -
// Phase N0 item 3 of docs/research/n64-wasm-jit-plan.md. Boots exactly like
// runN64CoreE2E, then free-runs for measureMs and reports presented/dropped
// frame counts and the resulting average fps, instead of stopping at the
// first 3 frames.
export async function measureN64Fps({ coreUrl, contentUrl, romFilename, bootTimeoutMs = 30000, measureMs = 12000 }) {
  assert(crossOriginIsolated, 'N64 worker page is not cross-origin isolated');
  const response = await fetch(contentUrl, { cache: 'no-store' });
  assert(response.ok, `N64 scene ROM request failed with HTTP ${response.status}`);
  const rom = new Uint8Array(await response.arrayBuffer());
  assert(rom.byteLength >= 0x1000, 'N64 scene ROM is truncated');

  const output = document.querySelector('#output');
  const client = new WorkerEmulatorClient({ requestTimeoutMs: bootTimeoutMs });
  const workerErrors = [];
  const audio = { events: 0, frames: 0, channels: 0, sampleRate: 0, format: null };
  client.addEventListener('error', ({ detail }) => workerErrors.push(String(detail)));
  client.addEventListener('audio', ({ detail }) => {
    audio.events++;
    audio.channels = Number(detail?.channels || 0);
    audio.sampleRate = Number(detail?.sampleRate || 0);
    audio.format = detail?.format || null;
    const bytesPerSample = audio.format === 's16' ? 2 : 4;
    audio.frames += audio.channels > 0 ? Math.floor((detail?.samples?.byteLength || 0) / bytesPerSample / audio.channels) : 0;
  });

  const content = {
    entryPath: romFilename,
    dependencies: [romFilename],
    files: new Map([[romFilename, rom]]),
  };

  try {
    await client.start(output, content, {
      coreName: 'mupen64plus_next',
      coreUrl,
      moduleStyle: 'module',
      entrypoint: 'retroarch',
      requiresThreads: true,
      width: 640,
      height: 480,
      frameIntervalMs: 16,
    });

    await waitFor(() => client.frameBridge.framesPresented >= 3, 'three presented N64 frames', bootTimeoutMs);
    const framesAtStart = client.frameBridge.framesPresented;
    const droppedAtStart = client.frameBridge.framesDropped;
    const measureStartedAt = performance.now();

    await new Promise((resolve) => setTimeout(resolve, measureMs));

    const elapsedMs = performance.now() - measureStartedAt;
    const framesPresented = client.frameBridge.framesPresented - framesAtStart;
    const framesDropped = client.frameBridge.framesDropped - droppedAtStart;
    assert(workerErrors.length === 0, `worker runtime errors: ${workerErrors.join('; ')}`);

    return {
      elapsedMs,
      framesPresented,
      framesDropped,
      fps: framesPresented / (elapsedMs / 1000),
      video: frameEvidence(output),
      audio,
      capabilities: client.capabilities,
    };
  } finally {
    await client.stop();
  }
}

globalThis.measureN64Fps = measureN64Fps;
