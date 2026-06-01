# Creating Original GBA Games as Test Content for LibretroWebXR

Research date: 2026-06-01. Target: small CC0/MIT games we author ourselves, shipped as
`.gba` ROMs that run on the libretro **mGBA** core. The GBA is a 32-bit ARM device; in
**Mode 3** VRAM is a plain 240x160 linear framebuffer of 16-bit BGR555 pixels, so you can
plot pixels directly in C with no asset pipeline. This makes it one of the *easiest*
possible targets for AI code generation.

> License note: a toolchain's license never taints the output. devkitARM (GPL/various),
> Butano (zlib), libtonc (MIT/zlib-style) are all fine — the game source we write is ours
> and we license it CC0 or MIT.

---

## Goal 1 — C/C++ Toolchains (devkitARM / libtonc / Butano)

### Option A (recommended baseline): devkitPro + devkitARM + libtonc

- **What:** devkitPro is the standard GBA homebrew toolchain. devkitARM is its ARM GCC.
  **libtonc** (the Tonc library) and **libgba** ship in the `gba-dev` package group.
  libtonc is preferred — far better documentation and the canonical Tonc tutorial uses it.
  libgba has almost no docs.
- **Windows install (GUI, headless-friendly enough for an agent):**
  - Download the graphical installer: <https://github.com/devkitPro/installer/releases/latest>
  - During install select the **"GBA Development"** component and install **all members of
    the `gba-dev` group**. Default path `C:\devkitPro\`.
  - Installer sets `DEVKITPRO` / `DEVKITARM` env vars and provides an MSYS2 shell
    (`C:\devkitPro\msys2\`). `make` is run from that shell.
  - On Linux/macOS the equivalent is `dkp-pacman -S gba-dev`.
- **Build:** projects use a Makefile that `include`s devkitARM's `gba_rules`. Just run
  `make`. Output is `<project>.gba`.
- **gbafix is automatic.** devkitARM's `gba_rules`
  (<https://github.com/devkitPro/devkitarm-rules/blob/master/gba_rules>) contains:
  ```makefile
  %.gba: %.elf
      $(SILENTCMD)$(OBJCOPY) -O binary $< $@
      $(SILENTCMD)gbafix $@ -t$(GAME_TITLE) -c$(GAME_CODE) -m$(MAKER_CODE)
  ```
  So `gbafix` (which writes the header complement at 0x0BD and the checksum, required to
  boot on real hardware and strict emulators) runs as part of every `make`. You only call
  it by hand if you build outside the standard rules.
- **Licenses:** devkitARM = GCC (GPL) + newlib; libtonc = permissive (MIT/zlib-style).
  Output ROM is unaffected.
- **AI suitability:** Excellent for Mode 3/Mode 4. Claude can write a complete `main.c`
  that sets `REG_DISPCNT = MODE_3 | BG2_ON` and writes BGR555 pixels to `0x06000000`
  with no external assets. Tonc's API (`m3_plot`, `m4_plot`, `vid_flip`, `key_poll`,
  `REG_DISPCNT`) is well represented in training data.
- **Templates:**
  - libtonc template: <https://github.com/gbadev-org/libtonc-template> (has `source/`,
    `graphics/`, Makefile; build with `make`).
  - Alt template: <https://github.com/nytpu/tonc_template>

### Option B (modern C++): Butano

- **What:** Butano (<https://github.com/GValiente/butano>) is a high-level **C++17** GBA
  engine (sprites, backgrounds, audio, no manual VRAM banking). Built *on top of*
  devkitARM (or the newer Wonderful Toolchain).
- **License:** **zlib** (very permissive). Third-party libs and bundled assets have their
  own licenses — if we ship a Butano game we author our own assets and keep them CC0/MIT.
- **Windows install:**
  - Install devkitPro `gba-dev` as in Option A.
  - Install **Python** (add to PATH; needed by Butano's image/audio import tools `grit`,
    `mmutil`).
  - Clone/download Butano into a path **without spaces or special characters**:
    `git clone https://github.com/GValiente/butano`
  - Verify by building a bundled example: `cd butano/examples/sprites && make -j8`.
    Output e.g. `sprites.gba` (gbafix runs via the same devkitARM rules).
  - Docs: <https://gvaliente.github.io/butano/getting_started.html>
