# Creating New PC Engine / TurboGrafx-16 Games for LibretroWebXR

Research date: 2026-06-01. Target runtime: libretro **mednafen_pce_fast**
(extensions confirmed: `pce|cue|ccd|chd|toc|m3u` — a plain `.pce` HuCard ROM is
what we want to author and ship). All games we ship are authored by us under
**CC0 or MIT**. The toolchain's own license does not taint our output: HuC/PCEAS
and cc65 are *tools*, and the C/asm source we write plus the resulting `.pce` are
our copyright, licensable as we choose. (Standard "compiler output" reasoning,
same as GCC's GPL not infecting compiled programs.)

---

## Goal 1 — C toolchain: HuC (primary, AI-friendly path)

**HuC** is the classic PC Engine C compiler: a small-C–derived C front end that
emits HuC6280 assembly, assembled to a `.pce` HuCard (or CD image) by its bundled
**PCEAS** assembler (a fork of the MagicKit assembler). It ships a runtime
library (`huc.h`) with high-level helpers for the VDC video chip, sprites/tiles,
fonts, input, and PSG sound — this is the single biggest reason it is the most
*AI-friendly* path: the hard hardware-init details are abstracted behind library
calls, so an LLM does not have to hand-bring-up the VDC or hand-craft the HuCard
header.

### Forks (lineage and which to use)
The original HuC (David Michel, "Zeograd", release 3.21) is unmaintained. Modern
forks, in lineage order:

- **uli/huc** — Ulrich Hecht's "Enhanced HuC". Added ANSI declarations, structs/
  unions, typedef, signed/unsigned, malloc/free, preprocessor macros, a 470+
  case test suite, 64-bit/Cygwin/Mac fixes. This is the modern foundation.
  https://github.com/uli/huc
- **ArtemioUrbina/huc** — Artemio Urbina's fork on top of uli (bank-packing and
  other fixes). https://github.com/ArtemioUrbina/huc
- **jbrandwood/huc** — John Brandwood's fork; further toolchain + library work,
  best README documenting features/limits. https://github.com/jbrandwood/huc
