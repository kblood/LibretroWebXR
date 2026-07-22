# Phase NJ1 spike: VR4300→Jitter adapter (lowering-layer proof of concept)

Status as of 2026-07-22: **standalone lowering layer validated natively
(128/128); the real cached_interp.c bridge + adapter + a Wasm-targeted
Play--CodeGen/Framework build are now linked into the FULL real N64 core
binary (via the real Makefile.common/Makefile.emscripten, gated opt-in),
and that full binary has been boot-verified against the real smoke ROM
with zero regressions versus the shipping interpreter-only baseline. It is
still NOT wired into the live dispatch table (`ci_table`)** — the linked
JIT code is real, present, and dormant, not yet executing on any real
instruction. This doc exists so that distinction is never lost — see
[[n64-wasm-jit-plan.md]] Phase NJ1 for the full exit gate this spike is a
step toward, not a completion of.

## What this is

`scripts/cores/n64-jit-spike/` contains a from-scratch VR4300 (MIPS III)
tier-1 IR-lowering adapter targeting Play--CodeGen's Jitter (the same IR
library the shipping PSX Lightrec adapter and PS2 Play! core already use in
this project — see `docs/PSX_CORE_BUILD.md` / `docs/PS2_CORE_BUILD.md`):

- `vr4300_play_backend.h` / `.cpp` — the adapter itself. C API shaped like
  the shipping PSX `lr_play_backend.h/.cpp` (block create/run/destroy/
  get-mode, per-block interpreter-fallback contract, abandon-partial-IR on
  first unsupported opcode).
- `test_vr4300_jit.cpp` — a standalone differential/unit test harness (hand
  -encoded MIPS instruction words, a synthetic register-file struct, no
  dependency on the real core).
- `CMakeLists.txt` — builds `test_vr4300_jit` against Play--CodeGen's
  **native x86_64** backend (fast iteration; the Wasm backend
  `Jitter_CodeGen_Wasm.cpp` is the same IR and is the actual shipping
  target once this logic is proven — swapping backends is a build-target
  change, not a rewrite). Requires a checkout of Play--CodeGen's deps
  (`$HOME/play-build/Play-/deps/CodeGen`, the same tree already used for
  the PS2/PSX JIT builds).

Build/run:
```bash
cd scripts/cores/n64-jit-spike
cmake -B build && cmake --build build
./build/test_vr4300_jit
```

## Tier-1 opcode coverage (this spike)

Integer ALU (32-bit: ADDU/SUBU/AND/OR/XOR/NOR/SLT/SLTU, immediates ADDIU/
ANDI/ORI/XORI/SLTI/SLTIU/LUI; 64-bit: DADDU/DSUBU/DADDIU), shifts (32-bit
SLL/SRL/SRA/SLLV/SRLV/SRAV; 64-bit DSLL/DSRL/DSRA/DSLL32/DSRL32/DSRA32/
DSLLV/DSRLV/DSRAV), HI/LO moves (MFHI/MFLO/MTHI/MTLO), and all branches/
jumps with delay slots including the MIPS-II likely forms (BEQ/BNE/BLEZ/
BGTZ + BEQL/BNEL/BLEZL/BGTZL, REGIMM BLTZ/BGEZ/BLTZAL/BGEZAL/BLTZL/BGEZL/
BLTZALL/BGEZALL, J/JAL/JR/JALR).

Explicitly **out of scope** for this spike (falls back to the interpreter
callback, exactly like an unsupported opcode): loads/stores, FPU, MULT/DIV,
TLB, COP0/exceptions.

