# LWX PSX Test Disc — authoring recipe + a real rendering-pipeline gap found while verifying it

`games/psx-testdisc/` is this repo's first PSX title authored as a real,
bootable CD image (CUE+BIN), as opposed to
`scripts/cores/psx/test-content/generate-smoke-exe.js` (a ~40-instruction
hand-assembled raw MIPS `.exe` that never touches CD-ROM reading, BIOS boot,
or memory-card save/load — see `docs/PSX_CORE_BUILD.md`). This doc covers the
toolchain recipe and, importantly, a real content-independent rendering gap
found in this project's PSX worker runtime while trying to verify the disc
visually — read the "Known gap" section before trusting any screenshot of
this disc as proof our game's own draw calls are on screen.

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
- `system.cnf` sets `BOOT=cdrom:\PSXTEST.EXE;1`.
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
`<license>` element. This is not believed to be the cause of the rendering
gap below (see that section — the same gap reproduces via a bare `.exe`,
which never goes through CD-ROM/TOC/license logic at all).

## Verification performed

- `npm run probe:psx-testdisc` boots the real CUE+BIN through the app's real
  disc-loading path (`WorkerEmulatorClient` → `mednafen_psx_jit` /
  Beetle-PSX-HW + Lightrec, `entrypoint: 'retroarch'`, `requiresThreads:
  true`), asserting: cross-origin isolation, ≥3 presented frames, a
  non-blank frame at three checkpoints (boot / after the frame-180
  save-trigger / after a `client.reset()` soft-reset), zero worker errors,
  zero real core error-log lines, and continuous native Lightrec JIT
  compilation + PCM audio forwarding. **This passed** (no track/file errors,
  no fatal markers — the disc genuinely loads through the real content
  pipeline). See `test/psx-core-e2e/harness-disc.js` /
  `scripts/probe-psx-testdisc.js`.
- What this does **not** prove: that our own authored draw calls (the cube,
  the HUD text, anything) are what's actually on screen. See below.

## Known gap: PSn00bSDK-built content doesn't visibly render in this project's PSX worker runtime

While trying to capture a screenshot of the cube as visual proof, every
checkpoint showed a flat, near-uniform screen color that slowly alternated
between two fixed values (`(0,66,90)` and `(58,16,0)`, roughly every ~5
real seconds) with no visible cube, HUD text, or any of several deliberately
unmistakable debug markers (a full-screen pure-red/green/green background
cycle, a solid 2D debug rectangle, a 16×16 white tile sweeping across the
screen). Meanwhile `psxJitCompiledBlocks` (native Lightrec compiled-block
count) climbed only from ~95 to ~122 over 90 real seconds — implausibly low
for a BIOS boot plus a running GTE/font/pad/memory-card game loop, which
touches far more unique code than that.

Isolation testing (`tmp/debug-psx-*.mjs`, `tmp/minimal-test/*` during this
session — not part of the shipped deliverable) built and booted **eight**
independent payloads:

1. The full game (cube + GTE + font + memory card), via CUE+BIN.
2. A minimal PSn00bSDK build doing *only* a full-screen background-color
   cycle via the standard double-buffer `DRAWENV`/`isbg`/`VSync`/`DrawSync`
   pattern (verified byte-for-byte structurally identical to PSn00bSDK's own
   official `examples/graphics/gte/main.c`), via CUE+BIN and via a raw `.exe`.
3. The same, plus a moving 16×16 tile.
4. A variant using PSn00bSDK's `DrawPrim()`/`TILE` primitives directly with
   **no** `VSync`/`DrawSync` calls at all (rules out a vblank-IRQ wait hang).
5. A variant using **raw GP0/GP1 MMIO pokes** (matching the known-working
   hand-assembled smoke test's own approach) with **no** PSn00bSDK graphics
   library calls at all — still built/linked via the normal PSn00bSDK
   toolchain (`psn00bsdk_add_executable`, real `crt0`/libc startup).
6. The same, with every division/modulo operation replaced by bitwise
   shifts (rules out a MIPS `DIV`/`DIVU` dynarec bug).
7. The same, with the `.exe` header's stack-pointer field hex-patched from
   `0` to a real address matching the smoke test's own header (rules out a
   null-stack-pointer corruption theory).

**All seven of these PSn00bSDK-toolchain-built payloads produced the
byte-identical, content-independent two-color sequence at the same frame
counts**, regardless of CD-boot vs. raw-`.exe` loading, regardless of
`VSync`/`DrawSync` use, regardless of division, regardless of the patched
stack pointer. Only the **original hand-assembled smoke test**
(`generate-smoke-exe.js`, which pokes GP0/GP1 directly and was never linked
against any PSn00bSDK library or `crt0` startup code) shows genuinely
different, content-correct output (a single fixed fill color consistent with
its own hardcoded GP0 fill command).

This strongly points at a gap somewhere between "a normally-linked
PSn00bSDK executable's BIOS handoff / `crt0` startup" and "this project's
PSX worker-runtime video-output path actually reflecting subsequent CPU
execution" — **not** a bug in this disc's content, in `mkpsxiso`'s CD image
structure, or in the build toolchain. The exact mechanism was not
conclusively identified (candidates not yet ruled out: something specific to
`GPREL` linking / initial `$gp` setup, the ~0x90-byte gap between this
build's load address and its recorded entry point in the `.exe` header vs.
the smoke test's entry-equals-load-address header, or a genuine bug in the
worker runtime's canvas/video-blit path specific to this core's hardware/GL
renderer) — root-causing further would mean editing `src/runtime/*` /
`src/RuntimeEmulatorClient.js` / `src/RetroArchConfig.js`, which is
explicitly out of scope for this work (see the task boundary notes in
`docs/research/psx-ps2-n64-review-2026-07-24.md`) and where a separate,
concurrent session is already working on worker-core runtime issues.

**Consequence for `docs/PSX_CORE_BUILD.md`'s existing "PASSED (2026-07-21)"
claim:** that verification is still valid on its own narrow terms (the
hand-assembled smoke exe's own MMIO writes really do reach the screen), but
it does not generalize to "any real PSn00bSDK-built PSX program renders
correctly in this app" — this doc's finding is new information that
narrows what that pass actually covers.

## Memory-card (Tier 3) status

Not independently verifiable given the above: `client.readSaveRam(1)`
returned `null` in every run, both mid-session and after a soft reset. This
is consistent with (a) our content never actually reaching its main loop for
the reasons above, and/or (b) the separately-tracked P0-5 SaveRAM-autosave
gap (`autosave_interval` is set, but `WorkerEmulatorClient.flushSaveRam()`
only re-reads MEMFS — a different, concurrently-being-fixed issue). The
game's own save/load code (`mc_init`/`save_load`/`save_write` in `main.c`)
is written and structurally correct against the documented BIOS low-level
memory-card protocol, but round-trip proof could not be captured.

## Bottom line / tier reached

**Tier 1 is not fully verified.** The toolchain and CD-image build pipeline
are real, reproducible, and proven (`npm run make-psx-testdisc` produces a
structurally valid CUE+BIN every time), and the disc **does** boot through
the app's real disc-loading path with no file/track/fatal errors and
continuous JIT execution + audio — but conclusive visual proof that our
authored content (not just the pipeline around it) is what's rendering could
not be obtained, for the reasons documented above. Tier 2 (visible spinning
cube) and Tier 3 (memory-card round trip) are consequently also unverified.
