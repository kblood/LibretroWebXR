#include "vr4300_play_backend.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <unordered_set>
#include <vector>

#include "Jitter.h"
#include "Jitter_CodeGenFactory.h"
#include "MemStream.h"
#include "MemoryFunction.h"

/*
 * VR4300 tier-1 lowering. Design grounded in two real references read
 * during this spike:
 *  - This project's own shipping PSX adapter (lr_play_backend.cpp in
 *    psx-wasm-jit-libretro) for the overall block/fallback/invalidate shape.
 *  - Play!'s own MIPS III/IV frontend (Source/MA_MIPSIV*.cpp,
 *    MIPSInstructionFactory.cpp), which lowers the PS2 EE (also MIPS III)
 *    through this same Jitter library, for the 64-bit GPR and branch idioms
 *    below (Jitter's 64-bit IR has Add64/Sub64/And64/Cmp64/Shl64/Srl64/Sra64
 *    but no Or64/Xor64 - confirmed by grepping Jitter.h; Play!'s own EE
 *    frontend handles OR/XOR/NOR by looping over the two 32-bit halves of
 *    the 64-bit register, which is the pattern mirrored here).
 */

namespace
{

constexpr uint32_t OP_SPECIAL = 0x00;
constexpr uint32_t OP_REGIMM  = 0x01;
constexpr uint32_t OP_J       = 0x02;
constexpr uint32_t OP_JAL     = 0x03;
constexpr uint32_t OP_BEQ     = 0x04;
constexpr uint32_t OP_BNE     = 0x05;
constexpr uint32_t OP_BLEZ    = 0x06;
constexpr uint32_t OP_BGTZ    = 0x07;
constexpr uint32_t OP_ADDIU   = 0x09;
constexpr uint32_t OP_SLTI    = 0x0a;
constexpr uint32_t OP_SLTIU   = 0x0b;
constexpr uint32_t OP_ANDI    = 0x0c;
constexpr uint32_t OP_ORI     = 0x0d;
constexpr uint32_t OP_XORI    = 0x0e;
constexpr uint32_t OP_LUI     = 0x0f;
constexpr uint32_t OP_BEQL    = 0x14;
constexpr uint32_t OP_BNEL    = 0x15;
constexpr uint32_t OP_BLEZL   = 0x16;
constexpr uint32_t OP_BGTZL   = 0x17;
constexpr uint32_t OP_DADDIU  = 0x19;

constexpr uint32_t SP_SLL    = 0x00;
constexpr uint32_t SP_SRL    = 0x02;
constexpr uint32_t SP_SRA    = 0x03;
constexpr uint32_t SP_SLLV   = 0x04;
constexpr uint32_t SP_SRLV   = 0x06;
constexpr uint32_t SP_SRAV   = 0x07;
constexpr uint32_t SP_JR     = 0x08;
constexpr uint32_t SP_JALR   = 0x09;
constexpr uint32_t SP_MFHI   = 0x10;
constexpr uint32_t SP_MTHI   = 0x11;
constexpr uint32_t SP_MFLO   = 0x12;
constexpr uint32_t SP_MTLO   = 0x13;
constexpr uint32_t SP_DSLLV  = 0x14;
constexpr uint32_t SP_DSRLV  = 0x16;
constexpr uint32_t SP_DSRAV  = 0x17;
constexpr uint32_t SP_ADDU   = 0x21;
constexpr uint32_t SP_SUBU   = 0x23;
constexpr uint32_t SP_AND    = 0x24;
constexpr uint32_t SP_OR     = 0x25;
constexpr uint32_t SP_XOR    = 0x26;
constexpr uint32_t SP_NOR    = 0x27;
constexpr uint32_t SP_SLT    = 0x2a;
constexpr uint32_t SP_SLTU   = 0x2b;
constexpr uint32_t SP_DADDU  = 0x2d;
constexpr uint32_t SP_DSUBU  = 0x2f;
constexpr uint32_t SP_DSLL   = 0x38;
constexpr uint32_t SP_DSRL   = 0x3a;
constexpr uint32_t SP_DSRA   = 0x3b;
constexpr uint32_t SP_DSLL32 = 0x3c;
constexpr uint32_t SP_DSRL32 = 0x3e;
constexpr uint32_t SP_DSRA32 = 0x3f;

constexpr uint32_t RT_BLTZ     = 0x00;
constexpr uint32_t RT_BGEZ     = 0x01;
constexpr uint32_t RT_BLTZL    = 0x02;
constexpr uint32_t RT_BGEZL    = 0x03;
constexpr uint32_t RT_BLTZAL   = 0x10;
constexpr uint32_t RT_BGEZAL   = 0x11;
constexpr uint32_t RT_BLTZALL  = 0x12;
constexpr uint32_t RT_BGEZALL  = 0x13;

uint32_t Primary(uint32_t op) { return op >> 26; }
uint32_t Rs(uint32_t op) { return (op >> 21) & 31; }
uint32_t Rt(uint32_t op) { return (op >> 16) & 31; }
uint32_t Rd(uint32_t op) { return (op >> 11) & 31; }
uint8_t Sa(uint32_t op) { return static_cast<uint8_t>((op >> 6) & 31); }
uint32_t Funct(uint32_t op) { return op & 63; }
uint32_t Imm(uint32_t op) { return op & 0xffff; }
uint32_t SImm(uint32_t op)
{
	return static_cast<uint32_t>(static_cast<int32_t>(static_cast<int16_t>(Imm(op))));
}

size_t GprOffset(const vr4300_play_layout& layout, uint32_t reg) { return layout.gpr + reg * sizeof(uint64_t); }
/* Host/target are always little-endian (x86_64 spike host, wasm32 shipping target). */
size_t GprLoOffset(const vr4300_play_layout& layout, uint32_t reg) { return GprOffset(layout, reg) + 0; }
size_t GprHiOffset(const vr4300_play_layout& layout, uint32_t reg) { return GprOffset(layout, reg) + 4; }

void PushReg64(Jitter::CJitter& jit, const vr4300_play_layout& layout, uint32_t reg)
{
	if(reg == 0) jit.PushCst64(0);
	else jit.PushRel64(GprOffset(layout, reg));
}

void PushRegLo(Jitter::CJitter& jit, const vr4300_play_layout& layout, uint32_t reg)
{
	if(reg == 0) jit.PushCst(0);
	else jit.PushRel(GprLoOffset(layout, reg));
}

/* Stores the freshly-computed 32-bit result on top of the stack into `reg`,
 * sign-extended to the full 64-bit register - the universal MIPS III rule
 * for every 32-bit-form ALU/shift op (ADDU, SUBU, SLL/SRL/SRA[V], LUI, ...). */
void StoreSignExtended32(Jitter::CJitter& jit, const vr4300_play_layout& layout, uint32_t reg)
{
	jit.PushTop();
	jit.SignExt();
	jit.PullRel(GprHiOffset(layout, reg));
	jit.PullRel(GprLoOffset(layout, reg));
}

void StorePc(Jitter::CJitter& jit, const vr4300_play_layout& layout, uint32_t pc)
{
	jit.PushCst(pc);
	jit.PullRel(layout.curr_pc);
}

/* Reduces a 64-bit condition to a taken/not-taken branch: Jitter's 64-bit IR
 * has Cmp64 (produces a 0/1 flag) but no 64-bit BeginIf, so every 64-bit
 * branch condition funnels through this - the same idiom Play!'s own EE
 * frontend uses (MA_MIPSIV_Templates.cpp's Template_BranchEq et al). */
void BeginIf64(Jitter::CJitter& jit, Jitter::CONDITION condition)
{
	jit.Cmp64(condition);
	jit.PushCst(0);
	jit.BeginIf(Jitter::CONDITION_NE);
}

/* Tier-1 integer ALU/shift ops (SPECIAL and I-type). Returns false (having
 * emitted nothing for THIS instruction - switch-default bails before any
 * Push) for anything outside tier 1, so the caller can safely abandon the
 * whole block's partially-built IR, exactly like the PSX adapter does. */
bool EmitAlu(Jitter::CJitter& jit, const vr4300_play_layout& layout, uint32_t op)
{
	const uint32_t primary = Primary(op);
	const uint32_t rs = Rs(op);
	const uint32_t rt = Rt(op);

	if(primary == OP_SPECIAL)
	{
		const uint32_t rd = Rd(op);
		const uint8_t sa = Sa(op);
		switch(Funct(op))
		{
		case SP_SLL:  if(rd) { PushRegLo(jit, layout, rt); jit.Shl(sa); StoreSignExtended32(jit, layout, rd); } return true;
		case SP_SRL:  if(rd) { PushRegLo(jit, layout, rt); jit.Srl(sa); StoreSignExtended32(jit, layout, rd); } return true;
		case SP_SRA:  if(rd) { PushRegLo(jit, layout, rt); jit.Sra(sa); StoreSignExtended32(jit, layout, rd); } return true;
		case SP_SLLV: if(rd) { PushRegLo(jit, layout, rt); PushRegLo(jit, layout, rs); jit.PushCst(31); jit.And(); jit.Shl(); StoreSignExtended32(jit, layout, rd); } return true;
		case SP_SRLV: if(rd) { PushRegLo(jit, layout, rt); PushRegLo(jit, layout, rs); jit.PushCst(31); jit.And(); jit.Srl(); StoreSignExtended32(jit, layout, rd); } return true;
		case SP_SRAV: if(rd) { PushRegLo(jit, layout, rt); PushRegLo(jit, layout, rs); jit.PushCst(31); jit.And(); jit.Sra(); StoreSignExtended32(jit, layout, rd); } return true;
		case SP_MFHI: if(rd) { jit.PushRel64(layout.hi); jit.PullRel64(GprOffset(layout, rd)); } return true;
		case SP_MFLO: if(rd) { jit.PushRel64(layout.lo); jit.PullRel64(GprOffset(layout, rd)); } return true;
		case SP_MTHI: PushReg64(jit, layout, rs); jit.PullRel64(layout.hi); return true;
		case SP_MTLO: PushReg64(jit, layout, rs); jit.PullRel64(layout.lo); return true;
		case SP_ADDU: if(rd) { PushRegLo(jit, layout, rs); PushRegLo(jit, layout, rt); jit.Add(); StoreSignExtended32(jit, layout, rd); } return true;
		case SP_SUBU: if(rd) { PushRegLo(jit, layout, rs); PushRegLo(jit, layout, rt); jit.Sub(); StoreSignExtended32(jit, layout, rd); } return true;
		case SP_AND:  if(rd) { PushReg64(jit, layout, rs); PushReg64(jit, layout, rt); jit.And64(); jit.PullRel64(GprOffset(layout, rd)); } return true;
		case SP_OR:
		case SP_XOR:
		case SP_NOR:
			if(rd)
			{
				for(size_t half = 0; half < 2; half++)
				{
					const size_t off = GprOffset(layout, rd) + half * 4;
					jit.PushRel(GprOffset(layout, rs) + half * 4);
					jit.PushRel(GprOffset(layout, rt) + half * 4);
					if(Funct(op) == SP_XOR) jit.Xor();
					else { jit.Or(); if(Funct(op) == SP_NOR) jit.Not(); }
					jit.PullRel(off);
				}
			}
			return true;
		case SP_SLT:  if(rd) { PushReg64(jit, layout, rs); PushReg64(jit, layout, rt); jit.Cmp64(Jitter::CONDITION_LT); jit.PullRel(GprLoOffset(layout, rd)); jit.PushCst(0); jit.PullRel(GprHiOffset(layout, rd)); } return true;
		case SP_SLTU: if(rd) { PushReg64(jit, layout, rs); PushReg64(jit, layout, rt); jit.Cmp64(Jitter::CONDITION_BL); jit.PullRel(GprLoOffset(layout, rd)); jit.PushCst(0); jit.PullRel(GprHiOffset(layout, rd)); } return true;
		case SP_DADDU: if(rd) { PushReg64(jit, layout, rs); PushReg64(jit, layout, rt); jit.Add64(); jit.PullRel64(GprOffset(layout, rd)); } return true;
		case SP_DSUBU: if(rd) { PushReg64(jit, layout, rs); PushReg64(jit, layout, rt); jit.Sub64(); jit.PullRel64(GprOffset(layout, rd)); } return true;
		case SP_DSLLV: if(rd) { PushReg64(jit, layout, rt); PushRegLo(jit, layout, rs); jit.PushCst(63); jit.And(); jit.Shl64(); jit.PullRel64(GprOffset(layout, rd)); } return true;
		case SP_DSRLV: if(rd) { PushReg64(jit, layout, rt); PushRegLo(jit, layout, rs); jit.PushCst(63); jit.And(); jit.Srl64(); jit.PullRel64(GprOffset(layout, rd)); } return true;
		case SP_DSRAV: if(rd) { PushReg64(jit, layout, rt); PushRegLo(jit, layout, rs); jit.PushCst(63); jit.And(); jit.Sra64(); jit.PullRel64(GprOffset(layout, rd)); } return true;
		case SP_DSLL:   if(rd) { PushReg64(jit, layout, rt); jit.Shl64(sa); jit.PullRel64(GprOffset(layout, rd)); } return true;
		case SP_DSRL:   if(rd) { PushReg64(jit, layout, rt); jit.Srl64(sa); jit.PullRel64(GprOffset(layout, rd)); } return true;
		case SP_DSRA:   if(rd) { PushReg64(jit, layout, rt); jit.Sra64(sa); jit.PullRel64(GprOffset(layout, rd)); } return true;
		case SP_DSLL32: if(rd) { PushReg64(jit, layout, rt); jit.Shl64(static_cast<uint8_t>(sa + 32)); jit.PullRel64(GprOffset(layout, rd)); } return true;
		case SP_DSRL32: if(rd) { PushReg64(jit, layout, rt); jit.Srl64(static_cast<uint8_t>(sa + 32)); jit.PullRel64(GprOffset(layout, rd)); } return true;
		case SP_DSRA32: if(rd) { PushReg64(jit, layout, rt); jit.Sra64(static_cast<uint8_t>(sa + 32)); jit.PullRel64(GprOffset(layout, rd)); } return true;
		default: return false;
		}
	}

	const uint32_t simm = SImm(op);
	const uint32_t imm = Imm(op);
	switch(primary)
	{
	case OP_ADDIU: if(rt) { PushRegLo(jit, layout, rs); jit.PushCst(simm); jit.Add(); StoreSignExtended32(jit, layout, rt); } return true;
	case OP_DADDIU: if(rt) { PushReg64(jit, layout, rs); jit.PushCst64(static_cast<uint64_t>(static_cast<int64_t>(static_cast<int32_t>(simm)))); jit.Add64(); jit.PullRel64(GprOffset(layout, rt)); } return true;
	case OP_SLTI:  if(rt) { PushReg64(jit, layout, rs); jit.PushCst64(static_cast<uint64_t>(static_cast<int64_t>(static_cast<int32_t>(simm)))); jit.Cmp64(Jitter::CONDITION_LT); jit.PullRel(GprLoOffset(layout, rt)); jit.PushCst(0); jit.PullRel(GprHiOffset(layout, rt)); } return true;
	case OP_SLTIU: if(rt) { PushReg64(jit, layout, rs); jit.PushCst64(static_cast<uint64_t>(static_cast<int64_t>(static_cast<int32_t>(simm)))); jit.Cmp64(Jitter::CONDITION_BL); jit.PullRel(GprLoOffset(layout, rt)); jit.PushCst(0); jit.PullRel(GprHiOffset(layout, rt)); } return true;
	case OP_ANDI:  if(rt) { PushRegLo(jit, layout, rs); jit.PushCst(imm); jit.And(); jit.PullRel(GprLoOffset(layout, rt)); jit.PushCst(0); jit.PullRel(GprHiOffset(layout, rt)); } return true;
	case OP_ORI:   if(rt) { PushRegLo(jit, layout, rs); jit.PushCst(imm); jit.Or();  jit.PullRel(GprLoOffset(layout, rt)); jit.PushRel(GprHiOffset(layout, rs)); jit.PullRel(GprHiOffset(layout, rt)); } return true;
	case OP_XORI:  if(rt) { PushRegLo(jit, layout, rs); jit.PushCst(imm); jit.Xor(); jit.PullRel(GprLoOffset(layout, rt)); jit.PushRel(GprHiOffset(layout, rs)); jit.PullRel(GprHiOffset(layout, rt)); } return true;
	case OP_LUI:   if(rt) { jit.PushCst(imm << 16); StoreSignExtended32(jit, layout, rt); } return true;
	default: return false;
	}
}

bool IsBranch(uint32_t op)
{
	const uint32_t primary = Primary(op);
	if(primary == OP_J || primary == OP_JAL) return true;
	if(primary >= OP_BEQ && primary <= OP_BGTZ) return true;
	if(primary >= OP_BEQL && primary <= OP_BGTZL) return true;
	if(primary == OP_REGIMM) return true;
	return primary == OP_SPECIAL && (Funct(op) == SP_JR || Funct(op) == SP_JALR);
}

bool IsLikely(uint32_t op)
{
	const uint32_t primary = Primary(op);
	if(primary >= OP_BEQL && primary <= OP_BGTZL) return true;
	if(primary == OP_REGIMM)
	{
		const uint32_t rt = Rt(op);
		return rt == RT_BLTZL || rt == RT_BGEZL || rt == RT_BLTZALL || rt == RT_BGEZALL;
	}
	return false;
}

/*
 * Lowers one block-terminating branch/jump plus its delay slot as a single
 * unit (unlike the linear ALU ops, the delay slot's placement relative to
 * the branch condition depends on likely-ness, so this owns both).
 * Returns false, having abandoned any IR opened for the delay slot, if the
 * delay-slot instruction itself is outside tier 1 - same "whole block falls
 * back to interpreter" contract as the PSX adapter.
 */
bool EmitBranchAndDelay(Jitter::CJitter& jit, const vr4300_play_layout& layout,
			 uint32_t branchOp, uint32_t delayOp, uint32_t pc)
{
	const uint32_t primary = Primary(branchOp);
	const uint32_t rs = Rs(branchOp);
	const uint32_t rt = Rt(branchOp);
	const uint32_t link = pc + 8;
	const uint32_t target = pc + 4 + (static_cast<int32_t>(SImm(branchOp)) << 2);
	const bool likely = IsLikely(branchOp);

	if(primary == OP_J || primary == OP_JAL)
	{
		const uint32_t jTarget = ((pc + 4) & 0xf0000000u) | ((branchOp & 0x03ffffffu) << 2);
		if(primary == OP_JAL) { jit.PushCst(static_cast<int32_t>(link)); StoreSignExtended32(jit, layout, 31); }
		if(!EmitAlu(jit, layout, delayOp)) return false;
		StorePc(jit, layout, jTarget);
		return true;
	}

	if(primary == OP_SPECIAL && (Funct(branchOp) == SP_JR || Funct(branchOp) == SP_JALR))
	{
		/* Capture the jump target from rs before the delay slot can mutate it. */
		PushRegLo(jit, layout, rs);
		jit.PullRel(layout.curr_pc);
		if(Funct(branchOp) == SP_JALR)
		{
			const uint32_t rd = Rd(branchOp);
			if(rd) { jit.PushCst(static_cast<int32_t>(link)); StoreSignExtended32(jit, layout, rd); }
		}
		if(!EmitAlu(jit, layout, delayOp)) return false;
		return true;
	}

	/* Conditional branches (BEQ/BNE/BLEZ/BGTZ, their *L likely forms, and
	 * REGIMM's BLTZ/BGEZ/BLTZAL/BGEZAL/*ALL). AL variants link
	 * unconditionally, before the branch condition is even evaluated -
	 * matching real hardware (the link write is part of executing the
	 * branch instruction, which happens before the delay slot regardless
	 * of whether the branch itself is taken). */
	bool isAl = false;
	Jitter::CONDITION cond;
	bool useRt0 = false; /* compare rs against 0 instead of rt */

	if(primary == OP_REGIMM)
	{
		switch(rt)
		{
		case RT_BLTZ: case RT_BLTZL:   cond = Jitter::CONDITION_LT; useRt0 = true; break;
		case RT_BGEZ: case RT_BGEZL:   cond = Jitter::CONDITION_GE; useRt0 = true; break;
		case RT_BLTZAL: case RT_BLTZALL: cond = Jitter::CONDITION_LT; useRt0 = true; isAl = true; break;
		case RT_BGEZAL: case RT_BGEZALL: cond = Jitter::CONDITION_GE; useRt0 = true; isAl = true; break;
		default: return false;
		}
	}
	else
	{
		switch(primary)
		{
		case OP_BEQ: case OP_BEQL: cond = Jitter::CONDITION_EQ; break;
		case OP_BNE: case OP_BNEL: cond = Jitter::CONDITION_NE; break;
		case OP_BLEZ: case OP_BLEZL: cond = Jitter::CONDITION_LE; useRt0 = true; break;
		case OP_BGTZ: case OP_BGTZL: cond = Jitter::CONDITION_GT; useRt0 = true; break;
		default: return false;
		}
	}

	if(isAl) { jit.PushCst(static_cast<int32_t>(link)); StoreSignExtended32(jit, layout, 31); }

	PushReg64(jit, layout, rs);
	if(useRt0) jit.PushCst64(0);
	else PushReg64(jit, layout, rt);
	BeginIf64(jit, cond);
	{
		if(likely) { if(!EmitAlu(jit, layout, delayOp)) return false; }
		StorePc(jit, layout, target);
	}
	jit.Else();
	{
		StorePc(jit, layout, link);
	}
	jit.EndIf();

	if(!likely)
	{
		if(!EmitAlu(jit, layout, delayOp)) return false;
	}
	return true;
}

void CopyError(const std::string& source, char *destination, size_t size)
{
	if(!destination || size == 0) return;
	const size_t count = std::min(size - 1, source.size());
	std::memcpy(destination, source.data(), count);
	destination[count] = '\0';
}

} // namespace

