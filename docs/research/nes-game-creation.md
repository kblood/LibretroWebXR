# Creating NES / Famicom Games for LibretroWebXR

Research on authoring small CC0/MIT NES games as test content. Target: a standard
iNES **.nes** ROM, mapper 0 (NROM), runnable on libretro **nestopia** (default) and
**fceumm**. All toolchains below are scriptable/headless on Windows (no GUI required
to emit a ROM). Toolchain licenses do **not** taint the output ROM — the game is ours
and we ship it CC0 or MIT.

Date: 2026-06-01.

---

## Goal 1 — C toolchains

### cc65 + neslib (Shiru) — RECOMMENDED C PATH

`cc65` is a freeware C compiler + macro assembler (`ca65`) + linker (`ld65`) for 6502
systems including the NES. `neslib` is Shiru's small public-domain C library that wraps
the hard parts (NMI/vblank handling, PPU updates via a buffered update list, sprite
rendering, controller reads, RLE name-table unpacking). Using neslib is the single
biggest lever for getting *working* NES C code, because it hides exactly the things
that go wrong (vblank timing, PPU register order).

- cc65 home: https://cc65.github.io/ — Getting Started: https://cc65.github.io/getting-started.html
- Windows snapshot zip (SourceForge): https://sourceforge.net/projects/cc65/files/cc65-snapshot-win64.zip/download
- Alt: GitHub Actions "Snapshot Build" artifact `cc65-snapshot-win64` at https://github.com/cc65/cc65
- NESdev install guide: https://www.nesdev.org/wiki/Installing_CC65
- Shiru examples (with build files): https://github.com/jmk/cc65-nes-examples
- Updated neslib for cc65 git master: https://github.com/clbr/neslib
- nesdoug (most modern cc65/neslib tutorial series + templates): https://nesdoug.com/
  GitBook: https://dag7.gitbook.io/nesdoug-nes-guide/

**License:** cc65 is zlib-style freeware. neslib is public domain (Shiru). Neither
taints output. → Our game can be CC0/MIT.

**Install (Windows, headless):**
1. Download `cc65-snapshot-win64.zip`, extract to `C:\cc65`.
2. Add `C:\cc65\bin` to PATH (or call binaries by full path in a build script).
3. Verify: `where cc65` (also installs `ca65`, `ld65`).

