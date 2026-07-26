# LWX PSX Test Disc — authoring recipe, and the two bugs that stopped it rendering

`games/psx-testdisc/` is this repo's first PSX title authored as a real,
bootable CD image (CUE+BIN), as opposed to
`scripts/cores/psx/test-content/generate-smoke-exe.js` (a ~40-instruction
hand-assembled raw MIPS `.exe` that never touches CD-ROM reading, BIOS boot,
or memory-card save/load — see `docs/PSX_CORE_BUILD.md`).

For a while this disc appeared not to render: every screenshot showed a flat,
near-uniform colour that alternated between two fixed values, with no cube, no
HUD text, and no reaction to deliberately unmistakable debug markers. That was
**two separate real bugs stacked on top of each other**, both now found and
fixed (2026-07-26) — see "Root causes" below. The disc now boots, renders, and
round-trips a memory-card save, and `npm run probe:psx-testdisc` asserts all
three.

## Content

An original CC0 PlayStation 1 homebrew (PSn00bSDK, C): a GTE-projected,
lit, rotating six-face cube (flat-shaded, backface-culled, depth-sorted
through an ordering table — copied structurally from PSn00bSDK's own
`examples/graphics/gte` sample, which is the standard reference every
PSn00bSDK program of this kind is built from), a text HUD (`FntPrint`), a
memory-card save/load path using the low-level BIOS `_card_read`/
`_card_write`/`_card_wait` protocol (sector 16 on card slot 1), and a
digital-pad input handler (D-pad changes spin speed, CROSS or an automatic
frame-180 trigger writes a save). No copyrighted Sony/game assets — geometry,
palette, and text are original to `games/psx-testdisc/main.c`.

## Toolchain recipe

