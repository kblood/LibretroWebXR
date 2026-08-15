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

import { RETROARCH_CFG, RETROARCH_CFG_DIR, RETROARCH_CFG_PATH, RETROARCH_SYSTEM_DIR } from './RetroArchConfig.js';

const ROM_VFS_DIR = '/rom';
// Single-file whole-disc extensions Play!'s Js_DiscImageDeviceStream bridge can
// serve (see DiscImageDevice below) — CreateOpticalMediaFromPath() opens exactly
// ONE CreateImageStream() for each of these (confirmed by reading Play!'s
// Source/DiskUtils.cpp: .chd routes through CreateOpticalMediaFromChd(), which
// wraps a single CreateImageStream() in CChdCdImageStream — libchdr's chd_open
// then does its own random-access hunk reads through that one stream, which the
// bridge already supports via its offset-aware read()). `.cue` is deliberately
// excluded HERE: fed to Play! directly, it parses into TWO CreateImageStream()
// calls (cue text + referenced .bin), both hitting the same global
// Module.discImageDevice singleton with no way to tell them apart — that's
// still true at THIS layer. A real `.cue` IS supported end-to-end though: this
// class never sees one — main.js's loadCartridge resolves it upstream (parses
// the cue with ContentBundle.js's parseCueReferences, fetches just the primary
// data track's bytes) and calls start() with an explicit `opts.discImage: true`
// override (see the `_discImage` assignment below) plus `contentExt: 'iso'`, so
// the VFS path/bridge see exactly the shape of an already-working single-file
// disc image. `.elf` homebrew boots via the normal MEMFS path, not this
// bridge, so it's excluded too.
const DISC_IMAGE_EXTS = new Set(['iso', 'cso', 'isz', 'chd']);
// Some cores identify content by its file *extension*, not by sniffing the
// bytes — e.g. PUAE (Amiga) rejects a disk image named `.bin` with
// "Unsupported file format". So the VFS content path carries the real
// extension when the caller supplies one (opts.contentExt); cartridge cores,
// which ignore the name, keep the historical `/rom/rom.bin` default.
function romVfsPath(ext) {
  const clean = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return `${ROM_VFS_DIR}/rom.${clean || 'bin'}`;
}
const ROM_VFS_PATH = romVfsPath('bin');
// Legacy single-file libretro core options. We point RA at this explicitly
// (core_options_path) and write `<key> = "<value>"` lines into it for cores
// that need a non-default option — e.g. PUAE's `puae_kickstart = "aros"`, which
// selects the built-in AROS Kickstart so the Amiga boots with no proprietary BIOS.
const CORE_OPTIONS_PATH = RETROARCH_CFG_DIR + '/retroarch-core-options.cfg';
// Per-core input remap directory. RetroArch reads a controller-port device
// override (input_libretro_device_pN) from a core-specific remap file at
// <remap_dir>/<LibraryName>/<LibraryName>.rmp — and, critically, HONOURS it at
// boot when the main cfg's input_libretro_device_pN is ignored (verified during
// the light-gun bring-up; see docs/LIGHTGUN_SUPPORT.md). This is how a light gun
// gets its console to connect the Zapper / Super Scope / Light Phaser on a port.
const REMAP_DIR = RETROARCH_CFG_DIR + '/config/remaps';
const STATE_DIR = '/home/web_user/retroarch/userdata/states';
const STATE_PATH = STATE_DIR + '/rom.state';
// RetroArch system directory — where cores look for BIOS / firmware. Some cores
// (notably PUAE/Amiga) need a real boot ROM (Kickstart) here to run actual games
// instead of a built-in replacement, and opts.systemFiles is provisioned into it
// before callMain. It comes from RetroArchConfig, which is what actually publishes
// it to RetroArch: this file used to declare its own path (without `userdata/`)
// and append a second `system_directory` line, which RetroArch ignored — see the
// RETROARCH_SYSTEM_DIR comment for the whole failure. Never restate the literal.
const SYSTEM_DIR = RETROARCH_SYSTEM_DIR;
// `-c PATH` explicitly tells RA which config file to load. RA's default
// search order is $XDG_CONFIG_HOME/retroarch/, $HOME/.config/retroarch/,
// and $HOME/.retroarch.cfg — none of which is /home/web_user/retroarch/
// userdata/, the path webretro (and we) write to. `-c` is belt; we also
// write the cfg into the default search paths in _writeRetroArchConfig as
// suspenders. GameInputMgr is the last line of defence: it dispatches both
// the webretro key (h/g/space) AND the RA stock key (x/z/RShift) for each
// logical button so the controller works even if no cfg is honoured.
const RA_CFG_PATH = '/home/web_user/retroarch/userdata/retroarch.cfg';

