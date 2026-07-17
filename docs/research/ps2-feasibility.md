# PlayStation 2 via libretro — feasibility

**TL;DR — superseded, 2026-07-17.** This doc's verdict flipped from "skip"
to "worth a real build plan" over the course of one research session — see
the two updates below in order, and then
**[docs/research/libretro-core-authoring/ps2-play-core-plan.md](libretro-core-authoring/ps2-play-core-plan.md)**
for the current plan and next steps. Short version: `Play!` (one of the two
PS2 emulators with a libretro-facing presence) already has a real
WebAssembly-native JIT with SIMD (not an interpreter, despite what this doc
claimed as recently as its own previous update) *and* an existing libretro
core wrapper (`Source/ui_libretro/`, separate from its `Play!.js` browser
frontend) — it's just never been built for Emscripten, and its libretro
wrapper's input never got light-gun support wired in. Both are scoped,
bounded engineering tasks now, not open research questions.

## What exists today

- **LRPS2** — a heavily modified hard fork of PCSX2, purpose-built for the
  libretro API. Launched around January 2025 with a new Vulkan-powered LLE
  renderer, **ParaLLEl-GS**, aiming for software-render accuracy at GPU
  speed, plus OpenGL/Vulkan/D3D11-12 HLE paths. Actively built on the
  buildbot for **Windows, macOS, and Linux — x86_64 only**. Per the libretro
  docs: "does not work natively on ARM hardware, so it is not available on
  iOS/tvOS, Android, ARM Linux or Windows on ARM."
- **Play!** — a lighter, independently-developed PS2 emulator with its own
  libretro core. Back on the buildbot with builds for Android
  (AArch64/ARMv7/x86), macOS (Intel), Linux, and Windows — broader platform
  reach than LRPS2, but still no Emscripten/wasm target found in any build
  matrix or docs page during this research pass.

- **ARMSX2** — a newer (2025/2026) fork of PCSX2 targeting native ARM64
  speed (desktop and mobile, including Android/iOS/Apple Silicon) via a
  real-time x86→ARM64 machine-code translation layer over PCSX2's existing
  JIT. Not a libretro core (no RetroArch integration found), and — like the
  others — no Emscripten/wasm target. See Blocker 2 below for why its
  approach doesn't change the wasm picture.

Neither libretro-facing project's buildbot pages, docs, or announcement
posts mention an Emscripten output. That's a strong negative signal, not
proof of impossibility — nobody appears to have tried, likely because of the
second point below.

## Blocker 1 — no light gun support

Per the EmuVR wiki (the most directly relevant source, since it's the same
"VR frontend over libretro cores" problem this project solves): **"The PS2
core doesn't have light gun support at all, so there's no way to play PS2
games with light guns (e.g. Time Crisis II, Time Crisis 3, Vampire Night)."**
This project's gun mechanics ([[../LIGHTGUN_SUPPORT.md]]) are built on the
libretro light gun device API (`RETRO_DEVICE_LIGHTGUN`), which the PS2 cores
simply never wired up. Without that, PS2 offers nothing this project doesn't
already do better with its existing NES Zapper / SNES Super Scope / SMS Light
Phaser / Justifier games — there's no gun game to point at.

## Blocker 2 — heavier than the console we already rejected

[[psx-n64-feasibility]] already established the wall: **WebAssembly in the
browser has no dynamic recompiler**, so every emulated instruction runs at
interpreter cost, competing with the WebXR render thread for the same cores.
That doc rated PSX "marginal, needs a measured spike" and N64 "not viable" —
and PS2 is a bigger lift than either:

- **CPU:** Emotion Engine (MIPS R5900, ~294 MHz) vs. N64's ~93 MHz VR4300 —
  roughly 3× the clock, and EE also drives two vector co-processors (VU0/VU1)
  that N64's single RSP doesn't have an equivalent scale to.
- **GPU:** the Graphics Synthesizer is a fundamentally HLE/HW-render-dependent
  design (unlike N64's RDP, which at least has a slow-but-workable software
  path) — LRPS2's whole pitch is a **GPU-accelerated** LLE renderer
  (ParaLLEl-GS), which assumes a real graphics backend, not the constrained
  WebGL2-via-wasm environment this project runs in.
