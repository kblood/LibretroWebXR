# Creating new Commodore VIC-20 games for LibretroWebXR

Research for shipping small, self-authored CC0/MIT test games on the
`vice_xvic` core. We ship **no** commercial ROMs — only games we write
ourselves. A toolchain's license does not taint our output; the game is ours.

Accepted `vice_xvic` extensions: `20 40 60 a0 b0 rom` (cartridge images) plus
the VICE family also loads `.prg .t64 .tap .d64`. **Simplest artifact: a `.prg`**
that auto-RUNs (tokenized BASIC, or machine code behind a BASIC SYS stub).

---

## 0. The critical gotcha (read first): VIC-20 load address depends on RAM config

Unlike the C64 (always `$0801`), the VIC-20 BASIC start address **moves** with
the amount of expansion RAM, because the system relocates the start-of-BASIC
pointer to keep screen + color RAM contiguous. The **first two bytes of the
`.prg`** (the load address) and any `SYS`/line-link pointers must match the
emulator's configured memory, or the program loads to the wrong place and
crashes or lists garbage.

| Config            | BASIC start / load addr | Typical SYS-stub entry | Notes |
|-------------------|-------------------------|------------------------|-------|
| **Unexpanded** (5K, ~3.5K free) | `$1001` (4097) | `SYS 4109/4110` | RAM `$1000–$1DFF`, screen `$1E00–$1FFF`, color RAM `$9600`. Only ~3583 BASIC bytes free. |
| **+3K**           | `$0401` (1025)          | `SYS 1037/1038`        | Adds RAM at `$0400–$0FFF`; BASIC starts lower. |
| **+8K / +16K / +24K** | `$1201` (4609)      | `SYS 4621/4622`        | The 3K block is *not* added to BASIC; screen stays `$1E00`, **color RAM moves to `$9400`**. |

Key consequences for us:
- A `.prg` authored for unexpanded (`$1001`) will **not** run correctly if VICE
  is configured for +8K, and vice-versa. The load address byte literally differs
  (`$01 $10` vs `$01 $12`).
- **Color RAM differs from the C64.** VIC-20 unexpanded color RAM is at `$9600`;
  with 8K+ expansion it is at `$9400`. (C64 color RAM is fixed `$D800`.)
- Screen RAM is `$1E00` unexpanded; border/background are set via the VIC chip
  registers at `$900F` (one register: high nibble = border, low nibble +
  bit = background/inverse) — **not** the C64's `53280/53281`. So a C64 BASIC
  game ported verbatim will POKE the wrong addresses.
- **Decision for our build script:** pick ONE target and pin the matching VICE
  memory option in the LibretroWebXR core config. Recommended: **unexpanded**
  for the smallest, most "authentic" footprint, OR **+8K (`$1201`)** if a game
  needs the room. Document the chosen `vice_xvic` memory setting alongside the
  ROM so the frontend boots it with the right expansion.

Sources: cc65 VIC-20 doc, techtinkering BASIC-stub article, zimmers memory map
(URLs in §6).

---

## 1. High-level path: BASIC tokenization (port of the C64 PoC)

The existing C64 PoC is `C:\LLM\LibretroWebXR\scripts\make-c64-demo.mjs`: it
hard-tokenizes C64 BASIC v2 (token table `$80..$CB`, longest-match outside
quotes), prepends the `$0801` load address, builds linked-line records with
`next`-line pointers, and appends the `$00 $00` end marker. It produces a
directly-RUNnable `.prg`.

**VIC-20 BASIC v2 is the same BASIC v2** — identical token table (`$80..$CB`),
identical line-link / tokenization format. A `make-vic20-demo.mjs` is a
near-clone of the C64 script with these differences:

1. **Load address**: `0x1001` (unexpanded) instead of `0x0801`. If targeting
   +8K, use `0x1201`. Everything downstream (the `next`-pointer arithmetic that
   already starts from `LOAD_ADDR`) then "just works" because the C64 script
   already parameterizes on `LOAD_ADDR`.
