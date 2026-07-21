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

function nativeJitEvidence(metrics) {
  if (!metrics) return null;
  const nativeCompiled = Number(metrics.psxJitCompiledBlocks || metrics.jitCompiledBlocks || 0);
  const nativeLive = Number(metrics.psxJitLiveBlocks || metrics.liveBlocks || 0);
  const bridgeCompiled = Number(metrics.jit?.compiled || 0);
  const bridgePublished = Number(metrics.jit?.published || 0);
  if (nativeCompiled > 0 || bridgeCompiled > 0 || bridgePublished > 0) {
    return {
      source: nativeCompiled > 0 ? 'native-lightrec' : 'worker-jit-bridge',
      psxJitCompiledBlocks: nativeCompiled,
      psxJitLiveBlocks: nativeLive,
      psxJitInterpreterBlocks: Number(metrics.psxJitInterpreterBlocks || metrics.interpreterBlocks || 0),
      psxJitInvalidatedBlocks: Number(metrics.psxJitInvalidatedBlocks || metrics.invalidatedBlocks || 0),
      bridge: metrics.jit,
    };
  }
  return null;
}

export async function runPsxCoreE2E({ coreUrl, contentUrl, bootTimeoutMs = 30000 }) {
  assert(crossOriginIsolated, 'PSX worker page is not cross-origin isolated');
  const response = await fetch(contentUrl, { cache: 'no-store' });
  assert(response.ok, `PSX smoke executable request failed with HTTP ${response.status}`);
  const executable = new Uint8Array(await response.arrayBuffer());
  assert(executable.byteLength >= 0x800, 'PSX smoke executable is truncated');
  assert(new TextDecoder().decode(executable.subarray(0, 8)) === 'PS-X EXE', 'smoke content has no PS-X EXE header');

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
    entryPath: 'psx-jit-smoke.exe',
    dependencies: ['psx-jit-smoke.exe'],
    files: new Map([['psx-jit-smoke.exe', executable]]),
  };

  const startedAt = performance.now();
  try {
    await client.start(output, content, {
      coreName: 'mednafen_psx_jit',
      coreUrl,
      moduleStyle: 'module',
      entrypoint: 'retroarch',
      requiresThreads: true,
      width: 640,
      height: 480,
      frameIntervalMs: 16,
    });

    await waitFor(() => client.frameBridge.framesPresented >= 3, 'three presented PSX frames', bootTimeoutMs);
    const video = await waitFor(() => frameEvidence(output), 'non-blank PSX smoke-test video', bootTimeoutMs);
    let errorLogs = logs.filter((record) => record.level === 'error');
    let fatalText = logs.filter((record) => /(?:abort|exception|failed to load|fatal|runtimeerror)/i.test(record.text));
    assert(workerErrors.length === 0, `worker runtime errors: ${workerErrors.join('; ')}`);
    assert(errorLogs.length === 0, `core emitted error output: ${errorLogs.map((record) => record.text).join('; ')}`);
    assert(fatalText.length === 0, `core startup log contains a fatal marker: ${fatalText.map((record) => record.text).join('; ')}`);

    const jit = await waitFor(() => {
      const evidence = nativeJitEvidence(client.metrics);
      if (evidence) return evidence;
      if (client.metrics) {
        throw new Error(`last counters ${JSON.stringify({
          psxJitCompiledBlocks: client.metrics.psxJitCompiledBlocks || 0,
          liveBlocks: client.metrics.psxJitLiveBlocks || client.metrics.liveBlocks || 0,
          interpreterBlocks: client.metrics.psxJitInterpreterBlocks || client.metrics.interpreterBlocks || 0,
          bridge: client.metrics.jit,
        })}`);
      }
      return null;
    }, 'native PSX JIT compilation evidence', bootTimeoutMs);
    await waitFor(() => audio.events > 0 && audio.frames > 0 && Number(client.metrics?.psxAudioFramesForwarded || 0) > 0,
      'native PSX audio forwarded through the execution-worker bridge', bootTimeoutMs);
    assert(audio.format === 'f32' && audio.channels === 2, `unexpected native audio format ${JSON.stringify(audio)}`);
    errorLogs = logs.filter((record) => record.level === 'error');
    fatalText = logs.filter((record) => /(?:abort|exception|failed to load|fatal|runtimeerror)/i.test(record.text));

    assert(workerErrors.length === 0, `worker runtime errors: ${workerErrors.join('; ')}`);
    assert(errorLogs.length === 0, `core emitted error output: ${errorLogs.map((record) => record.text).join('; ')}`);
    assert(fatalText.length === 0, `core startup log contains a fatal marker: ${fatalText.map((record) => record.text).join('; ')}`);

    return {
      crossOriginIsolated,
      contentBytes: executable.byteLength,
      bootMs: performance.now() - startedAt,
      capabilities: client.capabilities,
      frames: {
        presented: client.frameBridge.framesPresented,
        dropped: client.frameBridge.framesDropped,
        produced: client.metrics?.framesProduced || 0,
        skipped: client.metrics?.framesSkipped || 0,
      },
      video,
      jit,
      audio,
      logCount: logs.length,
      errorLogCount: errorLogs.length,
      workerErrors,
    };
  } finally {
    await client.stop();
  }
}

globalThis.runPsxCoreE2E = runPsxCoreE2E;