// Cores whose light gun is really UAE's LIGHT PEN, which needs RELATIVE mouse
// motion on top of the absolute aim. Only PUAE (Amiga) is in this club.
//
// WHY (traced through libretro-uae, 2026-08-15 — the Trojan Phazer would
// otherwise look alive and do nothing):
//   • The aim we send through the LIGHTGUN ids reaches the core fine, and
//     libretro-mapper's retro_ui_get_pointer_state draws PUAE's own crosshair
//     from it — so the gun LOOKS connected, and the statusbar even prints "L1".
//   • But the emulated beam latch is elsewhere: custom.c only fires the light-pen
//     trigger from lightpen_cx/cy, which drawing.c computes in lightpen_update()
//     — and draw_frame_extras() calls that ONLY `if (lightpen_active)`.
//   • lightpen_active is set exclusively by an INPUTEVENT_LIGHTPEN_HORIZ/VERT
//     event (inputdevice.c handle_input_event case 5/6). On a light-pen port UAE
//     binds those events to the port's MOUSE AXES, so nothing but real relative
//     mouse motion arms it. An absolute aim alone leaves it disarmed forever:
//     lightpen_cx/cy stay -1 and no shot ever reaches the game.
//   • The trigger has the same shape: PUAE reads the Phazer trigger from
//     RETRO_DEVICE_MOUSE left (libretro-mapper, gated on puae_physicalmouse) and
//     DISCARDS the LIGHTGUN trigger id (retro_lightpen_update keeps only x/y).
// Verified on the real thing: Trojan Skeet Shoot (1991) sits on "FIRE AT TARGET
// TO CALIBRATE GUN" forever with the aim alone, and calibrates on the first shot
// once ±1px of motion rides along (tmp/probe-amiga-fire.mjs, whole-screen diff
// 0 px → 33 596 px).
const LIGHTPEN_MOTION_CORES = new Set(['puae']);

// Play!'s Emscripten build routes EVERY optical-disc-image file open
// (Source/Js_DiscImageDeviceStream.cpp, under __EMSCRIPTEN__) through this
// JS-side bridge instead of the Emscripten filesystem — CreateImageStream()
// unconditionally returns a CJsDiscImageDeviceStream that calls
// Module.discImageDevice.{getFileSize,read,isDone}() via MAIN_THREAD_EM_ASM,
// regardless of what (if anything) exists on FS at the content path. The C++
// side has no per-instance path/identifier: it's one global device, which is
// why this only cleanly supports single-file whole-disc images (.iso), not a
// .cue naming two files (the cue-sheet parser opens two separate streams that
// would both hit this same global object with no way to tell them apart).
// Play!'s own (unrelated) ui_js browser frontend defines the same contract
// backed by a File + async Blob.slice(); we back it with a plain
// already-in-memory Uint8Array instead, so read() completes synchronously —
// isDone() is true by the time the busy-poll loop in C++ checks it.
class DiscImageDevice {
  constructor(module, data) {
    this._module = module;
    this._data = data instanceof Uint8Array ? data : new Uint8Array(data);
  }
  getFileSize() { return this._data.length; }
  read(dstPtr, offset, size) {
    const src = this._data.subarray(offset, offset + size);
    this._module.HEAPU8.set(src, dstPtr);
  }
  isDone() { return true; }
}

// ---- per-launch BOOT CONFIGURATION (CLAUDE_REVIEW §5.4 / CODEX_REVIEW COR-4) --
//
// These four options are consumed exactly ONCE per core, by
// _writeRetroArchConfig() + _provisionSystemFiles(), immediately before
// callMain(). RetroArch parses retroarch.cfg / the per-core .rmp / the core
// options file at startup and connects controller-port devices while loading
// content; nothing re-reads them afterwards. So they are not "current settings"
// that can drift — they are part of the loaded core's IDENTITY:
//
//   coreOptions   core-option overrides (gun read path, PUAE kickstart, …)
//   inputDevices  controller-port device overrides (Zapper / Super Scope /
//                 Justifier / Light Phaser / mouse / Four Score)
//   remapName     the RA library name of the .rmp that CONNECTS those devices
//   systemFiles   BIOS/firmware provisioned into the system dir before boot
//
// Two rules follow, and both were broken before:
//
//  1. REPLACE, never merge. start() used to write each field only when the
//     incoming value was non-empty, so a gun game's devices survived into the
//     next plain game on the same core ("sticky peripheral").
//  2. A same-core content hot swap is only legitimate when this configuration is
//     UNCHANGED. The hot-swap branch returns before _writeRetroArchConfig(), so
//     a changed configuration could never take effect — the old behaviour was to
//     boot the new game with the OLD game's peripherals, silently. There is no
//     way to apply it to the already-running core (see BootConfigChangeError),
//     so start() now refuses instead, and callers ask first — via
//     ConsoleRuntime.js's clientNeedsFreshBoot(), which reads `bootConfig` below.
function normalizeBootMap(value) {
  return (value && typeof value === 'object' && Object.keys(value).length) ? value : null;
}

/**
 * Canonical (key-order independent) signature of the per-launch boot
 * configuration in `opts`. Two starts with the same signature can share one
 * loaded core; two with different signatures cannot. Normalizes undefined /
 * null / `{}` / `[]` to the same "nothing requested" value, so an absent field
 * and an empty one never look like a change.
 */
export function bootConfigSignature(opts = {}) {
  const stable = (v) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(stable);
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = stable(v[k]); return acc; }, {});
  };
  const files = Array.isArray(opts.systemFiles) && opts.systemFiles.length ? opts.systemFiles : null;
  return JSON.stringify({
    coreOptions:  stable(normalizeBootMap(opts.coreOptions)),
    inputDevices: stable(normalizeBootMap(opts.inputDevices)),
    remapName:    opts.remapName || null,
    systemFiles:  stable(files),
  });
}