- **AI suitability:** Good but higher ceiling. Great for a polished sprite game, but it
  has more API surface and an asset-import step (PNG + `.bmp`/`.json` headers via grit),
  which is more error-prone for an agent than raw Mode 3. Use Butano only if we want a
  "real" looking game; use libtonc/raw-Mode-3 for guaranteed-reliable test content.

### Why Mode 3 is the easiest AI target
- VRAM at `0x06000000` is literally `u16 screen[160][240]` in BGR555.
- Set one register: `*(volatile u32*)0x04000000 = 0x0403;` (Mode 3 + BG2 on).
- Plot a pixel: `((u16*)0x06000000)[y*240 + x] = color;`
- No tiles, no palettes, no OAM, no DMA, no asset converter. A correct game can be a
  single self-contained `main.c`. Very low hallucination risk.

---

## Goal 2 — Tonc Tutorial Path (canonical learning resource)

- **Tonc** is *the* GBA programming tutorial. Community edition (maintained):
  - HTML: <https://gbadev.net/tonc/> and original <https://www.coranac.com/tonc/text/>
  - Source/repo: <https://github.com/gbadev-org/tonc>
  - Setup chapter: <https://gbadev.net/tonc/setup.html>
  - Bitmap modes (Mode 3 / Mode 4 page-flip): <https://www.coranac.com/tonc/text/bitmaps.htm>
  - First demo: <https://www.coranac.com/tonc/text/first.htm>

### Minimal Mode 3 template (no library needed, hardware-register only)
This is the canonical Tonc "first" demo — plots three colored dots:
```c
int main(void) {
    *(volatile unsigned int*)0x04000000 = 0x0403;          // REG_DISPCNT: Mode 3 + BG2

    unsigned short* vram = (unsigned short*)0x06000000;     // 240x160 BGR555 framebuffer
    vram[120 + 80*240] = 0x001F;                            // red   (BGR555)
    vram[136 + 80*240] = 0x03E0;                            // green
    vram[120 + 96*240] = 0x7C00;                            // blue

    while (1);                                              // no OS to return to
    return 0;
}
```
Colors are 5.5.5 BGR: `RGB15(r,g,b) = r | (g<<5) | (b<<10)`, each channel 0..31.

### Minimal interactive game skeleton (libtonc)
With libtonc you get input + helpers, still tiny:
```c
#include <tonc.h>
int main(void) {
    REG_DISPCNT = DCNT_MODE3 | DCNT_BG2;
    int x = 120, y = 80;
    while (1) {
        vid_vsync();          // wait for VBlank
        key_poll();
        if (key_is_down(KEY_LEFT))  x--;
        if (key_is_down(KEY_RIGHT)) x++;
        if (key_is_down(KEY_UP))    y--;
        if (key_is_down(KEY_DOWN))  y++;
        m3_fill(CLR_BLACK);
        m3_plot(x, y, CLR_WHITE);   // moveable cursor
    }
}
```
An agent can use Tonc as ground truth for register names and APIs, then emit a complete
project (this `main.c` + the libtonc-template Makefile) and `make`.

Mode 4 (8bpp paletted, page-flipped at `0x0600A000`) is the next step for flicker-free
animation via `vid_flip()`; slightly more setup (palette) but still framebuffer-simple.

---

## Goal 3 — AI-Assisted Creation: reliability & failure modes

**Verdict: Claude is highly reliable at producing a playable Mode 3 `.gba`.** A
single-file, register-or-libtonc Mode 3 game has minimal dependencies and a tiny, well-
documented API surface, so generation is low-risk.

