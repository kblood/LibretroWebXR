import {
  RETROARCH_CFG,
  RETROARCH_CORE_OPTIONS,
  RETROARCH_CORE_OPTIONS_PATH,
} from '../RetroArchConfig.js';
import { DiscControlBridge } from '../DiscControl.js';
import { JitRuntimeBridge } from './JitRuntimeBridge.js';
import { locateCoreAsset } from './assetUrls.js';
import { classifyCoreLog } from './coreLog.js';
import {
  RUNTIME_PROTOCOL_VERSION,
  WorkerMessage,
  assertProtocolMessage,
  eventMessage,
  responseMessage,
  serializeError,
} from './protocol.js';

const CONTENT_DIR = '/content';
const STATE_DIR = '/home/web_user/retroarch/userdata/states';
const SYSTEM_DIR = '/home/web_user/retroarch/userdata/system';
const SAVE_DIR = '/home/web_user/retroarch/userdata/saves';
const RA_CFG_PATH = '/home/web_user/retroarch/userdata/retroarch.cfg';
// Per-core input remap directory — mirrors EmulatorClient.js's REMAP_DIR
// (RETROARCH_CFG_DIR + '/config/remaps'). RetroArch only honours a
// controller-port device override (input_libretro_device_pN, e.g. GunCon on
// port 1) from this per-core <LibraryName>/<LibraryName>.rmp file at boot —
// the main cfg's value is ignored (verified during the original light-gun
// bring-up, see docs/LIGHTGUN_SUPPORT.md). Worker-executed cores (PSX, N64)
// never had this plumbing before — see writeConfig() below.
const REMAP_DIR = '/home/web_user/retroarch/userdata/config/remaps';

let canvas = null;
let moduleInstance = null;
let frameTimer = null;
let metricsTimer = null;
let framePending = false;
let startedAt = 0;
let inputTarget = null;
let jit = null;
let entryPath = `${CONTENT_DIR}/rom.bin`;
let statePath = `${STATE_DIR}/rom.state`;
let saveStem = 'rom';
let paused = false;
// Eject/select/insert control, shared with the main-thread execution path
// (src/DiscControl.js) rather than hand-duplicated here — this worker just
// supplies the live core module and disc count (C6, 2026-07-27 review
// followup; this duplication was flagged back in the 2026-07-24 review).
// Starts bound to no module (Codex review finding on 3a90d3f: a 'disc-status'/
// 'set-disc' RPC can arrive before hydrateLaunch() runs — WorkerEmulatorClient
// doesn't wait for 'ready' first — so this must default to the same
// safe "unsupported" status the old always-present `disc` object gave,
// not null.
let discBridge = new DiscControlBridge(null, { discCount: 1 });
const metrics = { framesProduced: 0, framesSkipped: 0, inputs: 0, audioBatches: 0, errors: 0 };
// Tracks each seated light-gun port's synthetic-trigger edge state (mirrors
// EmulatorClient.js's `_gunDown`/`_webgunSet` bookkeeping) so forwardLightgun
// emits clean mousedown/mouseup edges instead of re-firing every call — RA
// latches a gun-mouse button until the matching up event. Keyed by `port`
// (or the string 'default' when no port is given, i.e. a single-gun boot);
// value is `false` (up) or the DOM button index currently held down.
const gunDownByPort = {};
// Multiport light-gun side-channel — the WORKER's mirror of EmulatorClient.js's
// `_webgunSet`/`_resolveWebgun`. The patched (multiport) cores export
// rwebinput_set_lightgun(port,x,y,buttons) so each controller port carries its
// OWN aim point; a single canvas can only ever carry ONE DOM mouse pointer, so
// this export is the ONLY way two guns on one console drive two ports
// independently. Until this existed here, forwardLightgun() ignored `port` for
// AIM entirely (it was only ever a gunDownByPort bookkeeping key) and every gun
// on a worker-execution core — i.e. PSX, the only worker-execution gun system —
// fell through to the shared DOM-mouse path. Resolved lazily on first use (the
// core must be initialised first). null = not looked up yet; false = looked up
// and absent (unpatched core → DOM fallback); function = resolved.
let webgunSet = null;
// The counterpart export, rwebinput_clear_lightgun(port), behind the
// 'lightgun-clear' RPC. Resolved the same lazy/defensive way as webgunSet
// (null = not looked up, false = absent, function = resolved). It exists
// because rwebinput_set_lightgun latches `lightgun[port].active = true` and a
// port that is active IGNORES the shared DOM mouse forever — so a port that
// STOPS being driven through the multiport path has to be handed back
// explicitly, or it freezes at its last aim (and, if it was released mid-shot,
// with its trigger bit still held) until the core is torn down. Only an
// explicit caller can know that happened; see clearLightgunPort() below for
// which cases are and are NOT covered.
let webgunClear = null;
// Last value actually written per gun port, for probe/telemetry observability
// (reported in postMetrics as `gun.ports`). `path` records WHICH code path
// carried it — 'multiport' = straight into the core's per-port slot,
// 'dom' = the shared single-pointer canvas events. Two ports both reading
// 'dom' is exactly the silent two-guns-share-one-aim failure mode.
const gunAimByPort = {};
// Held DOM mouse-button bitmask for forwardMouse() (1=left, 2=right, 4=middle).
// Mirrors EmulatorClient._mouseButtons: RetroArch latches a button until the
// matching mouseup, so we diff against this and emit clean edges rather than
// re-firing mousedown every call.
let mouseButtons = 0;
// Last relative motion + buttons actually forwarded, for probe/telemetry
// observability (reported in postMetrics as `mouse`). `moves` counts motion
// events so a probe can tell "mouse wired but idle" from "never reached us".
const mouseState = { dx: 0, dy: 0, buttons: 0, moves: 0 };
// Echo of the per-port device overrides writeConfig() actually wrote into the
// RetroArch cfg + remap for this launch ({ player: libretroDeviceId }). Lets a
// probe confirm two guns really were SEATED on two ports, at the place where
// that decision lands, instead of inferring it from the page side.
let seatedInputDevices = null;

class WorkerEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event) {
    event.target ||= this;
    for (const listener of this.listeners.get(event.type) || []) {
      if (typeof listener === 'function') listener.call(this, event);
      else listener.handleEvent?.(event);
    }
    return !event.defaultPrevented;
  }
}

function installWorkerDomShim(offscreenCanvas) {
  inputTarget = new WorkerEventTarget();
  const documentShim = new WorkerEventTarget();
  documentShim.querySelector = (selector) => selector === '#canvas' ? offscreenCanvas : null;
  documentShim.getElementById = (id) => id === 'canvas' ? offscreenCanvas : null;
  documentShim.body = documentShim;
  documentShim.documentElement = documentShim;
  // Emscripten keyboard glue historically resolves its target to document.
  inputTarget = documentShim;
  globalThis.window ||= globalThis;
  globalThis.document ||= documentShim;
  globalThis.screen ||= { width: offscreenCanvas.width, height: offscreenCanvas.height };
  globalThis.devicePixelRatio ||= 1;
  // RetroArch's Emscripten frontend receives an OffscreenCanvas but still
  // performs a handful of HTMLCanvasElement setup calls. Supply only that
  // small surface; rendering continues to use the native OffscreenCanvas.
  const attributes = new Map();
  try {
    const style = offscreenCanvas.style || {};
    style.setProperty ||= function setProperty(name, value) { this[name] = String(value); };
    style.removeProperty ||= function removeProperty(name) { delete this[name]; };
    style.getPropertyValue ||= function getPropertyValue(name) { return this[name] || ''; };
    style.display ||= 'block';
    offscreenCanvas.style ||= style;
    offscreenCanvas.id ||= 'canvas';
    offscreenCanvas.getAttribute ||= (name) => attributes.get(String(name)) ?? null;
    offscreenCanvas.setAttribute ||= (name, value) => attributes.set(String(name), String(value));
    offscreenCanvas.removeAttribute ||= (name) => attributes.delete(String(name));
    offscreenCanvas.focus ||= () => {};
    // clientWidth/clientHeight/getBoundingClientRect must reflect the fixed
    // CSS layout size, NOT the live .width/.height backing-store resolution
    // — same as a real HTMLCanvasElement, where CSS decides the box size
    // independent of the canvas's internal pixel resolution. RetroArch's
    // platform_emscripten.c relies on this: it deliberately stomps
    // canvas.width/height to 64x64 as a CSS-constraint self-test, then
    // later recomputes the REAL target size from clientWidth * DPR (see
    // PlatformEmscriptenWatchCanvasSizeAndDpr in library_platform_emscripten.js).
    // If clientWidth were aliased to the live .width (as it was before this
    // fix), that recompute reads back the 64 it just wrote and the canvas
    // can never recover its real size. Capture the actual requested size
    // now (offscreenCanvas.width/height at construction, before any of
    // RetroArch's own resize probing runs — see the `new OffscreenCanvas(
    // payload.width, payload.height)` call site) and freeze it here.
    const layoutWidth = offscreenCanvas.width;
    const layoutHeight = offscreenCanvas.height;
    offscreenCanvas.getBoundingClientRect ||= () => ({
      left: 0,
      top: 0,
      right: layoutWidth,
      bottom: layoutHeight,
      width: layoutWidth,
      height: layoutHeight,
    });
    if (!('clientWidth' in offscreenCanvas)) {
      Object.defineProperty(offscreenCanvas, 'clientWidth', { get: () => layoutWidth });
    }
    if (!('clientHeight' in offscreenCanvas)) {
      Object.defineProperty(offscreenCanvas, 'clientHeight', { get: () => layoutHeight });
    }
    globalThis.getComputedStyle ||= (element) => element?.style || style;
    globalThis.ResizeObserver ||= class ResizeObserver {
      constructor(callback) { this.callback = callback; this.targets = new Set(); }
      observe(target) {
        this.targets.add(target);
        queueMicrotask(() => {
          if (!this.targets.has(target)) return;
          this.callback([{ target, contentRect: target.getBoundingClientRect() }], this);
        });
      }
      unobserve(target) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
    };
  } catch (_) {}
}

function installRuntimeHooks(jitBridge) {
  globalThis.__libretroWebXRJit = jitBridge.api;
  globalThis.__libretroWebXRRuntime = Object.freeze({
    // A worker-safe audio escape hatch for the PSX frontend. Samples must be
    // interleaved Float32 or Int16; ownership transfers to the page thread.
    pushAudio(samples, channels = 2, sampleRate = 48000) {
      const copy = samples.slice ? samples.slice() : new samples.constructor(samples);
      metrics.audioBatches++;
      postMessage(eventMessage('audio', {
        samples: copy.buffer,
        format: copy instanceof Float32Array ? 'f32' : 's16',
        channels,
        sampleRate,
      }), [copy.buffer]);
    },
    reportMetric(name, value) {
      if (typeof name === 'string' && Number.isFinite(value)) metrics[name] = value;
    },
  });
}

