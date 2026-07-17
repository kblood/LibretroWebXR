# Building the PS2 (Play!) core for the web

Play! (`jpd002/Play-`) ships a libretro core wrapper (`Source/ui_libretro/`)
but has never had it built for Emscripten before — only `Source/ui_js/`
(the separate `Play!.js` standalone frontend) has ever targeted the web. This
doc is the recipe that got `ui_libretro` building and booting for the first
time, done as a spike per [[research/libretro-core-authoring/ps2-play-core-plan.md]].
Output is a standard `MODULARIZE=1 EXPORT_ES6=1` module
(`export default libretro_play`) — same shape `EmulatorClient` already loads.

Built 2026-07-17 on WSL2 Ubuntu, using the same emsdk pin as
[[AMIGA_CORE_BUILD.md]] (3.1.46). Result: `play_libretro.wasm` ≈ 4.8 MB,
`play_libretro.js` ≈ 320 KB, `play_libretro.worker.js` ≈ 2 KB (pthreads
require the worker bootstrap file — see step 7).

This core boots real content end-to-end via the actual `EmulatorClient` API
(not a bypass harness) — see "Verified: real content boot via EmulatorClient"
below. Getting there past the initial GS/HW-render spike required five more
fixes (thread-spawn crash, worker-script 404, cross-realm JIT table, missing
Emscripten exports, missing table growth, WebGL1/2 mismatch) plus a
main-thread-freeze fix, all folded into the recipe below.

## Recipe

