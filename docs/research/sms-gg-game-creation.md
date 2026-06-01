# Creating New Sega Master System / Game Gear Games for LibretroWebXR

Research date: 2026-06-01

> **VERIFIED 2026-06-01:** This recipe was used end-to-end to build the CC0
> `games/sms-arcade/` ("LWX Catch") game into both
> `public/roms/freeware/lwx-sms-arcade.sms` and `lwx-gg-arcade.gg` (each 32 KB,
> valid `TMR SEGA` header + checksum). The exact install URLs, build commands,
> and the one real gotcha (SDCC-version / `--sdcccall` ABI mismatch with the
> *prebuilt* SMSlib libs) are recorded in **"VERIFIED working setup"** at the end
> of this doc. Build with `node scripts/make-sms-arcade.mjs`.

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

## VERIFIED working setup (2026-06-01) — exact URLs, commands, gotchas

This is what actually built `games/sms-arcade` into a working `.sms` + `.gg`.

### Install (zip-only, no interactive installer)

**SDCC** — the win64 *setup.exe* installers (under `sdcc-win64/`) are the only
thing in the per-version folders, but a **portable zip** lives under the
snapshot-builds tree. Used SDCC **4.6.0 #16555**:

```
# portable zip (no installer; just unzip):
https://sourceforge.net/projects/sdcc/files/snapshot_builds/x86_64-w64-mingw32/sdcc-snapshot-x86_64-w64-mingw32-20260601-16555.zip/download
```
The zip extracts to a top-level `sdcc/` folder. Place it so `sdcc.exe` is at
`C:\sdcc\bin\sdcc.exe` (the snapshot dir is regenerated daily — if that dated
filename 404s, pick the newest `sdcc-snapshot-x86_64-w64-mingw32-YYYYMMDD-*.zip`
in that same folder). `sdar.exe` and `sdasz80.exe` are in the same `bin`.
Verify: `C:\sdcc\bin\sdcc.exe -v` → `... 4.6.0 #16555 (MINGW64)`.