async function start(payload) {
  if (moduleInstance) throw new Error('execution worker is already running a core');
  if (payload.moduleStyle !== 'module') {
    throw new Error('worker runtime supports MODULARIZE ES-module cores only');
  }
  startedAt = performance.now();
  canvas = new OffscreenCanvas(payload.width, payload.height);
  installWorkerDomShim(canvas);
  jit = new JitRuntimeBridge();
  installRuntimeHooks(jit);

  const baseModule = {
    canvas,
    noInitialRun: true,
    arguments: payload.arguments || ['-c', RA_CFG_PATH, `${CONTENT_DIR}/${payload.content.entryPath}`],
    locateFile: (path) => locateCoreAsset(path, payload.assetBaseUrl),
    mainScriptUrlOrBlob: payload.coreUrl,
    webxrJit: jit.api,
    webxrRuntime: globalThis.__libretroWebXRRuntime,
    print: (text) => postMessage(eventMessage('log', {
      level: classifyCoreLog(text, 'debug'),
      text: String(text),
    })),
    // RetroArch writes warnings to stderr as well as real errors. Preserve the
    // severity prefix so benign diagnostics do not become fatal runtime logs.
    printErr: (text) => postMessage(eventMessage('log', {
      level: classifyCoreLog(text, 'error'),
      text: String(text),
    })),
  };

  const imported = await import(/* @vite-ignore */ payload.coreUrl);
  if (typeof imported.default !== 'function') throw new Error('worker core has no default module factory');
  moduleInstance = await imported.default(baseModule);
  jit.attachModule(moduleInstance);
  writeConfig(payload);
  await hydrateLaunch(payload);

  if (payload.entrypoint === 'retroarch') {
    try {
      moduleInstance.callMain(payload.arguments || ['-c', RA_CFG_PATH, entryPath]);
    }
    catch (error) {
      // emscripten_set_main_loop uses this sentinel to unwind the C stack.
      if (String(error) !== 'unwind') throw error;
    }
  } else if (typeof moduleInstance.webxrStart === 'function') {
    await moduleInstance.webxrStart({ romPath: entryPath });
  }

  startFramePump(payload.frameIntervalMs || 16);
  metricsTimer = setInterval(postMetrics, 1000);
  return { capabilities: detectCapabilities() };
}

function detectCapabilities() {
  return {
    saveState: !!(moduleInstance?.FS && moduleInstance?._cmd_save_state && moduleInstance?._cmd_load_state),
    saveRam: !!moduleInstance?.FS,
    // discBridge always exists (starts bound to no module; see its
    // declaration) so this reports "unsupported" rather than throwing
    // whenever this runs before any core has loaded.
    discControl: discBridge.capabilities().supported,
    jit: !!globalThis.__libretroWebXRJit,
    audioBridge: true,
    frameBridge: typeof canvas?.transferToImageBitmap === 'function',
  };
}

// payload: the same 'start' request payload start() receives — carries the
// optional per-launch coreOptions / inputDevices / remapName fields
// WorkerEmulatorClient.js now forwards from RuntimeEmulatorClient.start()'s
// opts (added for PSX GunCon; see systems.js SYSTEMS.psx.lightgun and
// CORES.mednafen_psx_hw.remapName). Static baseline is unchanged for every
// core that doesn't pass these — this is purely additive.
function writeConfig(payload = {}) {
  if (!moduleInstance?.FS) return;

  // Core options: this worker's static PSX-required baseline (cpu_dynarec /
  // renderer — see RetroArchConfig.js's long comment on why those values are
  // load-bearing) plus any per-launch overrides appended after (e.g. GunCon's
  // gun_input_mode/gun_cursor). New keys only; nothing here collides with the
  // static baseline's keys.
  let coreOptionsBody = RETROARCH_CORE_OPTIONS;
  if (payload.coreOptions) {
    coreOptionsBody += Object.entries(payload.coreOptions)
      .map(([k, v]) => `${k} = "${v}"`).join('\n') + '\n';
  }

  // Main cfg: static keybinds/base config, plus — when a controller-port
  // device override is requested (a light gun on some port) — the SAME
  // remap + gun-mouse-bind wiring EmulatorClient.js's _writeRetroArchConfig
  // writes for every main-thread gun (PS2 GunCon2, SNES Super Scope/
  // Justifier, NES Zapper, Genesis Menacer, SMS Light Phaser). Mirrored
  // line-for-line from that function; see its comments for the "why" of each
  // line (RETRO_DEVICE_MASK/LIGHTGUN/POINTER classification, why the remap
  // FILE — not the main cfg's input_libretro_device_pN — is what actually
  // connects the device at boot).
  let cfg = RETROARCH_CFG;
  seatedInputDevices = payload.inputDevices ? { ...payload.inputDevices } : null;
  if (payload.inputDevices) {
    const RETRO_DEVICE_MASK = 0xff, RETRO_DEVICE_MOUSE = 2, RETRO_DEVICE_LIGHTGUN = 4, RETRO_DEVICE_POINTER = 6;
    const validPorts = Object.entries(payload.inputDevices)
      .filter(([player]) => Number.isInteger(Number(player)) && Number(player) >= 1);
    cfg += `input_remap_binds_enable = "true"\n`;
    cfg += `input_remapping_directory = "${REMAP_DIR}"\n`;
    for (const [player, dev] of validPorts) {
      const p = Number(player);
      cfg += `input_libretro_device_p${p} = "${dev}"\n`;
      const base = Number(dev) & RETRO_DEVICE_MASK;
      if (base === RETRO_DEVICE_LIGHTGUN || base === RETRO_DEVICE_POINTER) {
        cfg += `input_player${p}_mouse_index = "0"\n`;
        cfg += `input_player${p}_gun_trigger_mbtn = "1"\n`;
        cfg += `input_player${p}_gun_offscreen_shot_mbtn = "2"\n`;
      } else if (base === RETRO_DEVICE_MOUSE) {
        cfg += `input_player${p}_mouse_index = "0"\n`;
      }
    }
    if (payload.remapName && validPorts.length) {
      const rmp = validPorts.map(([p, dev]) => `input_libretro_device_p${Number(p)} = "${dev}"`).join('\n') + '\n';
      const dir = `${REMAP_DIR}/${payload.remapName}`;
      try { moduleInstance.FS.mkdirTree(dir); } catch (_) {}
      try { moduleInstance.FS.writeFile(`${dir}/${payload.remapName}.rmp`, rmp); }
      catch (e) { postMessage(eventMessage('log', { level: 'error', text: `[EmulatorWorkerRuntime] failed to write remap: ${e?.message || e}` })); }
    } else {
      postMessage(eventMessage('log', { level: 'error', text: '[EmulatorWorkerRuntime] inputDevices set without remapName — port device will not connect at boot' }));
    }
  }

  const targets = [
    ['/home/web_user/retroarch/userdata', RA_CFG_PATH, cfg],
    ['/home/web_user/retroarch/userdata', RETROARCH_CORE_OPTIONS_PATH, coreOptionsBody],
    ['/home/web_user/.config/retroarch', '/home/web_user/.config/retroarch/retroarch.cfg', cfg],
    ['/home/web_user', '/home/web_user/.retroarch.cfg', cfg],
  ];
  for (const [dir, path, contents] of targets) {
    try { moduleInstance.FS.mkdirTree(dir); } catch (_) {}
    moduleInstance.FS.writeFile(path, contents);
  }
}

