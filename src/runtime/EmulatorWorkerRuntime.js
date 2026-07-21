import {
  RETROARCH_CFG,
  RETROARCH_CORE_OPTIONS,
  RETROARCH_CORE_OPTIONS_PATH,
} from '../RetroArchConfig.js';
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
let disc = { index: 0, ejected: false, discCount: 1 };
const metrics = { framesProduced: 0, framesSkipped: 0, inputs: 0, audioBatches: 0, errors: 0 };

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
    offscreenCanvas.getBoundingClientRect ||= () => ({
      left: 0,
      top: 0,
      right: offscreenCanvas.width,
      bottom: offscreenCanvas.height,
      width: offscreenCanvas.width,
      height: offscreenCanvas.height,
    });
    if (!('clientWidth' in offscreenCanvas)) {
      Object.defineProperty(offscreenCanvas, 'clientWidth', { get: () => offscreenCanvas.width });
    }
    if (!('clientHeight' in offscreenCanvas)) {
      Object.defineProperty(offscreenCanvas, 'clientHeight', { get: () => offscreenCanvas.height });
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
  writeConfig();
  hydrateLaunch(payload);

  if (payload.entrypoint === 'retroarch') {
    try { moduleInstance.callMain(payload.arguments || ['-c', RA_CFG_PATH, entryPath]); }
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
    discControl: discCapabilities().supported,
    jit: !!globalThis.__libretroWebXRJit,
    audioBridge: true,
    frameBridge: typeof canvas?.transferToImageBitmap === 'function',
  };
}

function writeConfig() {
  if (!moduleInstance?.FS) return;
  const targets = [
    ['/home/web_user/retroarch/userdata', RA_CFG_PATH, RETROARCH_CFG],
    ['/home/web_user/retroarch/userdata', RETROARCH_CORE_OPTIONS_PATH, RETROARCH_CORE_OPTIONS],
    ['/home/web_user/.config/retroarch', '/home/web_user/.config/retroarch/retroarch.cfg', RETROARCH_CFG],
    ['/home/web_user', '/home/web_user/.retroarch.cfg', RETROARCH_CFG],
  ];
  for (const [dir, path, contents] of targets) {
    try { moduleInstance.FS.mkdirTree(dir); } catch (_) {}
    moduleInstance.FS.writeFile(path, contents);
  }
}

function hydrateLaunch(payload) {
  if (!moduleInstance?.FS) throw new Error('worker core did not expose Emscripten FS');
  const content = payload.content;
  if (!content?.entryPath || !Array.isArray(content.files)) throw new Error('worker launch is missing a content bundle');
  entryPath = `${CONTENT_DIR}/${safeRelativePath(content.entryPath)}`;
  saveStem = basenameWithoutExtension(content.entryPath);
  statePath = `${STATE_DIR}/${saveStem}.state`;
  mkdir(CONTENT_DIR);
  for (const file of content.files) writeRelative(CONTENT_DIR, file.path, file.data);
  mkdir(SYSTEM_DIR);
  for (const record of payload.firmware || []) writeRelative(SYSTEM_DIR, record.name, record.data);
  mkdir(SAVE_DIR);
  for (const record of payload.restoredSaves || []) {
    moduleInstance.FS.writeFile(saveRamPath(record.slot || 1), new Uint8Array(record.data));
  }
  disc = { index: 0, ejected: false, discCount: Math.max(1, payload.discCount || 1) };
}

function startFramePump(interval) {
  const pump = () => {
    frameTimer = setTimeout(pump, interval);
    if (!canvas || framePending || typeof canvas.transferToImageBitmap !== 'function') {
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
  }));
}

function stop() {
  clearTimeout(frameTimer);
  clearInterval(metricsTimer);
  frameTimer = null;
  metricsTimer = null;
  jit?.clear();
  moduleInstance?._cmd_unload_core?.();
  moduleInstance = null;
  canvas = null;
}

