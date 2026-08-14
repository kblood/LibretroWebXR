// ConsoleRuntime — one running console: an EmulatorClient + its own video
// canvas + the loaded ROM/system + lifecycle (load / pause / resume / dispose)
// + per-instance input (canvas-targeted, so keys reach only THIS core).
//
// This is the unit the multi-console rack ([[src/RackMgr.js]]) multiplies. The
// Phase-0 spike proved N module cores can run isolated in their own canvases;
// ConsoleRuntime is that, productionised: a stable handle with a weight (for the
// [[src/RackBudget.js]] admission policy) and a clean pause/resume the budget
// drives.
//
// Two construction modes:
//   • own   — creates its own offscreen <canvas> + a fresh EmulatorClient
//             (the normal case for spawned consoles).
//   • adopt — wraps an EXISTING { client, canvas } (the primary console main.js
//             already wired to #canvas / the main TV), so the established
//             single-console path becomes console0 of the rack with no behaviour
//             change and no second WebGL context.
//
// Cores can't cleanly unload (they pin a WebGL context that survives callMain),
// so dispose() pauses + detaches rather than truly freeing — RackBudget's
// maxLive cap is what bounds live contexts.

import { RuntimeEmulatorClient } from './RuntimeEmulatorClient.js';
import { bootConfigSignature } from './EmulatorClient.js';
import { coreWeight } from './systems.js';

/**
 * Would starting `startOptions` on `client` need a brand-new core (a fresh
 * client + canvas), rather than the cheap same-core content hot swap?
 *
 * TRUE when the core itself differs, or when any per-launch boot configuration
 * field does — controller-port devices, core options, remap, BIOS. RetroArch
 * reads all of those exactly once, at core boot, so a change to any of them
 * cannot be applied to a core that is already running (see the BOOT
 * CONFIGURATION note in EmulatorClient.js). FALSE before the first boot and for
 * a plain content swap with identical configuration — the common case the
 * hot-swap path exists to make fast.
 *
 * ONE definition, used by BOTH consoles: the rack path via
 * ConsoleRuntime.needsFreshBoot() below, and main.js's primary path, which
 * drives its adopted client's start() directly. The PRIMARY console's client is
 * a RuntimeEmulatorClient facade that forwards start() to a delegate, so unwrap
 * it — the delegate is what actually loaded a core and holds its identity. A
 * client with no `bootConfig` at all (WorkerEmulatorClient) needs no fresh boot:
 * it tears its worker down and restarts it for EVERY content swap, so a changed
 * boot configuration is always re-applied there anyway.
 */
export function clientNeedsFreshBoot(client, startOptions = {}) {
  const core = client?.delegate ?? client;
  if (typeof core?.bootConfig !== 'string') return false;
  if (startOptions.coreName && core.coreName && startOptions.coreName !== core.coreName) return true;
  return bootConfigSignature(startOptions) !== core.bootConfig;
}

export class ConsoleRuntime {
  /**
   * @param {object} opts
   * @param {string} opts.id                    stable console id (Patchbay key)
   * @param {object} [opts.adopt]               { client, canvas } to wrap instead of creating
   * @param {Document} [opts.document]          DOM document (for tests/headless)
   * @param {number} [opts.width]  canvas width  (own mode, default 640)
   * @param {number} [opts.height] canvas height (own mode, default 480)
   * @param {object} [opts.audio]  SpatialAudio router ({ ensureBranch, pushSamples, ... },
   *                               see src/SpatialAudio.js). Optional — omitted in most
   *                               tests. When supplied, worker-execution cores (PSX/N64)
   *                               get their audio routed into it (B3, 2026-07-25 review);
   *                               main-thread cores are unaffected (they never emit an
   *                               'audio' event — see EmulatorClient.js — so binding this
   *                               listener unconditionally is harmless for them).
   */
  constructor({ id, adopt = null, document: doc = (typeof document !== 'undefined' ? document : null), width = 640, height = 480, audio = null, canRun = null } = {}) {
    this.id = id;
    this._canRun = typeof canRun === 'function' ? canRun : null;
    this.adopted = !!adopt;
    this.coreName = null;
    this.system = null;
    this.title = null;
    this.weight = 1;
    this.loaded = false;
    // True from the moment a core boot is *attempted* (top of load(), or
    // noteLoaded() for an externally-booted adopted client). Distinct from
    // `loaded`, which only flips once the boot resolved — see hasCore().
    this._started = false;
    this._disposed = false;
    this._audio = audio;

    if (adopt) {
      this.client = adopt.client;
      this.canvas = adopt.canvas;
    } else {
      if (!doc) throw new Error('ConsoleRuntime: no document to create a canvas');
      this.canvas = doc.createElement('canvas');
      this.canvas.id = `console-canvas-${id}`;
      this.canvas.width = width;
      this.canvas.height = height;
      // Kept in the DOM (some cores need an attached canvas for WebGL) but out
      // of the page flow; the scene textures it onto a TV mesh.
      this.canvas.style.cssText = 'position:absolute;left:-9999px;top:0;width:320px;height:240px;';
      (doc.body || doc.documentElement).appendChild(this.canvas);
      this.client = new RuntimeEmulatorClient();
    }
    if (this._audio && typeof this.client?.addEventListener === 'function') {
      this.client.addEventListener('audio', (event) => this._audio.pushSamples(this.id, event.detail));
    }
  }