async function hydrateLaunch(payload) {
  if (!moduleInstance?.FS) throw new Error('worker core did not expose Emscripten FS');
  const content = payload.content;
  if (!content?.entryPath || !Array.isArray(content.files)) throw new Error('worker launch is missing a content bundle');
  entryPath = `${CONTENT_DIR}/${safeRelativePath(content.entryPath)}`;
  saveStem = basenameWithoutExtension(content.entryPath);
  statePath = `${STATE_DIR}/${saveStem}.state`;
  mkdir(CONTENT_DIR);
  for (const file of content.files) await writeRelative(CONTENT_DIR, file.path, file.data);
  mkdir(SYSTEM_DIR);
  for (const record of payload.firmware || []) await writeRelative(SYSTEM_DIR, record.name, record.data);
  mkdir(SAVE_DIR);
  for (const record of payload.restoredSaves || []) {
    moduleInstance.FS.writeFile(saveRamPath(record.slot || 1), await bytesOf(record.data));
  }
  discBridge = new DiscControlBridge(moduleInstance, { discCount: Math.max(1, payload.discCount || 1) });
}

// How long to wait for a FRAME_ACK before assuming it's never coming and
// un-sticking the pump ourselves (B6, 2026-07-25 review). The main thread's
// FrameBridge only acks after actually presenting a frame via
// requestAnimationFrame — if that rAF stalls (a backgrounded tab, or a
// mis-wired XR session that isn't actually routing through XRRafShim; see
// FrameBridge.js), framePending latches true forever and this pump would
// silently stop producing frames for the rest of the session with no way to
// recover. 500ms is generous relative to a healthy ~16ms cadence — long
// enough to never fire during normal jitter, short enough that a real stall
// only costs a fraction of a second of missing video.
const FRAME_ACK_TIMEOUT_MS = 500;
let frameAckWatchdog = null;

function armFrameAckWatchdog() {
  clearTimeout(frameAckWatchdog);
  frameAckWatchdog = setTimeout(() => {
    if (!framePending) return;
    framePending = false;
    metrics.staleFrameAcks = (metrics.staleFrameAcks || 0) + 1;
  }, FRAME_ACK_TIMEOUT_MS);
}

function clearFrameAckWatchdog() {
  clearTimeout(frameAckWatchdog);
  frameAckWatchdog = null;
}

function startFramePump(interval) {
  const pump = () => {
    frameTimer = setTimeout(pump, interval);
    // Paused (B5, 2026-07-25 review): stop producing/transferring frames
    // entirely rather than keep pumping into a core the JS side believes is
    // stopped — RackBudget's auto-pause-idle-cores feature relies on a paused
    // console actually going quiet, not just accepting a no-op pause command.
    if (paused || !canvas || framePending || typeof canvas.transferToImageBitmap !== 'function') {
      if (framePending) metrics.framesSkipped++;
      return;
    }
    try {
      const bitmap = canvas.transferToImageBitmap();
      framePending = true;
      metrics.framesProduced++;
      postMessage({
        protocol: RUNTIME_PROTOCOL_VERSION,
        type: WorkerMessage.FRAME,
        bitmap,
        width: canvas.width,
        height: canvas.height,
      }, [bitmap]);
      armFrameAckWatchdog();
    } catch (error) {
      metrics.errors++;
      postMessage(eventMessage('error', serializeError(error)));
    }
  };
  pump();
}

function forwardInput(payload) {
  metrics.inputs++;
  if (typeof moduleInstance?.webxrInputEvent === 'function') {
    moduleInstance.webxrInputEvent(payload);
    return;
  }
  let defaultPrevented = false;
  inputTarget?.dispatchEvent({
    type: payload.eventType,
    ...payload,
    bubbles: true,
    cancelable: true,
    preventDefault() { defaultPrevented = true; this.defaultPrevented = true; },
    stopPropagation() {},
    defaultPrevented,
  });
}

// A duck-typed event object for `inputTarget` (the custom WorkerEventTarget
// shim, NOT a real DOM EventTarget — see installWorkerDomShim/documentShim
// above) — same shape forwardInput() already builds inline for keyboard.
function duckEvent(type, props) {
  return {
    type, ...props, bubbles: true, cancelable: true, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  };
}

// A REAL Event instance for `canvas` (a genuine OffscreenCanvas — spec'd as
// `interface OffscreenCanvas : EventTarget`, so its native dispatchEvent()
// requires an actual Event, unlike the duck-typed shim above). Worker global
// scope has no MouseEvent/UIEvent constructor (those are Window-only per the
// HTML spec's [Exposed=Window] on those interfaces) — only the base `Event`
// is available — so gun-relevant fields (clientX/Y, button/buttons) are
// added afterward via defineProperty, the same technique EmulatorClient.js's
// sendMouse() already uses for movementX/Y (real MouseEvent there leaves
// those read-only from its constructor dict).
function realEvent(type, props) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries(props)) {
    try { Object.defineProperty(ev, k, { value: v, configurable: true }); } catch (_) {}
  }
  return ev;
}

