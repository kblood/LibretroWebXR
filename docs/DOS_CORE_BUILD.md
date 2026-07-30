# DOS support — status & build notes

## Current real status (2026-07-31 — read this before anything below, supersedes everything about VirtualXT)

The 2026-07-29 plan below ("target DOSBox Pure next") was actually carried out
on branch/commit `2715c65` the same day: a real **DOSBox Pure** emscripten
core was built (pthreads/`HAVE_THREADS=1`, `HAVE_OPENGLES3=1`) and staged to
`~/dosbox-build/stage/latest` in WSL2 — but left "staged, NOT installed" (no
`public/cores/` copy, no `systems.js` entry, no boot verification). That is
the working core this doc's older sections say doesn't exist yet; it was just
never plugged in. Status as of this session (2026-07-30/31):

- **Installed** into `public/cores/dosbox_pure_libretro.{js,wasm,worker.js}`
  (gitignored, as with every other core) with a matching `.build.json`
  manifest (also gitignored — no core manifest in this repo is git-tracked,
  see `git ls-files public/cores/`; verify a core is real by hash/behavior,
  not by the manifest, per the gitignored-artifact-regression lesson from the
  PSX work).
- **Headless boot infra built and working**: `test/dos-core-e2e/{index.html,harness.js}`
  + `scripts/probe-dos-core.js`, following the exact N64/PSX pattern.
- **The pthread worker-in-worker risk flagged at build time is retired.**
  This is the first core in the app to call real `pthread_create()`
  (`DBP_ThreadControl`) from inside our own dedicated execution Worker. It
  works: the core boots, runs its main loop indefinitely at full frame rate,
  mounts a real FAT12 floppy (`public/roms/local/dos/freedos-boot.img`,
  gitignored), and its internal program dispatcher selects and runs a real
  program — all with zero crashes and zero worker errors, sustained over
  1000+ frames / 20+ seconds.
- **Found and fixed a real, generic app bug this exposed**: Emscripten's
  pthread-enabled glue does internal `postMessage()` scheduling calls (a
  `setImmediate` polyfill trick) on the same worker message channel this
  app's own REQUEST/RESPONSE/EVENT/FRAME protocol uses. `assertProtocolMessage()`
  in `src/runtime/protocol.js` used to treat any message missing a `protocol`
  field as fatal; it now silently ignores such "foreign traffic" instead, only
  throwing for a message that claims the protocol but has the wrong version.
  Fixed in `protocol.js`, `WorkerEmulatorClient.js`, `EmulatorWorkerRuntime.js`.
  This would have blocked ANY future pthread-enabled core, not just this one.
- **Found and fixed a real core-side rendering bug, by reading DOSBox Pure's
  own C++ source** (`~/dosbox-build/dosbox-pure/dosbox_pure_libretro.cpp` in
  WSL2): its `voodoo_perf` core option defaults to `"auto"`, which makes
  `retro_load_game()` negotiate an OpenGL **HW render context purely for
  optional 3dfx Voodoo emulation** — but once that context exists, DOSBox
  Pure's `dbp_opengl_draw` function pointer is set in `HWContext::Reset` and
  **every** frame after that (Voodoo or not) is submitted through its own
  internal GL blit-into-FBO path instead of the plain
  `video_cb(buf.video, ...)` software path. In this project's worker/
  OffscreenCanvas WebGL2 context that GL path presented nothing (solid
  black), exactly the same class of bug already fixed for Beetle PSX HW (see
  the `RETROARCH_CORE_OPTIONS` comment in `src/RetroArchConfig.js`). Fix:
  `dosbox_pure_voodoo_perf = "1"` (Software Multi Threaded) in
  `RETROARCH_CORE_OPTIONS`, which skips HW render negotiation entirely.
  Confirmed via verbose (`-v`) boot logs: the "Requesting OpenGL context...",
  "Using HW render, OpenGL driver forced.", and "[GL] Initializing HW render"
  lines are all gone after the fix, replaced by the plain software `gl`
  display-driver path. This fix is real and worth keeping regardless of the
  next point.