struct vr4300_play_backend
{
	vr4300_play_layout layout {};
	vr4300_play_interpreter_fn interpreter = nullptr;
	void *interpreterOpaque = nullptr;
	mutable std::mutex mutex;
	std::unordered_set<vr4300_play_block *> blocks;
};

struct vr4300_play_block
{
	vr4300_play_backend *backend = nullptr;
	uint32_t startPc = 0;
	size_t opcodeCount = 0;
	vr4300_play_block_mode mode = VR4300_PLAY_BLOCK_INTERPRETER;
	CMemoryFunction function;
};

extern "C" struct vr4300_play_backend *
vr4300_play_backend_create(const struct vr4300_play_layout *layout,
			    vr4300_play_interpreter_fn interpreter,
			    void *interpreter_opaque)
{
	if(!layout) return nullptr;
	auto backend = new(std::nothrow) vr4300_play_backend();
	if(!backend) return nullptr;
	backend->layout = *layout;
	backend->interpreter = interpreter;
	backend->interpreterOpaque = interpreter_opaque;
	return backend;
}

extern "C" void vr4300_play_backend_destroy(struct vr4300_play_backend *backend)
{
	if(!backend) return;
	std::vector<vr4300_play_block *> blocks;
	{
		std::lock_guard<std::mutex> lock(backend->mutex);
		blocks.assign(backend->blocks.begin(), backend->blocks.end());
	}
	for(auto *block : blocks) vr4300_play_block_destroy(block);
	delete backend;
}

