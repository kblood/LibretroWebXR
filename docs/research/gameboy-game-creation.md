# Creating Game Boy / Game Boy Color Games for LibretroWebXR

Research date: 2026-06-01. Target runtime: libretro **gambatte** core. Output: standard
`.gb` (Game Boy / DMG) and `.gbc` (Game Boy Color / CGB) ROMs, ROM-only or MBC1.
All ships under CC0 or MIT, authored by us. Toolchain license does NOT taint the ROM
(verified per toolchain below).

---

## Goal 1 — C toolchain: GBDK-2020 (RECOMMENDED, easiest AI-friendly path)

**What it is:** Modern, actively maintained fork of the classic Game Boy Developers Kit.
A C compiler (patched SDCC), assembler, linker, and runtime libraries. Front-end driver is
`lcc` which orchestrates the whole pipeline based on file extensions.

- Repo: https://github.com/gbdk-2020/gbdk-2020
- Site/docs: http://gbdk.org/  — docs: http://gbdk.org/docs/api/docs_getting_started.html
- **Latest release: v4.5.0 (2025-12-28).** Prebuilt Windows zip on the Releases page.
- Targets: Game Boy / Game Boy Color (also Analogue Pocket, SMS/GG, NES, Mega Duck).

### License (important for shipping)
- Core library + makefiles: **GPLv2 with a Linking Exception (GPLv2+LE)** (inherited from
  SDCC / historical GBDK).
- The linking exception means: **the compiled ROM carries NO GPL obligations** — "no
  requirement to include or credit any GBDK-2020 licenses or authors" in distributed game
  binaries. So our CC0/MIT game ROM is clean.
