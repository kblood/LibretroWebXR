# Creating New Sega Genesis / Mega Drive Games for LibretroWebXR

Research date: 2026-06-01. Target: a small CC0/MIT game **we author**, shipped as a
`.bin`/`.md` ROM that runs on `genesis_plus_gx` (default) and `picodrive`.

**TL;DR:** Use **SGDK** (C, MIT-licensed library) on Windows. It is the most
AI-friendly Genesis path by a wide margin. The toolchain's GPL3 GCC does **not** taint
our output — the game source is ours under CC0/MIT. Ready-made CC0/MIT Genesis ROMs are
essentially unavailable for reliable shipping, so authoring our own is both the cleanest
license story and the most reliable path.

---

## Goal 1 — C toolchain: SGDK (RECOMMENDED)

**SGDK** ("Sega Genesis Development Kit", by Stephane Dallongeville) is the dominant modern
Genesis SDK. C language, m68k GCC backend, with a resource compiler (`rescomp`) for
sprites/tiles/audio.

- Repo: https://github.com/Stephane-D/SGDK
- Releases: https://github.com/Stephane-D/SGDK/releases
- Latest: **SGDK 2.11 (April 2025)**; bundles **GCC 13.2** (m68k-elf) prebuilt for Windows.
- Docs (Doxygen): https://stephane-d.github.io/SGDK/
- Install wiki: https://github.com/Stephane-D/SGDK/wiki/SGDK-Installation
- Usage wiki: https://github.com/Stephane-D/SGDK/wiki/SGDK-Usage

### License (verified)
- **SGDK library + custom tools (incl. rescomp): MIT.**
- GCC / libgcc: GPL3, but emitted code falls under the **GCC Runtime Library Exception** —
  binaries you compile are **not** GPL-encumbered. **Our game stays CC0/MIT.** Confirmed in
  the SGDK readme.

### Windows install (Windows-first; prebuilt binaries provided)
1. Install **Java >= 8** (64-bit) — required only by `rescomp` (the resource compiler).
2. Download the latest SGDK release archive, unzip to e.g. `C:\SGDK` (the `<SGDK_PATH>`).
3. (Optional but conventional) set an env var so scripts are portable:
   - `GDK` = `C:\SGDK`  (some docs/templates use `GDK_WIN`; set both to be safe).
4. Verify the toolchain by building the library:
   ```
   C:\SGDK\bin\make -f C:\SGDK\makelib.gen
   ```
   Success produces `C:\SGDK\lib\libmd.a`. (Recent releases ship `libmd.a` prebuilt, so this
   step may already be satisfied.)

### Project layout (what the makefile expects)
```
myproject/
  src/   *.c, *.s        (C and asm source; main.c lives here)
  inc/   *.h, *.inc      (headers)
  res/   *.res           (resource definitions compiled by rescomp)
  out/   (auto-created)  -> out/rom.bin  AND out/rom.out (elf+symbols)
```
- `src/boot/` is auto-generated and contains `sega.s` (boot) and **`rom_head.c`** (the ROM
  header as a C struct — editable: title, region, ROM size, SRAM flags).

### Build a ROM (headless / scriptable — no GUI needed)
From inside the project directory:
```
C:\SGDK\bin\make -f C:\SGDK\makefile.gen
```
- Output: **`out\rom.bin`** — this is the shippable Genesis ROM (rename to `.md`/`.gen` if
  desired; identical bytes). `genesis_plus_gx` accepts `bin`/`md`/`gen`/`smd`.
- Profiles: append `debug` (symbols + Gens KMod logging) or `asm` (listings); default is
  optimized `release`.
- Fully CLI-driven → an AI agent can build with one command. Wrap in a `build.bat`:
  ```bat
  @echo off
  %GDK_WIN%\bin\make -f %GDK_WIN%\makefile.gen
  ```

### rescomp + sprite/tile workflow
- Resources are declared in a `.res` text file in `res/`, compiled by `rescomp` (Java) into
  C symbols you `#include` and reference.
- Common directives:
  - `SPRITE name "img.png" w h <compression> <time> ...` — sprite sheets (w/h in **tiles**, 8px each).
  - `IMAGE name "bg.png" <compression>` — backgrounds/tilemaps.
  - `PALETTE name "pal.png"` — 16-color palettes (Genesis = 4 palettes x 16 colors, color 0 transparent).
  - `TILESET`, `MAP`, `XGM`/`WAV` (audio), `BIN` (raw data).
