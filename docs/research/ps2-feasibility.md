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

Neither project's buildbot pages, docs, or announcement posts mention an
Emscripten output. That's a strong negative signal, not proof of impossibility
— nobody appears to have tried, likely because of the second point below.

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
- No JIT path exists in Emscripten-compiled wasm regardless of which of these
  cores were ported, so none of this changes even with unlimited porting
  effort — it's the same architectural wall, just a longer drop.

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

_Research pass: 2026-07-16. Libretro core status changes fast — re-verify
buildbot/docs pages before acting on this if it's been more than a few months._
