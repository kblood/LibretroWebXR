# Building the PSX (Beetle PSX HW + Lightrec + Wasm JIT) core

Unlike the PS2 (`play`) core (see [[PS2_CORE_BUILD.md]]), the PSX core's
build tooling is **not vendored in this repo** — it lives in its own
published repository, [`kblood/psx-wasm-jit-libretro`](https://github.com/kblood/psx-wasm-jit-libretro),
because it's independently useful outside this app (a standalone,
reproducible core build + a Lightrec↔Play--CodeGen Wasm-JIT adapter). This
doc only covers getting the built artifacts into this repo's `public/cores/`
and how the integration on this side is wired — for the actual build recipe,
patches, and JIT-adapter design, see that repo.

## Why this core is different from every other one here

Every existing web PSX core (including the classic
`mednafen_psx_hw_libretro` build referenced by `webretro`) ships with
Beetle PSX's Lightrec dynarec **disabled** — Lightrec's native code
generator (GNU Lightning) emits real AArch64/x86 machine code bytes into a
buffer, which is just inert data under Wasm; there's no way to jump to it.
Every existing browser PSX core therefore falls back to Beetle's plain
interpreter, which is why PSX has historically been considered infeasible
for in-browser emulation at full speed (this project's own
`docs/research/psx-n64-feasibility.md` reached exactly that conclusion,
independently, before this integration existed — see the note at the
bottom of this doc).

`psx-wasm-jit-libretro` avoids that by reusing the **same trick this
project's own PS2 (`play`) core already proved**: instead of emitting
native machine code, adapt Lightrec's IR to Play--CodeGen's `Jitter`
framework and its existing `Jitter_CodeGen_Wasm` backend, which emits a
real, valid WebAssembly module per compiled block, instantiates it in the
CPU-emulation worker's own JS realm, and publishes it into Emscripten's
growable indirect function table via `addFunction()` so Lightrec can call
it as an ordinary C function pointer. Unsupported/cold blocks still fall
back to Lightrec's own interpreter — this is a real guest-code JIT, not a
faster interpreter.

## Getting the artifacts

