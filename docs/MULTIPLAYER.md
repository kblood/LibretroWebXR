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

Not all of that state is symmetric: the room layout, the shelves and *which game
is on the TV* are **owned by the host** and merely mirrored by everyone else — see
"Host election and the shared room" below. Free-for-all keys (held objects,
avatars) stay last-writer-wins.

- **Transport options:** Networked-A-Frame (if we adopt A-Frame), **Colyseus**
  (server-authoritative rooms + matchmaking, engine-agnostic — good fit with our
  Three.js code), Croquet/Multisynq (replicated computation), or hand-rolled
  WebSocket (state) + WebRTC (voice) for a handful of users.
- **Recommended:** start with a small Colyseus (or plain WebSocket) room server
  for presence + matchmaking; voice over WebRTC.

### Layer 2 — Game sync (the emulator): two viable approaches
Pick per-game; expose both.

1. **Host-authoritative + video stream (v1, easy — this is what ships).** One peer
   runs the core authoritatively, collects remote inputs over the room socket, and
   streams the TV video (plus game audio) to other players. Tolerant of
   non-deterministic cores, minimal emulator changes. Best for co-op / turn-based /
   party games; higher latency for non-hosts. This is what EmulatorJS netplay does.
   *Which* peer is that host is not a detail — getting it wrong is what broke the
   first build, so it is specified separately under "Host election and the shared
   room" below.
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
- **M0 (done):** presence only — shared room, avatars, voice. No game sync (everyone
  watches one player). Immediately fun and validates the room/WebXR netcode.
- **M1 (done):** host-authoritative game sync (stream + remote input) for 2-player
  co-op. **M1.4** then rewrote *who hosts* and *who may run a core* — the section
  after this one is the current design; M1.1/M1.2's original "host = whoever last
  wrote the `tv` state" rule is dead.
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

### "Runs zero cores" is enforced at the runtime layer, not just at the boot gates
Gating every *boot* path is necessary but not sufficient: a peer may already have
been playing (even with a whole multi-console rack up) when it joins, and then the
question is not "may it boot?" but "may it keep running?". Pausing once at join
time is not enough either, because the **performance budget** re-decides which
cores run whenever the user toggles *Auto-pause* or simply looks at a different
TV — and it used to resume everything it found paused, silently handing a watcher
its own live copy of the host's game behind the video feed. That is the original
"each computer runs its own game" bug re-entered through a perf path.

So the role is a **hard gate on the runtime lifecycle**:
- `src/main.js` keeps a **latched** role, `mayRunLocalCore()`. It is latched
  because `isDisplayOnlyClient()` needs a live socket and therefore reads *false*
  during a client's reconnect; the latch is set when the server tells us someone
  else hosts and cleared only by promotion or by leaving the room. It is
  deliberately **not** set while the role is merely undecided — a live host whose
  socket blips must keep emulating.
- `RackMgr` takes that predicate as `allowRun`. `applyBudget()` checks it *first*
  and, when running is denied, **suspends the whole rack** (`{suspended:true}`)
  instead of planning anything. `RackMgr.add()` also pushes the predicate into
  each `ConsoleRuntime` (`setCanRun`), so a **direct** `runtime.resume()` — the
  in-world console power switch, a live reboot — is refused too and re-asserts the
  pause.
- Becoming a client calls `rackMgr.pauseAll()`, i.e. **every** console, not just
  the primary. A pre-existing rack's secondary consoles are inert scenery for a
  watcher; promotion (and leaving) runs `applyBudget()` again to bring them back.
- The desktop client (`src/desktop/main.js`) has the same latch, because its
  `role()` reports `idle` whenever the socket is down or the room is momentarily
  hostless, and the idle branch resumes the core — correct for a host mid-blip,
  wrong for a watcher. The latch is what distinguishes the two, and it is set on
  `connect()` so the pre-`HELLO` gap can't resume a solo game either.
- Observable ground truth, for tests and for debugging on a headset:
  `window.__rack.mayRun()` (false ⇒ display-only) and `window.__rack.live()`
  (**every** entry must then read `live:false`). `window.__desktop.mayRun()` /
  `.paused()` are the desktop equivalents. `scripts/test-rackmgr.mjs` unit-tests
  the gate, including that it fails *open* so solo play can never be bricked.

### ✅ Fixed — the HOST's "Load ROM" button now republishes (M1.4d)

