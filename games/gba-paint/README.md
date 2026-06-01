# LWX Paint (GBA)

A tiny **CC0** Game Boy Advance paint toy for LibretroWebXR test content. It runs
in GBA **Mode 3** — a plain 240×160 linear framebuffer of 16-bit BGR555 pixels at
VRAM `0x06000000` — so there are no tiles, palettes, OAM or DMA: the game just
plots pixels with libtonc's documented `m3_*` helpers.

This is the **devkitARM + libtonc Mode 3** workflow from
`docs/research/gba-game-creation.md`: the only file we author is `main.c` (game
logic calling libtonc's documented API); the toolchain and library are the
frozen, vendored devkitPro packages. That split is what makes AI-authored GBA
games reliable.

## Controls (RetroPad → GBA)

| Input | Action |
|---|---|
| D-pad | move the cursor |
| A | paint (drop the current colour, leaving a trail) |
| B | erase (paint black) |
| L / R | previous / next colour from the 8-colour palette |
| START | clear the whole canvas to black |
| SELECT | toggle a thicker brush (1px ↔ 3×3) |

The chosen colour is always shown by the white-outlined swatch in the palette bar
along the top.

## Build

```
node scripts/make-gba-paint.mjs      # from the repo root
```

Needs **devkitARM + libtonc** installed (devkitPro pacman packages extracted to
`C:\devkitPro`; the toolchain is not on PATH so the script discovers/hardcodes
that path and sets `DEVKITPRO`/`DEVKITARM`). The script:

1. `arm-none-eabi-gcc -mthumb -mthumb-interwork -O2 -mcpu=arm7tdmi … -c main.c`
2. links with `-specs=gba.specs -ltonc` (the specs file supplies the GBA crt0 +
   linker script — never hand-rolled)
3. `arm-none-eabi-objcopy -O binary` to a raw `.gba`
4. runs **gbafix** (writes the header complement at `0x0BD` + checksum, required
   to boot) and writes `public/roms/freeware/lwx-gba-paint.gba`.

See `docs/research/gba-game-creation.md` for the exact non-interactive package
URLs used to install the toolchain.

## Files

| File | Origin | License |
|---|---|---|
| `main.c` | **ours** — the game | CC0 |
| devkitARM, libtonc | devkitPro packages — frozen toolchain/library (installed under `C:\devkitPro`, outside the repo) | GPL/newlib + MIT/zlib |

The compiled ROM is **CC0** — the toolchain's license does not taint the output.