- **pce-devel/huc** — the **community organization fork and de-facto current
  HuC** (1700+ commits, forked from Artemio, pulls Brandwood's work). It also
  contains the newer **HuCC** compiler (in `examples/hucc`) alongside classic
  `huc`. **Use this one.** https://github.com/pce-devel/huc

> Note on "uPCEd": no current project by that exact name was found. The query
> most likely refers to **uli's HuC** ("u" = uli) / the upstream enhanced HuC
> line above. Treat pce-devel/huc as the canonical modern HuC.

### Windows install — PREBUILT BINARY EXISTS (no compiling the toolchain)
The pce-devel/huc repo publishes a rolling **"current"** prerelease with
auto-built binaries for all three OSes. Confirmed assets (release `current`,
asset build dated **2026-05-28**):

- `huc-2026-05-28-Win64.zip` (~9.4 MB) ← **Windows**
- `huc-2026-05-28-Linux.zip`
- `huc-2026-05-28-Darwin.zip`

Direct Windows download:
```
https://github.com/pce-devel/huc/releases/download/current/huc-2026-05-28-Win64.zip
```
Install (headless, scriptable — PowerShell):
```powershell
$zip = "$env:TEMP\huc-win64.zip"
Invoke-WebRequest -Uri "https://github.com/pce-devel/huc/releases/download/current/huc-2026-05-28-Win64.zip" -OutFile $zip
Expand-Archive $zip -DestinationPath "C:\tools\huc" -Force
# zip contains bin\ (huc.exe, pceas.exe, isolink/...) plus include\ libraries.
$env:PATH += ";C:\tools\huc\bin"
$env:PCE_INCLUDE = "C:\tools\huc\include\pce"   # huc finds its libs via include path
```
(If a future "current" build has a newer date, list assets with
`gh release view current --repo pce-devel/huc --json assets`.)

No GUI, no Cygwin/MinGW needed when using the prebuilt Win64 zip. Building the
toolchain from source on Windows is possible via Cygwin but unnecessary for us.

### Build a .pce from C
HuC produces the `.pce` directly (it writes the 8 KB HuCard header and bank
layout for you). Canonical command:
```
huc -O2 game.c
```
→ emits `game.pce` (plus `game.s`, `.sym`, `.lst`). That's it — runs in
mednafen_pce_fast. Common extra flags: `-msmall` (smaller/faster, no recursion),
`-S` to keep asm, `-cd`/`-scd` for CD targets (not needed for HuCard).

### License
HuC is a mixed bag, but **does not affect our game**: PCEAS/MagicKit asm is
stated "freeware… free to distribute, use and modify"; Ulrich Hecht's additions
are 2-clause **BSD**; the test suite/TGEmu are GPL (test infra only, not linked
into ROMs). GitHub reports the repo license as "Other/NOASSERTION". The runtime
library we link is the freeware/BSD HuC lib. Our C source + `.pce` are ours to
license **CC0/MIT**. Recommendation: ship our source CC0/MIT and just credit HuC.

### Can Claude write HuC C? — YES, this is the best LLM path
HuC C is plain small-C with a documented, high-level library (`set_color_rgb`,
`load_default_font`, `put_string`, `spr_*`, `vsync`, `joy()`, `cls`, `disp_on/off`).
An LLM does not touch raw VDC registers for simple games. Known constraints to
respect (from Brandwood's README): no floats, no struct-by-value, no array/
pointer initializers in some forms, fastcall library funcs. Keep generated code
to ints, fixed arrays, simple control flow.

---

## Goal 2 — Assembly toolchains (cc65/ca65 and PCEAS)

The HuC6280 is a **65C02 superset** (extra block-transfer, `ST0/1/2` VDC, speed
opcodes). An LLM with 6502 knowledge has a real head start, but PCE-specific I/O
(VDC/VCE/PSG register banging, MMU bank mapping, HuCard header) is the hard part
and a frequent failure source.

- **cc65 / ca65 / ld65** — full 6502 cross dev suite with an official PCE target.
  License: **zlib** (clean, permissive — easiest license story of all options).
  Docs: https://cc65.github.io/doc/pce.html , https://cc65.github.io/
  - ca65 supports HuC6280 opcodes, so inline asm is fine.
  - Provides `pce.h` (`get_tv()`, `waitvsync()`), `pce.inc` (PSG/VCE/VDC consts),
    a 2-button joystick driver. **Limitations: no C stdio** (`printf`/`fopen`
    unavailable) and only the basic conio/text path is turnkey.
  - **Pitfall — manual header/bank fixup:** ld65 emits a `.bin` whose final 8 KB
    bank is in the wrong place; you must rotate it to the front to get a valid
    `.pce`. POSIX example from the cc65 docs:
    ```
    dd if=conio.bin bs=8K skip=3 > conio.pce
    dd if=conio.bin bs=8K count=3 >> conio.pce
    ```
    On Windows this needs a `dd` port or a tiny script — extra friction vs HuC,
    which never requires this.
- **PCEAS** (bundled in HuC) — for pure-assembly projects; emits `.pce` directly
  with proper header. Good if we want a hand-written asm demo, but more LLM-risky.

**Verdict:** cc65 has the cleanest license (zlib) and is great for asm, but for
*C* it is lower-level, lacks stdio, and needs manual `.pce` post-processing.
For our "small game authored largely by an LLM" goal, HuC's batteries-included
library wins decisively.

---

## Goal 3 — AI-assisted creation

- **No corpus of AI-written PCE games exists.** Searches for ChatGPT/LLM-authored
  PC Engine/HuC games returned nothing real — LLM game-dev results are all modern
  engines/NPCs, not retro homebrew. So Claude must work from HuC's library docs +
  the example projects, not from prior AI-generated PCE code. Plan accordingly.
- **Claude reliability via HuC: good for small scope.** Because HuC abstracts VDC
  setup and HuCard header, the two classic failure modes (VDC/video-chip init,
  malformed header) are handled by the library/compiler, not the model. A
  text/sprite game (move a sprite with the joypad, simple collision, score) is
  well within reach.
- **Failure modes to guard against:**
  - HuC small-C limits: no floats, no struct-by-value, restricted initializers,
    fastcall lib funcs — Claude tends to write modern C that hits these. Mitigate
    with a prompt/style guide pinning it to "HuC small-C, ints + fixed arrays."
  - Forgetting `vsync()` in the loop, or drawing before `disp_on()`.
  - Sprite/tile data (VRAM) management is the genuinely hard part if going past
    the bundled font/`put_string`; keep first content text- or simple-sprite-based.
- **Minimal viable template** (compiles to a valid `.pce` today):
  ```c
  #include "huc.h"

  main() {
      disp_off(); cls(); disp_on();
      set_color_rgb(1, 7, 7, 7);
      set_font_color(1, 0); set_font_pal(0);
      load_default_font();
      put_string("HELLO WEBXR", 8, 12);
      for(;;) { vsync(); }   /* hold frame */
  }
  ```
  Build: `huc -O2 game.c` → `game.pce`. Verified pattern from the
  `pce-hello-world` example (https://github.com/Lochlan/pce-hello-world,
  HuC 3.2.1) and HuC's own `examples/huc/*` (scroll, shmup, sgx, overlay).

---

## Goal 4 — Concrete recommendation

**Author our own game with HuC.**

Realistic CC0/MIT test titles (small enough for LLM-assisted authoring in HuC):
1. **"WebXR Pong / Paddle"** — one paddle vs wall or two-player, ball physics in
   ints, score via `put_string`. Exercises input on both joypads (matches the
   repo's two-hand RetroPad mapping), sprites, collision. ~1 source file.
2. **"Star Catcher"** — player sprite moves with the D-pad, catch falling tiles,
   score + timer. Slightly more sprite/VRAM work; good second milestone.

Recommended title to ship first: **Pong/Paddle** — minimal VRAM, deterministic,
easy to verify in mednafen_pce_fast, and demonstrates input mapping.

### EXACT build pipeline (Windows, headless)
```powershell
# 1. Install toolchain (once)
$zip = "$env:TEMP\huc-win64.zip"
Invoke-WebRequest "https://github.com/pce-devel/huc/releases/download/current/huc-2026-05-28-Win64.zip" -OutFile $zip
Expand-Archive $zip -DestinationPath "C:\tools\huc" -Force
$env:PATH += ";C:\tools\huc\bin"
# (set PCE_INCLUDE to the unzipped include\pce dir if huc can't find huc.h)

# 2. Write game.c (the HuC small-C source — see template above / Goal 3)

# 3. Build
huc -O2 game.c          # -> game.pce  (header + banks written by HuC)

# 4. Verify it loads
#    Drop game.pce into LibretroWebXR with mednafen_pce_fast, or sanity-check
#    in standalone Mednafen / Beetle PCE.
```
Output: a standard `.pce` HuCard that mednafen_pce_fast loads directly.

---

## Goal 5 — Fallback: shippable CC0/PD homebrew (be skeptical)

**Strong caution:** most "PC Engine homebrew" is **commercial or all-rights-
reserved**, not freely licensable. Aetherbyte titles (e.g. *Atlantean*, *Inva-
sion*), Frozen Utopia, and most "PCEdev"/scene games are **commercial** — do NOT
ship them. "Public Domain" ROM dump sites (e.g. planetemu PD section) are
unreliable for license provenance and should not be trusted for CC0 claims.

Genuinely safe-to-ship paths, in order of preference:
1. **Author it ourselves (Goal 4).** Only this guarantees a clean CC0/MIT story.
   Strongly recommended over any found ROM.
2. **HuC's own example projects** (`pce-devel/huc/examples/`): scroll, shmup,
   sgx, overlay, etc. These build to `.pce` and are demos, but their license
   follows the HuC repo ("Other/NOASSERTION") — usable as internal test fixtures/
   tech demos *with attribution*, but **not** something we can relicense CC0.
   Fine as a stopgap "does the pipeline work" ROM, not as a flagship CC0 title.
3. The **PCEdev wiki** (https://pce.nesdev.org/) is itself CC0, a good docs
   source; it is not a game.

No verified third-party CC0/MIT *game* ROM was found that we can confidently
ship. **Recommendation: do not rely on a found ROM — build our own.**

---

## Sources
- HuC forks: https://github.com/uli/huc · https://github.com/ArtemioUrbina/huc ·
  https://github.com/jbrandwood/huc · https://github.com/pce-devel/huc
- HuC Win64 prebuilt (release "current", asset 2026-05-28):
  https://github.com/pce-devel/huc/releases/download/current/huc-2026-05-28-Win64.zip
- HuC hello-world example: https://github.com/Lochlan/pce-hello-world
- cc65 PCE target + license (zlib): https://cc65.github.io/doc/pce.html ·
  https://cc65.github.io/
- HuC6280 / 65C02 asm reference: https://www.chibiakumas.com/6502/pcengine.php
- mednafen_pce_fast extensions (`pce|cue|ccd|chd|toc|m3u`):
  https://github.com/libretro/libretro-core-info/blob/master/mednafen_pce_fast_libretro.info
- PCEdev wiki (CC0 docs): https://pce.nesdev.org/