`core-build/build.sh` (in the `kblood/psx-wasm-jit-libretro` repo) resolves
its own repo root as `core-build/../../../..` and reads sibling files like
`fetch-jit-deps.sh` / `integration/` relative to that — i.e. the script
expects to be run as if the whole `psx-wasm-jit-libretro` repo's contents
were laid out at `<some-root>/scripts/cores/psx/`, matching this project's
own `scripts/cores/psx/` (which currently only tracks `test-content/` in
git — the rest is deliberately not vendored here, see "Why this core is
different" above). A **plain top-level clone next to this repo will NOT
work** — `core-build/build.sh` will fail looking for
`<repo_root>/scripts/cores/psx/fetch-jit-deps.sh` four directories up from
`core-build/`, which won't exist. Lay it out correctly:

```sh
# From WSL. Anywhere works as <root>, as long as the clone's contents end up
# at <root>/scripts/cores/psx/ (this repo's own scripts/cores/psx/test-content/
# is safe to leave in place / overlay — the clone ships an identical copy).
mkdir -p <root>/scripts/cores/psx
git clone https://github.com/kblood/psx-wasm-jit-libretro.git /tmp/psx-clone
cp -a /tmp/psx-clone/. <root>/scripts/cores/psx/
rm -rf <root>/scripts/cores/psx/.git
cd <root>
bash scripts/cores/psx/core-build/build.sh   # see that repo's README for prerequisites
cp scripts/cores/psx/core-build/dist/mednafen_psx_jit_libretro.{js,wasm,worker.js,build.json} \
   <this-repo>/public/cores/
```

`public/cores/` is gitignored here — same convention as every other core
(`play_libretro.*`, etc.): build once, place on disk, never commit the
binary.

**One exception, added 2026-08-17 (ARC-3): `*.build.json` IS committed.**
`.gitignore` ignores `public/cores/*` and force-includes
`!public/cores/*.build.json`. That manifest is a few KB of reviewable text and
it is the entire provenance record for a binary nobody can see in the repo —
upstream repos + SHAs (RetroArch, beetle-psx, Play--CodeGen, Play--Framework),
the emsdk/emscripten commits, the link flags, and a sha256 per artifact. Copy it
into `public/cores/` with the binaries and commit it; `scripts/fetch-cores.mjs`
checks those sha256s against the bytes on disk. `PATCHED.json` stays ignored —
see `scripts/test-patched-cores.mjs` for why its absence has to mean something.

### Light-gun (GunCon) support — REQUIRED, easy to lose on a rebuild

**Fixed 2026-07-27.** `core-build/build.sh`, as published, applies exactly
two patches to its fetched RetroArch tree (`retroarch-worker-module.patch`,
`retroarch-rwebaudio.patch`) plus one to Beetle PSX
(`beetle-jit-build-fixes.patch`) — **it never applied the rwebinput
light-gun patch every other gun-capable core in this project needs**
(`docs/LIGHTGUN_SUPPORT.md`). Confirmed by fetching this build's pinned
RetroArch commit (`45246ce85eec8fb36d11c3bf551b9b81d3a426a1`) and reading
`input/drivers/rwebinput_input.c` directly: it has **no `RETRO_DEVICE_
LIGHTGUN` case at all**, so a game-port light gun always read `0,0`/no-
trigger no matter what this app's worker sent — exactly explaining why the
app-side GunCon wiring was fully verified working (`scripts/probe-psx-
guncon.js`'s dispatch/metrics checks) while the in-game shot never
registered.

If you rebuild this core from a fresh `kblood/psx-wasm-jit-libretro` clone,
you must (re)apply the same two patches this repo already carries for the
other gun cores, **in this order** (the multiport patch's hunks assume the
base patch's `RETRO_DEVICE_LIGHTGUN` case already exists and fail to apply
without it):

1. `docs/patches/rwebinput-lightgun.diff` — adds the base single-gun
   `RETRO_DEVICE_LIGHTGUN` case to `input/drivers/rwebinput_input.c`.
2. `docs/patches/rwebinput-lightgun-multiport.diff` — extends it to a
   per-port pointer + the exported setter
   `rwebinput_set_lightgun(port,x,y,buttons)` (`Module._rwebinput_set_
   lightgun` from JS) that `src/EmulatorClient.js`'s `sendLightgun()` /
   `src/runtime/EmulatorWorkerRuntime.js`'s `forwardLightgun()` call.

Apply both with `git apply` against the fetched `RetroArch` checkout
(`core-build/.work/wsl/RetroArch`) **after** `retroarch-worker-module.patch`
and `retroarch-rwebaudio.patch` have already been applied, and **before**
the final `emmake make ... all` link step. One wrinkle: the multiport
patch's own `Makefile.emscripten` hunk (adding `_rwebinput_set_lightgun,
_rwebinput_clear_lightgun` to `EXPORTED_FUNCTIONS`) no longer applies
cleanly once `retroarch-worker-module.patch` has already rewritten that
exact line — instead of a third patch file, insert those two export names
into the already-patched `EXPORTED_FUNCTIONS` line directly. **Guard the
insert so a second build.sh run against an already-patched Makefile doesn't
duplicate the symbols** (the same idempotency the two `git apply --check` /
`--reverse --check` patch blocks already give the other two patches):

```sh
# Check BOTH exported symbols, not just one -- a Makefile that somehow has
# _rwebinput_set_lightgun but not _rwebinput_clear_lightgun (e.g. hand-
# edited) must still fall through and get a full, correct insert rather
# than being treated as already-done.
if ! grep -q '_rwebinput_set_lightgun' Makefile.emscripten || \
   ! grep -q '_rwebinput_clear_lightgun' Makefile.emscripten; then
  grep -q '_lr_play_backend_invalidate_all' Makefile.emscripten || {
    echo "expected worker-module patch marker not found; insertion anchor changed" >&2; exit 1; }
  sed -i 's/_lr_play_backend_invalidate_all/_lr_play_backend_invalidate_all,_rwebinput_set_lightgun,_rwebinput_clear_lightgun/' \
    Makefile.emscripten
  grep -q '_rwebinput_set_lightgun' Makefile.emscripten && grep -q '_rwebinput_clear_lightgun' Makefile.emscripten || {
    echo "failed to insert rwebinput lightgun exports" >&2; exit 1; }
fi
```

`_lr_play_backend_invalidate_all` is the last symbol
`retroarch-worker-module.patch` itself adds, so it's a stable insertion
point **as long as that patch's own content doesn't change** — the explicit
`grep` check before the `sed` fails loudly instead of silently no-op'ing if
the anchor ever moves. Verify the export made it into the link command
(`grep _rwebinput_set_lightgun` in the `emcc ... -o mednafen_psx_jit_libretro.js`
invocation, or in the built `.js` glue afterward) before trusting the
artifact.

Both idempotent guard patterns already used for the other two RetroArch
patches (`git apply --check` / `--reverse --check` before applying, so a
second run of `build.sh` against an already-patched checkout doesn't error)
apply the same way here — see `core-build/build.sh`'s existing
`retroarch-worker-module.patch` / `retroarch-rwebaudio.patch` blocks for the
exact shape to copy.

**Verified end-to-end (2026-07-27):** rebuilt the core with both patches
applied plus the `sed` export insert, deployed to `public/cores/`, flipped
`SYSTEMS.psx.lightgun.broken` to `false` in `src/systems.js`, and re-ran
`npm run probe:psx-guncon` — **13/13** (was 12/13; the one prior failure was
exactly the `[GUNCON END-TO-END SIGNAL]` check). Confirmed with real
screenshots, not just the probe's pixel-diff assertion: the pre-shot
baseline shows Time Crisis's "Guncon Calibration" screen reading "Check the
GunCon connection, and point the gun at the screen." with an empty
crosshair; after firing at the on-screen calibration target, the settled
frame shows the screen has genuinely advanced to "Is the gun sight aligned
correctly? / Retry: Re-aim and shoot again. / End: Press A or B" with a red
calibration dot now inside the crosshair — the game's own state machine
reacted to the shot, not just a changed pixel count. (The actual PNGs are
`tmp/psx-guncon-baseline.png` / `tmp/psx-guncon-trigger-down.png` /
`tmp/psx-guncon-trigger-up.png`, written fresh by each `probe:psx-guncon`
run — `tmp/` is gitignored, so they aren't committed here; re-run the probe
to regenerate them.) `npm test` also passed
in full afterward (every suite, 0 failures) — no regressions from the
`broken: false` flip.

**⚠ That 13/13 was against an artifact that was reverted hours later
(2026-07-27), restored 2026-07-29.** The run above exercised the **12:17**
build. At **12:36 the same day** `public/cores/` was overwritten from an
**09:44 pre-gun-work backup**, so the core that then shipped carried
**neither** gun patch (`grep -c rwebinput_set_lightgun public/cores/
mednafen_psx_jit_libretro.js` → `0`) — most likely collateral damage from
rolling back a Lightrec/GL experiment, since the two builds pin identical
upstream commits. `public/cores/` is gitignored, so the revert left no trace
in `git status`, while `SYSTEMS.psx.lightgun.broken` stayed `false` and this
page still claimed a pass. On **2026-07-29** the 12:17 build was restored
from the WSL build dir (`scripts/cores/psx/core-build/dist`); the shipped
`.js` glue now greps `1` for both `rwebinput_set_lightgun` and
`rwebinput_clear_lightgun`, `public/cores/PATCHED.json` records
`mednafen_psx_jit: ["base","multiport"]`, and
`scripts/test-patched-cores.mjs` (in `npm test`) re-checks that against the
artifact. **End-to-end re-verification: DONE — `probe:psx-guncon` re-run
against the restored artifact, 14/14** (single gun, real Time Crisis `.cue`,
booted through the real cartridge-insert path; screenshots regenerated on
2026-07-29). The 2026-07-27 result above is therefore re-confirmed on the
shipped build, not merely inherited from the 12:17 one. Scope: that is the
SINGLE-gun path — two-gun co-op is a separate result with its own limits, see
`docs/LIGHTGUN_SUPPORT.md`, "PSX two-gun GunCon co-op". Post-mortem and the
two checks that catch this class of failure: `docs/LIGHTGUN_SUPPORT.md`,
"The PSX clobber".

**⚠ The probe's gating assertion was replaced on 2026-07-29 — the old one was
not a discriminator.** Every result above was gated on `[GUNCON END-TO-END
SIGNAL]`, which compared the settled post-shot frame against the boot-time
baseline captured ~25s earlier and passed on *any* non-zero difference. Run as
a negative control — a scratch checkout with `SYSTEMS.psx.lightgun.broken`
flipped back to `true`, so **no GunCon is ever seated** (worker telemetry
`gun:{multiport:null,devices:null}`) — that assertion **passed at
`maxDiff=407`, larger than the 287 a genuine hit produces**, purely from
elapsed time on a screen that drifts. So *that assertion alone* never proved a
shot reached Beetle PSX, and no claim should be sourced to it. It is now
`[GUNCON AIM DISCRIMINATION]`: the identical trigger sequence is fired twice,
off-screen then on-target, each arm measured against its **own** pre-shot frame
over the same timing budget, and the on-target arm must move the screen while
the off-screen control stays exactly flat. Validated in **both** directions:
working core → off-screen `0` / on-target `287`, **PASS 14/14**; no-gun
negative control → off-screen `412` / on-target `343`, **FAIL 12/14**. The
independent, still-valid evidence for the single-gun path is unchanged and does
not rest on any pixel-diff assertion: the shipped glue exports
`rwebinput_set_lightgun` (grep/sha256 above), the worker recorded the input
calls it was asked to make (`maxInputs=10`), and the 2026-07-27 screenshots
show the calibration screen genuinely advancing to "Is the gun sight aligned
correctly?" after the shot. (The on-target arm's pre-shot frame is now
`tmp/psx-guncon-pre-shot.png`; the trigger-down/-up PNGs keep their names.)

Pinned inputs at the time this integration was built (see that repo's own
`manifest.env`/`dist/*.build.json` for the current, authoritative pins —
these will drift as the upstream repo evolves):

| Component | Commit |
|---|---|
| RetroArch | `45246ce85eec8fb36d11c3bf551b9b81d3a426a1` |
| beetle-psx-libretro | `d6caed07fcba47c211ff23c4fa1b20b894830ff2` |
| Play--CodeGen | `a5009f7dca062695b8e5aebbd71e67b4ddfa9251` |
| Play--Framework | `587f278917acc0026bf5fc34b39f995fc26bd015` |
| Emscripten (emsdk) | `3.1.46` |

`buildHash` in `systems.js`'s `CORES.mednafen_psx_hw` entry
(`beetle-d6caed07-codegen-a5009f7d-jit-dev`) is derived from the Beetle and
Play--CodeGen pins above — it's a human-readable label, not
cryptographically bound to the artifact; the real integrity check is the
per-artifact SHA-256 in the adjacent `.build.json` manifest, which
`RuntimeEmulatorClient.resolveCoreBuildHash()` reads at boot and threads
through into save-state compatibility checks (`checkSaveStateCompatibility`
in `src/SaveState.js`).

## How this repo integrates it

The build artifact is a standard execution-worker-contract module (ES
`MODULARIZE`, adjacent `.js`/`.wasm`/`.worker.js`, shared Wasm memory,
growable indirect function table, `FS`/`callMain`/`addFunction`/
`removeFunction` exported) — the same shape `src/runtime/
EmulatorWorkerRuntime.js` already expects for any worker-mode core, so no
PSX-specific worker code was needed. What PSX-specific integration exists:

- `src/systems.js` — `CORES.mednafen_psx_hw` registers the core with
  `execution: 'worker'`, `requiresThreads: true`, `contentIo:
  'transfer-memfs'`, `multiFile: true`, `companionExtensions: ['bin', 'img',
  'iso', 'sub', 'sbi']`, `firmwareProfile: 'psx'`. `SYSTEMS.psx` registers
  the system. Because `.cue`/`.chd`/`.exe` collide with the existing `play`
  (PS2) and `virtualxt` (DOS) cores at the filename-extension level, the
  default resolution for those three extensions favors the existing cores
  (see `AMBIGUOUS_EXT_DEFAULT` in `systems.js`); reaching PSX for those
  extensions requires an explicit `?core=mednafen_psx_hw` override (or,
  from the file picker, selecting a `.m3u`, which isn't ambiguous).
- `src/FirmwareStore.js` — validates and stores a user-imported BIOS
  (SCPH-5500/5501/5502) in IndexedDB; never fetches or ships one. Wired
  into `main.js`'s "Import BIOS" button and threaded into `client.start()`
  as `opts.firmware` whenever `coreInfo.firmwareProfile` is set.
- `src/SaveRamStore.js` — native SaveRAM (memory card), separate from
  save-state snapshots, keyed by core ID + content hash + slot with a
  rolling backup history. `main.js` restores it into the SAME `start()`
  call that boots the disc (`opts.restoredSaves`) and flushes it
  periodically + on `pagehide` (`flushCurrentSaveRam` in `main.js`).
- `src/ContentBundle.js` / `src/DiscControl.js` — multi-file CUE/M3U
  resolution (with recursive companion validation and a stable
  content-hash `contentId`) and the eject/select/insert RPC bridge.
- `src/RuntimeEmulatorClient.js` + `src/runtime/*` — the worker-execution
  facade every worker-mode core (currently only PSX) goes through; every
  other core keeps using `EmulatorClient.js` main-thread, unchanged.

## Verification

- `npm run test:psx-foundations` / `npm run test:runtime` — unit tests for
  the bundle/firmware/SaveRAM/registry logic above (no browser, no core
  binary required).
- `npm run probe:psx-core` — real browser (Puppeteer) boot of a legal,
  CC0 PS-X EXE smoke-test binary (`scripts/cores/psx/test-content/
  psx-jit-smoke.exe`) through the actual compiled core artifact. Requires
  the built artifact to already be in `public/cores/` (see above).
- `npm run probe:psx-testdisc` — the one that proves real PSX **content**
  runs: it boots the repo's authored CC0 CD image (`games/psx-testdisc`) and
  asserts our own HUD text and clear colour are on the canvas plus a
  memory-card save round trip. See `docs/PSX_TESTDISC.md`.

**Correction to the earlier "PASSED (2026-07-21)" claim on this page.** That
run reported `psxJitCompiledBlocks: 95`, non-blank frames and forwarded audio
— all of which were true, but none of which came from the smoke executable.
Established 2026-07-26 (save-state VRAM dump + screenshot): **the bare PS-X EXE
path does not execute the payload in this build at all.** Beetle's `LoadEXE()`
hands the executable to the BIOS by patching `BIOSROM` at offset `0x6990`, an
address that only means anything in a retail Sony BIOS. This repo ships no
BIOS, so the core falls back to its bundled PCSX-Redux OpenBIOS, the patch
lands on unrelated code, and OpenBIOS runs its own built-in shell demo — a
rotating single-colour cube on a colour-cycling background. The "rendered
frames" in that pass were that demo, and the JIT counters were it being
executed. `probe:psx-core` is therefore now scoped honestly to "the core
artifact loads and stays alive end-to-end"; its strict JIT assertion is behind
`PSX_REQUIRE_JIT=1` (see the next bullet) and real content coverage moved to
`probe:psx-testdisc`.

Two core-artifact defects were found on 2026-07-26 while getting real content
to render, both currently worked around from `src/RetroArchConfig.js` rather
than fixed (fixing them means rebuilding the core):

- **Lightrec segfaults on real content.** `[Lightrec]: Segmentation fault in
  recompiled code: invalid load/store at address PC 0x5ffffcfc`, in a block at
  `PC 0x000036f8` (BIOS kernel RAM, during the CD exec/load path), ~2 s into a
  real disc boot; the core then stops presenting frames. `execute`, `execute` +
  `dynarec_invalidate = dma`, and `run_interpreter` (Lightrec's own
  interpreter, no Wasm codegen at all) all fail identically — so the fault is
  in Lightrec's shared memory-map / block-invalidation path, **not** in the
  `Jitter_CodeGen_Wasm` backend. `beetle_psx_cpu_dynarec` is pinned to
  `"disabled"` (Beetle's own CPU interpreter), which works. Until this is
  fixed, the JIT that is the entire point of this core build is not in use.
- **The OpenGL renderer presents only background fills** in this project's
  worker/`OffscreenCanvas` GL context: polygons, sprites and text never reach
  the canvas, while the parallel software framebuffer (`renderer_software_fb`,
  default enabled) shows the frames rendering correctly. `beetle_psx_renderer`
  is pinned to `"software"`.

## Known gap vs. `docs/research/psx-n64-feasibility.md`

That doc (uncommitted, in-progress research authored separately from this
integration) concludes PSX/N64 should be skipped because no Wasm-JIT
backend exists for Lightrec and building one would be a months-long,
nobody-has-done-this effort. This integration is exactly that effort,
already done, by adapting Lightrec to the existing, proven
`Jitter_CodeGen_Wasm` backend (the same one this project's own PS2 core
already ships) rather than writing a new native-code-generation backend
from scratch. That research doc has not been edited as part of this work
(it wasn't authored by this integration and may reflect research done
concurrently by someone else) — flagging the discrepancy here so whoever
next reads that doc knows to reconcile it against this one.

## Remaining work

- **Re-enable the JIT and the OpenGL renderer.** Both are switched off in
  `src/RetroArchConfig.js` because of the two core-artifact defects described
  under "Verification" above; each is a one-line revert plus a rebuild of
  `kblood/psx-wasm-jit-libretro`. The 2026-07-25 "content-independent colour
  sequence" gap previously listed here is **resolved** — it was an unbootable
  disc (non-Sony-serial `BOOT=` name) plus the OpenGL renderer defect, not a
  PSn00bSDK/`crt0` problem; full writeup in `docs/PSX_TESTDISC.md`.
- **Raw PS-X EXE loading does not work without a retail BIOS** (`LoadEXE()`'s
  `0x6990` patch, above). If bare-`.exe` support matters, it needs an
  OpenBIOS-aware load path in the core.
- Beta-scope items from the upstream repo's own plan (Quest-performance
  gating, full native R3000A opcode coverage beyond the current
  integer/control-flow tier, `.m3u` multi-disc in-VR swap UX, long-session
  soak testing) are tracked there, not duplicated here.
- Multi-file OPFS re-caching and shelf-cartridge persistence for
  bundle-based (CUE+BIN) local picks are not implemented in this repo yet —
  a picked CUE+BIN set boots and plays but won't survive a page reload as a
  re-insertable shelf cartridge the way single-file main-thread cores do
  (see the comment above the `romInput` handler in `src/main.js`).
- Live `.cue`/`.chd` byte-level disc sniffing (to resolve the PS2/PSX
  extension collision automatically instead of via `?core=` override) isn't
  implemented — `src/DiscIdentity.js` exists but can't parse compressed CHD
  hunks or a CUE sheet's referenced BIN bytes without more infrastructure
  than currently exists here.