extern "C" struct vr4300_play_block *
vr4300_play_block_create(struct vr4300_play_backend *backend, const uint32_t *opcodes,
			  size_t count, uint32_t start_pc, uint32_t cycle_cost,
			  char *error, size_t error_size)
{
	if(!backend || !opcodes || count == 0)
	{
		CopyError("invalid block arguments", error, error_size);
		return nullptr;
	}

	auto block = std::make_unique<vr4300_play_block>();
	block->backend = backend;
	block->startPc = start_pc;
	block->opcodeCount = count;

	Jitter::CJitter jit(Jitter::CreateCodeGen());
	Framework::CMemStream stream;
	jit.SetStream(&stream);
	jit.Begin();

	bool supported = true;
	bool hasBranch = false;
	for(size_t index = 0; index < count; index++)
	{
		const uint32_t op = opcodes[index];
		if(IsBranch(op))
		{
			if(index + 2 != count ||
			   !EmitBranchAndDelay(jit, backend->layout, op, opcodes[index + 1],
					       start_pc + static_cast<uint32_t>(index * 4)))
			{
				supported = false;
			}
			hasBranch = true;
			break;
		}
		if(!EmitAlu(jit, backend->layout, op))
		{
			supported = false;
			break;
		}
	}

	if(supported)
	{
		jit.PushRel(backend->layout.current_cycle);
		jit.PushCst(cycle_cost);
		jit.Add();
		jit.PullRel(backend->layout.current_cycle);
		if(!hasBranch)
			StorePc(jit, backend->layout, start_pc + static_cast<uint32_t>(count * 4));
		jit.End();

		block->function = CMemoryFunction(stream.GetBuffer(), stream.GetSize());
		if(block->function.IsEmpty())
		{
			CopyError("Play--CodeGen returned an empty function", error, error_size);
			return nullptr;
		}
		block->mode = VR4300_PLAY_BLOCK_COMPILED;
	}
	else
	{
		block->mode = VR4300_PLAY_BLOCK_INTERPRETER;
		if(!backend->interpreter)
		{
			CopyError("unsupported opcode and no interpreter callback", error, error_size);
			return nullptr;
		}
	}

	auto *result = block.release();
	{
		std::lock_guard<std::mutex> lock(backend->mutex);
		backend->blocks.insert(result);
	}
	CopyError("", error, error_size);
	return result;
}

