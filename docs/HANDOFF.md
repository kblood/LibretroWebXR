# Handoff

Single orientation doc for picking this project up cold. Last updated after
**Phase R.1** (JSON collection layer).

## What this is

**LibretroWebXR** — a browser-based WebXR libretro frontend. Retro console
emulators (via libretro cores compiled to WASM) run inside a 3D room you can
enter in VR (standalone Quest browser or PCVR) or explore on a flat screen.
North star: an open, web-native **EmuVR** — build your own room, curate game
collections, share rooms as data, eventually play together.

- **Repo:** https://github.com/kblood/LibretroWebXR (public, MIT)
- **Local working copy:** `C:\LLM\LibretroWebXR` ← all work happens here
- **Old scratch workspace:** `C:\LLM\Projects\ClaudeTest\LibretroWebXR`
  (historical/reference only — see `PROVENANCE.md`; do not develop there)
- **Deploy target (from prior project):** `https://dionysus.dk/webxr/libretrowebxr/`
  (Apache; COOP/COEP via `deploy/` + `public/.htaccess`). Not yet redeployed
  from this clean repo.

## Current state (works today)

The app is a **working prototype**, not greenfield. Already functional:
3D room, grabbable cartridges on shelves, insert into console → boots on the
in-world CRT TV, ~13 systems, keyboard/gamepad/WebXR-controller input with
per-core RetroPad mapping, save states (memory cards), spatial audio, in-VR
menus. See `docs/ROADMAP.md` "Current state" for the module list.

**Phase R.1 (done)** added a declarative collection layer over that scene
without rewriting it. **Phase R.2 (RomResolver) is next.**

## Get running (Windows / PowerShell)

```powershell
cd C:\LLM\LibretroWebXR
npm install
npm run fetch-cores     # copies cores into public/cores/ (gitignored). Auto-finds
                        # them in the old scratch workspace; else see the script.
npm run dev             # http://localhost:5173  (Vite sets COOP/COEP)
npm test                # 24 pure-logic assertions (systems/ArtResolver/Collection)
npm run debug           # headless-Chrome health check (see DEBUGGING.md)
```

`npm run debug -- --url=http://localhost:5173/ --screenshot=tmp\out.png` then
Read the PNG is the fastest way to *see* the scene. Verdict OK / exit 0 = healthy.
Headless Chrome has no XR runtime, so it always logs "VR NOT SUPPORTED" — that's
expected; real VR needs the Quest/headset on the HTTPS deploy.

## Hard invariants (don't break these)

- **COOP/COEP everywhere.** `crossOriginIsolated` must be `true` or
  `SharedArrayBuffer` vanishes and the threaded cores won't start. Enforced in
  `vite.config.js` (dev) and `deploy/` + `public/.htaccess` (prod).
- **Emulator canvas must be `id="canvas"`.** RetroArch's web input driver
  hardcodes `querySelector('#canvas')`; any other id null-derefs. See
  `DEBUGGING.md`.
- **Ship no ROMs, bundle no cores.** Cores are fetched at runtime
  (`public/cores/` is gitignored); only free/homebrew/PD/CC ROMs ever ship.
  Several cores are non-commercial (snes9x, genesis_plus_gx, picodrive). See
  `docs/LICENSING.md` and `THIRD_PARTY_LICENSES.md`.
- **Core runs on the main thread** via an injected `<script>` / dynamic
  `import()`, NOT in a Web Worker (webretro's worker path is buggy — see
  `DEBUGGING.md` "Architectural lesson"). `XRRafShim` keeps its rAF loop alive
  during a WebXR session.
- **`LICENSE` must stay pure MIT text** (no appended notes) or GitHub stops
  detecting it as MIT. Scope note lives in `THIRD_PARTY_LICENSES.md`.

## Architecture map (where things live)

