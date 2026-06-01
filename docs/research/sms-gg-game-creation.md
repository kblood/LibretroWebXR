# Creating New Sega Master System / Game Gear Games for LibretroWebXR

Research date: 2026-06-01

**Goal:** author small, original CC0/MIT games we own, shippable as `.sms` (Master System)
and `.gg` (Game Gear) test content. Targets the libretro cores LibretroWebXR uses:
**picodrive** (default) and **gearsystem**. SMS and GG share nearly identical hardware
(Zilog Z80 CPU + Sega VDP + SN76489 PSG), so a single C codebase covers both; the GG just
has a smaller visible window and a slightly different ROM header/palette format.

**License framing (important):** A toolchain's license does **not** taint the games you
author with it. SDCC is GPL but it is a *compiler* — its output is your code. devkitSMS's
runtime libraries (SMSlib, PSGlib, the conversion tools) are **public domain (Unlicense)**,
so nothing they contribute forces a license on your ROM. We can therefore release our own
games as **CC0 or MIT** freely. (One caveat tracked below: ZX7/aPLib decompression routines
bundled in SMSlib carry attribution notes — trivially avoidable by not using compression.)

Core file-extension support (verified from libretro-core-info):
- **picodrive**: `bin|gen|smd|md|32x|cue|iso|chd|sms|gg|sg|sc|m3u|...` — runs `.sms`, `.gg`, `.sg`.
- **gearsystem**: `sms|gg|sg|bin|rom` — runs `.sms`, `.gg`, `.sg`.

Both cores run standard `.sms`/`.gg` ROMs, so our output is directly compatible.

---

## Goal 1 — C toolchain: devkitSMS (RECOMMENDED, best AI-friendly path)

**What it is:** `sverx/devkitSMS` — a development kit + libraries for SMS / Game Gear /
SG-1000 / SC-3000 / ColecoVision homebrew in **C**, built on the **SDCC** Z80 compiler.
Repo: https://github.com/sverx/devkitSMS  (wiki: https://github.com/sverx/devkitSMS/wiki)

**Components:**
- **SMSlib** — high-level wrapper hiding VDP/PSG/controller internals (tiles, tilemap,
  sprites, palette, text renderer, pad reading, VBlank wait). `SMSlib.lib` for SMS,
  `SMSlib_GG.lib` for Game Gear. Same API; GG variant handles GG palette + header.
- **PSGlib** — SN76489 PSG music + SFX player (uses a PSG VGM-derived format).
- **crt0_sms.rel** — C runtime startup object (links before your code).
- **ihx2sms / makesms** — converts SDCC's `.ihx` (Intel HEX) into a padded `.sms`/`.gg`
  ROM, sized to a 16 KiB multiple, and computes the Sega checksum.
- **folder2c** — turns a folder of binary assets into a `.c`/`.h` with size defines.
- **assets2banks** — packs assets into ROM banks (for >48 KiB games / banked code).