**Still broken / open**: even with the HW-render bug fixed, the presented
video is **still solid black** — confirmed both by 5-point canvas sampling
and by direct visual review of full screenshots taken at multiple points
during a 25+ second boot with real content mounted. So there are (at least)
two independent problems here, not one: the HW-render-path bug above (real,
fixed) and something else keeping DOSBox's own software framebuffer
(`buf.video`) from ever showing content, even though the core reports no
errors, keeps presenting frames at a steady rate, and its `PUREMENU`/`DOSBOX`
program dispatcher log lines show it selecting real content to run. No
`[DOSBOX] Resolution changed ...` log line — which fires on every VGA mode
change — was ever observed, which is *consistent with* (but does not prove)
either a normal 80x25 text-mode boot that never changes mode, or a stalled
emulation thread that never gets far enough to draw anything. **Leading
untested hypothesis**: a pthread/semaphore synchronization stall specific to
this worker-in-worker topology, occurring after DOSBox's program-selection
logic runs (which appears to happen very early, likely still
initialization-phase) but before its CPU-emulation thread actually starts
executing/drawing — this would explain continuous frame *presentation*
(driven by this app's own timer-based frame pump, independent of whether the
core's own emulation thread is alive) coexisting with zero real video
content. Not yet confirmed; would need core-side instrumentation (e.g.
enabling `dosbox_pure_perfstats` to check for periodic speed/cycle log
output over a much longer wait, or adding temporary debug logging to the
core's CPU loop and rebuilding) to verify. Do not treat this as fixed until
a real screenshot shows real DOS video content.

**Not done as a result**: `dosbox_pure` is not yet added to `src/systems.js`'s
`CORES`/`SYSTEMS.dos` — that should wait until content actually renders, so
`experimental:true` DOS stays exactly as broken/hidden as it already was
rather than silently swapping in a differently-broken core.

---

## History: the original VirtualXT attempt (superseded, kept for context)

DOS was originally registered as a system (`dos`) running on the **VirtualXT**
libretro core (an Intel 8088 / IBM PC-XT emulator, MPL-2.0, built-in GLaBIOS —
no proprietary BIOS needed). The system + core were wired into `src/systems.js`
exactly like the other computer systems (`keyboard:true`, `medium:'floppy'`).
VirtualXT is a dead end (see below) — DOSBox Pure per the section above is the
live path.

### Status as last verified for VirtualXT (2026-07-29)

**`virtualxt_libretro.wasm` is ABSENT from `public/cores/` and 404s on the live
deploy.** The "prebuilt buildbot binary that boot-traps" described in the next
section below is **not the current failure** — that binary isn't even present
here anymore (it was fetched once for the original de-risk, tested, and never
persisted/re-fetched since; no local core source this repo has used recently
carries it, and `scripts/fetch-cores.mjs` treats a missing buildbot core as a
soft "missing in source" warning, not a hard error — see its `virtualxt` entry
comment). So a user picking DOS today hits **a missing-core fetch error**
(`EmulatorClient._loadCore`'s `import(absoluteCoreUrl)` on a 404 .js file
throws, caught by `main.js`'s `loadCartridge` try/catch, surfaced as a "couldn't
load" message on the in-world TV/placeholder screen — see that function's
`catch` block), not the `invoke_iii`/`unreachable` trap. Both states mean
"does not work"; only the failure *stage* changed.

To keep this honest, `src/systems.js`'s `dos` entry now carries
**`experimental: true`** — the same mechanism PSX/N64 use (see the comment
above `SYSTEMS.psx` in that file): it hides `dos` cartridges from the default
shelf/collection UI (`Collection.js` gated on `?experimental=1` in `main.js`)
without deleting the registration, so real users are never offered a system
that can't currently boot, while the wiring stays reachable for testing/future
work. `scripts/fetch-cores.mjs` still lists `virtualxt` (best-effort, not a
hard error) so a working build gets picked up automatically once one exists.

**Chosen plan (2026-07-29):** the de-risk below already showed VirtualXT
resurrection is a dead end (Odin frontend, no emscripten path upstream, and the
buildbot binary's trap is a content-independent build-level defect with no
config/flag to try against it). Do **not** spend further real effort chasing
virtualxt beyond a strict time-box. The next real DOS work should target
**DOSBox Pure**, following the PUAE recipe (`docs/AMIGA_CORE_BUILD.md`):

```json
{"core":"dosbox_pure","verdict":"PROCEED-WITH-RISK","fastPath":"Before starting the DOSBox Pure build, spend at most ~10 minutes on: `node scripts/fetch-cores.mjs` (from C:\\LLM\\LibretroWebXR) to see if the buildbot's virtualxt_libretro.js/.wasm even lands in public/cores/ today (KNOWN STATE says it currently 404s/is absent, so this alone may just fail loudly). Do NOT spend real time trying to resurrect virtualxt further than that: the documented invoke_iii/unreachable trap is a content-independent, emscripten build-level defect in a core whose upstream CI has no emscripten target at all (Odin frontend, Linux/Windows/Android only) — there is no flag or config to try against it, and it will not have self-healed. Time-box strictly and move on to DOSBox Pure regardless of outcome."}
```

## Feasibility outcome (de-risk)

| Path | Result |
|------|--------|
| Prebuilt **DOSBox Pure** on the libretro emscripten buildbot | **Absent.** `RetroArch.7z` (762 MB, 825 cores) contains no `dosbox_*`. EmulatorJS CDN ships `dosbox_pure-*.data`, but that's the EmscriptenFS `.data` bundle format, which this loader does not consume (it wants `export default` MODULARIZE ES modules). |
| Prebuilt **VirtualXT** on the buildbot | **Was present** during the original de-risk (`virtualxt_libretro.js/.wasm`, module-style `export default libretro_virtualxt`, temporarily dropped into `public/cores/` to test it) and **TRAPPED at boot** (see below). That binary is **no longer on disk here** — see "Current real status" above; the trap was never fixed, just no longer reproducible locally because the file itself is gone. |

### The prebuilt VirtualXT boot trap (BLOCKER)

The buildbot `virtualxt_libretro.wasm` loads, instantiates, and **correctly mounts
the disk image** (`[VirtualXT] Mounted /rom/rom.img as drive A: (1474560 bytes)`),
then traps:

```
[libretro WARN] [VirtualXT] RTC requested but time() not available; skipping.
[EmulatorClient] callMain threw: RuntimeError: unreachable
  at wasm-function[2626]  ← inside invoke_iii (emscripten C++ exception/longjmp trampoline)
```

- Reproducible and **content-independent** (same trap with a known-good FreeDOS
  1.3 boot floppy and with the user's game images).
- **Not** a loader/harness/wiring problem: the analogous heavy RA-Makefile core
  `puae` boots `ready:true` / 88% non-black in the *identical* harness.
- Persists with Chrome `--experimental-wasm-eh --wasm-staging`.
- The `invoke_iii` + `unreachable` signature is an emscripten build-level defect
  (function-pointer-cast / exception-mode mismatch) in the buildbot binary.

Verify scripts that produced this: `tmp/probe-dos-boot.mjs`, `tmp/probe-vxt-trap.mjs`
(boots virtualxt with a real canvas, FS-writes `/rom/rom.img`, hooks `onAbort`).

## What it would take to ship a *working* DOS core

Building VirtualXT ourselves is **not** the easy puae-style C recipe: VirtualXT's
libretro frontend is written in **Odin** (`src/frontend/libretro/libretro.odin`),
and the upstream libretro CI (`.github/workflows/libretro.yml`) only targets
Linux/Windows/Android — there is **no emscripten build path upstream**. A working
web build would require the Odin compiler (`dev-2025-09`) with a functioning
wasm/emscripten backend linked against RetroArch's `Makefile.emscripten` — an
unproven, multi-hour spike (and the buildbot's own attempt traps).

Alternative: **DOSBox Pure** (broad 386/486 compat, loads .zip/folder/.dosz
directly — the better long-term core). It's a large C++ core; an emscripten build
is heavy and not on the buildbot. This is the recommended target if a real build
is greenlit, following the puae recipe in `docs/AMIGA_CORE_BUILD.md` (emsdk
3.1.46 in WSL2 → core `.bc` → link against RetroArch `Makefile.emscripten`,
`HAVE_THREADS=0`). Assess effort before committing — dosbox_pure is the heaviest
core we'd have attempted.

## VirtualXT content model (for when the core works)

- `supported_extensions = "img|zip"`, `needs_fullpath = true`. It boots **FAT disk
  images** (floppy/HD `.img`) or a zip — **NOT** bare `.com`/`.exe` (those trap).
- It has **GLaBIOS (PC BIOS) built in but no DOS** — you must boot a DOS disk.
  Upstream ships redistributable boot HD images in its repo `boot/`:
  `freedos_hd.img`, `svardos.img`, `elks_hd.img`. The intended UX: mount a DOS
  HD image, copy the game onto it (or a second disk), and autorun it.
- A redistributable FreeDOS 1.3 boot floppy (`x86BOOT.img`, GPL) is staged at
  `public/roms/local/dos/freedos-boot.img` (gitignored) for boot testing.

## DOS mouse (follow-up — owned by the parallel mouse agent)

DOS is mouse-driven. The mouse transport is the shared
`EmulatorClient.sendMouse(dx, dy, buttons)` primitive being built on branch
`feat/mouse-peripheral`. VirtualXT reads `RETRO_DEVICE_MOUSE` on port 0 with the
PS/2 mouse enabled by default — no core option needed. When `sendMouse` lands,
route the room's mouse prop / aim-ray through it to the active DOS console's
`EmulatorClient`. See the "DOS mouse follow-up" comment in `src/systems.js`
(below `SYSTEM_PORTS`). This branch intentionally does NOT touch the mouse path,
to avoid colliding with that agent's `EmulatorClient` changes.

## Files

- `src/systems.js` — `CORES.virtualxt` + `SYSTEMS.dos` (now `experimental: true`)
  + `SYSTEM_PORTS.dos` + the DOS-mouse follow-up comment. (committed)
- `public/cores/virtualxt_libretro.{js,wasm}` — prebuilt buildbot core (gitignored;
  fetched into `public/cores/` by `scripts/fetch-cores.mjs`, best-effort). NOTE:
  as of 2026-07-29 this is **absent** (404s on the live deploy too) — see
  "Current real status" above. When present, expect the boot-trap described
  above unless a newer buildbot build has fixed it upstream.
- `public/roms/local/dos.collection.json` + `public/roms/local/dos/*` — gitignored
  local DOS test content (user-owned games + FreeDOS boot floppy).
- `tmp/probe-dos-*.mjs`, `tmp/probe-vxt-*.mjs` — headless boot-verify harnesses.
