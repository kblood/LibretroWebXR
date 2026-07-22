/*
 * NJ1 bridge implementation. See vr4300_jit_bridge.h for the contract and
 * docs/research/n64-jit-nj1-spike.md for what is and isn't proven yet.
 *
 * WHY THIS IS NOT WIRED INTO THE LIVE DISPATCH TABLE (ci_table) YET:
 * cached_interp_JIT_ENTRY() below now DOES call an equivalent of
 * cp0_update_count()/gen_interrupt() once per compiled block (see
 * AccountBlockCycles() and the COMPILED branch below), designed by close
 * reading of cp0.c/interrupt.c/cached_interp.c to match the real
 * interpreter's own per-branch accounting exactly - but none of it has
 * been tested against a real interrupt-firing ROM yet (no ci_table wiring
 * exists to reach it live, and no differential harness exists yet
 * either). Wiring this in before that testing exists would risk a real,
 * live regression to the currently-shipping, verified interpreter-only
 * core for the sake of unverified progress - that's explicitly still
 * gated on Phase NJ2's testing step in docs/research/n64-wasm-jit-plan.md,
 * not a NJ1 exit requirement. Full derivation in
 * docs/research/n64-jit-nj1-spike.md.
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
#include <cstdio>
#include <cstring>

#if defined(N64_JIT_SHADOW_CHECK)
#define __STDC_FORMAT_MACROS
#include <cinttypes>
#endif

extern "C" {
#include "device/r4300/r4300_core.h"
#include "device/r4300/cached_interp.h"
#include "device/r4300/interrupt.h"
#include "main/main.h"
#if defined(N64_JIT_SHADOW_CHECK)
#include "api/callbacks.h"
#endif
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
 * Lazily allocated, mirroring cached_interp_init_block()'s own pattern.
 * word_count is tracked alongside the block itself so cached_interp_
 * JIT_ENTRY() can find the delay-slot checkpoint address for COP0
 * cycle accounting (see AccountBlockCycles() below) without rescanning. */
constexpr size_t kPageShift = 12;
constexpr size_t kPageCount = 0x100000;
constexpr size_t kSlotsPerPage = (1u << kPageShift) / 4;

struct JitSlot
{
	vr4300_play_block *block = nullptr;
	uint32_t word_count = 0;
};

JitSlot *g_jit_pages[kPageCount];
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
	JitSlot *page = g_jit_pages[pageIndex];
	if(!page) return;
	for(size_t i = 0; i < kSlotsPerPage; i++)
	{
		if(page[i].block) vr4300_play_block_destroy(page[i].block);
	}
	delete[] page;
	g_jit_pages[pageIndex] = nullptr;
}

/* Reproduces cp0_update_count()'s exact formula (device/r4300/cp0.c) for
 * a given checkpoint PC, without touching the real PC struct pointer -
 * calling the real function would require repositioning *r4300_pc(r4300)
 * first, and generic_jump_to() (the only real way to do that in this
 * build's EMUMODE_INTERPRETER) has side effects (skip_jump early-return,
 * update_invalid_addr, conditional page re-decode via cached_interpreter_
 * jump_to()) that are wrong to trigger twice per block exit just for
 * bookkeeping. Only valid for VR4300_PLAY_RUN_COMPILED blocks - see the
 * call site and docs/research/n64-jit-nj1-spike.md for why the
 * VR4300_PLAY_RUN_INTERPRETED case must not call this at all. */
void AccountBlockCycles(struct r4300_core *r4300, uint32_t checkpointPc)
{
	struct cp0 *cp0 = &r4300->cp0;
	uint32_t *cp0_regs = r4300_cp0_regs(cp0);
	int *cp0_cycle_count = r4300_cp0_cycle_count(cp0);

	uint32_t count = ((checkpointPc - cp0->last_addr) >> 2) * cp0->count_per_op;
	if(cp0->count_per_op_denom_pot)
	{
		count += (1u << cp0->count_per_op_denom_pot) - 1;
		count >>= cp0->count_per_op_denom_pot;
	}
	cp0_regs[CP0_COUNT_REG] += count;
	*cp0_cycle_count += count;
	cp0->last_addr = checkpointPc;
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

JitSlot *LookupOrCompile(struct r4300_core *r4300, uint32_t pc)
{
	const size_t pageIndex = pc >> kPageShift;
	const size_t slot = (pc & 0xFFFu) >> 2;

	JitSlot *page = g_jit_pages[pageIndex];
	if(!page)
	{
		page = new JitSlot[kSlotsPerPage]();
		g_jit_pages[pageIndex] = page;
	}
	if(page[slot].block) return &page[slot];

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
	if(!block) return nullptr;
	page[slot].block = block;
	page[slot].word_count = static_cast<uint32_t>(count);
	return &page[slot];
}

} // namespace

