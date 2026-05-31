# Rooms & Collections — Design

This is the system the project is being built around: an **EmuVR-style virtual
room and game collection, expressed entirely as portable JSON**, so that a room
+ its games can be shared as a single file or URL, hosted on the web, or pointed
at local folders on a PC or VR headset — **without ever shipping ROMs**.

EmuVR's equivalent is an opaque binary room save plus a per-machine folder scan
(see `docs/EMUVR_RESEARCH.md`). Our headline difference: **everything is open,
declarative JSON that references content by location rather than embedding it.**

---

## 1. Three layers

```
Room (.room.json)  ── references ──▶  Collection(s) (.collection.json)  ── resolves ──▶  ROM sources
   geometry, surfaces,                  list of games: system, core,                     URL | local folder |
   props, shelves, lighting,            title, boxart, rom pointer                        file picker | OPFS cache
   placements, portals
```

- **Collection** = a library of games (EmuVR's "per-system folder", generalized
  and cross-system). Pure metadata + pointers. Shippable and shareable.
- **Room** = the 3D scene + how a collection is laid out in it (which shelf, what
  wallpaper, where the console sits). References collections by id/URL.
- **ROM source** = where the actual game bytes come from at play time. Resolved
  per-game, never committed.

The current `public/roms/manifest.json` (a `cartridges[]` array of
`{file, system, core, title, color, boxart}`) is the seed of the Collection
format and stays backward-compatible.

---

## 2. Collection schema (`*.collection.json`)

```jsonc
{
  "schema": "libretrowebxr/collection@1",
  "id": "homebrew-starter",
  "title": "Homebrew Starter Pack",
  "author": "you",
  "boxartBase": "https://raw.githubusercontent.com/libretro-thumbnails/",
  "games": [
    {
      "id": "micro-mages",
      "title": "Micro Mages",
      "system": "nes",
      "core": "nestopia",               // optional; else auto-detect from ext
      "rom": {
        "source": "url",                // url | local | pick | opfs
        "url": "https://example.org/roms/micromages.nes",
        "sha1": "…",                    // optional integrity + savestate keying
        "size": 40960
      },
      "boxart": "Nintendo_-_Nintendo_Entertainment_System/master/Named_Boxarts/Micro%20Mages.png",
      "color": "#3a6a8a",               // cartridge tint fallback when no boxart
      "license": "freeware",            // freeware | public-domain | cc-by | owned | unknown
      "credits": "Morphcat Games"
    }
  ]
}
```

### ROM source resolution (`rom.source`)
The same game entry can be fulfilled four ways, tried in declared order or by
explicit `source`:

| source | Meaning | Browser API | Notes |
|---|---|---|---|
| `url` | Fetch from the web | `fetch()` | Must be CORS-enabled + COEP-compatible (`Cross-Origin-Resource-Policy`). Only legal for free/public-domain/owned-and-self-hosted content. |
| `local` | A folder the user granted access to (a "ROMs library" on their PC/headset) | **File System Access API** (`showDirectoryPicker`, persisted handle in IndexedDB) | This is our answer to "reference local folders on people's computers or VR headsets." Match files by `rom.path`/filename + `sha1`. |
| `pick` | One-off file picker | `<input type=file>` | Always-available fallback; nothing persisted unless cached. |
| `opfs` | Origin-Private File System cache | OPFS | Where fetched/picked ROMs get cached between sessions, keyed by `sha1`. |

**"Web folders" vs "local folders" (the user's two requested modes):**
- *Web folder*: a `collection.json` whose games use `source: "url"`, hosted
  anywhere (GitHub Pages, the deploy server, IPFS). Loading the collection =
  fetching one JSON; ROMs stream on demand.
- *Local folder*: the user picks a directory once via the File System Access API;
  we persist the handle and resolve `source: "local"` games against it by
  filename/hash. Re-granting is one click on return visits. On Quest, the
  browser's File System Access support is the gating factor (verify per release;
  `pick` + `opfs` is the guaranteed fallback).

### Art matching (ported from EmuVR/RetroArch)
When `boxart` is omitted, resolve against **libretro-thumbnails** by trying, in
order: (1) ROM filename, (2) game title, (3) title with `()`/`[]` tags stripped.
Apply `\ / : * ? " < > |` → `_`. One image then covers all regions.