- **Why "x86_64 only" isn't a packaging gap — it's the whole performance
  story:** PCSX2/LRPS2's speed comes from a JIT recompiler that writes real
  x86-64 machine code into memory at runtime and jumps to execute it
  directly on the host CPU. Upstream PCSX2 *does* ship for ARM, but only as
  a plain interpreter — dramatically slower, because the JIT (the actual
  fast path) has no ARM equivalent there. A newer fork, **ARMSX2**, gets
  PCSX2 running fast on ARM (Android, Apple Silicon) not by writing a native
  ARM64 recompiler, but by translating the x86 machine code PCSX2's JIT
  already emits into ARM64 machine code in real time — Rosetta-2-style. So
  even PS2 emulation's "ARM support" story still fundamentally depends on
  generating and executing real native machine code at runtime, just with
  an extra translation hop.
- **Why this matters for wasm specifically:** WebAssembly already solves
  cross-CPU portability for free — the same `.wasm` file runs on an x86
  Windows PC or an ARM Quest headset, because the browser's own engine turns
  wasm into native code for whatever chip it's actually on. That was never
  the blocker. The real problem is that none of these PS2 emulators' speed
  comes from portable, recompilable C++ — their performance story is
  "generate real machine code and jump to it," and a WebAssembly sandbox has
  no ability to do that at all, on any host CPU. There is no "just
  recompile it for wasm" path here; you'd be stuck with the same plain
  interpreter ARM users are stuck with today, and PS2's interpreter-only
  speed is understood to be far too slow to be usable — unlike PSX's
  `pcsx_rearmed`, whose interpreter fallback was at least plausible enough
  to call "marginal, worth a spike."

## Verdict

Skip it. Neither blocker is a "spend more effort" problem:

- The gun-support gap is a libretro-core-maintainer decision, not something
  fixable from this project's side.
- Even absent that, PS2 sits a full tier past N64 on the no-JIT wasm wall
  that [[psx-n64-feasibility]] already used to reject N64 — and that doc's
  own PSX perf spike (the easiest of the three) hasn't even been run yet.

**Revisit only if:** (a) a libretro PS2 core ships light gun support upstream,
**and** (b) the PSX perf spike from [[psx-n64-feasibility]] comes back
healthy enough to suggest the no-JIT wall is survivable at all above
8/16-bit — at which point PS2 would still need its own from-scratch
Emscripten port before any of this is testable.

## Cross-references

- The no-JIT wasm wall, first established for Amiga/PSX/N64:
  [[../AMIGA_CORE_BUILD.md]], [[psx-n64-feasibility]].
- This project's gun mechanics and which systems currently support them:
  [[../LIGHTGUN_SUPPORT.md]].
- Core weight/style model (`'classic'` vs `'module'`, `weight` for rack
  budgeting): `src/systems.js` header comment, `src/RackBudget.js`.

## Sources