// Aim + fire a worker-hosted core's light gun (added for PSX GunCon; see
// systems.js SYSTEMS.psx.lightgun). Mirrors EmulatorClient.sendLightgun's
// single-gun DOM path: (u, v) are normalised canvas coords in [0,1] (origin
// top-left; outside that range = an off-screen/reload shot), `trigger` is the
// held trigger state. RetroArch's patched rwebinput
// (docs/patches/rwebinput-lightgun.diff) reads a game-port light gun's
// absolute aim from the canvas-relative mouse pointer and its
// trigger/reload buttons from the left/right mouse buttons — see that
// file's comment — so this synthesises the same mousemove/mousedown/mouseup
// sequence EmulatorClient dispatches on the main thread, just via this
// worker's own canvas/DOM shim (see writeConfig()'s doc comment for why the
// port-device wiring itself needed separate plumbing; this is the matching
// input-side half).
//
// Verified (per rwebinput_input.c at the pinned RetroArch commit,
// RETROARCH_COMMIT in mednafen_psx_jit_libretro.build.json) that RetroArch's
// keydown/keyup/mousedown/mouseup/mousemove callbacks all register on the
// "#canvas" target, which Emscripten's compiled findEventTarget() resolves
// DIRECTLY to `Module["canvas"]` (not via any "#document" alias) — so this
// dispatches on the real `canvas` object, which is a genuine EventTarget.
// ALSO dispatches the duck-typed equivalent on `inputTarget` (the document
// shim), matching forwardInput()'s existing keyboard precedent, as a
// harmless defensive fallback in case a differently-built core's frontend
// resolves its listener target differently — dispatchEvent() on a target
// with no matching listener is a no-op either way.
//
// MULTIPORT (two-gun) path — added 2026-07-29. Everything above describes the
// SHARED DOM-mouse path, which is all this function had: `port` was only ever a
// gunDownByPort key, so two guns on a worker-execution core (PSX) both wrote the
// same canvas pointer and both libretro ports read the SAME aim. That is the
// exact failure SYSTEMS.psx.lightgun2's `broken` gate was guarding against, and
// it lived on the app side, not in the core artifact. When a `port` is supplied
// AND the core exports the multiport setter, write that port's aim straight into
// its own slot and SKIP the shared mouse entirely — mirroring
// EmulatorClient.sendLightgun's multiport branch line-for-line. Callers that
// omit `port` (every single-gun boot, incl. probe:psx-guncon) take the DOM path
// below unchanged, so the proven single-gun behaviour is untouched.
function forwardLightgun(payload) {
  if (!canvas) return;
  metrics.inputs++;
  const { u, v, trigger, port } = payload || {};
  const offscreen = u < 0 || u > 1 || v < 0 || v > 1;
  const key = port ?? 'default';
  const rect = canvas.getBoundingClientRect();

  if (port != null && resolveWebgun()) {
    // Coordinate space: rwebinput_mouse_cb stores `mouse.x = targetX * dpr`,
    // where targetX is canvas-relative CSS pixels — so the equivalent of what
    // the DOM path below produces is (u * rect.width) * dpr. Deriving it from
    // the SAME getBoundingClientRect() the DOM path uses (rather than from
    // canvas.width) keeps the two paths in one coordinate space by
    // construction: RetroArch's platform_emscripten.c deliberately stomps
    // canvas.width during startup probing (see installWorkerDomShim's
    // layoutWidth comment), so the backing-store size is not a stable
    // reference here the way it is on the main thread.
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    // buttons bitmask: bit index = DOM MouseEvent.button, per rwebinput's
    // `mask = 1 << mouse_event->button` and RWEBINPUT_MOUSE_BTNL=0 / BTNM=1 /
    // BTNR=2. So 1 = left/trigger (on-screen shot), 4 = right/offscreen reload
    // — the same split the DOM path's button/buttons pair encodes.
    let buttons = 0;
    if (trigger) buttons = offscreen ? 4 : 1;
    // Clamp into the framebuffer; an off-screen aim still needs valid pixels so
    // the core's IS_OFFSCREEN test fires on the (held) reload button rather
    // than on a negative coordinate.
    const px = offscreen ? 0 : Math.max(0, Math.min(w - 1, Math.round(u * w)));
    const py = offscreen ? 0 : Math.max(0, Math.min(h - 1, Math.round(v * h)));
    // Defensive: this key may have dispatched a DOM mousedown before the setter
    // resolved (canvas exists from start()'s first statements, moduleInstance
    // only after the core factory resolves), and the multiport branch below
    // returns early, so the matching mouseup would never be emitted. Release it
    // here. In practice rwebinput registers its DOM mouse callbacks inside
    // callMain, which runs strictly AFTER moduleInstance is assigned — i.e.
    // after resolveWebgun() starts succeeding — so no listener can actually have
    // seen that mousedown and the C-side mouse.buttons cannot be latched. What
    // this DOES fix is the JS-side bookkeeping: a stale non-false gunDownByPort
    // entry would suppress the first real mousedown if this key ever fell back
    // to the DOM path, and would misreport `buttons` in the telemetry below.
    const heldOnDom = gunDownByPort[key];
    if (heldOnDom !== undefined && heldOnDom !== false) {
      const upProps = { clientX: rect.left + u * rect.width, clientY: rect.top + v * rect.height, button: heldOnDom, buttons: 0 };
      try { canvas.dispatchEvent(realEvent('mouseup', upProps)); } catch (_) {}
      try { inputTarget?.dispatchEvent(duckEvent('mouseup', upProps)); } catch (_) {}
      gunDownByPort[key] = false;
    }
    try {
      webgunSet(port, px, py, buttons);
      gunAimByPort[key] = { x: px, y: py, buttons, path: 'multiport' };
    } catch (_) { /* core gone */ }
    return;
  }

  const clientX = rect.left + u * rect.width;
  const clientY = rect.top + v * rect.height;
  const moveProps = { clientX, clientY };
  try { canvas.dispatchEvent(realEvent('mousemove', moveProps)); } catch (_) {}
  try { inputTarget?.dispatchEvent(duckEvent('mousemove', moveProps)); } catch (_) {}

  // Seed the entry on first sight. Without this the no-trigger path never writes
  // it, so `gunDownByPort[key]` stayed `undefined` until the first trigger edge —
  // matching neither branch of the `buttons` expression below and falling through
  // to 1, i.e. every idle single-gun boot reported "trigger held" from the first
  // aim until the first real shot.
  if (gunDownByPort[key] === undefined) gunDownByPort[key] = false;
  const wasDown = gunDownByPort[key];
  if (trigger && wasDown === false) {
    // Off-screen shots use the right button (offscreen_shot_mbtn = 2); an
    // on-screen shot uses the left/trigger button (button 0 / buttons bit 1)
    // — same convention EmulatorClient.sendLightgun uses.
    const button = offscreen ? 2 : 0;
    const buttons = offscreen ? 2 : 1;
    const downProps = { clientX, clientY, button, buttons };
    try { canvas.dispatchEvent(realEvent('mousedown', downProps)); } catch (_) {}
    try { inputTarget?.dispatchEvent(duckEvent('mousedown', downProps)); } catch (_) {}
    gunDownByPort[key] = button;
  } else if (!trigger && wasDown !== false) {
    const upProps = { clientX, clientY, button: wasDown, buttons: 0 };
    try { canvas.dispatchEvent(realEvent('mouseup', upProps)); } catch (_) {}
    try { inputTarget?.dispatchEvent(duckEvent('mouseup', upProps)); } catch (_) {}
    gunDownByPort[key] = false;
  }
  gunAimByPort[key] = {
    x: Math.round(clientX), y: Math.round(clientY),
    buttons: gunDownByPort[key] === false ? 0 : (gunDownByPort[key] === 2 ? 4 : 1),
    path: 'dom',
  };
}

