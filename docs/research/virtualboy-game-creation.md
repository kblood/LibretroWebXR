# Creating New Nintendo Virtual Boy Games for LibretroWebXR

Research date: 2026-06-01. Target core: **mednafen_vb** (extensions `.vb`, `.vboy`).
Goal: author a small CC0/MIT stereoscopic Virtual Boy game shippable as test content.

> **Licensing principle honored throughout:** the toolchains (GCC, binutils, newlib) are
> GPL, but compiler license does **not** taint compiled output. What *can* end up linked
> into our ROM is the runtime/engine code (libgccvb / VUEngine-Core). Both are permissive
> (see below), so a ROM we author can ship as CC0 or MIT cleanly.

---

## TL;DR Verdict

Authoring a small Virtual Boy game is **feasible and the recommended path** — but use
**VUEngine** (modern, MIT, `make`-based, well-documented), *not* raw gccVB hello-world hacking.
A bare gccVB "hello world with depth" is also viable and is the smallest dependency footprint.

- **Best pipeline:** VUEngine Studio (bundles toolchain) → clone `VUEngine-Barebone` (MIT) →
  edit C/asset code → `make` → `build/output.vb` → runs in mednafen_vb. Fully scriptable on
  Windows because the build chain is plain `make` + shell, with the GUI as optional sugar.
- **Smallest pipeline:** jbrandwood `v810-gcc` (GCC 4.9.4) + `libgccvb` headers →
  `v810-gcc … -Tvb.ld` → `v810-objcopy -O binary main.elf game.vb` → pad to 1 MB.
- **AI-assist verdict:** Claude can *reliably* produce build scaffolding, makefiles, asset
  pipelines and ordinary C game logic. The genuinely HARD part is the VIP (Visual Image
  Processor) — BGMaps, WORLDs, OBJ/affine tables, char memory layout, stereo parallax via
  left/right WORLD offsets. Expect iteration. A stereoscopic "hello world with depth" is the
  realistic first deliverable; a polished game is many iterations away.
- **Fallback (if authoring stalls):** ship a confirmed-free homebrew. BLOX is the famous one
  but its license is **not** clearly CC0 — treat as "freely distributed," not PD. Prefer a
  homebrew whose author explicitly grants CC0/MIT, or author our own tiny demo (preferred).

---

## Goal 1 — Toolchains (gccVB / NEC V810 GCC)

### jbrandwood/v810-gcc (the maintained modern toolchain)
- Repo: https://github.com/jbrandwood/v810-gcc
- Builds a GCC4 cross toolchain for the NEC **V810** CPU (used by Virtual Boy and PC-FX).
- Versions: **binutils 2.27, gcc 4.9.4, newlib 2.2.0-1**.
- **License:** repo itself ships build scripts/patches with **no SPDX LICENSE file** (GitHub
  API returns 404 for license). The produced compiler is GPL (GCC/binutils) + newlib's BSD-ish
  license. None of this taints our ROM unless we statically link GPL code — newlib is not GPL.
- **Windows build (MSYS2):**
  ```sh
  pacman -Sy
  pacman -S --needed git base-devel autoconf gperf
  pacman -S mingw-w64-x86_64-gcc      # or mingw-w64-ucrt-x86_64-gcc
  cd /path/to/v810-gcc/
  ./build_compiler.sh                 # runs step0..step8 in order
  ./build_compiler.sh clean           # removes ./build/ afterwards
  ```
  Output compiler lands in `./v810-gcc/`. (Build steps are `step0_download_prereqs.sh` …
  `step8_make_final_gcc.sh`; `build_compiler.sh` orchestrates them.)
- Linux equivalent: `apt install build-essential curl flex git gperf bison texinfo` then
  `./build_compiler.sh`.

