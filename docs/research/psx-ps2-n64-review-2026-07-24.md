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
are consequently also unverified. **This is now the single most important
open item for PSX**, ahead of the rest of Phase C: there is no confirmed
evidence yet that any real PSX game will display anything but this same
two-color cycle in this app. A focused follow-up investigation into the
worker-runtime video/GPU path (coordinating with whichever session owns
those files) should happen before further PSX content work or before
Phase C's PSX items are prioritized.

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