**License:** SMSlib, PSGlib, ihx2sms, folder2c, assets2banks are **public domain
(Unlicense, http://unlicense.org)**. `crt0` files are GPL-2 *with a linking exception* (the
standard libgcc-style exception so linking them does not impose GPL on your program).
Net result: **our games can ship CC0 or MIT.** Caveat: SMSlib bundles ZX7 and aPLib
decompression routines whose licenses request attribution — if we avoid SMSlib's
`*_decompress` functions (don't compress assets), there is nothing to attribute.

**Windows install (headless / scriptable):**
1. Install SDCC **4.2.0 or newer** (devkitSMS requires >=4.2.0; current 4.4/4.5 fine).
   Installer: https://sourceforge.net/projects/sdcc/files/sdcc-win64/4.2.0/sdcc-4.2.0-x64-setup.exe/download
   (browse newer: https://sourceforge.net/projects/sdcc/files/sdcc-win64/ )
   Default install `C:\Program Files\SDCC`; add `C:\Program Files\SDCC\bin` to PATH.
   Verify: `sdcc -v`.
   > NOTE: an old (2017) tutorial referencing SDCC 3.6 is outdated — use 4.2.0+.
2. Clone devkitSMS: `git clone https://github.com/sverx/devkitSMS`.
3. Copy `ihx2sms.exe` (or `makesms.exe`), `assets2banks.exe`, `folder2c.exe` into the
   SDCC `bin` folder (so they are on PATH).
4. For each project, copy into the project dir: `crt0_sms.rel`, `SMSlib.h`, and
   `SMSlib.lib` (SMS) and/or `SMSlib_GG.lib` (GG). (Prebuilt libs are in the repo; they
   can also be rebuilt with the included build scripts.)

**Build pipeline — Master System (`.sms`):**
```bat
sdcc -c -mz80 main.c
sdcc -o game.ihx -mz80 --no-std-crt0 --data-loc 0xC000 crt0_sms.rel main.rel SMSlib.lib
ihx2sms game.ihx game.sms
```
- `--data-loc 0xC000` places C variables in SMS work RAM (RAM is at 0xC000–0xDFFF).
- `--no-std-crt0` + explicit `crt0_sms.rel` substitutes the SMS startup for SDCC's default.
- `ihx2sms` pads to a 16 KiB multiple and writes the Sega header checksum.

**Build pipeline — Game Gear (`.gg`):** identical commands, **swap the library** and output
extension:
```bat
sdcc -c -mz80 main.c
sdcc -o game.ihx -mz80 --no-std-crt0 --data-loc 0xC000 crt0_sms.rel main.rel SMSlib_GG.lib
ihx2sms game.ihx game.gg
```
A single `main.c` builds both targets — only the linked lib and output name change. Build
both in one script to ship `.sms` + `.gg` from one source.

**Minimal working program (from the official `hello_sms` example):**
```c
#include "SMSlib.h"

void main(void) {
  SMS_VRAMmemsetW(0x0000, 0x0000, 16384);   /* clear VRAM */
  SMS_autoSetUpTextRenderer();              /* load font tiles 0-95, B/W palette, display on */
  SMS_setNextTileatXY(3, 10);
  SMS_print("Hello, LibretroWebXR!");
  for(;;) { }                               /* idle */
}

SMS_EMBED_SEGA_ROM_HEADER(9999, 0);                                   /* product code, region */
SMS_EMBED_SDSC_HEADER_AUTO_DATE(1, 0, "author", "title", "notes");    /* version, metadata */
```
Key SMSlib calls a typical game uses: `SMS_init()`/auto-setup, `SMS_loadTiles`,
`SMS_loadTileMap`, `SMS_loadSpritePalette`/`SMS_loadBGPalette`, `SMS_initSprites` +
`SMS_addSprite` + `SMS_finalizeSprites`, `SMS_getKeysStatus()` (read RetroPad/D-pad +
buttons 1/2), `SMS_waitForVBlank()`, `SMS_displayOn()`.

**Claude's ability to write devkitSMS C:** Strong. This is plain C with a small,
well-documented API and no manual VDP register poking required. The fixed
init → load tiles/palette → game loop (read pad, update sprites, wait VBlank) structure is
very LLM-friendly. This is the recommended path for AI-authored test games.

---

## Goal 2 — Assembly toolchain: WLA-DX (classic, lower-level)

**What it is:** `vhelin/wla-dx` (Ville Helin) — a multi-CPU cross-assembler; **wla-z80** +
**wlalink** are the classic SMS/GG assembly path used across SMS Power! tutorials.
- Repo: https://github.com/vhelin/wla-dx
- Docs: https://wla-dx.readthedocs.io/  · SMS Power! guide: https://www.smspower.org/Development/WLA-DX
  (smspower.org may 403 to automated fetches; open in a browser.)

**License:** **GPL-2.0-or-later** — but again it is an *assembler*; your assembled game is
yours and can be CC0/MIT.

**Windows build (CMake):**
```bat
git clone https://github.com/vhelin/wla-dx
cd wla-dx
mkdir build & cd build
cmake ..
cmake --build . --config Release
cmake -P cmake_install.cmake   :: optional install
```
Produces `wla-z80`, `wlalink` (and `wlab`). Put `wla-z80` and `wlalink` on PATH.

**Build a `.sms`:**
```bat
wla-z80 -o game.o game.s
wlalink linkfile game.sms
```
SMS/GG-relevant directives in the source/linkfile:
- `.MEMORYMAP` / `.ROMBANKMAP` — declare ROM layout (needed for >48 KiB / banking).
- `.SMSTAG` — inserts a valid SMS ROM header.
- `.SDSCTAG` — embeds author/title/version metadata (and prompts a valid header).
- `.COMPUTESMSCHECKSUM` — writes the correct header checksum.

**LLM feasibility:** Workable but noticeably harder than C. Z80 asm correctness (register
allocation, banking, manual VDP register writes) is more error-prone for an LLM and harder
to debug headlessly. Use only if we want tiny hand-tuned ROMs; otherwise prefer devkitSMS.

There is also `lajohnston/smslib` (https://github.com/lajohnston/smslib) — Z80 *assembly*
macro libraries for SMS built on WLA-DX (distinct from devkitSMS's C SMSlib).

---

## Goal 3 — High-level / BASIC options

There is **no mainstream, maintained BASIC** that compiles to `.sms`/`.gg` ROMs. The
practical "high-level" tier is **C**, via two options:
- **devkitSMS + SDCC** (Goal 1) — recommended.
- **z88dk** (https://github.com/z88dk/z88dk) — a Z80 C cross-compiler + assembler + libs
  with an **`sms` target** and SMS examples (e.g. `examples/sms/3dcity`). Viable
  alternative C path; broader/older toolchain, but devkitSMS's SMS-specific libraries and
  docs make it the cleaner choice for this platform.

**SMS Power!** (https://www.smspower.org/) is the central resource hub: development docs,
hardware/VDP references, "Getting Started" (https://www.smspower.org/Development/GettingStarted),
Maxim's "How To Program" tutorials, and annual coding competitions
(https://www.smspower.org/Competitions/Index).

---

## Goal 4 — AI-assisted creation: feasibility, template, failure modes

**Verdict:** **Reliable** for small games via **devkitSMS C**. No existing public "SMS game
generator" skill was found, but Claude can author SMSlib C directly. The API abstracts the
hard parts (VDP register sequencing, header/checksum), which removes the most common
homebrew bugs.

**Minimal AI template / path:**
1. One `main.c` using SMSlib: header macros + `main()` with init, asset load, and a
   `while(1){ SMS_waitForVBlank(); read pad; update; }` loop.
2. Assets as C arrays (hand-written small tile/palette arrays, or `folder2c` output).
3. Build with the 3-command pipeline above for `.sms`, repeat with `SMSlib_GG.lib` for `.gg`.
4. Test headlessly in picodrive/gearsystem (RetroArch CLI) or our WebXR frontend.

**Failure modes to guard against:**
- **VDP / display order:** load tiles+palette+tilemap *before* `SMS_displayOn()`; do VRAM
  writes during VBlank or before display-on to avoid corruption. Always
  `SMS_waitForVBlank()` once per frame.
- **ROM header / region:** *must* include `SMS_EMBED_SEGA_ROM_HEADER(...)`. Use `ihx2sms`
  to fix size + checksum — a wrong/missing checksum can fail on real hardware and some
  emulators (picodrive/gearsystem are generally lenient, but always emit the header).
- **GG vs SMS differences:**
  - Visible screen is **160×144** (GG) vs **256×192** (SMS). The VDP still renders a full
    plane; the GG only shows the centered window. Keep gameplay/UI inside the central
    ~160×144 region so the same `main.c` looks correct on both — or define GG-specific
    layout via `#ifdef`.
  - GG uses a **12-bit (4-bit-per-channel) palette** vs SMS's 6-bit; the GG SMSlib build /
    palette-load functions handle the format. Link the correct lib per target.
  - Different header location/format — handled automatically by building with
    `SMSlib_GG.lib` + `ihx2sms ... .gg`.
- **RAM placement:** keep `--data-loc 0xC000`; misplacing data corrupts the stack.
- **SDCC version:** <4.2.0 will fail/misbehave with current devkitSMS (esp. banked code).

---

## Goal 5 — Concrete recommendation + exact pipeline

**Toolchain:** **devkitSMS + SDCC** (Goal 1). C, public-domain libraries, identical source
for SMS and GG, picodrive/gearsystem-compatible, and the most reliable target for
AI-authored code.

**Recommended test games (author ourselves, release CC0 or MIT):**
1. **"Hello" / splash + input demo** — text + a movable sprite read from the D-pad. Smallest
   possible, proves the full pipeline and input mapping in LibretroWebXR.
2. **A one-screen arcade game — e.g. a Snake or a Pong/Breakout clone.** Single screen
   (no scrolling/banking), tile background, a few sprites, PSGlib beeps, simple collision.
   Realistic for an LLM to write correctly and small enough to ship `.sms` **and** `.gg`.

**Exact pipeline (Windows, end to end):**
```bat
:: 1. Install SDCC 4.2.0+ and add C:\Program Files\SDCC\bin to PATH
:: 2. git clone https://github.com/sverx/devkitSMS
:: 3. Copy ihx2sms.exe, assets2banks.exe, folder2c.exe into C:\Program Files\SDCC\bin
:: 4. Into the project dir, copy: crt0_sms.rel, SMSlib.h, SMSlib.lib, SMSlib_GG.lib

:: --- Master System ---
sdcc -c -mz80 main.c
sdcc -o game.ihx -mz80 --no-std-crt0 --data-loc 0xC000 crt0_sms.rel main.rel SMSlib.lib
ihx2sms game.ihx game.sms

:: --- Game Gear (same main.c) ---
sdcc -c -mz80 main.c
sdcc -o game_gg.ihx -mz80 --no-std-crt0 --data-loc 0xC000 crt0_sms.rel main.rel SMSlib_GG.lib
ihx2sms game_gg.ihx game.gg
```
`.sms`→`.gg` differences: link `SMSlib_GG.lib` instead of `SMSlib.lib`, output `.gg`, and
keep visible content within the central 160×144 window. Everything else is identical.

---

## Goal 6 — Fallback: genuinely CC0/PD homebrew we could ship

Be skeptical here — most SMS homebrew is **NOT** open-licensed even when freely downloadable.

- **`retrobrews/sms-games`** (https://github.com/retrobrews/sms-games) — a collection of
  prebuilt homebrew `.sms` ROMs. **Do NOT treat as CC0.** Its README states ROMs are
  "approved for free distribution on this site/project only; if you want to share it, please
  contact owner/developer." That is permission-for-that-project, not an open license, and
  authors vary (Furrtek, Haroldo Pinheiro, etc.). Not safe to redistribute in LibretroWebXR
  without per-author permission.
- **SMS Power! Homebrew / Competitions** (https://www.smspower.org/Homebrew/Index,
  https://www.smspower.org/Competitions/Index) — many entries are freeware but licenses are
  per-author and frequently unspecified or "freeware," **not** CC0. Some (e.g. certain
  entries) are GPL-2 — usable but copyleft, not CC0/MIT. Each title must be license-verified
  individually; assume "all rights reserved" unless the author states otherwise.

**Conclusion on fallback:** No reliably CC0/PD ready-made SMS/GG game was confirmed.
**Authoring our own with devkitSMS is both the safest licensing path and the lowest effort
for guaranteed CC0/MIT test content.** Treat third-party homebrew as opt-in extras only
after explicit per-title license confirmation from the author.

---

## Source URLs
- devkitSMS: https://github.com/sverx/devkitSMS · wiki https://github.com/sverx/devkitSMS/wiki
- devkitSMS README (build): https://github.com/sverx/devkitSMS/blob/master/README.md
- devkitSMS LICENSES: https://github.com/sverx/devkitSMS/blob/master/LICENSES.txt
- hello_sms example: https://github.com/sverx/devkitSMS/blob/master/examples/hello_sms/main.c
- SMSlib README: https://github.com/sverx/devkitSMS/blob/master/SMSlib/README.md
- SDCC downloads: https://sourceforge.net/projects/sdcc/files/sdcc-win64/
- WLA-DX: https://github.com/vhelin/wla-dx · docs https://wla-dx.readthedocs.io/
- WLA-DX SMS guide: https://www.smspower.org/Development/WLA-DX
- lajohnston/smslib (asm): https://github.com/lajohnston/smslib
- z88dk: https://github.com/z88dk/z88dk
- SMS Power!: https://www.smspower.org/ · Getting Started https://www.smspower.org/Development/GettingStarted
- retrobrews/sms-games: https://github.com/retrobrews/sms-games
- libretro picodrive: https://docs.libretro.com/library/picodrive/
- libretro gearsystem: https://docs.libretro.com/library/gearsystem/