  /** True once a ROM has booted (or, in adopt mode, if the client is ready). */
  isLoaded() { return this.loaded || (this.adopted && !!this.client?.ready); }

  /**
   * Whether a core genuinely EXISTS on this runtime — i.e. a boot has at least
   * been attempted. A freshly-constructed ConsoleRuntime (the display-only
   * watcher's adopted primary is the important case: main.js builds it, then the
   * M1.4 gate stops it ever booting) has an EmulatorClient object but no core
   * and no main loop, so every "is it running" question about it must answer no.
   *
   * Three sources, because no single one covers every boot path:
   *   • `loaded`   — ConsoleRuntime.load() finished, or noteLoaded() recorded an
   *                  externally-driven boot (main.js's primary console).
   *   • `_started` — load() was ENTERED but hasn't resolved yet (a mid-boot core
   *                  whose main loop is about to start still has to be pausable).
   *   • `client.ready` — the adopted primary is booted directly by main.js via
   *                  `client.start()`; this covers the window before its
   *                  noteLoaded() call lands.
   */
  hasCore() { return this.loaded || this._started || !!this.client?.ready; }

  /**
   * Whether the core's main loop is currently running.
   *
   * NOT just `!client.paused`: `paused` is falsy on a client that was never
   * started, so the old one-liner reported `live: true` for a CORELESS runtime —
   * documented as a live trap in docs/MULTIPLAYER.md and docs/HANDOFF.md (M1.4),
   * where a display-only watcher's `__rack.live()` claimed its never-booted
   * primary was running and every test had to remember to filter on `r.core`.
   * A runtime with no core is not live; requiring hasCore() makes that honest.
   */
  isLive() { return this.hasCore() && !this.client?.paused; }

  /**
   * The exact options object load() hands to client.start(), built in ONE place
   * so needsFreshBoot() below asks its question about the very same values the
   * boot would use. (Before this existed, the rack path built its options inline
   * and simply omitted the peripheral fields — a light-gun cartridge dropped on
   * a secondary console got no gun device at all, and a same-core swap kept the
   * previous game's devices. See main.js's loadCartridgeIntoConsole.)
   * @param {{name:string,url:string,style:string}} core
   * @param {object} meta
   */
  startOptions(core, meta = {}) {
    return {
      coreUrl: core.url, coreName: core.name, moduleStyle: core.style,
      contentExt: meta.contentExt,
      // Light-gun / port-device wiring (LightGunMgr supplies these when a gun is
      // seated on this console): inputDevices = {player: libretroDeviceId},
      // coreOptions selects the gun read path, remapName names the per-core remap
      // file that connects the device at boot. All optional — plain games omit them.
      coreOptions: meta.coreOptions ?? core.coreOptions,
      inputDevices: meta.inputDevices,
      // `?? core.remapName`: the remap FILE is what actually connects an
      // inputDevices port override at boot, so a core that declares its own RA
      // library name must keep it when the caller supplies no peripheral-specific
      // one — otherwise EmulatorClient warns "inputDevices set without remapName"
      // and the device silently never connects.
      remapName: meta.remapName ?? core.remapName,
      // Per-core BIOS/Kickstart (e.g. PUAE Amiga). meta wins when the caller
      // strips `core` to {name,url,style}; else read it off the full core entry.
      systemFiles: meta.systemFiles ?? core.systemFiles,
      // Execution topology (RuntimeEmulatorClient): absent/'main' for every
      // core except the worker-execution ones (PSX/N64 — see systems.js).
      execution: meta.execution ?? core.execution,
      requiresThreads: meta.requiresThreads ?? core.requiresThreads,
      coreBuildHash: meta.buildHash ?? core.buildHash,
      // Worker-mode BIOS + restored native SaveRAM (B1, 2026-07-25 review): both
      // were silently dropped here before — a secondary/rack console booting a
      // firmware-gated worker core (PSX) never got its BIOS, and never got its
      // previously-flushed SaveRAM back. Pre-resolved by the caller (main.js's
      // buildStartOptions) since resolving them needs FirmwareStore/SaveRamStore
      // (IndexedDB), which this class deliberately doesn't depend on — it stays
      // pure enough to unit-test with fakes (see RackMgr.js's doc comment).
      firmware: meta.firmware,
      restoredSaves: meta.restoredSaves,
    };
  }