Existing evidence of LLMs in this space (all *adjacent*, not turnkey game generators):
- **GBTS** — AI TypeScript→GBA-C transpiler CLI, supports Claude Sonnet 4 / GPT-4:
  <https://angelo-lima.fr/en/gbts-typescript-gameboy/>
- LLM-built GBA *emulators* (Claude Sonnet 4 did CPU/PPU/DMA) — shows models understand
  GBA hardware well: e.g. GLM/Claude emulator write-ups.
- No mature "prompt → .gba game" generator exists yet — so our approach (Claude writes
  Tonc-style C, devkitARM builds) is the practical path and a novel value-add.

**Failure modes to guard against (and fixes):**
1. **Header/checksum** — a raw `objcopy` binary won't boot until `gbafix` writes the
   complement + checksum. *Fix:* always build through devkitARM's `gba_rules` (gbafix runs
   automatically), or run `gbafix game.gba` manually as the last step.
2. **Crt0 / linker** — homebuilt Makefiles that omit the GBA crt0/specs link a broken ELF.
   *Fix:* start from `libtonc-template`'s Makefile; never hand-roll link flags.
3. **VRAM byte writes** — GBA VRAM cannot be written 8 bits at a time; Mode 3 must use
   16-bit writes (Mode 4 needs read-modify-write or 16-bit pairs). LLMs occasionally emit
   `u8` writes. *Fix:* always use `u16`/`m3_plot`.
4. **BIOS calls / SWI** — only needed for division, decompression, etc.; avoid in a demo.
   If used, must be the libtonc/libgba wrappers, not raw `swi` inline asm.
5. **Endianness/color order** — GBA is BGR555 not RGB565; use the `RGB15` macro.
6. **No `vsync`** — busy-plotting without `vid_vsync()` causes tearing; cosmetic, not fatal.

Recommended agent loop: generate `main.c` → `make` in MSYS2 → load `.gba` in mGBA
(libretro) or standalone mGBA headless to confirm boot → iterate on compiler errors.

---

## Goal 4 — Concrete Recommendation

**Pipeline (use this): devkitPro/devkitARM + libtonc, Mode 3, single `main.c`.**

### Exact build pipeline (Windows)
1. Install devkitPro from <https://github.com/devkitPro/installer/releases/latest>,
   selecting **GBA Development** + all `gba-dev` members. (Sets `DEVKITARM`, gives MSYS2.)
2. Get a known-good project skeleton:
   ```
   git clone https://github.com/gbadev-org/libtonc-template gba-demo
   ```
3. Replace `gba-demo/source/main.c` with our authored game (e.g. the skeleton in Goal 2).
   Optionally set `GAME_TITLE`/`GAME_CODE`/`MAKER_CODE` in the Makefile (feeds gbafix).
4. From the devkitPro **MSYS2** shell, in the project dir:
   ```
   make
   ```
   Produces `gba-demo.gba`. `gbafix` runs automatically via `gba_rules` (header complement
   + checksum written), so the ROM boots on mGBA / real hardware.
5. Test: open `gba-demo.gba` with the **mGBA** libretro core (our LibretroWebXR target) or
   standalone `mgba` to confirm it runs.
6. Ship the source under **CC0 or MIT** (our code) alongside the `.gba`.

### 2-3 realistic CC0 test games to author
1. **Mode 3 Paint** — D-pad moves a cursor, A draws, B erases, Start cycles color. ~80
   lines. Trivially reliable for an AI; shows input + framebuffer. *Top recommendation.*
2. **Mode 3 Pong** — two paddles + a ball with AABB bounce, score plotted as rectangles.
   Direct reference exists (MIT): <https://github.com/ZeroDayArcade/Pong-Homebrew-GBA>
   (C, Mode 3, no sprite lib) — we re-implement/clean-room it CC0.
3. **Mode 3 Maze** — a static maze drawn as filled rects, player dot navigates with
   collision against wall color. Pure framebuffer, no assets.