Build environment: the [`luksamuk/psxtoolchain`](https://hub.docker.com/r/luksamuk/psxtoolchain)
Docker image, run via WSL2. This image ships a **complete, pre-built
PSn00bSDK install** at `/opt/psn00bsdk` (compiler, `include/libpsn00b`,
`lib/libpsn00b/{release,cmake}`, `share/psn00bsdk/{examples,template}`,
and `mkpsxiso`) — no SDK bootstrap/build step is needed, unlike the PSX core
itself (`docs/PSX_CORE_BUILD.md`) or the N64 toolchain (`docs/N64_CORE_BUILD.md`).

```sh
# from WSL2, or via wsl.exe from Windows (see scripts/make-psx-testdisc.mjs
# for the exact invocation this repo uses)
docker run --rm -v <game-dir>:/work -w /work luksamuk/psxtoolchain \
  'cmake --preset default && cmake --build build'
```

- The container's `ENTRYPOINT` is `/bin/bash -l -c`, so the command must be
  passed as a **single string argument** to `docker run` — `docker run --rm
  luksamuk/psxtoolchain bash -c '...'` double-wraps it and silently exits
  with no output.
- `games/psx-testdisc/CMakeLists.txt` uses `psn00bsdk_add_executable(psxtest
  GPREL main.c)` then `psn00bsdk_add_cd_image(iso psxtest iso.xml DEPENDS
  psxtest system.cnf)`, matching PSn00bSDK's own CMake template
  (`CMakePresets.json` mirrors the template's preset, pointing
  `CMAKE_TOOLCHAIN_FILE` at `$env{PSN00BSDK_LIBS}/cmake/sdk.cmake`, which the
  image sets as an env var). The build produces `build/psxtest.bin` +
  `build/psxtest.cue` via `mkpsxiso`, driven by `games/psx-testdisc/iso.xml`
  (volume `LWX_PSX_TESTDISC`, files `SYSTEM.CNF` + `PSXTEST.EXE`, no license
  file — see "License data" below).
- `system.cnf` sets `BOOT=cdrom:\SLUS_000.01;1` and `iso.xml` names the
  executable `SLUS_000.01`. **The Sony-style serial name is load-bearing, not
  cosmetic** — see "Root cause 1" below.
- **Docker socket gotcha (WSL2 Ubuntu):** if `systemctl status docker`
  reports "active (running)" but `docker ps`/`docker run` hang or fail to
  connect, `docker.socket`'s socket-activation can be in a broken state where
  `/run/docker.sock` doesn't actually exist on disk. Fix: `sudo systemctl
  stop docker.socket docker.service; sudo pkill -9 dockerd; sudo rm -f
  /run/docker.sock; sudo nohup dockerd > /tmp/dockerd.log 2>&1 & disown`,
  then retry. This doesn't affect any other Docker workloads running in the
  same WSL2 instance once dockerd is back up.
- A prior `cmake --build` leaves a root-owned `build/` directory in the
  bind-mounted host folder (the container runs as root) that the host user
  can't `rm -rf` directly — clear it from inside a throwaway container first
  (`docker run --rm -v <dir>:/work luksamuk/psxtoolchain 'rm -rf /work/build'`),
  same pattern as `scripts/make-n64-scene.mjs`/`scripts/make-ps2-guncon-range.mjs`.

Rebuild + publish: `npm run make-psx-testdisc` (wraps
`scripts/make-psx-testdisc.mjs`, which does the WSL2/Docker dance above,
renames the CD image to `lwx-psx-testdisc.{cue,bin}` — rewriting the `.cue`'s
`FILE` line to match — and copies it to `public/roms/freeware/`). Verify with
`npm run probe:psx-testdisc` (wraps `scripts/probe-psx-testdisc.js`).

### License data

mkpsxiso's `iso.xml` supports an optional `<license file="..." />` pointing
at a 12-sector Sony boot-license binary blob, used by some BIOS variants/real
consoles to region-check a disc before booting it. PSn00bSDK does not ship
one ("License files are not distributed with PSn00bSDK for obvious reasons"
— its own template's comment), and this repo cannot legally include one
either (see `docs/LICENSING.md`) — `games/psx-testdisc/iso.xml` has no
`<license>` element.

The absence of that license blob **did** matter, just not the way you would
expect: Beetle PSX accepts a disc with no license data as long as the boot
executable is named like a Sony serial, which is exactly the workaround this
disc now uses (Root cause 1). No license blob is required.

## Root causes of the "it doesn't render" symptom

Both were found by dumping a save state out of the running core and decoding
it offline (`tmp/` helper scripts, not shipped): decoding the MDFNSVST
sections gave the CD controller's last response bytes, the CPU PC, main RAM,
and a full 1 MB copy of GPU VRAM that could be rendered to a PNG.

### Root cause 1 — the disc never booted; we were photographing OpenBIOS's demo

`system.cnf` said `BOOT=cdrom:\PSXTEST.EXE;1`. Beetle PSX decides whether a
disc is a PlayStation disc in `CalcDiscSCEx()`, which accepts either
"licensedby" text in the license area at sectors 0-15 **or** a Sony-format
serial on the `BOOT=` line — the name after `cdrom:\` must be four characters,
start with `S`, then `C`/`L`/`I`, then `E`/`U`/`K`/`B`/`P`
(`CalcDiscSCEx_BySYSTEMCNF()` in the core's `libretro.c`). `PSXTEST.EXE`
matches neither, and this disc ships no license blob, so `scex_ids[0]` stayed
`NULL`, `PS_CDC_SetDisc()` set `IsPSXDisc = false`, and `CdlGetID` answered
with the unlicensed-disc error `0a 90 20 00 ff 00 00 00` plus a
`CDCIRQ_DISC_ERROR` — verified byte-for-byte in the save state.

The core embeds PCSX-Redux's OpenBIOS (`deps/openbios/openbios.bin.h`), which
on an unbootable disc simply runs its own built-in shell demo: a large rotating
single-colour cube on a slowly colour-cycling background, with SPU music.
**That demo's background cycle is the `(0,66,90)` / `(58,16,0)`
"content-independent two-colour sequence"** the earlier isolation testing kept
recording. Every payload produced identical output because none of them ever
ran: the previous eight-payload isolation matrix was, unknowingly, eight
photographs of the same BIOS demo. Corroborating state evidence:
`BACKED_PC = 0x80031db4` (OpenBIOS shell region), main RAM at `0x10000` all
zero (our executable never loaded), all-zero GTE registers, and
`DisplayMode = 0x27` (640x480 interlaced — the demo, not our 320x240 program).

**Fix:** rename the boot executable to a Sony-serial-shaped name in both
`system.cnf` and `iso.xml` (`SLUS_000.01`) and rebuild the disc. Nothing about
the game code changed.

> Trap worth recording: an early attempt to test this hypothesis hex-patched
> the filename directly inside the `.bin`. That silently broke the Mode2 Form1
> EDC/ECC of the two sectors it touched, so `CDIF_ValidateRawSector()` failed,
> `CDIF_ReadSector()` returned 0, and the experiment showed "no change" —
> nearly discarding a correct hypothesis. Always rebuild with mkpsxiso.

### Root cause 2 — the core's OpenGL renderer presents only the background fill

With the disc booting, the game ran (`SET_SYSTEM_AV_INFO: 320x240`) and VRAM
dumped out of the save state showed **both** double buffers fully rendered —
"LWX PSX TEST DISC", "SAVE COUNT 1", "MEMORY CARD SLOT 1: OK", the HUD, and
the flat-shaded cube — while the canvas at the same instant was a single flat
colour.

Beetle PSX HW defaults `renderer` to `hardware` (Hardware (Auto)) and
`renderer_software_fb` to `enabled`, i.e. it presents the OpenGL renderer's
output while keeping a native-resolution software copy of VRAM in the
background for framebuffer effects and save states. In this project's
worker/`OffscreenCanvas` GL context the OpenGL path presents **only the
framebuffer's background fill** — no polygons, sprites or text ever reach the
canvas. That is why the flat colour tracked whatever program was running
(OpenBIOS's demo clear colour before fix 1, our `setRGB0(12,14,24)` after it).

**Fix:** `src/RetroArchConfig.js` now sets `beetle_psx_renderer = "software"`
(and the `beetle_psx_hw_` prefixed variant, since `BEETLE_OPT()` changes prefix
in `HAVE_HW` builds). It is a "Restart required" option, so it has to be in the
core-options file before content loads — which is what that constant is for.
The underlying GL-path bug in the core artifact is not fixed, just avoided.

### Side effect found on the way: Lightrec segfaults on real content

Once the disc actually booted, the run died ~2 s in with
`[Lightrec]: Segmentation fault in recompiled code: invalid load/store at
address PC 0x5ffffcfc` while executing a block at `PC 0x000036f8` (BIOS kernel
RAM, during the CD exec/load path), after which the core stopped presenting
frames. `execute`, `execute` + `dynarec_invalidate = dma`, and
`run_interpreter` (Lightrec's own interpreter, no Wasm codegen at all) all fail
identically; only `disabled` (Beetle's own CPU interpreter) works. Because
Lightrec's plain interpreter fails the same way, the fault is in the Lightrec
layer's shared memory-map / block-invalidation path and **not** in the Wasm
code generator. `beetle_psx_cpu_dynarec` is therefore pinned to `"disabled"` in
`src/RetroArchConfig.js`; the full reasoning and the one-line revert are in the
comment above `RETROARCH_CORE_OPTIONS`. Fixing it properly means rebuilding
`kblood/psx-wasm-jit-libretro`.

### Third bug found on the way: save/state paths never matched RetroArch's

RetroArch 1.22 defaults `sort_savefiles_enable` / `sort_savestates_enable` to
`true`, which redirects SRAM and save states into a per-core **subdirectory**
("[Override] Redirecting save file to .../saves/Beetle PSX/<content>.srm").
`EmulatorWorkerRuntime` computes `${SAVE_DIR}/${saveStem}.srm` and
`${STATE_DIR}/${saveStem}.state` with no core-name segment, so **every**
worker core's `readSaveRam()` read a path that never existed (returning `null`
— which is exactly what this doc used to record) and `serializeState()` polled
for a state file the core was writing elsewhere, failing with "save state did
not stabilize within 2s". `src/RetroArchConfig.js` now turns all four
`sort_save*` options off. This affects every worker core, not just PSX.

## Verification performed

`npm run probe:psx-testdisc` boots the real CUE+BIN through the app's real
disc-loading path (`WorkerEmulatorClient` -> `mednafen_psx_jit` /
Beetle-PSX-HW, `entrypoint: 'retroarch'`, `requiresThreads: true`) and asserts:

- cross-origin isolation, at least 3 presented frames, zero worker errors,
  zero real core error-log lines, no fatal markers;
- **our own draw calls on screen**: at least 250 near-white pixels in the top
  40% of the frame (the `FntPrint` HUD), at least 80000 pixels of the game's
  own `RGB(12,14,24)` clear colour, and at least 4 distinct RGB555 colours. The
  background requirement is what stops a bright BIOS boot screen counting as a
  pass, and the HUD requirement is what stops a flat fill or the OpenBIOS demo
  (which draws no text at all) counting as a pass — both were real shipped
  failure modes;
- the same content check again **after a `client.reset()` soft reset**;
- a **memory-card round trip**: the game's save block (magic `TWX1`, save
  count, frame number, checksum) must be readable back off the emulated card
  mid-session, and must still be there after the soft reset.

Measured on a passing run (2026-07-26): 1747 frames presented, 0 dropped;
`brightTop` 4080 / `background` 231744 before the reset and 3416 / 232890
after it; save block `54 57 58 31 01 00 00 00 b4 00 00 00 e1 57 58 31`
(`magic=TWX1, save_count=1, last_save_frame=180`) both mid-session and after
the reset. `scripts/probe-psx-testdisc.js` also writes
`tmp/psx-testdisc-boot.png` and `tmp/psx-testdisc-final.png`; the final shot
shows the cube plus "LWX PSX TEST DISC / SAVE COUNT: 1 / MEMORY CARD SLOT 1:
OK / X: SAVE  D-PAD L/R: SPIN SPEED".

## Memory-card (Tier 3) status

Working and asserted — see above. The earlier `readSaveRam(1) === null`
recorded here was the `sort_savefiles_enable` path bug, not the game's own
save code.

## Bottom line / tier reached

**Tiers 1, 2 and 3 are all verified.** The toolchain and CD-image build
pipeline are real and reproducible (`npm run make-psx-testdisc`), the disc
boots through the app's real disc-loading path, the authored cube and HUD are
confirmed on the canvas by both a screenshot and an automated pixel assertion,
and the memory-card save survives a soft reset.

Outstanding, both in the core artifact rather than in this repo:

- Lightrec (and therefore the Wasm JIT this core exists for) segfaults on real
  content, so PSX currently runs on Beetle's CPU interpreter.
- Beetle's OpenGL renderer presents only background fills in this worker GL
  context, so PSX currently runs on the software renderer. Performance on a
  Quest has not been measured under either constraint.