### Classic gccVB (SourceForge / PlanetVB)
- https://gccvb.sourceforge.net/ — older GNU C/C++ + assembler for the V810, plus a small
  helper library (`libgccvb`). Older guides use **Cygwin** + `make_v810.sh`, installing into
  `/usr/local/v810`. The jbrandwood repo supersedes this for fresh installs.
- Getting-started / guide threads:
  - https://www.virtual-boy.com/forums/t/guide-to-compile-and-use-the-new-gccvb/
  - https://www.virtual-boy.com/forums/t/gccvb-getting-started/
  - https://www.virtual-boy.com/tools/gccvb/

### How a `.vb` is produced (bare gccVB pipeline)
Minimal Makefile pattern from the PlanetVB guide:
```make
GCC      = v810-gcc
OBJCOPY  = v810-objcopy
LDPARAM  = -Tlib/vb.ld -L/usr/local/v810/lib/
OBJECTS  = main.o

game.vb: main.elf
	$(OBJCOPY) -O binary main.elf game.vb
	./padder game.vb 1048576       # pad to exactly 1 MB (0x100000)

main.elf: $(OBJECTS)
	$(GCC) -o main.elf $(OBJECTS) $(LDPARAM)
```
Key pieces: a **crt0.s** startup stub (`v810-as -o crt0.o crt0.s`), the **`vb.ld`** linker
script defining VB memory map, the **`libgccvb.h`** runtime headers, and a **padder** to fill
the ROM to a power-of-two size (1 MB typical) so mednafen_vb accepts it.

Minimal "turn the display on" program (from the getting-started guide):
```c
#include <libgccvb.h>
int main() {
    WA[31].head = WRLD_ON | WRLD_OBJ;   // WORLD 31 visible, OBJ mode
    WA[30].head = WRLD_END;             // terminate WORLD list
    VIP_REGS[SPT3] = 8;
    vbDisplayOn();
    vbDisplayShow();
    while (1) { vbWaitFrame(1); }
}
```

### Can Claude write V810 C/asm? (honest)
- **Ordinary C game logic, makefiles, asset converters, build scripts:** yes, reliably.
- **VIP/VSU hardware programming** (BGMap/WORLD/OBJ tables, char RAM layout, column-table,
  affine/HBias modes, the dual-buffer 50 Hz display, audio via VSU): this is the obscure part.
  Claude knows the broad strokes but register-level details are sparse in training data — expect
  to feed it the VB hardware docs (Sacred Tech Scroll / PlanetVB VIP docs) and iterate against
  the emulator. **V810 inline assembly** is rarely needed; stick to C.

---

## Goal 2 — VUEngine (modern C engine/SDK)

This is the strong recommendation for authoring.

- **VUEngine-Core** (the engine): https://github.com/VUEngine/VUEngine-Core — **MIT licensed**
  (confirmed via GitHub API: SPDX `MIT`). Object-oriented engine written in "Virtual C", a C
  dialect transpiled to plain C + macros by a bundled shell/awk preprocessor.
- **VUEngine Studio** (IDE): https://github.com/VUEngine/VUEngine-Studio,
  https://www.vuengine.dev/ — Eclipse-Theia-based IDE that **bundles the entire toolchain**
  (GCC, GNU Make, clang-format, doxygen, emulator). The IDE is EPL-2.0/GPL-2.0-w-Classpath, but
  **that is the IDE's license, not your game's** — games you build are yours.
- **VUEngine-Barebone** (project template): https://github.com/VUEngine/VUEngine-Barebone —
  **MIT** (confirmed). This is the canonical starting point for a new game. Contains
  `config.make`, `source/`, `assets/`, `headers/`, `lib/`, `barebone.workspace`.
- Sample games to learn from: **VUEngine-Platformer-Demo** (MIT), Showcase, etc.