2. **Screen/color POKEs in the game text**: replace C64-isms.
   - Border+background: VIC-20 uses one register `36879` (`$900F`). Example:
     `POKE 36879,8` (black border, white screen) instead of the C64's
     `POKE 53280,..:POKE 53281,..`.
   - Clear screen `PRINT CHR$(147)` is identical (good).
   - 22-column × 23-row screen (vs C64 40×25) — keep PRINT layouts narrow.
3. **Color RAM**, if poked directly: `$9600` unexpanded (`$9400` with 8K+),
   not `$D800`.
4. Everything else (`INPUT`, `GET`, `RND`, `GOTO`, `IF/THEN`) is unchanged.

This is the **lowest-effort, most robust** path: pure Node, no external
toolchain, runs headless on Windows, output is deterministic and tiny, and the
tokenizer is already proven on C64. **Recommended primary pipeline.**

No extra framework needed. (For larger BASIC projects, `petcat` — shipped with
VICE — tokenizes `.bas` text to `.prg` with `petcat -w2 -o out.prg -- in.bas`,
but it requires VICE installed and is overkill for a few-line demo.)

---

## 2. Assembly / C toolchains

For anything beyond a few BASIC lines (smooth movement, custom chars, sound),
go to 6502 assembly or cc65 C. All of the below run headless on Windows.

### cc65 (RECOMMENDED for asm/C) — has a first-class `vic20` target
- **License:** zlib (permissive; does not taint output). Our game stays CC0/MIT.
- **Install (Windows):** download `cc65-snapshot-win64.zip` from the GitHub
  Actions "Snapshot Build" artifacts or SourceForge, extract to `C:\cc65`, add
  `C:\cc65\bin` to PATH. No installer/GUI.
- **Default target memory:** unexpanded. Usable range `$1000–$1DFF`, screen
  `$1E00`, stack at `$1DFF` downward, optional heap in `$A000–$BFFF`. The linker
  emits a **machine-language program with a one-line BASIC stub that `SYS`es into
  the code**, so it loads as BASIC and starts with `RUN` — exactly the artifact
  we want.
- **Build a `.prg` (C):**
  ```
  cl65 -O -t vic20 -o game.prg game.c
  ```
- **Build a `.prg` (asm):**
  ```
  cl65 -t vic20 -o game.prg game.s
  ```
  or two-stage: `ca65 -t vic20 game.s -o game.o` then
  `ld65 -t vic20 -o game.prg game.o vic20.lib`.
- **Expanded RAM:** cc65 ships extra linker configs / `-D__HIMEM__` style
  start-address overrides; for +8K you point `-C` at a config that sets the load
  segment to `$1201`. (Default config = unexpanded — match VICE accordingly.)
- **Cartridge image:** use a cart config, e.g.
  ```
  cl65 -t vic20 -C cart.cfg -o cart.prg crt0.s cart.c
  ```
  Add `-u __LOADADDR__` to include a 2-byte load address in the cart image.
  Reference stub repo: `github.com/ops/vic-cc65-cart`. Cartridge images use the
  `.a0/.b0/.20/.40/.60` autostart extensions accepted by `vice_xvic`.
- **Claude can write cc65 C and ca65 asm for VIC-20 well** — the target is
  documented, register addresses are stable, and the BASIC-stub plumbing is
  automatic, removing the most error-prone hand step.

### 64tass
- **License:** permissive (open source). Native Windows CLI; "Turbo Assembler"
  syntax. Any 6502 assembler works for VIC-20; 64tass produces a `.prg` directly
  from the DOS/PowerShell command line. Good if you want a single self-contained
  asm file with a hand-written BASIC stub. Slightly more manual than cc65 (you
  set `*=$1001` and write the stub yourself).

### ACME
- **License:** GPL (tool only — output is yours). Cross-platform incl. Windows.
  Set `!to "game.prg",cbm` and `*=$1001`; emit a BASIC stub manually. Lightweight,
  widely used in the demoscene. Fine for VIC-20.

