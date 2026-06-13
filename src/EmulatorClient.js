// Main-thread libretro loader, matching webretro's working pattern.
//
// We previously ran the core in a Web Worker via webretro's emulator-worker.js,
// but driving the debug harness with a real ROM revealed that file was abandoned
// experimental code — webretro's actually-working path defines `window.Module`
// on the main thread and loads the core via a <script> tag, which auto-inits
// against the global Module. We do the same here for "classic" cores.
//
// Newer libretro buildbot cores are MODULARIZE=1 ES modules: they `export
// default libretro_<name>` (a factory) and use `import.meta.url` internally,
// which makes them a parse error inside a classic <script> tag. For those we
// use the official RetroArch web-player pattern (libretro.js line 380):
//   const mod = await import(coreUrl);
//   const Module = await mod.default(moduleArg);
//
// Architecture (both styles):
//   - The libretro core grabs WebGL on `emuCanvas` (must have no prior context).
//   - The core drives its own rAF loop (`emscripten_set_main_loop`).
//   - Three.js samples `emuCanvas` as a CanvasTexture for the TV mesh.

import { RETROARCH_CFG, RETROARCH_CFG_DIR, RETROARCH_CFG_PATH } from './RetroArchConfig.js';

const ROM_VFS_PATH = '/rom/rom.bin';
const STATE_DIR = '/home/web_user/retroarch/userdata/states';
const STATE_PATH = STATE_DIR + '/rom.state';
// `-c PATH` explicitly tells RA which config file to load. RA's default
// search order is $XDG_CONFIG_HOME/retroarch/, $HOME/.config/retroarch/,
// and $HOME/.retroarch.cfg — none of which is /home/web_user/retroarch/
// userdata/, the path webretro (and we) write to. `-c` is belt; we also
// write the cfg into the default search paths in _writeRetroArchConfig as
// suspenders. GameInputMgr is the last line of defence: it dispatches both
// the webretro key (h/g/space) AND the RA stock key (x/z/RShift) for each
// logical button so the controller works even if no cfg is honoured.
const RA_CFG_PATH = '/home/web_user/retroarch/userdata/retroarch.cfg';

export class EmulatorClient extends EventTarget {
  constructor({
    coreUrl = 'cores/snes9x_libretro.js',
    coreName = 'snes9x',
    moduleStyle = 'classic', // 'classic' | 'module'
  } = {}) {
    super();
    this.coreUrl = coreUrl;
    this.coreName = coreName;
    this.moduleStyle = moduleStyle;
    this.emuCanvas = null;
    this.ready = false;
    this._coreLoaded = false;
    // Whether the core's emscripten main loop is intentionally paused. Owned by
    // the host-video flow (M1.2 follow-up): a peer watching the host's streamed
    // frames pauses its own core to stop wasting CPU/battery emulating something
    // it isn't even showing. Re-applied after (re)start so the desired state
    // survives a fresh callMain / a same-core ROM swap (see _applyPauseState).
    this.paused = false;
  }

  async start(emuCanvas, romBuffer, opts = {}) {
    this.emuCanvas = emuCanvas;
    if (!this._coreLoaded) {
      if (opts.coreUrl) this.coreUrl = opts.coreUrl;
      if (opts.coreName) this.coreName = opts.coreName;
      if (opts.moduleStyle) this.moduleStyle = opts.moduleStyle;
    } else if (opts.coreName && opts.coreName !== this.coreName) {
      this._fail(`core switch from ${this.coreName} to ${opts.coreName} requires page reload`);
      return;
    }

    if (!this._coreLoaded) {
      await this._loadCore();
      this._coreLoaded = true;
    } else {
      // Subsequent calls (same core, different ROM): reset and swap rom.bin.
      this._writeRom(romBuffer);
      this._getModule()._cmd_reset?.();
      this._applyPauseState();
      this.dispatchEvent(new CustomEvent('ready'));
      return;
    }

    await this._waitForRuntime();
    this._writeRetroArchConfig();
    this._writeRom(romBuffer);
    try {
      this._getModule().callMain(['-c', RA_CFG_PATH, ROM_VFS_PATH]);
      this.ready = true;
      // callMain installs the core's main loop already running; if a pause was
      // requested before the loop existed (e.g. host video arrived first), apply
      // it now so a freshly-booted watcher core doesn't briefly run.
      this._applyPauseState();
      this.dispatchEvent(new CustomEvent('ready'));
    } catch (e) {
      this._fail(`callMain threw: ${e.message || e}`);
    }
  }

