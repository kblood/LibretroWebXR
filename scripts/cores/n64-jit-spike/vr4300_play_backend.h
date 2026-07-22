#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * VR4300 (N64 CPU) tier-1 block adapter, in the same shape as this project's
 * shipping PSX adapter (lr_play_backend.h/.cpp in psx-wasm-jit-libretro):
 * a per-block IR lowering from raw MIPS opcodes to Play--CodeGen's Jitter,
 * with a per-block fallback to an interpreter callback for anything tier 1
 * doesn't cover. Unlike PSX's R3000A, the VR4300 has 64-bit GPRs (MIPS III)
 * and "likely" branches (annulled delay slot when not taken) - both handled
 * explicitly here; see docs/research/n64-wasm-jit-plan.md Phase NJ1.
 *
 * Tier-1 scope (this spike): integer ALU (32- and 64-bit forms), shifts
 * (32- and 64-bit, immediate and variable), LUI, and all branches/jumps
 * with their delay slot, including the MIPS-II likely variants. Loads/
 * stores, FPU, MULT/DIV, and TLB are explicitly out of scope for this
 * spike and fall back to the interpreter callback (per-block, matching
 * the PSX adapter's fallback granularity).
 */
struct vr4300_play_layout {
	size_t gpr;           /* offset of int64_t regs[32] */
	size_t hi;             /* offset of int64_t hi */
	size_t lo;              /* offset of int64_t lo */
	size_t current_cycle;  /* offset of a cycle counter this adapter increments */
	size_t curr_pc;        /* offset of the uint32_t PC this adapter writes on exit */
};

struct vr4300_play_backend;
struct vr4300_play_block;

typedef uint32_t (*vr4300_play_interpreter_fn)(void *state, void *opaque, uint32_t pc);

enum vr4300_play_run_result {
	VR4300_PLAY_RUN_COMPILED = 0,
	VR4300_PLAY_RUN_INTERPRETED = 1,
	VR4300_PLAY_RUN_INVALIDATED = 2,
	VR4300_PLAY_RUN_ERROR = 3,
};

enum vr4300_play_block_mode {
	VR4300_PLAY_BLOCK_COMPILED = 0,
	VR4300_PLAY_BLOCK_INTERPRETER = 1,
};

struct vr4300_play_backend *
vr4300_play_backend_create(const struct vr4300_play_layout *layout,
			    vr4300_play_interpreter_fn interpreter,
			    void *interpreter_opaque);
void vr4300_play_backend_destroy(struct vr4300_play_backend *backend);

/*
 * Compile one raw guest block: zero or more linear instructions followed by
 * exactly one branch/jump and its delay slot (the same block shape the PSX
 * adapter uses). `cycle_cost` is supplied by the caller, exactly as
 * lr_play_block_create expects from Lightrec.
 *
 * Unsupported instructions (anything outside the tier-1 opcode set below)
 * cause the whole block to fall back to interpreter mode - a non-NULL
 * return therefore always has a correct execution route.
 */
struct vr4300_play_block *
vr4300_play_block_create(struct vr4300_play_backend *backend, const uint32_t *opcodes,
			  size_t count, uint32_t start_pc, uint32_t cycle_cost,
			  char *error, size_t error_size);
void vr4300_play_block_destroy(struct vr4300_play_block *block);

enum vr4300_play_run_result vr4300_play_block_run(struct vr4300_play_block *block, void *state);
enum vr4300_play_block_mode vr4300_play_block_get_mode(const struct vr4300_play_block *block);

#ifdef __cplusplus
}
#endif
