#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * NJ1 bridge: connects mupen64plus-core's cached_interp.c page/precomp_instr
 * dispatch model to the standalone vr4300_play_backend adapter (see
 * docs/research/n64-jit-nj1-spike.md). This file is written against the
 * REAL mupen64plus-core headers (r4300_core.h's regs()/mult_hi()/mult_lo()/
 * pc() accessors, precomp_instr's void(*ops)(void) signature,
 * fast_mem_access(), generic_jump_to(), invalidate_r4300_cached_code()) -
 * not the synthetic TestState used by the standalone spike's own test
 * harness.
 *
 * NOT wired into ci_table/NOTCOMPILED as of this writing - see the .cpp
 * file's top comment for exactly why and what's left before it can be.
 * These entry points compile against the real core but nothing in the
 * live dispatch path calls them yet.
 */

struct r4300_core;

/* Call once at core init (mirrors init_blocks()'s lifetime). Creates the
 * backend singleton and zeroes the per-page JIT LUT. */
void vr4300_jit_bridge_init(struct r4300_core *r4300);

/* Call once at core teardown (mirrors free_blocks()'s lifetime). */
void vr4300_jit_bridge_shutdown(void);

/* Call from wherever invalidate_r4300_cached_code() dispatches to
 * per-emumode invalidation (cached_interp.c's own hacktarux invalidation,
 * new_dynarec's, etc.) - NOT yet wired to that dispatch. size == 0 means
 * "invalidate everything" (matches invalidate_r4300_cached_code's own
 * contract). */
void vr4300_jit_bridge_invalidate(uint32_t address, uint32_t size);

/*
 * precomp_instr.ops-compatible entry point (void(*)(void), matches every
 * other cached_interp_* handler's signature exactly). On first hit at a
 * PC, decodes a straight-line run of instructions ending in exactly one
 * branch/jump + delay slot (the same block shape lr_play_backend and this
 * adapter both assume) from fast_mem_access(), lowers it via
 * vr4300_play_block_create(), and caches the result in a per-page LUT
 * (g_jit_pages[address>>12][... ]) mirroring cached_interp.blocks'
 * existing page granularity. Falls back to the normal interpreter
 * (byte-for-byte, via cached_interp_NOTCOMPILED()) if the block contains
 * an unsupported opcode.
 *
 * KNOWN GAP: does not run cp0_update_count()/gen_interrupt() per
 * instruction the way the interpreter and DECLARE_JUMP's branches do -
 * COP0 cycle counting and mid-block interrupts are Phase NJ2 scope per
 * the plan (docs/research/n64-wasm-jit-plan.md), not NJ1. Do not wire
 * this into the live dispatch table until that gap is closed or
 * explicitly accepted as a scoped limitation with a real fallback
 * (e.g. only JIT blocks below a size that can't plausibly straddle an
 * interrupt-sensitive boundary).
 */
void cached_interp_JIT_ENTRY(void);

/*
 * Shadow-differential validation harness (N64_JIT_SHADOW_CHECK, opt-in,
 * layered on top of WITH_N64_JIT - independent flag, but the shadow harness
 * reuses this bridge's own LookupOrCompile()/vr4300_play_block_run() code,
 * so it only builds when WITH_N64_JIT's sources are also present). Purely
 * observational: never touches ci_table, never changes what the real
 * interpreter executes or what state it ends up in. See
 * docs/research/n64-jit-nj1-spike.md for the full design and the real
 * match/mismatch counts from running it against the smoke ROM.
 *
 * vr4300_jit_shadow_on_decode(): call from cached_interp_recompile_block()
 * with the same `func` it was given (guaranteed to equal the real live PC
 * at that moment - cached_interp_NOTCOMPILED() is recompile_block's only
 * real call site, and always passes *r4300_pc(r4300)). If the tier-1
 * adapter can fully lower a block there, this snapshots the CURRENT real
 * architectural state (GPRs, hi, lo) into a private copy, runs the
 * compiled block against ONLY that copy, and stashes the predicted
 * post-block state (GPRs, hi, lo, exit PC) for later comparison. Never
 * writes to the real r4300_core state. COP0 registers are explicitly NOT
 * snapshotted or compared yet - see the doc for why.
 *
 * vr4300_jit_shadow_poll(): call after every real instruction retires
 * (i.e. right after every ->ops() call in run_cached_interpreter()'s main
 * loop). Cheap no-op scan when nothing is pending. Once the real PC has
 * moved outside a pending entry's tracked block span - this harness's
 * signal for "the interpreter just finished retiring this block" -
 * compares the REAL state at that instant against the entry's predicted
 * state and logs any mismatch via DebugMessage(); never aborts, never
 * mutates real state either way.
 */
void vr4300_jit_shadow_on_decode(struct r4300_core *r4300, uint32_t func);
void vr4300_jit_shadow_poll(struct r4300_core *r4300);

#ifdef __cplusplus
}
#endif
