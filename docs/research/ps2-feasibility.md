# PlayStation 2 via libretro — feasibility

**TL;DR.** **Not worth pursuing right now.** A real PS2 core exists
(`LRPS2`, plus a lighter `Play!` core), but two independent things rule it out
for this project: **it has no light gun support at all** — the entire reason
you'd want PS2 here (Time Crisis, Vampire Night, Point Blank-style titles) —
and it's a **desktop-only, GPU-heavy emulator with no evidence of an
Emscripten/wasm build**, one tier harder than the N64 core this project
already rejected as "not viable" in [[psx-n64-feasibility]].

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