### System → core registry
A single `src/systems.js` table maps a canonical `system` id to: display label,
default core, allowed cores, ROM extensions (auto-detect), folder-name aliases
(for scanning local folders), and the libretro-thumbnails repo name (for art).
This is today's `CORES` map in `src/main.js`, refactored and inverted to be
system-first. Cores themselves are fetched at runtime (see `docs/LICENSING.md`).

---

## 3. Room schema (`*.room.json`)

```jsonc
{
  "schema": "libretrowebxr/room@1",
  "id": "my-bedroom",
  "title": "My 90s Bedroom",
  "author": "you",
  "collections": ["homebrew-starter", "https://example.org/snes.collection.json"],
  "environment": {
    "preset": "bedroom",              // built-in geometry preset
    "surfaces": {
      "wallpaper":  { "texture": "url|builtin:retro-blue", "tiling": [2, 2] },
      "wallpaper_f":{ "texture": "…" },          // per-wall override (EmuVR-style)
      "floor":      { "texture": "…", "tiling": [4, 4] },
      "ceiling":    { "texture": "…" }
    },
    "lighting": { "timeOfDay": "evening", "lamps": [ { "pos": [1,1.6,-2], "color": "#ffd9a0" } ] }
  },
  "props": [
    { "type": "shelf",   "id": "shelf-1", "pos": [-2,0,-3], "rot": [0,90,0],
      "collection": "homebrew-starter", "filter": { "system": "nes" } },
    { "type": "console", "id": "nes-1",   "pos": [0,0.4,-2], "system": "nes" },
    { "type": "tv",      "id": "tv-1",    "pos": [0,1.0,-3], "size": 27, "shader": "crt" },
    { "type": "poster",  "id": "p-01",    "slot": 1, "texture": "url|builtin:poster-1" },
    { "type": "model",   "id": "plant",   "asset": "url-to.glb", "pos": [2,0,-2] }
  ],
  "portals": [
    { "id": "door", "pos": [3,0,0], "rot": [0,-90,0], "target": "https://example.org/arcade.room.json" }
  ]
}
```

- **Surfaces** map directly onto the existing room mesh in `src/SceneMgr.js`
  (which already builds an enclosed room) and the CRT material in
  `src/CrtShader.js`.
- **Props** reuse the existing `Cartridge`, `Shelf`, `Console`, `Gamepad`,
  `MemoryCard` factories — a room file becomes a declarative front-end over the
  builders that `src/main.js` currently calls imperatively.
- **Portals** = EmuVR's killer mod feature, but native and declarative: a prop
  that loads another room (local id or URL) when entered. Enables multi-room
  worlds and a shareable web of rooms.

---

## 4. Sharing model (our advantage over EmuVR)

EmuVR "shares a room" as a screenshot. We share **real data**:

- **By URL:** `https://app/?room=https://example.org/my.room.json` loads a room
  (and its referenced collections) directly. ROMs resolve per each user's own
  sources (their owned local folder, or free `url` games that travel with the
  collection).
- **By file:** drag a `.room.json` / `.collection.json` onto the page.
- **Gallery:** a community index is just a list of room/collection URLs.
- **Safety:** room/collection JSON never contains ROM bytes. A shared room with
  `source: "owned"`/`local` games shows empty cartridge slots to anyone who
  doesn't own the game; free `url` games just work. This keeps sharing legal.

---

## 5. How this maps onto the current code (refactor path)

| Today (imperative, in `src/main.js`) | Target (declarative) |
|---|---|
| `CORES` map keyed by core name | `src/systems.js` keyed by canonical system id; cores fetched at runtime |
| `public/roms/manifest.json` `cartridges[]` | `*.collection.json` (superset; old manifest still loads) |
| `createShelf/createCartridge/createConsole(...)` called directly | a `RoomLoader` that reads `*.room.json` and calls the same factories |
| ROM via `<input type=file>` only | `RomResolver` with url / local (File System Access) / pick / opfs |
| Boxart URL hand-written per game | `ArtResolver` with the libretro-thumbnails fallback chain |

None of this requires throwing away current code — it's a thin declarative layer
(`RoomLoader`, `Collection`, `RomResolver`, `ArtResolver`, `systems.js`) over the
builders that already exist. See `docs/ROADMAP.md` Phase R.