// Relative mouse motion + buttons for a worker-hosted core — the worker twin of
// EmulatorClient.sendMouse's single-mouse DOM path, and the reason DOS/Amiga
// mice work at all in worker execution. Before this existed, RuntimeEmulatorClient
// optional-chained `sendMouse` (`this.delegate?.sendMouse?.(...)`), so every mouse
// call against a worker core (dosbox_pure is worker+threaded) silently did
// NOTHING — no error, no log, just a mouse that never moved.
//
// rwebinput reads relative motion from a mousemove's movementX/movementY (the
// pointer-lock delta), not from clientX/Y, so that is the field that has to
// carry the payload; clientX/Y are pinned to the canvas centre purely so the
// event is well-formed. Same dual dispatch as forwardLightgun — a real Event on
// the genuine OffscreenCanvas EventTarget, plus the duck-typed twin on the
// document shim as a defensive fallback.
function forwardMouse(payload) {
  if (!canvas) return;
  metrics.inputs++;
  const { dx = 0, dy = 0, buttons = 0 } = payload || {};
  const mask = buttons & 0x7;
  const rect = canvas.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;

  if (dx || dy) {
    const moveProps = { clientX, clientY, movementX: dx, movementY: dy, buttons: mask };
    try { canvas.dispatchEvent(realEvent('mousemove', moveProps)); } catch (_) {}
    try { inputTarget?.dispatchEvent(duckEvent('mousemove', moveProps)); } catch (_) {}
    mouseState.dx = dx; mouseState.dy = dy; mouseState.moves++;
  }

  if (mask !== mouseButtons) {
    const changed = mask ^ mouseButtons;
    // DOM `button` is the index (0=left, 1=middle, 2=right); `buttons` is the
    // resulting held bitmask. rwebinput uses `mask = 1 << button` with
    // BTNL=0/BTNM=1/BTNR=2, i.e. 1=left, 2=middle, 4=right on the C side — the
    // same index mapping EmulatorClient.sendMouse's BIT_TO_BUTTON encodes.
    const BIT_TO_BUTTON = { 1: 0, 2: 2, 4: 1 };
    for (const bit of [1, 2, 4]) {
      if (!(changed & bit)) continue;
      const button = BIT_TO_BUTTON[bit];
      const goingDown = (mask & bit) !== 0;
      const newMask = goingDown ? (mouseButtons | bit) : (mouseButtons & ~bit);
      const props = { clientX, clientY, button, buttons: newMask };
      try { canvas.dispatchEvent(realEvent(goingDown ? 'mousedown' : 'mouseup', props)); } catch (_) {}
      try { inputTarget?.dispatchEvent(duckEvent(goingDown ? 'mousedown' : 'mouseup', props)); } catch (_) {}
      mouseButtons = newMask;
    }
    mouseState.buttons = mouseButtons;
  }
}

// Resolve (once) the patched core's multiport light-gun setter. Returns a bound
// (port,x,y,buttons)=>void on a multiport-patched core, or null on an unpatched
// core / before the runtime is ready (so forwardLightgun falls back to the
// shared DOM path). Line-for-line the worker twin of
// EmulatorClient.js's _resolveWebgun — cwrap preferred (it marshals args), with
// the raw _rwebinput_set_lightgun export as the fallback.
function resolveWebgun() {
  if (webgunSet) return webgunSet;
  if (webgunSet === false) return null;    // looked up, absent
  const M = moduleInstance;
  if (!M) return null;                     // runtime not ready yet — retry later
  let fn = null;
  try {
    if (typeof M.cwrap === 'function' && (M._rwebinput_set_lightgun || M.asm?.rwebinput_set_lightgun)) {
      fn = M.cwrap('rwebinput_set_lightgun', null, ['number', 'number', 'number', 'number']);
    } else if (typeof M._rwebinput_set_lightgun === 'function') {
      fn = (p, x, y, b) => M._rwebinput_set_lightgun(p, x, y, b);
    }
  } catch (_) { fn = null; }
  webgunSet = fn || false;
  return fn || null;
}