- PNG input is the practical route (indexed/paletted PNG, <=16 colors per palette). rescomp
  handles tile dedup + compression. Resource ref: rescomp.txt in repo; supported types listed
  at https://stephane-d.github.io/SGDK/md__s_g_d_k_2bin_2rescomp.html

### How well can Claude write SGDK C?
**Strong.** It's plain C against a documented library with high-level helpers
(`VDP_*`, `SPR_*`, `JOY_*`, `SYS_doVBlankProcess`, `PAL_*`). The library hides the gnarly
hardware bits (VDP register init, DMA, sprite attribute table layout, vertical-blank timing),
which is exactly where hand-rolled asm goes wrong. See Goal 3 for the minimal template.

---

## Goal 2 — Assembly toolchains (fallback / advanced only)

Pure m68k asm produces the same `.bin` but is far harder for an LLM (and humans). Listed for
completeness; **not recommended** vs SGDK.

| Tool | Notes | License | Get it |
|------|-------|---------|--------|
| **vasm** (`vasmm68k_mot`) | Clean Motorola syntax; direct binary out: `vasmm68k_mot -Fbin -o rom.bin main.asm`. Builds easily on Windows. | Free (custom permissive license; free for any use) | http://sun.hasenbraten.de/vasm/ |
| **asmx** | Multi-CPU; only the **2.0 beta 5** line emits end-to-end binary. | Free / public-domain-ish | http://xi6.com/projects/asmx/ |
| **asm68k** (Sega's original) | Used by Sonic disassembly community; 64-bit Win build via Sonic Retro archive. | Proprietary freeware (murky) — **avoid** for a clean license story. | Sonic Retro archive |

Key references:
- Plutiedev (excellent asm + hardware docs, incl. ROM header): https://plutiedev.com/rom-header
- Bumbershoot platform guide: https://bumbershootsoft.wordpress.com/platform-guide-sega-genesis-mega-drive/
- Martin Atkins "Hello, Sega Genesis" (vasm walkthrough): https://log.martinatkins.me/2020/01/20/hello-sega-genesis/
- jamesseanwright/68k-mega-drive: https://github.com/jamesseanwright/68k-mega-drive

**Asm failure modes for an LLM:** VDP register initialization sequence, sprite attribute
table (SAT) layout in VRAM, DMA setup, vblank-synchronized writes, TMSS/region handling, and
the 256-byte ROM header layout. SGDK handles all of these for you.

---

## Goal 3 — AI-assisted creation

**Verdict: Claude can reliably produce a playable `.md` via SGDK C.** It's the realistic
sweet spot: real C + a real library + a one-command headless build.

### Evidence of AI-built Genesis content
- A Claude-assisted **Text Elite** port to Genesis exists (surfaced in the SGDK GitHub topic).
- **genteel** — an MIT-licensed, Rust Genesis emulator *designed for AI-driven automated
  testing*: JSON state serialization (registers/memory/bus via serde), input-injection API,
  deterministic stepping, headless CI with 3000+ M68k tests, and an `AGENTS.md`.
  https://github.com/segin/genteel — useful for **automated verification** of our generated ROMs.

### Minimal SGDK template (what Claude generates)
`src/main.c`:
```c
#include <genesis.h>

int main(bool hard) {
    VDP_drawText("Hello, Genesis!", 12, 13);
    while (TRUE) {
        u16 j = JOY_readJoypad(JOY_1);
        // ... game logic ...
        SPR_update();
        SYS_doVBlankProcess();   // syncs to vblank; required each frame
    }
    return 0;
}
```
Add sprites via a `res/sprites.res` line like `SPRITE player "player.png" 2 2 NONE 0`, then
`SPR_addSprite(&player, x, y, ...)` after `SPR_init()`. Build with the make command from
Goal 1.

### Failure modes (and why SGDK neutralizes them)
- **VDP setup** — handled by SGDK init; don't touch raw registers.
- **Sprite tables** — use `SPR_*` engine; never write the SAT by hand.
- **ROM header** — `src/boot/rom_head.c` is auto-generated; only edit the title/struct fields.
- **Checksum** — Genesis hardware does NOT verify it; emulators only *warn*.
  `genesis_plus_gx` runs the ROM regardless. (If a clean log is wanted, a checksum fixer can
  patch the header word — sum of 16-bit words from `$000200` to end — but it is not required.)
- Practical LLM gotchas: forgetting `SYS_doVBlankProcess()` (causes tearing/no input latency),
  exceeding 16 colors per palette in a PNG (rescomp errors), and oversized DMA per frame.

---

## Goal 4 — Concrete recommendation

**Pipeline: SGDK 2.11 (C) -> `make -f makefile.gen` -> `out/rom.bin` -> ship as `.md`.**
License every game's source as **CC0 or MIT** (our choice; SGDK's MIT permits it).