// Thrown by start() instead of silently hot-swapping content into a core whose
// boot configuration no longer matches what was asked for. Structured (like
// RuntimeModeSwitchError) so a caller can recover deliberately: the recovery is
// a FRESH core — build a new EmulatorClient/ConsoleRuntime and boot into that
// (main.js's bootFreshRuntime). Callers that can recover should ask
// clientNeedsFreshBoot() / ConsoleRuntime.needsFreshBoot() BEFORE calling
// start(); this throw is the backstop that makes the failure loud instead of
// "the gun UI is armed but the core sees a pad".
export class BootConfigChangeError extends Error {
  constructor(coreName, from, to) {
    super(`boot configuration changed for the loaded "${coreName}" core — controller-port devices, core options, remaps and BIOS are read once, at core boot, so this needs a FRESH core (reload the page, or boot into a new runtime). See BootConfigChangeError.`);
    this.name = 'BootConfigChangeError';
    this.code = 'BOOT_CONFIG_CHANGED';
    this.coreName = coreName;
    this.from = from;
    this.to = to;
  }
}

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
    // VFS path the loaded content is written to + handed to RetroArch. Default
    // matches the legacy `/rom/rom.bin`; refined per-load from opts.contentExt.
    this._romPath = ROM_VFS_PATH;
    // Optional per-core libretro options ({ key: value }) written to the core
    // options file before callMain. Null = none (RA uses core defaults).
    this._coreOptions = null;
    // Optional controller-port device overrides ({ player: libretroDeviceId }),
    // e.g. { 2: 4 } assigns RETRO_DEVICE_LIGHTGUN to player 2 so a core boots its
    // light-gun (NES Zapper, SMS Light Phaser, …) on that port. Written as
    // input_libretro_device_pN before callMain. Null = cores use their defaults.
    this._inputDevices = null;
    // RetroArch library name (e.g. "Nestopia", "Snes9x", "Genesis Plus GX") used
    // to name the per-core remap dir/file that carries _inputDevices. Required for
    // a port-device override to take effect at boot (the main cfg's value is
    // ignored). Null = don't write a remap (port devices won't connect).
    this._remapName = null;
    // Tracks the synthetic light-gun trigger so sendLightgun() emits clean
    // mousedown/mouseup edges (RetroArch holds the button until the up event).
    this._gunDown = false;
    // Multiport light-gun side-channel. The patched (multiport) cores export
    // rwebinput_set_lightgun(port,x,y,buttons) so each controller port gets its
    // OWN aim point — DOM MouseEvents can't express two guns on one canvas. When
    // sendLightgun() is called WITH a port and this export exists, we drive that
    // port directly through this setter and SKIP the shared mouse event. Resolved
    // lazily on first use (the core must be initialised). false = looked up, not
    // present (single-gun core → DOM-event fallback); null = not looked up yet.
    this._webgunSet = null;
    // The counterpart export, rwebinput_clear_lightgun(port), behind the public
    // clearLightgun() below. It exists because rwebinput_set_lightgun latches
    // `lightgun[port].active = true`, and an active port IGNORES the shared DOM
    // mouse for the rest of the core's life — so a port that STOPS being driven
    // through the multiport path has to be handed back explicitly or it freezes
    // at its last aim (with its trigger bit still held, if it was released
    // mid-shot). Only an explicit caller knows when that has happened; see
    // clearLightgun()'s comment for exactly which cases are and are NOT covered.
    // Resolved lazily/defensively like _webgunSet; null = not looked up yet,
    // false = core lacks the export (stock core → nothing was ever latched).
    this._webgunClear = null;
    // Optional per-core system/BIOS files to provision into SYSTEM_DIR before
    // callMain ([{ name, url }] — e.g. PUAE's Kickstart so an Amiga boots the real
    // OS, not the AROS replacement). Fetched lazily in start(); a 404/failed fetch
    // is non-fatal (the core falls back to its built-in default). Null = none.
    this._systemFiles = null;
    // Whole-disc image content (e.g. PS2 .iso bytes) streamed through Play!'s
    // Module.discImageDevice JS bridge instead of being written into the
    // Emscripten MEMFS (see DiscImageDevice above). Set from opts.discImage
    // in start(); avoids ever duplicating a multi-hundred-MB disc image into
    // the WASM heap's own filesystem layer. Null = normal MEMFS content.
    this._discImage = false;
    // Synthetic mouse button state for sendMouse()'s DOM path — mirrors _gunDown.
    // A bitmask of currently-held DOM buttons (1=left, 2=right, 4=middle) so we
    // emit clean mousedown/mouseup edges (the core latches a button until release).
    this._mouseButtons = 0;
    // Multiport mouse side-channel (future-proofing, mirrors _webgunSet). A
    // multiport-patched core would export rwebinput_set_mouse(port,dx,dy,buttons)
    // so two mice on one console drive two ports independently — DOM movementX/Y
    // can't express two pointers on one canvas. Resolved lazily; false = absent
    // (single-mouse DOM fallback), null = not looked up yet.
    this._webmouseSet = null;
    // Signature (bootConfigSignature) of the per-launch boot configuration the
    // LOADED core was actually started with. Null until a core is loaded. This
    // is the live value — it is written where the boot happens, so nothing can
    // hold a stale shadow copy of it.
    this._bootConfig = null;
    // Sign of the next light-pen nudge (see LIGHTPEN_MOTION_CORES). It alternates
    // so a gun held perfectly still still emits motion every tick without the
    // emulated pointer drifting one way forever.
    this._lightpenNudge = 1;
  }

  // ±1px of relative motion, alternating, for the cores in LIGHTPEN_MOTION_CORES.
  // Deliberately NOT the gun's real frame-to-frame delta: a gun resting on target
  // — or a remote peer's aim arriving unchanged — has a delta of exactly 0, which
  // is the one case UAE's beam latch cannot be armed from, and that is precisely
  // when the player is about to pull the trigger.
  _nextLightpenNudge() {
    this._lightpenNudge = -this._lightpenNudge;
    return this._lightpenNudge;
  }

  /**
   * The bootConfigSignature() of the LOADED core's launch, or null when no core
   * is loaded yet. This is what makes "can the running core serve this boot?"
   * answerable from outside: compare it with bootConfigSignature(newOptions).
   * ConsoleRuntime.js's clientNeedsFreshBoot() is the one place that does, for
   * BOTH the primary console and the rack.
   *
   * A property rather than a `needsFreshBoot()` method on purpose: it is state,
   * not an action — and scripts/test-runtime-facade.mjs requires every public
   * EmulatorClient *method* to have a RuntimeEmulatorClient forwarder, which
   * this task is not allowed to add (that file belongs to another agent).
   */
  get bootConfig() { return this._coreLoaded ? this._bootConfig : null; }

  async start(emuCanvas, romBuffer, opts = {}) {
    // Checked BEFORE anything is mutated: a start we cannot honour must leave
    // this client exactly as it was, still running the previous game, so the
    // caller can recover onto a fresh runtime (see BootConfigChangeError).
    const nextBootConfig = bootConfigSignature(opts);
    if (this._coreLoaded && nextBootConfig !== this._bootConfig) {
      throw new BootConfigChangeError(this.coreName, this._bootConfig, nextBootConfig);
    }
    this.emuCanvas = emuCanvas;
    // Pin the content path BEFORE _loadCore (which bakes it into Module.arguments)
    // and before _writeRom — so extension-sensitive cores (e.g. PUAE) see e.g.
    // /rom/rom.adf instead of /rom/rom.bin.
    if (opts.contentExt) this._romPath = romVfsPath(opts.contentExt);
    // opts.discImage is an explicit override (used by de-risk/diagnostic scripts);
    // real call sites never set it, so auto-detect from the core + extension —
    // otherwise every PS2 disc image silently fails to boot (see DISC_IMAGE_EXTS).
    const coreForLoad = opts.coreName || this.coreName;
    const extForLoad = String(opts.contentExt || '').toLowerCase().replace(/^\./, '');
    this._discImage = opts.discImage !== undefined
      ? !!opts.discImage
      : (coreForLoad === 'play' && DISC_IMAGE_EXTS.has(extForLoad));
    // REPLACE, never merge (see the BOOT CONFIGURATION note above): what this
    // launch asks for is the whole truth. Previously each of these was only
    // overwritten when the incoming value was non-empty, so a light-gun game's
    // devices/options/remap stuck to the client and were re-applied to the NEXT
    // (plain) game booted on it. Every one of these four is normalized to null
    // when absent/empty, matching bootConfigSignature.
    this._coreOptions = normalizeBootMap(opts.coreOptions);
    this._inputDevices = normalizeBootMap(opts.inputDevices);
    this._remapName = opts.remapName || null;
    this._systemFiles = (Array.isArray(opts.systemFiles) && opts.systemFiles.length) ? opts.systemFiles : null;
    // The configuration this core is (about to be) running with. Set here, on
    // the one path that can reach _writeRetroArchConfig, so `bootConfig` (and
    // therefore clientNeedsFreshBoot) always reflects what the live core got.
    this._bootConfig = nextBootConfig;
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
      // This returns BEFORE _writeRetroArchConfig()/_provisionSystemFiles(), so
      // it can only ever be correct when the boot configuration is unchanged —
      // which the guard at the top of start() now guarantees (a changed one
      // throws BootConfigChangeError there instead of arriving here and
      // silently keeping the previous game's peripherals).
      this._writeRom(romBuffer);
      this._getModule()._cmd_reset?.();
      this._applyPauseState();
      this.dispatchEvent(new CustomEvent('ready'));
      return;
    }

    await this._waitForRuntime();
    this._writeRetroArchConfig();
    await this._provisionSystemFiles();
    this._writeRom(romBuffer);
    try {
      this._getModule().callMain(['-c', RA_CFG_PATH, this._romPath]);
      this.ready = true;
      // callMain installs the core's main loop already running; if a pause was
      // requested before the loop existed (e.g. host video arrived first), apply
      // it now so a freshly-booted watcher core doesn't briefly run.
      this._applyPauseState();
      this.dispatchEvent(new CustomEvent('ready'));
    } catch (e) {
      console.error('[EmulatorClient] callMain exception:', e, e?.stack);
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
    // Dispatch synthetic key events to THIS core's canvas, not `document`.
    //
    // The modern MODULARIZE buildbot cores register their RetroArch web input
    // (rwebinput) keyboard handler on their own canvas (`#canvas` → Module.canvas),
    // NOT on document. Dispatching to document therefore never reaches the core —
    // which was the "can't control any console" regression after the 2026-06-02
    // classic→module core migration (the old classic cores DID listen on
    // document). Verified empirically: holding a direction dispatched to the
    // canvas moves the game; dispatched to document it does nothing
    // (scripts/debug.js --hold-key --key-target).
    //
    // Targeting the per-core canvas (with bubbles:true, so a document-level
    // listener would still see it in the bubble phase) is also exactly what
    // multi-core routing needs: each console's core only hears keys aimed at its
    // own canvas. keyCode + which are populated defensively — emscripten's HTML5
    // layer copies both into the C event struct.
    const target = this.emuCanvas || document;
    const opts = { code, key, bubbles: true, cancelable: true };
    if (keyCode !== undefined) { opts.keyCode = keyCode; opts.which = keyCode; }
    if (location !== undefined) opts.location = location;
    target.dispatchEvent(new KeyboardEvent(eventType, opts));
  }

  // Aim + fire this core's light gun. (u, v) are normalised canvas coords with
  // origin top-left: u/v in [0,1] map onto the visible framebuffer; values
  // outside that range are off-screen (a reload shot). `trigger` is the held
  // trigger state. RetroArch's web input reads the gun's absolute position from
  // the mouse pointer (clientX/Y minus the canvas bounding rect) and the trigger
  // from a mouse button, so we synthesise mousemove + mousedown/up against this
  // core's own canvas — the same per-canvas targeting sendInput() relies on, so
  // each console only hears its own gun. We hold the button down across frames
  // (edge-triggered mousedown/up) since RetroArch latches it until release.
  sendLightgun(u, v, trigger, port) {
    const canvas = this.emuCanvas;
    if (!canvas) return;
    const offscreen = u < 0 || u > 1 || v < 0 || v > 1;

    // Multiport path: a per-port aim point, written straight into the patched
    // core's per-port light-gun slot (rwebinput_set_lightgun). This is the ONLY
    // way two guns on the SAME console drive two ports independently — a single
    // canvas can carry only one DOM mouse. Used when a `port` is supplied AND the
    // core exports the setter. Single-gun callers omit `port` → DOM path below,
    // so existing games are byte-for-byte unchanged. We pass framebuffer-pixel
    // coords (u*width, v*height): rwebinput's mouse handler stores targetX*dpr,
    // i.e. backing-store pixels, which canvas.width/.height already are.
    if (port != null && this._resolveWebgun()) {
      // buttons bitmask: bit0 (1) = left/trigger for an on-screen shot; bit2 (4)
      // = right/offscreen-reload, matching the DOM path's left/right split.
      let buttons = 0;
      if (trigger) buttons = offscreen ? 4 : 1;
      // Clamp into the framebuffer; an off-screen aim still needs valid pixels so
      // the core's IS_OFFSCREEN test fires on the (held) reload button, not on a
      // negative coordinate. Use a coord just inside the edge for off-screen.
      const px = offscreen ? 0 : Math.max(0, Math.min(canvas.width - 1, Math.round(u * canvas.width)));
      const py = offscreen ? 0 : Math.max(0, Math.min(canvas.height - 1, Math.round(v * canvas.height)));
      // Defensive: if the shared DOM path left a button held (this core booted
      // before the setter resolved, or this console just switched a gun from the
      // DOM path to a port), the multiport branch returns early and the matching
      // mouseup would never be dispatched. Release it so the shared mouse's
      // latched button can't bleed into any other port still reading it.
      if (this._gunDown !== false) {
        const r = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new MouseEvent('mouseup', {
          clientX: r.left + u * r.width, clientY: r.top + v * r.height,
          button: this._gunDown, buttons: 0, bubbles: true, cancelable: true, view: window,
        }));
        this._gunDown = false;
      }
      try { this._webgunSet(port, px, py, buttons); } catch (e) { /* core gone */ }
      // PUAE only: the per-port setter drives the LIGHTGUN ids, and this core
      // takes neither its beam latch nor its trigger from those (see
      // LIGHTPEN_MOTION_CORES). Relative motion + the trigger as mouse-left have
      // to go through the shared mouse. Position is irrelevant on this path —
      // PUAE takes the aim from the latched per-port light-gun state, so
      // sendMouse's centre-anchored mousemove cannot pull the aim off target.
      if (LIGHTPEN_MOTION_CORES.has(this.coreName)) {
        this.sendMouse(this._nextLightpenNudge(), 0, trigger ? (offscreen ? 2 : 1) : 0);
      }
      return;
    }

    const rect = canvas.getBoundingClientRect();
    // Map normalised coords onto the canvas's on-screen box. The canvas lives at
    // a large negative offset (off-viewport) but still has a real layout rect,
    // and rwebinput uses getBoundingClientRect the same way, so clientX/Y here
    // are consistent with whatever the core computes.
    const clientX = rect.left + u * rect.width;
    const clientY = rect.top + v * rect.height;
    const base = { clientX, clientY, bubbles: true, cancelable: true, view: window };
    const move = new MouseEvent('mousemove', base);
    // PUAE only: carry relative motion on the aim event itself. The event is
    // already at the right client coords, so unlike sendMouse's centre-anchored
    // mousemove it cannot disturb the aim. MouseEvent's constructor ignores
    // movementX/Y (they are read-only accessors), hence defineProperty — the
    // same trick sendMouse uses.
    if (LIGHTPEN_MOTION_CORES.has(this.coreName)) {
      try {
        Object.defineProperty(move, 'movementX', { value: this._nextLightpenNudge() });
        Object.defineProperty(move, 'movementY', { value: 0 });
      } catch (_) { /* locked down: the gun still aims, the beam just won't arm */ }
    }
    canvas.dispatchEvent(move);
    if (trigger && !this._gunDown) {
      // Off-screen shots use the right button (offscreen_shot_mbtn = 2); an
      // on-screen shot uses the left/trigger button (1). DOM button: 0 = left,
      // 2 = right; buttons bitmask: 1 = left, 2 = right.
      const button = offscreen ? 2 : 0;
      const buttons = offscreen ? 2 : 1;
      canvas.dispatchEvent(new MouseEvent('mousedown', { ...base, button, buttons }));
      this._gunDown = button;
    } else if (!trigger && this._gunDown !== false) {
      const button = this._gunDown;
      canvas.dispatchEvent(new MouseEvent('mouseup', { ...base, button, buttons: 0 }));
      this._gunDown = false;
    }
  }

  // Hand libretro gun `port` back to the shared DOM mouse: undo the `active`
  // latch that sendLightgun's multiport branch set on it, dropping any trigger
  // bit that was still held. Idempotent, and a silent no-op on a core without
  // the multiport patch (nothing was ever latched there) or before the core is
  // up.
  //
  // WHO CALLS THIS, AND WHAT IS THEREFORE COVERED. This is an EXPLICIT
  // binding-change signal, not something sendLightgun can infer from its own
  // call pattern — a gun that is simply holding still sends the same port
  // forever, and a mixed setup interleaves ported and un-ported calls every
  // tick, so no call-ordering heuristic can tell "stopped driving" from
  // "unchanged". The single caller is LightGunMgr.tick (see its
  // `_gunPortBindings` sweep), which each frame knows the authoritative set of
  // (console, port) bindings actually being driven. It therefore covers:
  //   • a gun re-jacked to another cable port (port changes),
  //   • a gun moved to another console (console changes),
  //   • a gun UNPLUGGED (portForGun goes null),
  //   • a gun dropped / no longer held (it leaves the active-gun set),
  //   • a two-gun game replaced by a single-gun one (ports go null).
  // NOT covered: a remote peer's gun in multiplayer. The host applies peers'
  // aim through _hostApplyGunWire (main.js), and the 'gun' wire channel carries
  // aim only — no binding-change event — so a REMOTE gun's port stays latched
  // on the host's core until that core is torn down. See _hostApplyGunWire's
  // comment; closing that needs a wire-protocol addition, not a change here.
  clearLightgun(port) {
    if (port == null) return;
    const clear = this._resolveWebgunClear();
    if (!clear) return;   // unpatched core (nothing latched) or runtime not up
    try { clear(port); } catch (_) { /* core gone */ }
  }

  // Feed RELATIVE mouse motion + buttons to this core's RETRO_DEVICE_MOUSE.
  //   dx, dy   — relative motion since the last call, in framebuffer pixels (the
  //              same units rwebinput integrates from pointer-lock movementX/Y).
  //   buttons  — bitmask of held buttons: bit0 (1)=left, bit1 (2)=right,
  //              bit2 (4)=middle. The core latches each until released.
  //   port     — optional libretro mouse PORT (0-based). Two mice on the SAME
  //              console drive two ports only via a patched multiport setter
  //              (rwebinput_set_mouse); a single DOM mouse can carry one pointer.
  //
  // Single-mouse path (no `port`, or no multiport core): synthesise a DOM
  // `mousemove` carrying movementX/movementY against this core's own canvas — the
  // exact field rwebinput reads (DE-RISK VERIFIED on PUAE) — plus mousedown/mouseup
  // edges for button changes. Per-canvas targeting (like sendInput/sendLightgun)
  // means each console only hears its own mouse.
  sendMouse(dx, dy, buttons = 0, port = null) {
    const canvas = this.emuCanvas;
    if (!canvas) return;
    const mask = buttons & 0x7;

    // Multiport path: write straight into the patched core's per-port mouse slot.
    // The ONLY way two mice on one console drive two ports independently.
    if (port != null && this._resolveWebmouse()) {
      try { this._webmouseSet(port, Math.round(dx), Math.round(dy), mask); } catch (_) { /* core gone */ }
      return;
    }

    // DOM path. Motion: emit a mousemove with movementX/Y when there's any motion.
    // MouseEvent's constructor leaves movementX/Y read-only at 0, so define them.
    const rect = canvas.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    if (dx || dy) {
      const ev = new MouseEvent('mousemove', { clientX, clientY, bubbles: true, cancelable: true, view: window });
      try {
        Object.defineProperty(ev, 'movementX', { value: dx });
        Object.defineProperty(ev, 'movementY', { value: dy });
      } catch (_) { /* some envs lock these — motion still no-ops gracefully */ }
      canvas.dispatchEvent(ev);
    }

    // Buttons: diff against the held mask and emit edges. DOM `button` is the index
    // (0=left,1=middle,2=right); `buttons` is the resulting held bitmask.
    if (mask !== this._mouseButtons) {
      const changed = mask ^ this._mouseButtons;
      // Map each DOM button index to its bitmask bit (left=1<<0, right=1<<1→idx2,
      // middle=1<<2→idx1). rwebinput uses the same 1=left/2=right/4=middle layout.
      const BIT_TO_BUTTON = { 1: 0, 2: 2, 4: 1 };
      for (const bit of [1, 2, 4]) {
        if (!(changed & bit)) continue;
        const button = BIT_TO_BUTTON[bit];
        const goingDown = (mask & bit) !== 0;
        const newMask = goingDown ? (this._mouseButtons | bit) : (this._mouseButtons & ~bit);
        canvas.dispatchEvent(new MouseEvent(goingDown ? 'mousedown' : 'mouseup', {
          clientX, clientY, button, buttons: newMask, bubbles: true, cancelable: true, view: window,
        }));
        this._mouseButtons = newMask;
      }
    }
  }

  // ---- internals ----

  // Resolve (once) the patched core's multiport mouse setter. Returns a bound
  // (port,dx,dy,buttons)=>void on a multiport-patched core, or null otherwise (so
  // sendMouse falls back to the shared DOM path). Mirrors _resolveWebgun.
  _resolveWebmouse() {
    if (this._webmouseSet) return this._webmouseSet;
    if (this._webmouseSet === false) return null;
    const M = this._getModule();
    if (!M) return null;
    let fn = null;
    try {
      if (typeof M.cwrap === 'function' && (M._rwebinput_set_mouse || M.asm?.rwebinput_set_mouse)) {
        fn = M.cwrap('rwebinput_set_mouse', null, ['number', 'number', 'number', 'number']);
      } else if (typeof M._rwebinput_set_mouse === 'function') {
        fn = (p, x, y, b) => M._rwebinput_set_mouse(p, x, y, b);
      }
    } catch (_) { fn = null; }
    this._webmouseSet = fn || false;
    return fn || null;
  }

  // Resolve (once) the patched core's multiport light-gun setter. Returns a
  // bound (port,x,y,buttons)=>void on a multiport core, or null on a single-gun
  // core / before the runtime is ready. cwrap is preferred (handles arg
  // marshalling); we fall back to the raw _rwebinput_set_lightgun export.
  _resolveWebgun() {
    if (this._webgunSet) return this._webgunSet;
    if (this._webgunSet === false) return null;   // looked up, absent
    const M = this._getModule();
    if (!M) return null;                          // runtime not ready yet — retry later
    let fn = null;
    try {
      if (typeof M.cwrap === 'function' && (M._rwebinput_set_lightgun || M.asm?.rwebinput_set_lightgun)) {
        fn = M.cwrap('rwebinput_set_lightgun', null, ['number', 'number', 'number', 'number']);
      } else if (typeof M._rwebinput_set_lightgun === 'function') {
        fn = (p, x, y, b) => M._rwebinput_set_lightgun(p, x, y, b);
      }
    } catch (_) { fn = null; }
    this._webgunSet = fn || false;
    return fn || null;
  }

  // Resolve (once) rwebinput_clear_lightgun(port), the counterpart of the setter
  // above. Same defensive resolution: the patched cores are linked with
  // EXPORTED_RUNTIME_METHODS = callMain,FS,addFunction,removeFunction and NOT
  // cwrap, so the raw `_rwebinput_clear_lightgun` export is what actually gets
  // used; cwrap is preferred only where a build happens to expose it. Returns
  // null on any core without the export (every stock/base-only core), so callers
  // no-op instead of throwing.
  _resolveWebgunClear() {
    if (this._webgunClear) return this._webgunClear;
    if (this._webgunClear === false) return null;  // looked up, absent
    const M = this._getModule();
    if (!M) return null;                           // runtime not ready yet
    let fn = null;
    try {
      if (typeof M.cwrap === 'function' && (M._rwebinput_clear_lightgun || M.asm?.rwebinput_clear_lightgun)) {
        fn = M.cwrap('rwebinput_clear_lightgun', null, ['number']);
      } else if (typeof M._rwebinput_clear_lightgun === 'function') {
        fn = (p) => M._rwebinput_clear_lightgun(p);
      }
    } catch (_) { fn = null; }
    this._webgunClear = fn || false;
    return fn || null;
  }

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
      arguments: ['-c', RA_CFG_PATH, this._romPath],
      onRuntimeInitialized: () => {
        this._runtimeReady = true;
        this.dispatchEvent(new CustomEvent('runtime'));
      },
      print: (text) => console.debug('[core]', text),
      printErr: (text) => {
        if (typeof text === 'string' && text.includes('[INFO]')) console.debug('[core]', text);
        else console.warn('[core]', text);
      },
      locateFile: (path) => (path.endsWith('.wasm') || path.endsWith('.worker.js')) ? coreBase + path : path,
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
    // When the core needs non-default options, point RA at an explicit
    // single-file core-options path and write the requested key/values there.
    let cfg = RETROARCH_CFG;
    // NOTE: no `system_directory` line here. RETROARCH_CFG already carries it,
    // and RetroArch keeps the FIRST occurrence of a duplicated key — an appended
    // second one is inert, which is exactly how BIOS provisioning was silently
    // broken until 2026-08-15 (see RETROARCH_SYSTEM_DIR's comment).
    if (this._coreOptions) {
      cfg += `core_options_path = "${CORE_OPTIONS_PATH}"\n`;
      const body = Object.entries(this._coreOptions)
        .map(([k, v]) => `${k} = "${v}"`).join('\n') + '\n';
      try { M.FS.mkdirTree(RETROARCH_CFG_DIR); } catch (_) {}
      try { M.FS.writeFile(CORE_OPTIONS_PATH, body); } catch (e) {
        console.warn('[EmulatorClient] failed to write core options', e);
      }
    }
    if (this._inputDevices) {
      // Port device overrides + light-gun input wiring. RetroArch's libretro
      // lightgun reads its absolute aim from the MOUSE pointer (rwebinput maps
      // the canvas-relative cursor to gun X/Y — the rwebinput patch in
      // docs/patches/) and its buttons from mouse buttons, so for any gun port we
      // bind trigger→LMB and the off-screen/reload shot→RMB. sendLightgun() emits
      // those synthetic mouse events. A "gun" port is one whose device base class
      // is LIGHTGUN (4) — or POINTER (6), which covers nestopia's Zapper (id 262 =
      // SUBCLASS(POINTER,0)) that is nonetheless read via the LIGHTGUN path.
      const RETRO_DEVICE_MASK = 0xff, RETRO_DEVICE_MOUSE = 2, RETRO_DEVICE_LIGHTGUN = 4, RETRO_DEVICE_POINTER = 6;
      const validPorts = Object.entries(this._inputDevices)
        .filter(([player]) => Number.isInteger(Number(player)) && Number(player) >= 1);
      // Main cfg: enable the per-core remap dir (so the .rmp below is honoured at
      // boot) + the device line (belt-and-suspenders; ignored at boot but correct
      // for any runtime re-read) + the gun mouse-button binds.
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
          // A MOUSE port reads its motion + buttons from a physical mouse index.
          // In a web build there is only one (index 0); sendMouse() feeds the
          // canvas-targeted DOM mouse events (movementX/Y + L/R buttons) the core
          // integrates. Two mice on one console reading distinct pointers needs a
          // multiport rwebinput patch (see sendMouse / docs/MOUSE_SUPPORT.md).
          cfg += `input_player${p}_mouse_index = "0"\n`;
        }
      }
      // The per-core remap FILE is what actually connects the device at boot.
      // <REMAP_DIR>/<LibraryName>/<LibraryName>.rmp with input_libretro_device_pN.
      if (this._remapName && validPorts.length) {
        const rmp = validPorts.map(([p, dev]) => `input_libretro_device_p${Number(p)} = "${dev}"`).join('\n') + '\n';
        const dir = `${REMAP_DIR}/${this._remapName}`;
        try { M.FS.mkdirTree(dir); } catch (_) {}
        try { M.FS.writeFile(`${dir}/${this._remapName}.rmp`, rmp); } catch (e) {
          console.warn('[EmulatorClient] failed to write remap', e);
        }
      } else if (this._inputDevices) {
        console.warn('[EmulatorClient] inputDevices set without remapName — port device will not connect at boot');
      }
    }
    // Debug/test hook: append arbitrary raw cfg lines (e.g. to probe input grab
    // behaviour during light-gun bring-up). Never set in production.
    if (typeof window !== 'undefined' && typeof window.__forceCfgExtra === 'string') {
      cfg += (window.__forceCfgExtra.endsWith('\n') ? window.__forceCfgExtra : window.__forceCfgExtra + '\n');
    }
    // Debug/test hook: write arbitrary extra files into the core FS before
    // callMain (e.g. a per-core remap .rmp to force a controller-port device).
    // { '/abs/path': 'contents' }. Never set in production.
    if (typeof window !== 'undefined' && window.__forceExtraFiles) {
      for (const [path, body] of Object.entries(window.__forceExtraFiles)) {
        const dir = path.slice(0, path.lastIndexOf('/'));
        try { M.FS.mkdirTree(dir); } catch (_) {}
        try { M.FS.writeFile(path, body); } catch (e) {
          console.warn('[EmulatorClient] failed to write extra file', path, e);
        }
      }
    }
    const targets = [
      [RETROARCH_CFG_DIR, RETROARCH_CFG_PATH],
      ['/home/web_user/.config/retroarch', '/home/web_user/.config/retroarch/retroarch.cfg'],
      ['/home/web_user',                   '/home/web_user/.retroarch.cfg'],
    ];
    for (const [dir, path] of targets) {
      try { M.FS.mkdirTree(dir); } catch (_) {}
      try { M.FS.writeFile(path, cfg); } catch (e) {
        console.warn('[EmulatorClient] failed to write retroarch.cfg at', path, e);
      }
    }
    // If the core exposes the cmd_reload_config hook, take it — webretro
    // uses this to force a re-parse after they rewrite the file from the
    // GUI. Worth trying as a post-callMain nudge too.
    this._reloadConfig = () => { try { M._cmd_reload_config?.(); } catch (_) {} };
  }

  // Fetch any per-core system/BIOS files (opts.systemFiles = [{ name, url }]) and
  // write them into SYSTEM_DIR before callMain so the core finds them at boot.
  // Used for PUAE's Kickstart: with a real Kickstart present an Amiga boots the
  // genuine OS (and real games like Settlers) instead of the AROS replacement.
  // Every step is best-effort: a missing/failed file is logged and skipped so a
  // clean clone (no user-owned ROMs on the server → 404) still boots via AROS.
  async _provisionSystemFiles() {
    if (!this._systemFiles?.length) return;
    const M = this._getModule();
    if (!M?.FS) return;
    try { M.FS.mkdirTree(SYSTEM_DIR); } catch (_) {}
    for (const f of this._systemFiles) {
      if (!f?.name || !f?.url) continue;
      try {
        const res = await fetch(f.url, { cache: 'force-cache' });
        if (!res.ok) { console.warn(`[EmulatorClient] system file ${f.name} not available (${res.status}) — core uses its built-in default`); continue; }
        const data = new Uint8Array(await res.arrayBuffer());
        M.FS.writeFile(`${SYSTEM_DIR}/${f.name}`, data);
        console.log(`[EmulatorClient] provisioned system file ${f.name} (${data.length} bytes)`);
      } catch (e) {
        console.warn(`[EmulatorClient] failed to provision system file ${f.name}:`, e?.message || e);
      }
    }
  }

  _writeRom(romBuffer) {
    const M = this._getModule();
    if (!M?.FS) throw new Error('Module.FS not available — core not initialized');
    try { M.FS.mkdirTree('/rom'); } catch (_) {}
    if (this._discImage) {
      // The real bytes never go through MEMFS — Play!'s CreateImageStream()
      // ignores whatever (if anything) is on disk at this path under
      // Emscripten and talks to M.discImageDevice instead (see DiscImageDevice
      // above). Still write a small placeholder so any path-existence/size
      // check RetroArch's own content loader does before retro_load_game
      // (need_fullpath=true content is never actually read into memory by RA
      // itself) finds a real, non-empty file.
      M.discImageDevice = new DiscImageDevice(M, romBuffer);
      const data = new Uint8Array(romBuffer);
      M.FS.writeFile(this._romPath, data.subarray(0, Math.min(data.length, 32768)));
      return;
    }
    M.FS.writeFile(this._romPath, new Uint8Array(romBuffer));
  }

  _fail(message) {
    console.error('[EmulatorClient]', message);
    this.dispatchEvent(new CustomEvent('error', { detail: message }));
  }
}