### KickAssembler ("KickAss")
- **License:** free (closed-source, Java). Needs a JRE on Windows. Very powerful
  (scripting/macros) but Java dependency + C64-centric examples make it heavier
  than cc65/64tass for our purposes. Works for VIC-20 (it's a generic 6502 asm).

**Toolchain verdict:** **cc65** for asm/C (best Windows story, real `vic20`
target, automatic BASIC stub, handles the load-address gotcha via its configs).
**64tass** as the lightweight single-file alternative.

---

## 3. AI-assisted creation (Claude writing a VIC-20 game)

**Feasibility: realistic for small BASIC and small asm; verify in an emulator.**

Evidence from the wild (C64, the close sibling): Claude 3.7 produced a fully
playable BASIC Snake in one shot; for a harder Tetris, only Claude (not ChatGPT
or Gemini) eventually produced a working version, but first attempts hit syntax
errors when pasted into VICE. Takeaway: **LLM-generated retro BASIC is a game of
chance per-attempt and must be tested**, but Claude is at the top of the pack and
iterates to a working result.

**Failure modes specific to VIC-20 (call out loudly):**
- **Tiny RAM is the dominant constraint.** Unexpanded VIC-20 has **~3.5 KB free
  BASIC RAM** (3583 bytes). A 200-line BASIC program will not fit unexpanded.
  Either keep BASIC demos very small (guess-the-number, simple maze, text
  blackjack) or target +8K (`$1201`) for anything bigger — and then pin VICE to
  8K. This is the #1 thing an LLM forgets.
- **C64→VIC-20 muscle memory:** models love `POKE 53280/53281` and color RAM
  `$D800`; on VIC-20 these are wrong (`$900F`, and `$9600/$9400`). They also
  assume a 40-column screen; VIC-20 is **22 columns**, so PRINT layouts overrun.
- **Load-address mismatch:** an LLM emitting raw bytes may default to `$0801`
  (C64) instead of `$1001`. Our tokenizer should own the load address, not the
  model.
- **Token edge cases:** longest-match tokenization (already handled in the C64
  script) prevents e.g. `TO`/`TOK` confusion; keep that logic.

**Recommended division of labor:** let Claude author the *BASIC source text*
(or cc65 C), and let our deterministic `make-vic20-demo.mjs` own load address,
tokenization, and link pointers. That isolates the fragile creative part from the
byte-exact part and makes output reproducible. No special "VIC-20 generator"
framework is needed; a short skill/prompt with the constraints above is enough.

---

## 4. Concrete recommendation + exact build commands

### Game A (primary, ship first): "Guess My Number" — BASIC, unexpanded, CC0
A direct VIC-20 port of the existing C64 demo. Fits easily in 3.5K. Authored by
us → CC0.

Create `scripts\make-vic20-demo.mjs` as a clone of `make-c64-demo.mjs` with:
- `const LOAD_ADDR = 0x1001;`  (unexpanded)
- Replace line 20 `POKE 53280,6:POKE 53281,6` with `POKE 36879,8`
- Keep line width ≤ 22 chars in PRINT strings
- Output to `public/roms/freeware/lwx-vic20-demo.prg`

Build (headless, Windows, no toolchain beyond Node):
```
node scripts\make-vic20-demo.mjs
```
Load in frontend with `vice_xvic`, **VICE memory = unexpanded**, then `RUN`
(or auto-run). Done. This is the safest, smallest test artifact.

### Game B (optional, more "game"): tiny maze/dodger — cc65 asm or C, unexpanded
For smooth movement + custom screen, write a ~1–2KB cc65 program:
```
# one-time: install cc65 to C:\cc65, add C:\cc65\bin to PATH
cl65 -O -t vic20 -o public\roms\freeware\lwx-vic20-dodge.prg dodge.c
```
Default cc65 config targets unexpanded and auto-adds the BASIC SYS stub, so it
RUNs directly on `vice_xvic` (unexpanded). If it grows past unexpanded RAM,
switch to an `$1201` linker config and set VICE to +8K.

**Pin one memory config per ROM** in the LibretroWebXR core/options metadata so
the frontend boots `vice_xvic` with the matching expansion. Recommend shipping
both demos as **unexpanded** so a single VICE config covers them.

---

## 5. Fallback: genuinely CC0/PD VIC-20 homebrew (be skeptical)

There is **little verified CC0** VIC-20 game source. Findings, with license
checks via the GitHub API:

- **`github.com/malessandrini/vic20`** — **BSD-2-Clause** (verified via API).
  Original homebrew: *Sokoban* (153 "microban" levels; 3K/8K) and *Connect4*
  (unexpanded, vs-CPU AI). Built with a Makefile; releases ship `.d64`. BSD-2 is
  permissive and **safe to redistribute with attribution** (it is *not* CC0, so
  we'd keep its copyright notice; fine as bundled third-party PD-style content,
  but not "ours"). The microban level set has its own (free) provenance — verify
  separately if shipping levels. **Best vetted fallback.**
- **`github.com/tomzox/vic20_games`** — **BSD-2-Clause** (verified via API; has
  LICENSE). Ships prebuilt `prg/dino_eggs.prg`, `snakes.prg`,
  `10_miles_runner.prg` (+ `xa`-assemblable `.asm` sources), all **require 8K
  expansion**. **Skeptic's caveat:** the README says these are the author's own
  early-80s games, but titles like "Dino Eggs" overlap with known commercial
  properties of that era — **do not assume the *game design/IP* is free just
  because the repo's code is BSD-2.** Treat as risky; prefer malessandrini or
  our own content.
- **`github.com/elderling/vic-20-gems`** — 3-in-a-row, cc65 C with a
  `vic20-8k.cfg`. **No LICENSE file found (API 404) → all rights reserved. Do
  NOT ship.**
- **`github.com/ops/vic-cc65-cart`** — cart *stub/template*, not a game; **no
  detected license**. Useful only as a how-to reference, not as content.

**Recommendation:** for true CC0 test content, **author our own** (Game A
above). If a "real" game is wanted as a bonus, **malessandrini's Connect4**
(unexpanded, BSD-2) is the cleanest vetted option — keep its copyright/notice,
label it as third-party BSD, build via its Makefile (needs cc65/asm toolchain),
and convert/extract the `.prg` for `vice_xvic`.

---

## 6. Sources

- cc65 VIC-20 target: https://cc65.github.io/doc/vic20.html
- cc65 intro / running executables: https://www.cc65.org/doc/intro-6.html
- cc65 getting started (Windows): https://cc65.github.io/getting-started.html
- cc65 Windows install (X16 forum): https://cx16forum.com/forum/viewtopic.php?t=6630
- cc65 SourceForge snapshot: https://sourceforge.net/projects/cc65/files/
- cc65 GitHub: https://github.com/cc65/cc65
- VIC cc65 cart stub: https://github.com/ops/vic-cc65-cart
- BASIC stubs / load addresses (techtinkering): https://techtinkering.com/articles/adding-basic-stubs-to-assembly-language-on-the-commodore-vic-20/
- BASIC line storage on VIC-20: https://techtinkering.com/articles/basic-line-storage-on-the-vic-20/
- VIC-20 memory map (zimmers): https://www.zimmers.net/anonftp/pub/cbm/maps/Vic20.MemoryMap.txt
- VIC-20 memory map (vic20reloaded): https://vic20reloaded.com/commodore-vic-20-memory-map/
- 6502 cross-assembler tour: https://bumbershootsoft.wordpress.com/2016/01/31/a-tour-of-6502-cross-assemblers/
- LLM C64 BASIC game tests (Medium, G.L. Bailo): https://medium.com/@gianlucabailo/the-commodore-64-test-why-ai-code-generation-is-still-a-game-of-chance-a8c7a1937d86
- VIC-20 homebrew (BSD-2): https://github.com/malessandrini/vic20
- VIC-20 games (BSD-2): https://github.com/tomzox/vic20_games
- VIC-20 gems (no license): https://github.com/elderling/vic-20-gems
- Existing C64 PoC in this repo: C:\LLM\LibretroWebXR\scripts\make-c64-demo.mjs
