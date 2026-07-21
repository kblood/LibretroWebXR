# Building the N64 (Mupen64Plus-Next) core for the web

`libretro/mupen64plus-libretro-nx` already ships an `emscripten` platform
block in its own Makefile (unlike Play!, which had none), but that block
had never actually been built through to a working link against this
repo's patched RetroArch/Emscripten frontend before. This doc is the
recipe that got it there, done per Phase N0 of
[[research/n64-wasm-jit-plan.md]].

Phase N0 is the **interpreter baseline**, not the JIT track:
`new_dynarec` (the core's CPU dynarec) is native-x86/ARM-machine-code-only
and `#error`s on any other target — see
[[research/psx-n64-feasibility.md]] for why that rules out a wasm build of
it. This build disables it
(`WITH_DYNAREC :=`) and runs the VR4300 on the core's C interpreter.
GLideN64 (the GPU/RDP plugin) is unaffected by that wall — it's a real GPU
command translator, not a CPU dynarec — so 3D rendering is not emulated in
software here.

Built 2026-07-21 on WSL2 Ubuntu, same emsdk pin as [[AMIGA_CORE_BUILD.md]]
(3.1.46), reusing the same
patched RetroArch checkout the PS2/PSX builds use. Result:
`mupen64plus_next_libretro.wasm` ≈ 4.98 MB, `mupen64plus_next_libretro.js`
≈ 296 KB, `mupen64plus_next_libretro.worker.js` ≈ 2 KB (pthreads require
the worker bootstrap file, same as PS2/PSX).

## Recipe

```bash
# 1. emsdk (same pin as Amiga/PS2/PSX)
source ~/emsdk/emsdk_env.sh   # already installed at 3.1.46

# 2. Source
mkdir -p ~/n64-build && cd ~/n64-build
git clone --depth 50 https://github.com/libretro/mupen64plus-libretro-nx.git
cd mupen64plus-libretro-nx
```

### 3. Patch the core's own `Makefile` `emscripten` platform block

Three changes, all in the `else ifeq ($(platform), emscripten)` block:

- **`GLES3 := 1`** (was `GLES := 1`). `Makefile.common`'s
  `ifeq ($(GLES3),1)` / `else ifeq ($(GLES),1)` selects which vendored
  `libretro-common/glsym/glsym_es{2,3}.c` gets compiled. The stock block
  built GLES2, mismatched against RetroArch's own `HAVE_OPENGLES3=1` /
  WebGL2 target — switch to GLES3 for architectural correctness (and see
  the glsym duplicate-symbol fix below, which this choice interacts with).
- **`-fno-common -pthread -matomics -mbulk-memory`** added to `CPUFLAGS`.
  Two independent reasons bundled into one flag set:
  - `-fno-common`: Emscripten/Clang's default tentative-definition
    (`-fcommon`) handling of plain global variable declarations (e.g.
    `cothread_t retro_thread;` in `libretro/libretro.c`) does not reliably
    resolve when the defining object is pulled from a **static archive**
    rather than linked directly, manifesting as spurious
    `undefined symbol: retro_thread` (and similar globals) at final link
    even though the object genuinely defines them. Confirmed via `emnm`:
    without the flag the symbol shows `U` even in an isolated recompile of
    `libretro.c` alone; with it, `D`.
  - `-pthread -matomics -mbulk-memory`: any object contributing to a
    `--shared-memory`-linked final module must itself be *compiled* with
    these (not just linked with `-pthread`) — GLideN64's `ThreadedOpenGl`
    command-queue wrapper (`opengl_ObjectPool.o` etc.) needs it. Signature
    error without this: `wasm-ld: error: --shared-memory is disallowed by
    <obj> because it was not compiled with 'atomics' or 'bulk-memory'
    features`.
- **Extend the existing `-D<name>=glupen_<name>` rename list** (the core's
  own Makefile already renames ~20 shared `libretro-common` symbols —
  `sinc_resampler`, `rglgen_symbol_map`, `memalign_alloc`, etc. — so its
  vendored copies coexist with RetroArch's own compiled copies of the same
  files) with two more: `convert_float_to_s16` → `glupen_convert_float_to_s16`
  and `convert_s16_to_float` → `glupen_convert_s16_to_float`. Without this,
  `wasm-ld: error: duplicate symbol: convert_float_to_s16` (and the s16-to-float
  variant) at final link — RetroArch's own build of these libretro-common
  audio-format-conversion functions collides with the core's vendored copy.

```bash
emmake make platform=emscripten clean
emmake make platform=emscripten -j$(nproc)
```

### 4. Combine into a real static archive

Same as PS2/PSX: the core's own final `em++ ... -o
mupen64plus_next_libretro_emscripten.bc` step is a full non-relocatable
link despite the `.bc` extension (Emscripten warns
`object file output extension (.bc) used for non-object output` — ignore
the bogus output). Archive the still-present `.o` files instead:

```bash
emar rcs mupen64plus_next_libretro_emscripten.a $(find . -name '*.o')
```

### 5. The remaining duplicate-symbol class: `glsym_es3.o` vs `glsym_es3.o`

Switching to `GLES3 := 1` (step 3) makes the core vendor
`libretro-common/glsym/glsym_es3.c` — the *same file* RetroArch's own
`Makefile.emscripten` compiles for itself (RetroArch always builds ES3
support). Two independently-compiled copies of the same ~203
plain-named `__rglgen_gl*`/`*OES` GL-symbol-resolution globals collide at
final link: `wasm-ld: error: duplicate symbol: __rglgen_glActiveShaderProgramEXT`
(and ~202 more).

Two "just tolerate it" shortcuts were tried and confirmed **not
available** for this toolchain before doing the real fix:
- `wasm-ld -Wl,--allow-multiple-definition` → `unknown argument`. Confirmed
  via `wasm-ld --help | grep -i multiple` (no such flag; no ELF-style
  `-z muldefs` equivalent either).
- `llvm-objcopy --localize-symbol=<name>` (to make the core's copies
  file-local) → `only flags for section dumping, removal, and addition are
  supported`. The wasm-target `llvm-objcopy` has no symbol-table editing
  support at all (no localize/redefine/globalize).

The real fix: recompile **only** `libretro-common/glsym/glsym_es3.c`
standalone, with an extra `-D<name>=glupen_<name>` rename applied to
every one of the ~203 colliding symbol names (extracted via `emnm
libretro-common/glsym/glsym_es3.o | awk '$2=="D"{print $3}' | grep -v
'^glupen_'` against a first build), appended to the exact original compile
command line (grep it out of the build log — every other flag, including
the core's own existing renames, must stay identical). Then splice the
renamed object back into the archive:

```bash
emar d mupen64plus_next_libretro_emscripten.a libretro-common/glsym/glsym_es3.o
emar r mupen64plus_next_libretro_emscripten.a libretro-common/glsym/glsym_es3.o
```

This is a one-file, non-architectural patch — it doesn't need to live in
the core's Makefile, just re-applied to this one object whenever the core
is rebuilt from scratch.

### 6. The RetroArch checkout needs the worker-safe audio patch too

This project's `~/amiga-build/RetroArch` checkout is otherwise stock —
its `emscripten/library_rwebaudio.js` is upstream's own page-only
`AudioContext`-based audio glue, which does not run inside a dedicated
Worker (no `window.AudioContext` there). The PSX build got real worker
audio via a **generic, core-agnostic** RetroArch patch published in
`github.com/kblood/psx-wasm-jit-libretro`'s `core-build/` tree — it was
never applied to this shared checkout permanently, so it has to be
(re-)applied before linking any new worker-mode core:

```bash
git clone --depth 1 https://github.com/kblood/psx-wasm-jit-libretro.git /tmp/psx-repo
cd ~/amiga-build/RetroArch
git apply /tmp/psx-repo/core-build/patches/retroarch-rwebaudio.patch
cp /tmp/psx-repo/core-build/rwebaudio/library_libretrowebxr_rwebaudio.js emscripten/
```

The patch just adds a `RWEBAUDIO_JS_LIBRARY` make-variable override (default
stays the stock file) around the existing `--js-library` line — it doesn't
change behavior unless the variable is passed. The replacement library
implements RetroArch's standard `RWebAudio*` ABI (the same interface every
core's audio driver calls) without creating an `AudioContext`; it interleaves
planar Float32 batches and calls `globalThis.__libretroWebXRRuntime.pushAudio()`,
which `src/runtime/EmulatorWorkerRuntime.js` already exposes unchanged. Confirm
it took with `grep LibretroWebXRRWA mupen64plus_next_libretro.js` after
linking (should be present — the *stock* file is quietly linkable and
produces no error, just silent/broken audio, so this is easy to miss).

### 7. Link against RetroArch

```bash
cp mupen64plus_next_libretro_emscripten.a ~/amiga-build/RetroArch/libretro_emscripten.a
cd ~/amiga-build/RetroArch
emmake make -f Makefile.emscripten LIBRETRO=mupen64plus_next \
  HAVE_THREADS=1 HAVE_OPENGLES3=1 \
  RWEBAUDIO_JS_LIBRARY=emscripten/library_libretrowebxr_rwebaudio.js \
  INITIAL_HEAP=268435456 ASYNC=1 -j$(nproc)
```

**`ASYNC=1` is required**, not optional — it's what makes RetroArch pass
full `-s ASYNCIFY=1` to the final link. See "Black-screen fix" below for
why: the core's emulation thread runs via a fiber-based `co_switch()` that
depends on it. Omitting it links successfully but the core silently never
runs its emulation thread body (permanent black screen, no error).
`wasm-opt --asyncify` over the whole linked binary is genuinely CPU-heavy
(100%+ single-core-equivalent, multi-minute) — that's expected, not a hang;
confirm via `ps -eo pid,pcpu,etime,cmd` before assuming a build is stuck.

## Black-screen fix: libco fiber backend + interrupt dispatch

The build above links and boots, but every guest ROM rendered a black
screen forever until three real, independent bugs were found and fixed
(2026-07-21/22):

1. **`libco` never actually switched stacks on Emscripten.** The stock
   dispatch in `libretro-common/libco/libco.c` falls through to `sjlj.c`
   (POSIX `sigaltstack`/`siglongjmp`), which cannot work under WASM —
   `co_switch()` silently no-ops and the core's emulation thread body never
   runs. Fixed with a new `libretro-common/libco/emscripten.c` backend built
   on `emscripten/fiber.h`, which requires the `ASYNC=1` full-Asyncify build
   mode above (fiber save/restore needs Asyncify's unwind/rewind support).
   The primary/main context is lazily captured via
   `emscripten_fiber_init_from_current_context()` the first time control
   switches away from it (it's never itself `co_create()`d).
2. **`libretro/libretro.c`'s own `co_create()` call site cast a
   `void*(void*)` function to `void(void)`** — harmless UB on native ABIs,
   but a hard `call_indirect` type-check failure ("function signature
   mismatch") once the fiber backend actually tried to invoke it. Fixed
   with a correctly-typed trampoline (`EmuThreadFunction_co_entry`) that
   matches `co_create()`'s expected signature and calls the real entry
   point from inside it.
3. **The actual black-screen root cause was in the test ROM, not the
   core:** `games/n64-smoke/main.c` never called `init_interrupts()`. The
   pinned `anacierdem/libdragon` Docker image used to build this repo's N64
   homebrew (predates the modern `rdpq` API) has a real, callable
   `init_interrupts()` that must be invoked explicitly by the user's
   `main()` — unlike modern libdragon trunk, which auto-runs interrupt init
   via an `__attribute__((constructor))` function before `main()` (and
   whose public `init_interrupts()` is now a deprecated no-op). Without the
   explicit call, `__interrupt_depth` stays at its negative sentinel and
   every `disable_interrupts()`/`enable_interrupts()` call (used throughout
   `display_init()`/`display_lock()`/`display_show()`) is a silent,
   permanent no-op — COP0 `Status.IE` never gets set, the emulated VI
   interrupt can never dispatch to the guest, and libdragon's internal
   double-buffer-free bookkeeping (which only runs inside that interrupt
   handler) never executes. `display_lock()`'s busy-wait therefore spins
   forever after the ROM's first (buffers-start-free) draw succeeds.
   **Any future N64 homebrew ROM built against this same pinned image must
   also call `init_interrupts()` explicitly as the first line of `main()`**
   — modern libdragon example code found online never needs to, and will
   look redundant against current docs, but this old image genuinely
   requires it.

**Diagnosis method** (useful precedent for future interpreter/timing bugs
in this core): confirmed each layer in isolation via targeted, capped
`fprintf` instrumentation rather than assumption, working from the RDP
command decode inward to the interrupt-dispatch gate, then to the exact
`MTC0`-to-`CP0_STATUS_REG` write site — which revealed only one real Status
write ever happened in the whole run, pointing straight at
`enable_interrupts()`/`disable_interrupts()` never actually executing a
real `MTC0`. All instrumentation was reverted after the fix was confirmed;
none of it should be reintroduced except as a temporary diagnostic.

**Two `make platform=emscripten` dependency-tracking gaps hit while
iterating on this** — its dependency tracking does not detect changes to
files `#include`d *into* a tracked `.c` file rather than being their own
translation unit:
- `libretro-common/libco/libco.c` `#include`s `emscripten.c` — editing the
  latter alone doesn't trigger a recompile of `libco.o`.
- `mips_instructions.def` is `#include`d by **both**
  `mupen64plus-core/src/device/r4300/pure_interp.c` **and** `cached_interp.c`
  (both get compiled into the binary; which one runs is a runtime
  core-option choice) — editing it requires deleting both `.o` files.

Symptom of missing either: the final wasm hash is unchanged after a
rebuild. Fix: `rm` the affected `.o`(s) before `emmake make`.

## GLideN64 WebGL2 buffer-mapping fixes

Once the black screen was fixed, the real assertion-based E2E probe
(`npm run probe:n64-core`, in `test/n64-core-e2e/harness.js`) reached its
strict error-log assertions for the first time and surfaced issues that had
been masked by the earlier black-screen failure the whole time:

- **A leftover `PS2DBG:` debug `fprintf` block** in
  `~/amiga-build/RetroArch/retroarch.c` (added during PS2 Play! core
  bring-up, printing argv on every core's startup since this RetroArch
  checkout is shared across the Amiga/PS2/PSX/N64 core builds). Deleted
  entirely — it was unconditional and affected every core built from this
  tree, not just N64.
- **`glMapBufferRange access does not support MAP_READ or
  MAP_UNSYNCHRONIZED`**, repeated on every buffer op: WebGL2/ANGLE's
  `glMapBufferRange` emulation doesn't validly support persistent/coherent
  mapped reads, `MAP_UNSYNCHRONIZED_BIT`, or `MAP_READ_BIT`, even though
  GLideN64's capability probing can report them as available. Three call
  sites needed gating (all behind `#if defined(EMSCRIPTEN)`, matching the
  existing convention in `opengl_TextureManipulationObjectFactory.cpp`):
  - `opengl_GLInfo.cpp`: force `bufferStorage = false` so
    `opengl_ContextImpl.cpp::createColorBufferReader()` and
    `opengl_BufferedDrawer.cpp::_initBuffer()` don't take the
    persistent/coherent-mapped path.
  - `opengl_BufferedDrawer.cpp::_updateBuffer()`: its non-bufferStorage
    fallback used `glMapBufferRange(..., GL_MAP_WRITE_BIT |
    GL_MAP_UNSYNCHRONIZED_BIT)` — replaced with a plain `glBufferSubData()`
    call under `EMSCRIPTEN` (universally valid, no mapping semantics
    involved).
  - `opengl_ContextImpl.cpp::createColorBufferReader()`: even with
    `bufferStorage` forced off, the `!isGLES2` branch picked
    `ColorBufferReaderWithPixelBuffer`, whose `_readPixels()` maps with
    plain `GL_MAP_READ_BIT` — also unsupported here. Gated that branch out
    under `EMSCRIPTEN` so it falls through to the plain, synchronous
    `ColorBufferReaderWithReadPixels` (`glReadPixels` directly, no mapping
    at all).

  Confirmed fixed via `npm run probe:n64-core`: zero error-level console
  logs, zero worker errors, non-blank video, frames presented — clean pass.

Produces `mupen64plus_next_libretro.{js,wasm,worker.js}` — standard
`MODULARIZE=1 EXPORT_ES6=1` module, same shape `RuntimeEmulatorClient`
already expects (`execution: 'worker'` in `src/systems.js`, identical
topology to PSX).

### 8. Deploy

Copy the three artifacts into `public/cores/` (gitignored — never
committed, matches every other core here) plus a hand-authored
`mupen64plus_next_libretro.build.json` manifest (sha256 + pins, same shape
as the PSX one) so `RuntimeEmulatorClient`'s save-state compatibility
check has a real build hash to key off.

## Phase N0 item 3: fps measurement against a real 3D scene

No commercial N64 ROM is available or sourced for this repo (per this
project's standing rule against sourcing ROM content from the internet), so
`games/n64-scene` (a hand-rolled rotating flat-shaded cube — perspective
projection, painter's-algorithm depth sort, 12 filled triangles/frame via
the RDP, analog-stick-driven yaw/pitch, an EEPROM boot counter) stands in
for "a representative commercial 3D title", matching every other system in
this repo (`games/nes-gallery`, `games/snes-scope`, `games/ps2-guncon-range`).

Build: `node scripts/make-n64-scene.mjs`. Measure:
`npm run measure:n64-fps` (env `N64_FPS_MEASURE_MS` controls sample
duration, default 12000). Uses `measureN64Fps()` in
`test/n64-core-e2e/harness.js` — boots identically to the correctness probe,
then free-runs for the measurement window and reports
`framesPresented`/`framesDropped`/`fps` instead of stopping at the first 3
frames.

**Result (2026-07-22, headless Chrome + `--use-angle=swiftshader`, i.e.
software-rendered GL — the worst case, not a real GPU):** ~50-58 fps
sustained over both 6s and 15s measurement windows, 0 dropped frames. This
is the interpreter-only baseline with no CPU JIT. Real hardware-accelerated
desktop Chrome should only be faster; **Quest 3 fps is not measured by this
script** — it needs the physical headset (deploy this build and read back
numbers the same way other systems' Quest validation has been done, e.g.
`dionysus.dk/logs?session=<room>`). Recording this desktop half now as
partial Phase N0 exit-gate evidence; the Quest half remains an open
follow-up.

## Phase N0 item 4: save types / analog input / audio HLE

- **Analog input**: verified — `games/n64-scene` reads `controller_read()`'s
  signed 8-bit `c[0].x`/`c[0].y` fields every frame and uses them
  continuously (not thresholded) to drive rotation speed.
- **EEPROM save**: verified at the API level — the ROM calls
  `eepfs_init()`/`eepfs_read()`/`eepfs_write()` successfully every boot
  (`capabilities.saveRam` reports `true` in the probe). Game-DB-driven save
  *type* auto-detection (EEPROM vs SRAM vs FlashRAM per-game) was not
  separately exercised — there's only one homebrew ROM, not a library of
  real carts with varying save chips.
- **Audio HLE: RESOLVED — real core bug found and fixed.** A single
  `audio_write()` call from guest code (following libdragon's documented
  API: `audio_init()`, then `audio_get_buffer_length()`-sized buffer,
  `audio_can_write()`/`audio_write()` in a loop) reproducibly crashed the
  worker with `Uncaught RuntimeError: memory access out of bounds`.
  Bisected by disabling code incrementally: `audio_init()` +
  `audio_get_buffer_length()` + `malloc()` alone were fine; the crash was
  specifically triggered by the first `audio_write()`. Ruled out a
  ROM-side buffer-sizing bug first (the size math —
  `audio_get_buffer_length()` stereo samples, `* 2` for channels — matches
  upstream libdragon's own `audio.c`). Root cause:
  `mupen64plus-core/src/device/rcp/ai/ai_controller.c`'s
  `read_ai_regs()`/`ai_end_of_dma_event()` indexed RDRAM via a **raw,
  unmasked** `&ai->ri->rdram->dram[ai->fifo[0].address/4]`, where
  `ai->fifo[0].address` is whatever the guest wrote to `AI_DRAM_ADDR_REG`.
  libdragon's `audio_write()` buffers are allocated with
  `malloc_uncached()`, which returns a KSEG1-tagged pointer (upper address
  bits set, e.g. `0xA0xxxxxx`) — real N64 AI DMA hardware only has ~24
  address pins wired and silently ignores those upper bits, but this code
  used the full unmasked value as an array index. The analogous SI/PIF DMA
  path in `si_controller.c` already wraps the same kind of address through
  `rdram_dram_address()` (`device/rdram/rdram.h`: `(address & 0xffffff) >>
  2`) before indexing — `ai_controller.c` was simply missing the same
  masking. On native builds this silently corrupts unrelated heap memory
  (UB, no crash, because native processes have huge virtual address
  spaces); under WASM's small, bounds-checked linear memory the same OOB
  index becomes a hard trap, which is why this dormant bug was never
  noticed on other platforms. **Fix:** wrap both RDRAM-indexing sites in
  `ai_controller.c` with `rdram_dram_address()`, matching
  `si_controller.c`. Verified 2026-07-22: `games/n64-scene` now runs with
  audio re-enabled (a continuous 220Hz tone via the polling
  `audio_can_write()`/`audio_write()` model), `npm run measure:n64-fps`
  shows real audio flowing (805 events / 386400 frames / 2ch / 48000Hz /
  f32 over an 8s window, 0 dropped video frames), and `npm run
  probe:n64-core` still passes cleanly (no regression to the
  correctness gate).

## Known gaps (tracked, not blockers for N0's build step)

- **No CPU JIT.** Interpreter-only per the plan; fps measurement against
  a real 3D title (Phase N0 step 3) is the actual verdict on whether this
  is even worth pursuing further — see [[research/n64-wasm-jit-plan.md]].
- **Analog stick input has no continuous-value transport yet.** Every
  existing system in this repo (`src/GameInputMgr.js`) sends RetroPad
  input as synthetic `KeyboardEvent`s — including "analog" stick
  direction, which is thresholded into 8-way digital dpad-equivalent
  presses (`STICK_THRESHOLD` in `GameInputMgr.js`). N64 is this project's
  first system where the real hardware analog range (not just direction)
  matters for gameplay (camera control, walk-vs-run). The initial `n64`
  `ControllerMaps.js` entry reuses this same digital-threshold approach as
  every other system (functional, matches how most keyboard-only N64
  setups already work) — true continuous analog would need a new
  transport (e.g. a `sendAnalog(index, id, value)` primitive plumbed
  through `EmulatorClient`/`WorkerEmulatorClient` into whatever RetroArch
  input driver this build uses) which has not been built.