async function handle(method, payload) {
  switch (method) {
    case 'start': return start(payload);
    case 'load-content': hydrateLaunch(payload); moduleInstance?._cmd_reset?.(); return { capabilities: detectCapabilities() };
    case 'reset': moduleInstance?._cmd_reset?.(); return null;
    case 'pause': setPaused(true); return null;
    case 'resume': setPaused(false); return null;
    case 'set-disc': return setDisc(payload.index);
    case 'set-disc-ejected': return setDiscEjected(payload.ejected);
    case 'disc-status': return discStatus();
    case 'read-save-ram': return readSaveRam(payload.slot || 1);
    case 'input': forwardInput(payload); return null;
    case 'serialize-state': return serializeState();
    case 'unserialize-state': await unserializeState(payload.data); return null;
    case 'stop': stop(); return null;
    default: throw new Error(`unknown worker method '${method}'`);
  }
}

function mkdir(path) { try { moduleInstance.FS.mkdirTree(path); } catch (_) {} }

function writeRelative(root, relative, buffer) {
  const clean = safeRelativePath(relative);
  const target = `${root}/${clean}`;
  const slash = target.lastIndexOf('/');
  mkdir(target.slice(0, slash));
  moduleInstance.FS.writeFile(target, new Uint8Array(buffer));
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

function setPaused(next) {
  if (paused === next) return;
  if (typeof moduleInstance?._cmd_pause !== 'function') throw new Error('core has no pause command');
  moduleInstance._cmd_pause();
  paused = next;
}

function discCapabilities() {
  const explicit = typeof moduleInstance?._libretrowebxr_set_disc_index === 'function' && typeof moduleInstance?._libretrowebxr_set_eject_state === 'function';
  const sequential = typeof moduleInstance?._cmd_disk_next === 'function' && typeof moduleInstance?._cmd_disk_eject_toggle === 'function';
  return { supported: explicit || sequential, explicit, sequential };
}

function discStatus() { return { ...disc, ...discCapabilities() }; }

function setDiscEjected(nextValue) {
  const next = !!nextValue;
  if (disc.ejected === next) return discStatus();
  if (typeof moduleInstance?._libretrowebxr_set_eject_state === 'function') moduleInstance._libretrowebxr_set_eject_state(next ? 1 : 0);
  else if (typeof moduleInstance?._cmd_disk_eject_toggle === 'function') moduleInstance._cmd_disk_eject_toggle();
  else throw new Error('core has no disc eject control');
  disc.ejected = next;
  return discStatus();
}

function setDisc(index) {
  if (!Number.isInteger(index) || index < 0 || index >= disc.discCount) throw new RangeError(`disc index ${index} is outside 0..${disc.discCount - 1}`);
  const capabilities = discCapabilities();
  if (!capabilities.supported) throw new Error('core has no disc control');
  const wasEjected = disc.ejected;
  if (!wasEjected) setDiscEjected(true);
  if (capabilities.explicit) {
    if (moduleInstance._libretrowebxr_set_disc_index(index) === 0) throw new Error(`core rejected disc index ${index}`);
  } else {
    const forward = (index - disc.index + disc.discCount) % disc.discCount;
    const backward = (disc.index - index + disc.discCount) % disc.discCount;
    if (backward < forward && typeof moduleInstance._cmd_disk_prev === 'function') {
      for (let i = 0; i < backward; i++) moduleInstance._cmd_disk_prev();
    } else {
      for (let i = 0; i < forward; i++) moduleInstance._cmd_disk_next();
    }
  }
  disc.index = index;
  if (!wasEjected) setDiscEjected(false);
  return discStatus();
}

self.addEventListener('message', async (event) => {
  let message;
  try { message = assertProtocolMessage(event.data); }
  catch (error) { postMessage(eventMessage('error', serializeError(error))); return; }
  if (message.type === WorkerMessage.FRAME_ACK) { framePending = false; return; }
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
