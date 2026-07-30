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
frameEvidence.raw = function (canvas) {
  if (!canvas.width || !canvas.height) return { note: 'canvas has zero width/height' };
  const context = canvas.getContext('2d', { alpha: false });
  const points = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
  const samples = points.map(([x, y]) => [...context.getImageData(
    Math.min(canvas.width - 1, Math.floor(canvas.width * x)),
    Math.min(canvas.height - 1, Math.floor(canvas.height * y)),
    1, 1,
  ).data]);
  return { width: canvas.width, height: canvas.height, samples };
};

// This is a BOOT SMOKE TEST, not a rendering-correctness check (unlike the
// N64/PSX probes' render-evidence stages — DOSBox Pure has no equivalent
// signature-generating smoke ROM here). Its one real question, per the
// 2026-07-29 build commit: does DBP_ThreadControl's real pthread_create()
// actually run from inside this app's OWN dedicated execution Worker — a
// worker-in-worker topology no other core here has exercised — or does it
// hang/trap. Content is a trivial DOSBox .conf with no autoexec, so DOSBox
// Pure boots to its own internal Z:\> shell (supports_no_game=true in its
// .info, but this runtime's content path still wants a real entryPath, so a
// minimal .conf is the least-assumption way to satisfy needs_fullpath).
export async function runDosCoreE2E({ coreUrl, contentUrl, bootTimeoutMs = 30000, verbose = false }) {
  assert(crossOriginIsolated, 'DOS worker page is not cross-origin isolated');

  // With no contentUrl: a trivial DOSBox .conf with no autoexec (real DOSBox
  // boots to its internal Z:\> shell with nothing mounted at all — this is
  // the least-assumption smoke test, satisfying needs_fullpath without
  // needing real bootable media).
  // With a contentUrl (e.g. a FAT floppy .img): fetched and booted for real,
  // needed because an empty .conf alone was observed to render solid black
  // (see docs/DOS_CORE_BUILD.md) — DOSBox Pure's supports_no_game path does
  // NOT reproduce vanilla DOSBox's "shell with nothing mounted" UX.
  let entryFilename;
  let entryBytes;
  if (contentUrl) {
    entryFilename = decodeURIComponent(contentUrl.split('/').pop());
    const response = await fetch(contentUrl, { cache: 'no-store' });
    assert(response.ok, `DOS content request failed with HTTP ${response.status}`);
    entryBytes = new Uint8Array(await response.arrayBuffer());
    assert(entryBytes.byteLength > 0, 'DOS content is empty');
  } else {
    entryFilename = 'lwx-dos-smoke.conf';
    entryBytes = new TextEncoder().encode('# LibretroWebXR DOS boot smoke test: no autoexec, boot to Z:\\> shell.\n[autoexec]\n');
  }

  const output = document.querySelector('#output');
  const client = new WorkerEmulatorClient({ requestTimeoutMs: bootTimeoutMs });
  const logs = [];
  const workerErrors = [];
  client.addEventListener('log', ({ detail }) => logs.push({ level: detail?.level || 'unknown', text: String(detail?.text || '') }));
  client.addEventListener('error', ({ detail }) => workerErrors.push(String(detail)));

  const content = {
    entryPath: entryFilename,
    dependencies: [entryFilename],
    files: new Map([[entryFilename, entryBytes]]),
  };

  const startedAt = performance.now();
  try {
    try {
      await client.start(output, content, {
        coreName: 'dosbox_pure',
        coreUrl,
        moduleStyle: 'module',
        entrypoint: 'retroarch',
        requiresThreads: true,
        width: 640,
        height: 400,
        frameIntervalMs: 16,
        // -v forces RetroArch's frontend log_cb to actually emit core-side
        // log_cb output (RetroArch drops it silently unless log_verbosity is
        // set — see the "PSX log verbosity gate" investigation). Hardcodes
        // this runtime's known-fixed RA_CFG_PATH/CONTENT_DIR (EmulatorWorkerRuntime.js)
        // since passing custom `arguments` bypasses the default construction.
        ...(verbose ? { arguments: ['-v', '-c', '/home/web_user/retroarch/userdata/retroarch.cfg', `/content/${entryFilename}`] } : {}),
      });
    } catch (error) {
      throw new Error(`client.start() failed: ${error.message}\nlogs so far: ${JSON.stringify(logs)}\nworkerErrors: ${JSON.stringify(workerErrors)}`);
    }

    let video;
    try {
      await waitFor(() => client.frameBridge.framesPresented >= 3, 'three presented DOS frames', bootTimeoutMs);
      video = await waitFor(() => frameEvidence(output), 'non-blank DOS smoke-test video', bootTimeoutMs);
    } catch (error) {
      const raw = frameEvidence.raw ? frameEvidence.raw(output) : null;
      throw new Error(`${error.message}\nframesPresented=${client.frameBridge.framesPresented} framesDropped=${client.frameBridge.framesDropped} canvas=${output.width}x${output.height}\nrawSamples=${JSON.stringify(raw)}\nlogs so far (${logs.length}): ${JSON.stringify(logs)}\nworkerErrors: ${JSON.stringify(workerErrors)}`);
    }
    const errorLogs = logs.filter((record) => record.level === 'error');
    const fatalText = logs.filter((record) => /(?:abort|exception|failed to load|fatal|runtimeerror|unreachable)/i.test(record.text));
    assert(workerErrors.length === 0, `worker runtime errors: ${workerErrors.join('; ')}`);
    assert(errorLogs.length === 0, `core emitted error output: ${errorLogs.map((record) => record.text).join('; ')}`);
    assert(fatalText.length === 0, `core startup log contains a fatal marker: ${fatalText.map((record) => record.text).join('; ')}`);

    return {
      crossOriginIsolated,
      bootMs: performance.now() - startedAt,
      capabilities: client.capabilities,
      frames: {
        presented: client.frameBridge.framesPresented,
        dropped: client.frameBridge.framesDropped,
        produced: client.metrics?.framesProduced || 0,
        skipped: client.metrics?.framesSkipped || 0,
      },
      video,
      logCount: logs.length,
      errorLogCount: errorLogs.length,
      workerErrors,
      allLogs: logs.map((record) => `[${record.level}] ${record.text}`),
    };
  } finally {
    await client.stop();
  }
}

globalThis.runDosCoreE2E = runDosCoreE2E;