extern "C" void vr4300_play_block_destroy(struct vr4300_play_block *block)
{
	if(!block) return;
	if(block->backend)
	{
		std::lock_guard<std::mutex> lock(block->backend->mutex);
		block->backend->blocks.erase(block);
	}
	delete block;
}

extern "C" enum vr4300_play_run_result
vr4300_play_block_run(struct vr4300_play_block *block, void *state)
{
	if(!block || !state) return VR4300_PLAY_RUN_ERROR;
	if(block->mode == VR4300_PLAY_BLOCK_COMPILED)
	{
		block->function(state);
		return VR4300_PLAY_RUN_COMPILED;
	}
	if(!block->backend || !block->backend->interpreter) return VR4300_PLAY_RUN_ERROR;
	const uint32_t nextPc = block->backend->interpreter(state, block->backend->interpreterOpaque, block->startPc);
	auto *bytes = static_cast<uint8_t *>(state);
	std::memcpy(bytes + block->backend->layout.curr_pc, &nextPc, sizeof(nextPc));
	return VR4300_PLAY_RUN_INTERPRETED;
}

extern "C" enum vr4300_play_block_mode
vr4300_play_block_get_mode(const struct vr4300_play_block *block)
{
	return block ? block->mode : VR4300_PLAY_BLOCK_INTERPRETER;
}
