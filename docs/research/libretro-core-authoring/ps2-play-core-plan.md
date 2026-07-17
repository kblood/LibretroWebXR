# PS2 via a new `Play!`-based libretro core — build plan

## Update (2026-07-17, later same day) — items 2 and 3 done; core boots real content

Item 2 ("build `ui_libretro` for Emscripten") and item 3 ("wire
`RETRO_DEVICE_LIGHTGUN`") are both done, not just planned. The core now boots
real content end-to-end through the actual `EmulatorClient`/`systems.js`
integration (not the item-1 bypass harness), and `SET_CONTROLLER_INFO`
confirms `"PS2 GunCon2"` registers correctly as a controller option. Getting
from the item-1 spike to a real boot took five more layered build/runtime
bugs (thread-spawn crash under non-pthread Emscripten, pthread worker-script
404, cross-realm Wasm-JIT import table, missing Emscripten exports, missing
indirect-table growth, WebGL1-vs-WebGL2 context mismatch) plus a
main-thread-freeze fix (`retro_run()` was blocking the browser's main thread
indefinitely waiting on the GS mailbox). Full writeup, exact patches, and
verification methodology for all of it: [[../../PS2_CORE_BUILD.md]].

Still open, per that doc's "Remaining work": GunCon2 *input polling* during
real gameplay (only tested against a no-input homebrew ELF so far, needs a
real GunCon2-compatible ISO), a minor non-blocking WebGL texture-parameter
warning, item 4 (`-msimd128`), and item 5 (rack weight — unchanged, still
not rack-eligible).

## Update (2026-07-17, same day) — the spike ran, and it worked

Item 1 below ("GS/HW-render-under-Emscripten spike") is done, not just
planned: `ui_libretro` now builds and links for Emscripten, boots a real
open-source PS2 homebrew ELF with no BIOS needed, and the HW-render path
issues real, continuous WebGL draw calls that produce actual non-black
pixel output. Three real build/link issues were found and fixed along the
way (a CMake include-order bug that silently disabled the JS platform
detection and pulled in desktop-only GLEW; a zlib CMake target collision;
missing `--bind`/`-fexceptions` link flags for Play!'s Embind-based Wasm-JIT
and C++ exception use). Full recipe, exact patches, and the render-path
verification methodology: [[../../PS2_CORE_BUILD.md]]. This doc's items
2-5 (release rebuild, light gun wiring, SIMD, rack weight) are still open.

Supersedes the "skip it" verdict in [[../ps2-feasibility.md]]. That doc's
2026-07-16/17 passes were working from secondhand reviews and doc summaries.
This pass reads the actual source of `jpd002/Play-` (the `Play!` PS2
emulator) directly, and the picture is materially better than either prior
pass concluded. **Correcting the record here rather than quietly:** the
2026-07-17 addendum in the feasibility doc claimed the web build is
"interpreter-only... no JIT" — that was wrong. See below.

## The headline finding: Play! already has a real WebAssembly-targeting JIT

`Play!` uses a cross-platform JIT framework called **Jitter** (its own IR +
per-target code generator backends — x86, x86-64, AArch32, AArch64, **and
Wasm**). The Wasm backend is a real, mature, separate submodule:
[`jpd002/Play--CodeGen`](https://github.com/jpd002/Play--CodeGen)
(`Jitter_CodeGen_Wasm.cpp`, `_64.cpp`, `_Fpu.cpp`, `_Md.cpp`,
`_LoadStore.h` — five files, not a stub).

How it works, confirmed by reading the code:

- Compiles PS2 EE (MIPS R5900) basic blocks into **real WebAssembly
  bytecode** at runtime (`CWasmModuleBuilder`, raw `Wasm::INST_*` opcode
  emission — `m_functionStream.Write8(...)`), then almost certainly hands
  that to the browser's native `WebAssembly.compile`/`instantiate` (called
  from the Emscripten/JS glue layer). This sidesteps the actual wasm-sandbox
  limitation (a module can't self-modify or JIT *into its own* linear
  memory) by generating **separate** wasm modules and dynamically linking
  them in — a different, already-real technique from the not-yet-implemented
  `jit-interface`/`func.new` browser proposal (Phase 1 of 5 — see the
  feasibility doc's earlier addendum). Nothing about Play!'s JIT depends on
  that proposal.
- **Emits real WebAssembly SIMD (`v128`) instructions** for vector-unit code
  (`Jitter_CodeGen_Wasm_Md.cpp` — `INST_V128_*`, `INST_I32x4_*`,
  `INST_PREFIX_SIMD`) — the EE's 128-bit register file and the VU0/VU1
  vector co-processors are exactly the part of a PS2 that benefits most from
  this, and it's already wired.
- `Source/ui_js/Ps2VmJs.cpp` (the existing `Play!.js` browser frontend)
  explicitly includes `Jitter_CodeGen_Wasm.h` and registers native "proxy"
  callback functions (`MemoryUtils_Get/SetByteProxy`, `LWL/LWR/SWL/SWR_Proxy`
  for unaligned loads/stores) that JIT-generated code calls out to — this is
  the JIT actually wired into the shipping browser build, not dead code.

**What the "JIT cache can't be invalidated" limitation (from the earlier
addendum) actually means**, now that the JIT's real: wasm can't
write-protect memory pages, so Play! can't *detect* when a game
self-modifies its own EE code at runtime and invalidate the stale compiled
block the way a native build does via `mprotect` + a segfault trap. That's a
correctness risk for the subset of games that self-modify code at runtime —
not evidence of "no JIT." Games that don't do that are unaffected.

**Revised read on the "choppy, slow, fidgety" Play!.js reviews** (Virtua
Fighter 4, per the earlier addendum's sourcing): with a real CPU JIT+SIMD
confirmed, the GPU/Graphics Synthesizer emulation path
(`GSH_OpenGLJs.cpp`, HLE/LLE rendering via WebGL2) is now the more likely
bottleneck for a 3D-heavy title, not CPU interpretation. **This is inference,
not verified** — nobody has profiled it. Don't repeat it as fact without
checking; it's the first thing a spike should confirm or kill.

## The second headline finding: Play! already ships a libretro core wrapper

`Source/ui_libretro/` in the same repo — **a complete, separate libretro ABI
implementation**, distinct from the `Play!.js` (`ui_js`) browser frontend:

| File | What it does |
|---|---|
| `main_libretro.cpp` | Core `retro_*` lifecycle. **`retro_serialize`/`retro_unserialize`/`retro_serialize_size` are implemented** (confirmed present, lines ~242-280) — save states work, and this is what this project's netplay host↔late-joiner sync needs (see [[../../MULTIPLAYER.md]]). |
| `GSH_OpenGL_Libretro.cpp/h` | GPU backend via libretro's HW-render callback (`RETRO_HW_CONTEXT_OPENGLES3`/`OPENGL_CORE`, confirmed at `main_libretro.cpp:512-526`) — standard libretro convention, same category of thing this project's other GPU-using cores already do. |
| `PH_Libretro_Input.cpp/h` | Input. **Confirmed: `RETRO_DEVICE_JOYPAD` and `RETRO_DEVICE_ANALOG` only.** No `RETRO_DEVICE_LIGHTGUN` anywhere in this file. Blocker 1 from the original feasibility doc is **real and still open** for this specific core — GunCon input exists in Play!'s *other* frontends (mouse-based, per the desktop docs) but was never wired into this libretro wrapper. |
| `SH_LibreAudio.cpp/h` | Audio via libretro's audio callback. |
| `CMakeLists.txt` | Builds this target for desktop/Android platforms (per the original feasibility doc, Play!'s libretro core ships prebuilt for Android/Linux/Windows/macOS on the buildbot). **No Emscripten preset exists for `ui_libretro`** — only `ui_js` has the `wasm-ninja-release`/`wasm-ninja-debug` CMake presets. This is the concrete build gap, not a research unknown: the engine demonstrably compiles for Emscripten (`ui_js` proves it, live at playjs.purei.org); this specific *frontend target* has just never been pointed at that toolchain. |

License: `Play!` is BSD-2-Clause-style (`License.txt`, copyright Jean-Philip
Desjardins) — permissive, no copyleft concern, cleaner than several cores
already in `CORES` (e.g. `snes9x`/`genesis_plus_gx` are tagged
"Non-commercial", `gearsystem` is GPLv3).

## What this changes vs. the original "skip" verdict

The original doc's two blockers were "no light gun support" and "no
Emscripten/wasm build, one tier harder than N64 on the no-JIT wall." Now:

- **No Emscripten build** — **wrong**, and more specifically wrong than the
  2026-07-17 addendum realized: not only does an Emscripten build exist
  (`Play!.js`), the engine has a **real wasm-native JIT with SIMD**, not an
  interpreter. This was the single biggest technical risk in the entire
  investigation and it's already solved, by someone else, shipping today.
- **No light gun support** — **still true**, specifically for the libretro
  wrapper (`ui_libretro`). This is now the smaller of the two original
  blockers: it's a well-scoped wiring task, not a research risk. This
  project has done the equivalent for five other systems already (see
  [[../../LIGHTGUN_SUPPORT.md]]'s per-core table) — same shape of work, new
  engine.
- **Not a libretro core** — this was *my* framing from the prior session
  turn, and it was **incomplete, not just wrong**: I'd only checked the
  standalone `Play!.js` frontend and concluded the engine wasn't packaged as
  a libretro core at all. It is — `ui_libretro` exists, upstream, already
  building for four other platforms. The actual gap is narrower: get that
  *specific* existing frontend building for Emscripten, which is a build
  problem with a proven-similar precedent in this repo
  ([[../../AMIGA_CORE_BUILD.md]]), not an integration-architecture problem.

## The real remaining work, in order of risk (highest first)

1. **GS/HW-render-under-Emscripten spike.** Does `GSH_OpenGL_Libretro.cpp`'s
   `RETRO_HW_CONTEXT_OPENGLES3` path work when compiled for Emscripten,
   given the frontend providing the GL context will be RetroArch's emscripten
   platform code (used by every other buildbot core in `CORES`) instead of
   Play!'s own `GSH_OpenGLJs.cpp`? `ui_js` proves *a* WebGL2 path works on
   this engine, but that's a different code path (Play!'s own GL glue, not
   libretro's HW-render convention) — **do not assume this transfers without
   testing.** This is the single highest-uncertainty item and should be the
   first thing spiked, before investing in the rest.
2. **Build `ui_libretro` for Emscripten.** Concretely: add an
   Emscripten CMake preset for the `ui_libretro` target (parallel to the
   existing `wasm-ninja-release` preset for `ui_js`), following the
   `puae` recipe shape from [[../../AMIGA_CORE_BUILD.md]] — pin an emsdk
   version, compile to bitcode, link against RetroArch's
   `Makefile.emscripten` (`LIBRETRO=play`), `MODULARIZE=1 EXPORT_ES6=1`
   output. Real work, no unknown blockers identified so far — the engine's
   Emscripten-compilability is already proven by `ui_js`.
3. **Wire `RETRO_DEVICE_LIGHTGUN` into `PH_Libretro_Input.cpp`.** Find
   Play!'s internal GunCon controller-state struct (used by its other
   frontends' mouse-based aiming — not yet located, needs a follow-up read of
   `Source/Pad*` or equivalent) and feed it from
   `g_input_state_cb(port, RETRO_DEVICE_LIGHTGUN, 0, RETRO_DEVICE_ID_LIGHTGUN_*)`
   instead of raw mouse events, matching the pattern in
   [[../../LIGHTGUN_SUPPORT.md]] for the other five gun-capable systems.
4. **Enable `-msimd128`/`-mfpu=neon` for the AOT-compiled (non-JIT)
   portions.** Separate, smaller lever, already documented in
   [[../ps2-feasibility.md]]'s SIMD addendum — the JIT's own SIMD use doesn't
   depend on this flag (it emits raw wasm bytecode directly), but
   `Vif.h`/`GSH_OpenGL_Texture.cpp`'s statically-compiled SSE2-emulation path
   does.
5. **Rack weight.** Not rack-eligible regardless of how the above goes —
   PS2 is well past N64/PSX on `RackBudget.js`'s weight scale; plan for a
   solo-slot system from the start, same as this project already treats any
   `weight: 3+` core.

## Recommended next step

A cheap, bounded **spike** on item 1 (GS/HW-render under Emscripten) before
committing to item 2's real build effort — if the GPU path doesn't adapt,
that changes the shape of the whole plan (software-render fallback? skip
gun-game titles that lean hardest on GS features?) before multi-day build
work is sunk into it. This mirrors the "measured spike before full build"
pattern [[../psx-n64-feasibility.md]] already recommended for PSX and never
ran — worth doing that PSX spike too, since it's a cheaper version of the
same no-JIT-wall question this whole investigation started from, and would
be a useful calibration point before the PS2 spike.

## Open questions for whoever picks this up

- Where does Play!'s GunCon controller-state live internally (need to find
  it to complete item 3)?
- Has anyone attempted an Emscripten build of `ui_libretro` in a fork
  (`xerpi/play-switch*`, `Provenance-Emu/Provenance`, and others turned up
  during this research all vendor `Play--CodeGen` — worth a quick check
  before starting item 2 from scratch)?
- Real FPS numbers, on real hardware, for a light-gun-relevant title (Time
  Crisis 3 was named as GunCon-calibratable in the general docs) — nothing
  in this investigation is a substitute for actually running it.

## Sources

- [jpd002/Play-](https://github.com/jpd002/Play-) — `Source/ui_js/`,
  `Source/ui_libretro/`, `Source/ee/Vif.h`, `License.txt`
- [jpd002/Play--CodeGen](https://github.com/jpd002/Play--CodeGen) —
  `src/Jitter_CodeGen_Wasm*.cpp`, `include/WasmDefs.h`
- [jpd002/Play--Framework](https://github.com/jpd002/Play--Framework) —
  `include/SimdDefs.h`