  /**
   * Whether booting `core`+`meta` HERE needs a brand-new ConsoleRuntime rather
   * than load()'s in-place swap — because the core differs, or because the boot
   * configuration does (peripherals/core options/remap/BIOS are read once, at
   * core boot; see EmulatorClient's BOOT CONFIGURATION note). load() would throw
   * BootConfigChangeError in that case; callers that can stand up a fresh
   * runtime (main.js's bootFreshRuntime) ask this first and do so instead.
   */
  needsFreshBoot(core, meta = {}) {
    if (!this.hasCore()) return false;
    if (this.coreName && core?.name && this.coreName !== core.name) return true;
    return clientNeedsFreshBoot(this.client, this.startOptions(core, meta));
  }

  /**
   * Boot a ROM into this console's core. `core` is the systems.js core info
   * ({ name, url, style }); `meta` carries system/title for labelling plus the
   * per-launch boot configuration (see startOptions above). THROWS
   * BootConfigChangeError when that configuration differs from what the loaded
   * core booted with — ask needsFreshBoot() first if you can recover.
   * @param {ArrayBuffer|ContentBundle} romBuffer
   * @param {{name:string,url:string,style:string}} core
   * @param {{system?:string,title?:string,firmware?:object,restoredSaves?:object}} [meta]
   */
  async load(romBuffer, core, meta = {}) {
    // Marked BEFORE the await: from here on a main loop may start at any moment,
    // so isLive()/pauseAll() must already treat this runtime as having a core.
    this._started = true;
    const options = this.startOptions(core, meta);
    // Worker-execution cores (PSX/N64) push decoded PCM straight into
    // pushSamples() instead of creating a same-thread AudioContext (see
    // SpatialAudio.js's ensureBranch doc comment) — register the branch before
    // the core can possibly emit its first sample. Consumes whatever `expect()`
    // the caller queued just before this call (the established pattern every
    // spawn/swap site already follows for main-thread cores); harmless no-op
    // for a main-thread boot (B3, 2026-07-25 review).
    if (options.execution === 'worker') this._audio?.ensureBranch?.(this.id);
    await this.client.start(this.canvas, romBuffer, options);
    this.coreName = core.name;
    this.system = meta.system ?? null;
    this.title = meta.title ?? null;
    this.weight = coreWeight(core.name);
    this.loaded = true;
    return this;
  }

  // Adopt-mode helper: when the wrapped client is booted externally (main.js
  // drives the primary console's boot directly), record what it loaded so the
  // budget knows this console's real weight/system without load() owning boot.
  noteLoaded(coreName, meta = {}) {
    this._started = true;
    this.coreName = coreName;
    this.system = meta.system ?? this.system;
    this.title = meta.title ?? this.title;
    this.weight = coreWeight(coreName);
    this.loaded = true;
  }

  /**
   * Install the "may this console run at all?" predicate. RackMgr.add() wires
   * this to its own allowRun gate, so every runtime in the rack inherits it —
   * see RackMgr.js. Absent predicate = always allowed (solo play, unit tests).
   */
  setCanRun(fn) { this._canRun = typeof fn === 'function' ? fn : null; return this; }

  /** Fails OPEN: a throwing/absent predicate must never brick solo play. */
  runAllowed() {
    if (!this._canRun) return true;
    try { return this._canRun(this) !== false; }
    catch (e) { console.warn('[ConsoleRuntime] canRun threw', e); return true; }
  }

  pause() { try { this.client?.pause?.(); } catch (e) { console.warn('[ConsoleRuntime] pause', e); } }

  /**
   * Start (or restart) this console's main loop — UNLESS running is currently
   * forbidden (display-only netplay client; see RackMgr's allowRun). A refused
   * resume re-asserts the pause instead, so a console power switch or a stray
   * budget pass can't quietly hand a watcher its own live core back.
   * @returns {boolean} whether the core is now allowed to run.
   */
  resume() {
    if (!this.runAllowed()) {
      try { this.client?.pause?.(); } catch (_) {}
      return false;
    }
    try { this.client?.resume?.(); } catch (e) { console.warn('[ConsoleRuntime] resume', e); }
    return true;
  }

  /** Dispatch a synthetic key event to THIS console's core (canvas-targeted). */
  sendInput(eventType, code, key, keyCode, location) {
    this.client?.sendInput?.(eventType, code, key, keyCode, location);
  }

  /** Pause + detach. Never frees the WebGL context (cores can't unload). */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.pause();
    if (!this.adopted) {
      try { this.canvas?.remove?.(); } catch (_) {}
    }
  }
}
