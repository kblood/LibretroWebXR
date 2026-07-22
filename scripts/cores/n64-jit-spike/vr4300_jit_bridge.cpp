/*
 * NJ1 bridge implementation. See vr4300_jit_bridge.h for the contract and
 * docs/research/n64-jit-nj1-spike.md for what is and isn't proven yet.
 *
 * WHY THIS IS NOT WIRED INTO THE LIVE DISPATCH TABLE (ci_table) YET:
 * cached_interp_JIT_ENTRY() below does not call cp0_update_count() or
 * gen_interrupt() the way the interpreter and every DECLARE_JUMP branch do
 * per-instruction - COP0 timer-driven interrupts (VI, the RCP interrupts
 * lightweight-polled off cp0_cycle_count) simply wouldn't fire on schedule
 * inside a compiled block. That's explicitly Phase NJ2 scope in
 * docs/research/n64-wasm-jit-plan.md, not NJ1 - this file gets the
 * lowering/LUT/dispatch machinery real and buildable against the actual
 * core headers first, so NJ2's interrupt-accuracy work has a real
 * dispatch path to land in rather than starting from nothing.
 *
 * Design choice: rather than have the compiled IR write directly into
 * r4300_core's real regs[]/hi/lo (which would require this file's layout
 * offsets to track NEW_DYNAREC's alternate memory layout, see
 * r4300_core.h's R4300_REGS_OFFSET), this bridge copies the real
 * architectural state into a small contiguous BridgeState, runs the
 * compiled block against THAT (identical layout to the shape already
 * validated 128/128 in scripts/cores/n64-jit-spike/test_vr4300_jit.cpp),
 * then copies back. Costs one ~272-byte memcpy each way per block entry -
 * irrelevant next to a JIT's whole point, and keeps this file decoupled
 * from r4300_core.h's layout variants entirely.
 */

#include "vr4300_jit_bridge.h"
#include "vr4300_play_backend.h"

#include <cstddef>
#include <cstring>

extern "C" {
#include "device/r4300/r4300_core.h"
#include "device/r4300/cached_interp.h"
#include "main/main.h"
}

namespace
{

struct BridgeState
{
	int64_t regs[32];
	int64_t hi;
	int64_t lo;
	uint32_t cycle;
	uint32_t exit_pc;
};

vr4300_play_layout MakeLayout()
{
	vr4300_play_layout layout {};
	layout.gpr = offsetof(BridgeState, regs);
	layout.hi = offsetof(BridgeState, hi);
	layout.lo = offsetof(BridgeState, lo);
	layout.current_cycle = offsetof(BridgeState, cycle);
	layout.curr_pc = offsetof(BridgeState, exit_pc);
	return layout;
}

/* One page's worth of compiled-block slots, indexed the same way
 * cached_interp.blocks' precomp_instr array is: (address & 0xFFF) >> 2.
 * Lazily allocated, mirroring cached_interp_init_block()'s own pattern. */
constexpr size_t kPageShift = 12;
constexpr size_t kPageCount = 0x100000;
constexpr size_t kSlotsPerPage = (1u << kPageShift) / 4;

vr4300_play_block **g_jit_pages[kPageCount];
vr4300_play_backend *g_backend = nullptr;

/* Interpreter fallback for blocks vr4300_play_block_create() couldn't
 * fully lower (falls back per-block, same granularity as the PSX
 * adapter). Invoked by vr4300_play_block_run() itself whenever a block's
 * mode is VR4300_PLAY_BLOCK_INTERPRETER, which only ever happens after
 * cached_interp_JIT_ENTRY() has already confirmed *r4300_pc(r4300) == pc
 * - so this can single-step via the real cached interpreter's own
 * NOTCOMPILED2 path directly, with no PC re-positioning needed, and
 * behavior is byte-for-byte identical to never having JIT-attempted this
 * address at all. */
uint32_t InterpretOneBlock(void *state, void *opaque, uint32_t pc)
{
	(void)state;
	(void)opaque;
	(void)pc;
	auto *r4300 = &g_dev.r4300;
	cached_interp_NOTCOMPILED2();
	return *r4300_pc(r4300);
}

void FreePage(size_t pageIndex)
{
	vr4300_play_block **page = g_jit_pages[pageIndex];
	if(!page) return;
	for(size_t i = 0; i < kSlotsPerPage; i++)
	{
		if(page[i]) vr4300_play_block_destroy(page[i]);
	}
	delete[] page;
	g_jit_pages[pageIndex] = nullptr;
}

/* Scans raw instruction words starting at `startPc` for the block shape
 * this adapter expects: zero or more linear instructions followed by
 * exactly one terminator (branch/jump) plus its delay slot. Stops early
 * (declines to compile) if no terminator appears before the page ends or
 * a generous safety cap is hit - conservative on purpose: an over-long
 * scan just means more addresses fall back to the interpreter, which is
 * always correct, just not accelerated. */
bool ScanBlock(struct r4300_core *r4300, uint32_t startPc, uint32_t *outWords, size_t maxWords, size_t *outCount)
{
	constexpr size_t kMaxScan = 64;
	const size_t cap = maxWords < kMaxScan ? maxWords : kMaxScan;

	uint32_t *mem = fast_mem_access(r4300, startPc);
	if(!mem) return false;

	for(size_t i = 0; i + 1 < cap; i++)
	{
		const uint32_t iw = mem[i];
		outWords[i] = iw;
		if(vr4300_play_is_block_terminator(iw))
		{
			/* Include exactly one more word: the delay slot. */
			outWords[i + 1] = mem[i + 1];
			*outCount = i + 2;
			return true;
		}
	}
	return false;
}

vr4300_play_block *LookupOrCompile(struct r4300_core *r4300, uint32_t pc)
{
	const size_t pageIndex = pc >> kPageShift;
	const size_t slot = (pc & 0xFFFu) >> 2;

	vr4300_play_block **page = g_jit_pages[pageIndex];
	if(!page)
	{
		page = new vr4300_play_block *[kSlotsPerPage]();
		g_jit_pages[pageIndex] = page;
	}
	if(page[slot]) return page[slot];

	/* Words remaining until the end of this 4KB page - a block can't
	 * cross a page boundary here, matching cached_interp's own per-page
	 * invalidation granularity. */
	const uint32_t wordsToPageEnd = ((0x1000u - (pc & 0xFFFu)) / 4);

	uint32_t words[64];
	size_t count = 0;
	if(!ScanBlock(r4300, pc, words, wordsToPageEnd, &count))
		return nullptr; /* No clean terminator found - stays uncompiled. */

	char error[256];
	vr4300_play_block *block = vr4300_play_block_create(
		g_backend, words, count, pc, static_cast<uint32_t>(count), error, sizeof(error));
	page[slot] = block;
	return block;
}

} // namespace