// Resolve (once) rwebinput_clear_lightgun(port), the counterpart of the setter
// resolved above. Same defensive resolution — this build's EXPORTED_RUNTIME_
// METHODS are callMain,FS,addFunction,removeFunction and NOT cwrap, so the raw
// `_rwebinput_clear_lightgun` export is the path that actually gets used; cwrap
// is preferred only when a build happens to have it. Returns null on a core that
// lacks the export (every stock/base-only core), so callers no-op gracefully.
function resolveWebgunClear() {
  if (webgunClear) return webgunClear;
  if (webgunClear === false) return null;  // looked up, absent
  const M = moduleInstance;
  if (!M) return null;                     // runtime not ready yet — retry later
  let fn = null;
  try {
    if (typeof M.cwrap === 'function' && (M._rwebinput_clear_lightgun || M.asm?.rwebinput_clear_lightgun)) {
      fn = M.cwrap('rwebinput_clear_lightgun', null, ['number']);
    } else if (typeof M._rwebinput_clear_lightgun === 'function') {
      fn = (p) => M._rwebinput_clear_lightgun(p);
    }
  } catch (_) { fn = null; }
  webgunClear = fn || false;
  return fn || null;
}

// Hand libretro gun `port` back to the shared DOM mouse: undo the `active`
// latch forwardLightgun's multiport branch set on it, dropping any trigger bit
// still held. The worker end of the 'lightgun-clear' RPC —
// WorkerEmulatorClient.clearLightgun -> here — and the exact twin of
// EmulatorClient.clearLightgun. Idempotent; a silent no-op on a core without
// the multiport patch (nothing was ever latched there) or before the core is
// up.
//
// This is an EXPLICIT binding-change signal, NOT something forwardLightgun can
// infer from its own call pattern: a gun holding still sends the same port
// forever, and a mixed setup interleaves ported and un-ported calls every tick,
// so no call-ordering heuristic can separate "stopped driving" from
// "unchanged". The only caller is LightGunMgr.tick's binding sweep (via
// RuntimeEmulatorClient -> WorkerEmulatorClient), which each frame knows the
// authoritative set of (console, port) bindings being driven — so this covers a
// gun re-jacked to another port, moved to another console, unplugged, dropped,
// or left port-less when a two-gun game is replaced by a single-gun one. NOT
// covered: a REMOTE peer's gun in multiplayer — the host applies peers' aim via
// main.js's _hostApplyGunWire and the 'gun' wire channel carries aim only, no
// binding-change event, so a remote gun's port stays latched on the host's core
// until teardown. Closing that needs a wire-protocol addition.
function clearLightgunPort(payload) {
  const port = payload?.port;
  if (port == null) return;
  const clear = resolveWebgunClear();
  if (!clear) return;   // unpatched core (nothing latched) or runtime not up
  try { clear(port); } catch (_) { /* core gone */ }
  const rec = gunAimByPort[port];
  if (rec) { rec.buttons = 0; rec.released = true; }
}

async function serializeState() {
  if (!detectCapabilities().saveState) throw new Error('core has no save-state support');
  try { moduleInstance.FS.unlink(statePath); } catch (_) {}
  moduleInstance._cmd_save_state();
  let lastSize = -1;
  let stable = 0;
  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 33));
    let size;
    try { size = moduleInstance.FS.stat(statePath).size; } catch (_) { continue; }
    if (size > 0 && size === lastSize && ++stable >= 2) return moduleInstance.FS.readFile(statePath).slice().buffer;
    if (size !== lastSize) stable = 0;
    lastSize = size;
  }
  throw new Error('save state did not stabilize within 2s');
}

async function unserializeState(buffer) {
  if (!detectCapabilities().saveState) throw new Error('core has no save-state support');
  try { moduleInstance.FS.mkdirTree(STATE_DIR); } catch (_) {}
  moduleInstance.FS.writeFile(statePath, new Uint8Array(buffer));
  moduleInstance._cmd_load_state();
  await new Promise((resolve) => setTimeout(resolve, 250));
}

function postMetrics() {
  postMessage(eventMessage('metrics', {
    ...metrics,
    uptimeMs: performance.now() - startedAt,
    jit: jit?.snapshot() || null,
    // Light-gun routing snapshot. `multiport` is the tri-state resolution of the
    // per-port setter (null = never looked up because no ported gun call has
    // happened yet, false = core lacks the multiport patch, true = resolved);
    // `devices` echoes the per-port device overrides actually written into the
    // RA cfg/remap at boot; `ports` is the last aim written per port, tagged
    // with which path carried it. Together these make "did two guns really get
    // two independent aims?" directly observable instead of inferred — see
    // scripts/probe-psx-twogun.js.
    gun: {
      multiport: webgunSet === null ? null : !!webgunSet,
      devices: seatedInputDevices,
      ports: { ...gunAimByPort },
    },
    // Mouse routing snapshot. `moves` separates the two failure modes a silent
    // mouse has: 0 means nothing ever reached the worker (page side not wired),
    // >0 with a dead pointer in-game means the core isn't reading movementX/Y.
    mouse: { ...mouseState },
  }));
}

