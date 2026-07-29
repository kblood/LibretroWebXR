import { EmulatorClient } from './EmulatorClient.js';
import { WorkerEmulatorClient } from './runtime/WorkerEmulatorClient.js';

export async function resolveCoreBuildHash(coreUrl, fallback = 'unversioned', fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function' || !/\.js(?:[?#].*)?$/i.test(String(coreUrl || ''))) return fallback;
  const manifestUrl = String(coreUrl).replace(/\.js(?=([?#]|$))/i, '.build.json');
  try {
    const response = await fetchImpl(manifestUrl, { cache: 'no-store' });
    if (!response.ok) return fallback;
    const manifest = await response.json();
    const wasm = Object.entries(manifest?.artifacts || {}).find(([name]) => name.endsWith('.wasm'))?.[1];
    return /^[a-f0-9]{64}$/i.test(wasm?.sha256 || '') ? `sha256:${wasm.sha256.toLowerCase()}` : fallback;
  } catch (_) {
    return fallback;
  }
}

// Thrown by start() instead of a generic Error when a caller asks for a
// different execution topology (main-thread <-> worker) than the one already
// running on this facade. This can't be serviced in place: a <canvas> element
// can only ever host ONE context type (WebGL for EmulatorClient, 2D for
// WorkerEmulatorClient's FrameBridge) for its whole lifetime, so switching
// requires a fresh canvas, not just a fresh delegate. Structured (not a bare
// Error) so callers can recover deliberately instead of the switch being a
// silent, permanent dead end for the rest of the page's life (P0-3, 2026-07-25
// review) — see main.js's bootOnPrimary/bootFreshRuntime for the actual
// recovery (a live fresh-canvas swap, the same mechanism the light-gun/mouse
// arm-reboot already uses) and RomInput's cross-core handling for the reload
// fallback used where the content can't be re-handed to a fresh boot.
export class RuntimeModeSwitchError extends Error {
  constructor(currentMode, desiredMode) {
    super(`runtime switch from ${currentMode} to ${desiredMode} requires a fresh canvas/delegate (a <canvas> can't change context type in place) — see RuntimeModeSwitchError`);
    this.name = 'RuntimeModeSwitchError';
    this.code = 'MODE_SWITCH_REQUIRED';
    this.currentMode = currentMode;
    this.desiredMode = desiredMode;
  }
}

// Stable facade used by input, save-state and UI code while selecting the
// execution topology per core. Classic cores retain their proven page-bound
// loader; the modular PSX JIT core always runs in its dedicated worker.
export class RuntimeEmulatorClient extends EventTarget {
  constructor() {
    super();
    this.delegate = null;
    this.mode = null;
    this.buildHash = 'unversioned';
  }

  get ready() { return !!this.delegate?.ready; }
  get paused() { return !!this.delegate?.paused; }
  get capabilities() { return this.delegate?.capabilities || {}; }

  async start(canvas, content, options = {}) {
    const desiredMode = options.execution === 'worker' || options.workerRequired ? 'worker' : 'main';
    this.buildHash = desiredMode === 'worker'
      ? await resolveCoreBuildHash(options.coreUrl, options.coreBuildHash)
      : options.coreBuildHash || 'unversioned';
    if (this.delegate && desiredMode !== this.mode) {
      throw new RuntimeModeSwitchError(this.mode, desiredMode);
    }
    if (!this.delegate) {
      this.mode = desiredMode;
      this.delegate = desiredMode === 'worker' ? new WorkerEmulatorClient() : new EmulatorClient();
      for (const type of ['ready', 'error', 'audio', 'metrics', 'log']) {
        this.delegate.addEventListener(type, (event) => this.dispatchEvent(new CustomEvent(type, { detail: event.detail })));
      }
    }
    return this.delegate.start(canvas, content, options);
  }

  reset() { return this.delegate?.reset(); }
  pause() { return this.delegate?.pause(); }
  resume() { return this.delegate?.resume(); }
  stop() { return this.delegate?.stop?.(); }
  sendInput(...args) { return this.delegate?.sendInput(...args); }
  sendLightgun(...args) { return this.delegate?.sendLightgun?.(...args); }
  // Release a multiport light-gun port's `active` latch (LightGunMgr's binding
  // sweep). Optional on the delegate — a delegate without it just means nothing
  // was ever latched.
  clearLightgun(...args) { return this.delegate?.clearLightgun?.(...args); }
  sendMouse(...args) { return this.delegate?.sendMouse?.(...args); }
  canSerialize() { return !!this.delegate?.canSerialize?.(); }
  serializeState() { return this.delegate?.serializeState(); }
  unserializeState(data) { return this.delegate?.unserializeState(data); }
  setDisc(index) { return this.delegate?.setDisc?.(index); }
  setDiscEjected(ejected) { return this.delegate?.setDiscEjected?.(ejected); }
  discStatus() { return this.delegate?.discStatus?.(); }
  readSaveRam(slot = 1) { return this.delegate?.readSaveRam?.(slot); }
  flushSaveRam(slot = 1) { return this.delegate?.flushSaveRam?.(slot); }
}
