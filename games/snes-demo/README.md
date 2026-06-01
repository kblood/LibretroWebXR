# LWX SNES Demo

A tiny CC0 SNES game for LibretroWebXR test content. A single player sprite sits
on a tiled/colored background; the D-pad moves it around the screen (clamped to
the visible area) and A / B cycle the backdrop colour. Standard **LoROM** `.sfc`
(256 KB, ROM-only, no special chips) that the libretro **snes9x** core runs.

This is the **PVSnesLib template-fill** workflow from
`docs/research/snes-game-creation.md`: the timing-critical SNES boot/init code is
frozen in the SDK library and the vendored template files (`hdr.asm`, `data.asm`,
`Makefile`); the only file we author is `snesdemo.c` (game logic calling
PVSnesLib's documented API). That split is what makes AI-authored SNES games
reliable.

## Build

```
node scripts/make-snes-demo.mjs      # from the repo root
```

Needs **PVSnesLib** (the 65816 toolchain is bundled with it), plus a GNU `make`
and a Unix shell. The build script:

- finds PVSnesLib via `%PVSNESLIB_HOME%`, then `C:\pvsneslib`
  (it must contain `devkitsnes\snes_rules`);
- finds GNU make via `%MAKE%`, then `C:\ProgramData\mingw64\mingw64\bin\mingw32-make.exe`,
  then MSYS2 / MinGW dirs, then `PATH`;
- finds a Unix shell (`sh.exe` + sed/ls/rm/echo/find) via `%GIT_BASH_BIN%`, then
  `C:\Program Files\Git\usr\bin` (these ship with **Git for Windows**);
- runs `make SHELL=<git sh.exe> OS=` (see *Gotchas* below) which converts the
  font + sprite BMPs with `gfx4snes`, compiles `snesdemo.c` through
  `816-tcc -> 816-opt -> constify -> wla-65816 -> wlalink`, and emits
  `snesdemo.sfc`; then it copies that to `public/roms/freeware/lwx-snes-demo.sfc`
  and removes the build intermediates.

No interactive installer is required: GNU make comes from a MinGW-w64 install and
the Unix coreutils come from Git for Windows — both are non-interactive.

## Files

| File | Origin | License |
|---|---|---|
| `snesdemo.c` | **ours** — the game logic | CC0 |
| `Makefile`, `hdr.asm`, `data.asm` | ours (adapted from PVSnesLib sample templates) | CC0 |
| `pvsneslibfont.bmp` | PVSnesLib example font (used as BG tile set + text) | MIT (alekmaul) |
| `sprites.bmp` | PVSnesLib `SimpleSprite` example art (player sprite) | MIT (alekmaul) |

PVSnesLib is **MIT**; its license does not taint the compiled ROM. The art is the
SDK's own example assets (MIT, attribution kept above). Our game logic is **CC0**,
and the compiled ROM ships as **CC0**.

## Controls

- **D-pad** — move the sprite (up/down/left/right), clamped to the screen.
- **A** — next backdrop colour.
- **B** — previous backdrop colour.

## Notes

- LoROM, SlowROM, ROM-only, 256 KB (8 × 32 KB banks). Internal SNES header at
  `0x7FC0` with title `LWX SNES DEMO`, mapmode `0x20` (LoROM), valid checksum.
- Runs on the **snes9x** core (the system default for `snes`).
