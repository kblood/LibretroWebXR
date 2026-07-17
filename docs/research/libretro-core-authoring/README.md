# Creating / porting a libretro core — general primer

This project has never *authored* a libretro core from scratch, but it has
now done the "get an existing core building for Emscripten" job twice
(`puae` — success, see [[../../AMIGA_CORE_BUILD.md]]; `virtualxt` — attempted,
boot-traps, see [[../../DOS_CORE_BUILD.md]]). This doc distills what those two
attempts taught us into a reusable checklist, for PS2 or any future system.

## What a libretro core actually is

A shared library (`.so`/`.dll`/`.wasm`) exporting a small, fixed C ABI that a
frontend (RetroArch, or this project's `EmulatorClient`) calls into:

- `retro_init` / `retro_deinit` — lifecycle
- `retro_get_system_info` / `retro_get_system_av_info` — what content
  extensions it accepts, native resolution/framerate
- `retro_load_game` / `retro_unload_game` — mount content
- `retro_run` — advance one frame; calls back into the frontend for
  video/audio/input each call
- `retro_serialize_size` / `retro_serialize` / `retro_unserialize` — save
  states, **also what this project's netplay host↔late-joiner sync is built
  on** — a core without working serialize is a core that can't join this
  project's multiplayer model, full stop
- `retro_set_environment` + the `RETRO_ENVIRONMENT_*` callback family — how a
  core asks for things (HW-accelerated rendering context, variables/core
  options, controller port info, log interface, etc.)
- `retro_set_controller_port_device` + `RETRO_DEVICE_*` — this is the device
  abstraction this project's whole gun/mouse peripheral system depends on
  (`RETRO_DEVICE_LIGHTGUN`, `RETRO_DEVICE_MOUSE`, subclasses like
  `RETRO_DEVICE_SUBCLASS(LIGHTGUN, id)` for Super Scope/Phaser/Menacer — see
  [[../../LIGHTGUN_SUPPORT.md]])

Full header: `libretro.h` (every core repo vendors a copy, usually under
`libretro-common/include/` or `deps/libretro/`).

## The three ways a "new core" question actually resolves

1. **Already a libretro core, prebuilt on the buildbot.** Just fetch it
   (`scripts/fetch-cores.mjs`). This is 90% of `CORES` in `src/systems.js`.
   Zero build work.
2. **Already a libretro core, but not on the buildbot for Emscripten.** The
   `puae` and `virtualxt` situation. The work is a *build*, not new C++:
   vendor the core source + RetroArch, pin an emsdk version, compile the core
   to LLVM bitcode (`emmake make -f Makefile platform=emscripten`), link it
   against RetroArch's `Makefile.emscripten` frontend
   (`LIBRETRO=<corename>`), producing `MODULARIZE=1 EXPORT_ES6=1` output
   (`export default libretro_<name>`) — the shape `EmulatorClient` already
   loads for every `style: 'module'` core. **Full recipe:**
   [[../../AMIGA_CORE_BUILD.md]].
   - Risk: the core's own build system may not have an emscripten path at
     all (VirtualXT's frontend is written in Odin with no emscripten
     backend), or the buildbot's own attempt may boot-trap for reasons
     unrelated to this project (VirtualXT again — see
     [[../../DOS_CORE_BUILD.md]]).
   - **Check this first, always**, before assuming new C++ is needed — most
     "we need a new core" asks are actually "we need a new build" asks in
     disguise.
3. **No libretro core exists for this engine at all** (or one exists but is
   missing a capability this project needs, e.g. light gun input). This is
   real core-authoring work: write a `libretro.cpp`/wrapper file implementing
   the ABI above against the engine's existing (non-libretro) API — every
   mature emulator has an internal "run one frame," "read/write memory,"
   "save/load state," "poll input" surface already, since that's what its
   *other* frontends (Qt, SDL, Android, iOS…) call. The wrapper is glue, not
   a rewrite. Best available reference for "what does this glue look like":
   an existing libretro core for a similar-complexity system (e.g.
   `genesis_plus_gx`'s or `snes9x`'s `libretro.cpp` in their respective
   repos) plus the target engine's own other frontends as a map of what
   internal API to call.

## Decision checklist before committing to any of the three paths

- [ ] Does a libretro core already exist for this engine? (Check the engine's
      own repo for a `libretro`/`ui_libretro`-style directory *before*
      assuming you'd write one — engines that support multiple frontends
      often already have one, even if it's never been built for Emscripten.)
- [ ] Does *anything* in this engine already compile under Emscripten? A
      working non-libretro Emscripten build (even a totally different
      frontend) is strong evidence the core engine itself is portable — the
      hard part (getting the CPU/GPU/audio emulation to compile and run in a
      wasm sandbox) is proven; only the frontend glue differs.
- [ ] Does the engine's hot path depend on writing and executing real native
      machine code at runtime (a classic x86/ARM JIT)? If yes, and there's no
      Emscripten-targeting code generator backend, that's a hard wall — wasm
      sandboxes cannot execute self-generated native code in-place. (This
      *can* be worked around — see the PS2 plan for a real example of a
      project that built a WebAssembly-bytecode-targeting code generator
      instead — but that's a major undertaking, not a build-flag fix.)
- [ ] Does the target need GPU-accelerated rendering (`RETRO_HW_CONTEXT_*`)?
      Check whether another frontend in the same engine already proves the
      OpenGL(ES)-via-WebGL2 path works under Emscripten
      (`-sUSE_WEBGL2=1`) — if so, the libretro core's HW-render callback path
      is very likely adaptable with modest effort, not a rewrite.
  <br>*(GS/GPU adaptation is real remaining PS2 work — the ui_js frontend
  proves the WebGL2 path exists on this engine, but ui_libretro's HW-render
  glue hasn't been checked against Emscripten specifically. Verify before
  committing effort — don't assume from the ui_js precedent alone.)*
- [ ] Does the core need input devices this project relies on
      (`RETRO_DEVICE_LIGHTGUN`, `RETRO_DEVICE_MOUSE`)? Check the ABI wrapper's
      input file directly (grep for `RETRO_DEVICE_`) — don't assume from the
      engine's *other* frontends having that feature (e.g. Play!'s Qt/desktop
      frontend has GunCon aiming; its libretro wrapper currently does not).
- [ ] What license? This project tracks a `license` field per core in
      `src/systems.js` `CORES` and documents constraints in
      [[../../LICENSING.md]] — check before investing build effort, not after.
- [ ] What `weight` in the rack budget (`RackBudget.js`)? A core this heavy
      is very likely a solo-slot system (see `src/systems.js` weight-tier
      comment) — decide this before promising rack-mode support.

## Cross-references

- [[../ps2-feasibility.md]] — where this general checklist got exercised for
  real; see the PS2-specific plan in this same folder for the worked example.
- [[../../AMIGA_CORE_BUILD.md]], [[../../DOS_CORE_BUILD.md]] — the two prior
  build attempts this checklist is distilled from.
- [[../../LIGHTGUN_SUPPORT.md]], [[../../MOUSE_SUPPORT.md]] — this project's
  device-wiring conventions once a core's ABI surface is confirmed to
  support the needed `RETRO_DEVICE_*`.
