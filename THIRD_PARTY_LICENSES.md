# Third-Party Licenses

LibretroWebXR's own code is MIT (see `LICENSE`). It runs **libretro emulator
cores** that are **not distributed in this repository** — they are fetched or
installed separately at build/deploy time (see `scripts/fetch-cores.mjs` and
`docs/LICENSING.md`). Each core keeps its own upstream license. This file lists
the cores LibretroWebXR is wired to use and their licenses, so anyone hosting a
build knows their obligations.

> **Not legal advice.** This is a good-faith summary of upstream license
> metadata (the libretro `*_libretro.info` files and each project's LICENSE).
> Verify against the actual core you ship before any commercial use.

## License categories

- **GPL / permissive** — free to redistribute (with GPL's source-availability
  obligations where applicable). Safe for a free, open project.
- **NON-COMMERCIAL** — free for personal/non-commercial use only. May **not**
  be sold or bundled into a commercial product. Not OSI "open source". Keep
  these isolated and easy to drop; never rely on them if the project ever
  becomes commercial.

## Cores referenced by this project

| Core | System(s) | License | Category |
|---|---|---|---|
| snes9x | SNES | Non-commercial | ⚠️ NON-COMMERCIAL |
| nestopia (nestopia_ue) | NES | GPLv2 | GPL |
| fceumm | NES | GPLv2 | GPL |
| gambatte | Game Boy / Color | GPLv2 | GPL |
| mgba | GB / GBC / GBA | MPL-2.0 | Permissive (GPL-compatible) |
| genesis_plus_gx | Genesis / MD / SMS / GG / SegaCD | Non-commercial | ⚠️ NON-COMMERCIAL |
| picodrive | SMS / GG / MD / 32X / SegaCD | MAME (non-commercial) | ⚠️ NON-COMMERCIAL |
| gearsystem | SMS / GG / SG-1000 | GPLv3 | GPL |
| mednafen_pce_fast | PC Engine / TurboGrafx-16 | GPLv2 | GPL |
| mednafen_vb (Beetle VB) | Virtual Boy | GPLv2 | GPL |
| stella2014 | Atari 2600 | GPLv2 | GPL |
| vice_x64 / vice_xvic | C64 / VIC-20 | GPLv2 | GPL |
| beetle_psx / beetle_psx_hw | PlayStation | GPLv2 | GPL (needs BIOS) |
| mupen64plus_next | Nintendo 64 | GPLv2 | GPL |
| mame2003_plus / fbneo | Arcade | Non-commercial | ⚠️ NON-COMMERCIAL (+ROM/BIOS issues) |

### Flagged non-commercial cores
`snes9x`, `genesis_plus_gx`, `picodrive`, `mame2003*`, `fbneo`. They are fine
for this free/non-commercial project but cannot be sold or bundled into a
commercial product, and are not GPL-compatible (do not statically combine them
into a single GPL artifact — load them as separate runtime files, which is
exactly what this project does).

## BIOS files — never distributed

Console BIOS/firmware is copyrighted by the manufacturer and is **not** covered
by any emulator license. It is never included here. Users must supply their own.

| System | BIOS | Status |
|---|---|---|
| PlayStation (beetle/pcsx) | `scph5500/5501/5502.bin` | Sony copyright — user-supplied (OpenBIOS works but worse) |
| GBA (mgba) | `gba_bios.bin` | Nintendo copyright — optional (mGBA has HLE BIOS) |
| Sega CD (genesis_plus_gx/picodrive) | `bios_CD_*.bin` | Sega copyright — required for CD games |
| Arcade (mame/fbneo) | e.g. `neogeo.zip` | Copyright — never bundle |
| NES/SNES/GB/GBC/Genesis-cart/N64 | — | No BIOS needed |

## ROMs — never distributed

No commercial game ROMs are included in this repository. See
`public/roms/README.md` for the free/homebrew/public-domain content the project
ships pointers to, and how to add your own legally-owned ROMs.

## Sources
- libretro core license metadata: https://github.com/libretro/libretro-core-info
- libretro licenses doc: https://docs.libretro.com/development/licenses/
- Snes9x LICENSE: https://github.com/snes9xgit/snes9x/blob/master/LICENSE
- Genesis Plus GX LICENSE: https://github.com/libretro/Genesis-Plus-GX/blob/master/LICENSE.txt
- EmulatorJS (GPL-3, CDN-hosted cores) : https://github.com/EmulatorJS/EmulatorJS , https://emulatorjs.org/docs/cdn/
