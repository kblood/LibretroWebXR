# DOS support (VirtualXT) — status & build notes

DOS is registered as a system (`dos`) running on the **VirtualXT** libretro core
(an Intel 8088 / IBM PC-XT emulator, MPL-2.0, built-in GLaBIOS — no proprietary
BIOS needed). The system + core are wired into `src/systems.js` exactly like the
other computer systems (`keyboard:true`, `medium:'floppy'`).

## Feasibility outcome (de-risk)

| Path | Result |
|------|--------|
| Prebuilt **DOSBox Pure** on the libretro emscripten buildbot | **Absent.** `RetroArch.7z` (762 MB, 825 cores) contains no `dosbox_*`. EmulatorJS CDN ships `dosbox_pure-*.data`, but that's the EmscriptenFS `.data` bundle format, which this loader does not consume (it wants `export default` MODULARIZE ES modules). |
| Prebuilt **VirtualXT** on the buildbot | **Present** (`virtualxt_libretro.js/.wasm`, module-style `export default libretro_virtualxt`) and **dropped into `public/cores/`** — but the buildbot binary **TRAPS at boot** (see below). |

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

- `src/systems.js` — `CORES.virtualxt` + `SYSTEMS.dos` + `SYSTEM_PORTS.dos` +
  the DOS-mouse follow-up comment. (committed)
- `public/cores/virtualxt_libretro.{js,wasm}` — prebuilt buildbot core (gitignored;
  fetched into `public/cores/`). NOTE: the current binary boot-traps; see above.
- `public/roms/local/dos.collection.json` + `public/roms/local/dos/*` — gitignored
  local DOS test content (user-owned games + FreeDOS boot floppy).
- `tmp/probe-dos-*.mjs`, `tmp/probe-vxt-*.mjs` — headless boot-verify harnesses.
