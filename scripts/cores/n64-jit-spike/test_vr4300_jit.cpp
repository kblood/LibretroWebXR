/* Differential/unit test harness for the VR4300 tier-1 Jitter adapter spike.
 * Runs natively (x86_64 host backend via Jitter::CreateCodeGen()'s platform
 * auto-detection) for a fast iteration loop; the Wasm backend is the same
 * IR, swapped in only once this logic is proven, per the Emscripten build's
 * much slower edit/rebuild cycle. */
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "vr4300_play_backend.h"

namespace
{

struct TestState
{
	int64_t regs[32];
	int64_t hi;
	int64_t lo;
	uint32_t pc;
	uint32_t cycle;
};

vr4300_play_layout MakeLayout()
{
	vr4300_play_layout layout {};
	layout.gpr = offsetof(TestState, regs);
	layout.hi = offsetof(TestState, hi);
	layout.lo = offsetof(TestState, lo);
	layout.current_cycle = offsetof(TestState, cycle);
	layout.curr_pc = offsetof(TestState, pc);
	return layout;
}

uint32_t RType(uint32_t rs, uint32_t rt, uint32_t rd, uint32_t sa, uint32_t funct)
{
	return (rs << 21) | (rt << 16) | (rd << 11) | (sa << 6) | funct;
}
uint32_t IType(uint32_t op, uint32_t rs, uint32_t rt, uint16_t imm)
{
	return (op << 26) | (rs << 21) | (rt << 16) | imm;
}
uint32_t JType(uint32_t op, uint32_t target)
{
	return (op << 26) | (target & 0x03ffffff);
}

uint32_t ADDIU(uint32_t rt, uint32_t rs, int16_t imm) { return IType(0x09, rs, rt, static_cast<uint16_t>(imm)); }
uint32_t DADDIU(uint32_t rt, uint32_t rs, int16_t imm) { return IType(0x19, rs, rt, static_cast<uint16_t>(imm)); }
uint32_t ANDI(uint32_t rt, uint32_t rs, uint16_t imm) { return IType(0x0c, rs, rt, imm); }
uint32_t ORI(uint32_t rt, uint32_t rs, uint16_t imm) { return IType(0x0d, rs, rt, imm); }
uint32_t XORI(uint32_t rt, uint32_t rs, uint16_t imm) { return IType(0x0e, rs, rt, imm); }
uint32_t SLTI(uint32_t rt, uint32_t rs, int16_t imm) { return IType(0x0a, rs, rt, static_cast<uint16_t>(imm)); }
uint32_t SLTIU(uint32_t rt, uint32_t rs, int16_t imm) { return IType(0x0b, rs, rt, static_cast<uint16_t>(imm)); }
uint32_t LUI(uint32_t rt, uint16_t imm) { return IType(0x0f, 0, rt, imm); }
uint32_t NOP() { return 0; }

uint32_t ADDU(uint32_t rd, uint32_t rs, uint32_t rt) { return RType(rs, rt, rd, 0, 0x21); }
uint32_t SUBU(uint32_t rd, uint32_t rs, uint32_t rt) { return RType(rs, rt, rd, 0, 0x23); }
uint32_t AND(uint32_t rd, uint32_t rs, uint32_t rt) { return RType(rs, rt, rd, 0, 0x24); }
uint32_t OR(uint32_t rd, uint32_t rs, uint32_t rt) { return RType(rs, rt, rd, 0, 0x25); }
uint32_t XOR(uint32_t rd, uint32_t rs, uint32_t rt) { return RType(rs, rt, rd, 0, 0x26); }
uint32_t NOR(uint32_t rd, uint32_t rs, uint32_t rt) { return RType(rs, rt, rd, 0, 0x27); }
uint32_t SLT(uint32_t rd, uint32_t rs, uint32_t rt) { return RType(rs, rt, rd, 0, 0x2a); }
uint32_t SLTU(uint32_t rd, uint32_t rs, uint32_t rt) { return RType(rs, rt, rd, 0, 0x2b); }
uint32_t DADDU(uint32_t rd, uint32_t rs, uint32_t rt) { return RType(rs, rt, rd, 0, 0x2d); }
uint32_t DSUBU(uint32_t rd, uint32_t rs, uint32_t rt) { return RType(rs, rt, rd, 0, 0x2f); }
uint32_t SLL(uint32_t rd, uint32_t rt, uint32_t sa) { return RType(0, rt, rd, sa, 0x00); }
uint32_t SRL(uint32_t rd, uint32_t rt, uint32_t sa) { return RType(0, rt, rd, sa, 0x02); }
uint32_t SRA(uint32_t rd, uint32_t rt, uint32_t sa) { return RType(0, rt, rd, sa, 0x03); }
uint32_t SLLV(uint32_t rd, uint32_t rt, uint32_t rs) { return RType(rs, rt, rd, 0, 0x04); }
uint32_t DSLL(uint32_t rd, uint32_t rt, uint32_t sa) { return RType(0, rt, rd, sa, 0x38); }
uint32_t DSRL(uint32_t rd, uint32_t rt, uint32_t sa) { return RType(0, rt, rd, sa, 0x3a); }
uint32_t DSRA(uint32_t rd, uint32_t rt, uint32_t sa) { return RType(0, rt, rd, sa, 0x3b); }
uint32_t DSLL32(uint32_t rd, uint32_t rt, uint32_t sa) { return RType(0, rt, rd, sa, 0x3c); }
uint32_t DSLLV(uint32_t rd, uint32_t rt, uint32_t rs) { return RType(rs, rt, rd, 0, 0x14); }
uint32_t DSRLV(uint32_t rd, uint32_t rt, uint32_t rs) { return RType(rs, rt, rd, 0, 0x16); }
uint32_t DSRAV(uint32_t rd, uint32_t rt, uint32_t rs) { return RType(rs, rt, rd, 0, 0x17); }
uint32_t MFHI(uint32_t rd) { return RType(0, 0, rd, 0, 0x10); }
uint32_t MFLO(uint32_t rd) { return RType(0, 0, rd, 0, 0x12); }
uint32_t MTHI(uint32_t rs) { return RType(rs, 0, 0, 0, 0x11); }
uint32_t MTLO(uint32_t rs) { return RType(rs, 0, 0, 0, 0x13); }
uint32_t JR(uint32_t rs) { return RType(rs, 0, 0, 0, 0x08); }
uint32_t JALR(uint32_t rd, uint32_t rs) { return RType(rs, 0, rd, 0, 0x09); }

uint32_t BEQ(uint32_t rs, uint32_t rt, int16_t off) { return IType(0x04, rs, rt, static_cast<uint16_t>(off)); }
uint32_t BNE(uint32_t rs, uint32_t rt, int16_t off) { return IType(0x05, rs, rt, static_cast<uint16_t>(off)); }
uint32_t BLEZ(uint32_t rs, int16_t off) { return IType(0x06, rs, 0, static_cast<uint16_t>(off)); }
uint32_t BGTZ(uint32_t rs, int16_t off) { return IType(0x07, rs, 0, static_cast<uint16_t>(off)); }
uint32_t BEQL(uint32_t rs, uint32_t rt, int16_t off) { return IType(0x14, rs, rt, static_cast<uint16_t>(off)); }
uint32_t BNEL(uint32_t rs, uint32_t rt, int16_t off) { return IType(0x15, rs, rt, static_cast<uint16_t>(off)); }
uint32_t BLEZL(uint32_t rs, int16_t off) { return IType(0x16, rs, 0, static_cast<uint16_t>(off)); }
uint32_t BGTZL(uint32_t rs, int16_t off) { return IType(0x17, rs, 0, static_cast<uint16_t>(off)); }
uint32_t BLTZ(uint32_t rs, int16_t off) { return IType(0x01, rs, 0x00, static_cast<uint16_t>(off)); }
uint32_t BGEZ(uint32_t rs, int16_t off) { return IType(0x01, rs, 0x01, static_cast<uint16_t>(off)); }
uint32_t BLTZL(uint32_t rs, int16_t off) { return IType(0x01, rs, 0x02, static_cast<uint16_t>(off)); }
uint32_t BGEZL(uint32_t rs, int16_t off) { return IType(0x01, rs, 0x03, static_cast<uint16_t>(off)); }
uint32_t BLTZAL(uint32_t rs, int16_t off) { return IType(0x01, rs, 0x10, static_cast<uint16_t>(off)); }
uint32_t BGEZAL(uint32_t rs, int16_t off) { return IType(0x01, rs, 0x11, static_cast<uint16_t>(off)); }
uint32_t BLTZALL(uint32_t rs, int16_t off) { return IType(0x01, rs, 0x12, static_cast<uint16_t>(off)); }
uint32_t BGEZALL(uint32_t rs, int16_t off) { return IType(0x01, rs, 0x13, static_cast<uint16_t>(off)); }
uint32_t J(uint32_t target) { return JType(0x02, target >> 2); }
uint32_t JAL(uint32_t target) { return JType(0x03, target >> 2); }

int g_failures = 0;
int g_checks = 0;

void Check(const std::string& name, bool condition)
{
	g_checks++;
	if(!condition)
	{
		g_failures++;
		std::printf("FAIL: %s\n", name.c_str());
	}
}

void CheckEq64(const std::string& name, int64_t actual, int64_t expected)
{
	g_checks++;
	if(actual != expected)
	{
		g_failures++;
		std::printf("FAIL: %s (expected %lld, got %lld)\n", name.c_str(),
			    static_cast<long long>(expected), static_cast<long long>(actual));
	}
}

/* Compiles and runs one block; fails the test if it didn't compile (tier-1
 * unsupported) unless expectInterpreterFallback is set. */
TestState RunBlock(vr4300_play_backend *backend, const std::vector<uint32_t>& opcodes,
		    uint32_t startPc, TestState initial, bool expectCompiled = true)
{
	char error[256];
	vr4300_play_block *block = vr4300_play_block_create(
		backend, opcodes.data(), opcodes.size(), startPc, 1, error, sizeof(error));
	Check("block_create(" + std::to_string(startPc) + ")", block != nullptr);
	if(!block) return initial;

	if(expectCompiled)
		Check("block compiled (not interpreter fallback) @0x" + std::to_string(startPc),
		      vr4300_play_block_get_mode(block) == VR4300_PLAY_BLOCK_COMPILED);

	TestState state = initial;
	vr4300_play_block_run(block, &state);
	vr4300_play_block_destroy(block);
	return state;
}

} // namespace

