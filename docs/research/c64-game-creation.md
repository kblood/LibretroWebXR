# Creating New Commodore 64 Games as LibretroWebXR Test Content

Research date: 2026-06-01. Status: findings + recommendation. **Not legal advice.**

## Goal & constraints

The C64 (libretro `vice_x64` core) is the flagship system. We want a "C64 Game
System"-style set of **several small games we author ourselves**, shipped under
CC0 or MIT. We ship **no commercial ROMs**. The output (the game we write) is
ours regardless of the toolchain's own license — a GPL assembler does not taint
a `.prg` we author, the same way GCC's license doesn't taint compiled programs
(the FSF's own GCC Runtime Library Exception logic).

Accepted `vice_x64` extensions: `d64 d71 d80 d81 d82 g64 x64 t64 tap prg p00 crt`.
**The simplest shippable artifact is a `.prg`** that loads at `$0801` and runs.

We already ship a working proof of concept: `scripts/make-c64-demo.mjs` tokenizes
C64 BASIC v2 into a runnable `.prg` from pure Node.js (no external tools). The
"next step" is more interesting/playable games, including assembly/C for action.

Key technical fact that shapes everything below: **a C64 `.prg` is directly
runnable on its own — no disk image required.** A `.prg` is just a 2-byte load
address followed by the bytes. If those bytes are a BASIC program (or a tiny
BASIC stub that `SYS`es into machine code) loaded at `$0801`, the user can
`LOAD` + `RUN` it. Our frontend can autostart it.

---

## Goal 1 — High-level / lowest-effort paths (emit a game from a script)

### 1a. Pure BASIC v2 tokenization (what we already do) — zero dependencies
`scripts/make-c64-demo.mjs` is the model: a JS array of `[lineNo, "BASIC TEXT"]`,
a token table (`0x80..0xCB`), longest-match tokenization outside quotes, then
link-pointer assembly at load address `$0801`. **No toolchain, runs in CI, fully
ours, CC0-clean.** This is the lowest-effort path and should remain the baseline
for menu/quiz/puzzle/turn-based games.

Limits of raw BASIC v2:
- ~1 MHz interpreted; action games are sluggish (the Claude Tetris experiment
  needed VICE **warp mode** to be playable — see Goal 3).
- No structured `IF...THEN`: you **cannot chain `:`-separated statements after a
  `THEN`** in a way that survives all cases; multi-state logic gets awkward. This
  is a real, documented LLM failure mode (rotation bug in the Tetris experiment).
- No built-in sprite/sound helpers — everything is `POKE`/`PEEK` to VIC-II
  (`$D000+`) and SID (`$D400+`).
- 38911 BASIC bytes free; fine for our scale.

**Verdict:** keep for simple games. Extend `make-c64-demo.mjs` into a small
reusable "BASIC → prg" module so each game is just a listing.

### 1b. PETSCII / charset graphics from BASIC
The C64 ROM charset (PETSCII) gives instant blocky graphics with no asset
pipeline — see *Digiloi*, a full action game using only default characters
(http://oldmachinery.blogspot.com/2018/12/digiloi-action-game-with-c64-default.html).
For our script approach, drawing with `PRINT CHR$(...)` and reverse/colour codes
is the cheapest "graphics." Good enough for maze/snake/board games.

### 1c. Sprite/charset tooling (if we go beyond PETSCII)
- **`sp65`** ships with cc65 — converts PNG/koala/etc. to C64 sprite/charset data
  you `#include` (https://cc65.github.io/doc/sp65.html). Headless, scriptable.
- For pure-script generation we can also just emit sprite bytes directly from JS
  (a sprite is 63 bytes; 24x21 1-bpp) — same philosophy as the BASIC tokenizer.

### 1d. Frameworks
There is no mature, npm-installable "C64 game engine." The realistic frameworks
are the C/asm toolchains in Goal 2 plus community libraries (e.g. cc65's
`conio`/`tgi`). SEUCK (Shoot-Em-Up Construction Kit) exists but is GUI-only and
not scriptable/headless — **not suitable** for an AI-agent pipeline.

---

## Goal 2 — Assembly / C toolchains for real action games

All of these are free, run **headless on Windows**, and produce a `.prg`. Summary:

| Tool | Lang | License | Install (Windows) | Directly-runnable .prg? | LLM-friendliness |
|---|---|---|---|---|---|
| **cc65 / cl65** | C + 6502 asm | zlib (permissive) | installer or snapshot zip | **Yes** (default c64 target adds BASIC SYS stub @ $0801) | High (C is in distribution; lots of examples) |
| **llvm-mos** | modern C/C++ (clang) | Apache-2.0-with-LLVM-exception (SDK: see note) | download `llvm-mos-windows.7z` | **Yes** (`-o x.prg` adds BASIC SYS header) | High (standard clang C, best optimizer) |
| **ACME** | 6502 asm | GPL (output is yours) | SourceForge binary | Yes (`--format cbm`, add stub or set $0801) | Medium-High (very common in examples) |
| **64tass** | 6502 asm (Turbo Ass syntax) | GPL-2.0 (output is yours) | SourceForge / GitHub binary | Yes (`-C -a`, set start) | Medium |
| **KickAssembler** | 6502 asm (rich macros) | Freeware, closed-source, **Java** | `theweb.dk/KickAssembler` + JRE 8+ | Yes | Medium (powerful but Java dep; less ideal for CI) |

### Recommended: cc65 (write in C) — best balance for us
- **Install (Windows):** download the snapshot from GitHub Actions
  (`cc65/cc65` → Actions → Snapshot Build → `cc65-snapshot-win64`), unzip to
  `C:\cc65`, add `C:\cc65\bin` to PATH. (`where cc65` to verify.) Or the
  classic `.exe` installer from https://cc65.github.io/.
- **Build a runnable .prg (one command):**
  ```
  cl65 -O -t c64 -o game.prg game.c
  ```
  `cl65` compiles + assembles + links in one step. The default **c64 target
  config already emits a `.prg` with a one-line BASIC stub that `SYS`es into the
  machine code at `$0801`**, so the user just `LOAD"GAME",8` + `RUN` (or we
  autostart). **No disk image needed.** (cc65 c64 docs:
  https://cc65.github.io/doc/c64.html)
- Mix in hand-written asm files for hot loops: `cl65 -O -t c64 -o game.prg game.c irq.s`
- Sprites/charsets via `sp65`. Sound: `POKE` SID or a small player.
- License: cc65 is **zlib** — permissive; our output is unencumbered.

### Strong modern alternative: llvm-mos (write in modern C)
- **Install (Windows):** download
  https://github.com/llvm-mos/llvm-mos-sdk/releases/latest/download/llvm-mos-windows.7z,
  extract, add `bin` to PATH.
- **Build a runnable .prg:**
  ```
  mos-c64-clang -Os -o game.prg game.c
  ```
  Produces a `.prg` for the C64 **including a BASIC SYS header** (auto-runs with
  `RUN`). Clang means better optimization and more standard C than cc65 (no
  hardware float, but games rarely need it). License is LLVM's
  Apache-2.0-with-exception (the SDK README doesn't restate a license; the
  toolchain is Apache/LLVM — confirm the SDK's `LICENSE` file before relying on
  it, but in all cases **our compiled game is ours**). https://llvm-mos.org/
- Trade-off vs cc65: fewer ready-made C64 examples for an LLM to pattern-match,
  but cleaner C. Either is fine.

### Pure-assembly options
Use only if we want a demo-scene-grade action game and are willing to write
6502. **ACME** and **64tass** are GPL, single-binary, trivially headless, and
both emit a `.prg` (ACME: `acme --outfile game.prg --format cbm game.a` with a
`* = $0801` BASIC stub for autostart). **KickAssembler** is the most powerful
(macros, SID/graphics import) but is closed-source freeware and needs Java —
**least suited to our scriptable/CI goal**, so prefer cc65/llvm-mos/ACME.

**Note on "directly-runnable .prg vs disk image":** all tools above can produce
a single autostarting `.prg`. You only need a `.d64` disk image if the game spans
multiple files, streams from disk, or exceeds what fits comfortably in one load —
not the case for our small test games. The vice_x64 core accepts `.prg`
directly.

---

## Goal 3 — AI-assisted game creation (can Claude write a working C64 game?)

**Verdict: Yes, feasibly, for small games — best results writing C for cc65, with
a build+screenshot verification loop. BASIC works for simple/turn-based games.**

Real, documented evidence:

- **"Meteor Storm" (Claude Opus, 2026)** — Claude *autonomously designed* an
  original action game (Asteroids/Invaders/Arkanoid mashup: splitting meteors,
  destructible bunkers, power-ups, parallax starfield, demo AI). Written in **C
  (1,654 lines) compiled with cc65** to a 26 KB binary. It **compiled cleanly on
  the first try and ran in VICE.** Failure modes after that: 6 rendering bugs
  found by code review, and a **memory-layout crash** (program overran its space
  and overwrote its own code) fixed with a custom **linker config**. Needed ~2
  debugging rounds + one human hint. (Medium, "I Asked Claude Opus … to Invent a
  C64 Game", https://medium.com/operations-research-bit/i-asked-claude-opus-4-6-to-invent-a-commodore-64-game-from-scratch-heres-what-happened-6adf483b7578)
  → **This is essentially our exact use-case and it worked.**

- **Tetris in C64 BASIC (Claude Opus)** — reached ~90% functional (all 7 pieces,
  collision, line-clear, scoring, levels) from a one-line prompt. Failure modes:
  a piece-**rotation bug** rooted in BASIC v2's inability to chain `:`-statements
  after `THEN`, and it needed **warp mode** to be playable (1 MHz interpreter too
  slow). (https://medium.com/@gianlucabailo/breaking-through-the-tetris-barrier-how-claude-4-opus-nearly-conquered-the-commodore-64-378f1d990606)
  → BASIC is fine for simple games; real-time/complex logic should be C/asm.

Tooling for an agent loop:
- **c64bridge** — an **MCP server** (Node 24+, `npx -y c64bridge@latest`,
  **GPL-2.0**) that exposes `c64_program`/`c64_memory`/`c64_graphics`/`c64_sound`
  tools and `upload_run_basic` / `upload_run_asm`, targeting **VICE** or real
  C64 Ultimate hardware. It tokenizes BASIC / assembles asm, uploads, and runs.
  Useful for *interactive* agent dev, but for our CI/build pipeline a plain
  `cl65` invocation is simpler and dependency-light.
  (https://github.com/chrisgleissner/c64bridge)

**Failure modes to expect & mitigate (for our own authoring):**
1. **Memory/linker overruns** (asm/C) → catch by building + checking size; keep a
   known-good linker config; for cc65 watch the `__EXEHDR__`/segment layout.
2. **BASIC `THEN` / line-length limits** → keep BASIC logic flat; one statement
   per `IF`; prefer `GOTO`/`GOSUB`. Our tokenizer should reject lines > 255 bytes.
3. **Slowness in BASIC** → restrict BASIC to turn-based/menu games; do action in C.
4. **Visual bugs invisible to text review** → add a **headless VICE screenshot**
   step (VICE can run a `.prg` and dump a frame) and eyeball it, or use a vision
   pass. This is the single highest-value verification we can add.
5. **PETSCII/screen-code vs ASCII confusion** → centralize char constants.

---

## Goal 4 — Concrete recommendation (games + exact pipeline)

### The single recommended pipeline
For **simple games**: keep extending the **pure-Node BASIC tokenizer**
(`make-c64-demo.mjs`) — zero deps, CI-clean, instant.

For **action/"real" games**: **cc65 + `cl65`**, building a self-contained
autostarting `.prg`:

```powershell
# one-time install: unzip cc65 snapshot to C:\cc65, add C:\cc65\bin to PATH
cl65 -O -t c64 -o public/roms/freeware/lwx-<game>.prg games/<game>.c
# optional: hand-written asm for the inner loop
cl65 -O -t c64 -o public/roms/freeware/lwx-<game>.prg games/<game>.c games/<game>_irq.s
```

The resulting `.prg` loads at `$0801`, includes a BASIC SYS stub, and **runs
directly** in `vice_x64` — load it via the existing freeware ROM collection with
`license: CC0` and our own `credits`.

### Three small CC0 games we could realistically author

1. **"LWX Snake" — BASIC, low complexity.** PETSCII grid, `GET`-based input,
   grow-on-eat, wall/self collision. Turn-based timing hides BASIC's slowness.
   Build: pure-Node tokenizer (no toolchain). *Best first deliverable — extends
   what we already have.*

2. **"LWX Catch / Avoid" — C via cc65, low-medium complexity.** Single hardware
   sprite you move left/right with joystick (port 2, `$DC00`), objects falling
   from top, score, lives. Demonstrates sprites + SID blip + real-time play.
   ~150–300 lines of C. Build: `cl65 -O -t c64 -o lwx-catch.prg catch.c`.

3. **"LWX Meteors" — C via cc65, medium complexity (stretch).** A small original
   shooter in the spirit of the proven *Meteor Storm* experiment: a few sprites,
   wrap-around movement, shooting, splitting rocks. Validates that an LLM-authored
   C action game compiles + runs end-to-end. Build same as #2; watch memory
   layout (add a custom `-C` linker config if it overruns).

Each ships under **CC0** with a `LICENSE`/credit entry; source committed under
`games/` so the artifact is provably ours.

---

## Goal 5 — Fallback: existing CC0 / public-domain homebrew (be skeptical)

**Conclusion: do NOT rely on third-party "PD" C64 games — author our own.**

Why skeptical:
- C64-scene "Public Domain" (e.g. Lemon64's "(Public Domain)" publisher tag,
  CSDb releases) is a **community/distribution convention, not a verified legal
  license.** Many such games contain ripped commercial music (SID tunes),
  sprites, or charsets, and almost none ship a clear CC0/MIT `LICENSE` file with
  a copyright holder we can name. "Free download" ≠ redistributable.
- Aggregator repos like `retrobrews/c64-games`
  (https://github.com/retrobrews/c64-games) bundle many titles **without
  per-title license provenance** — unsafe to redistribute wholesale.
- itch.io C64 homebrew (e.g. C64CD Laboratories, https://c64cd.itch.io/) sometimes
  posts source, but licenses vary per author and must be checked title-by-title;
  most are "all rights reserved" by default even when source is visible.

If we ever do adopt an external title, the bar is: (a) an explicit CC0/MIT/PD
declaration **from the named author**, (b) source available, (c) no embedded
third-party SID/graphics of unclear origin. Record `license` + `credits` +
source URL in the collection JSON (per `docs/LICENSING.md`). Until such a title
is verified, **authoring our own (Goal 4) is the only clean path** — and it's
cheap, since the BASIC tokenizer is already proven.

---

## Sources
- cc65 home / docs: https://cc65.github.io/ , https://cc65.github.io/doc/cl65.html , https://cc65.github.io/doc/c64.html , https://cc65.github.io/doc/sp65.html
- cc65 c64 BASIC SYS stub / autostart: https://www.cc65.org/snapshot-doc/c64-4.html , https://codebase64.org/doku.php?id=base:autostarting_disk_files
- cc65 Windows install: https://www.nesdev.org/wiki/Installing_CC65 , https://cx16forum.com/forum/viewtopic.php?t=6630
- llvm-mos: https://llvm-mos.org/ , https://github.com/llvm-mos/llvm-mos-sdk , https://www.c64-wiki.com/wiki/llvm-mos
- Cross-assembler comparison: https://bumbershootsoft.wordpress.com/2016/01/31/a-tour-of-6502-cross-assemblers/ , https://www.c64-wiki.com/wiki/Cross_Assembler
- ACME: https://sourceforge.net/projects/acme-crossass/ ; 64tass: https://sourceforge.net/projects/tass64/ , https://github.com/irmen/64tass ; KickAssembler: https://theweb.dk/KickAssembler/
- AI-authored C64 game (Meteor Storm, cc65/C): https://medium.com/operations-research-bit/i-asked-claude-opus-4-6-to-invent-a-commodore-64-game-from-scratch-heres-what-happened-6adf483b7578
- AI Tetris in C64 BASIC: https://medium.com/@gianlucabailo/breaking-through-the-tetris-barrier-how-claude-4-opus-nearly-conquered-the-commodore-64-378f1d990606
- c64bridge MCP server: https://github.com/chrisgleissner/c64bridge
- PETSCII action game (Digiloi): http://oldmachinery.blogspot.com/2018/12/digiloi-action-game-with-c64-default.html
- Homebrew aggregator (skeptical): https://github.com/retrobrews/c64-games ; itch.io: https://c64cd.itch.io/
