# Multiplayer — Design

Goal: EmuVR-style "play together in a shared retro room" in the browser —
multiple people in one 3D room, with avatars and voice, playing the same game
together. EmuVR proves the model; we have to rebuild its game-sync layer in JS
because **libretro netplay does not exist in the browser wasm build** (no raw
sockets in Emscripten — libretro issues #7186, #10851).

## Decoupled into two independent layers

EmuVR does exactly this split; we follow it.

### Layer 1 — Presence (the room): avatars, voice, room state
Low-rate, non-deterministic, easy. Sync: avatar head+hands transforms, voice,
nicknames/colors, and **room-object state** (who grabbed which cartridge, TV
on/off, which game is inserted, lighting). This is the social layer and works for
*every* core regardless of determinism.

- **Transport options:** Networked-A-Frame (if we adopt A-Frame), **Colyseus**
  (server-authoritative rooms + matchmaking, engine-agnostic — good fit with our
  Three.js code), Croquet/Multisynq (replicated computation), or hand-rolled
  WebSocket (state) + WebRTC (voice) for a handful of users.
- **Recommended:** start with a small Colyseus (or plain WebSocket) room server
  for presence + matchmaking; voice over WebRTC.

### Layer 2 — Game sync (the emulator): two viable approaches
Pick per-game; expose both.

1. **Host-authoritative + video stream (v1, easy).** One peer runs the core
   authoritatively, collects remote inputs over a WebRTC DataChannel, and
   streams the TV video to other players. Tolerant of non-deterministic cores,
   minimal emulator changes. Best for co-op / turn-based / party games; higher
   latency for non-hosts. This is what EmulatorJS netplay does.
2. **Input-lockstep + rollback (v2, best feel).** Exchange only inputs per
   frame; on divergence, load the last agreed savestate and re-simulate.
   Tiny bandwidth, low latency — how RetroArch/GGPO/EmuVR work. Requires a
   **deterministic core** + **fast save/load-state** (the savestate is the
   rollback snapshot; `src/SaveState.js` already wraps this). netplayjs is the JS
   reference to adapt (its `serialize/deserialize` ↦ libretro savestate, `tick`
   ↦ run one frame with merged inputs).

Both require: a **signaling/matchmaking WebSocket server**, **STUN**, and a
**TURN** relay (effectively mandatory for real-world NAT). We already serve
HTTPS + COOP/COEP, which threaded wasm cores need.

## Hard constraints (inherited from the netplay model)
- All players must have the **same ROM** (hash-checked — we already track
  `sha1` in the collection schema) and a compatible core.
- Not every core/system is netplay-friendly; heavy cores (PSX/N64) cost more.
- Rollback needs determinism + cheap savestates; when a core lacks them, fall
  back to host-authoritative streaming for that game.

## Phasing
- **M0:** presence only — shared room, avatars, voice. No game sync (everyone
  watches one player). Immediately fun and validates the room/WebXR netcode.
- **M1:** host-authoritative game sync (stream + remote input) for 2-player
  co-op.
- **M2:** rollback game sync for deterministic cores.
- **M3:** multiple simultaneous games on different TVs; mid-session join;
  VR↔desktop crossplay (all things EmuVR does).

## Host election and the shared room (M1.4)

**Exactly one core runs in a room, and it belongs to the host.** Everyone else is
a *display-only client*: it never boots a core, it paints the host's video feed on
its in-world TV, and it forwards its input. This is the invariant the whole
multiplayer design now rests on, so it is worth stating what it replaced: the
first M1 build made "whoever last wrote the shared `tv` state" the host. That rule
looks convenient and is wrong in every real session — a joiner who touched the TV
(or merely reloaded at the wrong moment) stole the role from the person actually
running the game, both machines then booted the ROM into their own core, and the
two players ended up in the same room watching two independent games. A joiner
also frequently does not even own the ROM, so it cannot be authoritative.

### Who is the host
- **The server elects it** (`server/Hub.js`, relayed in `HELLO` and in later
  `HOST` messages), by **seniority**: the longest-present peer in the room. The
  first peer in is the host, and it stays the host — nothing a client does can
  take the role.
- **Migration happens only when the host actually LEAVES**, and then the role goes
  to the most senior remaining peer, which boots the room's game itself and takes
  over the broadcast.
- Migration is **deferred by `HOST_RECLAIM_MS`** (15 s). A host that reloads its
  own page (arming a peripheral through the reload bridge, dropping in a new room)
  is gone from the socket for a moment; promoting a client in that window would
  make it boot its own core, which is the exact bug above. The room stays hostless
  instead, and the returning host **reclaims** the role by session id. If it never
  comes back, the timer promotes the senior peer.
- If the deployed room server predates this (it sends no `host`), the clients
  elect one themselves over the persisted state channel
  (`src/net/HostElection.js`): earliest claim by a peer that is still present
  wins, ties broken by the smaller id. A stale client can therefore never end up
  with *no* game rather than a shared one.

### What the host owns
- **The room and the shelves.** The host publishes its serialized room descriptor
  (`room`) plus its shelf (`shelf:collections`, `shelf:local`); every client
  adopts that instead of building its own layout. A host-side watcher republishes
  whenever the room actually changes, so in-place edits (Add mode, a swapped
  shelf, a new poster) reach clients too — not only whole-room loads.
- Those keys are **host-owned server-side**: `Hub.isHostOwnedKey()` rejects
  `tv`/`room`/`shelf:*` writes from anyone but the host (and from everyone during
  a reclaim window) and answers the writer with the authoritative value.
- **Games the host only has locally** still appear on every client's shelf. No ROM
  bytes cross the wire: the host advertises the metadata, the client mints a
  cart marked `rom.source:'host'`, and *inserting* it sends the host an `insert`
  request. The host resolves it against its own library and boots it — or
  **nacks** it (`insert-nack`) when it does not have that file, so a client can
  never make the host try to boot something missing and kill the room's picture.
- **Peripherals** follow the same rule: a client grabbing the light gun or mouse
  cannot reboot a core it does not run, so it forwards a `peripheral` message and
  the HOST attaches the libretro device to the running game. Then the client's
  forwarded aim has somewhere to land.

## Playtesting (M1 host-authoritative is live)

The current build implements M1: the elected **host** runs the core, streams its
TV video (plus the game's audio) to the others over WebRTC, and accepts their
forwarded input as extra players. Only the focused console0 game is shared — the
multi-console patch rack (`docs/ROADMAP.md` Phase RACK) is local to each player.

Two things generalized beyond this section's original scope, both covered in
`docs/ROADMAP.md`'s Phase M: the shared `STATE` channel now also carries
**peripheral bindings** (which gamepad/light-gun/mouse drives which
console/port/player — `GamepadSync.js`/`GunSync.js`/`MouseSync.js`), and
joining **mid-session via the header widget** (not just `?session=` at load)
now wires every subsystem, not only presence. There's also a second Layer-2
client, `desktop.html` (flat-screen only, no VR/avatars), which reuses this
same server/protocol/host-authoritative video path — see
`scripts/verify-desktop-netplay.mjs`.

### Test games
The host-authoritative model only shows its worth with a game that actually
reads **player 2**. Most of our shipped CC0 carts are single-player or vs-CPU, so
they only exercise the *video* half of MP. Two options:

1. **LWX Pong (ships, no download).** The built-in `freeware/lwx-nes-pong.nes` is
   now optional-2-player: the right paddle is CPU until player 2 presses up/down,
   then a human drives it. In a shared room the client's forwarded P2 input
   reaches the host core as controller 1, so both players see the same volley over
   the video stream. This is the zero-setup MP smoke game. (Source:
   `games/nes-pong/main.c`, rebuild with `npm run make-nes-pong`.)
2. **Super Tilt Bro. (download required).** A real 2-player NES fighting game
   (WTFPL). In `roms/homebrew.collection.json`; download
   `super-tilt-bro.nes` into `public/roms/freeware/` and load that wall with
   `?collection=roms/homebrew.collection.json`. Best for a "real game" co-op test.
3. **LWX Bomberman (ships, no download).** Authored CC0 4-player NES cart that
   auto-detects the **Four Score** multitap (falls back to 2-player without
   it) — the test case for the Four Score fix in `docs/ROADMAP.md`'s Phase M.
   `games/nes-bomberman/main.c`, rebuilt via `npm run make-nes-bomberman`.

### Headless verification
The MP transport + host-resolution are covered by smoke tests against a local
room + dev server (start `PORT=8797 node server/room-server.mjs` and `npm run dev`
first):

```
node scripts/smoke-gamesync.mjs     --app=http://localhost:<port>/ --ws=ws://localhost:8797/
node scripts/smoke-object-sync.mjs  --app=http://localhost:<port>/ --ws=ws://localhost:8797/
node scripts/smoke-video.mjs        --app=http://localhost:<port>/ --ws=ws://localhost:8797/
node scripts/smoke-shared-game.mjs  --app=http://localhost:<port>/ --ws=ws://localhost:8797/
node scripts/smoke-room-inherit.mjs --app=http://localhost:<port>/ --ws=ws://localhost:8797/
```

The last two are the ones that defend the invariant at the top of this document,
and they drive the REAL app (`window.__insertCartridge`, the `#rom-input` picker,
`__addLocalRom`, a dropped `.collection.json`) rather than the transport, because
a smoke that pokes `setObjectState('tv', …)` directly passes happily while the app
does something else entirely:

- `smoke-shared-game.mjs` — election, room handoff, the client booting **no** core
  by any route (cart insert, file picker, `__pickLocalRom`, rack spawn, peripheral
  arm), that the client's TV really is painting the host feed and the picture's
  **decoded frame count advances** (including across a host live-reboot), and a
  three-peer migration where the junior peer keeps watching the NEW host.
- `smoke-room-inherit.mjs` — an authored host room adopted by a bare-URL client,
  host-only local carts on the client's shelf, the `insert-nack` path, a dropped
  collection inherited through an unfetchable `dropped:` ref, several successive
  room changes, and an in-place room edit with no reload.

`scripts/test-multiplayer.mjs` (in `npm test`) covers the host-side keycode
injection (`GameInputMgr.setRemoteButton`) and the controller→logical capture;
`scripts/test-net.mjs` covers the election/reclaim/host-owned-key rules in
`server/Hub.js` and `src/net/HostElection.js` as pure units.

### On-headset / two-browser test
1. Host and client open the same URL with `?session=<room>` (e.g.
   `…/?session=pongtest`). They should see each other's avatars (presence), and
   the second one in should be standing in the FIRST one's room, looking at the
   first one's shelf.
2. The first peer in is the host. It boots **LWX Pong**; the client's TV shows the
   host's stream and the client's own status stays `idle` — if the client's header
   names a core, it booted a game of its own and the shared-game invariant is
   broken.
3. Host plays the left paddle; client presses up/down → the right paddle wakes up
   and the client is now player 2. Both see the same game.
4. Client grabs a cart off the shelf: the game changes **on the host** (or the
   client is told the host doesn't have it), and the client still runs no core.
5. Close the host's tab. The client is promoted, boots the room's game itself, and
   a third peer keeps watching — now off the new host.

## References
- EmuVR netplay: emuvr.net/wiki/Netplay
- libretro netplay (design to mirror) + browser gap: docs.libretro.com/development/retroarch/netplay/ , github.com/libretro/RetroArch/issues/7186 , /10851
- netplayjs (rollback over WebRTC): github.com/rameshvarun/netplayjs
- EmulatorJS netplay (host-authoritative): emulatorjs.org/docs4devs/netplay
- Networked-A-Frame: github.com/networked-aframe/networked-aframe ; Colyseus: colyseus.io
