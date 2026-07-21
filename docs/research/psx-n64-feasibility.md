# PlayStation & Nintendo 64 on a standalone Quest 3 — feasibility

**TL;DR — updated 2026-07-19, verdict: skip both, no known path.** The PSX
headless perf spike this doc called for is done: `pcsx_rearmed` measured
**~11.8fps, ~20% of NTSC full speed**, on a desktop-Chrome headless run (an
*upper bound* — Quest would be worse). That's far below "~full speed," so
**PSX is not being registered.** A follow-up research pass (below) also
checked whether the same trick that made PS2's `Play!` core fast in-browser
— a JIT that emits WebAssembly bytecode at runtime instead of native machine
code — exists or is buildable for PSX/N64 today. It doesn't, anywhere in
either ecosystem, confirmed from source across every actively-maintained
core. **Both systems remain unshippable and there's no cheap lever to change
that** — closing the gap would mean building a wasm-native JIT backend
comparable in scope to `Play!`'s `Jitter` framework (a multi-year effort for
its original author), which is a different order of task than "register a
core." Static recompilation (below) is a real alternative technique but is
inherently per-game, not a generic core, so it doesn't fit this project's
architecture either.

**Original TL;DR (context, superseded above).** The deciding constraint is
the same one that ruled out an Amiberry-based Amiga core: **WebAssembly in
the browser has no dynamic recompiler**, so every emulated CPU/GPU
instruction runs at interpreter cost. `src/systems.js` already anticipates
this — its `weight` comment flags "N64/PSX/Saturn" as heavy cores that
"should be capped to one live instance."

## Why no-JIT is the whole story

Every console we ship today is 8/16-bit: the emulated CPU is ≤ a few MHz and an
interpreter keeps up easily on a Quest. PSX (~33 MHz MIPS R3000) and N64
(~93 MHz MIPS VR4300 **plus** the RSP/RDP signal+graphics co-processors) are a
different order of magnitude. Native RetroArch hits full speed on these by
JIT-compiling the guest CPU to host code (a *dynarec*). In the browser there is
no JIT path available to a libretro core — emscripten emits a fixed wasm module,
and the guest CPU stays interpreted. So the cost we pay is the raw interpreter
throughput of a 33–93 MHz RISC core, competing for the same cores as the WebXR
render thread that must hold 72–90 fps for comfort.

This is not a tuning problem; it is architectural. It's the identical wall we hit
with Amiga (see [[../AMIGA_CORE_BUILD.md]] / the Amiberry-as-new-core dead end):
PUAE only works because its 68000 is slow enough to interpret.

## PlayStation — marginal, worth a measured spike

- **Core: `pcsx_rearmed`.** It's the right choice — purpose-built lean/ARM-mobile
  PSX core, interpreter is comparatively fast, and it has an **HLE BIOS** option
  so it can boot many titles **without** a copyrighted `SCPH*.bin` (keeps the
  "works out of the box / ship no proprietary ROMs" promise — there is also a
  real PSX homebrew scene for CC0 content). Avoid `beetle_psx`/`mednafen_psx`/
  `swanstation` — far more accurate, far too heavy for mobile wasm.
- **Expected behaviour on Quest 3 (XR2 Gen 2):** desktop-browser wasm runs many
  PSX games near full speed on `pcsx_rearmed`; on the Quest's mobile SoC, sharing
  the frame with the XR render thread, expect **2D / lighter titles near
  playable and heavy 3D titles dropping below full speed**. This is an estimate,
  not a measurement — do not promise it sight-unseen.
- **Verdict:** add it *only after* a perf spike returns real numbers. `weight: 3`
  (cap to one live rack slot). BIOS UX = HLE by default, optional user-supplied
  real BIOS later.

## Nintendo 64 — not viable on standalone

- **Core would be `mupen64plus_next` + GLideN64** (or `parallel_n64`). That stack
  needs a CPU dynarec **and** an RSP implementation **and** a real GLES3 graphics
  plugin. In no-JIT wasm the CPU+RSP interpreter alone is brutal; even
  desktop-browser wasm N64 struggles, and the emscripten N64 cores are
  historically flaky (threads / GLES context requirements).
- **Expected behaviour on Quest 3:** a slideshow for most commercial titles.
- **Verdict:** experimental-curiosity at best ("loads but runs slow"), **not a
  shippable system**. Skip unless explicitly wanted as a tech demo.

## Recommended path

1. **PSX perf spike (headless first).** Pull `pcsx_rearmed` from the buildbot
   bundle (`buildbot.libretro.com/nightly/emscripten/RetroArch.7z` — same source
   as our 14 cores; no per-core download exists), boot an HLE-BIOS homebrew/test
   title through the real `EmulatorClient`, and measure emulated FPS. Then make a
   Quest-on-device pass (the headless number is an upper bound — mobile is lower).
