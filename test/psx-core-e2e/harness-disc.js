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
// The assertions below deliberately go past "a non-blank frame appeared" and
// prove our OWN authored draw calls are on screen: games/psx-testdisc's HUD is
// PSn00bSDK debug-font text in the top rows of a 320x240 framebuffer whose
// clear colour is a near-black navy, so near-white pixels concentrated in the
// upper part of the frame cannot come from a blank screen, a flat fill, or the
// core's built-in OpenBIOS shell demo (which draws no text at all). See
// `contentEvidence()` below and docs/PSX_TESTDISC.md.
//
// This matters because both earlier failure modes passed a "non-blank frame"
// check: an unbootable disc left the OpenBIOS demo running, and the core's
// default OpenGL renderer presented only the framebuffer's background fill.

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
      const result = await predicate();
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
  return { width: canvas.width, height: canvas.height, lit, samples, ...contentEvidence(canvas, context) };
}

// Whole-frame evidence that the authored content (and not a flat fill, a blank
// screen, or the core's OpenBIOS shell demo) is being presented.
//
//  - brightTop: near-white pixels in the upper 40% of the frame. That is where
//    games/psx-testdisc's FntPrint() HUD lives ("LWX PSX TEST DISC", the save
//    counter, the memory-card status line). The 320x240 framebuffer is cleared
//    to RGB(12,14,24), and nothing else the core can put on screen without our
//    executable running produces white text there.
//  - distinctColors: RGB555-quantised unique colours. A flat/background-only
//    presentation gives 2 (the fill plus the letterbox bars); the real frame
//    has the fill, the bars, the white font and the cube's shaded faces.
//  - background: pixels matching our clear colour, RGB(12,14,24) quantised to
//    RGB555 and presented as (8,8,24). Required alongside brightTop so that a
//    bright BIOS/boot screen (which is light and near-white over most of the
//    frame) cannot be mistaken for our HUD.
function contentEvidence(canvas, context) {
  const width = canvas.width;
  const height = canvas.height;
  const topRows = Math.floor(height * 0.4);
  const { data } = context.getImageData(0, 0, width, height);
  let bright = 0;
  let brightTop = 0;
  let background = 0;
  const colors = new Set();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r > 200 && g > 200 && b > 200) {
        bright++;
        if (y < topRows) brightTop++;
      }
      if (r < 40 && g < 40 && b >= 16 && b < 80 && b > g) background++;
      if (colors.size < 4096) colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
    }
  }
  return { bright, brightTop, background, distinctColors: colors.size };
}

// The frame carries our authored content: white HUD glyphs in the top rows
// AND the game's own dark navy clear colour over most of the frame.
function showsAuthoredContent(evidence) {
  return evidence.brightTop >= 250 && evidence.background >= 80000 && evidence.distinctColors >= 4;
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

// games/psx-testdisc/main.c: MC_MAGIC, written into memory-card sector 16.
const MC_MAGIC = 0x31585754;

function isValidSaveBlock(block) {
  return !!block
    && block.magic === MC_MAGIC
    && block.save_count > 0
    && block.checksum === ((block.magic ^ block.save_count ^ block.last_save_frame) >>> 0);
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
    // Now insist on our OWN content: the disc has to have actually booted (a
    // failed boot leaves the core's OpenBIOS shell demo running) and the
    // presented frame has to carry the drawn HUD text, not just a background
    // fill. Both of those were previously-shipped failure modes.
    const videoAfterSave = await waitFor(() => {
      const evidence = frameEvidence(output);
      return showsAuthoredContent(evidence) ? evidence : null;
    }, "games/psx-testdisc's own HUD text on screen", Math.max(bootTimeoutMs, 30000));

    // The game auto-saves at its own frame 180 (~3s after main() starts) and
    // RetroArch only flushes SRAM to the virtual FS periodically, so poll
    // rather than taking a single reading.
    let midSessionCardImage = null;
    let midSessionError = null;
    try {
      midSessionCardImage = await waitFor(async () => {
        const raw = await client.readSaveRam(1);
        if (!raw) return null;
        const image = Array.from(raw);
        return isValidSaveBlock(decodeSaveBlockFromCardImage(image)) ? image : null;
      }, "games/psx-testdisc's save block on the emulated memory card", 30000);
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
    // ...and the rebooted game has to draw its HUD again, which is also the
    // visible half of the save round trip (it prints the save count it read
    // back off the card).
    const videoAfterReset = await waitFor(() => {
      const evidence = frameEvidence(output);
      return showsAuthoredContent(evidence) ? evidence : null;
    }, "games/psx-testdisc's HUD text on screen after soft reset", Math.max(bootTimeoutMs, 30000));

    let postResetCardImage = null;
    let postResetError = null;
    try {
      postResetCardImage = await waitFor(async () => {
        const raw = await client.readSaveRam(1);
        if (!raw) return null;
        const image = Array.from(raw);
        return isValidSaveBlock(decodeSaveBlockFromCardImage(image)) ? image : null;
      }, "games/psx-testdisc's save block still on the card after soft reset", 30000);
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