All three are single-file, asset-free, and avoid BIOS calls — maximally AI-reliable.
Start with **Paint** (simplest, most visually obvious it works), then Pong.

---

## Goal 5 — Fallback: genuinely permissive GBA homebrew we could ship

If we want pre-made content instead of authoring:

- **agb game template — CC0.** The Rust `agb` library is **MPL-2.0**, but its *game
  template* is explicitly released under **CC0**, so a game started from it can be CC0.
  <https://github.com/agbrs/agb>. (Note: building needs Rust + `agb`, more setup than C.)
- **sdk-seven docs — CC0; libs MPL-2.0 / zlib.** <https://github.com/LunarLambda/sdk-seven>
  Code is zlib/MPL, docs CC0 — permissive but not a finished game.
- **Pong-Homebrew-GBA — MIT.** <https://github.com/ZeroDayArcade/Pong-Homebrew-GBA>
  A complete, simple Mode 3 Pong in C under MIT. Ship as-is (keep MIT notice) or clean-room
  to CC0. **Best ready-made shippable game.**
- **GBA Jam 2021 open-source entries** — multiple games released under GPL/MIT/Apache/CC0.
  <https://itch.io/jam/gbajam21> (verify each game's individual license before shipping).
- **Homebrew Hub / awesome-gbdev** for discovery:
  <https://hh.gbdev.io/> and <https://github.com/gbdev/awesome-gbdev>

Skepticism / verification notes:
- **Anguna** (Bite the Chili, <https://www.bitethechili.com/anguna/>,
  <https://gauauu.itch.io/anguna>) is **freeware, NOT CC0/MIT.** Its license permits free
  *binary* redistribution **only if the license text ships with it** — no source license,
  no modification rights granted. Usable as a bundled binary with attribution, but it does
  **not** meet a "CC0/MIT we author" bar; treat as conditional freeware, not open source.
- Always open the actual `LICENSE`/`COPYING` file in the repo before shipping; itch.io and
  ROM-archive pages frequently mislabel licenses.
- Prefer **authoring our own** Mode 3 games (Goal 4): zero license ambiguity, guaranteed
  CC0/MIT, and well within Claude's reliable range.

---

## Sources
- Butano: <https://github.com/GValiente/butano> · <https://gvaliente.github.io/butano/getting_started.html> (license: zlib)
- devkitPro installer: <https://github.com/devkitPro/installer/releases/latest> · portal <https://devkitpro.org/>
- devkitARM gba_rules (auto gbafix): <https://github.com/devkitPro/devkitarm-rules/blob/master/gba_rules>
- gbafix source: <https://github.com/devkitPro/gba-tools/blob/master/src/gbafix.c>
- Tonc: <https://gbadev.net/tonc/> · <https://www.coranac.com/tonc/text/bitmaps.htm> · <https://www.coranac.com/tonc/text/first.htm> · repo <https://github.com/gbadev-org/tonc>
- libtonc template: <https://github.com/gbadev-org/libtonc-template> · alt <https://github.com/nytpu/tonc_template>
- gbadev getting started: <https://gbadev.net/getting-started>
- Pong (MIT): <https://github.com/ZeroDayArcade/Pong-Homebrew-GBA>
- agb (MPL-2.0 lib, CC0 template): <https://github.com/agbrs/agb>
- sdk-seven (zlib/MPL/CC0-docs): <https://github.com/LunarLambda/sdk-seven>
- Anguna (freeware, conditional binary redist): <https://www.bitethechili.com/anguna/> · <https://gauauu.itch.io/anguna>
- GBA Jam 2021 (open-source entries): <https://itch.io/jam/gbajam21>
- Discovery: <https://hh.gbdev.io/> · <https://github.com/gbdev/awesome-gbdev>
- GBTS (AI TS→GBA-C, Claude/GPT): <https://angelo-lima.fr/en/gbts-typescript-gameboy/>