**Build pipeline (C → .nes):** cc65 compiles C to asm, ca65 assembles, ld65 links with
an NROM config and links in CHR data. Typical script:
```bat
cc65 -Oi game.c --add-source -o game.s
ca65 game.s -o game.o
ca65 crt0.s -o crt0.o            REM neslib startup / NMI handler
ca65 neslib.s -o neslib.o        REM the library (asm)
ld65 -C nrom_32k_vert.cfg -o game.nes crt0.o game.o neslib.o nes.lib
```
In practice you copy a working template (nesdoug or Shiru's examples) that already
ships `crt0.s`, `neslib.s/.h`, the `.cfg`, and a `compile.bat` — then you only edit
`game.c`. This is the AI-friendliest setup: an LLM fills in `main()` against neslib's
documented API and leaves the timing-critical startup untouched.

**AI suitability:** GOOD. C + neslib lets Claude write ordinary game logic
(state machines, collision, score) and call `ppu_on_all()`, `pal_all()`, `vram_*`,
`oam_spr()`/`oam_meta_spr()`, `pad_poll()` / `pad_trigger()`. The library owns the
PPU/vblank correctness. Failure surface is small and high-level.

### create-nes-game (scriptable wrapper around cc65/ca65)

A tool that scaffolds and builds NES games using cc65/ca65, fetching the toolchain for
you. MIT licensed; does not bundle cc65 (downloads it via `download-dependencies`).
- https://github.com/igwgames/create-nes-game (releases: https://gh.nes.science/create-nes-game/releases)
- Companion beginner kit: https://github.com/igwgames/nes-starter-kit

```
create-nes-game.exe install
create-nes-game           REM interactive scaffold (one-time, manual)
create-nes-game build     REM produces the .nes  -- scriptable
create-nes-game run
```
**Caveat for agents:** project *creation* is interactive (multiple-choice prompts) and
the docs expose no documented `--non-interactive` flag. Workaround: generate the
project once by hand (or commit a template repo) — the resulting
`.create-nes-game.config.json` supports `beforeStepActions`/`afterStepActions`, and
`create-nes-game build` is then fully headless/CI-runnable. Good as a thin reproducible
build wrapper; for pure AI generation the raw cc65 template is simpler.

### NESFab — high-level NES language (assess: strong, but GPL compiler + WSL on Windows)

NESFab is a purpose-built high-level language that targets the NES, with C-like syntax
plus integrated asset loading (drop a PNG in the source dir, the build converts it) and
level-editing helpers. It reportedly emits *better* 6502 than gcc/llvm.
- Home: https://pubby.games/nesfab.html — Docs: http://pubby.games/nesfab/doc.html
- Repo: https://github.com/pubby/nesfab — Releases: https://github.com/pubby/nesfab/releases

**License:** the **compiler is GPL-3.0**, but the **standard library/examples are Boost
Software License 1.0**, and the author states explicitly: *"If you make a game using
NESFab, your code can remain private, and you do not need to include attribution."* So
**our game ROM is NOT tainted** — we can release it CC0/MIT.

**Windows:** binary releases are published "from time to time" (e.g. `nesfab_legal.exe`
shipped in a Windows release; latest ~1.8). When a Windows binary isn't current, build
from source needs GCC (C++20) + Boost + Make → easiest via WSL2/MinGW (`make release`).
This is the main friction point on Windows: less turnkey than cc65.

**AI suitability:** PROMISING but RISKY. The syntax is friendly and the asset pipeline
removes CHR hassle, but it is a *niche* language with little training data, so Claude is
far more likely to produce idiomatically-wrong NESFab than idiomatically-wrong C. Best
reserved for a second-pass once the C pipeline is proven. Toolchain friction on Windows
also argues against it as the default.

### llvm-mos — full C/C++ for 6502, prebuilt NES NROM targets

LLVM fork with a real 6502 backend and a clang-based C/C++ compiler; the SDK ships
ready NES board targets.
- Home: https://llvm-mos.org/ — Repo: https://github.com/llvm-mos/llvm-mos
- SDK: https://github.com/llvm-mos/llvm-mos-sdk
- NES Game Genie jam template: https://github.com/jroweboy/llvm-mos-game-genie-jam

**Install (Windows):** download prebuilt SDK `llvm-mos-windows.7z`, extract, add
`...\bin` to PATH (`rundll32.exe sysdm.cpl,EditEnvironmentVariables`). Do NOT add to PATH
alongside an existing stock LLVM/Clang — they conflict.

**Build (one command, C → .nes):**
```
mos-nes-nrom-clang -Os -o game.nes game.c
```
NES targets include `mos-nes-nrom` (NROM-128/256), `mos-nes-cnrom`, `mos-nes-unrom`,
`mos-nes-mmc1`, `mos-nes-mmc3`, plus FDS variants.

**License:** Apache-2.0-with-LLVM-exception (compiler) + permissive SDK runtime — output
not tainted.

**AI suitability:** OK. Standard C/C++ that Claude writes well, and the single-command
build is attractive. BUT the NES SDK targets are described as *skeletal* — you still
hand-roll PPU/vblank/CHR setup with no neslib-equivalent batteries included, so the
hard NES-specific failure modes are back on the table. Prefer cc65+neslib unless C++ is
specifically wanted.

---

## Goal 2 — Assembly toolchains (ca65 / asm6f / NESASM)

### ca65 / ld65 (part of cc65) — RECOMMENDED ASM PATH

Same install as cc65 above. The macro assembler (`ca65`) + linker (`ld65`) use a linker
config (`.cfg`) and segments instead of NESASM-style `.org`. This is the modern de-facto
standard and what the "Nerdy Nights" tutorials have been ported to.

- Minimal, clean reference (CC0-ish, "freely reused"): https://github.com/bbbradsmith/NES-ca65-example
  (files: `example.s`, `background.chr`, `sprite.chr`, `example.cfg`, `compile_example.bat`)
- NROM template: https://github.com/pinobatch/nrom-template
- Nerdy Nights → ca65 translations:
  https://github.com/JamesSheppardd/Nerdy-Nights-ca65-Translation and
  https://github.com/ddribin/nerdy-nights
- Nerdy Nights PDF: https://nerdy-nights.nes.science/downloads/Nerdy-Nights-NES-Tutorials-v1.pdf

**Build (headless):**
```
ca65 game.s -o game.o --debug-info
ld65 game.o -o game.nes -t nes --dbgfile game.dbg
```
(or `ld65 -C nrom.cfg ...` with an explicit NROM config and CHR linked as a segment).
bbbradsmith's repo's `compile_example.bat` is a drop-in Windows reference.

### asm6 / asm6f — simplest single-binary assembler

`asm6f` (freem's fork of loopy's ASM6) is a single small Windows .exe; one command,
`.org`-based, no linker. Great for tiny demos. Supports illegal opcodes, NES2.0 headers,
FCEUX/Mesen symbol export.
- https://github.com/freem/asm6f (Windows 32/64-bit binaries in Releases)
```
asm6f game.asm game.nes
```

### NESASM (classic Nerdy Nights assembler)

Original Nerdy Nights assembler; maintained fork `nesasm CE`:
https://github.com/ClusterM/nesasm . Works but is the most dated; prefer ca65 or asm6f.

**AI suitability (all asm):** MODERATE-TO-POOR. Hand 6502 for the NES is exactly where
LLMs fail most (see Goal 4). Use asm only for the smallest demos, and only on top of a
*known-good template* where Claude edits logic between the proven init/NMI blocks.

---

## Goal 3 — High-level / visual / lowest-effort

- **8bitworkshop online IDE** — https://8bitworkshop.com/ . Browser IDE that compiles
  C (cc65 + a fork of Shiru's NESLib) **and** 6502 asm in-browser, with live emulator and
  ROM export. Excellent for *humans* and for iterating; **not headless** (it's a GUI/web
  app), so it's not the agent pipeline, but it's the lowest-effort way to *prototype* and
  to sanity-check AI-written C against a real emulator. NES intro:
  https://8bitworkshop.com/blog/platforms/nes/
- **NESmaker** — commercial, GUI-only, not scriptable. Note it exists; not for us.
- **Family BASIC** — historical, not a viable authoring path. Skip.
- **Lowest-effort code path that an AI can drive end-to-end:** cc65 + neslib from a
  committed template (edit `game.c`, run `compile.bat`). Single-command alternative:
  `llvm-mos` (`mos-nes-nrom-clang -Os -o game.nes game.c`) but with less hand-holding.

---

## Goal 4 — AI-assisted creation (honest assessment)

**Can Claude produce a playable NROM game?** Yes — *if* it writes **C against neslib**
from a working template. Writing raw NES 6502 from scratch is unreliable.

Evidence / consensus from practitioners:
- 8bitworkshop's own experiment ("Will ChatGPT replace retro programmers?",
  https://8bitworkshop.com/docs/posts/2023/fun-with-chatgpt-and-8bits.html): LLMs are good
  at *boilerplate, modification-with-context, and brainstorming*, and poor at *large
  projects, niche languages, and assembly*. Notable success: it correctly rewrote a
  sprite demo into NES metasprites on the first try **when given example source**. Notable
  failures: subtle logic bugs (e.g. setting but never clearing a flag), dialect confusion,
  and incomplete/non-functional programs.
- NESdev guidance on init: the NES reset code must **wait for two vblanks** (poll bit 7
  of `$2002`) before touching the PPU; `$2000/$2001` must be set in the right order;
  OAM is uploaded via `$4014` DMA during vblank; CHR must be present. These are precisely
  the timing-critical details LLMs get subtly wrong.

**Common AI failure modes on NES:**
- Wrong/missing **double-vblank wait** at reset → garbled or black screen.
- Writing PPU registers (`$2006/$2007`) **outside vblank** → corrupted name tables /
  flicker. (neslib's update-list pattern prevents this.)
- Forgetting **OAM DMA** (`$4014`) each frame, or wrong sprite attribute byte order.
- **No CHR data** / wrong iNES header (mapper, mirroring, PRG/CHR bank counts) → emulator
  shows nothing or refuses to load.
- Subtle 6502 gotchas: indirect `JMP` page-wrap, zero-page wrap, BCD/carry handling.
- Cycle-budget overruns in the NMI handler causing dropped frames.

**Mitigation = a fixed minimal template the AI only fills in.** Keep
`crt0.s`/reset/NMI, the iNES header, the linker `.cfg`, and CHR generation *frozen and
correct*; let Claude write only `main()` + game logic in C calling neslib. This converts
the task from "write correct NES hardware code" (hard for LLMs) to "write a small C
game loop" (easy for LLMs). Always validate by running the ROM in fceumm/nestopia (or
8bitworkshop) — never assume first-pass correctness.

**MCP / skills / generators:** no mature, reliable NES-specific LLM generator or MCP
server was found as of this research. The robust approach is the template-fill workflow
above, not a turnkey "NES generator."

---

## Goal 5 — Concrete recommendations (games + exact pipeline)

**Default pipeline for all three (cc65 + neslib template):**
1. `Download cc65-snapshot-win64.zip` → extract to `C:\cc65`; add `C:\cc65\bin` to PATH.
2. Clone a neslib template: `git clone https://github.com/jmk/cc65-nes-examples` (or use a
   nesdoug template). It contains `crt0.s`, `neslib.s/.h`, an NROM `.cfg`, `compile.bat`.
3. AI edits **only** `game.c` (logic + neslib calls) and supplies CHR tiles (PNG→CHR via
   the template's tool, or hand-authored).
4. Build: run `compile.bat` (cc65 → ca65 → ld65) → emits `game.nes` (NROM, mapper 0).
5. Validate: load `game.nes` in fceumm/nestopia (or 8bitworkshop) before shipping.
6. License the source CC0 or MIT; commit ROM as test content.

Suggested CC0 games (ascending complexity, all NROM, all neslib-friendly):

1. **Pong / Paddle** — *trivial.* 2 paddles + 1 ball, BG playfield, score digits.
   Pure C: ball velocity, AABB collision vs paddles/walls, score. ~1 screen, no scrolling.
   Best first target — highest chance of a clean first build. Toolchain: cc65+neslib.
2. **Maze / collect-the-dots** — *easy.* Static name-table maze, player sprite, tile-based
   movement with wall collision (read BG tile id), pickups, win state. cc65+neslib.
3. **Fixed-screen shoot-em-up** — *moderate.* Player ship, button-fire bullets (small
   object pool), descending enemies, collision, score/lives, simple sound via neslib's
   APU helpers. Single screen, no scrolling to keep PPU updates trivial. cc65+neslib.

Keep all three single-screen (no scrolling) to minimize PPU-update complexity — that is
the difference between "AI writes it on the first or second try" and "fights the PPU."

---

## Goal 6 — Fallback: ship existing permissively-licensed homebrew (be skeptical)

If authoring slips, ship verified freely-redistributable homebrew. Verify the license in
each repo's `LICENSE` before redistributing the ROM (a permissive *source* license does
not always come with redistributable prebuilt art/ROM rights).

- **Super Tilt Bro.** — https://github.com/sgadrat/super-tilt-bro ,
  https://supertiltbro.wontfix.it/ . Source under **WTFPL** (functionally public-domain;
  WTFPL is used because true PD dedication isn't possible in France). Still the best-known
  pick. **Caveat:** character art is *derived from third-party characters* (e.g. David
  Revoy's Pepper) under their own CC licenses with attribution requirements — so the
  *code* is free but verify/attribute the *assets* before shipping the ROM. A from-source
  rebuild lets us confirm exactly what we ship.
- **Alter Ego (NES)** — cc65 C port; source available, BUT licensing is murky (port done
  "with permission," no explicit license negotiated). **Do not assume redistributable.**
- **Lawn Mower / other Shiru releases** — Shiru historically releases source as public
  domain on https://shiru.untergrund.net/ ; verify per-title.
- **nesdev compo entries** — many publish source; licenses vary, check each.
- Brad Smith's **NES-ca65-example** (https://github.com/bbbradsmith/NES-ca65-example) is
  explicitly "freely redistributable/modifiable, credit appreciated" — usable as a CC0-like
  base or as shippable test content itself.

**Verdict on fallback:** Super Tilt Bro (WTFPL code) is the strongest existing pick, but
its *assets* carry attribution obligations — so authoring our own small CC0 game is
cleaner for a project that wants unambiguous CC0/MIT test content.

---

## Bottom line

- **Best pipeline:** cc65 + neslib from a frozen working template; AI edits only the C
  game loop; build with cc65→ca65→ld65 to an NROM `.nes`; validate in fceumm/nestopia.
- **AI feasibility:** realistic for small single-screen games *via neslib C*; unreliable
  for hand-written 6502 asm; the template-fill discipline is what makes it work.
- **First game to author:** **Pong** (CC0), then a maze, then a fixed-screen shmup.