- One caveat: if you use the optional **zx0 decompressor** from the GBDK lib, it is BSD
  3-Clause and requires attribution. Easy to avoid for small games (just don't call it).

### Install on Windows (headless / scriptable)
1. Download `gbdk-win64.zip` from https://github.com/gbdk-2020/gbdk-2020/releases (v4.5.0).
2. Unzip to e.g. `C:\gbdk`. Binaries (`lcc.exe`, etc.) live in `C:\gbdk\bin`. No installer,
   no GUI, no admin. Fully agent-scriptable.
3. Sanity check: build the bundled `examples` (`compile.bat`) — each produces a `.gb`.

### Build a .gb ROM (exact commands)
```bat
REM compile each C file to an object
C:\gbdk\bin\lcc -c -o main.o main.c
REM link object(s) into a Game Boy ROM
C:\gbdk\bin\lcc -o game.gb main.o
```
Single-step shortcut: `C:\gbdk\bin\lcc -o game.gb main.c`

### Build a .gbc (Game Boy Color) ROM
Add a makebin/`-Wm-y*` header flag and name the output `.gbc`:
- `-Wm-yc` = CGB-compatible **and** runs on DMG (header byte `0x80`).
- `-Wm-yC` = **CGB-only** (header byte `0xC0`).
- Other header helpers: `-Wm-yn"TITLE"` (cart title, <=15 chars), `-Wm-ys` (SGB),
  `-Wl-yt0x1B` (MBC type, e.g. MBC5+RAM+BATT), `-Wl-yo<N>` (ROM banks), `-Wl-ya<N>` (RAM banks).

Example (dual DMG/CGB):
```bat
C:\gbdk\bin\lcc -Wm-yn"MYGAME" -Wm-yc -o game.gbc main.o
```
gambatte runs the result by extension (`.gb` -> DMG, `.gbc` -> CGB). For ROM-only / MBC1
small games no extra MBC flag is needed.

### How well can Claude write GBDK C?  → Very well.
- Plain C99-ish with a small, well-documented API (`<gb/gb.h>`): `DISPLAY_ON`,
  `wait_vbl_done()`, `joypad()`, `set_bkg_tiles()`, `set_sprite_data/tile()`, `move_sprite()`,
  `SHOW_SPRITES`. Concepts (tiles, sprites, background map, joypad bitmask) are stable and
  heavily represented in training data.
- Tutorials with full open-source games: Larold's Jubilant Junkyard
  (https://laroldsjubilantjunkyard.com/) and Larold's Retro Gameyard.
- This is plausibly the **single easiest retro target for an LLM**: C (not asm), tiny API,
  deterministic batch build, no GUI, output validated instantly in gambatte.

---

## Goal 2 — Assembly toolchain: RGBDS (gold standard)

**What it is:** The community-standard GB/GBC assembler suite (Rednex Game Boy Dev System).
- Site/docs: https://rgbds.gbdev.io/  — Repo: https://github.com/gbdev/rgbds
- **License: MIT** (toolchain itself permissive; output is yours regardless).
- **Latest release: v1.0.1 (2026-01-01).** Note: the v1.0 line — flag syntax matured.
- Components: `rgbasm` (assembler), `rgblink` (linker), `rgbfix` (header/checksum),
  `rgbgfx` (PNG -> GB tiles).

### Install on Windows
- Best: download the prebuilt Windows release zip from
  https://github.com/gbdev/rgbds/releases (put the `.exe`s on PATH). Fully scriptable.
- Chocolatey exists (`choco install rgbds`) but is **stale (0.5.2)** — avoid; use the GitHub zip.

### Build a .gb ROM (exact pipeline)
```bat
rgbasm -o game.o game.asm
rgblink -o game.gb game.o
rgbfix -v -p 0xFF game.gb
```
`rgbfix -v` validates/writes the header + Nintendo logo + global checksum (gambatte/real HW
boot requires a correct logo & checksum). For CGB: set the CGB flag with
`rgbfix -C` (CGB-only) or `-c` (CGB-compatible) and name output `.gbc`.

### LLM feasibility
- Feasible but **markedly harder than GBDK C**: SM83 assembly, manual VRAM timing
  (write during VBlank), bank math, and exact header bytes are easy to get subtly wrong.
- Excellent learning resources: gbdev.io "ASMSchool"/Pan Docs, the gbdev Awesome list
  (https://github.com/gbdev/awesome-gbdev), and the assemblydigest "empty ROM" tutorial.
- Verdict: use RGBDS only when we need tight control or asm-specific tricks; otherwise GBDK.

---

## Goal 3 — High-level / visual / lowest-effort: GB Studio

**What it is:** A visual (drag-and-drop) Game Boy game maker built on GBDK. Exports **real
`.gb`/`.gbc` ROMs** (plus web/Pocket builds).
- Site: https://www.gbstudio.dev/  — Repo: https://github.com/chrismaltby/gb-studio
- **License: MIT** (the app). Exported games are the author's own work — no royalty/ownership
  claim found; our content stays CC0/MIT. (Confirm we don't bundle GB Studio's bundled demo
  assets, which have their own terms.)

### Scriptable? — Yes, partially.
GB Studio ships a CLI: **`gb-studio-cli`**. Headless ROM build:
```
gb-studio-cli make:rom path/to/project.gbsproj out/game.gb
```
(invoked e.g. via `yarn bin gb-studio-cli`). **BUT** authoring the `.gbsproj` itself is a GUI
activity — the CLI compiles an already-designed project. So it is *buildable* headlessly,
not *authorable* headlessly. Less suited to an autonomous AI agent than GBDK, which is C an
agent can write directly.

### BASIC-like options
- No mainstream maintained BASIC for GB worth shipping. GB BASIC interpreters exist as
  curiosities but are not a practical authoring path. Skip.

---

## Goal 4 — AI-assisted creation (Claude authoring a .gb)

**Verdict: HIGH reliability via GBDK-2020 C.** Recommended AI pipeline:
1. Claude writes `main.c` against `<gb/gb.h>` (sprites + background + joypad loop).
2. Agent runs `lcc -o game.gb main.c` (or `.gbc` with `-Wm-yc`).
3. Load in gambatte; iterate on compile errors / behavior. Fast, deterministic loop.

### Minimal template Claude can extend (compiles as-is)
```c
#include <gb/gb.h>

void main(void) {
    DISPLAY_ON;
    SHOW_SPRITES;
    while (1) {
        UINT8 keys = joypad();
        // read keys (J_LEFT/J_RIGHT/J_UP/J_DOWN/J_A/J_B/J_START), move_sprite(), etc.
        wait_vbl_done();   // yield until next frame (~60Hz / ~59.7Hz)
    }
}
```
Build: `C:\gbdk\bin\lcc -o game.gb main.c`

### Failure modes to watch
- **Tile/sprite data:** sprites need data loaded (`set_sprite_data`) and a tile assigned
  (`set_sprite_tile`) before `move_sprite` shows anything — a common "blank screen" bug.
- **VRAM access timing:** heavy background updates outside VBlank can glitch; batch them.
- **Header/CGB flag:** wrong `-Wm-y*` flag -> runs as DMG instead of CGB (or vice-versa).
- **`UINT8`/`UBYTE` types** and `joypad()` bitmask: easy to mix up; verify against gb.h.
- RGBDS path adds many more failure modes (logo/checksum, banking) — prefer GBDK for AI.

---

## Goal 5 — Concrete recommendation (CC0 games + exact pipeline)

**Toolchain: GBDK-2020 v4.5.0.** Three realistic, forgiving CC0 test games:
1. **Snake** — single sprite/tile movement, grid logic, growing tail, score. Trivial assets.
2. **Breakout / brick-breaker** — paddle (joypad), ball physics, brick grid collision.
3. **Simple one-screen platformer** — gravity + jump, a few solid tiles. (GB is forgiving.)

Each is a few hundred lines of C with a handful of 8x8 tiles — well within reliable AI output.

### EXACT build pipeline (Windows, headless)
```bat
REM 1) one-time install
REM    download gbdk-win64.zip (v4.5.0) from
REM    https://github.com/gbdk-2020/gbdk-2020/releases  and unzip to C:\gbdk

REM 2) author main.c (Claude-written), then build:
C:\gbdk\bin\lcc -c -o main.o main.c
C:\gbdk\bin\lcc -Wm-yn"SNAKE" -o snake.gb main.o

REM   (for Game Boy Color build instead:)
C:\gbdk\bin\lcc -Wm-yn"SNAKE" -Wm-yc -o snake.gbc main.o

REM 3) run in gambatte (LibretroWebXR) -> snake.gb / snake.gbc
```
Ship each ROM + its `main.c` under **CC0** (or MIT) in the repo. Pure-our-code, zero
third-party asset entanglement.

---

## Goal 6 — Fallback: genuinely CC0/MIT GB/GBC homebrew we could ship

Treat any homebrew with skepticism — **code and assets often have different licenses**, and
art is frequently the catch.

- **Tobu Tobu Girl** (arcade platformer) — VERIFIED.
  - Repo: https://github.com/SimonLarsen/tobutobugirl (DX: .../tobutobugirl-dx)
  - README: "source code ... licensed under the **MIT License**. All assets (images, text,
    sound and music) are licensed under **Creative Commons Attribution 4.0 International**
    (CC-BY-4.0)." (DX uses CC-BY-SA-4.0 for assets per listings.)
  - => Shippable IF we provide attribution for the assets (CC-BY). Not CC0/MIT-only, but
    permissive. Built with GBDK 2.96a originally.
- **gbdk-gb-4-player ("Den of Snakes")** — https://github.com/bbbbbr/gbdk-gb-4-player —
  source released to the **public domain** (attribution welcome, not required). CC0-equivalent,
  though it targets the 4-player link adapter (niche for our use).
- **gbdev / awesome-gbdev open-source ROM list** — https://github.com/gbdev/awesome-gbdev
  and the Game Boy Compo entries (https://gbdev.io/gbcompo21.html) — compos award bonuses for
  GPL/MIT/Apache/**CC0** entries, so a curated pool of permissively-licensed ROMs exists.
  Verify each repo's asset license individually before shipping.

**Recommendation:** authoring our own tiny CC0 games via GBDK is cleaner than vetting
third-party asset licenses. Use Tobu Tobu Girl only as a polished demo with proper CC-BY
attribution if desired.

---

## Goal 7 — VERIFIED build log (LWX Snake, 2026-06-01)

We actually built a CC0 Snake game with this toolchain. Below is the
ground-truth record (URLs, commands, gotchas) from that run.

### Install (what worked, headless / zip-only)
- Asset confirmed via the GitHub API
  (`releases/latest` of `gbdk-2020/gbdk-2020`): **tag `4.5.0`**.
- Windows asset: **`gbdk-win64.zip`** (~8.6 MB). Working URL:
  `https://github.com/gbdk-2020/gbdk-2020/releases/download/4.5.0/gbdk-win64.zip`
- Download + extract (no installer, no prompts):
  ```powershell
  Invoke-WebRequest -Uri "https://github.com/gbdk-2020/gbdk-2020/releases/download/4.5.0/gbdk-win64.zip" -OutFile "$env:TEMP\gbdk-win64.zip"
  Expand-Archive -Path "$env:TEMP\gbdk-win64.zip" -DestinationPath "C:\" -Force
  ```
- **GOTCHA — zip layout:** the zip contains a top-level `gbdk\` folder, so
  `Expand-Archive ... -DestinationPath C:\` yields `C:\gbdk\bin\lcc.exe`
  (NOT `C:\gbdk-2020\...`). If you want it at `C:\gbdk-2020`, move it after
  extraction (`Move-Item C:\gbdk C:\gbdk-2020`). The build script
  `scripts/make-gb-snake.mjs` searches both `C:\gbdk-2020\bin` and
  `C:\gbdk\bin` (plus `%GBDK_HOME%\bin` and `PATH`) so either location works.
- Version confirmed from `C:\gbdk-2020\ChangeLog` (top entry `gbdk-4.5.0`).

### Build (exact, verified)
```bat
C:\gbdk-2020\bin\lcc -Wm-ynLWX_SNAKE -o lwx-gb-snake.gb main.c
```
- Single-step `lcc -o out.gb main.c` works fine; no separate `-c` step needed.
- **GOTCHA — title with spaces:** `-Wm-yn"LWX SNAKE"` breaks when spawned
  through a shell — the space splits the argument and lcc tries to open a file
  named `SNAKE`. Either spawn lcc WITHOUT a shell (`spawnSync(..., {shell:false})`)
  or use a space-free title (we used `LWX_SNAKE`). The repo script does both.

### Verify (what to check on the output `.gb`)
- Size: **32768 bytes** (ROM-only, 2× 16 KB banks) — sane.
- Nintendo logo at `0x104..0x133`: written by makebin, byte-exact match. ✔
- Cart type `0x147` = `0x00` (ROM ONLY); ROM size `0x148` = `0x00` (32 KB). ✔
- **Header checksum `0x14D`: correct** — this is the byte the DMG boot ROM
  actually enforces, and makebin computes it. ✔
- **GOTCHA — global checksum `0x14E/0x14F`:** GBDK/makebin does NOT compute the
  16-bit global checksum (leaves it `0x0084`-ish, not the true sum). This is
  EXPECTED and harmless: neither real hardware nor gambatte verifies the global
  checksum. Do not treat a global-checksum mismatch as a build failure. (RGBDS's
  `rgbfix -v` would fill it in; GBDK does not, by design.)

### Result
- Game: `games/gb-snake/main.c` (CC0, ~280 lines, our own tile graphics).
- Build script: `scripts/make-gb-snake.mjs` (`node scripts/make-gb-snake.mjs`).
- ROM: `public/roms/freeware/lwx-gb-snake.gb` (32768 bytes), runs on gambatte.

---

## Sources
- GBDK-2020: https://github.com/gbdk-2020/gbdk-2020 , http://gbdk.org/docs/api/docs_getting_started.html , http://gbdk.org/docs/api/docs_toolchain.html
- GBDK minimal project: https://laroldsjubilantjunkyard.com/tutorial/minimal-gbdk-project/
- GBDK CGB flags: https://github.com/drludos/GBcorp , http://gbdk.org/docs/api/docs_supported_consoles.html
- RGBDS: https://rgbds.gbdev.io/ , https://github.com/gbdev/rgbds , https://rgbds.gbdev.io/install
- GB Studio: https://www.gbstudio.dev/docs/build/ , https://github.com/chrismaltby/gb-studio
- Tobu Tobu Girl: https://github.com/SimonLarsen/tobutobugirl , https://hh.gbdev.io/game/tobutobugirl/
- gbdev resources: https://github.com/gbdev/awesome-gbdev , https://gbdev.io/gbcompo21.html