function stop() {
  clearTimeout(frameTimer);
  clearInterval(metricsTimer);
  clearFrameAckWatchdog();
  frameTimer = null;
  metricsTimer = null;
  jit?.clear();
  moduleInstance?._cmd_unload_core?.();
  moduleInstance = null;
  discBridge = new DiscControlBridge(null, { discCount: 1 });
  canvas = null;
  for (const k of Object.keys(gunDownByPort)) delete gunDownByPort[k];
  for (const k of Object.keys(gunAimByPort)) delete gunAimByPort[k];
  // The resolved setter/clearer are bound to the module we just dropped —
  // re-resolve against the next core rather than calling into a freed instance.
  // The core's own per-port latch state dies with that module.
  webgunSet = null;
  webgunClear = null;
  seatedInputDevices = null;
  // Held buttons die with the module; a stale mask would suppress the next
  // core's first real mousedown (the diff in forwardMouse would see no change).
  mouseButtons = 0;
  Object.assign(mouseState, { dx: 0, dy: 0, buttons: 0, moves: 0 });
}

async function handle(method, payload) {
  switch (method) {
    case 'start': return start(payload);
    case 'load-content': await hydrateLaunch(payload); moduleInstance?._cmd_reset?.(); return { capabilities: detectCapabilities() };
    case 'reset': moduleInstance?._cmd_reset?.(); return null;
    case 'pause': setPaused(true); return null;
    case 'resume': setPaused(false); return null;
    case 'set-disc': return discBridge.setDisc(payload.index);
    case 'set-disc-ejected': return discBridge.setEjected(payload.ejected);
    case 'disc-status': return discBridge.status();
    case 'read-save-ram': return readSaveRam(payload.slot || 1);
    case 'input': forwardInput(payload); return null;
    case 'lightgun': forwardLightgun(payload); return null;
    case 'mouse': forwardMouse(payload); return null;
    case 'lightgun-clear': clearLightgunPort(payload); return null;
    case 'serialize-state': return serializeState();
    case 'unserialize-state': await unserializeState(payload.data); return null;
    case 'stop': stop(); return null;
    default: throw new Error(`unknown worker method '${method}'`);
  }
}

function mkdir(path) { try { moduleInstance.FS.mkdirTree(path); } catch (_) {} }

// `data` arrives as either an ArrayBuffer (small/already-materialized
// sources) or a Blob/File (large disc tracks passed through untouched by
// WorkerEmulatorClient's prepareLaunchPayload, C1 2026-07-27 review
// followup) — this is the one place in the worker that actually needs the
// bytes, so it's also the one place that reads a Blob's contents.
async function bytesOf(data) {
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return new Uint8Array(data);
}

async function writeRelative(root, relative, data) {
  const clean = safeRelativePath(relative);
  const target = `${root}/${clean}`;
  const slash = target.lastIndexOf('/');
  mkdir(target.slice(0, slash));
  moduleInstance.FS.writeFile(target, await bytesOf(data));
}

function safeRelativePath(path) {
  const clean = String(path || '').replace(/\\/g, '/');
  if (!clean || clean.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(clean) || clean.includes('\0') || clean.split('/').some((part) => part === '..')) {
    throw new Error(`unsafe worker VFS path: ${path}`);
  }
  return clean.split('/').filter((part) => part && part !== '.').join('/');
}

function basenameWithoutExtension(path) {
  const leaf = safeRelativePath(path).split('/').pop() || 'rom';
  return leaf.replace(/\.[^.]+$/, '') || 'rom';
}

function saveRamPath(slot = 1) { return `${SAVE_DIR}/${saveStem}${slot === 1 ? '' : `.${slot}`}.srm`; }

function readSaveRam(slot) {
  try { return moduleInstance.FS.readFile(saveRamPath(slot)).slice().buffer; }
  catch { return null; }
}

// Prefer Module.pauseMainLoop()/resumeMainLoop() — Emscripten's generic
// MAIN_LOOP support (the SAME exports the main-thread EmulatorClient.js uses,
// see its pause()/resume() ~:255-263) — over _cmd_pause(), a single TOGGLE
// command tracked only by the `paused` JS boolean below. Before this fix,
// setPaused always called _cmd_pause() for BOTH directions: any desync between
// that boolean and the core's real state (e.g. a dropped/duplicate request)
// could invert pause permanently with no way to recover. pauseMainLoop/
// resumeMainLoop are each idempotent and directional, so they can't desync the
// same way; _cmd_pause() is kept only as a last-resort fallback for a core
// that doesn't export them (B5, 2026-07-25 review).
function setPaused(next) {
  if (paused === next) return;
  if (next) {
    if (typeof moduleInstance?.pauseMainLoop === 'function') moduleInstance.pauseMainLoop();
    else if (typeof moduleInstance?._cmd_pause === 'function') moduleInstance._cmd_pause();
    else throw new Error('core has no pause command');
  } else {
    if (typeof moduleInstance?.resumeMainLoop === 'function') moduleInstance.resumeMainLoop();
    else if (typeof moduleInstance?._cmd_pause === 'function') moduleInstance._cmd_pause();
    else throw new Error('core has no resume command');
  }
  paused = next;
}

self.addEventListener('message', async (event) => {
  let message;
  try { message = assertProtocolMessage(event.data); }
  catch (error) { postMessage(eventMessage('error', serializeError(error))); return; }
  if (message === null) {
    return; // foreign traffic on the same channel (see assertProtocolMessage) — not ours, not an error
  }
  if (message.type === WorkerMessage.FRAME_ACK) { framePending = false; clearFrameAckWatchdog(); return; }
  if (message.type !== WorkerMessage.REQUEST) return;
  try {
    const result = await handle(message.method, message.payload);
    if (message.id) postMessage(responseMessage(message.id, result));
  } catch (error) {
    metrics.errors++;
    if (message.id) postMessage(responseMessage(message.id, null, serializeError(error)));
    else postMessage(eventMessage('error', serializeError(error)));
  }
});

self.addEventListener('error', (event) => {
  metrics.errors++;
  postMessage(eventMessage('error', serializeError(event.error || event.message)));
});

self.addEventListener('unhandledrejection', (event) => {
  metrics.errors++;
  postMessage(eventMessage('error', serializeError(event.reason)));
});
