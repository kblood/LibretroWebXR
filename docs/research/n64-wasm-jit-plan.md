# Nintendo 64 on the web — Wasm-JIT feasibility re-check and implementation plan

Status: research + plan only, written 2026-07-21. No N64 code exists in this
repo yet. This doc re-verifies (and partly overturns) the N64 conclusions of
[[psx-n64-feasibility.md]] in light of the PSX Wasm-JIT integration that
shipped on the `psx-jit-integration` branch (see `docs/PSX_CORE_BUILD.md` and
[kblood/psx-wasm-jit-libretro](https://github.com/kblood/psx-wasm-jit-libretro)),
and lays out a concrete, phase-gated plan for adding N64 — in the same spirit
as the PSX pair (`PSX_IMPLEMENTATION_PLAN.md` / `PSX_WASM_JIT_DESIGN.md` in
the archived `ClaudeTest` checkout). Every load-bearing claim below was
re-checked against source or primary references in a 2026-07-21 research
pass; URLs are in section 12.

## 1. Executive summary

**Recommended path: yes, N64 is now a plannable project — but a longer and
riskier one than PSX was, and it must be entered through two cheap,
decision-forcing spikes before any large commitment.**

The four findings that change the picture from the old "skip, no known path"
verdict:

1. **N64 does not need "three JITs." It needs exactly one.** The RSP
   (vector coprocessor) is handled in every mainstream N64 emulator by HLE —
   `mupen64plus-rsp-hle` is pure C with zero code generation (audio/MusyX/
   MP3/JPEG ucodes), and the graphics ucodes (F3D/F3DEX/F3DEX2/S2DEX, and
   since 2018–2019 even the famously custom Factor 5 and BOSS ucodes) are
   HLE'd inside the video plugin (GLideN64). The RDP, in HLE-graphics mode,
   is never emulated at the rasterizer level at all. Only the **VR4300 main
   CPU** needs a dynarec. This collapses the problem to the same *shape* as
   PSX: one guest-MIPS JIT plus a GLES renderer.
2. **The prior claim that `new_dynarec` has "no IR boundary" was half
   wrong.** It does have a real frontend/backend split: ~400 KB of shared,
   target-independent analysis (decode, liveness, register allocation,
   dirty-tracking — passes 1–7) versus ~125–142 KB per-target `assem_*.c`
   emitters selected by `#include` (x86/x64/arm/arm64; no RISC-V port
   exists). The arm64 backend proves "one new target = one emitter file +
   linkage stubs." **But** the parts that don't fit Wasm live in the
   *shared* code: the dynamic linker patches emitted branch instructions in
   place (impossible — Wasm modules are immutable), and register
   allocations persist in host registers across block boundaries (Wasm
   locals are per-function). So it is neither "clean adapter" (like
   Lightrec) nor "total rewrite" — it is "reuse the analysis frontend,
   redesign the dispatch/link/residency model."
3. **The runtime-Wasm-JIT mechanism this project needs is already proven —
   twice in-house (PS2 `play`, PSX `mednafen_psx_hw`) and independently at
   scale elsewhere** (v86 JITs x86 to Wasm in-browser and boots Windows
   2000; .NET 8's Blazor "Jiterpreter" ships the same technique in
   production). Nobody has published an N64 dynarec that emits Wasm; this
   would be a first, but the mechanism risk (the thing PSX Phase J0
   existed to retire) is already retired for this codebase — the identical
   `JitRuntimeBridge`/worker runtime ships today.
4. **Static recompilation matured dramatically.** N64Recomp now has a
   dozen shipped per-game recompilations (Majora's Mask, Banjo-Kazooie,
   Dr. Mario 64, Bomberman 64, Harvest Moon 64, Snowboard Kids 2, more
   WIP), its runtime declares the renderer a *pluggable interface*, and
   decomp-derived N64 code demonstrably runs at full speed in browsers
   (the sm64 Emscripten ports). The old blocker (RT64 needs GPU features
   WebGPU lacks) still stands, but it blocks *reusing their renderer*,
   not the approach. This is a viable **parallel track** for hand-picked
   games, outside the one-core-per-system architecture.

**Recommendation, in order:**

- **Phase N0 (1–2 weeks): interpreter + renderer baseline.** Build/port
  `mupen64plus_next` (GLideN64, GLES3) — or fall back to `parallel-n64`
  (GLES2 plugins, already proven in-browser by N64Wasm) — through this
  repo's existing worker runtime, boot libdragon homebrew, and measure
  real fps on desktop and Quest. This is the renderer-risk and
  baseline-speed gate. EmulatorJS ships an Emscripten `mupen64plus_next`
  today, so "does it build" is largely de-risked; "does GLideN64 behave on
  WebGL2, and how slow is the interpreter on Quest" are the real questions.
- **Phase NJ1 (3–5 weeks): VR4300→Jitter adapter spike.** Lower hot VR4300
  blocks to Play--CodeGen's `Jitter_CodeGen_Wasm` — the same backend PSX
  and PS2 already use — dispatched through a code LUT with interpreter
  fallback, exactly mirroring the Lightrec adapter's proven shape. The
  frontend is the new work (there is no Lightrec-equivalent for N64); the
  backend and browser mechanism are reused as-is.
- **Then decide.** If NJ1's exit gate passes and N0's Quest interpreter
  baseline suggests a 2–4x JIT uplift reaches playable speed for a
  meaningful library slice, proceed to coverage/hardening (NJ2–NJ4,
  roughly 4–7 further months). If not, N64-as-a-core goes back on the
  shelf **with the static-recomp track (R0/R1) as the surviving option**
  for a small set of specific games.

Honest bottom line: this is a 6–10 month project to a shippable JIT-backed
core, with a real possibility that the Quest performance gate still fails at
the end — the VR4300 is ~3x the clock of PSX's R3000A and the HLE video
plugin adds CPU cost PSX never had. The plan below is structured so that the
kill/continue decision costs weeks, not months.

## 2. Re-verification of the prior feasibility doc, point by point

`docs/research/psx-n64-feasibility.md` (as currently on disk, including its
2026-07-19 update) makes four N64 claims. Checked against source:

| Prior claim | Verdict after this pass |
|---|---|
| `new_dynarec` "emits x86/ARM assembly inline … no separating IR layer for a new backend to plug into" | **Half right.** The `#include`-selected backend structure is real (`new_dynarec.c` includes one of `x86/assem_x86.c`, `x64/assem_x64.c`, `arm/assem_arm.c`, `arm64/assem_arm64.c`, `#error` otherwise). But there *is* a de-facto backend interface: the shared 400 KB engine runs eight documented passes (disassembly → liveness → register allocation → … → assembly), and only pass 8 is per-target, via hundreds of `emit_*` functions plus target-constant headers (`HOST_REGS`, `INVERTED_CARRY`, `DESTRUCTIVE_SHIFT`, …). The genuinely Wasm-hostile parts are the shared dynamic linker (patches emitted branches in place; keeps `jump_in`/`jump_out`/`jump_dirty` lists over a mutable RWX cache) and cross-block host-register residency. See section 4.2. |
| N64 has "THREE distinct execution units that would each need attention" | **Misleading.** True architecturally, false as a work statement. RSP audio ucode HLE is pure C (`mupen64plus-rsp-hle`, no codegen anywhere in its tree); RSP graphics ucode HLE lives in the video plugin, and GLideN64 covers effectively the whole commercial library including the historical LLE-only holdouts (Factor 5's Rogue Squadron / Battle for Naboo / Indiana Jones HLE'd May 2018; BOSS's World Driver Championship / Stunt Racer ZSort ucode HLE'd Feb 2019). The RDP is only emulated at rasterizer level in LLE paths (angrylion: CPU-bound beyond even a desktop i7; ParaLLEl-RDP: Vulkan compute, no WebGPU port exists or is discussed) — which a browser target simply doesn't use. **Only the VR4300 needs a JIT.** |
| N64 in browser today = "a slideshow for most commercial titles" | **Too pessimistic for desktop, unmeasured for Quest.** N64Wasm (Emscripten `parallel-n64`, interpreter CPU, GLES2-era HLE video) reports "a good portion of the 3D games playable and at full speed on a mid-range computer"; mupen64plus-web reports demo ROMs at 60 fps but "most games ~30 FPS." So the desktop interpreter baseline is *borderline*, not hopeless — and the dynarec uplift on top is measured at 2.2–3.8x whole-process (mupen64plus's own 2015 benchmarks, pure-interp vs new_dynarec; the CPU-component-only uplift is higher since those totals include video/RSP time). Quest remains unmeasured — hence Phase N0. |
| Static recomp is "per-game, not a generic core, doesn't fit the architecture" | **Still true as stated, but the ecosystem moved.** A dozen shipped recomps now exist, the runtime renderer is officially pluggable (RT64 recommended, not required), and sm64's Emscripten ports prove decomp-derived N64 code at full speed in-browser. Worth a bounded parallel track (section 4.5), explicitly outside `systems.js`'s one-core-per-system model. |

One more prior-doc question answered: **no RISC-V `new_dynarec` port
exists** (searched mupen64plus-core and pcsx_rearmed; the official doc still
lists x86/x86-64/ARMv5/ARMv7, plus the in-tree x64/arm64 backends
contributed by Gillou68310 around 2019). The per-target cost signal is the
arm64 backend itself: one ~142 KB `assem_arm64.c` + a ~7 KB hand-written
`linkage_arm64.S` + a 1.2 KB constants header.

Also confirmed: pcsx_rearmed's "ari64" dynarec is the *same* new_dynarec
lineage (its `new_dynarec.c` carries the literal "Mupen64plus - Copyright
(C) 2009-2011 Ari64" header) — so in principle a Wasm-capable new_dynarec
would serve both systems, but the two copies have diverged for years
(316 KB heavily notaz-modified PSX copy vs 404 KB N64 copy), and for PSX
this project already has a better answer (Lightrec/Jitter, shipped).

## 3. Why N64 is genuinely harder than PS2/PSX — accurately

Not for the reasons previously assumed. The accurate list:

1. **No Lightrec-equivalent exists.** PSX was tractable because Lightrec
   already provided a complete, IR-based, backend-swappable recompiler
   *frontend* (decoder, optimizer, block cache, invalidation, interpreter
   fallback) — the integration only replaced its emission boundary. For
   N64 there is no such component anywhere in the ecosystem:
   - `new_dynarec` has a frontend/backend split but its shared linker and
     register-residency model assume mutable native code (section 4.2).
   - ares's recompiler sits on **sljit** — a portable low-level JIT LIR
     with x86/ARM/RISC-V/s390x/PPC/LoongArch/MIPS backends but **no Wasm
     backend**; adding one means writing a stackifier + register→locals
     mapping inside sljit, a compiler-backend project bigger than either
     of this project's two adapters (and ares's RDP is Vulkan-only
     parallel-rdp, a second independent wall).
   - CEN64 and gopher64 are deliberately interpreter-only (gopher64's
     author explicitly rejects dynarecs for readability; the repo has
     zero JIT code — and contrary to a stale memory, **no gopher64 web
     build exists**).
   So the JIT *frontend* (block discovery, decode, invalidation, cycle
   accounting) must be assembled for N64 — reusing mupen64plus block
   machinery and/or new_dynarec's analysis passes where they fit — rather
   than adopted whole. That is the single biggest scope difference from
   PSX.
2. **The VR4300 ISA is bigger than the R3000A.** MIPS III: 64-bit GPRs and
   doubleword ops, a real FPU (COP1, 32/64-bit FR modes, FCR31 rounding
   modes — Wasm float ops are round-to-nearest only, so directed rounding
   needs helper calls), and a TLB that some games (notably Goldeneye)
   exercise heavily, so generated loads/stores need a TLB-aware fast path.
   Mitigation: Play!'s Jitter already expresses 64-bit (and 128-bit) MIPS
   semantics — the PS2 EE is an R5900, a MIPS III superset — so the
   *backend* IR is known to be expressive enough. The lowering work is
   still ~1.5–2x the PSX opcode surface.
3. **The video plugin is a porting project of its own.** Beetle PSX's
   renderer came along for free inside the core; N64 HLE video is a large
   separate C++ plugin. The good news: `mupen64plus_next` bundles GLideN64,
   which ships real GLES3 builds on Android (`-DHAVE_OPENGLES3 -DGLES3`,
   and an official `mupen64plus_next_gles3` libretro core-info), and
   EmulatorJS already ships an Emscripten `mupen64plus_next` that requires
   WebGL2 — strong evidence the GLES3→WebGL2 path basically works. The bad
   news: per-device GLES3 fragility is documented even on Android, and
   this project's PS2 work already found two WebGL2 present-path bugs
   (feedback-loop false positives, blit Y-flips) that only surfaced under
   ANGLE. Budget real time here.
4. **The performance target is higher.** ~93 MHz VR4300 vs ~33 MHz R3000A,
   plus HLE video plugin CPU cost, against the same Quest frame budget.
   The measured dynarec uplift (2.2–3.8x whole-process) applied to a
   borderline desktop interpreter baseline lands most titles in "maybe" —
   which is exactly why N0 measures before NJ2 commits.

What is *not* harder than PSX: content handling (single-file ROMs, no
CUE/BIN bundles, no disc control) and firmware (**no BIOS at all** — the
PIF boot is HLE'd by every mainstream core, so the entire
FirmwareStore/BIOS-import UX PSX needed simply doesn't apply).

## 4. Candidate approaches

### 4.1 Interpreter-only `mupen64plus_next` (baseline, not a product)

The core's Makefile has an Emscripten target today (`WITH_DYNAREC :=` empty,
`-DNO_ASM`), falling back to `cached_interp.c`/`pure_interp.c`. EmulatorJS
ships exactly this. The cached interpreter buys only ~1.3–1.5x over pure
interpretation (mupen64plus's own benchmarks), and desktop-browser reports
cluster around "lighter titles full speed, most 3D ~30 fps." On Quest this
will be slower still.

Role in the plan: **Phase N0 vehicle, correctness oracle, and permanent
cold/unsupported-block fallback** — the same role Lightrec's interpreter
plays in the PSX integration. Not a shippable endpoint for most 3D titles,
and it should not be registered in `systems.js` as a user-facing system on
interpreter speed alone (that was the PSX lesson: pcsx_rearmed's
interpreter measured ~20% of full speed and was correctly not shipped).

### 4.2 `new_dynarec` + a new Wasm backend

What the source actually supports: passes 1–7 (decode through dirty-reg
analysis) are target-independent code in `new_dynarec.c`; pass 8 calls
`emit_*` functions from the `#include`d per-target file; target quirks are
parameterized via constants/flags (`HOST_REGS 8` vs 12, `INVERTED_CARRY`,
`DESTRUCTIVE_SHIFT`, …). Writing `wasm/assem_wasm.c` is therefore *shaped*
like a supported operation — but three assumptions break:

- **In-place branch patching.** The shared dynamic linker compiles a stub
  for unresolved branches and later *patches the emitted branch
  instruction* to jump directly to the compiled target. Wasm modules are
  immutable; every cross-block transfer must become an indirect dispatch
  through a code LUT (exactly what the PSX adapter does), which means
  modifying the shared `add_link`/`ll_add`/stub machinery, not just adding
  a backend.
- **Cross-block register residency.** The allocator deliberately keeps
  guest registers live in host registers across block boundaries. Wasm
  locals die at function return, so every block boundary spills to the
  state structure — nullifying much of what passes 3–6 buy and requiring
  allocator changes in shared code.
- **Native-ABI linkage trampolines.** Each target ships hand-written
  assembly (`linkage_*.S`) for entry/exit and helper calls; the Wasm
  equivalent is the already-proven helper-table import pattern, but it's
  new shared-boundary work, not a file drop.

Verdict: viable as a *source of parts* (the MIPS III decoder and liveness
analysis are mature and battle-tested), not as a clean adapter target. Cost
if pursued wholesale: closer to "fork and restructure a 400 KB GPL dynarec"
than "add one emitter file."

### 4.3 ares recompiler via an sljit Wasm backend

Attractive on paper (one new sljit backend would serve ares's CPU *and*
RSP recompilers), but: sljit's model (host registers, arbitrary
labels/jumps, self-modifying code) needs a stackifier and register-mapping
layer to target structured, immutable Wasm — a genuine compiler backend,
larger than either in-house adapter; ares is not a libretro core (whole new
frontend integration for this project); and its RDP is Vulkan-only
parallel-rdp with no browser path. **Rejected** for this project. (Ares's
`recompiler.cpp` design commentary is nonetheless recommended reading for
NJ1.)

### 4.4 VR4300→Jitter direct lowering (recommended JIT path)

Mirror the PSX integration's proven architecture, with the frontend role
recast:

- **Backend: unchanged.** Play--CodeGen `Jitter_CodeGen_Wasm`, one Wasm
  module per compiled block, instantiated in the execution worker's realm
  against shared memory + a private helper table, published via
  `addFunction()`, dispatched as a C function pointer through a code LUT,
  `removeFunction()` on invalidation. Already shipping twice from this
  codebase; `src/runtime/JitRuntimeBridge.js` and the worker runtime need
  zero changes.
- **Frontend: mupen64plus-next's existing block infrastructure + a new
  lowering layer.** The cached interpreter already discovers/caches blocks
  and maintains `invalid_code[]` self-modification tracking; new_dynarec's
  pass-1/2 decode+liveness code is available to borrow where it pays.
  The new component — the actual work of NJ1/NJ2 — walks a decoded VR4300
  basic block and emits Jitter IR ops, with anything unsupported leaving
  the whole block on the interpreter (per-block, not per-instruction,
  fallback — same as PSX).
- **Tiering identical to PSX:** first native tier = integer ALU, shifts,
  branches/jumps with delay slots, 32-bit loads/stores through a fast-path
  RDRAM check; interpreter tier = FPU, TLB-mapped access, COP0, 64-bit
  doubleword ops, MUL/DIV — then expand tier by tier with differential
  testing against the interpreter as the correctness oracle.

Why this over 4.2: it keeps every browser-hostile assumption out of the
design from day one (no patching, LUT dispatch, per-block spill is the
baseline not a regression), reuses the exact code and mental model the team
just shipped for PSX, and the Jitter IR is already proven to express MIPS
III semantics (PS2 EE). The price is hand-building block lowering that
new_dynarec's pass 8 would have given a native target for free — but that
price is paid in the open, in adapter code this project owns, rather than
inside a fork of a patch-hostile 400 KB engine.

### 4.5 Static recompilation (parallel track, per-game)

Facts as of 2026-07: N64Recomp still requires per-game symbol metadata (an
ELF from a disassembly/decomp setup; "arbitrary unannotated ROM" support
remains a stated future goal). Its output is portable C intended for
N64ModernRuntime (`ultramodern` libultra reimplementation + `librecomp`
glue), which needs pthreads (fine — COOP/COEP is already deployed here) and
declares graphics a **pluggable interface**. RT64 (the recommended
renderer) remains browser-impossible (D3D12/Vulkan/Metal only; the
maintainers' own WebGPU assessment — no bindless, no SPIR-V, no push
constants, etc. — closed Zelda64Recomp#221 and hasn't changed). Nobody has
compiled an N64Recomp output to Wasm yet. But sm64's decomp-derived
Emscripten ports run at full speed in desktop browsers, proving the
CPU-side story completely: statically recompiled/decompiled N64 game code
in Wasm is *fast*, because it's just C compiled ahead of time.

Assessment for this project: a credible **tech-demo track for specific
games** (the MIT-licensed recomp outputs — Dr. Mario 64, Banjo-Kazooie,
Bomberman 64, etc. — are the candidates; the user supplies their own ROM
for assets, same legal shape as this project's BIOS handling), living
outside `systems.js` as a special content type rather than a core. The
whole cost is the renderer: a WebGL2 display-list renderer implementing the
runtime's graphics interface subset (the sm64-port `gfx_pc` architecture is
the proven browser-feasible shape). R0 below scopes the cheap proof; R1 the
real cost. This track is also the **hedge**: if NJ1/N0 kills the JIT core,
this is what remains.

### Comparison summary

| Approach | Reuses proven Wasm-JIT mechanism | Frontend work | Renderer path | Fits systems.js | Verdict |
|---|---|---|---|---|---|
| Interpreter-only core | n/a | none | GLideN64-GLES3 or parallel-n64 GLES2 | yes | Baseline + oracle only |
| new_dynarec Wasm backend | partly (emission only) | fork/restructure shared linker + allocator | same | yes | Parts donor, not the plan |
| ares + sljit Wasm backend | no (new sljit backend) | new backend + new frontend integration | Vulkan-only RDP — blocked | no | Rejected |
| **VR4300→Jitter lowering** | **fully** | **new block-lowering layer (the real work)** | same as baseline | **yes** | **Recommended** |
| Static recomp (per-game) | n/a (no runtime codegen at all) | none (AOT) | must write WebGL2 renderer | no (special case) | Parallel track + hedge |

## 5. Technical design (JIT path)

```text
N64 ROM code in emulated RDRAM
        |
        v
mupen64plus-next block discovery (cached-interp infra, invalid_code[] tracking)
        |
        +---------------------------+
        | cold / unsupported block  |--> cached interpreter (correctness oracle)
        |
        v hot block
VR4300 decode (+ borrowed new_dynarec liveness where it pays)
        |
        v
NEW: VR4300-block -> Jitter IR lowering        <- the actual N64-specific work
        |
        v
Play--CodeGen Jitter_CodeGen_Wasm (unchanged)  <- proven: PS2 + PSX
        |
        v
new WebAssembly.Module per block, instantiated in the execution worker realm
(shared memory + private helper table), addFunction(fn,'vi'), code-LUT publish
        |
        v
dispatcher calls table index as void(*)(vr4300_state*)  — no block-to-block patching
```

Key decisions, mirroring proven PSX choices unless N64 forces otherwise:

- **ABI:** uniform `void (*)(state*)` / Emscripten `'vi'`; PC, cycle count,
  pending exceptions in the state struct; every block returns to the
  dispatcher (no direct linking in tier 1 — v86's documented experience
  confirms cross-module linking isn't available anyway).
- **64-bit GPRs:** stored as i64 in the state struct; Jitter's 64-bit ops
  (already exercised by PS2 EE) do the arithmetic. Most games are
  32-bit-clean but correctness requires real 64-bit semantics — this is a
  tier-1 requirement, not an optimization.
- **FPU:** interpreter-tier initially. When lowered natively, FCR31
  rounding modes other than round-to-nearest go through helpers (Wasm has
  no directed-rounding ops); FR-mode (32/64-bit register file view)
  handled in the state layout.
- **TLB:** tier-1 generated loads/stores take a fast path for directly
  mapped KSEG0/KSEG1 and physical RDRAM, and call a helper for TLB-mapped
  addresses; TLB-heavy titles simply spend more time in helpers until a
  measured inline-TLB-lookup tier is justified.
- **Invalidation:** reuse the core's `invalid_code[]` page model; stores
  from generated code that hit code pages clear LUT entries (same shape as
  Lightrec's explicit store invalidation, which the PSX adapter preserved).
  N64's main self-modification pattern is overlay loading via PI DMA (e.g.
  Zelda overlays) — DMA completion invalidates affected pages.
- **RSP:** `mupen64plus-rsp-hle`, compiled as ordinary C. No codegen. LLE
  RSP (cxd4 interpreter) is a distant, likely-never fallback — with
  GLideN64 covering Factor 5/BOSS ucodes in HLE, no known commercial title
  requires it for a beta.
- **Video:** GLideN64 GLES3 profile on WebGL2 (Phase N0 proves it; the
  `HAVE_OPENGLES3=1` RetroArch context lesson from the PS2 recipe applies
  verbatim). Fallback: parallel-n64's GLES2-era plugins (glide64/gln64/
  rice), which N64Wasm proves in-browser, at the cost of Factor 5/BOSS
  titles and modern accuracy. All LLE RDP options are explicitly out of
  scope (angrylion: CPU-hopeless in Wasm; ParaLLEl-RDP: Vulkan).
- **Audio:** rsp-hle audio ucode HLE (reliable across effectively the
  whole library) into the same PCM forwarding the PSX worker already does.
- **Threads/realms:** identical to PSX — compile, instantiate,
  `addFunction`, execute, `removeFunction` all in the execution worker's
  realm; per-realm helper table; `ALLOW_TABLE_GROWTH=1`; CSP
  `'wasm-unsafe-eval'` only.

Licensing: mupen64plus-core/-next and rsp-hle are GPL-2.0+; GLideN64 is
GPL-2.0+ (originally MIT-era gln64 lineage — verify exact notices at build
pin time); Play--CodeGen is permissive BSD-style; combined artifact
distribution follows the same GPL posture as the PSX core repo. Same
"nothing vendored, pins + patches only" standalone-repo pattern as
`psx-wasm-jit-libretro` (a future `n64-wasm-jit-libretro`).

## 6. Phased plan with exit gates

Phase J0 from the PSX plan (generic browser mechanism proof) is **already
satisfied** — the mechanism ships in production for PSX in this repo. N64
starts at its own N0.

### Phase N0 — interpreter + renderer baseline (1–2 weeks)

1. Build `mupen64plus_next` for Emscripten (pinned, reproducible, same
   recipe skeleton as the PSX core repo; EmulatorJS's build is the
   existence proof and a reference). GLES3/WebGL2 GLideN64 first;
   parallel-n64 GLES2 fallback if GLideN64-on-ANGLE misbehaves beyond a
   timeboxed fix.
2. Boot legal homebrew (libdragon-built test ROM — same "author our own
   CC0 content" pattern as every other system here) through the existing
   worker runtime (`execution: 'worker'`, unchanged
   `RuntimeEmulatorClient`/`WorkerEmulatorClient`/`src/runtime/*`).
3. Boot one representative commercial 3D title from local content;
   measure emulated fps on desktop Chrome and on Quest 3.
4. Verify save types (EEPROM/SRAM/FlashRAM via the core's game DB),
   analog input, and audio HLE.

Exit gate: real rendered frames through the real app path on both desktop
and Quest, with recorded fps numbers. **Decision input:** if Quest
interpreter speed is so low that even a 4x JIT uplift cannot plausibly
reach full speed for lighter 3D titles, stop — the JIT track is dead on
this hardware generation and only Track R survives.

### Phase NJ1 — VR4300→Jitter adapter spike (3–5 weeks)

Deliberately bigger than PSX's J1 (1–2 weeks) because the frontend must be
assembled, not adopted:

1. Add the block-lowering layer for the first tier (integer ALU, shifts,
   branches/jumps + delay slots, KSEG-direct 32-bit loads/stores),
   hosted in the core's cached-interp block model, dispatching via LUT.
2. Per-block interpreter fallback for everything else; differential-test
   architectural state (GPRs, hi/lo, PC, COP0 cycle-relevant regs, memory)
   against the interpreter over instruction-suite ROMs (n64-systemtest,
   libdragon test suites) and real game boot sequences.
3. Overlay/DMA invalidation test: load a Zelda-style overlay, verify no
   stale block dispatch.
4. Measure native-vs-interpreter block residency and speedup on the N0
   content set, desktop first, then Quest.

Exit gate (mirrors PSX J1): a representative hot VR4300 block executes
through unmodified `Jitter_CodeGen_Wasm` in the execution worker, publishes
through the LUT, invalidates cleanly, and produces identical architectural
state — plus a measured, positive whole-game speedup trend. If lowering
overhead or dispatch cost eats the gains, evaluate borrowing new_dynarec's
liveness/regalloc passes (section 4.2) before abandoning.

### Phase NJ2 — coverage expansion (8–16 weeks)

FPU tier (with rounding-mode helpers), MUL/DIV/doubleword ops, TLB fast
path, COP0/interrupt/exception handling in generated code, broad
differential testing, compatibility sweep across the microcode spectrum
(F3DEX/F3DEX2/S2DEX 2D titles/Factor 5 title on GLideN64). Same exit gate
shape as PSX J2: no differential mismatch on the CPU suite; representative
games reach the required speed on desktop.

### Phase NJ3 — Quest profiling and cache management (3–5 weeks)

Quest-side compile-stall measurement, hotness threshold tuning, bounded
block-cache eviction (module-count and code-byte ceilings — v86's
documented few-thousand-module practical cap is the reference point),
metrics in the debug HUD. Exit gate: JIT uplift exceeds its costs on Quest
with no progressive memory growth.

### Phase NJ4 — product hardening (4–8 weeks)

Long-session soak, save/state round-trips with `buildHash` compatibility
(reusing `SaveRamStore`/`SaveState` unchanged), controller-pak/rumble
decisions, in-room UX, registration polish, upstreamable patch split.
Exit gate: the PSX-style beta definition of done, on Quest.

### Track R — static recomp tech demo (parallel, independent)

- **R0 (2–3 weeks):** compile one MIT-licensed N64Recomp output (Dr. Mario
  64 is the simplest shipped candidate) with emcc against a stub renderer;
  count frames and verify game logic runs at speed in-browser. This is the
  cheap existence proof nobody has published.
- **R1 (2–4 months, only if R0 passes and the product wants it):** a
  WebGL2 display-list renderer implementing the N64ModernRuntime graphics
  interface subset (sm64-port `gfx_pc` architecture as the model), input/
  audio callbacks into this app, user-supplied-ROM asset extraction, and a
  "recomp cartridge" content type outside the core registry.

Track R does not block, and is not blocked by, any NJ phase.

## 7. File-level change map (this repo)

Reused **unchanged** (explicitly — this is the payoff of the PSX
architecture): `src/RuntimeEmulatorClient.js`, `src/runtime/
WorkerEmulatorClient.js`, `src/runtime/EmulatorWorkerRuntime.js`,
`src/runtime/JitRuntimeBridge.js`, `src/runtime/FrameBridge.js`,
`src/runtime/protocol.js`, `src/SaveRamStore.js`, `src/SaveState.js`
(buildHash mechanism), COOP/COEP/deploy config. The build artifact contract
(`MODULARIZE` ES module + `.wasm` + `.worker.js` + `.build.json` sha256
manifest) is the same worker-mode shape the runtime already expects.

Not needed at all (simpler than PSX): `src/FirmwareStore.js` (no BIOS),
`src/ContentBundle.js` multi-file bundles and `src/DiscControl.js` (single
file ROMs, no discs).

New/edited:

- `src/systems.js` — `CORES.mupen64plus_next`: `exts: ['n64','z64','v64']`
  (all three byte orders; the core normalizes), `style: 'module'`,
  `execution: 'worker'`, `requiresThreads: true`, `contentIo:
  'transfer-memfs'` (ROMs are 4–64 MB, fine), `weight: 3` (heavy tier, cap
  one live instance), `buildHash` from the build manifest. `SYSTEMS.n64`
  with `defaultCore`, aliases, `thumbnailRepo: 'Nintendo_-_Nintendo_64'`,
  `medium: 'cart'`. No extension collisions with existing cores.
- `src/ControllerMaps.js` / `src/GameInputMgr.js` — `n64` profile: this
  project's **first genuinely analog system** (Quest thumbstick → RetroPad
  analog is a natural fit and arguably better than any N64-on-flat-keyboard
  story); C-buttons on the right stick/face buttons per mupen64plus-next's
  standard libretro mapping; Z-trigger on grip.
- `scripts/probe-n64-core.js` — real-browser boot probe mirroring
  `probe-psx-core.js` (boots a libdragon test ROM, asserts non-blank
  frames, native JIT block counters once NJ1 lands, forwarded audio).
- `games/n64-*` — authored CC0 libdragon test content, per the established
  per-system pattern.
- Core artifacts in gitignored `public/cores/`; build tooling in a new
  standalone `n64-wasm-jit-libretro` repo mirroring
  `psx-wasm-jit-libretro` (pins.env, patches, fail-closed build, dist
  manifest), with N0's plain-interpreter build as its first output.

## 8. Verification matrix

- **Content:** .z64/.n64/.v64 byte orders; 4 MB and 64 MB ROMs; libdragon
  homebrew; a game-DB save-type spread (EEPROM 4k/16k, SRAM, FlashRAM).
- **CPU (NJ phases):** n64-systemtest / instruction-suite ROMs, JIT vs
  interpreter differential state; overlay-DMA invalidation; TLB-heavy
  title (Goldeneye) boot.
- **Microcode/video:** F3DEX-era title, F3DEX2 (Zelda), S2DEX 2D title, a
  Factor 5 title (GLideN64 HLE path), FMV/framebuffer-effect title.
- **Audio:** standard alist title, MusyX title.
- **Input:** analog range/deadzone through the Quest mapping; C-button
  ergonomics user check; Controller Pak decision documented.
- **Runtime:** desktop flat Chrome; Quest immersive; enter/exit XR; system
  menu interruption; 30-min and 2-h soaks; block-cache ceiling behavior.
- **Perf recording:** every N0/NJ measurement lands in this doc's future
  update sections with the same rigor as the PSX 11.8 fps spike record.

Commercial titles are user-supplied local content only; the repo ships
nothing but authored homebrew.

## 9. Schedule and critical path

One developer, Quest access, PSX integration as prior art:

- N0 baseline + renderer proof: 1–2 weeks.
- NJ1 adapter spike: 3–5 weeks. **Kill/continue decision lands here, ~4–7
  weeks in, having spent no long-tail effort.**
- NJ2 coverage: 8–16 weeks.
- NJ3 Quest tuning: 3–5 weeks.
- NJ4 hardening: 4–8 weeks.
- **Total to a shippable JIT-backed core: roughly 6–10 months**, vs the
  PSX plan's 4–7 — the delta is the hand-built frontend, the bigger ISA,
  and the video-plugin risk.
- Track R: R0 2–3 weeks anytime; R1 2–4 months if pursued.

Critical path: `N0 renderer+baseline -> NJ1 lowering viability -> FPU/TLB
coverage -> Quest core speed -> block-cache/memory bounds -> soak
stability`. Room/UX work stays off the critical path until those pass —
same discipline as PSX.

## 10. Open questions and biggest risks

1. **Quest interpreter baseline is unmeasured** — the single most
   decision-relevant unknown; N0 exists to close it first. Desktop signals
   (N64Wasm "good portion playable," mupen64plus-web "~30 fps") are
   encouraging-but-unciteable-for-Quest.
2. **GLideN64 on WebGL2/ANGLE** — real GLES3 builds exist and EmulatorJS
   ships an Emscripten build, but this project's own PS2 experience says
   ANGLE present-path bugs are likely; budget for gl2.c-style blit fixes.
   Verify exactly which video plugin EmulatorJS's artifact uses during N0.
3. **Lowering-frontend performance** — if naive per-block lowering
   (without new_dynarec's liveness/regalloc) leaves too much on the table,
   NJ1 must prove the borrow path works before NJ2 scales it.
4. **FPU semantics in Wasm** — directed rounding via helpers may be hot in
   FPU-heavy titles; measure before promising those.
5. **JIT-generated-module ceilings on Quest Browser** — v86 documents
   per-module memory overhead capping practical module counts at a few
   thousand; N64 working sets must fit under a measured Quest ceiling.
6. **Whether the market of one (this project) wants N64 more than the
   next-cheapest system** — this plan deliberately front-loads the
   cheapest kill signals so that question can be answered for weeks, not
   months, of cost.
7. **Track R legal posture** — recomp binaries embed translated game code
   (community-normal, ROM-required for assets, but grayer than emulation);
   ship only the MIT-licensed community recomps, user-supplied ROM for
   assets, same posture as BIOS handling.

## 11. Relationship to prior docs

This doc supersedes the N64 half of [[psx-n64-feasibility.md]]'s verdict
the same way `docs/PSX_CORE_BUILD.md` superseded its PSX half: the "no
known path" conclusion was correct *for the ecosystem as surveyed* but did
not account for (a) HLE collapsing the RSP/RDP problem, (b) the in-house
Jitter mechanism being guest-ISA-portable, and (c) the recomp ecosystem's
2025–2026 maturation. That doc has deliberately not been edited (it has
concurrent uncommitted edits from another session); reconcile there
separately.

## 12. References (verified 2026-07-21)

CPU dynarec architecture:

- https://github.com/mupen64plus/mupen64plus-core/tree/master/src/device/r4300/new_dynarec — backend layout (x86/x64/arm/arm64)
- https://raw.githubusercontent.com/mupen64plus/mupen64plus-core/master/src/device/r4300/new_dynarec/new_dynarec.c — `#include`-selected backends, shared passes
- https://github.com/mupen64plus/mupen64plus-core/blob/master/doc/new_dynarec.mediawiki — official 8-pass design doc ("Most of the code is shared between the architectures")
- https://pandorawiki.org/Mupen64plus_dynamic_recompiler — linker/patching model description
- https://github.com/mupen64plus/mupen64plus-core/issues/504 — arm64 backend history (Gillou68310)
- https://raw.githubusercontent.com/libretro/mupen64plus-libretro-nx/develop/Makefile — emscripten target, `WITH_DYNAREC :=` empty
- https://raw.githubusercontent.com/libretro/pcsx_rearmed/master/libpcsxcore/new_dynarec/new_dynarec.c — shared Ari64 lineage with PSX
- https://groups.google.com/g/mupen64plus/c/4rOO7cX0toY/m/CE5ilI5hYMUJ — Goedeken 2015 interpreter/dynarec benchmarks (2.2–3.8x)

RSP/RDP/video:

- https://github.com/mupen64plus/mupen64plus-rsp-hle + /tree/master/src + /blob/master/src/hle.c — pure-C RSP HLE, graphics ucode forwarded to video plugin
- http://gliden64.blogspot.com/2018/05/hle-implementation-of-microcodes-for.html — Factor 5 ucode HLE
- http://gliden64.blogspot.com/2019/02/hle-implementation-of-boss-zsort.html — BOSS ZSort ucode HLE
- https://github.com/gonetz/GLideN64/wiki/The-masterpiece-graphic-microcode-behind--the-Nintendo-64-version-of--Indiana-Jones-and-the-Infernal-Machine-and-Star-Wars-Episode-I:-Battle-for-Naboo
- https://github.com/libretro/libretro-core-info/blob/master/mupen64plus_next_gles3_libretro.info — shipping GLES3 profile
- https://github.com/libretro/mupen64plus-libretro-nx/pull/82 — `-DHAVE_OPENGLES3 -DGLES3` build
- https://github.com/libretro/mupen64plus-libretro-nx/issues/364 — GLES3 per-device fragility example
- https://github.com/libretro/parallel-rsp — RSP JIT (GNU Lightning / LLVM backends; no Wasm)
- https://www.libretro.com/index.php/parallel-rdp-and-rsp-updates-september-2016/ and https://www.libretro.com/index.php/parallel-n64-with-parallel-rsp-dynarec-release-fast-and-accurate-n64-emulation/ — parallel-rsp design history
- https://github.com/ata4/angrylion-rdp-plus and https://www.libretro.com/index.php/parallel-rdp-rewritten-from-scratch-available-in-parallel-n64-right-now-for-retroarch/ — angrylion CPU cost ("not full speed even on a Core i7-8700K")
- https://github.com/Themaister/parallel-rdp — Vulkan requirement
- https://emulation.gametechwiki.com/index.php/Recommended_N64_plugins

Browser N64 prior art:

- https://github.com/nbarkhina/N64Wasm — Emscripten parallel-n64, interpreter CPU, desktop performance claims
- https://github.com/johnoneil/mupen64plus-web — "most games ~30 FPS"
- https://github.com/schibo/1964js, https://github.com/hulkholden/n64js — JS-era experiments
- https://emulatorjs.org/docs/systems/nintendo-64/ — mupen64plus_next on web, WebGL2 requirement; https://github.com/linuxserver/emulatorjs/issues/151

Alternative emulators:

- https://github.com/ares-emulator/ares/tree/master/ares/n64/cpu + https://github.com/ares-emulator/ares/blob/master/nall/nall/recompiler/generic/generic.hpp — recompiler over sljit
- https://github.com/zherczeg/sljit — backend list (no Wasm)
- https://github.com/n64dev/cen64, https://emulation.gametechwiki.com/index.php/CEN64 — interpreter-only, Ryzen-class CPU need
- https://github.com/gopher64/gopher64, https://emulation.gametechwiki.com/index.php/Gopher64 — deliberately interpreter-only; no web build exists
- https://github.com/simple64/simple64/wiki/simple64-FAQ/

Runtime-Wasm-JIT prior art:

- https://github.com/copy/v86 + https://github.com/copy/v86/blob/master/docs/how-it-works.md — x86→Wasm in-browser JIT, module-count/patching lessons
- https://github.com/dotnet/runtime/blob/main/src/mono/wasm/features.md — .NET 8 Jiterpreter
- https://humphri.es/blog/WATaBoy/ — GB SM83→Wasm runtime JIT, addFunction-style publication
- https://github.com/bwasti/wasmblr — single-header runtime Wasm assembler
- https://github.com/bytecodealliance/wasmtime/blob/main/cranelift/README.md — Cranelift consumes, does not emit, Wasm
- https://github.com/AssemblyScript/binaryen.js/ and https://web.dev/articles/binaryen — Binaryen as an in-browser emit layer

Static recompilation:

- https://github.com/N64Recomp/N64Recomp — README: ELF/symbol requirement, RSP recomp support
- https://github.com/N64Recomp/N64ModernRuntime — ultramodern/librecomp, pluggable graphics interface
- https://github.com/Zelda64Recomp/Zelda64Recomp + /issues/221 — web build closed over RT64/WebGPU
- https://github.com/rt64/rt64 + https://github.com/rt64/rt64/issues/6#issuecomment-2111301292 — WebGPU feature-gap enumeration
- https://readonlymemo.com/decompilation-projects-and-n64-recompiled-list/ — shipped recomp/port catalog (July 2026)
- https://decomp.dev/projects and https://github.com/n64decomp — decomp completeness tracking
- https://github.com/ArkShocer/sm64, https://github.com/lwllac/sm64, https://net64-mod.github.io/blog/sm64js/ — sm64 in-browser full-speed proofs
- https://github.com/gcsmith/Superman64Recomp — additional recomp example
- https://github.com/HarbourMasters/Shipwright — no web build exists

In-house precedent:

- `C:\LLM\LibretroWebXR\docs\PS2_CORE_BUILD.md` — Play! Jitter Wasm JIT precedent, WebGL2/ANGLE present-path lessons
- `C:\LLM\LibretroWebXR\docs\PSX_CORE_BUILD.md` + https://github.com/kblood/psx-wasm-jit-libretro — Lightrec/Jitter adapter, worker runtime contract
- `C:\LLM\LibretroWebXR\src\runtime\JitRuntimeBridge.js`, `src\RuntimeEmulatorClient.js`, `src\systems.js` — reusable integration surface
- `C:\LLM\Projects\ClaudeTest\LibretroWebXR\PSX_IMPLEMENTATION_PLAN.md` / `PSX_WASM_JIT_DESIGN.md` — structural/rigor reference (archived checkout)