2. **Decide PSX from the numbers**, not this estimate. If it clears ~full speed
   on lighter content, register it (`weight 3`, HLE BIOS default) and ship a CC0
   homebrew demo like the other systems.
3. **Defer N64.** Revisit only if a JIT-capable path appears (it doesn't today)
   or as an explicit non-playable tech demo.

## Cross-references

- Heaviness/`weight` model and the one-live-instance cap: `src/systems.js`,
  `src/RackBudget.js`.
- The no-JIT wall, first hit on Amiga: `docs/AMIGA_CORE_BUILD.md`,
  memory `[[amiga-puae-blocked]]`.
- Roadmap slot: Phase C — "BIOS-needing systems (PSX/N64) via fetched cores".

## Update (2026-07-19) — PSX perf spike result: fail, and why PS2 doesn't generalize

### The PSX spike, run for real

Built a minimal CC0 homebrew PS-EXE (`tmp/psx-spike/main.c`, PSn00bSDK via
the `luksamuk/psxtoolchain` Docker image) and booted it through the actual
`EmulatorClient` against the extracted `pcsx_rearmed` core, HLE BIOS, same
instantiation pattern the early PS2 diagnostics used before `play` was
registered. One real bug had to be found and fixed to get a valid reading:
the homebrew's initial variants left the canvas black despite booting
cleanly, across three different rendering strategies, because none of them
called `SetDispMask(1)` — `ResetGraph()`/`PutDispEnv()` alone never enable
the GPU's display scanout (GP1 0x03).

With that fixed, the measurement is clean and repeatable (headless
Puppeteer, `tmp/verify-psx-perf-spike.mjs`, 4/4 checks passing):

```
guest frames advanced: 238 over 20.16s wall-clock
measured emulated FPS: 11.8  (20% of NTSC 60fps)
```

**~20% of full speed**, under a synthetic per-frame CPU workload standing in
for real game logic, on desktop Chrome with swiftshader — i.e. the *best*
case this doc anticipated, not the Quest case. Per the "Recommended path"
section above, this is a clear no: PSX is not being registered in
`src/systems.js`. This isn't a close call to revisit later; it's ~5x too
slow on the friendlier of the two platforms this doc considers.

### "If PS2 can run in web, why not PSX/N64?" — it's not that PS2 is easier

This is worth answering precisely because it looks like a real
counterexample: `docs/research/ps2-feasibility.md` documents that PS2's `EE`
(MIPS R5900, ~294MHz) is *heavier* than N64's CPU and clocked ~3x PSX's, yet
a real PS2 core (`play`) now ships in this project and renders actual
commercial 3D content correctly (Time Crisis II, see
`[[ps2-play-core-built]]`). If the no-JIT wall is architectural, how does
that work?

**Answer, confirmed by reading `Play!`'s actual source (not docs/wiki
summaries, which got this backwards twice before someone checked — see the
correction chain in `ps2-feasibility.md`): `Play!` isn't fast *despite*
running in a wasm sandbox with no native-codegen JIT — it has a real JIT,
but that JIT's backend (`Jitter_CodeGen_Wasm`, part of author jpd002's
`Jitter` IR framework) emits actual WebAssembly bytecode at runtime and
calls `WebAssembly.compile`/`instantiate` from JS.** That's legal inside the
browser sandbox — generating and running *wasm* at runtime is allowed;
generating and jumping to native x86/ARM machine code (what every other
dynarec here does) is not. PS2 isn't an easier case that happened to work —
it's the *only* case anyone has actually solved, via a purpose-built,
multi-project JIT framework its author had already spent years developing
for reasons unrelated to the browser.

A follow-up research pass checked whether that same wasm-bytecode-JIT trick
exists, or is close to existing, for PSX or N64 anywhere in the ecosystem.
It doesn't. Checked from source, not secondhand:

- **`pcsx_rearmed`'s two dynarecs are both native-machine-code-only.**
  `ari64`/"new dynarec" is ARM-only; `lightrec` (`pcercuei/lightrec`) has
  backends for x86, x86_64, ARM, AArch64, MIPS, PowerPC, SH4, RISC-V — all
  real machine code, no wasm target exists or is proposed anywhere in its
  issue tracker. The project's own `Makefile.libretro` sets `DYNAREC=`
  (empty) for the `emscripten` platform target — confirmed by reading the
  file directly. **EmulatorJS ships the identical upstream interpreter-only
  build** (`make platform=emscripten`, same Makefile) — this project's ~20%
  number isn't an implementation gap, it's the same number anyone gets from
  this core in a browser.
