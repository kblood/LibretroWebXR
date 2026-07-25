// Boots a real PSX CUE+BIN disc image (not a bare .exe) through the actual
// WorkerEmulatorClient/RetroArch/Beetle PSX path, the way a real disc-based
// game would be loaded. Companion to harness.js (which only exercises a
// bare PS-X EXE and never touches CD-ROM/BIOS/disc-boot). Used to verify
// games/psx-testdisc's authored CC0 homebrew CD image.
//
// No BIOS file is supplied (this repo never ships one — see
// docs/LICENSING.md); the core falls back to its own bundled OpenBIOS
// (a free/open-source clean-room BIOS reimplementation, MIT-licensed,
// from the PCSX-Redux project) baked into mednafen_psx_jit_libretro.wasm.
//
// IMPORTANT (see docs/PSX_TESTDISC.md "Known gap"): the assertions below
// prove the disc loads through the real content/CD pipeline (no track/file
// errors, no fatal core errors, continuous audio + JIT execution, a
// non-blank frame). They do NOT prove our authored PS-X content's own draw
// calls are what's on screen. Extensive isolation testing found every
// PSn00bSDK-built payload (this game, and several minimal test builds using
// raw GPU register pokes with no library/BIOS graphics calls at all) render
// the exact same content-independent, deterministic two-color sequence,
// while only the original hand-assembled smoke .exe (which pokes GP0/GP1
// directly with no PSn00bSDK toolchain involved) showed genuinely different
// output. This points at a worker-runtime video-path gap specific to this
// project's HW/GL-accelerated PSX core build, not a bug in this file's
// content or in mkpsxiso's disc image.

import { WorkerEmulatorClient } from '../../src/runtime/WorkerEmulatorClient.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// A handful of log lines RetroArch/Emscripten emit in this headless
// (Puppeteer + SwiftShader, no real DOM wheel/pointer-lock support) probe
// environment that are cosmetic and unrelated to whether the disc actually
// booted: Emscripten's input glue probing for browser APIs the headless
// page doesn't implement, and RetroArch's content-history "playlist" write
// (this build has no discoverable core *path* to record since the core is
// statically linked into this WASM artifact, not loaded from a file).
const BENIGN_LOG_PATTERN = /Failed to create (?:wheel|pointerlockchange) callback|\[Playlist\] Cannot push NULL or empty core path/i;

function isRealError(record) {
  return record.level === 'error' && !BENIGN_LOG_PATTERN.test(record.text);
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
  return { width: canvas.width, height: canvas.height, lit, samples };
}

function bytesToHex(bytes, start, len) {
  if (!bytes) return null;
  const out = [];
  for (let i = start; i < start + len && i < bytes.length; i++) out.push(bytes[i].toString(16).padStart(2, '0'));
  return out.join(' ');
}