void vr4300_jit_bridge_init(struct r4300_core *)
{
	if(g_backend) return;
	vr4300_play_layout layout = MakeLayout();
	g_backend = vr4300_play_backend_create(&layout, InterpretOneBlock, nullptr);
	for(size_t i = 0; i < kPageCount; i++) g_jit_pages[i] = nullptr;
}

void vr4300_jit_bridge_shutdown(void)
{
	for(size_t i = 0; i < kPageCount; i++) FreePage(i);
	if(g_backend)
	{
		vr4300_play_backend_destroy(g_backend);
		g_backend = nullptr;
	}
}

void vr4300_jit_bridge_invalidate(uint32_t address, uint32_t size)
{
	if(size == 0)
	{
		for(size_t i = 0; i < kPageCount; i++) FreePage(i);
		return;
	}
	const size_t firstPage = address >> kPageShift;
	const size_t lastPage = (address + (size ? size - 1 : 0)) >> kPageShift;
	for(size_t p = firstPage; p <= lastPage && p < kPageCount; p++) FreePage(p);
}

extern "C" void cached_interp_JIT_ENTRY(void)
{
	auto *r4300 = &g_dev.r4300;
	const uint32_t pc = *r4300_pc(r4300);

	vr4300_play_block *block = LookupOrCompile(r4300, pc);
	if(!block)
	{
		/* No clean single-terminator block could be scanned at all (e.g.
		 * no branch found before the page ended) - run this one address
		 * via the ordinary interpreter and leave the JIT out of it. */
		cached_interp_NOTCOMPILED2();
		return;
	}

	/* block may be VR4300_PLAY_BLOCK_COMPILED or _INTERPRETER - either
	 * way vr4300_play_block_run() below does the right thing (runs the
	 * compiled IR, or calls InterpretOneBlock() above), so both cases
	 * are handled uniformly here. */
	BridgeState state {};
	std::memcpy(state.regs, r4300_regs(r4300), sizeof(state.regs));
	state.hi = *r4300_mult_hi(r4300);
	state.lo = *r4300_mult_lo(r4300);
	state.cycle = 0;
	state.exit_pc = pc;

	vr4300_play_block_run(block, &state);

	std::memcpy(r4300_regs(r4300), state.regs, sizeof(state.regs));
	*r4300_mult_hi(r4300) = state.hi;
	*r4300_mult_lo(r4300) = state.lo;

	generic_jump_to(r4300, state.exit_pc);
}