#if defined(N64_JIT_SHADOW_CHECK)
namespace
{

/*
 * One pending shadow prediction: a block LookupOrCompile() found and
 * confirmed VR4300_PLAY_BLOCK_COMPILED for, already run against a private
 * BridgeState copy at decode time (see vr4300_jit_shadow_on_decode()
 * below), waiting for the real interpreter to retire the same address
 * range so the two can be compared. A small fixed-capacity array, not a
 * dynamic container - this is a purely observational probe, and dropping
 * an over-capacity entry (counted in g_shadowDropped) is preferable to
 * adding allocation or contention to the hot per-instruction poll.
 */
struct ShadowEntry
{
	bool active = false;
	uint32_t startPc = 0;
	uint32_t wordCount = 0;
	int64_t regs[32] = {};
	int64_t hi = 0;
	int64_t lo = 0;
	uint32_t exitPc = 0;
};

constexpr size_t kMaxPendingShadow = 16;
ShadowEntry g_shadowPending[kMaxPendingShadow];
uint32_t g_shadowChecked = 0;
uint32_t g_shadowMatched = 0;
uint32_t g_shadowMismatched = 0;
uint32_t g_shadowDropped = 0;

/*
 * Every shadow-check log line is explicitly prefixed "[info] " so this
 * project's worker-side classifyCoreLog() (src/runtime/coreLog.js)
 * deterministically tags it 'info' regardless of whether the mupen64plus
 * DebugMessage() callback happens to route through stdout or stderr in
 * this build - the stderr path's un-prefixed fallback is 'error', which
 * would otherwise turn every shadow-check line (match or mismatch alike)
 * into a real console.warn() on the host page and trip probe-n64-core.js's
 * "no browser warnings" assertion, even though nothing regressed. Using
 * M64MSG_WARNING/M64MSG_ERROR here would not fix that (classification is
 * purely text-prefix-based, not tied to the M64MSG_* level passed in) -
 * only the literal "[info] " prefix does.
 */
void LogFieldMismatch(uint32_t startPc, const char *field, int64_t expected, int64_t actual)
{
	/* Uses fprintf(stderr, ...) rather than DebugMessage() - the
	 * decode-tally diagnostic below found that DebugMessage(M64MSG_INFO,...)
	 * lines never reach the worker's log listener in this build (most
	 * likely RetroArch's own core log-level cvar filtering INFO-level
	 * messages before they reach retro_log()/Module.printErr - not
	 * confirmed further, but a raw libc stdio call bypasses that path
	 * entirely and is confirmed to arrive, so it's used here too). */
	std::fprintf(stderr,
		"[info] N64_JIT_SHADOW mismatch: block_pc=%08" PRIx32 " field=%s jit=%016" PRIx64 " interp=%016" PRIx64 "\n",
		startPc, field, (uint64_t)expected, (uint64_t)actual);
}

/* Compares the real, just-retired architectural state against this entry's
 * decode-time shadow prediction. Only ever reads real state - never writes
 * it, regardless of match/mismatch. GPRs/hi/lo/PC are compared; COP0 is
 * explicitly out of scope (the shadow run's BridgeState has no COP0 fields
 * at all - see docs/research/n64-jit-nj1-spike.md for why extending this
 * to COP0 was not attempted in this pass). */
void CompareAndReport(struct r4300_core *r4300, const ShadowEntry &entry)
{
	g_shadowChecked++;
	bool mismatch = false;

	const int64_t *realRegs = r4300_regs(r4300);
	for(int i = 0; i < 32; i++)
	{
		if(realRegs[i] != entry.regs[i])
		{
			char name[16];
			std::snprintf(name, sizeof(name), "gpr[%d]", i);
			LogFieldMismatch(entry.startPc, name, entry.regs[i], realRegs[i]);
			mismatch = true;
		}
	}
	if(*r4300_mult_hi(r4300) != entry.hi)
	{
		LogFieldMismatch(entry.startPc, "hi", entry.hi, *r4300_mult_hi(r4300));
		mismatch = true;
	}
	if(*r4300_mult_lo(r4300) != entry.lo)
	{
		LogFieldMismatch(entry.startPc, "lo", entry.lo, *r4300_mult_lo(r4300));
		mismatch = true;
	}
	const uint32_t realPc = *r4300_pc(r4300);
	if(realPc != entry.exitPc)
	{
		LogFieldMismatch(entry.startPc, "pc", entry.exitPc, realPc);
		mismatch = true;
	}

	if(mismatch) g_shadowMismatched++;
	else g_shadowMatched++;

	/* A running summary line on every checked block (not just mismatches)
	 * so a short-lived probe run still leaves a final tally in whatever
	 * log capture is watching, even if it stops before any explicit
	 * teardown/report call. */
	std::fprintf(stderr,
		"[info] N64_JIT_SHADOW summary: checked=%" PRIu32 " matched=%" PRIu32 " mismatched=%" PRIu32
		" dropped=%" PRIu32 " last_block_pc=%08" PRIx32 " last_result=%s\n",
		g_shadowChecked, g_shadowMatched, g_shadowMismatched, g_shadowDropped,
		entry.startPc, mismatch ? "MISMATCH" : "match");
}

} // namespace

