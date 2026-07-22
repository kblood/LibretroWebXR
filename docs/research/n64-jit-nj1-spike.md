# Phase NJ1 spike: VR4300→Jitter adapter (lowering-layer proof of concept)

Status as of 2026-07-22: **standalone lowering layer validated natively;
real core integration not started.** This doc exists so that distinction is
never lost — see [[n64-wasm-jit-plan.md]] Phase NJ1 for the full exit gate
this spike is a first step toward, not a completion of.

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

## What this spike does NOT prove yet

This is a **unit-tested lowering layer running in isolation**, not the NJ1
exit gate. Per the plan, NJ1's actual four steps are:

1. Add this lowering layer **hosted in the core's cached-interp block
   model** (real `mupen64plus-core/src/device/r4300/cached_interp.c`
   integration — the block/page/`precomp_instr` structures, not a
   synthetic `TestState`), **dispatching via LUT**.
2. Per-block interpreter fallback (already designed for, above) plus
   **differential testing against the real interpreter over instruction-
   suite ROMs (n64-systemtest, libdragon test suites) and real game boot
   sequences** — this spike's hand-built test cases are a substitute for
   that, not equivalent to it.
3. **Overlay/DMA invalidation test** (a Zelda-style overlay swap must not
   dispatch a stale block) — not attempted; requires real memory/DMA
   plumbing this spike has none of.
4. **Measured native-vs-interpreter speedup**, desktop then Quest — not
   possible without step 1's real integration.

None of steps 1–4 have started. This spike only de-risks the "can the
lowering logic itself be written correctly" question for tier-1 opcodes —
a necessary precondition, not the deliverable the exit gate asks for.

## Next steps

Wire this adapter into the real `mupen64plus-core` fork's block-dispatch
path (the fork already built per `docs/N64_CORE_BUILD.md`), replacing the
synthetic register layout with the real `r4300_core.h` `regs[32]`/`hi`/`lo`
offsets, adding LUT-based block lookup alongside `cached_interp.c`'s
existing page-based `precomp_block` model, and building the differential
test harness against real ROM content per step 2 above. This is the bulk of
the remaining NJ1 work (the plan estimates 3–5 weeks for the whole phase).