### Scriptability / headless (the key feasibility question)
The official docs emphasize the GUI (Build = `Shift+Alt+B`, Run on Emulator = `Shift+Alt+R`,
Export ROM button; output written to `build/{mode}/output-{mode}.vb` and copied to
`build/output.vb`). **However, the build is plain `make` under the hood.** Confirmed: the
shared build chain lives in `VUEngine-Core/lib/compiler/make/` (`makefile`, `makefile-common`,
`makefile-compile`, `makefile-game`, `makefile-preprocess`, `makefile-compiler`) plus a shell/awk
preprocessor in `lib/compiler/preprocessor/` (`processSourceFile.sh`, `setupClasses.sh`,
`*.awk`, etc.).

**Implication for an AI agent on Windows:** install VUEngine Studio once (to obtain the bundled
v810 GCC + make + the engine), then drive `make` directly from MSYS2 / Git-bash with the right
env vars/paths — no GUI clicks required. The GUI is sugar over `make`. This satisfies the
"scriptable/headless" requirement.

### Windows prerequisites
- Node.js ≥ 22 (via `nvm-windows`) — only needed if building/running the *IDE itself*.
- Visual Studio Build Tools + Python — for the IDE/native deps.
- For *just building a game* you mainly need the bundled toolchain + a bash/make environment
  (MSYS2 or the Git-bash that ships with Studio).

### AI-friendliness
High, relatively. C codebase, MIT, real sample games to imitate, declarative asset/entity
specs, a documented build. The Virtual-C transpiler adds a learning step but is consistent and
scriptable. This is the most AI-tractable VB path that exists today.

---

## Goal 3 — AI-assisted creation: honest feasibility

- **No well-known precedent** of a fully AI-authored Virtual Boy game was found. VB homebrew is
  a tiny scene; expect to be largely on your own.
- **What works:** Claude can scaffold a VUEngine-Barebone fork, write game logic in C, generate
  the makefile/asset glue, write a Python/Node asset converter (PNG → VB char/BGMap tiles), and
  iterate on emulator feedback.