void vr4300_jit_shadow_on_decode(struct r4300_core *r4300, uint32_t func)
{
	/* Self-initializing on first use - real ci_table dispatch never calls
	 * vr4300_jit_bridge_init() today (nothing wires cached_interp_JIT_ENTRY
	 * in), so the shadow harness lazily brings up the same backend/LUT
	 * cached_interp_JIT_ENTRY would use if it were ever wired, rather than
	 * requiring a separate real-init-path edit for this probe. */
	if(!g_backend)
	{
		vr4300_jit_bridge_init(r4300);
		if(!g_backend) return;
	}

	static uint32_t s_decodeCalls = 0;
	static uint32_t s_compiledEligible = 0;
	static uint32_t s_lookupFailed = 0;
	s_decodeCalls++;

	JitSlot *slot = LookupOrCompile(r4300, func);
	if(!slot || !slot->block)
	{
		s_lookupFailed++;
		if((s_decodeCalls & 0xFFF) == 0)
		{
			std::fprintf(stderr,
				"[info] N64_JIT_SHADOW decode-tally: decode_calls=%u compiled_eligible=%u lookup_failed=%u\n",
				s_decodeCalls, s_compiledEligible, s_lookupFailed);
		}
		return;
	}
	if(vr4300_play_block_get_mode(slot->block) != VR4300_PLAY_BLOCK_COMPILED)
	{
		/* Same tier-1 opcode-coverage criteria the (still-dead) real JIT
		 * entry point would use, reused via vr4300_play_block_get_mode()
		 * rather than re-implemented here - a block the adapter itself
		 * flags as interpreter-fallback has nothing to shadow-compare. */
		if((s_decodeCalls & 0xFFF) == 0)
		{
			std::fprintf(stderr,
				"[info] N64_JIT_SHADOW decode-tally: decode_calls=%u compiled_eligible=%u lookup_failed=%u\n",
				s_decodeCalls, s_compiledEligible, s_lookupFailed);
		}
		return;
	}
	s_compiledEligible++;
	std::fprintf(stderr,
		"[info] N64_JIT_SHADOW decode-tally: decode_calls=%u compiled_eligible=%u lookup_failed=%u (COMPILED block_pc=%08" PRIx32 ")\n",
		s_decodeCalls, s_compiledEligible, s_lookupFailed, func);

	size_t freeIndex = kMaxPendingShadow;
	for(size_t i = 0; i < kMaxPendingShadow; i++)
	{
		if(!g_shadowPending[i].active) { freeIndex = i; break; }
	}
	if(freeIndex == kMaxPendingShadow)
	{
		g_shadowDropped++;
		return;
	}

	BridgeState state {};
	std::memcpy(state.regs, r4300_regs(r4300), sizeof(state.regs));
	state.hi = *r4300_mult_hi(r4300);
	state.lo = *r4300_mult_lo(r4300);
	state.cycle = 0;
	state.exit_pc = func;

	if(vr4300_play_block_run(slot->block, &state) != VR4300_PLAY_RUN_COMPILED) return;

	ShadowEntry &entry = g_shadowPending[freeIndex];
	entry.active = true;
	entry.startPc = func;
	entry.wordCount = slot->word_count;
	std::memcpy(entry.regs, state.regs, sizeof(entry.regs));
	entry.hi = state.hi;
	entry.lo = state.lo;
	entry.exitPc = state.exit_pc;
}

void vr4300_jit_shadow_poll(struct r4300_core *r4300)
{
	if(!g_backend) return;
	const uint32_t pc = *r4300_pc(r4300);
	for(size_t i = 0; i < kMaxPendingShadow; i++)
	{
		ShadowEntry &entry = g_shadowPending[i];
		if(!entry.active) continue;
		const uint32_t blockEnd = entry.startPc + entry.wordCount * 4;
		if(pc >= entry.startPc && pc < blockEnd) continue; /* still inside - not retired yet */
		CompareAndReport(r4300, entry);
		entry.active = false;
	}
}
#endif // N64_JIT_SHADOW_CHECK