  reset() {
    try { this._getModule()?._cmd_reset?.(); } catch (e) { console.warn(e); }
  }

  // ---- main-loop pause/resume (M1.2 follow-up) ----
  //
  // Halt/restart the core's emscripten main loop via the Browser API methods
  // the buildbot cores export (Module.pauseMainLoop / resumeMainLoop). This
  // stops retro_run from being scheduled — no CPU spent emulating — while
  // leaving the WebGL context and loaded ROM intact, so it's fully reversible.
  // A peer watching the host's streamed video (M1.2) pauses its own core; it
  // resumes when the stream ends (host left / it became the host). Cores that
  // don't export these methods simply keep running (graceful no-op). Note: a
  // paused watcher also produces no game audio — acceptable, since its local
  // audio was never synced to the host's displayed frames anyway.

  pause() {
    if (this.paused) return;
    this.paused = true;
    this._applyPauseState();
  }

  resume() {
    if (!this.paused) return; // not paused → never double-resume a live loop
    this.paused = false;
    try { this._getModule()?.resumeMainLoop?.(); } catch (e) { console.warn(e); }
  }

  // Re-assert the paused flag against the current main loop. Called after a
  // (re)start so the desired state survives callMain / a same-core swap. Only
  // pauses (resuming on start is the caller's job via resume()).
  _applyPauseState() {
    if (!this.paused) return;
    try { this._getModule()?.pauseMainLoop?.(); } catch (e) { console.warn(e); }
  }

  // ---- libretro save-state passthrough ----
  //
  // These webemu cores are RetroArch-wrapped builds, not bare libretro
  // cores. They don't export retro_serialize directly; instead they expose
  // _cmd_save_state / _cmd_load_state, which queue the operation on RA's
  // task system. The resulting blob lands on the Emscripten VFS at
  // /home/web_user/retroarch/userdata/states/rom.state — we read it back
  // from there. Loading is the reverse: write the blob, then trigger
  // _cmd_load_state.

  canSerialize() {
    const M = this._getModule();
    return !!(M && typeof M._cmd_save_state === 'function' && typeof M._cmd_load_state === 'function' && M.FS);
  }