**Fixed 2026-08-04.** Keep the history: this was the reason M1.4 as a whole did not
fully pass verification, and it was the *last* live cause of the user's original
"the screens aren't synced".

**What was wrong.** The invariants above held on the *cartridge* path, which is the
only path the committed smokes drove. They did **not** hold when the host started a
game through a **file picker**. `loadCartridge` was the only boot path that
published `tv` **and** called `net.startVideoBroadcast()` after the canvas swap — in
the whole of `src/main.js` there were exactly **two** `setObjectState('tv', …)`
sites (that one and the promotion branch). Both picker paths — the real `#rom-input`
change handler and `window.__pickLocalRom` — called `bootOnPrimary()` and stopped,
and `bootOnPrimary` live-swaps to a **fresh runtime and a fresh canvas** on a
cross-core pick while publishing nothing and re-capturing nothing. (The
`startVideoBroadcast()` a little further down belongs to `rebootPrimaryConsole`, the
gun/mouse arm-reboot — which is why §4c of the smoke passed while this was broken.)

Two consequences, both silent:

- Every watcher **froze permanently on the previous game** — the retired canvas'
  `captureStream` track stays `readyState:'live'` forever while painting nothing, so
  `sendingCount()==1` and `receivingCount()==1` throughout and every existing
  diagnostic reported "healthy". Worth filing correctly: `VideoMgr`'s canvas-changed
  re-capture was always capable of handling this, it was simply **never invoked** —
  the bug was a missing call in `main.js`, not a `VideoMgr` defect.
- The room's `tv` key kept naming the **previous** game, so a **late joiner** was
  shown the wrong title next to the wrong pixels, and on **host migration** the
  promoted peer booted whatever `tv` still advertised, i.e. the wrong game.

**The fix** (`src/main.js`): the publish/broadcast pair moved **inside**
`bootOnPrimary`, which now ends with `publishTvAndBroadcast(meta)` — a new helper
that, guarded by `amRoomHost()`, does exactly what `loadCartridge` always did:
`net?.setObjectState('tv', {file, core, system, title})` then
`net?.startVideoBroadcast()`. It publishes `meta.core`, **not** the booted core
name, because a light-gun boot may run a different core (SMS → `genesis_plus_gx`)
while the room must still advertise the cart's own core — that value is what a
promoted peer re-boots from. Putting it in the callee rather than in the two callers
closes the whole class: any future primary-boot path re-publishes for free.
`loadCartridge` is the one caller that opts out, with `publishTv: false`, because it
owns its own publish under its `echo` flag (an `echo:false` load is *reflecting* a
remote peer's state and must not bounce a stale value back over a newer overwrite);
its call site is otherwise untouched. Double-calling would in any case be inert —
`NetMgr.setObjectState` drops an unchanged value and `VideoMgr.startBroadcast`
early-outs on an unchanged canvas.

**The test gap that hid it, now closed.** `smoke-shared-game.mjs` §5b drives
`#rom-input` and `__pickLocalRom` **only on the CLIENT** (asserting they are
*suppressed*); no committed test ever pressed that button on the **host**. The new
`scripts/smoke-host-picker.mjs` (`npm run smoke-host-picker`) does, through the real
`input.uploadFile` and not the debug hook, and covers **both** branches of
`bootOnPrimary`: a cross-core pick (a shelf NES cart is `fceumm`, a picked bare
`.nes` detects as `nestopia` → fresh runtime + fresh canvas), a same-core pick (no
swap, so only the stale-`tv` half shows), and a second cross-core pick to
`gambatte`. Its evidence channels are deliberately not "nothing threw": the room's
published `tv` read **on the watcher**, decoded-frame advance on the watcher's
`<video>`, and a coarse 8×6 luminance **correlation between the watcher's TV pixels
and the host's live canvas** sampled at the same moment. It was negative-controlled
against the pre-fix behaviour and seen to go RED — 9 failures, `tv` stuck on the
first cart, `dFrames:0` at the retired canvas' 512×448, correlation −0.09/−0.32 —
versus 28/28 green with the fix and correlation ≈0.99.

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
node scripts/smoke-display-only.mjs --app=http://localhost:<port>/ --ws=ws://localhost:8797/
node scripts/smoke-xr-room-adopt.mjs --app=http://localhost:<port>/ --ws=ws://localhost:8797/
node scripts/smoke-host-picker.mjs  --app=http://localhost:<port>/ --ws=ws://localhost:8797/
```

`smoke-display-only.mjs` is the one that covers a peer which was **already
playing** (with a two-console rack up) before it joined, and then re-asserts the
invariant after every trigger that re-runs the perf budget — the Auto-pause toggle,
a gaze shift, a console power switch, a bare `applyBudget()`. Its ground truth is
distinct frame signatures off each `ConsoleRuntime`'s own canvas, and it
negative-controls itself in the same run by removing the `allowRun` gate from the
page and requiring the watcher's cores to come back to life. If that phase ever
reports no resume, the smoke has gone vacuous.

`smoke-xr-room-adopt.mjs` covers **adoption while the user is in VR**, which used
to be written off as "only a real headset can test this". Adopting the host's room
*live* (the header-widget join path — `?session=` instead hands the room over
before the world is built, and never reaches `_maybeAdoptHostRoomLive`) means
stashing it and **reloading**, which would eject the user from immersive, so it is
deferred with *"Host's room layout differs — leave VR to adopt it"*. Two things
made that message a dead end, both now fixed:
- The one-shot stamp (`sessionStorage['libretrowebxr.roomAdopted']`, there to stop
  a reload *loop*) was claimed **before** the XR check, so the deferral consumed
  the snapshot: leaving VR hit "already handled this snapshot" and the client
  stayed in its own room for the rest of the session. Only a path that actually
  reloads may claim the stamp.
- Nothing retried on XR exit. Adoption is driven by incoming `ROOM` messages and
  the host's watcher only republishes on a real *change*, so the user could follow
  the instruction exactly and still see nothing. `src/main.js` now retries on the
  renderer's `sessionend`.

No headset needed: `isPresenting` is a plain property on three's `WebXRManager`,
which is an `EventDispatcher`, so the smoke overrides the flag from the page and
then dispatches `sessionend` — exactly the two things a headset does to the app.

`smoke-shared-game.mjs` / `smoke-room-inherit.mjs` are the ones that defend the
invariant at the top of this document,
and they drive the REAL app (`window.__insertCartridge`, the `#rom-input` picker,
`__addLocalRom`, a dropped `.collection.json`) rather than the transport, because
a smoke that pokes `setObjectState('tv', …)` directly passes happily while the app
does something else entirely:

- `smoke-shared-game.mjs` — election, room handoff, the client booting **no** core
  by any route (cart insert, file picker, `__pickLocalRom`, rack spawn, peripheral
  arm), that the client's TV really is painting the host feed and the picture's
  **decoded frame count advances** (including across a host live-reboot), and a
  three-peer migration where the junior peer keeps watching the NEW host.
  Note that it only ever drives the file picker on the *client* (to prove it's
  suppressed) — the **host** side of "Load ROM" lives in `smoke-host-picker.mjs`
  below, which exists because that gap hid M1.4d for a whole verification round.
- `smoke-host-picker.mjs` — the HOST pressing "Load ROM" (real `#rom-input`
  `uploadFile`, not `__pickLocalRom`), for both branches of `bootOnPrimary`
  (cross-core swap → fresh runtime + canvas, and same-core re-load). Asserts the
  room's `tv` key as read **on the watcher**, that the watcher's decoded frames keep
  advancing, and that its TV pixels **correlate** with the host's live canvas at the
  same moment (≈0.99 when correct, ≈0 when the watcher is stuck on a retired
  capture). This is the automated form of two-browser manual step 6.
- `smoke-room-inherit.mjs` — an authored host room adopted by a bare-URL client,
  host-only local carts on the client's shelf, the `insert-nack` path, a dropped
  collection inherited through an unfetchable `dropped:` ref, several successive
  room changes, and an in-place room edit with no reload.

### Point the smokes at the DEPLOYED build too — the room server is not in `dist/`
Every script above takes `--app`/`--ws`, so the whole set runs against production:

```
node scripts/smoke-shared-game.mjs  --app=https://dionysus.dk/webxr/libretrowebxr2/ --ws=wss://dionysus.dk/ws/
```