**devkitSMS** — the GitHub *releases* have **no binary assets** and the latest
tag ("for SDCC 4.1.x") is stale; the prebuilt Windows tools + libs live in the
repo tree itself. Clone master:
```
git clone --depth 1 https://github.com/sverx/devkitSMS.git   # -> C:\devkitSMS
```
Key paths used:
- `C:\devkitSMS\ihx2sms\Windows\ihx2sms.exe`  (ROM packer; also `makesms\Windows\makesms.exe`, `folder2c\Windows\folder2c.exe`)
- `C:\devkitSMS\crt0\crt0_sms.rel`
- `C:\devkitSMS\SMSlib\SMSlib.lib`, `SMSlib_GG.lib`, and headers in `SMSlib\src\`
- `C:\devkitSMS\SMSlib\src\peep-rules.txt`

### GOTCHA #1 (the big one): prebuilt SMSlib libs vs SDCC 4.6 `--sdcccall`

The libs shipped in the devkitSMS repo were built with an **older SDCC whose
default calling convention was `--sdcccall 0`**. SDCC **4.4+ defaults to
`--sdcccall 1`**. Linking 4.6-compiled `main.rel` against the prebuilt
`SMSlib.lib` makes the linker (`sdldz80`) **fail** with a wall of
`?ASlink-Warning-Conflicting sdcc options: "...sdcccall(1)" in module "main" and
"-mz80" in module "SMSlib..."`. Worse, even forcing `main.c` to
`--sdcccall 0` only moves the conflict to SDCC's own stdlib `divunsigned`
(`/` and `%` helpers are sdcccall-1 in 4.6) — an ABI mismatch that would silently
corrupt integer math.

**Fix that works: rebuild SMSlib from source with the same SDCC 4.6**, so every
module + the stdlib agree on sdcccall 1. Use the shipped recipe
`SMSlib\src\how to build this.txt` (the authoritative `.bat`; the sibling
`Makefile` has a typo referencing `SMSlib_metasprite.rel` as a source). In
`SMSlib\src\`, compile each module with
`C:\sdcc\bin\sdcc.exe -c -mz80 --max-allocs-per-node 100000 --peep-file peep-rules.txt <file>.c`
(the core `SMSlib.c` adds `--reserve-regs-iy`; build a second `SMSlib_GG.rel` and
the `*_GG` palette/autotext/spriteClip variants with an extra `-DTARGET_GG`;
zx7/aPLib/paddle/debug compile *without* `--peep-file`), then archive with
`C:\sdcc\bin\sdar.exe r SMSlib.lib <all SMS .rel...>` and
`sdar r SMSlib_GG.lib <all GG .rel...>` exactly per that file's two `sdar` lines.
Copy the resulting `SMSlib.lib` / `SMSlib_GG.lib` up into `C:\devkitSMS\SMSlib\`.
Also re-assemble `crt0_sms.rel` with the matching assembler
(`C:\sdcc\bin\sdasz80.exe -g -o crt0_sms.s`) for good measure (asm carries no
sdcccall, so this is belt-and-suspenders). After rebuilding, the link is clean.

### GOTCHA #2: the GG build needs `-DTARGET_GG` at *compile* time

`SMSlib.h` is `#ifdef TARGET_GG` throughout: it omits the SMS `TMR SEGA` header
placement, switches the palette macros to the GG 12-bit format, and exposes
`GG_setBGPaletteColor`/`GG_loadBGPalette` (the SMS names don't exist in GG mode).
So a single `main.c` must be **compiled twice** — plain for SMS, with
`-DTARGET_GG` for GG — and use `#ifdef TARGET_GG` around the palette call. ihx2sms
then writes the right region byte automatically: **0x4C** (SMS Export) vs **0x7C**
(GG International), confirmed in the built ROMs at offset 0x7FFF.

### GOTCHA #3: no number printer in SMSlib

This SMSlib build has `SMS_print(const unsigned char *)` for strings but **no**
`SMS_printNumber`/printf-style decimal helper. Roll a tiny fixed-width
uint→string formatter for score/HUD (see `games/sms-arcade/main.c`). The
`warning 336: incomplete array type` from `SMSlib.h:96` during compile is benign
(it fires in the official examples too).

### Exact build commands used (per target; see scripts/make-sms-arcade.mjs)

```bat
:: --- Master System ---
C:\sdcc\bin\sdcc.exe -mz80 -IC:\devkitSMS\SMSlib\src --peep-file C:\devkitSMS\SMSlib\src\peep-rules.txt -c main.c -o main_sms.rel
C:\sdcc\bin\sdcc.exe -o game_sms.ihx -mz80 --no-std-crt0 --data-loc 0xC000 C:\devkitSMS\crt0\crt0_sms.rel C:\devkitSMS\SMSlib\SMSlib.lib main_sms.rel
C:\devkitSMS\ihx2sms\Windows\ihx2sms.exe game_sms.ihx lwx-sms-arcade.sms

:: --- Game Gear (same main.c, add -DTARGET_GG, link the GG lib) ---
C:\sdcc\bin\sdcc.exe -mz80 -IC:\devkitSMS\SMSlib\src --peep-file C:\devkitSMS\SMSlib\src\peep-rules.txt -DTARGET_GG -c main.c -o main_gg.rel
C:\sdcc\bin\sdcc.exe -o game_gg.ihx -mz80 --no-std-crt0 --data-loc 0xC000 C:\devkitSMS\crt0\crt0_sms.rel C:\devkitSMS\SMSlib\SMSlib_GG.lib main_gg.rel
C:\devkitSMS\ihx2sms\Windows\ihx2sms.exe game_gg.ihx lwx-gg-arcade.gg
```
Both outputs: 32768 bytes, `TMR SEGA` @ 0x7FF0, valid checksum @ 0x7FFA.

### Cores

Manifest pins **gearsystem** for both ROMs (it is SMS/GG-specific and the most
reliable renderer for plain tilemap homebrew). **picodrive** (the system default)
also lists `.sms`/`.gg` support and should run them; if picodrive shows issues,
gearsystem is the safe choice. (In-app render verification is done by the
orchestrator, not this build step.)

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