  async serializeState() {
    if (!this.canSerialize()) throw new Error('core has no save-state support');
    const M = this._getModule();
    const path = STATE_PATH;
    // Remove any prior snapshot so we can detect when the new one appears
    // and not pick up stale bytes.
    try { M.FS.unlink(path); } catch (_) {}
    M._cmd_save_state();
    // RA's task system writes the file asynchronously; poll for it to
    // appear AND reach a stable size before reading.
    let lastSize = -1;
    let stableTicks = 0;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 33));
      let size = -1;
      try { size = M.FS.stat(path).size; } catch { continue; }
      if (size > 0 && size === lastSize) {
        stableTicks++;
        if (stableTicks >= 2) return M.FS.readFile(path);
      } else {
        stableTicks = 0;
      }
      lastSize = size;
    }
    throw new Error('save_state did not produce a stable file within 2s');
  }

  async unserializeState(data) {
    if (!this.canSerialize()) throw new Error('core has no save-state support');
    const M = this._getModule();
    try { M.FS.mkdirTree(STATE_DIR); } catch (_) {}
    M.FS.writeFile(STATE_PATH, data);
    M._cmd_load_state();
    // load_state is also async-queued; a short delay lets RA pick it up
    // before the user does anything else.
    await new Promise((r) => setTimeout(r, 250));
  }

  sendInput(eventType, code, key, keyCode, location) {
    // The libretro core's emscripten HTML5 glue registers its keyboard
    // handler on **document** (empirically — even though the C call passes
    // EMSCRIPTEN_EVENT_TARGET_WINDOW, the older emscripten version this
    // core was built against resolves it to document; verified via
    // JSEvents.eventHandlers inspection). Synthetic events don't propagate
    // outside their dispatch target, so we must hit document directly.
    // keyCode + which populated defensively — emscripten's HTML5 layer
    // copies both into the C event struct.
    const opts = { code, key, bubbles: true, cancelable: true };
    if (keyCode !== undefined) { opts.keyCode = keyCode; opts.which = keyCode; }
    if (location !== undefined) opts.location = location;
    document.dispatchEvent(new KeyboardEvent(eventType, opts));
  }

  // ---- internals ----

  _getModule() {
    // Classic cores attach Module to window; modular cores hand it back from
    // the factory and we keep our own reference.
    return this._instance || window.Module;
  }

  async _loadCore() {
    const coreBase = this.coreUrl.substring(0, this.coreUrl.lastIndexOf('/') + 1);
    const absoluteCoreUrl = new URL(this.coreUrl, document.baseURI).href;

    const baseModule = {
      canvas: this.emuCanvas,
      noInitialRun: true,
      arguments: ['-c', RA_CFG_PATH, ROM_VFS_PATH],
      onRuntimeInitialized: () => {
        this._runtimeReady = true;
        this.dispatchEvent(new CustomEvent('runtime'));
      },
      print: (text) => console.debug('[core]', text),
      printErr: (text) => {
        if (typeof text === 'string' && text.includes('[INFO]')) console.debug('[core]', text);
        else console.warn('[core]', text);
      },
      locateFile: (path) => path.endsWith('.wasm') ? coreBase + path : path,
    };

    if (this.moduleStyle === 'module') {
      // Modern Emscripten cores: dynamic import + factory call. The /* @vite-ignore */
      // hint stops Vite from trying to statically rewrite the URL — coreUrl
      // is computed at runtime relative to document.baseURI, so the deploy
      // location is the source of truth.
      const mod = await import(/* @vite-ignore */ absoluteCoreUrl);
      const factory = mod.default;
      if (typeof factory !== 'function') {
        throw new Error(`module core ${this.coreName} has no default export factory`);
      }
      this._instance = await factory(baseModule);
      // The factory may resolve before onRuntimeInitialized fires in some
      // builds — the returned promise itself signals readiness.
      this._runtimeReady = true;
    } else {
      // Classic auto-init cores: set window.Module then drop a <script> tag.
      window.Module = baseModule;
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = absoluteCoreUrl;
        script.onload = () => resolve();
        script.onerror = (e) => {
          this._fail('failed to load core script');
          reject(e);
        };
        document.body.appendChild(script);
      });
    }
  }

  _waitForRuntime() {
    if (this._runtimeReady) return Promise.resolve();
    return new Promise((resolve) => {
      this.addEventListener('runtime', () => resolve(), { once: true });
    });
  }

  _writeRetroArchConfig() {
    const M = this._getModule();
    if (!M?.FS) return;
    // Write the cfg to every path RA might consult: the webretro
    // userdata path (explicit -c target), and the three default paths
    // RA searches ($HOME/.config/retroarch/, $HOME/.retroarch.cfg, and
    // $XDG_CONFIG_HOME/retroarch/). $HOME is /home/web_user in
    // emscripten. We don't know which one this RA build will actually
    // honour, so we cover all of them.
    const targets = [
      [RETROARCH_CFG_DIR, RETROARCH_CFG_PATH],
      ['/home/web_user/.config/retroarch', '/home/web_user/.config/retroarch/retroarch.cfg'],
      ['/home/web_user',                   '/home/web_user/.retroarch.cfg'],
    ];
    for (const [dir, path] of targets) {
      try { M.FS.mkdirTree(dir); } catch (_) {}
      try { M.FS.writeFile(path, RETROARCH_CFG); } catch (e) {
        console.warn('[EmulatorClient] failed to write retroarch.cfg at', path, e);
      }
    }
    // If the core exposes the cmd_reload_config hook, take it — webretro
    // uses this to force a re-parse after they rewrite the file from the
    // GUI. Worth trying as a post-callMain nudge too.
    this._reloadConfig = () => { try { M._cmd_reload_config?.(); } catch (_) {} };
  }

  _writeRom(romBuffer) {
    const M = this._getModule();
    if (!M?.FS) throw new Error('Module.FS not available — core not initialized');
    try { M.FS.mkdirTree('/rom'); } catch (_) {}
    M.FS.writeFile(ROM_VFS_PATH, new Uint8Array(romBuffer));
  }

  _fail(message) {
    console.error('[EmulatorClient]', message);
    this.dispatchEvent(new CustomEvent('error', { detail: message }));
  }
}