128/128 differential-style unit checks pass, covering: sign-extension edge
cases for the 32-bit-result family (ADDU/SUBU/shifts/LUI); full-64-bit
bitwise semantics for AND/OR/XOR/NOR (a real gap between "sign-extend the
32-bit result" and "operate the full 64 bits" that a first pass got wrong
in the *test's* expected value, not the adapter — see below); zero- vs
sign-extended immediates (ANDI zero-extends and forces the result's high
word to 0, ORI/XORI zero-extend but preserve the source's high word,
SLTI/SLTIU sign-extend the immediate before a full 64-bit compare); delay-
slot annulment on not-taken likely branches; and — the one genuinely
serious bug this spike caught before any test ran — **link-register writes
(JAL/JALR/REGIMM `*AL`) must sign-extend the 32-bit link value**, not zero-
extend it, because real N64 game code executes at KSEG0 (`0x80000000+`,
bit31 set) and a zero-extended link would corrupt `$ra` on essentially
every real title.

**One test-writing mistake worth recording explicitly** (per this project's
own "verify before claiming done" practice): the first NOR test case
expected a zero-extended-32-bit result, because AND/OR/XOR/NOR "feel" like
they should behave like the ADDU/SUBU family (32-bit op, sign-extended
result). They don't — MIPS III specifies AND/OR/XOR/NOR as genuine 64-bit
bitwise ops. The adapter's lowering (loop the bitwise op over both 32-bit
register halves independently) was correct from the start; the test's hand
-computed expected value was wrong. Fixed by re-deriving the expected value
from real 64-bit semantics instead of assuming the adapter was at fault.

## The real-core bridge (`vr4300_jit_bridge.h`/`.cpp`)

Added after the standalone spike above was validated: a bridge connecting
`cached_interp.c`'s real page/`precomp_instr` dispatch model to
`vr4300_play_backend`, written directly against the real
`mupen64plus-core` headers (not a synthetic `TestState`):

- **Register state**: copies the real `r4300_core`'s `regs[32]`/`hi`/`lo`
  (via its own `r4300_regs()`/`r4300_mult_hi()`/`r4300_mult_lo()`
  accessors — these work regardless of the `NEW_DYNAREC` memory-layout
  variant) into a small contiguous `BridgeState` before running a compiled
  block, and back afterward. A ~272-byte memcpy each way per block entry;
  irrelevant next to a JIT's whole point, and it decouples this file from
  `r4300_core.h`'s layout variants entirely rather than chasing offsets
  into the real struct directly.
- **Block-boundary discovery**: `vr4300_play_is_block_terminator()` — one
  new, additive export on the adapter itself (the existing internal
  `IsBranch()` classifier, exposed) — lets the bridge scan raw instruction
  words from `fast_mem_access()` for the same block shape the adapter
  expects (linear run + one terminator + its delay slot) without
  duplicating/drifting from the adapter's own notion of where a block
  ends. Scanning stops at the current 4KB page boundary, matching
  `cached_interp`'s own per-page invalidation granularity.
- **LUT**: `g_jit_pages[address >> 12][(address & 0xFFF) >> 2]`, a
  lazily-allocated parallel structure directly mirroring
  `cached_interp.blocks[address >> 12]`'s existing page-array shape —
  deliberately matched, not a different data structure, so it composes
  with the real invalidation granularity later.
- **Interpreter fallback**: for blocks the adapter itself flags as
  `VR4300_PLAY_BLOCK_INTERPRETER` (an unsupported opcode was hit while
  lowering), `vr4300_play_block_run()`'s own internal fallback path calls
  back into `cached_interp_NOTCOMPILED2()` — the real interpreter,
  single-stepping byte-for-byte as if this address had never been
  JIT-attempted at all.
- **Exit**: after a block runs, `generic_jump_to(r4300, exit_pc)` —
  the real, emulator-agnostic PC-retargeting function every other r4300
  backend already uses for out-of-block jumps — resolves the adapter's
  raw exit address back into the correct `precomp_instr*` dispatch
  pointer.

