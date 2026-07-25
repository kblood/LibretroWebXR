# PSX/PS2/N64 core work — Opus review + improvement/test plan (2026-07-24)

Produced by an Opus 5 subagent (Plan mode, read-only) reviewing the actual
diffs (not just doc claims) on `main`/`n64-jit-plan`. Kept verbatim except
for this header — see git blame / session log for provenance.

## Status (updated 2026-07-25)

**Phase A is done.** Commit `528910c` on branch `n64-jit-plan` (content-
identical to `main` at this point + this review + this closure — see the
commit message for the full breakdown), **committed but NOT pushed** —
push needs separate authorization. Independently re-verified (not just
trusting the implementing subagent's own report): `git show` on the actual
diff for every item below, plus a fresh `npm test` (green) and `npm run
probe:lightgun` (9/9) run directly.

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

**Not done in Phase A, still open (unchanged from Part 2 below):** P1-8
("new tests aren't in `npm test`") is only *partially* addressed — the new
`test-runtime-facade.mjs` is wired in, but the pre-existing
`test:psx-foundations`/`test:runtime` remain separate `npm run` scripts,
not part of the main `npm test` chain. Everything in Phases B/C/D is
unstarted. P0-2 through P0-6 (worker-core reachability, mode-switch
recovery, audio, SaveRAM, OOM risk) are all still live on `main` — A4 only
*hides* the affected systems from casual users, it doesn't fix the
underlying gaps.

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
- **P0-2 — Worker cores unreachable from the real in-VR cartridge path.**
  `execution:'worker'` is only threaded through the desktop file-picker
  (`main.js:5892`), not `loadCartridge` (`:5225`) or `pickLocalRom`
  (`:2693`) — the paths VR actually uses. The shipped N64 shelf cartridges
  (`lwx-n64-smoke.z64`, `lwx-n64-scene.z64`) have never been booted through
  the real insert path.
- **P0-3 — One-way runtime mode lock, no recovery.** Switching between a
  main-thread core and a worker core (in either direction) after the first
  boot throws `runtime switch ... requires page reload` with no reload
  offered — a dead end for the rest of the page's life.
- **P0-4 — Worker cores have no audio in the app.** `SpatialAudio.pushSamples`
  has zero callers; nothing subscribes to the worker's `'audio'` event
  outside the isolated test harness. The "forwarded audio" claim in the PSX
  commit message is only true inside `test/psx-core-e2e/`.
- **P0-5 — Native SaveRAM never captures new progress.** No
  `autosave_interval` in `RetroArchConfig.js`, and
  `WorkerEmulatorClient.flushSaveRam()` just re-reads the boot-time bytes
  instead of flushing. Progress is never actually persisted.
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
`WorkerEmulatorClient.js:188-189` (open); worker pause doesn't stop the
frame pump, breaking `RackBudget` auto-pause (open, B5); `FrameBridge`
uses window `rAF` instead of `XRRafShim`, likely cause of any "PSX/N64
black in VR" (open, B6); fixed 16ms frame pacing ignores real core
refresh rate (open, B6); `test:psx-foundations`/`test:runtime` still
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

**Phase B — make worker cores actually usable:**
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

1. ~~A1 + A2 + T-X2~~ — **done 2026-07-25**, see Status above.
2. ~~A3/A4/A5~~ — **done 2026-07-25.**
3. **Next: `git push` the Phase A commit** (`528910c`) — it's currently
   local-only, so the live deploy is still running the broken
   `RuntimeEmulatorClient`. Needs explicit go-ahead (not authorized by
   "implement Phase A" alone).
4. T-0 (app-probe tier) — prevents the next P0-shaped miss. Note A2
   already built one instance of this pattern
   (`probe-lightgun-regression.mjs`); T-0 generalizes it into a reusable
   harness rather than one-off scripts per probe.
5. B1–B5, gated by T-X4/T-X5/T-PSX-4/T-PSX-5.
6. `games/psx-testdisc` (T-PSX-2) early — independent, unblocks most of
   the PSX matrix.
7. C1 (streaming content) — the largest single piece; nothing about real
   PSX discs is trustworthy until it lands.
8. D1–D3 in parallel with the above (different files/skillset) — but D1
   (commit the mismatch finding) is still outstanding and increasingly
   stale; `scripts/cores/n64-jit-spike/vr4300_jit_bridge.cpp` was still
   uncommitted (someone else's in-flight WIP) as of this update.
9. H-1/H-2/H-3 at the first headset session, **plus H-7** (a full
   gun/mouse re-validation pass, now that P0-1 is fixed) — H-3 may
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
