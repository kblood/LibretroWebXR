# LWX Snake (Game Boy)

A tiny **CC0** Snake game for LibretroWebXR test content. Standard DMG
(Game Boy) ROM, ROM-only (no MBC), 32 KB. Runs on the **gambatte** core.

This is the **GBDK-2020 C** workflow from
`docs/research/gameboy-game-creation.md`: all the hardware boot/header
boilerplate is supplied (and frozen) by GBDK's `crt0` + `makebin`; the only
file we author is `main.c` — pure game logic against the documented
`<gb/gb.h>` API. That split is what makes AI-authored GB games reliable.

## Gameplay

- **D-pad** — steer the snake (180-degree reversals are ignored).
- **START** — begin a game, and restart after game over.

Eat the diamond-shaped food to grow and score; the snake speeds up slightly
each time it eats. Hitting a wall or your own body ends the game. The score
(0–999) is drawn as digit tiles in the top-right of the score bar.

## Build

```
node scripts/make-gb-snake.mjs      # from the repo root
```

Needs **GBDK-2020** installed. The script finds `lcc` via `%GBDK_HOME%\bin`,
then `C:\gbdk-2020\bin`, then `C:\gbdk\bin`, then `PATH`. It runs:

```
lcc -Wm-ynLWX_SNAKE -o lwx-gb-snake.gb main.c
```

then copies the result to `public/roms/freeware/lwx-gb-snake.gb` and removes
the build intermediates. (`-Wm-yn...` writes the cart title into the header;
ROM-only — no MBC flag — is fine for a game this small. `lcc`/`makebin` fix up
the Nintendo logo and header checksum automatically.)

## Files

| File | Origin | License |
|---|---|---|
| `main.c` | **ours** — the game (logic + tile graphics) | CC0 |
| (boot/header/crt0/runtime) | GBDK-2020 — frozen boilerplate, GPLv2 **with Linking Exception** | not in this dir; supplied by the toolchain |

The compiled ROM is **CC0**: GBDK-2020's linking exception means the output
binary carries no GPL obligations, and the only thing we wrote (`main.c`,
including the hand-encoded 8×8 tiles) is dedicated to the public domain.

## Verification

The built ROM is 32768 bytes with a valid Game Boy header: the Nintendo logo
at `0x104` matches, the cart type is `0x00` (ROM ONLY), and the header
checksum at `0x14D` is correct (this is the byte the boot ROM enforces).