Do it before believing a multiplayer feature is live. `npm run deploy` publishes
`dist/`, and the room server is a long-running process (`npm run deploy-room`,
see `server/README.md`) — so the app and the server can drift apart silently, and
on 2026-08-03 they had, by two months: the live server predated server-side host
election *and* the `wire()` method that carries `insert`/`insert-nack`/peripheral
binds. Locally everything passed; against production `smoke-shared-game` was 41/45
and a migrated watcher stayed frozen at 0 decoded frames indefinitely. A local
`node server/room-server.mjs` is always current and therefore proves nothing about
what the headset connects to.

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
   host's stream, its status line reads `Watching <host>: …`, and its header stays
   `LibretroWebXR · idle`.

   Don't rely on the header alone — it is only a label, and a peer that had booted
   a game *before* joining used to keep the old core's name there while behaving
   perfectly. The authoritative check is in the console:
   `window.__rack.mayRun()` must be `false`, and **every** entry of
   `window.__rack.live()` must read `live:false` (secondary rack consoles
   included). If any console is live on a non-host, the shared-game invariant is
   broken. Re-check it after toggling *Auto-pause* and after looking at a second
   TV — those re-run the perf budget, which is how the invariant was broken once
   before.
3. Host plays the left paddle; client presses up/down → the right paddle wakes up
   and the client is now player 2. Both see the same game.
4. Client grabs a cart off the shelf: the game changes **on the host** (or the
   client is told the host doesn't have it), and the client still runs no core.
5. Close the host's tab. The client is promoted, boots the room's game itself, and
   a third peer keeps watching — now off the new host.
6. Have the HOST start a game with the header's **Load ROM** button instead of a
   cart. The watcher's picture must follow to the new game, and its Now Playing /
   status must name it. **This used to fail** (M1.4d: the watcher froze on the
   previous game forever and a late joiner was told the wrong title) — fixed
   2026-08-04 by moving the `tv` publish + `startVideoBroadcast()` into
   `bootOnPrimary`; see the M1.4d section above. It is covered headlessly by
   `npm run smoke-host-picker`, so this step is now a confirmation on real hardware
   rather than a known-broken case; if it ever regresses, run that smoke first.

Two cosmetic things that read as "the shared screen is broken" on a headset but
aren't:
- **Both peers spawn at the same origin**, so the remote avatar's head/face plane
  sits *at your camera* and occludes most of the TV. Proven by traversing for
  `avatar:*` and hiding it — the picture behind it is clean and correct. Spawning
  joiners at an offset is the real fix; until then, step aside before judging the
  stream.
- `window.__rack.live()` reports `live:true` for a **coreless** runtime on a
  display-only watcher, because `ConsoleRuntime.isLive()` is just
  `!this.client?.paused` (`src/ConsoleRuntime.js:78`). Harmless today only because
  every assertion filters on `r.core && r.live` — keep that filter in any new check.

### Writing a NEW headless MP test — use the automation API, not new one-off hooks

Everything above predates `window.__testApi` (`src/TestApi.js`) and its Node
harness (`scripts/lib/mp-harness.mjs`). **New tests should use those** —
`docs/TEST_AUTOMATION.md` is the reference, and `scripts/demo-automation-api.mjs`
is the worked three-peer example (49 checks, bidirectional, three negative
controls). It exists precisely because the scripts listed above each hand-rolled
their own calls into whatever `window.__*` hook was handy, which is how the
vacuous-green checks catalogued in this document happened.

In particular the API replaces the traps this file keeps warning about:
`rack.running()` instead of `__rack.live()`'s `!paused` (the coreless-watcher
false positive noted just above is *why* it exists), `video.progress()` instead of
`receivingCount()`, `tv.get().kind` instead of reaching into three.js, and
`mp.samePicture()` for the host↔watcher pixel correlation `smoke-host-picker.mjs`
open-codes. The existing scripts still work and were not migrated.

## References
- Test automation surface: `docs/TEST_AUTOMATION.md`
- EmuVR netplay: emuvr.net/wiki/Netplay
- libretro netplay (design to mirror) + browser gap: docs.libretro.com/development/retroarch/netplay/ , github.com/libretro/RetroArch/issues/7186 , /10851
- netplayjs (rollback over WebRTC): github.com/rameshvarun/netplayjs
- EmulatorJS netplay (host-authoritative): emulatorjs.org/docs4devs/netplay
- Networked-A-Frame: github.com/networked-aframe/networked-aframe ; Colyseus: colyseus.io