- **Failure modes / where it gets HARD:**
  1. **Stereoscopy** — depth = giving the left and right eye WORLDs different horizontal
     parallax offsets (`GX`/`MX` deltas per WORLD). Getting comfortable, non-eye-straining depth
     is fiddly and must be tested in a real stereo viewer / mednafen's anaglyph or side-by-side
     mode (and ideally LibretroWebXR's own stereo path).
  2. **VIP memory layout** — char RAM segments (CharSeg0..3), BGMap memory, OAM/WORLD tables,
     param tables for affine/HBias; easy to corrupt and get a black or garbled screen.
  3. **Tooling friction on Windows** — bash/awk preprocessor + make + cross-GCC must all be on
     PATH; path quoting and line-ending (CRLF) issues bite.
  4. **ROM acceptance** — mednafen_vb expects a correctly sized/padded ROM; wrong size or
     missing header region → load failure.
- **Most reliable minimal path:** fork VUEngine-Barebone, change only a few entities/assets,
  build with `make`, confirm `build/output.vb` loads in mednafen_vb, *then* add stereo depth.
  Treat "blank screen that boots" → "static stereo image with depth" → "one interaction" as
  three separate, individually-verifiable milestones.

---

## Goal 4 — Concrete recommendation

**Ship a tiny CC0 stereoscopic demo we author ourselves.** Realistic scope: a single static
scene (e.g. a logo or grid of cubes) where foreground elements have visible depth via
left/right parallax, plus a D-pad control that nudges parallax/“pushes” an object in/out — a
genuine "Hello, depth" that is *thematically perfect* for a WebXR frontend and trivially CC0.

### Recommended toolchain
**VUEngine** (MIT engine + MIT Barebone template), driven via `make`.

### Exact build pipeline (Windows, scriptable)
1. Install **VUEngine Studio** once to obtain the bundled toolchain + emulator:
   https://www.vuengine.dev/ (or build from https://github.com/VUEngine/VUEngine-Studio).
2. Clone the template:
   ```sh
   git clone https://github.com/VUEngine/VUEngine-Barebone myvbgame
   git clone https://github.com/VUEngine/VUEngine-Core    # engine dependency
   ```
3. Author game code in `myvbgame/source/` and assets in `myvbgame/assets/`; relicense the
   project header as CC0/MIT (it starts MIT — keep VUEngine's MIT notice for the engine).
4. Build headlessly from MSYS2/Git-bash by invoking the engine's make chain (the same one the
   IDE calls): point it at `VUEngine-Core/lib/compiler/make/makefile` with the project's
   `config.make`. Output: `build/output.vb` (also `build/{mode}/output-{mode}.vb`).
5. Verify: load `build/output.vb` in **mednafen_vb** (and in LibretroWebXR's stereo path).

### Alternative minimal toolchain (no engine)
jbrandwood `v810-gcc` + `libgccvb` headers + `crt0.s` + `vb.ld` + padder, as in Goal 1. Smaller
dependency surface, but you reimplement VIP setup yourself. Good if we want the *tiniest* CC0
demo with no MIT engine code linked in at all (then the ROM is 100% ours, CC0-clean).

### Is authoring impractical? 
No — it is practical for a *small* demo. A full game is a large effort given the obscure
hardware, but a CC0 stereoscopic "hello world with depth" is an achievable, valuable test ROM.

---

## Goal 5 — Fallback: genuinely free VB homebrew to ship

Be skeptical: PlanetVB lists ~80 titles "(PD)", but community members explicitly note these are
better described as **"freely distributed," not public domain** — authors retain copyright.
Do **not** assume CC0 from a "(PD)" tag.

- **BLOX / BLOX 2** by KR155E — the famous "first complete homebrew." Marked (PD) on PlanetVB,
  ROM downloadable, but the homebrew page lists **no explicit license** and source isn't clearly
  posted. Treat as freely-distributed, license-unverified — **not safe to relabel CC0** without
  the author's explicit grant.
  - https://www.virtual-boy.com/homebrew/blox/ , https://www.virtual-boy.com/homebrew/blox-2/
- Other freely-distributed titles/demos: Simon! (DogP), various tech demos, Mario VB, Metroid VB,
  3D Crosswords, etc. — same caveat; many are derivative of Nintendo IP and unsafe to ship.
  - List: https://www.virtual-boy.com/forums/t/list-of-every-virtual-boy-public-domain-homebrew/
  - Homebrew index: https://www.virtual-boy.com/homebrew/

**Recommendation on fallback:** rather than gamble on ambiguous "(PD)" homebrew, **author our
own tiny CC0 demo** (Goal 4). It is the only way to be certain of the license, and it is the
better thematic fit for a VR frontend. If a third-party fallback is truly required, contact a
homebrew author for an explicit CC0/MIT grant before shipping.

---

## Source URLs
- v810-gcc toolchain: https://github.com/jbrandwood/v810-gcc
- gccVB (classic): https://gccvb.sourceforge.net/ ; https://www.virtual-boy.com/tools/gccvb/
- gccVB build guide: https://www.virtual-boy.com/forums/t/guide-to-compile-and-use-the-new-gccvb/
- gccVB getting started: https://www.virtual-boy.com/forums/t/gccvb-getting-started/
- VUEngine-Core (MIT): https://github.com/VUEngine/VUEngine-Core
- VUEngine-Barebone (MIT): https://github.com/VUEngine/VUEngine-Barebone
- VUEngine-Platformer-Demo: https://github.com/VUEngine/VUEngine-Platformer-Demo
- VUEngine Studio: https://github.com/VUEngine/VUEngine-Studio ; https://www.vuengine.dev/
- VUEngine docs (build): https://www.vuengine.dev/documentation/basics/building/
- PD/freely-distributed list: https://www.virtual-boy.com/forums/t/list-of-every-virtual-boy-public-domain-homebrew/
- BLOX: https://www.virtual-boy.com/homebrew/blox/
