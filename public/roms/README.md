# ROMs

**No commercial game ROMs and no BIOS files live here** — they're copyrighted
(see `docs/LICENSING.md`). This folder holds only:

- `manifest.json` — the default collection (metadata + boxart + ROM pointers).
- `freeware/` — games we can legally ship: either **our own** CC0 demos, or
  homebrew with explicit redistribution permission. This folder IS committed.
- Your own ROMs (gitignored) — drop them here, or point the app at a local
  folder / URL (see `docs/ROOM_AND_COLLECTIONS.md`).

## How to get test games legally

### Option A — our own CC0 demos (ship out of the box)
We generate tiny demo games from source so there's zero licensing doubt:

```bash
node scripts/make-c64-demo.mjs      # -> public/roms/freeware/lwx-demo.prg (C64 BASIC, CC0)
```

These are ours, CC0/public-domain, and safe to redistribute. More to come for
other systems (see "Creating custom games" below).

### Option B — curated redistributable homebrew (download yourself)
This is the default `manifest.json` starter pack, chosen for **clear** licenses.
Download each into this `freeware/` folder (filenames must match `manifest.json`)
or a local library folder, then load via the app. Filenames expected:
`super-tilt-bro.nes`, `halo2600.a26`, `anguna.gba`, `tobutobugirl.gb`,
`blox.vb`, `oldtowers.md`.

| Game | System | License | Where |
|---|---|---|---|
| Super Tilt Bro. | NES | **WTFPL** (≈ public domain) | https://github.com/retrobrews/nes-games (or sgadrat.itch.io) |
| Halo 2600 | Atari 2600 | **Public domain** (Ed Fries) | https://github.com/retrobrews/atari2600-games |
| Anguna | GBA | Freeware — **author permits binary redistribution** (keep credits) | https://www.tolberts.net/anguna/ |
| Tobu Tobu Girl | Game Boy | **MIT** (code) + **CC-BY** (assets) — cleanest of all | https://tangramgames.itch.io/tobutobugirl |
| BLOX | Virtual Boy | **Public domain** | https://www.virtual-boy.com/homebrew/blox/ |
| Old Towers | Genesis/MD | **CC BY-NC-SA 4.0** (non-commercial only) | https://retrosouls.itch.io/old-towers |

**License caveats (verified 2026-05-31):**
- "Free to download" ≠ "free to redistribute." Many author freeware releases
  (e.g. Shiru's *Alter Ego*/*Lan Master*, several itch.io freebies) have **no
  explicit redistribution license** — fine to download and play, but link to the
  author's page rather than re-hosting unless you confirm.
- The **retrobrews** repos (https://github.com/retrobrews) are the best single
  source, but their "approved for free distribution" note is **scoped to that
  project**, not a transferable license. Strong signal authors are friendly;
  re-host only after checking each game's `.txt`.
- **Old Towers is CC BY-NC-SA** — keep it out of any commercial build.
- Demos of *commercial* games (Micro Mages — **commercial, ~$10**; Tanglewood;
  Goodboy Galaxy) are fine **as demos only**; never ship a full commercial ROM.

### Curated bulk sources
- **libretro homebrew DB** (curated as redistributable, guarantees thumbnail
  matches): https://github.com/libretro/libretro-database (`metadat/homebrew/`)
- **PDRoms**: https://pdroms.de/
- **SMS Power! homebrew**: https://www.smspower.org/Homebrew/Index
- **AtariAge homebrew**: https://atariage.com/
- **PlanetVB** (Virtual Boy): https://www.planetvb.com/
- **CSDb** (C64): https://csdb.dk/
- Boxart: **libretro-thumbnails** https://thumbnails.libretro.com/ (Alter Ego &
  Halo 2600 have entries; most homebrew needs custom art).

## Creating custom games

The surest way to have unambiguously-shippable content is to make it. Easiest
first (no compiler needed): **C64 / VIC-20 BASIC** `.prg` files — tokenized
BASIC we emit from a script (`scripts/make-c64-demo.mjs`). Harder but possible
with a toolchain: NES (ca65/asm6), Atari 2600 (dasm), GB/GBA (devkit). Anything
we author here is CC0 and committed under `freeware/`.

## manifest.json

Today's schema (extended, backward-compatible) per entry:
`file` (relative to this folder), `system`, `core` (optional → auto-detect),
`title`, `color` (cartridge tint when no boxart), `boxart` (URL), plus
`license` and `credits`. The richer Collection/Room JSON in
`docs/ROOM_AND_COLLECTIONS.md` is the forward direction (Phase R).
