# Source Projects Overview

Five prototypes live under `source-projects/`. This document summarizes what each one is, the state it is in, and what to harvest from it for the new project.

---

## 1. `webretro/` — most advanced, primary reference

**What it is:** A fork of [binbashbanana/webretro](https://github.com/binbashbanana/webretro) (RetroArch compiled to WASM via Emscripten, v6.5 upstream) with WebXR support and worker-based cores bolted on. Last touched 2025-06-08.

**Bundled libretro cores (24):** a5200, Beetle NeoPop, Beetle PSX HW, Beetle VB, Beetle WonderSwan, FreeChaF, FreeIntv, Gearcoleco, Genesis Plus GX, Handy, melonDS, mGBA, Mupen64Plus-Next, NeoCD, Nestopia UE, O2EM, Opera, ParaLLEl N64, ProSystem, Snes9x, Stella 2014, Vecx, Virtual Jaguar, Yabause.

**Key files to study:**
- `webxr.js` (43 KB) — Three.js VR scene, controller-to-keyboard input mapping, multiple fallback strategies for getting the emulator canvas onto a textured plane.
- `assets/worker-core-manager.js` (10.7 KB), `assets/webxr-worker-integration.js` (10.1 KB), `assets/webretro-worker-integration.js` (23.1 KB), `assets/webxr-worker-hook.js` (12.0 KB) — runtime patches that detect worker-capable cores and swap them in.
- `cores/snes9x_libretro.js` (232 KB) + `snes9x_libretro.wasm` (4.6 MB) — the *only* core actually rebuilt with `PROXY_TO_PTHREAD=1 HAVE_WASMFS=1`.
- `production-server.py` — Python server that sets `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Opener-Policy: same-origin` so `SharedArrayBuffer` is enabled.
- `build-worker-cores.sh`, `build-cores.bat` — Emscripten build recipes.
- `VR_ROOM_PLAN.md` — the "retro gaming room" design (cartridges as ROMs, virtual console, virtual screen, virtual controller).
- `Overview.md` — a very thorough deep-dive on how `webxr.js`, `base.js`, and `emulator-worker.js` interact. Read this before doing anything.

**What it solved:**
- **VR freezing on Quest / standalone headsets.** When a WebXR session starts, browsers mark the page "hidden"; `requestAnimationFrame` stops and `setTimeout` throttles to ~1 fps. Moving the emulator into a Web Worker with `PROXY_TO_PTHREAD` keeps the main loop alive.
- **Getting `SharedArrayBuffer` to work** with proper COOP/COEP headers.
- **Routing VR controller buttons to the emulator** via a `fakeKey()` shim that posts `input_event` messages to the worker.
- **Persisting last core + ROM** to `localStorage` so the worker can be restarted into a fresh VR canvas on `sessionstart`.

**What it did poorly (don't carry over):**
- The whole worker-integration layer is **runtime monkey-patching** of upstream `base.js` and the Emscripten module. Functions like `initFromFile` and `restartEmulatorWithCanvas` are wrapped or injected. This is fragile — any upstream change breaks it.
- Two emulator instances exist at different times (a "browser emulator" and a "VR emulator") and one has to be torn down on `sessionstart`. This is the source of the messiest code paths.
- Only **SNES9X** was actually rebuilt as a worker core. Every other system still uses legacy single-threaded cores that will freeze in standalone VR.
- `webxr.js` does aggressive things — polyfilling `document` inside the worker, patching Emscripten's `preMainLoop`, intercepting null function calls — to work around quirks of the older SNES9X port. These patches are tightly coupled to that one core.
- VR room (cartridges, virtual console) from `VR_ROOM_PLAN.md` is **not implemented**; the VR view today is just a floating plane with the emulator on it.

**What to harvest:**
- Worker-core architecture (`PROXY_TO_PTHREAD=1 HAVE_WASMFS=1 OFFSCREENCANVAS_SUPPORT=1 PTHREAD_POOL_SIZE=4`).
- COOP/COEP server config from `production-server.py`.
- Controller-input-to-key mapping table in `webxr.js` (`vrToEmuMap`).
- ROM/state persistence pattern in `localStorage` / IndexedDB.
- The 24 already-built (non-worker) `.wasm` cores — useful as a fallback path even in the new project.
- The Emscripten build scripts.

---

## 2. `webretro - Kopi/` — older snapshot of webretro

Same upstream lineage as `webretro/`, dated 2025-05-10. `webxr.js` is **135 KB monolithic** — all the WebXR + worker-integration logic stuffed into one file. The `webretro/` fork later split this into a smaller `webxr.js` plus four `*-worker-integration.js` modules.

**Useful for:** seeing the "before refactor" version of the WebXR bridge in one place. If anything is missing from the split version, it is probably still in here.

**Not useful for:** anything else — it predates the worker-core production server and the integration docs. Treat as a read-only archive.

---

## 3. `webretro2/` — earliest WebXR experiment in this lineage

Dated 2025-05-07. `webxr.js` is only 30 KB. No worker cores, no production server, no VR room plan. This is essentially "vanilla webretro upstream + first attempt at adding a Three.js plane in a WebXR session." No `*-worker-integration.js` files yet.

**Useful for:** seeing the minimum viable webxr.js, before all the worker-freeze workarounds were piled on. If we want to understand what the bare-minimum bridge looks like, start here.

**Not useful for:** running on Quest — the emulator will freeze on `sessionstart`.

---

## 4. `WebEmu/` — clean Three.js + libretro web emulator, no WebXR

Dated 2025-05-04. A from-scratch attempt at the same "emulator on a screen in a 3D room" idea, but with a much cleaner architecture than the webretro family. Built around a small set of classes:

- `EmulatorCore` — WebAssembly libretro core manager
- `ThreeJsEnvironment` — Three.js scene + screen mesh
- `InputManager` — keyboard / gamepad → emulator buttons, with a `Tab` toggle between "emulator mode" and "environment mode"
- `AssetLoader` — ROMs, textures, GLB models
- `AudioProcessor` — emulator audio → Web Audio API

**Key files to study:**
- `RetroEmulatorProjectPlan.md` — phased plan, very readable.
- `TechnicalImplementationGuide.md` — ~730 lines of skeleton code showing how the classes fit together, including a CRT-effect shader, a frame-skipper for low-end devices, and `nextPowerOfTwo` texture sizing.
- `README.md` — user-facing controls (`Tab` toggles emulator/environment, WASD to navigate the 3D scene).
- `public/cores/*.{js,wasm}` — same set of legacy cores as webretro (no worker builds).

**What it did well:**
- Clean class boundaries — the `EmulatorCore` and `ThreeJsEnvironment` don't know about each other; the app wires them up.
- Multiple selectable environments (living room, arcade, retro room) with selectable shaders (CRT, scanlines, pixelated).
- Environment-vs-emulator input modes — a primitive but useful pattern that maps directly to "in VR you can walk around, then look at the screen to play."

**What it lacked:**
- **No WebXR.** It only mentions "WebVR/WebXR" as a future enhancement.
- Cores are unmodified legacy single-threaded builds.
- No worker isolation — same `requestAnimationFrame` freeze risk if you were to add a VR session.

**What to harvest:**
- The class architecture (`EmulatorCore`, `ThreeJsEnvironment`, `InputManager`, `AudioProcessor`). This is the structure the new project should use.
- The phased implementation plan in `RetroEmulatorProjectPlan.md`.
- The CRT shader and frame-skipper in `TechnicalImplementationGuide.md`.
- The mode-toggle input pattern.

---

## 5. `LibretroUnity/` — Unity C# port, design reference only

Dated 2025-05-01. A Unity project that loads libretro cores natively (P/Invoke, not WASM) and renders frames to a `Texture2D` on a `MeshRenderer`. Targets Unity XR (OpenXR / Quest standalone build, not WebXR).

**Key files:**
- `LibretroWrapper.cs` (36 KB) — full P/Invoke surface for the libretro C API: `Geometry`, `Timing`, `GameInfo`, pixel-format conversions, retro_run / retro_load_game wrappers.
- `EmulatorDisplay.cs` — sets up a per-frame `Texture2D.LoadRawTextureData()` blit onto a quad positioned in front of the VR camera.
- `InputMapper.cs` (12 KB) + `InputMapperUI.cs` (11 KB) + `KeybindingProfile.cs` + `KeybindingManager.cs` — full input remapping system using the new Unity Input System.
- `CoreLoader.cs`, `FileBrowser.cs`, `APKReader.cs`, `APKTool.cs` (the APK ones are for sideloading on a Quest build).
- `Libretro Integration Plan.md` — the architectural plan (CoreManager / ROMManager / EmulationManager / VirtualDisplay / InputMapper / AudioManager / SaveStateManager).

**What it offers the new project:**
- A clean reference for **libretro's C API shape and pixel-format handling**. The WASM cores expose the same API; if anything is unclear about how to drive a core directly (instead of through RetroArch's frontend), this is the cleanest read.
- A well-thought-through **input mapper** model — separate profiles per system, runtime remapping UI.
- Aspect-ratio and per-system geometry handling on the display quad.

**What is not relevant:** the Unity rendering, the APK tooling, anything OpenXR-specific. The new project is browser-only.

---

## Comparison table

| Project | Date | Tech stack | WebXR? | Worker cores? | VR room? | Architecture |
|---|---|---|---|---|---|---|
| `webretro/` | Jun 2025 | RetroArch WASM + Three.js | Yes (works) | Yes (SNES9X only) | Planned, not built | Monkey-patches on upstream |
| `webretro - Kopi/` | May 10 | Same | Yes (older) | Partial | No | Monolithic webxr.js |
| `webretro2/` | May 7 | Same | Yes (minimal) | No | No | Minimal bridge |
| `WebEmu/` | May 4 | Three.js + libretro WASM | No | No | "Living room" / "arcade" 3D scene only | Clean class-based |
| `LibretroUnity/` | May 1 | Unity + native libretro | No (OpenXR) | N/A | Planned | Unity components |

## Recommendation

Start the new project from a **clean WebEmu-style architecture** (`EmulatorCore` / `Scene` / `InputManager` / `AudioProcessor`), then port in **webretro's worker-core build pipeline and `SharedArrayBuffer` server**, and consult **LibretroUnity** when implementing the input mapper and per-core geometry handling.

Do **not** start by editing `webretro/` again — every previous attempt to extend it has produced another fork because the patching layer makes upstream-merging painful. The new project should be designed for WebXR from day one, so the worker-vs-main-thread split and the OffscreenCanvas-to-VR-texture flow are part of the architecture, not retrofitted.