```
src/
  main.js            Bootstrap + wiring. Loads a collection, builds the room,
                     handles cartridge-insert → load, save-state memory cards.
  systems.js         ★R.1 SYSTEMS (system-first) + CORES (core-first) registry.
                     Single source of truth: cores, exts, folder aliases,
                     thumbnail repos, licenses. coreForFile / systemForFile /
                     systemForName.
  Collection.js      ★R.1 Load/normalize manifest.json (cartridges[]) AND
                     *.collection.json (games[]); auto-fill core + boxart.
  ArtResolver.js     ★R.1 libretro-thumbnails candidate chain (filename → title
                     → tag-stripped) + RetroArch char sanitization. Pure.
  EmulatorClient.js  Main-thread proxy that loads the core + drives it; events
                     ready/error; serializeState/unserializeState.
  SceneMgr.js        Three.js scene, room geometry, WebXR session, TV mesh,
                     render loop. setScreenSource() swaps TV texture source.
  Cartridge/Shelf/Console/Gamepad/MemoryCard.js  Grabbable 3D prop factories.
  GrabMgr / LocomotionMgr / GameInputMgr / InputMgr / ControllerMaps  Input + VR.
  MenuMgr / MenuPanel / ControlsPanel / DebugHud  In-VR UI.
  SaveState.js       IndexedDB save-state store (per slot).
  CrtShader / SpatialAudio / Placeholder / XRRafShim  Effects + shims.
scripts/
  debug.js           Puppeteer health harness (DEBUGGING.md).
  fetch-cores.mjs    Populate public/cores/ from a local source.
  make-c64-demo.mjs  Generate the CC0 C64 BASIC demo .prg.
  test-collection.mjs  npm test — pure-logic assertions for the R.1 layer.
public/roms/
  manifest.json      Default collection (free/homebrew starter pack).
  *.collection.json  Example collection schema (snes-demo).
  freeware/          Shippable ROMs (lwx-demo.prg ships; rest are pointers).
docs/                ROADMAP, EMUVR_RESEARCH, ROOM_AND_COLLECTIONS, MULTIPLAYER,
                     LICENSING, PROJECT_HISTORY, HANDOFF (this file).
```
★ = added in Phase R.1.

## Data model (the project's core idea)

Everything is portable JSON that references content by location, never embeds
ROMs. Full spec: `docs/ROOM_AND_COLLECTIONS.md`. In short:

- **Collection** (`*.collection.json`, `games[]`) = a game library: per game a
  `{ file/rom, system, core?, title, color?, boxart? }`. Core + boxart are
  auto-filled if omitted. Superset of the legacy `manifest.json` (`cartridges[]`).
- **Room** (`*.room.json`) = the 3D scene + how collections lay out in it
  (surfaces, shelves, console, posters, **portals** to other rooms). *Schema
  designed, loader not built yet (Phase R.3).*
- A game entry consumed by `Cartridge.js` keeps fields: `file, system, core,
  title, color, boxart`, plus R.1 extras `boxartList, license, credits, rom`.
- Load a collection at runtime: `?collection=URL` (alias `?room=URL`); default
  is `roms/manifest.json`.

## Roadmap position

`docs/ROADMAP.md` is authoritative. Phases:
- **Phase 0** ✅ clean repo published (MIT, licensing docs, EmuVR research).
- **Phase R — Rooms & Collections as JSON** ← in progress
  - **R.1 ✅ done** — data layer (systems / ArtResolver / Collection; main.js
    refactored; tests; debug harness boxart-404 reclassification).
  - **R.2 ← NEXT** — `src/RomResolver.js`: url / local (File System Access API,
    persisted dir handles in IndexedDB) / pick / opfs. Delivers the user goal of
    referencing **web folders OR local folders on PCs/headsets**. Slots into
    `main.js`'s `romUrl(meta)` (already factored out as the seam).
  - **R.3** — `src/RoomLoader.js`: read `*.room.json`, drive the existing
    factories, apply surfaces/lighting/portals. Load room by URL/drag-drop.
- **Phase E** — in-VR room editor (write back `*.room.json`).
- **Phase M** — multiplayer (`docs/MULTIPLAYER.md`): M0 presence/avatars/voice,
  M1 host-authoritative game sync, M2 rollback, M3 crossplay.
- **Phase C** — open prop package schema, community gallery, BIOS-needing
  systems (PSX/N64), PWA.

## Immediate next actions for R.2

1. `src/RomResolver.js` exposing `resolve(meta) → Promise<ArrayBuffer>` with
   sources url / local / pick / opfs (see `docs/ROOM_AND_COLLECTIONS.md` §2).
2. Persist a user-granted directory handle (File System Access API) in
   IndexedDB; match games by filename + optional sha1; OPFS cache by sha1.
3. Wire it behind `main.js`'s `romUrl()`/`loadCartridge()` seam.
4. Verify File System Access availability on Quest browser (fallback: pick + opfs).
5. Extend `npm test` for the pure parts (filename/hash matching); harness for
   the rest. Keep `npm run debug` verdict OK.

## Gotchas already hit (so you don't re-hit them)

- Box-art 404s against libretro-thumbnails are **expected** (homebrew coverage
  is sparse); the harness reclassifies them as "expected probes". Don't treat
  them as failures.
- Many "freeware" homebrew ROMs have **no explicit redistribution license** —
  the manifest ships *pointers*, only `lwx-demo.prg` (CC0, ours) is committed.
  See `public/roms/README.md` for the verified-license picks.
- `gh` CLI wasn't logged in but git push worked (Windows credential store).
  `gh` was bridged via `git credential fill → gh auth login --with-token`.
- Don't batch a failing shell command with dependent tool calls — a non-zero
  exit cancels the rest of the batch. Run git/verification steps sequentially.

## Memory

A persistent memory note (`canonical-repo-moved`) records that
`C:\LLM\LibretroWebXR` is now canonical and the old path is historical.
