# LibretroWebXR

A **browser-based WebXR libretro frontend** — play retro console games inside a
3D room, on **desktop browsers** and **standalone Meta Quest**, with no install.
Think [EmuVR](https://emuvr.net), but open-source and running in a web page.

> **Status:** live at `dionysus.dk/webxr/libretrowebxr2/` — rooms/collections as
> JSON, an in-VR room editor, and networked multiplayer are all built and
> deployed. See `docs/ROADMAP.md` for what's shipped vs. still in progress and
> `docs/HANDOFF.md` for the current state of the world.

## What it does today

- A 3D room you can enter in VR (Quest browser / PCVR) or explore on a flat
  screen — plus a **flat-screen-only `desktop.html` build** with the same
  netplay for players without a headset.
- Grabbable **cartridges** on **shelves/bookcases**; slot one into a **console**
  and it boots on the in-world **CRT TV**. A **patchable AV rack** lets you spawn
  more consoles/TVs and repatch video, controller, and keyboard cords between
  them, EmuVR-style.
- **17 systems** via libretro cores: SNES, NES, Game Boy / Color / Advance,
  Genesis / Master System / Game Gear / SG-1000 / Sega 32X, Virtual Boy,
  PC Engine / TurboGrafx-16, Atari 2600, C64, VIC-20, and **Amiga** (real
  Kickstart boot). DOS (VirtualXT) is registered but currently blocked — see
  `docs/DOS_CORE_BUILD.md`.
- Keyboard, gamepad, and WebXR-controller input with per-core RetroPad mapping;
  local couch co-op (up to 4 players, NES Four Score included); **light-gun**
  peripherals (Zapper, Super Scope, Justifier 2-gun, Menacer, Light Phaser) and
  a **mouse** peripheral (Amiga point-and-click) as grabbable, cord-connected,
  net-synced props — see `docs/LIGHTGUN_SUPPORT.md` / `docs/MOUSE_SUPPORT.md`.
- Save states, spatial audio, in-VR menus, a C64/VIC-20 virtual keyboard.
- **Networked multiplayer**: shared room presence, voice, room-object sync,
  and host-authoritative 2-player game streaming — see `docs/MULTIPLAYER.md`.

## Important: no ROMs, no bundled cores

This repo ships **neither game ROMs nor emulator cores**, by design — see
`docs/LICENSING.md`.

- **Cores** (`.wasm`/`.js`) are fetched at build/deploy time, not committed.
  Run `npm run fetch-cores` (see that script for sources). They keep their own
  upstream licenses (`THIRD_PARTY_LICENSES.md`); some are non-commercial.
- **ROMs & BIOS** are copyrighted — supply your own from media you own. The only
  game content here is free / homebrew / public-domain test material; see
  `public/roms/README.md`.

## Quick start

```bash
npm install
npm run fetch-cores      # populates public/cores/ (gitignored) — see script
npm run dev              # http://localhost:5173  (sets COOP/COEP for SharedArrayBuffer)
```

Click **Load ROM** to pick a game, or load a collection/room (see
`docs/ROOM_AND_COLLECTIONS.md`). On Quest, open the HTTPS deploy and tap **Enter
VR**. `npm run debug` runs the headless health-check harness (`DEBUGGING.md`).

Requirements: HTTPS + `Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: require-corp` (handled by `vite.config.js` in dev
and `deploy/` + `public/.htaccess` in prod) so `SharedArrayBuffer` — and thus the
threaded cores — work.

## The big idea: rooms & collections as portable JSON

Instead of EmuVR's opaque binary room saves and per-machine folder scans,
everything here is **open, declarative JSON** that references content by location
(a web URL, or a local folder on your PC / headset) and **never embeds ROMs**:

- a **Collection** (`*.collection.json`) is a library of games (system, core,
  boxart, and a ROM *pointer*);
- a **Room** (`*.room.json`) is the 3D scene + how collections are laid out in
  it (wallpaper, shelves, console, posters, portals to other rooms);
- a room can be **shared as a single file or URL** — free games travel with it,
  your owned games resolve against your own local folder.

Try it: `?room=roms/bedroom.room.json` loads an example room (walk into the
doorway to portal to `arcade.room.json`); `?collection=URL` drops a bare
collection into the default room; or drag a `.room.json` / `.collection.json`
onto the page. With no parameter you get the built-in room.

Full design: `docs/ROOM_AND_COLLECTIONS.md`. Multiplayer plan:
`docs/MULTIPLAYER.md`. EmuVR research that informs all of this:
`docs/EMUVR_RESEARCH.md`.

## Layout

```
LibretroWebXR/
├── index.html              Flat-mode shell (header + canvases)
├── vite.config.js          Dev server with COOP/COEP
├── src/                    The app (Three.js + WebXR, emulator client, input, VR room)
├── scripts/
│   ├── debug.js            Puppeteer health-check harness (see DEBUGGING.md)
│   └── fetch-cores.mjs     Pulls libretro cores into public/cores/ (gitignored)
├── public/
│   ├── cores/              (gitignored) fetched cores
│   └── roms/               manifest + free/homebrew test ROMs only (README inside)
├── deploy/                 Apache config to enable .htaccess COOP/COEP
└── docs/                   ROADMAP, EMUVR_RESEARCH, ROOM_AND_COLLECTIONS, MULTIPLAYER, LICENSING, PROJECT_HISTORY
```

## Picking this up

New to the codebase (or a fresh session)? Read **`docs/HANDOFF.md`** first — it
orients you on state, how to run it, the hard invariants, the architecture map,
and what's next.

## License

Frontend code: **MIT** (`LICENSE`). Cores and ROMs are **not** covered by it —
see `THIRD_PARTY_LICENSES.md` and `docs/LICENSING.md`.

History of the five prototypes this distilled from: `docs/PROJECT_HISTORY.md`.
Where it came from: `PROVENANCE.md`.