```bash
# 1. emsdk (same pin as the Amiga build)
source ~/emsdk/emsdk_env.sh   # already installed at 3.1.46

# 2. Source
mkdir -p ~/play-build && cd ~/play-build
git clone https://github.com/jpd002/Play-.git
cd Play-

# 3. REQUIRED PATCH — Source/ui_libretro/CMakeLists.txt calls include(Header)
#    BEFORE project(). Header.cmake's platform-detection guard only fires
#    when CMAKE_CURRENT_SOURCE_DIR == CMAKE_SOURCE_DIR (i.e. this file is the
#    CMake root, which it is here — we configure ui_libretro standalone, not
#    through the top-level Play- CMakeLists.txt). But the Emscripten
#    toolchain file (which sets the EMSCRIPTEN variable Header.cmake checks)
#    only loads during the FIRST project()/enable_language() call — and here
#    project() comes AFTER include(Header). So on the very first configure,
#    EMSCRIPTEN reads as unset, Header.cmake's elseif(EMSCRIPTEN) branch is
#    skipped, and it silently falls through to the Unix branch instead of
#    setting TARGET_PLATFORM_JS. Downstream this makes FrameworkOpenGl's
#    CMakeLists.txt turn USE_GLES off and USE_GLEW on — GLEW is a desktop-only
#    GL function-pointer loader, meaningless (and uncompilable — glewInit,
#    GLEW_OK etc. all undeclared) under Emscripten's native GL bindings. Fix:
#    swap the two lines so project() runs first.
#
#    sed -n '1,9p' Source/ui_libretro/CMakeLists.txt should read:
#      cmake_minimum_required(VERSION 3.18)
#      project(Play_Libretro_Core)
#      set(CMAKE_MODULE_PATH ...)
#      include(Header)

# 4. REQUIRED PATCH — deps/libchdr/deps/zlib-1.3.1/CMakeLists.txt builds BOTH
#    a `zlib` (SHARED, auto-downgraded to STATIC under Emscripten) and a
#    `zlibstatic` (STATIC) target, and sets OUTPUT_NAME "z" on both — harmless
#    on native platforms (.so vs .a extensions differ) but a ninja
#    "multiple rules generate libz.a" hard error once both are STATIC. Gate
#    the `zlib` target (and every property/install rule that references it)
#    behind `if(NOT EMSCRIPTEN)`, and set zlibstatic's OUTPUT_NAME to "z"
#    only in the EMSCRIPTEN branch. (Diff is mechanical — every reference to
#    the `zlib` target gets `NOT EMSCRIPTEN` added to its guard; `zlibstatic`
#    is untouched except gaining the OUTPUT_NAME line under `if(EMSCRIPTEN)`.)

# 5. Configure + build ui_libretro directly as the CMake root (not through
#    the top-level Play- CMakeLists.txt — that would also try to build
#    ui_qt/ui_js/tests, none of which we want here). CMAKE_*_FLAGS add
#    -pthread -s SHARED_MEMORY: CPS2VM::Initialize() (PS2VM.cpp) spawns a
#    real std::thread to run EE/IOP CPU emulation (EmuThread) — under
#    Emscripten WITHOUT pthreads, std::thread's constructor throws
#    ("thread constructor failed: Resource temporarily unavailable"),
#    which RetroArch swallows into a silent fallback to its own dummy
#    core (CMD_EVENT_CORE_INIT fails, retroarch.c re-inits as
#    CORE_TYPE_DUMMY) — this was the original "content never loads, no
#    visible error" mystery, and looks nothing like a threading problem
#    from the RetroArch side.
mkdir build-emscripten && cd build-emscripten
emcmake cmake -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS='-pthread -s SHARED_MEMORY' \
  -DCMAKE_C_FLAGS='-pthread -s SHARED_MEMORY' \
  -DBUILD_LIBRETRO_CORE=ON -DBUILD_PLAY=OFF -DBUILD_TESTS=OFF \
  ../Source/ui_libretro
ninja -j$(nproc)
# → play_libretro.a (just the 4 ui_libretro object files; dependencies are
#   16 separate .a files elsewhere under build-emscripten/)

# 6. Combine every produced .a into one archive (Makefile.emscripten's link
#    step expects a single libretro_emscripten.a, not many)
mkdir ~/play-build/combine && cd ~/play-build/combine
i=0
for a in $(find ~/play-build/Play-/build-emscripten -name '*.a' | sort); do
  i=$((i+1)); mkdir "obj_$i"; (cd "obj_$i" && emar x "$a")
done
emar rcs libretro_emscripten.a obj_*/*.o

# 7. REQUIRED Makefile.emscripten PATCHES. Four total — the first two were
#    needed even for the original bypass-harness spike; the last two are
#    what got a REAL boot through RetroArch's own content-loading pipeline
#    (`-c retroarch.cfg /rom/rom.elf`) working.
#
#    7a. LIBRETRO=play-only LDFLAGS (near the other `ifeq ($(LIBRETRO), ...)`
#        conditionals):
#      ifeq ($(LIBRETRO), play)
#         LDFLAGS += --bind -fexceptions -s ALLOW_TABLE_GROWTH=1
#      endif
#    Why:
#      --bind        Play!'s Jitter Wasm-JIT (deps/CodeGen/src/MemoryFunction.cpp
#                     — the thing that makes this core fast; see the plan doc)
#                     uses Embind (`emscripten::val`) to hold JS handles for
#                     each JIT-compiled wasm module. Link fails with
#                     `undefined symbol: _emval_decref/_emval_incref` without it.
#      -fexceptions   Play!/RetroArch code throws real C++ exceptions during
#                     init. Header.cmake already compiles Play!'s own sources
#                     with `-fexceptions`, but that's a COMPILE flag; Emscripten
#                     also needs it at LINK time (default is
#                     DISABLE_EXCEPTION_CATCHING=1), or callMain() aborts
#                     immediately with "Exception thrown, but exception
#                     catching is not enabled" — happens before any core code
#                     you'd recognize runs, easy to misdiagnose as something
#                     PS2-specific. It isn't; it's generic Emscripten/C++.
#      ALLOW_TABLE_GROWTH  Play!'s Wasm JIT (WasmCreateFunction,
#                     Jitter_CodeGen_Wasm.cpp) grows Emscripten's indirect
#                     function table at runtime via addFunction() for every
#                     JIT-compiled code block. Without this the first
#                     JIT-compiled block throws at instantiation.
#
#    7b. Append play-specific names to EXPORTED_FUNCTIONS. Must go right
#        after the BASE `EXPORTED_FUNCTIONS = ...` definition (before
#        `EXPORTS := ...`), NOT next to the LDFLAGS block above — Make's
#        `LDFLAGS := ...` a few lines later does an IMMEDIATE expansion of
#        `$(EXPORTED_FUNCTIONS)`, so anything appended after that point is
#        silently dropped from the final link command:
#      ifeq ($(LIBRETRO), play)
#      EXPORTED_FUNCTIONS += ,_EmptyBlockHandler,_MemoryUtils_GetByteProxy,_MemoryUtils_GetHalfProxy,_MemoryUtils_GetWordProxy,_MemoryUtils_GetDoubleProxy,\
#      _MemoryUtils_SetByteProxy,_MemoryUtils_SetHalfProxy,_MemoryUtils_SetWordProxy,_MemoryUtils_SetDoubleProxy,\
#      _LWL_Proxy,_LWR_Proxy,_LDL_Proxy,_LDR_Proxy,_SWL_Proxy,_SWR_Proxy,_SDL_Proxy,_SDR_Proxy
#      endif
#    Why: see the `CPS2VM_Libretro::CreateVM()` note in step 8 below — these
#    are the same 17 extern functions, and Emscripten's `RegisterExternFunction`
#    resolves them via `Module[fctName]`, which is `undefined` unless the C
#    function is actually exported. `undefined` silently makes it all the way
#    to `WasmCreateFunction`'s `new WebAssembly.Instance()` call, which then
#    fails with a misleading `LinkError: ... table import requires a
#    WebAssembly.Table` — nothing in that error points at "missing export".
#
#    7c. HAVE_OPENGLES3=1 at build time (passed on the make command line in
#        step 9, not a source patch) — RetroArch's Emscripten WebGL context
#        driver (gfx/drivers_context/emscriptenwebgl_ctx.c) gates
#        `attrs.majorVersion` on the `HAVE_OPENGLES3` *compile-time* macro,
#        NOT on the core's requested `hw_render.context_type`/`version_major`
#        (main_libretro.cpp correctly requests RETRO_HW_CONTEXT_OPENGLES3
#        3.2, but that request is ignored unless the whole build was compiled
#        with HAVE_OPENGLES3=1). Without it you get a silent WebGL1 context
#        and a crash the first time real rendering starts:
#        `GLctx.vertexAttribIPointer is not a function` (a WebGL2-only API).
#        This changes globally-compiled files, not just the play-specific
#        link step, so switching it on requires a full `make ... clean`.

