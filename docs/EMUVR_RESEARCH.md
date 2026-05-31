# EmuVR Research

Research compiled 2026-05-31 to inform LibretroWebXR's room, collections, and
multiplayer design. EmuVR (https://emuvr.net) is the closest existing thing to
what we want — but it is a **Windows-only, closed-source Unity desktop app**
(PCVR, not standalone Quest). LibretroWebXR aims to bring the same experience to
the **browser** (desktop + Quest), open-source and shareable.

Sources are cited inline. The official wiki sits behind Cloudflare; several
findings were sourced via the Wayback Machine, a community GitHub wiki mirror,
and search excerpts. Uncertainty is flagged.

---

## 1. The Room / Environment

**What a "room" is.** A single fixed-geometry 1980s/90s bedroom (4 walls, floor,
ceiling, window, bed). Users **decorate** it; they don't model new geometry.
Customization = (a) placing grabbable props/TVs/consoles by hand, (b) swapping a
fixed set of surface textures, (c) saving the arrangement to a numbered slot.

**Saving.** Menu → Settings → Save/Load Room. A Default Room slot + 35 save
slots. "New" on an empty slot can seed with/without TVs, objects, random
consoles, games (uncheck all = empty room). A save stores objects, time of day,
season, and power states — **not** in-game ROM progress. Last slot auto-loads.

**On-disk layout** (under the install dir `EmuVR\`):
```
EmuVR\
  Games\<MediaName>\<Game>\<Game>.<ext>     # user ROMs (BYO)
  Saved Data\Rooms\                          # room saves + exported pixel-art thumbnail PNGs
  Custom\
    Labels\<MediaName>\                       # cartridge/CD art (PNG/JPG)
    Posters\ 01.png .. 31.png                 # numbered preset poster slots
    Misc\                                     # surface textures + .txt sidecars
    UGC\<PropName>\                           # community props: .fbx + .json + textures
```

**Formats.**
- **Room saves are opaque/binary and undocumented** (each save also exports an
  isometric pixel-art thumbnail PNG; community reports "2 files per room"). This
  is EmuVR's biggest weakness for sharing — rooms aren't diffable or portable as
  data; "sharing a room" is effectively sharing a screenshot.
- **Surface textures** are plain images at fixed names in `Custom\Misc\`
  (`wallpaper.png`, `floor.png`, `ceiling.png`, `bed_sheet.png`, `pillow.png`),
  each with a **sibling `.txt`** controlling tiling/offset (`tiling_x`,
  `tiling_y`, offset). Advanced PBR maps supported via name suffixes
  (`*_normal`, `*_glossiness`, `*_roughness`, `*_emissive`), and per-wall
  variants (`wallpaper_f/_b/_l/_r.png`, `_f` = window wall).
- **UGC props** are per-prop folders: `.fbx` model + a `.json` config (system +
  media settings) + textures. The exact `.json` schema is **Discord-gated**
  (the "UGC DevKit") and not public.

**Editor / scripting.** The base game has **no room editor**. The only real
editor/scripting/portals layer is a third-party mod stack — **WIGUx** on
**MelonLoader** — which adds a Room Manager, a Content Manager, **portals**
(props that load other rooms), and **compiled .NET (DLL) modules** for scripting
(not Lua/JSON). Heavyweight and closed.

**Tech.** Unity engine; emulation is **RetroArch/libretro** (historically pinned
to RetroArch 1.7.5), with cores rendered onto in-world CRT/TV surfaces. ~90+
systems. Freeware, not open-source.

Sources: emuvr.net/wiki (Customization, Room_Saving, Installation_Guide, FAQ) via
Wayback + github.com/madelk/EmuVR/wiki mirror; WIGUx docs (archive.org,
modworkshop.net); MelonLoader (github.com/LavaGang/MelonLoader).

---

## 2. Game Library / Collections / ROM Linking

**Organizing unit = a per-system folder.** Each top-level folder under
`EmuVR\Games\` is one console; its games spawn as physical cartridges/discs for
that console's 3D model. There is **no** cross-system "favorites/themed
playlist" concept — the folder *is* the collection. Folders can be named
anything; recognizable names improve auto-detection. Subfolders are scanned.

**Linking mechanism = the "Game Scanner" desktop tool.**
1. Update Core Data → 2. Attempt Autofill (matches folder names against known
aliases, e.g. "PS1/PSX/PlayStation", "SNES/Super Nintendo/Super Famicom",
assigns most-probable **Media** + **Core**) → 3. add folders manually if missed
→ 4. per-folder **Media** + **Core** dropdowns → 5. Download Missing Cores →
6. Scan. Many differently-named folders can map to the same Media.

**Per-folder core + input overrides.** Each folder gets one Media + one Core
(Media auto-picks the fastest core, overridable). Per-folder Core Options
override input modes (Light Gun / Keyboard / Mouse). BIOS goes in
`RetroArch\system\`. EmuVR's own scanner output format is **undocumented**
(third-party tooling hints at `system.cfg` + per-folder `emuvr_core.txt`
markers). EmuVR ships a patched RetroArch 1.7.5 but users never touch `.lpl`
files directly.

**Art matching (the clever, reusable part).** Cartridge/CD labels live in
`Custom\Labels\<Media name>\` as PNG/JPG. A label is matched to a game by:
1. ROM **filename**, then 2. **detected name**, then 3. a **tag-stripping
fallback** — strip anything in `()`/`[]` from both sides and retry, so one
`Super Mario Bros 3.png` matches `... (USA)`, `... (Japan) [!]`, etc. Special
chars `\ / : * ? " < > |` → `_`. This is the same scheme RetroArch uses for
thumbnails, and it's worth copying verbatim.

**Media sourcing.** Community label packs (Google Sheets curated on Discord);
the standard free corpus is **libretro-thumbnails**
(https://thumbnails.libretro.com, per-system repos under
github.com/libretro-thumbnails) with Named_Boxarts / Named_Snaps / Named_Titles.
LibretroWebXR's `public/roms/manifest.json` already uses these boxart URLs.

**Reusable `.lpl` JSON shape** (RetroArch playlist, JSON since 1.7.5):
```json
{ "version": "1.0", "items": [
  { "path": "...", "label": "Alien Arena", "core_path": "DETECT",
    "core_name": "DETECT", "crc32": "01ACE2AB|crc", "db_name": "MAME 2003-Plus.lpl" } ] }
```

Sources: emuvr.net/wiki (Installation_Guide, Customization);
docs.libretro.com/guides/roms-playlists-thumbnails/; github.com/libretro-thumbnails;
EMVRLabelManager (community).

---

## 3. Multiplayer

**EmuVR's model (shipped Dec 2020, v1.0.9 "Netplay Update").** Two layers
stacked:
1. **Game sync = RetroArch's own netplay** (P2P, GGPO-style rollback). Everyone
   needs the **exact same ROM** (hash-checked) and a compatible core. EmuVR adds
   automatic core syncing (host pushes the needed core to clients). Heavy cores
   (PSX) sharply raise CPU/RAM with netplay on.
2. **Room/presence/social = EmuVR's own layer.** Avatars (with a visor,
   nickname, color), **built-in voice chat** (auto voice-detection), and full
   room-state sync (textures, posters, objects, cartridge inserts, cables,
   lights, time/season, light guns, music/video). Host clicks **Host**, shares
   an **Address Code**, friends **Join** (P2P, no central game server). Anyone
   can "grab the controller" as P1/P2/... up to what the game supports; multiple
   games can run on different TVs at once; VR↔2D crossplay; mid-session join;
   experimental host→client video streaming. Host can kick.

**Browser reality for LibretroWebXR.**
- **libretro netplay does NOT work in the browser/Emscripten build** — the wasm
  build has no raw-socket networking (libretro issues #7186, #10851). We cannot
  flip it on; we must sync at the JS layer.
- **Two emulator-sync options over WebRTC DataChannels** (+ WebSocket signaling
  + STUN/**TURN**):
  - **Input-lockstep + rollback** (the "proper" way; netplayjs is the JS
    reference). Tiny bandwidth, low latency. Needs a deterministic core + fast
    savestates (savestate = the rollback snapshot). Hard to bolt onto a
    non-cooperating wasm core.
  - **Host-authoritative + video stream to players 2+** (EmulatorJS's approach).
    Easy, tolerant of non-deterministic cores, fine for co-op/turn-based/party,
    but higher latency for non-hosts. Good "v1" path.
- **Presence/avatars/voice in WebXR is a separate, easier problem** — sync
  low-rate avatar transforms + voice + room-object state via Networked-A-Frame,
  Colyseus, Croquet/Multisynq, Photon, or hand-rolled WebSocket+WebRTC.
- **Decouple the two layers** (exactly as EmuVR does): a server-authoritative
  room/presence layer + a separate WebRTC emulator-sync channel. Infra needed
  regardless: a signaling/matchmaking WebSocket server and a TURN server; HTTPS
  + COOP/COEP for threaded wasm cores (we already require these).

Existing browser references: EmulatorJS netplay (host-authoritative video),
netplayjs (rollback over WebRTC), PSX Party (WebRTC PS1), RetroArch web player
(shows netplay is absent in wasm).

Sources: emuvr.net/wiki/Netplay & 2020/12/17 blog; libretro netplay docs +
issues #7186/#10851; emulatorjs.org/docs4devs/netplay; github.com/rameshvarun/netplayjs;
github.com/networked-aframe/networked-aframe; Colyseus/Croquet docs.

---

## 4. What LibretroWebXR should copy, fix, and add

**Copy (proven):**
- Per-system "collection = folder/list" model, with a Media→Core registry and
  folder-name aliases for auto-detection.
- The art-matching fallback chain (filename → detected name → tag-stripped),
  sourcing boxart from libretro-thumbnails.
- The two-layer multiplayer split (game-sync vs presence/voice).
- Surface customization by named asset + small config (their `.txt` sidecar → a
  JSON field for us).

**Fix EmuVR's weaknesses (our advantages):**
- **Rooms as portable JSON**, not opaque binaries — diffable, shareable as a
  single file or URL, hostable on the web. This is the headline upgrade.
- **A built-in declarative room editor** + JSON "portals/links" between rooms,
  instead of EmuVR's closed compiled-DLL mod.
- **Documented, open prop/package schema** (EmuVR's UGC `.json` is Discord-gated).
- **Standalone Quest + any WebXR browser**, zero install, vs Windows-PCVR-only.

**Add:**
- Reference rooms/collections by **URL** (web folders) *or* local folders /
  headset storage — see `docs/ROOM_AND_COLLECTIONS.md`.
- A shareable-room link format and a community gallery path.
