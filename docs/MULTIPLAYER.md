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

## References
- EmuVR netplay: emuvr.net/wiki/Netplay
- libretro netplay (design to mirror) + browser gap: docs.libretro.com/development/retroarch/netplay/ , github.com/libretro/RetroArch/issues/7186 , /10851
- netplayjs (rollback over WebRTC): github.com/rameshvarun/netplayjs
- EmulatorJS netplay (host-authoritative): emulatorjs.org/docs4devs/netplay
- Networked-A-Frame: github.com/networked-aframe/networked-aframe ; Colyseus: colyseus.io