# 8. main_libretro.cpp needs its own patch, on top of Play!'s upstream code
#    (already applied under Source/ui_libretro/main_libretro.cpp in this
#    checkout — see the CPS2VM_Libretro class and the GunCon2 wiring):
#      - CPS2VM_Libretro : public CPS2VM, overriding CreateVM() to
#        pre-register the same 17 extern functions listed in 7b via
#        Jitter::CWasmFunctionRegistry::RegisterFunction(...) before calling
#        CPS2VM::CreateVM(). Necessary because Play!'s WASM JIT backend
#        lazily creates a `Module.codeGenImportTable` (a WebAssembly.Table)
#        the first time RegisterExternFunction runs — and under Emscripten
#        pthreads, each worker is a SEPARATE JS Realm with its own `Module`
#        object (they share wasm linear memory via SharedArrayBuffer, but
#        NOT arbitrary JS object state), so the CPU-emulation worker
#        (EmuThread) needs its OWN table, created on that thread. This
#        mirrors `ui_js`'s validated precedent (`CPs2VmJs::CreateVM()` in
#        Source/ui_js/Ps2VmJs.cpp).
#      - retro_run()'s call to GS's ProcessSingleFrame() uses a
#        timeout-bounded overload under __EMSCRIPTEN__ — see "Verified:
#        main-thread no longer freezes" below.