int main()
{
	vr4300_play_layout layout = MakeLayout();
	vr4300_play_backend *backend = vr4300_play_backend_create(&layout, nullptr, nullptr);
	Check("backend_create", backend != nullptr);

	TestState zero {};

	// --- Pure ALU block, no branch ---
	{
		std::vector<uint32_t> ops {
			ADDIU(8, 0, 100),
			ADDIU(9, 0, 50),
			ADDU(10, 8, 9),
			SUBU(11, 8, 9),
			AND(12, 8, 9),
			OR(13, 8, 9),
			XOR(14, 8, 9),
			NOR(15, 8, 9),
			SLT(16, 9, 8),   // 50 < 100 -> 1
			SLTU(17, 8, 9),  // 100 < 50 (unsigned) -> 0
		};
		TestState s = RunBlock(backend, ops, 0x1000, zero);
		CheckEq64("ADDIU r8", s.regs[8], 100);
		CheckEq64("ADDIU r9", s.regs[9], 50);
		CheckEq64("ADDU r10", s.regs[10], 150);
		CheckEq64("SUBU r11", s.regs[11], 50);
		CheckEq64("AND r12", s.regs[12], 100 & 50);
		CheckEq64("OR r13", s.regs[13], 100 | 50);
		CheckEq64("XOR r14", s.regs[14], 100 ^ 50);
		// NOR is a full 64-bit op (MIPS III), unlike ADDU/SUBU's 32-bit-then-sign-
		// extend family: both operands' upper 32 bits are 0 here (ADDIU-sign-
		// extended positive values), so NOR's upper word is NOT(0|0)=0xFFFFFFFF,
		// making the full 64-bit result negative even though the low word alone
		// would print as a small positive number.
		CheckEq64("NOR r15 (full 64-bit op)", s.regs[15], ~(static_cast<int64_t>(100) | static_cast<int64_t>(50)) & ~(static_cast<int64_t>(0xFFFFFFFF00000000ULL)) | static_cast<int64_t>(0xFFFFFFFF00000000ULL));
		CheckEq64("SLT r16", s.regs[16], 1);
		CheckEq64("SLTU r17", s.regs[17], 0);
		CheckEq64("no-branch PC advance", s.pc, 0x1000 + static_cast<uint32_t>(ops.size() * 4));
	}

	// --- Sign extension: ADDIU with negative immediate, shifts, DADDIU ---
	{
		std::vector<uint32_t> ops {
			ADDIU(18, 0, -1),        // r18 = 0xFFFFFFFFFFFFFFFF
			DADDIU(19, 18, -1),      // r19 = -2 (64-bit add)
			SLL(21, 18, 4),          // (-1 << 4) sign-extended = -16
			SRA(22, 18, 4),          // arithmetic -1 >> 4 = -1
			SRL(23, 18, 4),          // logical 0xFFFFFFFF >> 4 = 0x0FFFFFFF (positive)
			LUI(24, 0x8000),         // sign-extended: bit31 set -> negative 64-bit
		};
		TestState s = RunBlock(backend, ops, 0x2000, zero);
		CheckEq64("ADDIU -1 sign-extends", s.regs[18], -1);
		CheckEq64("DADDIU 64-bit add", s.regs[19], -2);
		CheckEq64("SLL sign-extends", s.regs[21], -16);
		CheckEq64("SRA arithmetic", s.regs[22], -1);
		CheckEq64("SRL logical", s.regs[23], 0x0FFFFFFF);
		CheckEq64("LUI sign-extends when bit31 set", s.regs[24],
			  static_cast<int64_t>(static_cast<int32_t>(0x80000000u)));
	}

	// --- DSLL/DSRL/DSRA/DSLL32 on a full 64-bit pattern (pre-seeded, not derived) ---
	{
		TestState init = zero;
		init.regs[8] = static_cast<int64_t>(0x0123456789ABCDEFULL);
		std::vector<uint32_t> ops {
			DSLL(9, 8, 4),
			DSRL(10, 8, 4),
			DSRA(11, 8, 4),
			DSLL32(12, 8, 0),
		};
		TestState s = RunBlock(backend, ops, 0x3000, init);
		CheckEq64("DSLL", s.regs[9], static_cast<int64_t>(0x123456789ABCDEF0ULL));
		CheckEq64("DSRL", s.regs[10], static_cast<int64_t>(0x00123456789ABCDEULL));
		CheckEq64("DSRA", s.regs[11], static_cast<int64_t>(0x00123456789ABCDEULL)); // bit63=0 so same as DSRL
		CheckEq64("DSLL32", s.regs[12], static_cast<int64_t>(0x89ABCDEF00000000ULL));
	}

	// --- HI/LO move ---
	{
		TestState init = zero;
		init.hi = 0x1111;
		init.lo = 0x2222;
		std::vector<uint32_t> ops { MFHI(8), MFLO(9), ADDIU(10, 0, 5), MTHI(10), MTLO(10) };
		TestState s = RunBlock(backend, ops, 0x4000, init);
		CheckEq64("MFHI", s.regs[8], 0x1111);
		CheckEq64("MFLO", s.regs[9], 0x2222);
		CheckEq64("MTHI", s.hi, 5);
		CheckEq64("MTLO", s.lo, 5);
	}

	// --- BEQ taken: delay slot always runs, PC goes to target ---
	{
		std::vector<uint32_t> ops { ADDIU(8, 0, 5), ADDIU(9, 0, 5), BEQ(8, 9, 2), ADDIU(10, 0, 111) };
		TestState s = RunBlock(backend, ops, 0x5000, zero);
		uint32_t branchPc = 0x5000 + 2 * 4;
		uint32_t target = branchPc + 4 + (2 << 2);
		CheckEq64("BEQ taken delay slot runs", s.regs[10], 111);
		Check("BEQ taken PC == target", s.pc == target);
	}

	// --- BEQ not taken: PC falls through, delay slot still runs ---
	{
		std::vector<uint32_t> ops { ADDIU(8, 0, 5), ADDIU(9, 0, 6), BEQ(8, 9, 2), ADDIU(10, 0, 111) };
		TestState s = RunBlock(backend, ops, 0x5100, zero);
		uint32_t branchPc = 0x5100 + 2 * 4;
		uint32_t link = branchPc + 8;
		CheckEq64("BEQ not-taken delay slot still runs", s.regs[10], 111);
		Check("BEQ not-taken PC == fallthrough", s.pc == link);
	}

	// --- BNEL likely, NOT taken: delay slot must be annulled ---
	{
		std::vector<uint32_t> ops { ADDIU(8, 0, 5), ADDIU(9, 0, 5), BNEL(8, 9, 2), ADDIU(10, 0, 222) };
		TestState s = RunBlock(backend, ops, 0x5200, zero);
		uint32_t branchPc = 0x5200 + 2 * 4;
		uint32_t link = branchPc + 8;
		CheckEq64("BNEL not-taken delay slot ANNULLED", s.regs[10], 0);
		Check("BNEL not-taken PC == fallthrough", s.pc == link);
	}

	// --- BNEL likely, taken: delay slot must run ---
	{
		std::vector<uint32_t> ops { ADDIU(8, 0, 5), ADDIU(9, 0, 6), BNEL(8, 9, 2), ADDIU(10, 0, 222) };
		TestState s = RunBlock(backend, ops, 0x5300, zero);
		uint32_t branchPc = 0x5300 + 2 * 4;
		uint32_t target = branchPc + 4 + (2 << 2);
		CheckEq64("BNEL taken delay slot runs", s.regs[10], 222);
		Check("BNEL taken PC == target", s.pc == target);
	}

	// --- BLEZ / BGTZ ---
	{
		std::vector<uint32_t> ops { ADDIU(8, 0, static_cast<int16_t>(-1)), BLEZ(8, 3), NOP() };
		TestState s = RunBlock(backend, ops, 0x5400, zero);
		uint32_t branchPc = 0x5400 + 1 * 4;
		uint32_t target = branchPc + 4 + (3 << 2);
		Check("BLEZ taken (negative)", s.pc == target);
	}
	{
		std::vector<uint32_t> ops { ADDIU(8, 0, 1), BGTZ(8, 3), NOP() };
		TestState s = RunBlock(backend, ops, 0x5500, zero);
		uint32_t branchPc = 0x5500 + 1 * 4;
		uint32_t target = branchPc + 4 + (3 << 2);
		Check("BGTZ taken (positive)", s.pc == target);
	}

	// --- J / JAL, at a KSEG0 address (bit31 set) to exercise link sign-extension ---
	{
		const uint32_t startPc = 0x80000400;
		std::vector<uint32_t> ops { JAL(0x80000800), ADDIU(11, 0, 77) };
		TestState s = RunBlock(backend, ops, startPc, zero);
		Check("JAL delay slot runs", s.regs[11] == 77);
		Check("JAL PC == target", s.pc == 0x80000800);
		CheckEq64("JAL link sign-extended (KSEG0)", s.regs[31],
			  static_cast<int64_t>(static_cast<int32_t>(startPc + 8)));
	}

	// --- JR / JALR ---
	{
		std::vector<uint32_t> ops { LUI(8, 0x8000), ORI(8, 8, 0x1234), JR(8), ADDIU(12, 0, 33) };
		TestState s = RunBlock(backend, ops, 0x6000, zero);
		Check("JR delay slot runs", s.regs[12] == 33);
		Check("JR PC == rs (low 32 bits)", s.pc == 0x80001234);
	}
	{
		const uint32_t startPc = 0x80000400;
		std::vector<uint32_t> ops { LUI(8, 0x8000), ORI(8, 8, 0x2000), JALR(9, 8), NOP() };
		TestState s = RunBlock(backend, ops, startPc, zero);
		uint32_t jalrPc = startPc + 2 * 4;
		Check("JALR PC == rs", s.pc == 0x80002000);
		CheckEq64("JALR link sign-extended", s.regs[9],
			  static_cast<int64_t>(static_cast<int32_t>(jalrPc + 8)));
	}

	// --- BLTZAL at a KSEG0 address: unconditional link + conditional branch ---
	{
		const uint32_t startPc = 0x80000400;
		std::vector<uint32_t> ops { ADDIU(8, 0, -5), BLTZAL(8, 2), NOP() };
		TestState s = RunBlock(backend, ops, startPc, zero);
		uint32_t branchPc = startPc + 1 * 4;
		uint32_t target = branchPc + 4 + (2 << 2);
		Check("BLTZAL taken (negative rs)", s.pc == target);
		CheckEq64("BLTZAL link sign-extended (KSEG0)", s.regs[31],
			  static_cast<int64_t>(static_cast<int32_t>(branchPc + 8)));
	}

	// --- ANDI/ORI/XORI (immediate zero-extended to 64 bits per MIPS III, so
	// ANDI always forces the result's hi word to 0 while ORI/XORI leave it
	// as rs's unchanged hi word) and SLTI/SLTIU (immediate sign-extended,
	// full 64-bit signed/unsigned compare) ---
	{
		TestState init = zero;
		init.regs[8] = static_cast<int64_t>(0xFFFFFFFF00000001ULL); // hi=-1, lo=1
		std::vector<uint32_t> ops {
			ANDI(9, 8, 0x000F),   // lo: 1 & 0xF = 1, hi forced to 0
			ORI(10, 8, 0x00F0),   // lo: 1 | 0xF0 = 0xF1, hi unchanged (0xFFFFFFFF)
			XORI(11, 8, 0x00FF),  // lo: 1 ^ 0xFF = 0xFE, hi unchanged
			ADDIU(12, 0, -5),
			SLTI(13, 12, -1),     // -5 < -1 (signed) -> 1
			SLTI(14, 12, -10),    // -5 < -10 (signed) -> 0
			SLTIU(15, 12, -1),    // 0xFFFF...FB < 0xFFFF...FF (unsigned) -> 1
		};
		TestState s = RunBlock(backend, ops, 0x8000, init);
		CheckEq64("ANDI zero-extends immediate, forces hi=0", s.regs[9], 1);
		CheckEq64("ORI preserves hi word", s.regs[10],
			  static_cast<int64_t>(0xFFFFFFFF000000F1ULL));
		CheckEq64("XORI preserves hi word", s.regs[11],
			  static_cast<int64_t>(0xFFFFFFFF000000FEULL));
		CheckEq64("SLTI true", s.regs[13], 1);
		CheckEq64("SLTI false", s.regs[14], 0);
		CheckEq64("SLTIU true (sign-extended imm compared unsigned)", s.regs[15], 1);
	}

	// --- DSLLV/DSRLV/DSRAV: variable 64-bit shifts, amount taken from a
	// register (masked to 6 bits) - same source pattern and expected values
	// as the static DSLL/DSRL/DSRA case above, exercising the *V encoding. ---
	{
		TestState init = zero;
		init.regs[8] = static_cast<int64_t>(0x0123456789ABCDEFULL);
		std::vector<uint32_t> ops {
			ADDIU(9, 0, 4), // shift amount register
			DSLLV(10, 8, 9),
			DSRLV(11, 8, 9),
			DSRAV(12, 8, 9),
		};
		TestState s = RunBlock(backend, ops, 0x9000, init);
		CheckEq64("DSLLV", s.regs[10], static_cast<int64_t>(0x123456789ABCDEF0ULL));
		CheckEq64("DSRLV", s.regs[11], static_cast<int64_t>(0x00123456789ABCDEULL));
		CheckEq64("DSRAV", s.regs[12], static_cast<int64_t>(0x00123456789ABCDEULL));
	}

	// --- BEQL/BLEZL/BGTZL taken: delay slot runs ---
	{
		std::vector<uint32_t> ops { ADDIU(8, 0, 5), ADDIU(9, 0, 5), BEQL(8, 9, 2), ADDIU(10, 0, 77) };
		TestState s = RunBlock(backend, ops, 0xA000, zero);
		uint32_t branchPc = 0xA000 + 2 * 4;
		uint32_t target = branchPc + 4 + (2 << 2);
		CheckEq64("BEQL taken delay slot runs", s.regs[10], 77);
		Check("BEQL taken PC == target", s.pc == target);
	}
	{
		std::vector<uint32_t> ops { ADDIU(8, 0, 0), BLEZL(8, 2), ADDIU(10, 0, 88) };
		TestState s = RunBlock(backend, ops, 0xA100, zero);
		uint32_t branchPc = 0xA100 + 1 * 4;
		uint32_t target = branchPc + 4 + (2 << 2);
		CheckEq64("BLEZL taken (zero) delay slot runs", s.regs[10], 88);
		Check("BLEZL taken PC == target", s.pc == target);
	}
	{
		std::vector<uint32_t> ops { ADDIU(8, 0, 1), BGTZL(8, 2), ADDIU(10, 0, 99) };
		TestState s = RunBlock(backend, ops, 0xA200, zero);
		uint32_t branchPc = 0xA200 + 1 * 4;
		uint32_t target = branchPc + 4 + (2 << 2);
		CheckEq64("BGTZL taken delay slot runs", s.regs[10], 99);
		Check("BGTZL taken PC == target", s.pc == target);
	}

	// --- BLTZL not taken: delay slot must be ANNULLED ---
	{
		std::vector<uint32_t> ops { ADDIU(8, 0, 1), BLTZL(8, 2), ADDIU(10, 0, 111) };
		TestState s = RunBlock(backend, ops, 0xA300, zero);
		uint32_t branchPc = 0xA300 + 1 * 4;
		uint32_t link = branchPc + 8;
		CheckEq64("BLTZL not-taken delay slot ANNULLED", s.regs[10], 0);
		Check("BLTZL not-taken PC == fallthrough", s.pc == link);
	}
	// --- BGEZL taken (zero counts as >= 0) ---
	{
		std::vector<uint32_t> ops { ADDIU(8, 0, 0), BGEZL(8, 2), ADDIU(10, 0, 111) };
		TestState s = RunBlock(backend, ops, 0xA400, zero);
		uint32_t branchPc = 0xA400 + 1 * 4;
		uint32_t target = branchPc + 4 + (2 << 2);
		CheckEq64("BGEZL taken delay slot runs", s.regs[10], 111);
		Check("BGEZL taken PC == target", s.pc == target);
	}

	// --- BLTZALL: link is written UNCONDITIONALLY, before the branch
	// condition is evaluated, even though the delay slot itself is annulled
	// when the branch isn't taken - the real VR4300 always executes an *AL
	// branch's link write as part of the instruction, independent of the
	// branch outcome. Both taken and not-taken are checked. ---
	{
		const uint32_t startPc = 0x80000600;
		std::vector<uint32_t> ops { ADDIU(8, 0, -1), BLTZALL(8, 2), ADDIU(10, 0, 123) };
		TestState s = RunBlock(backend, ops, startPc, zero);
		uint32_t branchPc = startPc + 1 * 4;
		uint32_t target = branchPc + 4 + (2 << 2);
		CheckEq64("BLTZALL taken delay slot runs", s.regs[10], 123);
		Check("BLTZALL taken PC == target", s.pc == target);
		CheckEq64("BLTZALL link sign-extended (KSEG0)", s.regs[31],
			  static_cast<int64_t>(static_cast<int32_t>(branchPc + 8)));
	}
	{
		const uint32_t startPc = 0x80000700;
		std::vector<uint32_t> ops { ADDIU(8, 0, 1), BLTZALL(8, 2), ADDIU(10, 0, 123) };
		TestState s = RunBlock(backend, ops, startPc, zero);
		uint32_t branchPc = startPc + 1 * 4;
		uint32_t link = branchPc + 8;
		CheckEq64("BLTZALL not-taken delay slot ANNULLED", s.regs[10], 0);
		Check("BLTZALL not-taken PC == fallthrough", s.pc == link);
		CheckEq64("BLTZALL link still written when not taken", s.regs[31],
			  static_cast<int64_t>(static_cast<int32_t>(branchPc + 8)));
	}

	// --- BGEZALL taken (spot check; same isAl+likely lowering as BLTZALL) ---
	{
		const uint32_t startPc = 0x80000800;
		std::vector<uint32_t> ops { ADDIU(8, 0, 0), BGEZALL(8, 2), ADDIU(10, 0, 5) };
		TestState s = RunBlock(backend, ops, startPc, zero);
		uint32_t branchPc = startPc + 1 * 4;
		uint32_t target = branchPc + 4 + (2 << 2);
		CheckEq64("BGEZALL taken delay slot runs", s.regs[10], 5);
		Check("BGEZALL taken PC == target", s.pc == target);
		CheckEq64("BGEZALL link sign-extended (KSEG0)", s.regs[31],
			  static_cast<int64_t>(static_cast<int32_t>(branchPc + 8)));
	}

	// --- BGEZAL (non-likely AL form) taken, as a sanity check alongside the
	// already-tested BLTZAL above ---
	{
		const uint32_t startPc = 0x80000900;
		std::vector<uint32_t> ops { ADDIU(8, 0, 0), BGEZAL(8, 2), ADDIU(10, 0, 9) };
		TestState s = RunBlock(backend, ops, startPc, zero);
		uint32_t branchPc = startPc + 1 * 4;
		uint32_t target = branchPc + 4 + (2 << 2);
		Check("BGEZAL taken (zero counts as >=0)", s.pc == target);
		Check("BGEZAL delay slot runs", s.regs[10] == 9);
		CheckEq64("BGEZAL link sign-extended (KSEG0)", s.regs[31],
			  static_cast<int64_t>(static_cast<int32_t>(branchPc + 8)));
	}

	// --- Unsupported opcode (MULT) falls back cleanly with an interpreter callback ---
	{
		vr4300_play_backend *fallbackBackend = vr4300_play_backend_create(
			&layout, [](void*, void*, uint32_t pc) -> uint32_t { return pc + 4; }, nullptr);
		std::vector<uint32_t> ops { RType(8, 9, 0, 0, 0x18) /* MULT */, NOP() };
		char error[256];
		vr4300_play_block *block = vr4300_play_block_create(
			fallbackBackend, ops.data(), ops.size(), 0x7000, 1, error, sizeof(error));
		Check("unsupported op still creates a block", block != nullptr);
		if(block)
		{
			Check("unsupported op falls back to interpreter mode",
			      vr4300_play_block_get_mode(block) == VR4300_PLAY_BLOCK_INTERPRETER);
			vr4300_play_block_destroy(block);
		}
		vr4300_play_backend_destroy(fallbackBackend);
	}

	vr4300_play_backend_destroy(backend);

	std::printf("\n%d/%d checks passed\n", g_checks - g_failures, g_checks);
	return g_failures == 0 ? 0 : 1;
}
