# PlayStation & Nintendo 64 on a standalone Quest 3 — feasibility

**TL;DR.** **PSX is plausible but marginal — gate it behind a headless perf
spike. N64 is not viable** at playable speeds on a standalone Quest 3 in our
no-JIT wasm runtime. The deciding constraint is the same one that ruled out an
Amiberry-based Amiga core: **WebAssembly in the browser has no dynamic
recompiler**, so every emulated CPU/GPU instruction runs at interpreter cost.
`src/systems.js` already anticipates this — its `weight` comment flags
"N64/PSX/Saturn" as heavy cores that "should be capped to one live instance."

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