- [Play! Libretro core ready for download on the buildbot](https://www.libretro.com/index.php/play-libretro-core-ready-for-download-on-the-buildbot/)
- [LRPS2 – the new PlayStation2 core with a Vulkan LLE renderer](https://www.libretro.com/index.php/lrps2-the-new-playstation2-core-with-a-brand-new-lle-renderer/)
- [Sony - PlayStation 2 (PCSX2/LRPS2) - Libretro Docs](https://docs.libretro.com/library/lrps2/)
- [buildbot.libretro.com PS2 nightly builds](https://buildbot.libretro.com/nightly/playstation/ps2/)
- [Light Guns - EmuVR Wiki](https://www.emuvr.net/wiki/Light_Guns)
- [PCSX2 Documentation/PCSX2 EE Recompiler - PCSX2 Wiki](https://wiki.pcsx2.net/index.php/PCSX2_Documentation/PCSX2_EE_Recompiler)
- [ARMSX2 GitHub](https://github.com/ARMSX2/ARMSX2)
- [Inside ARMSX2: Interviewing the Team Reviving PS2 Emulation on Android](https://gardinerbryant.com/inside-armsx2-interviewing-the-team-reviving-ps2-emulation-on-android/)

_Research pass: 2026-07-16. Libretro core status changes fast — re-verify
buildbot/docs pages before acting on this if it's been more than a few months._

## Update (2026-07-17) — two corrections, verdict unchanged

A follow-up pass (prompted by "has newer wasm made this viable?") found the
2026-07-16 pass above was **wrong on two factual points**, but the skip
verdict still holds for different, better-evidenced reasons.

**Correction 1 — a PS2-in-browser build does exist.** `Play!.js`
(https://playjs.purei.org/, part of the mainline `jpd002/Play-` repo) is a
real Emscripten/wasm build of the `Play!` PS2 emulator running today in
Chrome/Firefox, no BIOS file required. The "no evidence of an Emscripten/wasm
build" claim above was a research miss, not a project fact — it exists, I
just hadn't found it.

**Correction 2 — light gun / GunCon input does exist**, in `Play!` itself
(not in LRPS2, so the EmuVR-sourced Blocker 1 quote was accurate for LRPS2
specifically but overgeneralized to "PS2 cores" as a whole). `Play!` maps
GunCon trigger/pedal to CIRCLE/TRIANGLE and uses cursor position for aim,
with Time Crisis 3 named explicitly as a supported/calibratable title.

**Why the verdict doesn't change despite both corrections flipping:**

- **It's not a libretro core.** `Play!.js` is `Play!`'s own standalone
  SDL-style frontend recompiled with Emscripten — its own window, canvas,
  event loop, and mouse-based GunCon input, entirely outside the libretro
  ABI. This project's whole pipeline (`src/systems.js` core loading,
  `RackBudget`, the `RETRO_DEVICE_LIGHTGUN` wiring documented above, and the
  netplay host/late-joiner state sync, which is built on
  `retro_serialize`/`retro_unserialize`) assumes a libretro core. None of
  that applies to a monolithic non-libretro app. Adding PS2 would mean
  building a second, parallel emulator-integration stack from scratch — not
  "register a new core" the way every other system in this project works —
  with no guarantee `Play!.js`'s wasm build even exposes a serialize hook to
  hang netplay sync off of.
- **The web build is confirmed slow in practice, not just in theory.**
  Per the project's own docs, the wasm build runs as a plain interpreter
  (no JIT — "write protection on memory pages is not supported, thus...JIT
  cache can't be invalidated," which can also break games that
  self-modify EE code at runtime). Outside reviews report it as "choppy,
  slow, and fidgety" with "poor framerates and bugs galore," and the authors
  themselves call it "only an experiment, not meant to play all games."
  ~400 titles playable, ~1,200 more in partial/broken states. That's
  real-world confirmation of Blocker 2's theoretical no-JIT concern, not
  just a prediction anymore.
- **The "wasm gets its own JIT" hope doesn't rescue this.** There's a
  `jit-interface` proposal (`func.new`, safe runtime code generation) that
  would let wasm modules do what PCSX2's JIT does today. It's real, but it's
  **Phase 1 of 5** — earliest community-group stage, unimplemented in any
  browser, no shipping timeline, championed by one person. (For scale: wasm
  threads, which shipped in 2025, took years to go from Phase 1 to
  universal browser support.) Not something to plan a port around.

**Verdict stands: skip.** Better information now, same conclusion — and if
anything the "no libretro core → no fit with this project's architecture"
point is a harder blocker than either point in the original pass, since it's
not fixable by anyone upstream shipping a feature; it's a structural mismatch
with how this whole frontend is built.

**Revisit only if:** `Play!` (or a fork) ships as an actual libretro core —
at which point the `RETRO_DEVICE_LIGHTGUN` wiring and per-core registration
pattern this project already has would apply directly and most of this
integration cost disappears.

### Addendum — checking whether newer WASM (SIMD/threads) could fix the speed

Pushed on this further: does the current WASM feature set (SIMD128, threads,
which have both shipped in all major browsers since ~2025) change the
performance picture, either in general or specifically for `Play!.js`?

- **General WASM state, confirmed:** WebAssembly 3.0 (GC, Memory64, threads,
  SIMD, relaxed SIMD, exception handling) is real and shipped everywhere as
  of late 2025. None of it adds the one thing that actually matters for a
  PS2 emulator's stock performance story — a way to generate and execute
  native machine code at runtime (see the `jit-interface`/Phase-1 discussion
  above). SIMD and threads can still meaningfully speed up an
  *interpreter's* hot loops even without a JIT, though — worth checking
  case-by-case.
- **`Play!.js` specifically, checked against its actual build config
  (`Source/ui_js/CMakeLists.txt`, `Source/CMakeLists.txt`, and the
  `Play--Framework` submodule's `SimdDefs.h`) rather than guessing:**
  - `SimdDefs.h` explicitly maps `__EMSCRIPTEN__` → `FRAMEWORK_SIMD_USE_NEON`,
    and vector-heavy code (`Source/ee/Vif.h`, the VIF/VU-feeding path) is
    already written against that SIMD abstraction — so the maintainer's
    intent was clearly for the browser build to get vector acceleration.
  - But **no `-msimd128` (or `-mfpu=neon`) flag appears anywhere in the wasm
    build's compile or link options**, in either `ui_js/CMakeLists.txt` or
    the shared `Source/CMakeLists.txt`. Per Emscripten's own docs, NEON
    intrinsics are emulated *on top of* wasm SIMD128 — meaning that flag is
    what actually turns the emulation on. Without it, this code path is at
    best compiling to Emscripten's scalar fallback for unsupported ops, not
    real hardware SIMD, in the exact code (vector unit feed) that would
    benefit most.
  - PTHREAD_POOL_SIZE=2 is set, so some worker-thread pooling is already in
    play; how much of the emulator's actual workload (EE/VU1/IOP split) uses
    it wasn't checked.
  - **Not independently verified by building it** — this is read from the
    public build scripts, not confirmed against the actual generated
    `Play.wasm`'s opcodes. Treat "no SIMD128 in the shipped build" as
    strong-but-unconfirmed until someone actually builds it with the flag
    added and diffs the output/benchmarks it.

**So: is there a real, cheap performance lever here?** Plausibly yes, and
it's a legitimate thing worth testing — but it's a lever on **`Play!.js` /
`jpd002/Play-` upstream**, not on this project. Even a substantially faster
`Play!.js` (from adding `-msimd128`, or from wasm eventually getting runtime
codegen) still doesn't make it a libretro core, and the architecture-mismatch
blocker above is the one this project can't route around. If this is worth
pursuing, it's an upstream contribution to `jpd002/Play-` in its own right —
not LibretroWebXR work, and not gated on anything about *this* project.

### Additional sources (2026-07-17 pass)

- [Play!.js](https://playjs.purei.org/)
- [jpd002/Play- GitHub — Emscripten build docs](https://github.com/jpd002/Play-)
- [Play!.js coverage — chromeunboxed.com](https://chromeunboxed.com/web-based-playstation-2-game-emulator)
- [Play!.js coverage — megavisions.net](https://www.megavisions.net/this-emulator-plays-playstation-2-games-in-your-web-browser/)
- [WebAssembly jit-interface proposal](https://github.com/WebAssembly/jit-interface)
- [WebAssembly/proposals — phase tracking](https://github.com/WebAssembly/proposals)

## Correction (2026-07-17, later same day) — the addendum above was itself wrong

The "web build uses an interpreter approach" claim two sections up came from
summarizing GitHub docs/wiki pages, not from reading the actual source. It's
wrong: `Play!` has a real, mature WebAssembly-bytecode-emitting JIT
(`Jitter_CodeGen_Wasm`, with a dedicated SIMD backend), and a separate
existing libretro core wrapper neither prior pass had found
(`Source/ui_libretro/`). Full findings and a build plan now live in
**[docs/research/libretro-core-authoring/ps2-play-core-plan.md](libretro-core-authoring/ps2-play-core-plan.md)**
— that doc supersedes this one's verdict. Kept here rather than deleted: the
progression (wrong → less wrong → verified) is the useful part, and the next
person to touch this shouldn't have to rediscover that secondhand
review/doc summaries got the CPU-performance story backwards twice in a row
before someone read the actual code.