# 9. Link
cp ~/play-build/combine/libretro_emscripten.a ~/amiga-build/RetroArch/
cd ~/amiga-build/RetroArch   # reuse the same RetroArch checkout as the Amiga build
emmake make -f Makefile.emscripten LIBRETRO=play HAVE_THREADS=1 HAVE_CHD=0 HAVE_OPENGLES3=1 -j$(nproc)
# → play_libretro.js + play_libretro.wasm + play_libretro.worker.js

# 10. Vendor into the project (cores are gitignored — never committed)
cp play_libretro.js play_libretro.wasm play_libretro.worker.js <repo>/public/cores/
```

Also required, in this repo (not the WSL2 build trees): `EmulatorClient.js`'s
`locateFile` callback redirected only `.wasm` requests to `coreBase`, not
`.worker.js` — pthread-enabled cores need their worker bootstrap script
served from the same `/cores/` path, or the pthread pool's worker spawn
404s into a syntax error the first time a thread is created.

## Verified: GS/HW-render actually renders under Emscripten

This was flagged as the single highest-uncertainty item in the plan doc —
`ui_js` proves *a* WebGL2 path works on this engine, but `ui_libretro`'s
libretro-HW-render-callback path (`GSH_OpenGL_Libretro.cpp`, driven by
RetroArch's Emscripten GL glue rather than Play!'s own) had never been
checked. Confirmed **working** via a standalone spike (not yet folded into
this repo's `EmulatorClient`/`systems.js` — see below):

- Booted a minimal open-source PS2SDK homebrew ELF (`ps2sdk/samples/graph` —
  BSD/AFL-2.0, built with the `ps2dev/ps2dev` Docker toolchain image) that
  clears the GS framebuffer via real DMA/GIF packets every frame. No PS2 BIOS
  was needed for this — `CSubSystem::LoadBIOS()` (the only code that reads a
  `bios/scph10000.bin`-style file) is dead code, never called from
  `ui_libretro`'s `main_libretro.cpp`. (BIOS files ARE available locally at
  `C:\Devstuff\ROMs\PS2\bios\` if a future real-game boot test needs one —
  legitimately self-dumped, see that folder's `README.md`.)
- `retro_load_game` requires actual bootable content (`elf|iso|cso|isz|cue|chd`,
  `need_fullpath=true`) — a bare BIOS alone isn't "content."
- With `callMain()` no longer aborting (patch #7 above), RetroArch's
  Emscripten driver successfully created a real WebGL context on the target
  canvas, and over ~3s of real time the core issued a steady stream of real
  GL calls (362 `clear`, 12489 `drawArrays`) — not zero, not a one-shot no-op.
- Canvas readback (with `preserveDrawingBuffer` forced on — without it, a
  WebGL canvas reads back black regardless of whether rendering worked,
  because the browser clears the backbuffer after compositing; this tripped
  the first readback attempt and is worth remembering for any future core
  smoke test) showed 292614/307200 pixels non-black, uniformly colored,
  matching the homebrew's per-frame clear color exactly.

Harness: `tmp/verify-ps2-spike.mjs` in this repo + a standalone scratch
HTML page (not committed — lived under the session scratchpad) that imports
`play_libretro.js` directly, bypassing `EmulatorClient`/RetroArch config
entirely (`Module.arguments = ['/content/graph.elf']`, no `-c` flag). Good
enough to prove the render path; this bypass harness never exercised
RetroArch's real content-loading pipeline, which is why it hit none of the
five bugs described below.

## Verified: real content boot via EmulatorClient

The core is registered in `systems.js` (`CORES.play`, system `ps2`) and boots
real content through the actual app path — `EmulatorClient.start()` fires its
`ready` event, not a bypass harness. Getting from the spike above to this
took five more layered bugs, each silently masking the next (RetroArch gives
close to zero visible error when core init fails — it just falls back to its
own dummy core and boots to an empty menu):

1. `CPS2VM::Initialize()`'s `std::thread` constructor threw under a
   non-pthread build. Fixed: `HAVE_THREADS=1` (recipe steps 5, 9).
2. The pthread worker script (`play_libretro.worker.js`) 404'd because
   `EmulatorClient.js`'s `locateFile` only redirected `.wasm`. Fixed: see
   note after step 10 above.
3. Play!'s WASM JIT's `Module.codeGenImportTable` is per-JS-Realm, not
   shared across pthread workers — the CPU-emulation worker crashed the
   first time it tried to JIT-compile code (`LinkError: table import
   requires a WebAssembly.Table`). Fixed: `CPS2VM_Libretro` (recipe step 8).
4. The JIT's extern-function lookups need those functions in
   `EXPORTED_FUNCTIONS`. Fixed: recipe step 7b.
5. The JIT's runtime function registration needs table growth allowed.
   Fixed: `ALLOW_TABLE_GROWTH=1` (recipe step 7a).
6. RetroArch's Emscripten WebGL driver only creates a WebGL2/GLES3 context
   when the whole build has `HAVE_OPENGLES3=1` — regardless of what the core
   requests — so real rendering crashed on a WebGL1-only API the first time
   it ran. Fixed: recipe step 7c.

Harness: `tmp/verify-ps2-integration.mjs` (real `EmulatorClient`/`systems.js`
path, PS2SDK homebrew ELF) and `tmp/capture-ps2-log.mjs` (boot-log capture
only, no post-boot evaluate/screenshot).

**Correction (2026-07-17):** "boots" here only ever meant `retro_load_game`
+ `retro_run()` executing without crashing — it did **not** mean pixels
reached the canvas for this path. See the caveat at the end of the
GS/HW-render section above: the 292614/307200-non-black-pixel confirmation
used a **standalone bypass harness** that called `play_libretro.js` directly
(`Module.arguments = ['/content/graph.elf']`, no RetroArch `-c` config), not
the real `EmulatorClient`/RetroArch content-loading pipeline. Driving content
through the *real* pipeline (this section) never actually got a pixel-level
render check — and when one was finally done (GunCon2 verification below),
screenshots came back solid black for every homebrew ELF tried, including a
trivial infinite-magenta-fill-loop with zero SIF/USB logic. Root cause:
`CGSH_OpenGL::FlipImpl()` (`Source/gs/GSH_OpenGL/GSH_OpenGL.cpp`) gates the
entire present/blit call behind `if(framebuffer)`, where `framebuffer` is
resolved by matching the CRTC's configured display-layer buffer against a
cache of framebuffers Play! has seen actually rendered to — for this content
under the real pipeline, that match/creation never happens, so nothing is
ever drawn to the canvas. Real, previously-undiagnosed, and separate from the
GunCon2 driver work below — tracked in "Remaining work".

## Verified: main-thread no longer freezes

Once real content was booting, the entire browser tab froze solid the moment
the VM started running — not just slow, but genuinely unresponsive, to the
point that even a Chrome DevTools Protocol `Page.captureScreenshot` call
(pure browser-side, no page JS involved) timed out. Root cause:
`retro_run()` (main_libretro.cpp) called `CGSHandler::ProcessSingleFrame()`
every frame, which does an indefinite `std::condition_variable::wait()`
(`CMailBox::WaitForCall()`) for the `CPS2VM` EmuThread pthread worker to
finish producing a frame's worth of GS commands. `retro_run()` executes on
the browser's main/window thread — and a main thread that never returns
from a blocking wait never yields back to the browser's event loop, so
*everything* (rendering, input, DevTools) stalls for as long as the wait
takes, which during JIT warmup can be far longer than one frame.

Fix: added a timeout-bounded `CGSHandler::ProcessSingleFrame(unsigned int
timeoutMs)` overload (`Source/gs/GSHandler.h`/`.cpp` — purely additive, the
existing blocking `ProcessSingleFrame()` is untouched and still used by
every other front-end). `retro_run()` calls the bounded 4ms version under
`__EMSCRIPTEN__`: if the worker hasn't flipped a frame within the budget,
this `retro_run()` call simply skips presenting new video (RA tolerates a
duped frame) and returns control to the browser; the next call — driven by
`requestAnimationFrame` — resumes waiting where `m_flipped` left off, since
a timed-out poll doesn't touch that state.

Re-verified with `tmp/verify-ps2-integration.mjs`: `page.screenshot()`
(`Page.captureScreenshot`) now returns normally while the VM is running, and
the boot log is otherwise byte-identical in shape to the pre-fix run (same
365-line tail) — confirming the fix didn't regress anything else.

## Verified: GunCon2 input polling through the REAL USB driver stack

Goes beyond Play!'s internal `CGunCon2UsbDevice::SetGunState()` shortcut —
authored a homebrew PS2SDK test program that drives the emulated GunCon2 via
the actual USB LDD driver protocol a real PS2 driver would use:
`sceUsbdRegisterLdd` → DEVICE/CONFIGURATION/INTERFACE/ENDPOINT descriptor
scan (`sceUsbdScanStaticDescriptor`) → `sceUsbdOpenPipe` → a continuous
`sceUsbdTransferPipe` interrupt-transfer poll, parsing the real 6-byte
GunCon2Out report (`u16 buttons` active-low, `s16 posX`, `s16 posY`). Source
lives outside this repo (`~/ps2-guncon2-test/` in the WSL2 build tree — an
IOP module `iop/guncon2_ldd/guncon2_ldd.c` + a SIF-RPC bridge + an EE program
`ee/main.c`), following this project's "author own test content" pattern
(same idea as `games/nes-gallery`, `games/snes-scope`).

Verification reads state out of EE RAM directly
(`retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM)`, exported to JS by adding
`_retro_get_memory_data,_retro_get_memory_size` to `Makefile.emscripten`'s
`ifeq ($(LIBRETRO), play)` `EXPORTED_FUNCTIONS` block) rather than via
screenshots, since the `FlipImpl` bug above blanks the canvas for this
content regardless of whether the driver test itself works.

**Two real bugs found and fixed to get input actually reaching the driver:**

1. **`rwebinput` had no light-gun support at all in this checkout.** The
   existing multi-port patch (`docs/patches/rwebinput-lightgun-multiport.diff`,
   written against an older RetroArch revision) no longer applied cleanly —
   this tree's `rwebinput_input.c` has *zero* `RETRO_DEVICE_LIGHTGUN` handling
   to patch against (not even the unpatched base case the diff's context
   assumed). Hand-applied the equivalent changes: the per-port
   `rwebinput_lightgun_state_t` array, the exported
   `rwebinput_set_lightgun`/`rwebinput_clear_lightgun` setters, and a
   `case RETRO_DEVICE_LIGHTGUN:` in `rwebinput_input_state()` that falls back
   to the shared DOM mouse when no per-port state has been set — same shape
   as the original patch, plus `_rwebinput_set_lightgun,_rwebinput_clear_lightgun`
   in `Makefile.emscripten`'s base `EXPORTED_FUNCTIONS`. Rebuilt
   `play_libretro.js`/`.wasm` with both this and the `retro_get_memory_data`
   export.
2. **`inputDevices` keys are 1-based player numbers, not 0-based libretro
   ports.** `EmulatorClient.js`'s remap-file writer only treats
   `Number(player) >= 1` as valid (matching `lightgunLoadConfig`'s
   `{ [lg.port + 1]: lg.device }` convention in `systems.js`) and silently
   drops anything else — logging `inputDevices set without remapName —
   port device will not connect at boot`. `systems.js` declares the GunCon2 on
   libretro **port 0** (`SYSTEMS.ps2.lightgun.port === 0`), so passing that
   raw port value as the `inputDevices` key (as `tmp/verify-ps2-integration.mjs`
   already did, uncaught since it never actually checked input) silently
   dropped the device — it never connected at boot at all. Fix: key by
   `port + 1`.

With both fixed, `tmp/verify-ps2-guncon2-real.mjs` passes **8/8**: core boots,
EE RAM probe readable, poll loop running, LDD `connected:1` (the real driver
bound to the emulated device), idle trigger reads released, holding the
trigger flips the real active-low bit (`buttons` drops from `65535` to
`57343`), releasing restores it, and aim position propagates
(`x/y` moved from `320,224` centre to `160,336`) — end-to-end through
`sendLightgun()` → RetroArch's DOM mouse path → the patched `rwebinput` →
`RETRO_DEVICE_LIGHTGUN` → `UpdateGunConInputState` →
`CGunCon2UsbDevice::SetGunState` → the **real IOP driver's** `TransferPipe`
poll → SIF RPC → the EE-side global, proven via the actual USB protocol, not
Play!'s internal shortcut.

## Remaining work

See [[research/libretro-core-authoring/ps2-play-core-plan.md]]'s
risk-ordered list. Done: GS/HW-render spike, real-content boot via
`EmulatorClient`, GunCon2 USB device + controller-port wiring (confirmed via
`SET_CONTROLLER_INFO` registering `"PS2 GunCon2"`), main-thread-freeze fix,
GunCon2 real-driver input polling (see above, 8/8).
Still open:
- **`FlipImpl` never presents a frame for content driven through the real
  `EmulatorClient`/RetroArch pipeline** (see the correction under "Verified:
  real content boot" above) — every homebrew ELF tested this way screenshots
  solid black, including trivial fill-loop content with no SIF/USB logic at
  all. Root cause identified (`if(framebuffer)` gate in
  `GSH_OpenGL::FlipImpl`, `Source/gs/GSH_OpenGL/GSH_OpenGL.cpp:169`) but not
  yet fixed — real content will need this working to be visually playable at
  all, even though EE-RAM-based verification (like the GunCon2 test above)
  can route around it.
- The GunCon2 test above still uses homebrew content with no video output a
  player would see (paired with the `FlipImpl` bug, doubly true). A real
  GunCon2-compatible ISO is still the only way to verify a *playable* gun
  game, not just driver-level input plumbing.
- The multiport `rwebinput` patch was hand-applied directly to the WSL2
  `~/amiga-build/RetroArch` checkout, not re-saved as an updated `.diff` in
  `docs/patches/` — the existing
  `docs/patches/rwebinput-lightgun-multiport.diff` no longer matches current
  RetroArch master and will need regenerating (`git diff`) from that checkout
  if another core needs relinking from a fresh clone.
- A handful of `WebGL: INVALID_OPERATION: texParameter: no texture bound to
  target` / `INVALID_ENUM` warnings appear every frame starting right at GS
  texture-cache init, before any content-specific rendering. Non-blocking
  (doesn't stop boot or the freeze fix from working) but not yet root-caused
  — likely a texture-unit binding gap specific to `GSH_OpenGL_Libretro`'s
  init path vs. `ui_js`'s.
- Real-game boot test with an actual PS2 ISO/BIOS (`C:\Devstuff\ROMs\PS2\`
  has BIOS files but no game ISOs as of this writing).
- `-msimd128` and a size/perf pass on the release build haven't been
  revisited since the ASSERTIONS-era measurement.

## Deploy

`public/cores/` is gitignored; `npm run deploy` rehosts cores on dionysus.dk,
same as every other core.
