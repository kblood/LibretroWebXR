# LWX Catch (Sega Master System + Game Gear)

A tiny CC0 one-screen arcade game for LibretroWebXR test content. Move the
basket left/right with the D-pad to catch fruit falling from the top. Each catch
scores a point and speeds the next drop up a little; a miss costs one of three
lives. Three misses shows **GAME OVER** — press button 1 (Start) or button 2 to
play again.

One source file builds **both** a Master System `.sms` and a Game Gear `.gg`
ROM. All gameplay is kept inside the central 160x144 region so it is fully
visible on the smaller Game Gear screen as well as the full SMS screen. The only
per-target difference is the palette-load call (`#ifdef TARGET_GG`), the linked
library, and the output extension.

This is the **devkitSMS + SDCC** workflow from
`docs/research/sms-gg-game-creation.md`: the only file we author is `main.c`
(game logic calling SMSlib's documented API). The C runtime startup
(`crt0_sms.rel`), the SMSlib runtime libraries, and the `ihx2sms` ROM packer are
the frozen, known-good devkitSMS templates — no hardware boot/header/checksum
code is hand-written. That split is what makes AI-authored SMS/GG games reliable.

## Build

```
node scripts/make-sms-arcade.mjs      # from the repo root
```

Needs **SDCC** (zip-installed at `C:\sdcc`) and **devkitSMS** (at
`C:\devkitSMS`). The script finds them there (override with `SDCC_HOME` /
`DEVKITSMS_HOME`), compiles `main.c` twice, and writes both ROMs:

- `public/roms/freeware/lwx-sms-arcade.sms` (32 KB)
- `public/roms/freeware/lwx-gg-arcade.gg` (32 KB)

`ihx2sms` pads each ROM to a 16 KiB multiple and writes the Sega header
checksum. The SMS ROM gets region byte `0x4C` (SMS Export); the GG ROM gets
`0x7C` (GG International), selected automatically by the `-DTARGET_GG` define.

## Files

| File | Origin | License |
|---|---|---|
| `main.c` | **ours** — the game | CC0 |
| `crt0_sms.rel`, `SMSlib.lib`, `SMSlib_GG.lib`, `SMSlib.h` | devkitSMS (sverx) — frozen runtime, vendored at `C:\devkitSMS` | public domain (Unlicense) |
| `ihx2sms` | devkitSMS (sverx) — ROM packer | public domain (Unlicense) |

The compiled ROMs are **CC0** — devkitSMS's public-domain runtime does not taint
the output. The game uses no compressed assets, so none of SMSlib's ZX7/aPLib
attribution caveats apply.

## Notes

- Graphics are three hand-built 8x8 tiles (wall, basket, fruit) defined as C
  arrays in `main.c` plus SMSlib's built-in font — no external asset files.
- No sprites: everything is drawn into the tilemap, which keeps the code
  identical across SMS and GG apart from the palette call.
- SMSlib (this SDCC 4.6 build) has no number-print helper, so `main.c` includes a
  tiny fixed-width unsigned-int formatter for the score/lives HUD.