- **DuckStation** has no Emscripten/wasm build at all (x86-64/ARMv7/
  ARMv8/RISC-V native targets only). **Rustation** is interpreter-only, no
  JIT of any kind, confirmed by its source tree having no
  `jit.rs`/`recompiler.rs`. Neither is a live option.
- **`mupen64plus-next`'s `new_dynarec.c`** literally `#include`s one of
  `x86/assem_x86.h` / `x64/assem_x64.h` / `arm/assem_arm.h` /
  `arm64/assem_arm64.h` and `#error`s on anything else — no portable or wasm
  path exists in the source, confirmed directly. Its top-level Makefile
  zeroes `WITH_DYNAREC` and sets `-DNO_ASM` for the emscripten build. The
  only fallback that actually runs in wasm is `cached_interp.c` /
  `pure_interp.c` — a plain interpreter, same category as PSX's. No modern,
  citable fps benchmark for `mupen64plus-next` under wasm was found anywhere
  (a real gap in public data, not a "confirmed fast" story) — but real user
  reports against EmulatorJS's identical core describe N64 as "sooooo slow,"
  capped around 30fps even on lighter titles on desktop hardware, which is
  the closest available real-world signal.

### Precisely what's missing: not a JIT, a wasm-targeting *backend* for one

Worth being exact about this, since "no JIT" undersells it and invites the
wrong question ("why hasn't anyone written a PSX/N64 JIT?" — they have, for
20+ years, and they're good). **The JITs already exist and are mature; what
none of them has is a code-generation backend that targets WebAssembly
bytecode instead of native x86/ARM machine code.** Every dynarec here does
the same two-stage thing: translate guest MIPS into some internal form, then
emit *something* and execute it. Stage one (the hard emulation-correctness
part — instruction decoding, register allocation, block linking) is fully
solved in all of these projects. Stage two — what actually gets emitted —
is hardwired to native machine code, and that's specifically the part a
browser sandbox refuses to run.

`Play!`'s `Jitter` framework happens to separate those two stages cleanly:
a shared intermediate representation, with the final "emit real
instructions" step delegated to a swappable backend per target
(`Jitter_CodeGen_x86`, `Jitter_CodeGen_Arm`, `Jitter_CodeGen_Wasm`, ...).
Adding wasm support there meant writing *one more backend* against an
architecture already designed for multiple backends — not redesigning the
emulator.

Whether that same move is available for PSX/N64 depends on how each
project's dynarec is actually built, and the two aren't in the same
position:

- **`lightrec` (pcsx_rearmed's dynarec) is architecturally close to
  `Jitter`'s shape.** It already ships separate backends for x86, x86_64,
  ARM, AArch64, MIPS, PowerPC, SH4, and RISC-V — so "add a wasm backend" is
  literally the kind of change the codebase already supports as a pattern,
  even though writing one is still real, sustained work (a wasm bytecode
  emitter, register-allocation adjustments for wasm's stack-machine model,
  and testing against the existing IR) — realistically months, by someone
  who knows both lightrec's IR and wasm's instruction set well. It is *not*
  a rewrite of pcsx_rearmed.
- **`mupen64plus-next`'s `new_dynarec` is not in that position.** It emits
  x86/ARM instruction encodings directly inline in C, selected via
  `#include`s of `x86/assem_x86.h` etc. with no separating IR layer for a
  new backend to plug into (confirmed by reading `new_dynarec.c` itself —
  see Sources). Getting wasm output out of it isn't "add a backend," it's
  closer to writing a new dynarec from scratch that happens to reuse
  `new_dynarec`'s frontend (MIPS decode, block management) if that part is
  even separable. Meaningfully more work than the PSX case, on top of N64
  already being the heavier system.

So: the *examples* problem and the *conversion* problem are really the same
problem stated two ways, and the honest answer is closer to the second —
existing JITs would need a new code-generation backend added (`lightrec`)
or a substantial partial rewrite (`new_dynarec`), not a from-scratch
emulator. The reason it hasn't happened isn't "impossible," it's that it's
a real, scoped, multi-month piece of dynarec-engineering work that nobody
with the right expertise has pointed at these two projects yet — the same
category of effort `Play!`'s wasm backend already represents for PS2, just
not yet spent on PSX or N64.

### Static recompilation — a real technique, but doesn't fit this project

There is one genuinely different approach that sidesteps the wasm-JIT
problem entirely: **static recompilation**. Instead of interpreting or
JIT-compiling a ROM's machine code at runtime, a tool translates one
*specific game's* MIPS binary into portable C/C++ **ahead of time** (as a
one-off build step, done by a developer, not at runtime in the player's
browser), which is then compiled completely normally — no runtime codegen
at all, so the browser sandbox restriction that blocks every dynarec above
simply doesn't apply.

- **N64 side is real and active**: `N64Recomp` (generic tool) and
  `Zelda64Recomp` (Majora's Mask / OoT specifically) both show active 2026
  commits. Several other titles (Star Fox 64, Banjo-Kazooie, Mario Kart 64)
  have working community recompilations. But it fundamentally **requires an
  existing decompilation or at least a function/symbol-annotated
  disassembly of that specific ROM** — per N64Recomp's own README, fully
  automatic operation on an arbitrary unannotated ROM is a stated future
  goal, not current capability. That means it's a per-game, per-decomp
  tool, not a generic "any cartridge" emulator — architecturally it couldn't
  slot into `src/systems.js`'s one-core-per-system model any more than a
  native port of the actual game could. **Nobody has shipped a wasm build of
  one anyway**: `Zelda64Recomp#221` explicitly requested Emscripten/web
  support and was closed unbuilt — not for a CPU-performance reason, but
  because its RT64 renderer needs GPU features (ray tracing, bindless
  resources, push constants) WebGPU doesn't expose.
- **PSX side is much earlier-stage.** `PSXRecomp` is the most developed
  effort (actively committed as of mid-2026, handles the BIOS and PS1's
  code-overlay problem), with two downstream game recompilations reaching
  mid/late gameplay but not fully validated. The gating factor is upstream:
  **PS1's decompilation scene is far less mature than N64's** — N64 has
  three complete, byte-matching decomps (SM64, OoT, MM) to build tooling
  against; the best comparable PSX case found (Metal Gear Solid) has its
  main executables fully matching but under half of its 80+ overlay files
  decompiled. Recompilers need a mature matching decomp as raw material, and
  that raw material mostly doesn't exist yet for PSX.

### Verdict (unchanged, now evidence-backed both ways)

Skip both PSX and N64. Not "revisit in a year" — genuinely nobody, anywhere,
has solved in-browser PSX/N64 speed for arbitrary ROMs, and the one project
that solved the adjacent PS2 case (`Play!`) got there via a framework its
author had already spent years building for unrelated reasons, not a
technique this project could adopt cheaply. The two real options if this
ever gets revisited are (a) someone builds a `Jitter`-scale wasm-bytecode
JIT backend for `lightrec` or `mupen64plus-next` from scratch — a project on
the order of months, by someone with dynarec-authoring experience, not a
LibretroWebXR-side task — or (b) static recompilation matures enough
(especially on the PSX decomp side) that a single hand-picked, fully
decompiled game could ship as a one-off tech demo *outside* the normal
per-system core architecture, the same kind of structural special-case
`Play!.js` was ruled out as being before the real `Play!` libretro core made
PS2 fit properly. Neither is close today.

### Sources (2026-07-19 pass)

- [pcercuei/lightrec](https://github.com/pcercuei/lightrec) — dynarec backend list, no wasm target
- [libretro/pcsx_rearmed `Makefile.libretro`](https://github.com/libretro/pcsx_rearmed) — `emscripten` target zeroes `DYNAREC`
- [libretro-DuckStation](https://github.com/stenzek/duckstation) — supported platform list, no Emscripten
- [simias/rustation](https://github.com/simias/rustation) — source tree, no JIT/recompiler files
- [mupen64plus-libretro-nx `new_dynarec.c`](https://github.com/libretro/mupen64plus-libretro-nx) — native-arch-only `#include`/`#error` guard
- [N64Recomp](https://github.com/N64Recomp/N64Recomp) — README, symbol/disassembly requirement
- [Zelda64Recomp](https://github.com/Zelda64Recomp/Zelda64Recomp) — active commits
- [Zelda64Recomp#221 — Emscripten/web request, closed unbuilt](https://github.com/Zelda64Recomp/Zelda64Recomp/issues/221)
- [rt64/rt64#6 — WebGPU renderer limitations](https://github.com/rt64/rt64/issues/6)
- [mstan/psxrecomp](https://github.com/mstan/psxrecomp)
- [EmulatorJS build.sh](https://github.com/EmulatorJS/EmulatorJS) — `make platform=emscripten`, same upstream cores
- [EmulatorJS#759, #823 — N64/PSX slowness reports](https://github.com/EmulatorJS/EmulatorJS/issues)
- Cross-reference: `docs/research/ps2-feasibility.md`'s correction chain on
  `Play!`'s `Jitter_CodeGen_Wasm` backend and `Source/ui_libretro/` wrapper,
  and `docs/research/libretro-core-authoring/ps2-play-core-plan.md`.