// Little-endian uint32 read helper for inspecting the raw SaveBlock struct
// (magic/save_count/last_save_frame/checksum) games/psx-testdisc/main.c
// writes into memory-card sector 16.
function readU32LE(bytes, offset) {
  if (!bytes || bytes.length < offset + 4) return null;
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function decodeSaveBlockFromCardImage(cardImage) {
  if (!cardImage) return null;
  const sectorOffset = 16 * 128; // MC_SECTOR = 16, 128 bytes/sector
  if (cardImage.length < sectorOffset + 16) return null;
  return {
    magic: readU32LE(cardImage, sectorOffset),
    save_count: readU32LE(cardImage, sectorOffset + 4),
    last_save_frame: readU32LE(cardImage, sectorOffset + 8),
    checksum: readU32LE(cardImage, sectorOffset + 12),
    hex: bytesToHex(cardImage, sectorOffset, 16),
  };
}

export async function runPsxDiscE2E({
  coreUrl, cueUrl, binUrl, bootTimeoutMs = 30000, autoSaveFrame = 180, restoredCardImage = null,
}) {
  assert(crossOriginIsolated, 'PSX disc-boot page is not cross-origin isolated');

  const cueResponse = await fetch(cueUrl, { cache: 'no-store' });
  assert(cueResponse.ok, `CUE fetch failed with HTTP ${cueResponse.status}`);
  const cueBytes = new Uint8Array(await cueResponse.arrayBuffer());

  const binResponse = await fetch(binUrl, { cache: 'no-store' });
  assert(binResponse.ok, `BIN fetch failed with HTTP ${binResponse.status}`);
  const binBytes = new Uint8Array(await binResponse.arrayBuffer());
  assert(binBytes.byteLength > 0x8000, 'PSX disc BIN is implausibly small/truncated');

  const output = document.querySelector('#output');
  const client = new WorkerEmulatorClient({ requestTimeoutMs: bootTimeoutMs });
  const logs = [];
  const workerErrors = [];
  client.addEventListener('log', ({ detail }) => logs.push({ level: detail?.level || 'unknown', text: String(detail?.text || '') }));
  client.addEventListener('error', ({ detail }) => workerErrors.push(String(detail)));

  // File names inside the content bundle's virtual FS must match exactly
  // what the .cue text's FILE reference says (mkpsxiso/cue authoring tools
  // bake the referenced BIN's name verbatim into the CUE), so derive them
  // from the fetched URLs rather than hardcoding the SDK's own build-time
  // basename ("psxtest.cue"/"psxtest.bin").
  const cueName = decodeURIComponent(new URL(cueUrl).pathname.split('/').pop());
  const binName = decodeURIComponent(new URL(binUrl).pathname.split('/').pop());
  const content = {
    entryPath: cueName,
    dependencies: [cueName, binName],
    files: new Map([
      [cueName, cueBytes],
      [binName, binBytes],
    ]),
  };

  const restoredSaves = restoredCardImage
    ? [{ slot: 1, data: restoredCardImage.buffer || restoredCardImage }]
    : [];

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
      restoredSaves,
    });

    await waitFor(() => client.frameBridge.framesPresented >= 3, 'three presented PSX frames', bootTimeoutMs);
    const videoAtBoot = await waitFor(() => {
      const evidence = frameEvidence(output);
      return evidence.lit > 0 ? evidence : null;
    }, 'non-blank PSX disc-boot video', bootTimeoutMs);

    let errorLogs = logs.filter(isRealError);
    let fatalText = logs.filter((record) => /(?:abort|exception|failed to load|fatal|runtimeerror)/i.test(record.text));
    assert(workerErrors.length === 0, `worker runtime errors: ${workerErrors.join('; ')}`);
    assert(errorLogs.length === 0, `core emitted error output: ${errorLogs.map((record) => record.text).join('; ')}`);
    assert(fatalText.length === 0, `core startup log contains a fatal marker: ${fatalText.map((record) => record.text).join('; ')}`);

    // Run long enough for the game's own automatic memory-card save trigger
    // (frame `autoSaveFrame`, see games/psx-testdisc/main.c) to have fired.
    await waitFor(
      () => client.frameBridge.framesPresented >= autoSaveFrame + 90,
      'enough presented frames for the in-game auto-save trigger',
      Math.max(bootTimeoutMs, 25000),
    );
    const videoAfterSave = frameEvidence(output);

    let midSessionCardImage = null;
    let midSessionError = null;
    try {
      const raw = await client.readSaveRam(1);
      midSessionCardImage = raw ? Array.from(raw) : null;
    } catch (error) {
      midSessionError = String(error?.message || error);
    }

    // Soft-reset the emulated PS1 (re-runs the BIOS boot sequence and the
    // game's main() from scratch against the SAME live emulated memory
    // card) to prove the read-back-on-boot half of the round trip without
    // depending on a full page reload / IndexedDB persistence path (that
    // plumbing is separately in flux — see docs/PSX_TESTDISC.md).
    await client.reset();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const framesAtReset = client.frameBridge.framesPresented;
    await waitFor(
      () => client.frameBridge.framesPresented >= framesAtReset + 30,
      'frames presented after soft reset',
      bootTimeoutMs,
    );
    const videoAfterReset = frameEvidence(output);

    let postResetCardImage = null;
    let postResetError = null;
    try {
      const raw = await client.readSaveRam(1);
      postResetCardImage = raw ? Array.from(raw) : null;
    } catch (error) {
      postResetError = String(error?.message || error);
    }

    errorLogs = logs.filter(isRealError);
    fatalText = logs.filter((record) => /(?:abort|exception|failed to load|fatal|runtimeerror)/i.test(record.text));
    assert(workerErrors.length === 0, `worker runtime errors after reset: ${workerErrors.join('; ')}`);

    return {
      crossOriginIsolated,
      bootMs: performance.now() - startedAt,
      cueBytes: cueBytes.byteLength,
      binBytes: binBytes.byteLength,
      capabilities: client.capabilities,
      frames: {
        presented: client.frameBridge.framesPresented,
        dropped: client.frameBridge.framesDropped,
      },
      videoAtBoot,
      videoAfterSave,
      videoAfterReset,
      midSessionCardImage: midSessionCardImage ? { length: midSessionCardImage.length, saveBlock: decodeSaveBlockFromCardImage(midSessionCardImage) } : null,
      midSessionError,
      postResetCardImage: postResetCardImage ? { length: postResetCardImage.length, saveBlock: decodeSaveBlockFromCardImage(postResetCardImage) } : null,
      postResetError,
      logCount: logs.length,
      errorLogCount: errorLogs.length,
      workerErrors,
      logs,
      metrics: client.metrics,
    };
  } finally {
    await client.stop();
  }
}

globalThis.runPsxDiscE2E = runPsxDiscE2E;
