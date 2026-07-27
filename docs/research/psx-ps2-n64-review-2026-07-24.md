# PSX/PS2/N64 core work — Opus review + improvement/test plan (2026-07-24)

Produced by an Opus 5 subagent (Plan mode, read-only) reviewing the actual
diffs (not just doc claims) on `main`/`n64-jit-plan`. Kept verbatim except
for this header — see git blame / session log for provenance.

## Status (updated 2026-07-25, third pass)

**Phase A is done AND merged+pushed.** Commit `528910c` (plus the
doc-update commit `b0b3463`) — fast-forward-merged into `main` and pushed
to `origin/main` on 2026-07-25 at the user's explicit request. `main`/
`origin/main` are currently at `b0b3463`. Independently re-verified (not
just trusting the implementing subagent's own report): `git show` on the
actual diff for every item below, plus a fresh `npm test` (green) and `npm
run probe:lightgun` (9/9) run directly.

- **A1 (the critical fix) — done.** `src/RuntimeEmulatorClient.js` now
  forwards `sendLightgun`/`sendMouse`; these were the only two gaps against
  `EmulatorClient`'s actual prototype. `scripts/test-runtime-facade.mjs`
  (new) asserts prototype parity going forward and is wired into `npm test`.
- **A2 — done.** `scripts/probe-lightgun-regression.mjs` (`npm run
  probe:lightgun`) boots the real app and fires a real gun through
  `games/nes-gallery`. Proven to actually guard the bug: it was run against
  a reverted A1 fix and failed with the exact P0-1 `TypeError`, then passed
  once restored.
- **A3 — done.** `docs/HANDOFF.md`'s branch-topology note and PSX/PS2/N64
  status section were corrected (see Part 0 below — they're no longer
  stale). The false `DiscIdentity`-wiring comments in `systems.js` and
  `test/psx-foundations.test.js` are fixed to describe reality (still dead
  code, just no longer mis-documented). The BIOS-import comment in
  `main.js` was fixed to match `FirmwareStore.import()`'s actual
  throw-on-unrecognized behavior — **docs-only, the reject behavior itself
  is untouched, deliberately left for Phase C3.**
- **A4 — done, via new infrastructure.** No prior mechanism existed for
  hiding a system, so a small generic `experimental: true` flag was added
  to `SYSTEMS`/`CORES` (`systems.js`), enforced in exactly one place
  (`Collection.js`'s `parseCollection`/`loadCollection`), gated on
  `?experimental=1` (`main.js`, following the existing `urlParams`
  convention). Applied to `mednafen_psx_hw`/`mupen64plus_next` — both are
  now hidden from the default shelf/manifest (including the two N64
  cartridges in `public/roms/manifest.json`) until Phase B lands, but
  remain testable with the query param. This flag is now available
  infrastructure for anything else that needs staged rollout.
- **A5 — done.** `scripts/fetch-cores.mjs` now knows about
  `play`/`mednafen_psx_jit`/`mupen64plus_next` (custom WSL builds, not on
  the buildbot) and hard-errors — breaking `npm run deploy` — if any are
  missing from `public/cores/`, rather than silently shipping 404 core
  URLs. The hardcoded fallback to the old archived sibling checkout is
  gone.

**Phase B is also done.** Commit `7455531` on `n64-jit-plan`, stacked
directly on `main`'s tip (`b0b3463`) — **committed but NOT pushed/merged**,
awaiting separate authorization. Independently re-verified: `npm test`
green, plus direct re-runs of the two new probes (not just trusting the
report) — `npm run probe:mode-switch` 11/11 and `npm run
probe:worker-cartridge-insert` 12/12, both passing cleanly.

- **B1 — done.** A shared `buildStartOptions()` helper in `main.js` now
  threads `execution`/`firmware`/`restoredSaves` through every boot path
  (`loadCartridge`, `pickLocalRom`, the file-input handler, `spawnConsole`,
  `swapConsoleCore`), and `ConsoleRuntime.load()` forwards the same for
  secondary/rack consoles.
- **B2 — done, via live-swap (approach a).** `RuntimeEmulatorClient` throws
  a structured `RuntimeModeSwitchError` (was a bare, silent dead end);
  `bootOnPrimary()` in `main.js` reuses the existing
  `bootFreshRuntime`/`rebindPrimaryClient` live-reboot mechanism (already
  proven for gun/mouse arm-reboots) to give a cross-mode boot a clean fresh
  client instead of ever mutating a live delegate's mode in place.
  **Independently confirmed: NES → PSX → NES on one page, no dead end, no
  error, both directions.**
- **B3 — done, with a real bug caught mid-implementation.** Worker
  `'audio'` events now reach `SpatialAudio.pushSamples` via a new
  `ensureBranch()`, wired from both `ConsoleRuntime.load()` **and**
  `bootOnPrimary`'s direct-start branch — the second wiring point only
  exists because the implementing agent's own audio probe caught that the
  primary console's first-ever worker-core boot bypasses
  `ConsoleRuntime.load()` entirely and would otherwise have stayed silent
  despite "B3 done" looking complete from the `ConsoleRuntime` change
  alone. Good example of why every phase in this doc insists on a real
  probe, not just a code read.
- **B4 — partially done.** `autosave_interval = "10"` added to
  `RetroArchConfig.js` (config-only fix, as this doc's Phase B section
  preferred over a core rebuild). `flushSaveRam`/`readSaveRam` confirmed to
  do live (non-aliased) reads. **But end-to-end persistence is still
  unconfirmed**: the shipped N64 EEPROM test ROM (`lwx-n64-scene.z64`)
  never produced saveram bytes in testing, most likely because
  `mupen64plus_next`'s save-type detection is CRC/game-database-driven and
  doesn't recognize a from-scratch homebrew ROM — i.e. `SAVE_RAM` size is
  probably reporting 0, so there's nothing for autosave to persist. This
  is a plausible **content/core-detection gap, not proof the config fix is
  wrong** — needs either forcing a save type or content with a
  core-recognized one to actually settle. Left open, informational only in
  `scripts/probe-worker-audio-saveram.mjs`.
- **B5 — done.** `EmulatorWorkerRuntime.setPaused` now prefers
  `Module.pauseMainLoop()`/`resumeMainLoop()` (falls back to `_cmd_pause()`
  only if absent), matching the main-thread client; the frame pump now
  actually checks `paused` before producing/transferring frames.
- **B6 — done, defensively.** `FrameBridge`'s frame-request function is now
  injectable (for testability — it was already correctly picking up
  `XRRafShim`'s monkeypatch before this change, so this wasn't fixing an
  observed live bug, just making the assumption testable). A 500ms
  `FRAME_ACK` stall watchdog now clears `framePending` and counts
  `staleFrameAcks` if an ack never arrives, so a temporarily-stalled page
  can't starve the worker forever.

**New permanent regression probes**, all independently re-run and passing:
`npm run probe:mode-switch` (T-X4, the P0-3 guard), `npm run
probe:worker-cartridge-insert` (T-X5, the P0-2 guard — boots BOTH
`mednafen_psx_hw` and `mupen64plus_next` through the literal
`GrabMgr`/`handleCartridgeInserted` real-insert callback, not a bypass
harness), and `npm run probe:worker-audio-saveram` (opportunistic B3/B4
coverage, B4 half informational per above).

**Still open after Phase A + B:** P1-8 ("new tests aren't in `npm test`")
remains only partially addressed (the Phase A/B probes are separate `npm
run` scripts, not folded into the main `npm test` chain — by design, since
they need a live dev server + Puppeteer, unlike the pure-logic `npm test`
suite). B4's SaveRAM persistence needs the content/detection gap above
resolved before it can be called done. **Everything in Phase C (PSX
content pipeline: streaming/OOM, disc-classifier wiring, BIOS-import
fix, multi-file shelf persistence, PS2 `.cue`) and Phase D (N64 JIT
COP0/interrupt verification before `ci_table`) is still unstarted.**

**T-PSX-2 (real PSX CD-ROM test content) landed, but surfaced a new,
significant, unresolved finding: PSX Tier 1 (real content actually
rendering) is NOT verified.** Commit `7e801c4` on `n64-jit-plan` (stacked
on Phase B, also unpushed) adds `games/psx-testdisc/` — the first real
PSn00bSDK-built PSX title in this repo (a CC0 GTE cube + HUD + low-level
BIOS memory-card save/load), built via the `luksamuk/psxtoolchain` Docker
image and a genuine `mkpsxiso` CUE+BIN. I independently read the full
writeup (`docs/PSX_TESTDISC.md`) and the `docs/PSX_CORE_BUILD.md` diff —
both check out; the isolation methodology is sound and the conclusion is
appropriately hedged, not overclaimed.

The disc **does** boot cleanly through the app's real disc-loading path
(`probe:psx-testdisc`: no track/file/fatal errors, continuous native
Lightrec JIT compilation, PCM audio, non-blank frames at 3 checkpoints)
— but while trying to capture a screenshot as visual proof, every
checkpoint showed only a flat two-color background cycle
(`(0,66,90)`/`(58,16,0)`, content-independent, ~5s period), with no cube,
HUD text, or any of several unmistakable debug markers ever appearing.
Eight independent isolation builds were tested (full game; minimal
VSync/DrawSync background-cycle; +moving tile; `DrawPrim`-only with no
VSync at all; raw GP0/GP1 MMIO pokes via the normal PSn00bSDK
toolchain/`crt0`; division-free; patched stack-pointer header) across both
CD-boot and raw-`.exe` loading — **all seven PSn00bSDK-toolchain-built
variants produced the byte-identical, content-independent two-color
sequence at the same frame counts.** Only the pre-existing bare
hand-assembled MIPS smoke `.exe` (`generate-smoke-exe.js`, which pokes
GP0/GP1 directly and never links against PSn00bSDK's `crt0`/library at
all) renders correctly.

This points at a real gap between "a normally-linked PSn00bSDK
executable's BIOS handoff/`crt0` startup" and "this project's PSX
worker-runtime video-output path reflecting subsequent CPU execution" —
**not** a bug in the test disc's content, CD image structure, or build
toolchain. Exact mechanism not conclusively identified (candidates:
`GPREL`/initial-`$gp` setup, an entry-point-vs-load-address header gap, or
a genuine worker-runtime canvas/video-blit bug) — root-causing it means
editing `src/runtime/*`/`src/RuntimeEmulatorClient.js`/
`src/RetroArchConfig.js`, deliberately left out of scope for the testdisc
agent (a separate concurrent session was already working in related
worker-runtime files this session).

**Consequence: `docs/PSX_CORE_BUILD.md`'s existing "PASSED (2026-07-21)"
claim is still true on its own narrow terms (the hand-assembled smoke
exe's raw MMIO writes do reach the screen) but does NOT generalize to any
real-world PSX game** (which would all be normally-linked, not
hand-assembled bypass code). Tier 2 (visible spinning cube) and Tier 3
(memory-card round-trip — `readSaveRam(1)` returned `null` in every run)
are consequently also unverified. This was the single most important open
item for PSX, ahead of the rest of Phase C — see the fourth-pass update
below for where the fix effort landed.

## Status update (2026-07-26, fourth pass): PS2 confirmed clean, N64 has its own real color-fill finding

The user set a standing goal (see memory `three-cores-playable-goal.md`)
to keep looping plan→implement→verify until PSX/PS2/N64 are all
genuinely confirmed playing real games, using the Codex CLI (`codex exec
review`) as an independent reviewer at each checkpoint alongside my own
re-verification. Three parallel investigations were run this pass:

- **PS2: confirmed still working, no regression.** A new committed probe
  (`scripts/probe-ps2-guncon-regression.mjs`, `npm run probe:ps2-guncon`)
  boots `games/ps2-guncon-range` through the real `window.__pickLocalRom`
  path and fires the GunCon2 through the real `LightGunMgr.tick()` →
  `sendLightgun()` chain — 15/15 passing, with a real screenshot showing
  the game's actual orange target box rendering on the TV (visually
  confirmed, not just a pixel-count heuristic). `codex exec review`
  caught two real issues in the first draft (a stray `package.json` line
  from a concurrent agent's uncommitted work, and a whole-page 1%
  non-black threshold that app chrome alone would satisfy regardless of
  whether PS2 rendered anything) — both fixed and re-verified
  (commit `c57ef69`). PS2 remains the one core with zero open rendering
  issues.
- **N64: a real, distinct rendering bug found — geometry/rotation/audio
  all correct, but face colors never appear.** A new committed probe
  (`scripts/probe-n64-scene-render.mjs`, `npm run probe:n64-scene-render`)
  boots `lwx-n64-scene.z64` through the real `GrabMgr`/
  `handleCartridgeInserted` cartridge-insert path. Frame pump (0 stale
  `FRAME_ACK`s, ~260-350 frames over ~9.3s, 0 core errors), worker audio
  (`SpatialAudio` branch advancing), and the CPU side (N64_JIT_SHADOW
  checked=31/matched=31/mismatched=0) are all healthy and unaffected by
  the Phase A/B facade changes. But a direct pixel histogram of the
  cube's own bounding box, across three timed captures, never finds any
  of its six assigned flat face colors (red/green/blue/yellow/magenta/
  cyan) — only the scene's `(8,8,16)` background color and antialiasing
  gradients toward black. The cube renders as a correctly-shaped,
  reproducibly non-black-silhouetted, solid **black** fill instead of
  colored faces. (I independently re-ran the probe and visually confirmed
  this from the saved `tmp/n64-scene-t1.png`/`t3.png` screenshots — a
  clear cube silhouette, uniformly black.) Full detail:
  memory `n64-color-fill-regression.md`. This is judged (by the
  investigating agent, not yet independently root-caused) as a likely
  pre-existing limitation in `mupen64plus_next`'s HLE graphics-plugin
  handling of this ROM's low-level `rdp_set_primitive_color` fill path —
  not something the Phase A/B JS-side facade changes could have caused,
  since none of them touch pixel/color output. `codex exec review` on
  this commit (`ef71ff7`) found two probe-quality issues (a metrics-null
  false-positive risk, and a Windows dev-server cleanup bug that could
  leak a `node` process holding the port for the next run) — both fixed
  and re-verified, including confirming via `netstat` that the port is
  actually released after the fixed cleanup (commit `84570f6`).

**Net effect at the time: two of three cores had a real, confirmed,
independently-verified rendering gap blocking "plays games" — PSX (no
authored content visibly renders at all) and N64 (geometry renders,
color does not). PS2 was the only core with no open item.** Both gaps
were fixed within the same session — see the fifth-pass update below.

## Status update (2026-07-26, fifth pass): N64 color-fill FIXED, PSX rendering gap FIXED — all three cores now confirmed genuinely playing real content

**N64 (commit `cb060b9`).** Root-caused for real (not just the
GFX-plugin-limitation guess from the fourth pass): `GLideN64/src/gDP.cpp`'s
`LLETriangle::draw()` only wrote vertex colors inside an `if (_shade)`
branch, so a non-shaded low-level RDP fill-mode triangle (exactly what
libdragon's pre-`rdpq` `rdp_draw_filled_triangle()` emits) reached the
drawer with color fields never written — deterministically black. Fixed
by seeding those vertices from `gDPGetFillColor()` in `G_CYC_FILL` mode
(matching what `gDPFillRectangle()` already did for rectangles — the
game's background rect rendered its correct color the whole time, which
was the actual tell). One-file patch
(`scripts/cores/n64/gliden64-fill-mode-lle-triangle-color.patch`), core
rebuilt. Verified before→after: `probe:n64-scene-render` 16/18→18/18,
`0/65000`→`32571/65000` bright face pixels in the cube's bounding box,
screenshots flip from a uniformly black cube to genuinely colored,
rotating faces. I independently re-ran the probe, `npm test`, and
`probe:worker-cartridge-insert` myself and viewed the screenshots
directly; `codex exec review --commit cb060b9` found no issues.

**PSX (commit `45271e9`).** Two stacked bugs, not the single
"crt0/BIOS-handoff gap" hypothesized in the third pass:
1. `games/psx-testdisc/system.cnf`'s `BOOT=cdrom:\PSXTEST.EXE;1` isn't a
   valid Sony-format disc serial, so Beetle never recognized the disc as
   licensed and its embedded OpenBIOS fell through to its own built-in
   shell demo — whose slow color-cycle was exactly the
   "content-independent two-color sequence" the third pass's 8-payload
   isolation matrix recorded (8 photos of the same BIOS demo, not 8
   photos of our game). Fixed by renaming the boot executable to a
   valid-looking serial (`SLUS_000.01`) — no game code changed.
2. Even after the disc booted, Beetle's OpenGL hardware renderer only
   ever presented the background fill in this project's worker/
   OffscreenCanvas GL context, though a GPURAM save-state dump proved the
   hardware renderer's own buffers held the correct cube+HUD the whole
   time. Worked around (not fixed) by pinning `beetle_psx_renderer` to
   `"software"`.

   A third bug was found on the way: Lightrec (the JIT) segfaults on real
   content ~2s into a boot, reproducing identically under the Wasm
   codegen, DMA-invalidate mode, AND Lightrec's own plain interpreter —
   the bug is in Lightrec's shared memory-map/block-invalidation path,
   not the `Jitter_CodeGen_Wasm` backend. Worked around (not fixed) by
   pinning `beetle_psx_cpu_dynarec` to `"disabled"`.

   Also fixed as a drive-by, affecting ALL worker cores (PSX and N64):
   RetroArch 1.22's `sort_savefiles_enable`/`sort_savestates_enable`
   default to `true` and redirect saves into a per-core subdirectory this
   project's path builder didn't know about, breaking
   `readSaveRam()`/`serializeState()` everywhere. All four `sort_save*`
   options now off.

   Verified: `probe:psx-testdisc` PASSED (real HUD text + a lit cube on
   screen, save-block round-trip surviving a soft reset — screenshot
   `tmp/psx-testdisc-final.png`). I independently re-ran the probe myself
   (one transient failure on the first attempt that passed cleanly on
   retry — resource contention, not a regression, same pattern as
   [[ps2-glctx-crash-not-reproducible]]/`docs/PS2_CORE_BUILD.md`), viewed
   the screenshot directly, re-ran `npm test`/`probe:mode-switch`/
   `probe:worker-cartridge-insert`/`probe:lightgun` (all green), and got a
   clean `codex exec review --commit 45271e9` (which went as far as
   inspecting the built `.wasm` binary to confirm the new RetroArch option
   strings are real, not typos).

**Net effect: all three cores (PS2, N64, PSX) are now independently
confirmed genuinely rendering real authored content end-to-end through
the real app flow, closing the core "plays games" bar this whole review
was chasing.** Two real, open follow-up items remain for PSX specifically
— it currently runs on CPU interpretation + software rendering rather
than its intended Wasm-JIT + hardware-GL architecture:
- Restore the Lightrec JIT (root-cause + fix the memory-map/
  block-invalidation segfault, then re-enable `beetle_psx_cpu_dynarec`).
- Restore the hardware GL renderer (root-cause why this project's worker/
  OffscreenCanvas GL context doesn't present Beetle's hardware-renderer
  output even though the renderer itself draws correctly, then re-enable
  `beetle_psx_renderer=hardware`).

Neither is measured for real-world performance impact yet (no fps
baseline was captured for the interpreter+software configuration). Phase
C (PSX content pipeline: streaming/OOM, disc-classifier wiring, BIOS-import
fix, multi-file shelf persistence) and PS2's `.cue` support remain
separately open, lower-priority now that the rendering bar is met for all
three cores.

## Part 0 — Premise corrections (read first)

| Assumed | Reality |
|---|---|
| PSX + N64 are unmerged, only on `n64-jit-plan` | **Already merged to `main` and pushed** (fast-forward at `7d9e0c9`). `n64-jit-plan` is only 1 commit ahead (the PS2 GLctx doc closure). |
| `src/CoreRegistry.js` exists | Never existed — no file, no references. |
| N64 JIT shadow harness is a clean 19/19 | True for the smoke ROM, but the **uncommitted** `scripts/cores/n64-jit-spike/vr4300_jit_bridge.cpp` diff says it was "added specifically to investigate the first real mismatches this harness ever found (n64-systemtest ROM)" — mismatches exist and are undocumented. |

**Consequence: everything in Part 1 below is live on `main`/pushed, not quarantined on a branch.**

## Part 1 — Code review findings

### P0 — live regressions / blockers on `main`

- **P0-1 — ✅ FIXED (2026-07-25, commit `528910c`, not yet pushed).** All
  light-gun and mouse support was broken: `RuntimeEmulatorClient`
  (the facade that replaced `EmulatorClient` app-wide) never forwarded
  `sendLightgun`/`sendMouse`. Every gun/mouse call site
  (`LightGunMgr.js:126/132`, `MouseMgr.js:112/154`, `main.js:1481/1486/2483`)
  threw. Blast radius: NES Zapper, SNES Scope/Justifier, SMS Light
  Phaser, PS2 GunCon2, SNES/C64/Amiga/DOS mouse — effectively the app's
  flagship feature set. Missed by CI because all existing gun/mouse tests
  stub the client. Now has a real-app regression guard
  (`npm run probe:lightgun`) that fails loudly if this recurs. **Still
  needs a headset re-validation pass (H-7 below) and a `git push` before
  the live deploy is actually fixed** — the deployed build is still
  broken until then.
- **P0-2 — ✅ FIXED (2026-07-25, `7455531`, not pushed).** Worker cores
  were unreachable from the real in-VR cartridge path — `execution:'worker'`
  was only threaded through the desktop file-picker (`main.js:5892`), not
  `loadCartridge` (`:5225`) or `pickLocalRom` (`:2693`). Independently
  re-verified: both `mednafen_psx_hw` and `mupen64plus_next` now boot
  correctly through the literal `GrabMgr`/`handleCartridgeInserted` insert
  callback (`npm run probe:worker-cartridge-insert`, 12/12).
- **P0-3 — ✅ FIXED (2026-07-25, `7455531`).** The one-way runtime mode
  lock (switching main-thread↔worker threw a permanent dead end) is fixed
  via a live-swap approach reusing the existing arm-reboot mechanism.
  Independently re-verified: NES → PSX → NES on one page, no dead end,
  either direction (`npm run probe:mode-switch`, 11/11).
- **P0-4 — ✅ FIXED (2026-07-25, `7455531`).** Worker cores had no audio in
  the app (`SpatialAudio.pushSamples` had zero callers). Now wired via
  `ensureBranch()` from both `ConsoleRuntime.load()` and the primary
  console's direct-start path (the latter only found because the
  implementing agent's own probe caught it as a second, separate gap).
- **P0-5 — ⚠️ PARTIAL (2026-07-25, `7455531`).** `autosave_interval` added
  to `RetroArchConfig.js`; `flushSaveRam`/`readSaveRam` confirmed to do
  live reads. But end-to-end persistence is still unconfirmed — testing
  against the shipped N64 EEPROM ROM produced no saveram bytes, likely
  because `mupen64plus_next`'s CRC/database-driven save-type detection
  doesn't recognize a from-scratch homebrew ROM. Needs real
  content with a recognized save type (or forcing one) to settle.
- **P0-6 — Real disc images will OOM.** Content is copied in full three
  times before a core even starts (`ContentBundle.computeContentId` hash,
  `WorkerEmulatorClient.prepareLaunchPayload` slice, MEMFS `writeFile`) — a
  700MB CUE+BIN needs ~2.1GB peak; a multi-disc M3U is impossible. This is
  an architectural blocker, not a test gap.

### P1 — correctness / consistency (see agent output for full file:line detail)

BIOS import rejects nearly every real BIOS — **comment now fixed to match
this (2026-07-25); the reject behavior itself is still open, tracked as
C3**. `DiscIdentity.js` disc classifier is dead code — **the doc comments
falsely claiming it's wired are fixed (2026-07-25); it's still genuinely
dead code, tracked as C2.** `DiscControl.js` is dead/duplicated vs. the
worker's inline copy (open, C6); duplicate `'error'` dispatch in
`WorkerEmulatorClient.js:188-189` (open); worker pause not stopping the
frame pump / breaking `RackBudget` auto-pause — **fixed 2026-07-25 (B5)**;
`FrameBridge`'s frame-request path made injectable/testable — **fixed
2026-07-25 (B6), defensively** (it was already correctly picking up
`XRRafShim`'s monkeypatch before this change, so this wasn't confirmed as
a live bug, just hardened); fixed 16ms frame pacing still ignores real
core refresh rate (open, no B-item covers this specifically); `test:psx-foundations`/`test:runtime` still
aren't wired into `npm test` (open — only the new facade test was, see
Status above). **`fetch-cores.mjs` not knowing about the three custom
cores, and its hardcoded sibling-checkout path — both fixed 2026-07-25
(A5).** Still open: PS2 `DiscImageDevice.read` silently short-writes on
out-of-range reads instead of throwing; PSX CUE+BIN can never become a
re-insertable shelf cartridge; PS2 `.cue` is rejected outright (no
`multiFile`); a standard gamepad unconditionally hijacks P1 regardless of
Patchbay routing.

## Part 2 — Prioritized improvement plan

**Phase A — stop the bleeding on `main` — ✅ DONE 2026-07-25 (commit
`528910c`, not pushed — see Status at the top of this doc):**
A1 restore `sendLightgun`/`sendMouse` forwarding + a facade-parity test;
A2 add a real-app light-gun/mouse regression probe; A3 correct
`docs/HANDOFF.md` and the false `DiscIdentity`-wiring comments; A4 gate
`mednafen_psx_hw`/`mupen64plus_next` behind `?experimental=1` until B/C
land; A5 add the three cores to `fetch-cores.mjs`, remove the hardcoded
sibling-checkout path.

**Phase B — make worker cores actually usable — ✅ DONE 2026-07-25 (commit
`7455531`, not pushed — see Status at the top of this doc; B4 partial):**
B1 thread `execution`/`firmware`/`restoredSaves` through every boot path
(extract one `buildStartOptions` helper); B2 handle the mode switch
(teardown + reconstruct, or an explicit reload prompt) instead of a dead
end; B3 wire worker audio to `SpatialAudio.pushSamples`; B4 make SaveRAM
real (`autosave_interval` or an explicit flush export, not an alias for
read); B5 fix pause to actually stop the frame pump; B6 route
`FrameBridge` through `XRRafShim` + add a stalled-`FRAME_ACK` watchdog.

**Phase C — PSX content pipeline (the real blocker):**
C1 streaming content (hash paths+sizes+sampled prefix, not full bytes;
transfer large tracks as `Blob` handles, not copied `ArrayBuffer`s); C2
wire `DiscIdentity` for real (with an explicit prompt when it can't
classify, e.g. `.chd`); C3 fix BIOS import (import-with-warning +
missing MD5s + region-aware `getPreferred`); C4 multi-file shelf
persistence so a CUE+BIN can be a re-insertable cartridge; C5 PS2 `.cue`
support (key `discImageDevice` by path); C6 delete `DiscControl.js`
duplication, build the actual disc-swap UI.

**Phase D — N64 JIT, before any `ci_table` wiring:**
D1 commit + document the n64-systemtest mismatches found by the
uncommitted harness diff; D2 root-cause each mismatch class; D3
behavior-verify COP0/interrupt accounting against ≥10⁴ checked blocks
before touching `ci_table`; D4 only then wire it in, behind the existing
flag, harness still compiled in.

## Part 3 — Testing plan

**Structural fix first (T-0):** every existing PSX/N64 probe drives
`WorkerEmulatorClient` directly through a private test harness page,
bypassing `main.js` entirely — this is *why* P0-1 through P0-5 all
shipped unnoticed. Add an app-level probe tier that boots the real dev
server + `index.html` + `main.js` (generalizing the `tmp/verify-ps2-*`
pattern), alongside the existing core-artifact-focused probes. Also wire
`test:psx-foundations`/`test:runtime` into `npm test`.

**Cross-cutting headless probes:** facade parity (unit test, no browser);
real-app light-gun/mouse regression (T-X2/T-X3, the P0-1 guard); mode-switch
handling (T-X4, the P0-3 guard); cartridge-insert parity for every
worker-execution core (T-X5, the P0-2 guard); post-build deploy
completeness check that every registered core URL resolves to a real
file (T-X6, the P1-9 guard); prod-CSP boot smoke (T-X7).

**PSX (10 scenarios, T-PSX-1..10):** highest-value missing piece is
**`games/psx-testdisc`** — an authored CC0 PSn00bSDK homebrew as a real
CUE+BIN (moving 3D shape + memory-card write/read), following the
`games/n64-scene` pattern; nothing today exercises CD-ROM/BIOS/
memory-card paths. Built on top of that: real disc boot + OOM budget
assert, audio-reaches-graph, memory-card round-trip through IndexedDB +
reload, save-state round-trip across the worker boundary, save-state
build-hash compatibility gate, a BIOS-import matrix (valid/legacy/
garbage/missing), M3U multi-disc, and a clean-error assert for a `.cue`
missing its `.bin`.

**N64 (7 scenarios, T-N64-1..7):** keep the existing core/fps probes as
baseline gates; add a real-app cartridge-insert test (expected to fail
until P0-2 is fixed); a 60s audio-HLE regression gate (there's a known,
partially-fixed AI DMA crash history); EEPROM persistence across reload;
promote the interrupt-shadow-diff script to a real `npm run` target
gated at `mismatched=0` over ≥10⁴ blocks (the actual `ci_table` blocker);
author `games/n64-interrupts` (libdragon) as a CC0, in-repo,
interrupt-firing exerciser rather than relying on the third-party
n64-systemtest ROM alone; and a byte-identity check that a default
(`WITH_N64_JIT` off) build is unaffected.

**PS2 (5 scenarios, T-PS2-1..5):** promote the existing
`tmp/verify-ps2-*.mjs` scripts out of gitignored `tmp/` into `scripts/`
with real `npm run` entries (**the PS2 verification suite currently
isn't in the repo at all**); `.cue` multi-file boot (post-C5) / clean
rejection (pre-C5); disc-classifier wiring once C2 lands, extending the
existing synthetic-ISO9660 builder; a `DiscImageDevice` bounds-check
unit test; and a long-run CHD boot-loop probe to catch any recurrence of
the (currently closed, non-reproducible) GLctx crash with the new
`e.stack` logging.

**Requires a physical Quest 3 (8 items, H-1..8), cannot be faked
headlessly:** N64 fps on real hardware (the open gap already flagged in
HANDOFF); PSX fps + real JIT-compile cost on mobile V8; the
`FrameBridge`/XR-rAF question (P1-6, only reproducible in a real
`immersive-vr` session); worker + XR thermal/memory over a 15-minute
session; PSX/N64 two-hand controller-mapping ergonomics; PS2 GunCon2
in-headset (extends the existing `HEADSET_LIGHTGUN_VALIDATION.md`
process); a full re-validation pass over every gun/mouse title once
P0-1 is fixed; and a multi-console rack test with a worker core (exercises
`RackBudget` auto-pause, which P1-5 currently breaks).

## Suggested sequencing

1. ~~A1 + A2 + T-X2~~ — **done 2026-07-25.**
2. ~~A3/A4/A5~~ — **done 2026-07-25.**
3. ~~B1–B6~~ — **done 2026-07-25** (`7455531`; B4 partial — see Status).
   `main` was fast-forward-merged to include Phase A (`b0b3463`) and
   pushed 2026-07-25 — **but Phase B (`7455531`) is still local-only on
   `n64-jit-plan`, not yet merged to `main` or pushed.** The live deploy
   has the gun/mouse fix but NOT the worker-core reachability fixes yet.
4. **Next: merge `7455531` to `main` + push**, same fast-forward pattern
   as Phase A. Then redeploy (`npm run deploy`) if the intent is to make
   PSX/N64 actually reachable in the live app (remember they're still
   behind `?experimental=1` from A4 either way).
5. T-0 (generalized app-probe tier) — Phase A/B ended up building THREE
   one-off instances of this pattern (`probe-lightgun-regression.mjs`,
   `probe-mode-switch.mjs`, `probe-worker-cartridge-insert.mjs`) rather
   than one reusable harness. Worth consolidating now, before a fourth
   probe repeats the boilerplate a fourth time.
6. In flight (separate concurrent effort, not yet reviewed as of this
   update): authoring real PSX CD-ROM test content (`games/psx-testdisc/`,
   T-PSX-2) — this doc needs another pass once it lands, to record which
   tier was reached and fold its findings in.
7. C1 (streaming content) — the largest single remaining piece; nothing
   about real PSX discs (as opposed to a small homebrew test disc) is
   trustworthy until it lands.
8. Remaining Phase C items (C2 disc-classifier wiring, C3 BIOS-import fix,
   C4 multi-file shelf persistence, C5 PS2 `.cue`, C6 delete
   `DiscControl.js` duplication) — C4 in particular blocks
   `games/psx-testdisc` (once authored) from being a normal, re-insertable
   shelf cartridge.
9. D1–D3 (N64 JIT COP0/interrupt verification) in parallel with the
   above — but D1 (commit the mismatch finding) is still outstanding and
   increasingly stale; `scripts/cores/n64-jit-spike/vr4300_jit_bridge.cpp`
   was still uncommitted (someone else's in-flight WIP) as of this update.
10. H-1/H-2/H-3 at the first headset session, **plus H-7** (a full
    gun/mouse re-validation pass, now that P0-1 is fixed, and now
    genuinely reachable in-headset once B1/B2 are on `main`) — H-3 may
    invalidate frame-pacing design choices in B6, so don't over-invest
    there first.

## Critical files for implementation

- `src/RuntimeEmulatorClient.js` — P0-1 (missing forwarders), P0-3 (mode
  lock `:38-40`, `stop()` `:54`)
- `src/main.js` — P0-2 (`loadCartridge` `:5225`, `pickLocalRom` `:2693`
  vs. picker `:5892`), P0-4 (no audio subscriber), P0-5
  (`flushCurrentSaveRam` `~:5967`), P1-1 (BIOS comment `:5945`)
- `src/runtime/EmulatorWorkerRuntime.js` — P0-5 (`readSaveRam` `:380`),
  P1-3 (duplicated disc logic `:392-430`), P1-5 (`setPaused` `:385`),
  P1-7 (frame pump `:248`), P0-6 (`hydrateLaunch` `:230`)
- `src/ContentBundle.js` — P0-6 (`computeContentId` `:169-180`,
  `readBytes` `:161`)
- `src/systems.js` — P1-2 (false `DiscIdentity` claims `:606-614`,
  `:636-643`), P1-12 (`play` lacks `multiFile` `:101`), core
  registrations `:130-148`

## Status update (2026-07-26, fifth pass): the N64 color-fill gap is ROOT-CAUSED and FIXED

The fourth-pass N64 finding above ("geometry renders, color does not")
turned out to be a single, concrete, one-function bug in **GLideN64's
low-level RDP triangle path**, not a broad HLE-plugin limitation. It is
now fixed in the core's C++ source, rebuilt, and verified end-to-end.
See `docs/N64_CORE_BUILD.md` ("GLideN64 fill-mode LLE-triangle color
fix") for the full write-up; the short version:

- `GLideN64/src/gDP.cpp`, `LLETriangle::draw()` — its `updateVtx()`
  lambda only assigned `vtx->r/g/b/a` inside an `if (_shade)` branch.
  A **non-shaded** LLE triangle (RDP command `0x08`/`0x09`,
  `gDPTriFill`/`gDPTriFillZ`) therefore reached the drawer with its
  vertex color fields never written at all — undefined behaviour that is
  deterministically zero (black) under wasm.
- That is normally invisible, but is fatal in `G_CYC_FILL`:
  `CombinerInfo::update()` swaps the color combiner for a pure
  "shade only" program in FILL cycle type, so the fragment color **is**
  that never-written vertex shade. Real RDP hardware ignores the combiner
  entirely in FILL mode and writes `SET_FILL_COLOR`, which
  `gDPFillRectangle()` already reproduced for rectangles (via
  `gDP.rectColor` ← `gDPGetFillColor()`) — LLE triangles were simply
  missing the equivalent.
- That asymmetry explains the exact symptom seen: `games/n64-scene`'s
  background *rectangle* (also drawn via `rdp_set_primitive_color` +
  `rdp_draw_filled_rectangle`) came out at the correct `(8,8,16)`, while
  all 12 cube *triangles* came out black. The hypothesis that
  `rdp_set_primitive_color` itself was mishandled was therefore wrong —
  `SET_FILL_COLOR` was decoded fine all along; only the triangle
  consumer of it was missing.
- Fix: seed non-shaded LLE-triangle vertices from `gDPGetFillColor()`
  when `cycleType == G_CYC_FILL` (white otherwise, matching the
  function's own `int r = 0xff, g = 0xff, ...` initialisation intent),
  plus value-initialise the local `SPVertex` array.

**Verification (before/after, same probe, same ROM, real app flow):**

| | baseline core | fixed core |
|---|---|---|
| `probe:n64-scene-render` | 16/18 | **18/18** |
| bbox bright-face-color pixels | `0 / 65000` | `32571 / 65000` |
| brightest bbox pixel | `(8,8,16)` = background | `(49,255,255)` = cyan face |
| whole-canvas frame-to-frame diff | `0.08` / `0.29` | `15.43` / `4.56` |
| `tmp/n64-scene-t1.png` | uniformly black cube | green front + cyan top |
| `tmp/n64-scene-t3.png` | uniformly black cube | red front + cyan top + yellow edge |

No regressions: `npm test` (all suites green),
`npm run probe:worker-cartridge-insert` 12/12 (both PSX and N64),
`npm run probe:mode-switch` 11/11, and `npm run probe:n64-core` PASSED
with the N64_JIT_SHADOW harness still reporting `mismatched=0`.

One probe change was needed as a *consequence* of the fix, not to mask
it: the two motion assertions used a near-black `darkCount` as a
"silhouette area" proxy, which was only meaningful while the cube was
rendering black. With colors restored, `darkCount` is a constant `0`.
Those checks now key off `silhouetteCount` (pixels differing from the
scene's own `(8,8,16)` background), which is correct in both regimes.

**Net effect: N64 is now closed alongside PS2 — geometry, rotation,
audio, frame pump, save/EEPROM API, and now real face color all verified
through the real cartridge-insert path. PSX remains the one core with an
open rendering gap.**

## Status update (2026-07-27): PSX GunCon, PS2 `.cue`, and Phase C's C3 (BIOS import) all closed; C5 done

Since the fifth pass above, all three cores' "plays real commercial games"
bar was independently re-verified (see memory `real-commercial-game-verification.md`
— out of scope for this doc's tracking, a different, narrower claim than
Phase C). Remaining Phase C items have since progressed:

- **C5 (PS2 `.cue` support) — DONE.** Backslash paths, URL-suffix-match
  fragility, and secondary-console swaps all fixed; see memory
  `ps2-cue-secondary-console-fixed.md`. Commits `02babf1`/`d8101bc`/`ec89e16`.
- **PSX GunCon — DONE** (a separate item from this doc's original Phase
  list, added when GunCon support was implemented after this doc's fifth
  pass). Root cause: the core build never applied the `rwebinput`
  light-gun patch every other gun-capable core here needs. Fixed by
  rebuilding `psx-wasm-jit-libretro` with the patch applied; see memory
  `psx-guncon-app-wired-core-gap.md`. Commits `1a1856c`..`cc662d1`.
  `SYSTEMS.psx.lightgun.broken` is now `false`.
- **C3 (BIOS import fix) — DONE.** `FirmwareStore.import()` used to hard-reject
  any file whose MD5 didn't match one of the 3 canonical SCPH-5500/5501/5502
  dumps — most real-world BIOS dumps (other revisions/regions, patched
  images) failed to import at all. Now: any 512KB file imports successfully
  (a genuine PS1 BIOS is always exactly 512KB across every known revision),
  recognized dumps get their known region, unrecognized ones import with an
  explicit "region unknown" warning instead of being rejected. Only a
  wrong-size file is still rejected outright (no basis for treating it as
  any kind of BIOS). `FirmwareStore.getPreferred()` was already
  region-aware in its own logic but nothing ever passed it a real region —
  `buildStartOptions()` now derives a best-effort region hint from the
  cartridge title/filename's "(Region)" bracket tag (the No-Intro/Redump
  convention this project's own titles already use) and passes it through.
  Deliberately did NOT expand `PSX_FIRMWARE`'s known-MD5 list with
  additional hashes sourced from memory/web search — cross-checking found a
  real, documented case of a well-known emulation database (libretro-database)
  having a WRONG MD5 on record for a canonical BIOS filename (confused with
  a debug/dev BIOS variant); shipping an unverified hash risks silently
  misidentifying a user's real BIOS, which the import-with-warning fix makes
  unnecessary anyway (an unmatched-but-plausible dump now works regardless).
  `src/FirmwareStore.js`, `src/main.js` (`buildStartOptions`,
  `firmwareInput` handler). Test coverage added in
  `test/psx-foundations.test.js`. `npm test` clean, `probe:psx-testdisc` and
  `probe:psx-guncon` re-verified clean (neither probe imports a BIOS
  explicitly, both rely on the core's bundled OpenBIOS fallback — confirmed
  the `getPreferred(profile, region)` signature change doesn't affect that
  path since there are no stored records either way).
- **PSX Lightrec JIT + GL renderer — investigated, NOT fixed.** See memory
  `psx-lightrec-gl-investigation-2026-07-27.md` for concrete leads (a
  Lightrec `lightrec_get_map()` memory-region-registration timing issue; a
  `rhi_lib_gl.c`-vs-`glsm.c` GL-context-shim divergence under Emscripten) —
  a deeper instrumented-debugging pass is in progress as of this update.
- **Still open:** C1 (streaming content), C2 (DiscIdentity wiring), C4
  (multi-file shelf persistence), C6 (delete `DiscControl.js` duplication +
  real disc-swap UI). See memory `psx-phase-c-n64-phase-d-goal.md` for the
  standing goal tracking all of this.

## Status update (2026-07-27, second pass): C2 (DiscIdentity wiring) done; C3's BIOS mount-name bug found+fixed

C3's "DONE" above was written before a Codex review pass found a real P1 in
it (mounting an unrecognized-but-plausible BIOS under the user's own
filename, which Beetle PSX HW never probes for — the import silently
"succeeded" but had zero effect). Both that and C2 went through several
rounds of `codex exec review` before landing clean — noted in full since it's
a good illustration of why every commit here goes through review, not just
the ones that feel risky:

- **C3 mount-name bug — FIXED (commit `26d2ad4`).** `mountNameFor()` /
  `UNRECOGNIZED_MOUNT_NAME` now always mount an unrecognized-but-plausible
  dump under a filename the core actually probes for (`scph5501.bin`),
  keeping the user's real filename in a separate `displayName` field for the
  UI. Also fixed 3 P2s from the same review round (title metadata never
  reaching the region-hint parser; combined "(USA, Europe)"-style region tags
  not recognized; `FirmwareStore.remove()`'s signature broken by the new
  keying scheme).
- **C3 migration + UI gaps — FIXED (commit `e664df0`).** The mount-name fix
  itself had 2 more P2s: already-persisted broken records (from the brief
  `f2f30c9`-only window) were never migrated, and the import-status message
  displayed the mount alias instead of the user's real filename.
  `FirmwareStore.list()` now self-heals legacy records at read time
  (`healUnrecognizedMountName()`), no DB version bump needed.
- **C2 (DiscIdentity wiring) — DONE (commit `e664df0`, hardened in
  `9565c74`/`7f0b27b`).** `src/DiscIdentity.js`'s `identifyPlayStationDisc()`
  was tested but genuinely dead code (2026-07-24 finding) — now wired into
  the `romInput` file-picker path via a new `pickPlayStationCore()`: a picked
  `.cue`'s referenced data track (or a `.chd` directly) gets sniffed for
  SYSTEM.CNF's BOOT/BOOT2 line before core selection, so a real PS1 disc now
  correctly boots `mednafen_psx_hw` without an explicit `?core=` override. A
  `.chd`'s compressed container never parses as raw ISO9660, so it naturally
  (and correctly) falls back to the old static default with a clear status
  message instead of a silent guess. Also promoted `DiscIdentity.js`'s test
  coverage from a gitignored `tmp/` scratch script into the real suite
  (`test/disc-identity.test.js`) — it had zero committed tests before this.
  - This wiring's own review turned up 3 more P1s, all in the surrounding
    `romInput` multi-file-selection logic rather than in the sniffing itself:
    the primary-file selector relied on a core's `multiFile` flag, but
    `play` (the un-overridden default for `.cue`) never declared it, so the
    selector silently missed the `.cue` entry whenever a FileList didn't
    happen to put it first (`9565c74`); the derived `system` still used the
    un-sniffed override, so a correctly-detected PS1 disc would boot the
    right core but route as system `ps2` anyway, sending its peripheral
    wiring down the wrong path (`9565c74`); and an M3U-based multi-disc
    bundle picked whichever member CHD sorted first instead of the M3U
    itself (`7f0b27b`). That selection logic was extracted into a pure,
    directly-unit-tested `pickPrimaryFile()` in `systems.js` after the third
    round, specifically so the next ordering edge case gets caught by a test
    instead of a fourth review round.
- **Still open:** C1 (streaming content), C4 (multi-file shelf persistence),
  C6 (delete `DiscControl.js` duplication + real disc-swap UI). PSX
  Lightrec JIT + GL renderer still investigated-not-fixed (separate
  background investigation in progress, see memory
  `psx-lightrec-gl-investigation-2026-07-27.md`).

## Status update (2026-07-27, third pass): C6's dedup half done; C4 (multi-file shelf persistence) done

- **C6 "delete `DiscControl.js` duplication" — DONE (commits `3a90d3f`,
  `714b747`).** `EmulatorWorkerRuntime.js` (the worker-execution PSX boot
  path) had hand-duplicated `DiscControl.js`'s capability-detection +
  eject/select/insert logic instead of importing `DiscControlBridge`; now
  imports it directly. Review found a real P2 (the bridge started `null`
  before `hydrateLaunch()` ran, and `WorkerEmulatorClient` doesn't wait for a
  `'ready'` signal before sending disc RPCs, so an early `disc-status` call
  would throw instead of reporting "unsupported"); fixed by defaulting the
  bridge to an instance bound to no module rather than `null`. **Still open:**
  the actual disc-swap UI — `main.js`/the VR scene has zero disc-swap
  references today; the worker client already exposes `setDisc`/
  `setDiscEjected`/`discStatus`, so this is pure new UI work, no backend gap.
- **C4 (multi-file shelf persistence) — DONE (commits `1d103bc`, `ff4917c`,
  `02542e6`, `efe3ef5`).** Multi-file (bundle) worker-execution content
  (real PSX CUE+BIN picks) now persists to OPFS keyed by its own
  `contentId` (`RomResolver.js`'s `cacheBundle`/`hasBundleCached`/
  `restoreBundleFiles`, walking real nested OPFS directories for paths like
  `Disc/game.cue`) and survives a reload as a real re-insertable shelf
  cartridge, same as single-file ROMs already did (`LocalRomLibrary.js`
  entries can now key on `bundle.contentId` alongside the original `sha1`).
  `resolve()` short-circuits to `null` for a bundle meta so the existing
  `wrapWorkerContent()` call sites reconstruct it unchanged — a design that
  also fixed a broader pre-existing gap where ANY worker-mode pick (single-
  or multi-file) was never OPFS-cached at all. Went through 4 Codex review
  rounds, each finding a real regression in the one call site the original
  design missed — `rebootPrimaryConsole()` (the gun/mouse live arm-reboot
  path), which built its own stripped `{name,url,style}` core object
  instead of spreading the full `CORES` entry like every other boot site:
  missing the bundle-reconstruction wrap (`ff4917c`); silently defaulting to
  main-thread execution for PSX/N64, previously masked by the path's own
  reload fallback (`02542e6`); and, once real worker execution was actually
  exercised there, two genuine SaveRAM bugs — `currentMeta` dropping
  `contentId` (silently disabling all future memory-card persistence) and
  the outgoing runtime's SaveRAM never being flushed before the persisted
  copy was read back, letting a recent write be rolled back by the reboot
  itself (`efe3ef5`). A 4th round flagged a further, genuinely pre-existing
  limitation (the worker's SaveRAM flush can only read whatever RetroArch's
  own 10s internal autosave last wrote, not force a fresh one) — judged out
  of scope here since it equally affects the already-shipped periodic/
  `pagehide` flushes and is no worse than the old reload-fallback's own
  `pagehide`-triggered flush; left as a known limitation, not fixed.
  Extended `scripts/test-localromlibrary.mjs` (64/64) and
  `scripts/test-romresolver.mjs` (135/135); new
  `scripts/probe-bundle-persist.mjs` real-browser OPFS probe (12/12).
- **Still open:** C1 (streaming content), C6's disc-swap UI half. PSX
  Lightrec JIT + GL renderer still investigated-not-fixed. See memory
  `psx-phase-c-n64-phase-d-goal.md` for the standing goal tracking all of
  this.

## Status update (2026-07-27, fourth pass): C6 fully done (disc-swap UI half shipped)

- **C6 "build the real disc-swap UI" — DONE (commits `8552959`,
  `1a90210`).** New `src/DiscSwapPanel.js`: a small HUD-style status+Prev/
  Next panel reusing `MenuMgr`'s existing hover/click convention (modeled on
  the `mpPanel` Multiplayer sub-panel, the closest existing precedent for "a
  live-relabelled status button + a couple of action buttons"). Wired into
  `main.js` via `refreshDiscPanel()`/`stepDisc()`, called at every boot-
  success site that already updates `nowPlayingPanel` — deliberately not
  via the client's `'ready'` event, since that event fires synchronously
  inside `start()` before a reboot/swap path's listener can attach (the
  same gotcha `nowPlayingPanel` already works around by calling its updater
  directly at each boot-success site). No bootable multi-disc PSX test
  asset was built for this; verified instead via
  `scripts/probe-discswap-panel.mjs`, a headless Puppeteer probe driving
  `window.__discSwap` against a monkey-patched `window.__client` — judged
  proportional, since this is a presentational layer on top of already-
  tested plumbing (`DiscControlBridge` / worker `setDisc`/`setDiscEjected`/
  `discStatus` all have their own coverage already).
  Codex review of `8552959` found 4 issues, fixed in `1a90210`:
  (1) `DiscControlBridge.setDisc()` left the tray physically ejected
  forever after a rejected explicit-index write (`setEjected(false)` sat
  after the rejection throw with nothing to catch it) — wrapped the
  core-switch step in try/catch, added a regression test;
  (2) the panel could show/attempt Prev-Next on a core reporting
  `discCount > 1` (from the M3U's own file listing) while exposing no
  disc-control export at all — both `DiscSwapPanel.setStatus` and
  `stepDisc` now also gate on `status.supported`;
  (3) the panel wasn't populated if the console had already finished
  booting before `buildMenuAndControlsPanel()` wired it up — added an
  explicit `refreshDiscPanel()` call right after panel creation.
  **Deliberately NOT fixed** — (4) P1: disc swaps aren't forwarded to guest
  peers the way gun/mouse/kbd input is; a guest's local client is paused
  and shows the host's broadcasted video, so a guest-side `setDisc()` has
  zero visible effect for them today. Correctly fixing this needs a new
  bidirectional wire protocol (guest requests → host applies + broadcasts
  → peers sync), not safely verifiable without a live 2-peer session —
  documented as a known limitation, same judgment call as C4's SaveRAM
  flush-timing finding. `node --test test/psx-foundations.test.js`: 10/10.
  Full `npm test`: 64/64, 51/51, 11/11 unchanged. Probe: 12/12 (its
  `setDisc` mock needed a `supported: true` field added once the new guard
  landed — a probe-mock gap, not a real bug, since the real
  `DiscControlBridge.status()` always includes `supported`). Codex review
  of `1a90210` came back clean ("No actionable regressions introduced by
  this commit were identified"). Pushed.
- **C6 is now fully done** (dedup half + UI half), modulo the documented
  MP-forwarding gap.

## Status update (2026-07-27, fifth pass): C1 done — PSX Phase C is now 100% complete

- **C1 (streaming content) — DONE (commits `2199d97`, `89970b9`).** A real
  CD/DVD track (a PSX .bin redump) can be 600MB+; before this, loading one
  meant reading its full bytes three times on the main thread before a frame
  ever rendered — `ContentBundle.computeContentId()` SHA-256'd every byte
  just to mint an identity string, then `WorkerEmulatorClient.
  prepareLaunchPayload()` read the bytes again and duplicated them into a
  fresh ArrayBuffer to transfer into the worker. Fix: `computeContentId()`
  now only full-byte-hashes files at/under 8MB (every existing single-file
  ROM, every `.cue`/`.m3u`); above that it hashes size + a 64KB prefix + 64KB
  suffix sample instead — a deliberate, narrow tradeoff scoped only to large
  tracks. `prepareLaunchPayload()` now passes Blob/File sources straight
  through to the worker via `postMessage` (structured-clone hands over a
  reference to the same backing storage, never materializing a large track
  on the main thread) instead of reading+copying into a transferable
  ArrayBuffer; the worker's `hydrateLaunch()`/`writeRelative()` (the one
  place that actually needs real bytes) is now async and reads a Blob's
  bytes itself, right before mounting it into the emulated filesystem.
  `wrapWorkerContent()`'s network-fetch companion path now hands back
  `res.blob()` instead of a materialized `Uint8Array` too.
  Codex review of `2199d97` found a real P1: an earlier draft tagged EVERY
  manifest record (`full:`/`sampled:`), not just the new sampled branch —
  silently changing the contentId for every already-persisted SMALL file
  too, breaking every existing SaveRAM/save-state/shelf-cache lookup keyed
  on it, directly contradicting the commit's own claim. Fixed in `89970b9`:
  small files produce the byte-for-byte exact pre-C1 manifest record again;
  added a regression test hand-computing the original manifest hash
  independently. Codex review of `89970b9` came back clean.
  Verified: `node --test` 25/25 (13/13 on the fixup); full `npm test`
  unchanged throughout. Real-browser probes against the exact worker boot
  path this touches: `probe-bundle-persist.mjs` 12/12,
  `probe-worker-cartridge-insert.mjs` 12/12 (PSX + N64), and — the actual
  target scenario — `probe-psx-timecrisis.js` against a real, user-owned
  663MB 34-file PSX CUE+BIN redump: 30/30, both the desktop file-picker
  upload path and the URL-fetched cartridge-insert path, confirmed still
  rendering and animating real title-screen/cutscene content. Pushed.
- **PSX Phase C (C1-C6) is now 100% complete.** Only PSX Lightrec JIT + GL
  renderer (investigated, not yet fixed) and N64 Phase D (owned by a
  different concurrent session) remain from this review's original backlog.
  See memory `psx-phase-c-n64-phase-d-goal.md` for the standing goal
  tracking all of this.

## Status update (2026-07-27, sixth pass): N64 Phase D — two real bugs found and fixed in vendored Play!-CodeGen

Continued the N64 shadow-differential harness (see `n64-jit-nj1-spike.md`)
against a harder ROM than the original smoke test: `n64-systemtest.z64`.
Rebuilt the core with `N64_JIT_SHADOW_CHECK=1` and ran it through the real
worker/RetroArch boot path for 20s. Real, non-synthetic result on the first
run: **`checked=9 matched=6 mismatched=3`** — the harness's first-ever
mismatches, with full raw instruction-word dumps for each (a new diagnostic
added to `vr4300_jit_bridge.cpp`'s `CompareAndReport()` specifically to make
this root-causable instead of just an address).

**Finding 1 — real bug, found and fixed.** Two of the three mismatched
blocks (`a4000618`, `a400066c`) were both terminated by `BGEZAL` (MIPS
REGIMM `rt=0x11`), and both diverged only in the predicted exit `pc`: the
JIT-shadow prediction landed on the not-taken/fallthrough address even
though `BGEZAL`'s condition (`r0 >= 0`) is architecturally always true.

Root cause, confirmed by reading the actual vendored library source (not
guessed): this project's tier-1 adapter (`vr4300_play_backend.cpp`) lowers
`BGEZ`/`BGEZAL`/`BGEZL`/`BGEZALL` via `Jitter::CJitter::Cmp64(CONDITION_GE)`
— correct IR usage. But **Play!-CodeGen's own vendored Wasm backend has no
`CONDITION_GE` case in two separate places**, both falling through to
`default: assert(false)` — a silent no-op in the release/NDEBUG build this
project ships (`assert` compiles out, it does not abort):
- `Jitter_CodeGen_Wasm_64.cpp`'s `Emit_Cmp64_MemAnyAny` (the actual Wasm
  bytecode lowering for a runtime 64-bit compare) — missing `CONDITION_GE`
  and `CONDITION_AE`.
- `Jitter_Optimize.cpp`'s `FoldConstant64Operation` (the compile-time
  constant-folding pass, which runs *before* codegen) — same two cases
  missing. This is the one that actually fired for `BGEZAL $r0,...`: since
  `rs=r0` is always a compile-time-constant zero and the adapter also
  pushes a literal `0` as the other operand (`useRt0=true`), the comparison
  becomes two constants, hits this optimizer path, silently defaults
  `result=false`, and rewrites the condition to a hardcoded `false` — this
  is what actually produced the observed bug for this specific test.
  (The codegen-only fix was tried and applied first, rebuilt, and verified
  to make *zero* difference to the shadow-check output — proof the real bug
  was here, not in codegen, before moving on to patch this too.)

Both gaps patched locally in the WSL2-side vendored checkout
(`~/play-build/Play-/deps/CodeGen`, upstream `github.com/jpd002/Play-`),
adding the missing `CONDITION_GE`/`CONDITION_AE` cases mirroring the
existing `CONDITION_GT`/`CONDITION_AB` pattern in each file. **Not yet
upstreamed or committed to this project's own repo** — the fix lives only
in the WSL2 build tree and must be reapplied (or a proper pinned fork made,
matching the `psx-wasm-jit-libretro`/`ps2-play-libretro` pattern) before any
future N64 JIT rebuild. After rebuilding with both fixes, the same probe
against the same ROM showed both `BGEZAL` blocks now `match`:
**`checked=9 matched=8 mismatched=1`**.

**Finding 2 — not a bug, a shadow-harness limitation.** The remaining
mismatch (`block_pc=a4000408`) is a tight decrement loop (`ADDIU r2,r0,0x100`
/ `ADDIU r2,r2,-1` / `BNE r2,r0,<loop>` / delay nop) whose backward branch
target lands *inside* the block's own already-scanned span. The shadow
harness predicts a block's outcome with exactly one synthetic run of the
compiled IR at decode time, then compares once the real interpreter's PC
exits `[startPc, blockEnd)` — which is correct for blocks that leave their
own span on the first pass, but not for a self-referencing loop: the real
interpreter genuinely re-enters and loops for real (256 times here) before
exiting, while the shadow only ever modeled one pass. This is a limitation
of the *observational harness*, not evidence of a codegen bug — the
compiled IR itself (verified by hand-decoding the raw words against
`EmitBranchAndDelay`) computes the single-pass semantics correctly. It does
not, on its own, say anything about whether the real `ci_table`-wired
re-entry model (which would treat the loop-back target as a fresh
`LookupOrCompile()` at a smaller block) behaves correctly — that's a
separate, not-yet-tested question.

**Where this leaves Phase D:** a real, previously-undiscovered, and now-fixed
correctness bug was found in a third-party dependency shared by every
Play!-CodeGen consumer in this project (PS2 EE, PSX Lightrec, N64) —
significant validation of why the shadow-check-before-`ci_table` caution in
the original plan was correct. This is genuine progress, but Phase D's exit
gate (broad differential coverage — interrupt-firing, more ROMs, longer
sessions — clean enough to justify wiring `ci_table`) is not met by one
20-second boot-window sample against one ROM. `ci_table` wiring has still
not been attempted. See memory `n64-jit-nj1-spike.md` for the same finding.
