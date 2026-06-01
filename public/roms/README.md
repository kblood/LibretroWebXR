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
We generate tiny demo games from source so there's zero licensing doubt. All
ship under `freeware/` and are referenced by `manifest.json`:

```bash
# Zero-install (pure Node — Commodore BASIC v2 tokenized to .prg)
npm run make-games          # builds all three below
node scripts/make-c64-demo.mjs    # -> freeware/lwx-demo.prg        (C64 "guess my number")
node scripts/make-c64-snake.mjs   # -> freeware/lwx-snake.prg       (C64 joystick Snake)
node scripts/make-vic20-demo.mjs  # -> freeware/lwx-vic20-demo.prg  (VIC-20 demo, load addr $1001)

# Needs a compiler toolchain (one-time install; see each docs/research/<system>-game-creation.md)
npm run make-nes-pong       # -> freeware/lwx-nes-pong.nes     (NES Pong;     cc65 + neslib, games/nes-pong/)
npm run make-gb-snake       # -> freeware/lwx-gb-snake.gb      (GB Snake;     GBDK-2020,     games/gb-snake/)
npm run make-genesis-demo   # -> freeware/lwx-genesis-demo.md  (Genesis demo; SGDK 2.11,     games/genesis-demo/)
npm run make-sms-arcade     # -> freeware/lwx-sms-arcade.sms + lwx-gg-arcade.gg
                            #                                 (SMS+GG Catch;  devkitSMS+SDCC, games/sms-arcade/)
npm run make-pce-pong       # -> freeware/lwx-pce-pong.pce     (PCE Pong;     HuC,           games/pce-pong/)
npm run make-atari-dodger   # -> freeware/lwx-atari-dodger.a26 (Beam Dodger;  batari Basic,  games/atari-dodger/)
npm run make-snes-demo      # -> freeware/lwx-snes-demo.sfc    (SNES demo;    PVSnesLib,     games/snes-demo/)
```

These are ours, CC0/public-domain, and safe to redistribute. The shared
Commodore BASIC tokenizer lives in `scripts/lib/cbm-basic.mjs`. The compiled
games use the template-fill workflow (boilerplate frozen from each SDK, only the
game `main.c` authored). Per-system research on creating more is in
`docs/research/` (one file per system + a `README.md` synthesis).

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
