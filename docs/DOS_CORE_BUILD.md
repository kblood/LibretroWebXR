# DOS support — status & build notes

## Current real status (2026-08-01 — RESOLVED, read this before anything below, supersedes everything about VirtualXT)

**DOSBox Pure genuinely renders now.** Installed, wired into `src/systems.js`
(`CORES.dosbox_pure`, `SYSTEMS.dos.defaultCore = 'dosbox_pure'`), and
headless-verified via `scripts/probe-dos-core.js`: a screenshot of the booted
core shows a fully legible **DOSBOX PURE START MENU** (real text, real UI,
real colors) on the synthetic FreeDOS boot floppy
(`public/roms/local/dos/freedos-boot.img`, gitignored). Not just non-black
pixels — actual, readable content. `experimental: true` stays set (same
in-VR-cart-insert-path reachability gap as PSX/N64, plus only tested against
a synthetic boot floppy so far, not a real commercial game).

The two bugs documented below (protocol.js foreign-message handling,
`voodoo_perf` HW-render bypass) were real and necessary but NOT sufficient —
video was still solid black after both. The actual root cause, found via
C-level (`retro_run()`) and JS-level (`Browser.mainLoop`) instrumentation of
the running core, not guesswork:

**Root cause: `EM_TIMING_SETIMMEDIATE` doesn't work in a nested-Worker
topology.** Emscripten's main-loop scheduler supports three timing modes —
`EM_TIMING_RAF` (requestAnimationFrame), `EM_TIMING_SETTIMEOUT` (a plain
timer), and `EM_TIMING_SETIMMEDIATE` (a message-based "run as fast as
possible" polyfill). Inside a Worker, the `SETIMMEDIATE` polyfill calls bare
`postMessage({target:"setimmediate"})` — which in a Worker's global scope
posts the message **outward to whatever created the worker**, not back to
itself. Stock Emscripten shell.html JS has a complementary listener that
relays it straight back in, closing the loop. This app has no such relay: the
whole RetroArch+core runtime already lives inside its own custom Worker
(`src/runtime/EmulatorWorkerRuntime.js`), and the main thread that owns that
worker (`WorkerEmulatorClient.js`) has never heard of this Emscripten-internal
convention. The message vanishes, `Browser.mainLoop`'s continuation never
arrives, and the loop silently stops ticking forever after the very first
`emscripten_resume_main_loop()` call — `retro_run()` never gets called again,
while this app's own timer-driven frame-presentation pump keeps right on
"presenting" whatever stale (black) framebuffer content is sitting there,
which is exactly the "steady frame count, zero video, zero errors" symptom
that made this so slow to pin down.

Confirmed empirically, not by inspection alone: a temporary C-level diagnostic
in `retro_run()` (logs unconditionally on its very first call) never fired at
all; JS-level instrumentation of `Browser.mainLoop.pause()/resume()` and the
`checkIsRunning()`/scheduler chain showed `resume()` correctly re-arming a
scheduler, that scheduler correctly getting invoked once, `Browser_emulated_
setImmediate()` correctly firing and posting `{target:"setimmediate"}` — and
then nothing: the matching `Browser_setImmediate_messageHandler` never once
received that message back. (A *stale*, already-queued `requestAnimationFrame`
callback from an earlier, superseded scheduler setup DID fire once — but by
then `Browser.mainLoop.currentlyRunningMainloop` had already advanced past
it, so `checkIsRunning()` correctly self-cancelled it before it could reach
`retro_run()`. Red herring, not the fix.)

**Fix** (RetroArch source level — `~/amiga-build/RetroArch/frontend/drivers/
platform_emscripten.c`, the shared checkout every core in this repo builds
against): every call site that could select `EM_TIMING_SETIMMEDIATE`
(`thread_main()`, `platform_emscripten_enter_fake_block()`,
`platform_emscripten_set_main_loop_interval()`) now resolves to
`EM_TIMING_SETTIMEOUT` instead, specifically when `HAVE_THREADS` is defined —
sidestepping the message round-trip entirely via a plain timer tick. Scoped
narrowly with `#if defined(HAVE_THREADS)` so N64/PSX's non-threaded
`EM_TIMING_RAF` path (which works fine as-is — RAF has no such round-trip
requirement) is completely untouched. This is a local patch to the shared
WSL2 RetroArch checkout, not upstreamed — re-applying it is a prerequisite
for any *future* HAVE_THREADS=1 core rebuild in this repo (see the `LWX:`
comments at each call site for exact patch text if the checkout ever gets
reset/re-cloned).

Also confirmed along the way, in case future pthread-core work re-treads this
ground: `PTHREAD_POOL_SIZE` already defaults to 4 in `Makefile.emscripten`
(`?= 4`, wired into `LDFLAGS` automatically whenever `HAVE_THREADS=1`) — a
"cold pthread pool" theory was floated and ruled out before the real
root cause was found; no pool-size tuning was needed or applied.

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

**Resolved 2026-08-01** — see the top of this section for the real root cause
(Emscripten's `EM_TIMING_SETIMMEDIATE` message-relay never closing the loop
in this app's nested-Worker topology) and the fix. The "stalled pthread/
semaphore in DOSBox's own CPU thread" hypothesis floated at the time this
paragraph was written turned out to be wrong — the CPU-emulation thread was
never the problem; `retro_run()` (RetroArch's own per-frame driver call) was
simply never being invoked at all, at the frontend level, regardless of
whether DOSBox's internal threads were healthy.

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