**Verified so far:** both `vr4300_play_backend.cpp` and
`vr4300_jit_bridge.cpp` compile cleanly (zero warnings under `-Wall`)
against the real core headers (`device/r4300/r4300_core.h`,
`device/r4300/cached_interp.h`, `main/main.h`), using the exact real build
flags (`em++ -std=gnu++11 -DEMSCRIPTEN -DNO_ASM`, matching this core's own
`Makefile`/`Makefile.common`). One real, worth-recording finding from this
check: `vr4300_play_backend.cpp` originally used `std::make_unique`
(C++14), but this core's real build standard is `gnu++11` — fixed to
`std::unique_ptr<T>(new T())`, the C++11-compatible form, matching the
established precedent this project's own shipping PSX adapter
(`lightrec_play_backend.cpp`) already had to follow in the same
mupen64plus/libretro-style Makefile family. The standalone native test
suite (128/128) was rerun after this fix to confirm no behavior changed —
still 128/128.

## Real full-core link + boot verification

Following the synthetic adapter-only link-check above, the same recipe was
carried into the actual production build described in
`docs/N64_CORE_BUILD.md`, gated entirely opt-in (default off, so every
other build of this core is byte-for-byte unaffected):

- **`Makefile.common`** (mupen64plus-libretro-nx): a new
  `ifeq ($(WITH_N64_JIT), 1)` block (placed after the existing
  `HAVE_PARALLEL_RSP` block, same style) adds
  `vr4300_play_backend.cpp`/`vr4300_jit_bridge.cpp` (copied into
  `mupen64plus-core/src/device/r4300/`, alongside the files they extend)
  to `SOURCES_CXX`, and adds `-I$(N64_JIT_CODEGEN_INCLUDE)
  -I$(N64_JIT_FRAMEWORK_INCLUDE)` to `INCFLAGS` (both passed on the `make`
  command line, since they're WSL-local paths, not repo-relative).
- **`Makefile.emscripten`** (the patched RetroArch checkout): a new
  `ifeq ($(N64_JIT), 1)` block (placed right after the existing
  `ifeq ($(LIBRETRO), play)` block that already does this for the PS2
  core) adds the same `--bind -fexceptions -s ALLOW_TABLE_GROWTH=1`
  LDFLAGS (same embind/Wasm-JIT-instantiation requirement confirmed above,
  now reused rather than rediscovered) plus `$(N64_JIT_CODEGEN_LIB)
  $(N64_JIT_FRAMEWORK_LIB)` to `LIBS`.
- Build/rearchive/relink, extending `~/build-n64-full.sh`'s existing
  three-script recipe with the new variables:
  ```bash
  # 1. core build (mupen64plus-libretro-nx), with the JIT files enabled
  emmake make platform=emscripten -j$(nproc) \
    WITH_N64_JIT=1 \
    N64_JIT_CODEGEN_INCLUDE=$PLAY_ROOT/deps/CodeGen/include \
    N64_JIT_FRAMEWORK_INCLUDE=$PLAY_ROOT/deps/Framework/include
  # 2. rearchive (unchanged from docs/N64_CORE_BUILD.md step 4)
  # 3. relink against RetroArch, with the JIT libs now added
  emmake make -f Makefile.emscripten LIBRETRO=mupen64plus_next \
    HAVE_THREADS=1 HAVE_OPENGLES3=1 \
    RWEBAUDIO_JS_LIBRARY=emscripten/library_libretrowebxr_rwebaudio.js \
    INITIAL_HEAP=268435456 ASYNC=1 \
    N64_JIT=1 \
    N64_JIT_CODEGEN_LIB=$BUILD/libCodeGen.a \
    N64_JIT_FRAMEWORK_LIB=$BUILD/Framework/libFramework.a
  ```
  (`$BUILD` = the clean wasm-targeted CodeGen/Framework build described
  above, `~/n64-jit-spike/build-wasm-codegen/`.)

**Result: `RELINK_EXIT=0`.** Both new `.o` files were confirmed present in
the rearchived `.a` (`emar t ... | grep -c vr4300` → 2), and the full link
against the real, patched RetroArch checkout succeeded with zero errors
and zero `undefined symbol` hits (confirmed via `grep -i error` /
`grep undefined symbol` over the full build log — both empty) — the
`--bind` requirement found via the synthetic check above turned out to
transfer directly, unchanged, to the real build. Output:
`mupen64plus_next_libretro.wasm` grew to 7.74 MB (the added
CodeGen/Framework code, present but unreached — nothing calls into it yet
since `ci_table` is untouched).

**Boot-verified, not just link-verified:** a clean link does not prove the
binary still runs — so before writing any of this up, the new binary was
swapped into `public/cores/` (after backing up the prior baseline) and run
through the project's own real headless boot probe,
`node scripts/probe-n64-core.js` (Puppeteer + a real Chrome, the real
`WorkerEmulatorClient`/RetroArch/mupen64plus_next stack, the real
`lwx-n64-smoke.z64` smoke ROM — the same probe N0 itself was verified
with). Result: **`Real N64 worker-core browser probe PASSED`** — 5 frames
presented, 0 dropped, 0 error logs, 0 worker errors, `jit: true` in the
reported capabilities (present-but-inert, not yet load-bearing). This is a
real, meaningful regression check: identical boot behavior to the
shipping interpreter-only baseline, confirming the linked-in (but not
wired) JIT code changes nothing about current behavior — exactly the
"safe to have present as dead code" property the whole approach depends
on.

**What is explicitly still NOT done, on purpose:**

- `cached_interp_JIT_ENTRY` is **not wired into `ci_table`** (the real
  dispatch table `cached_interp.c` uses to pick each `precomp_instr`'s
  `.ops` handler). Nothing in the live core calls any of this bridge code
  yet — it compiles, but is dead code from the running core's point of
  view. This is deliberate: the bridge does not call
  `cp0_update_count()`/`gen_interrupt()` per instruction the way the
  interpreter and every real branch handler do, so COP0 timer-driven
  interrupts would not fire on schedule inside a compiled block. That gap
  is explicitly Phase NJ2 scope in the plan (COP0/interrupt handling in
  generated code), not NJ1 — wiring this in before closing it would risk
  a real, live regression to the currently-verified interpreter-only N64
  core, which is not an acceptable trade for un-verified progress.
- `vr4300_jit_bridge_invalidate()` exists and is correct by inspection but
  is not called from anywhere real (`invalidate_r4300_cached_code()`'s
  actual dispatch chain isn't touched).
- Play--CodeGen is now **linked into the full real core binary** (see
  "Real full-core link + boot verification" above) and that binary
  **boots correctly** with zero regressions — this bullet is intentionally
  left in place, historically, only to record that the `--bind` embind
  requirement (first found via a synthetic `link_check_main.cpp`-only
  check against `vr4300_play_backend.cpp`, tracing to CodeGen's own
  `MemoryFunction.cpp` `MEMFUNC_USE_WASM`/`EM_JS`/`emscripten::EM_VAL`
  Wasm-module-instantiation path) transferred unchanged to the real
  Makefile integration, exactly as expected.
- No differential testing against real ROM content, and no interrupt-
  timing test of any kind — only the standalone spike's 128 hand-built
  checks (run against the synthetic harness, not through this bridge) and
  the real-core boot probe above (which exercises the *existing*
  interpreter path only, since `ci_table` still routes to it — it does
  not exercise the JIT bridge's compiled path at all yet).

## What this spike does NOT prove yet

This is still short of the NJ1 exit gate. Per the plan, NJ1's actual four
steps are:

1. Add this lowering layer **hosted in the core's cached-interp block
   model**, **dispatching via LUT** — the bridge above is real progress on
   this (compiles against real headers, real LUT shape matching
   `cached_interp`'s own) and is now linked into a real, boot-verified core
   binary (see "Real full-core link + boot verification" above), but is
   still not wired into `ci_table` — the linked code is real and present,
   but nothing calls it yet.
2. Per-block interpreter fallback (done, see above) plus **differential
   testing against the real interpreter over instruction-suite ROMs
   (n64-systemtest, libdragon test suites) and real game boot sequences**
   — not started; the 128 hand-built checks are a substitute, not
   equivalent.
3. **Overlay/DMA invalidation test** (a Zelda-style overlay swap must not
   dispatch a stale block) — not attempted; the invalidation function
   exists but isn't hooked to anything real yet.
4. **Measured native-vs-interpreter speedup**, desktop then Quest — not
   possible without steps 1–2 actually running live.

## Next steps

1. ~~Add `SOURCES_CXX` entries for `vr4300_play_backend.cpp` and
   `vr4300_jit_bridge.cpp` to `Makefile.common`, and wire a locally-built
   Play--CodeGen static library into the final link.~~ **Done** — see
   "Real full-core link + boot verification" above: gated `WITH_N64_JIT`/
   `N64_JIT` blocks added to `Makefile.common`/`Makefile.emscripten`
   (default off), full core links (`RELINK_EXIT=0`) and boots correctly
   (`scripts/probe-n64-core.js` PASSED, zero regressions). Remaining under
   this step: none — it's complete for NJ1's purposes. (A further polish
   item, not blocking: the linked CodeGen/Framework code is currently
   100% dead weight in the shipped `.wasm`, +2.76 MB, since nothing calls
   it — acceptable for now since `WITH_N64_JIT`/`N64_JIT` are opt-in and
   off by default, so this doesn't affect the actual shipping build.)
2. Close (or explicitly, narrowly scope around) the COP0/interrupt gap
   before wiring `cached_interp_JIT_ENTRY` into `ci_table` for real. A
   real design finding from reading `cp0.c`/`interrupt.c` (not yet
   implemented or tested): `cp0_update_count()` computes elapsed cycles as
   `((*r4300_pc(r4300) - cp0->last_addr) >> 2) * count_per_op` — a pure
   function of the *instruction-count delta* since the last call, not of
   how many times it's been called. The interpreter's own `DECLARE_JUMP`
   macro calls it exactly once per retired branch (with PC still at the
   delay-slot address, i.e. *before* the jump is applied), checks
   `gen_interrupt()` immediately after, then unconditionally resets
   `cp0.last_addr` to the post-jump PC. Because this bridge's block model
   is already "linear run + one terminator + its delay slot" — the same
   granularity a branch retirement represents — a per-block call
   replicating that exact two-step protocol (checkpoint PC at
   `blockStart + (count-1)*4` for the `cp0_update_count()` call, then reset
   `last_addr` to the real post-jump PC after `generic_jump_to()`) should
   reproduce the interpreter's own Count-register accounting exactly, not
   approximately — this may not need to be a coarse approximation at all.
   Further reading (`grep delay_slot` across every `r4300/*.c`) found the
   concrete shape of the remaining risk: `cp0.c`'s exception paths (e.g.
   the EPC/ErrorEPC computation, per its own comment "adjust ErrorEPC if
   we were in a delay slot") read `r4300->delay_slot`, which `BridgeState`
   doesn't track at all. The good news: `DECLARE_JUMP` itself already
   resets `r4300->delay_slot = 0` immediately after executing the delay
   slot instruction, *before* its own `gen_interrupt()` check — i.e. the
   interpreter's own reference check point is always at `delay_slot == 0`.
   Since this bridge's block model always fully retires its one terminator
   + delay slot before reaching its own equivalent check point, the two
   check points line up: `delay_slot` should read `0` at both, by
   construction, for every block this bridge actually compiles or
   interpreter-falls-back for (the only case that skips this entirely —
   `LookupOrCompile()` finding no terminator before the page ends — already
   routes straight to `cached_interp_NOTCOMPILED2()`, never through this
   check at all). This is still a **read-the-source finding, not a tested
   one** — `gen_interrupt()`'s callee handlers (registered per-interrupt-
   type, not read yet in full) may have further requirements this hasn't
   surfaced, and none of it has been tried against a real interrupt-firing
   ROM. No code for this has been written yet; per this project's own
   verify-before-claiming-done standard, it shouldn't be until it can
   actually be tested.
3. Build a real differential harness against actual ROM content
   (n64-systemtest, libdragon test suites, then a real game boot) once 1–2
   are done — this is the bulk of the remaining NJ1 work (the plan
   estimates 3–5 weeks for the whole phase).