### Exact end-to-end build pipeline
```bat
:: One-time setup
::  1. Install Java 8+ (64-bit)
::  2. Unzip SGDK 2.11 to C:\SGDK
set GDK=C:\SGDK
set GDK_WIN=C:\SGDK
C:\SGDK\bin\make -f C:\SGDK\makelib.gen   :: verify -> C:\SGDK\lib\libmd.a

:: Per project (run from the project root containing src\ res\ inc\)
C:\SGDK\bin\make -f C:\SGDK\makefile.gen  :: -> out\rom.bin

:: Ship
copy out\rom.bin content\genesis\<game>.md
```
Then load `<game>.md` in LibretroWebXR (genesis_plus_gx). No GUI step anywhere.

### Three realistic CC0 test games (in build-difficulty order)
1. **Sprite-mover / "Hello sprite"** — D-pad moves one sprite on a tiled background.
   Smallest possible win; exercises `SPR_*`, `JOY_*`, palettes, vblank. ~80 lines C +
   1 PNG. Best first deliverable.
2. **Maze / collect-the-dots** — tilemap background, sprite player, AABB collision vs a
   tile grid, a score via `VDP_drawText`. Exercises `IMAGE`/`MAP` resources. ~200-300 lines.
3. **Minimal vertical shmup** — scrolling starfield, player ship, bullets (sprite pool),
   one enemy type, collision, score. Exercises sprite recycling + scrolling. The most
   "game-like" but still well within Claude's reach; ~400-600 lines.

Recommended **first** ship: **#1 sprite-mover**, then **#2 maze**. Keep #3 as a stretch.

---

## Goal 5 — Fallback: shipping existing permissive homebrew

**Be skeptical here — clean CC0/MIT Genesis ROMs are rare and licenses are often vague.**

- **Old Towers** (RetroSouls): **CC BY-NC-SA 4.0** — **NON-commercial only**. Built with SGDK.
  **FLAG: do NOT ship** if LibretroWebXR is/ may be used commercially or sublicensed; the NC +
  ShareAlike terms are incompatible with a clean CC0/MIT-only project. Source:
  https://retrosouls.itch.io/old-towers
- **retrobrews/md-games** (https://github.com/retrobrews/md-games): a collection, but **no
  repo-wide license**; explicit disclaimer "approved for free distribution on this site/project
  only — contact owner to share." That is **not** a redistributable open license. Avoid.
- Zophar's "public domain" Genesis list (https://www.zophar.net/pdroms/genesis.html): mixed,
  largely **unverifiable** provenance/licenses. Avoid for a project that wants a clean story.
- Curated lists worth scanning if needed (still must verify each game's LICENSE file):
  - https://github.com/And-0/awesome-megadrive
  - https://github.com/DogedomStudioS/awesome-genesis-mega-drive

**Conclusion on fallback:** No reliably CC0/MIT, redistributable, ready-made Genesis ROM was
found that meets the project's clean-license bar. This **reinforces authoring our own** with
SGDK — it is the only path with a guaranteed CC0/MIT result.

---

## Key URLs (quick reference)
- SGDK repo / releases / wiki:
  https://github.com/Stephane-D/SGDK ·
  https://github.com/Stephane-D/SGDK/releases ·
  https://github.com/Stephane-D/SGDK/wiki/SGDK-Installation ·
  https://github.com/Stephane-D/SGDK/wiki/SGDK-Usage
- rescomp docs: https://stephane-d.github.io/SGDK/md__s_g_d_k_2bin_2rescomp.html
- vasm: http://sun.hasenbraten.de/vasm/
- Plutiedev (hardware/header): https://plutiedev.com/rom-header
- genteel (AI test emulator, MIT): https://github.com/segin/genteel