#if defined(__EMSCRIPTEN__)
#include <emscripten.h>
/*
 * Real bug found the first time this bridge ever ran live (via the
 * shadow-check harness): Play--CodeGen's own WasmCreateFunction
 * (MemoryFunction.cpp) unconditionally instantiates every compiled block
 * module with an `env.fctTable` import bound to `Module.codeGenImportTable`
 * - but that table is only ever lazily created as a side effect of
 * CWasmFunctionRegistry::RegisterFunction() registering at least one
 * extern helper (Jitter_CodeGen_Wasm.cpp's RegisterExternFunction). Every
 * block this project has compiled before now (PS2 EE, PSX) always
 * references at least one helper (memory access, syscalls, ...), so this
 * never surfaced. Tier-1 VR4300 blocks (pure ALU/shifts/branches, no
 * loads/stores/helpers by design - see docs/research/n64-jit-nj1-spike.md)
 * can legitimately compile with zero registered externs, leaving
 * `Module.codeGenImportTable` undefined and crashing instantiation with
 * "table import requires a WebAssembly.Table". Fixed here, not in the
 * vendored CodeGen source, by forcing the same lazy-init CodeGen itself
 * would eventually do, once, before this bridge ever compiles a block.
 */
EM_JS(void, EnsureCodeGenImportTable, (), {
	if(Module.codeGenImportTable === undefined) {
		Module.codeGenImportTable = new WebAssembly.Table({ element: 'anyfunc', initial: 32 });
		Module.codeGenImportTableNextIndex = 0;
	}
});
#else
static void EnsureCodeGenImportTable(void) {}
#endif

void vr4300_jit_bridge_init(struct r4300_core *)
{
	if(g_backend) return;
	EnsureCodeGenImportTable();
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

	JitSlot *slot = LookupOrCompile(r4300, pc);
	if(!slot)
	{
		/* No clean single-terminator block could be scanned at all (e.g.
		 * no branch found before the page ended) - run this one address
		 * via the ordinary interpreter and leave the JIT out of it. */
		cached_interp_NOTCOMPILED2();
		return;
	}

	/* slot->block may be VR4300_PLAY_BLOCK_COMPILED or _INTERPRETER -
	 * either way vr4300_play_block_run() below does the right thing (runs
	 * the compiled IR, or calls InterpretOneBlock() above) - but the two
	 * cases need different COP0 cycle-accounting treatment afterward, see
	 * below. */
	BridgeState state {};
	std::memcpy(state.regs, r4300_regs(r4300), sizeof(state.regs));
	state.hi = *r4300_mult_hi(r4300);
	state.lo = *r4300_mult_lo(r4300);
	state.cycle = 0;
	state.exit_pc = pc;

	const vr4300_play_run_result result = vr4300_play_block_run(slot->block, &state);

	std::memcpy(r4300_regs(r4300), state.regs, sizeof(state.regs));
	*r4300_mult_hi(r4300) = state.hi;
	*r4300_mult_lo(r4300) = state.lo;

	if(result == VR4300_PLAY_RUN_COMPILED)
	{
		/* The whole word_count-instruction span (linear body + terminator
		 * + delay slot) just ran atomically as compiled IR with no
		 * internal COP0 accounting at all - replicate DECLARE_JUMP's own
		 * two-step protocol (device/r4300/cached_interp.c) exactly once
		 * for the whole block: account cycles up to the delay-slot
		 * address (BEFORE the jump), apply the real jump, reset
		 * cp0.last_addr to the post-jump PC, THEN check for a due
		 * interrupt - matching exception_general()'s EPC = *r4300_pc()
		 * capture happening only after the jump is applied, and
		 * delay_slot reading 0 at this point (this bridge never sets it),
		 * matching the interpreter's own convention of resetting it
		 * before this same check. See docs/research/n64-jit-nj1-spike.md
		 * for the full derivation - this is NOT yet tested against a
		 * real interrupt-firing ROM. */
		AccountBlockCycles(r4300, pc + (slot->word_count - 1) * 4);
		generic_jump_to(r4300, state.exit_pc);
		r4300->cp0.last_addr = *r4300_pc(r4300);
		if(*r4300_cp0_cycle_count(&r4300->cp0) >= 0) gen_interrupt(r4300);
	}
	else
	{
		/* VR4300_PLAY_RUN_INTERPRETED: InterpretOneBlock() executed
		 * exactly one real instruction via cached_interp_NOTCOMPILED2()'s
		 * unmodified .ops() handler, which - if that instruction was a
		 * branch - already did its own correct cp0_update_count()/
		 * gen_interrupt() internally, exactly as if reached through the
		 * ordinary ci_table path (which it was). Adding another
		 * accounting pass here, sized for the whole scanned block that
		 * was never actually executed as a unit in this fallback path,
		 * would double-count cycles or check an interrupt against a
		 * bogus PC delta - so this path must do nothing extra. */
		generic_jump_to(r4300, state.exit_pc);
	}
}
