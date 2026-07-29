# Headset light-gun validation plan (Quest)

Status: **PENDING** — the light-gun feature (G1) is proven HEADLESSLY only. This is
the concrete plan for a human to validate it on a physical Meta Quest. It requires
the headset, a controller in hand, and someone willing to enter VR — none of which
the headless harness can do (controller pose, trigger feel, latency, framerate, and
the arm-on-grab page-reload-in-XR behaviour are all unverifiable without it).

Background on how the loop works lives in
[`docs/LIGHTGUN_SUPPORT.md`](LIGHTGUN_SUPPORT.md); the code is
[`src/LightGun.js`](../src/LightGun.js) (the prop) and
[`src/LightGunMgr.js`](../src/LightGunMgr.js) (the per-frame aim → `sendLightgun`).

---

## 1. Setup

### Load the deployed build

1. On the Quest, open the browser and go to:

   ```
   https://dionysus.dk/webxr/libretrowebxr2/
   ```

   Verified live on 2026-07-29 carrying all six gun-patched cores (nestopia,
   snes9x, genesis_plus_gx, play, mupen64plus_next, mednafen_psx_jit — each
   confirmed byte-identical to the locally-tested build). Remote logging
   auto-enables on the `dionysus.dk` host over HTTPS, see
   [`src/Logger.js`](../src/Logger.js) `_detectServerUrl`.
2. Wait for the room to load (console + TV rack visible on a flat screen).
3. Note the **log session id** — see below. It is *not* always the room id.
4. Press **Enter VR** and put the headset on if you took it off. You should be
   standing in the room with the TV(s) and the desk; the light-gun prop rests on
   the desk to the **left of the console** (orange/grey pistol, barrel pointing
   down-range).

### Where to read logs (you cannot see the Quest console)

The app auto-ships structured logs to the server when running on `dionysus.dk`.
Read them live from a PC browser at:

```
https://dionysus.dk/logs?session=<room>
```

**Finding the right `<session>` — read this, it is the #1 way to waste a session.**
If you joined a multiplayer room, `<session>` is the room id. **If you are testing
solo (the normal case), it is NOT `default`** — `Logger.init()` rewrites `default`
to a stable per-device `solo-<clientId>` so one device's telemetry is not buried in
a shared bucket ([`src/Logger.js`](../src/Logger.js) `soloSession()`). Pointing the
viewer at `?session=default` will show an empty page and look like logging is broken.

Three reliable ways to get it right:

- **Easiest:** open `https://dionysus.dk/logs` with **no** `?session=` — it shows
  *all* sessions, with a dropdown listing live ones. Pick yours.
- The app logs its own read URL as its first line:
  `[Logger] remote logging active → … | session=… | read: …`. Find it in the
  all-sessions view.
- Raw JSON for scripting/grep: `https://dionysus.dk/logs.json?session=<session>`.

Endpoints verified working 2026-07-29 (ingest `POST /log` → `204`, entries read
back and still present 45s later). Note the paths differ: **`/log`** (singular)
ingests, **`/logs`** serves the viewer. Retention is an in-memory ring, so read
the logs while or shortly after testing — do not leave it until the next day.

- Logging is `logger.event(name, fields)` → JSON entries (see
  [`src/Logger.js`](../src/Logger.js)). Generic events include `boot-attempt`,
  `rom-resolved`, `console-loaded`, `boot-error`, `input`.
- **Gun-specific telemetry now exists** — six events, listed in §4. You are no
  longer validating by eye alone; a spotter can confirm aim, fire and port
  routing from the log stream. Two events (`lightgun-release`, `lightgun-mgr-init`)
  are still missing, so a *silent* log does not by itself prove nothing happened.
- Tip: have a second person at the PC with the `/logs` page open while the tester
  is in the headset, calling out what events arrive (or do not).

### Recommended crew

- 1 tester in the headset.
- 1 spotter at a PC: watches `/logs?session=<room>` AND, ideally, a cast/mirror of
  the headset view (Quest casting) so they can see where the in-game crosshair
  actually lands vs. where the tester says they are pointing.

---

## 1.5 Session script — run these in this order

§2 is the exhaustive matrix and is more than one sitting. This is the ordered
short list: it front-loads the checks that can only be answered in a headset and
that nothing else in the project covers. **Stop and write down what you saw after
each step** — a partial run of steps 1–4 is far more useful than a rushed sweep.

| # | Step | Why it is first | Pass looks like |
|---|---|---|---|
| 1 | Boot the build, enter VR, open the all-sessions log view and confirm your session appears | If logging is not flowing, every later step becomes unverifiable hearsay | `[Logger] remote logging active` line visible |
| 2 | Grab the gun prop, point at the TV, fire a few shots at an **NES** Zapper game | The best-understood path; if this is wrong, something broad is broken and the exotic systems will only confuse | `lightgun-grab`, then `lightgun-aim`/`lightgun-fire` events |
| 3 | **PSX GunCon** (`?experimental=1`) — single gun, aim + fire | **Highest value in the whole document.** PSX is the only worker-execution gun system; its in-VR routing hop (`LightGunMgr._portForGun → libretroGunPortFor → sendLightgun`) has never been exercised by any automated test | Shots register; `lightgun-aim` shows `path: "multiport"` |
| 4 | **PSX two-gun** — second gun, both players firing | Newly enabled 2026-07-29; headless-verified only | **Both ports report `path: "multiport"`**; ports do not cross-talk |
| 5 | Aim accuracy sweep — corners + centre (§2c) | Needs a human eye; headless cannot judge "where it actually points" | Crosshair lands where the barrel points |
| 6 | Arm-on-grab page reload in XR (§2b) | Known wrinkle; only reproducible in a real XR session | Session recovers, gun still works after reload |
| 7 | Feel — latency, jitter, framerate (§2f) | Subjective by definition | No perceptible lag; framerate holds |

**If you only have ten minutes, do steps 1–4.** Steps 3 and 4 are the ones that
would change project decisions; 5–7 refine confidence in something already
believed to work.

Two cautions carried over from the headless work:

- The gun and mouse are **armed on grab, and arming reboots the core.** A reload
  mid-session is expected behaviour, not a crash (§2b).
- A green log line proves the *app* dispatched the event. Whether the *core*
  registered the hit is only visible on screen — which is why step 2 uses a game
  whose hit feedback you can recognise instantly.

---

## 2. Test matrix

Run each row per system where noted. For each: follow **Steps**, compare to
**Expected**, mark **Pass/Fail**, and record **Notes** (especially any mismatch
between where you point and where the hit lands).

Systems & guns under test (from `docs/LIGHTGUN_SUPPORT.md`):

| System | Core | Gun | Gun port (0-based) |
|---|---|---|---|
| NES | nestopia | Zapper | 1 (player 2) |
| SNES | snes9x | Super Scope | 1 (player 2) |
| SNES | snes9x | Justifier **2-gun** | both on port 1 (chained, device ids 516/772) |
| Genesis | genesis_plus_gx | Menacer | 1 (player 2) |
| SMS | genesis_plus_gx | Light Phaser | 0 (player 1) — shares the pad port |
| PSX | mednafen_psx_hw | GunCon | 0 (player 1) |
| PSX | mednafen_psx_hw | GunCon **2-gun** | 0 **and** 1 (one gun per native port) |
| PS2 | play | GunCon2 | 0 (player 1) |

**PSX/PS2 are behind `?experimental=1`** in the shipped UI (`src/systems.js`) —
append it to the URL or these systems will not appear.

**PSX is the highest-value row on this page.** It is the only
*worker-execution* gun system, so it exercises a completely different code path
(`EmulatorWorkerRuntime.forwardLightgun`) from every other row above, and its
in-VR routing hop — `LightGunMgr._portForGun` → `libretroGunPortFor` →
`sendLightgun` — has **never been exercised for PSX by any test**. The headless
probes drive `window.__client.sendLightgun` directly and bypass it entirely.
A headset session is currently the *only* way to cover that path.

Two-gun rows need **two** physical controllers held as two guns, on one
console. What you are checking is that each gun has its **own** aim: if both
crosshairs move together, that is a real bug — file it (see §3).

### 2a. Prop / grab behaviour

| # | Test | Steps | Expected | Pass/Fail | Notes |
|---|---|---|---|---|---|
| G1 | Gun is present | Enter VR, look at the desk left of the console | The orange/grey light-gun prop is visible resting on the desk | | |
| G2 | Grab attaches to hand | Reach to the gun, grip-grab it | Gun snaps to the hand and follows hand motion 1:1; barrel leads (points away from you) | | |
| G3 | Held highlight | While holding, observe the body | Body shows the held emissive tint (`setHeld(true)` → blue-ish glow); turns off on release | | |
| G4 | Follow / no drift | Wave the gun around, rotate the wrist | Muzzle tracks the hand with no lag/snap-back; cord anchor stays at the grip base | | |
| G5 | Which hand | Repeat G2 with the **other** hand | Grabs and follows identically in either hand | | |
| G6 | Two-handed | Try to grab with both hands / pass hand-to-hand | Document actual behaviour (single grab expected); note any glitch | | |
| G7 | Release | Open grip | Gun drops/returns, held highlight clears | | |

### 2b. Arm-on-grab page reload (KNOWN WRINKLE — verify recovery)

Picking up the gun calls `armLightGunAndReload()`
([`src/main.js`](../src/main.js)) which **reloads the page** to re-boot the core
with the gun device attached. On a Quest this **ends the immersive XR session**.

| # | Test | Steps | Expected | Pass/Fail | Notes |
|---|---|---|---|---|---|
| A1 | Arm triggers reload | With a gun-capable game running, grab the gun | Page reloads; immersive session drops (you fall back to the 2D page / "Enter VR") | | |
| A2 | Clean re-entry | After reload, press Enter VR again | Re-enters VR cleanly; the **same** game is running (ROM + title preserved), room edits preserved | | |
| A3 | Gun connected after reload | In the re-entered session, pick up the gun (if not already armed) and aim+fire | Gun is now connected — aim moves the in-game crosshair and the trigger registers a hit (it did NOT before arming) | | |
| A4 | No re-reload loop | Grab the gun again after it is already armed | No second reload (already armed → early-return); session stays put | | |
| A5 | Time-to-recover | Stopwatch the reload→playable gap | Note seconds lost; flag if the session is awkward/unrecoverable on the headset | | |

### 2c. Aim accuracy (per system)

For each system, load a gun game (or the Zapper/Super Scope test ROM), arm the
gun, and aim at these screen regions. A spotter watching the cast confirms where
the in-game crosshair/hit lands. Aim accuracy depends on the CRT barrel-curve
correction in `surfaceUvToCanvasUv()` — **corners are the most likely to mismatch.**

Repeat the block per system (NES / SNES / Genesis / SMS):

| # | Region | Steps | Expected | Pass/Fail | Notes |
|---|---|---|---|---|---|
| C1 | Centre | Point the muzzle at the dead centre of the TV | In-game crosshair sits at screen centre, on the muzzle line | | |
| C2 | Top-left corner | Aim at the top-left corner | Crosshair lands in the top-left corner (watch for curve-induced offset) | | |
| C3 | Top-right corner | Aim at the top-right corner | Crosshair lands top-right | | |
| C4 | Bottom-left corner | Aim at the bottom-left corner | Crosshair lands bottom-left | | |
| C5 | Bottom-right corner | Aim at the bottom-right corner | Crosshair lands bottom-right | | |
| C6 | Top edge mid | Aim at the middle of the top edge | Crosshair at top-centre | | |
| C7 | Bottom / left / right edge mids | Aim at each remaining edge midpoint | Crosshair tracks each edge midpoint | | |
| C8 | Distance | Step back ~1 m and repeat centre + one corner | Aim stays accurate at range (longer ray, same hit) | | |
| C9 | Off-angle | Aim from the side of the TV, not straight on | Hit still maps correctly (no skew) — note any error | | |

> **Recording the offset:** when a hit is off, note the region AND the direction/
> magnitude of the error (e.g. "TL corner: crosshair ~5% inward/down"). A
> consistent corner-inward bias points at the `curvature` constant
> (`DEFAULT_CURVATURE = 0.18`) not matching the actual CRT shader curvature on the
> headset.

### 2d. Trigger / fire (per system)

| # | Test | Steps | Expected | Pass/Fail | Notes |
|---|---|---|---|---|---|
| T1 | On-screen hit | Aim at a target on-screen, pull the controller trigger (button 0) | Muzzle flash + trigger depress on the prop; the game registers a **hit** at that point | | |
| T2 | Rising-edge flash | Hold the trigger, then release and pull again | Flash pops on each fresh pull (rising edge), not continuously | | |
| T3 | Trigger feedback | While holding trigger | Prop trigger tab depresses + lights (`setTriggered(true)`) | | |
| T4 | Miss | Aim at empty screen area and fire | Game registers a shot/miss at that point (no hit) | | |

### 2e. Off-screen reload (per system)

Off-screen / wrong-console aim sends `sendLightgun(-1,-1,trigger)` = a reload.

| # | Test | Steps | Expected | Pass/Fail | Notes |
|---|---|---|---|---|---|
| R1 | Off-screen reload | Point the gun **away** from the TV (at the floor/wall) and pull the trigger | The game treats it as a **reload** (gun-game-specific: ammo refills / reload animation), not an on-screen shot | | |
| R2 | Wrong-console | (Multi-console rack only) Aim at a TV showing a **different** console than the gun is plugged into, and fire | Treated as off-screen/reload — does NOT hit the other console's game | | |
| R3 | Edge re-acquire | Sweep from off-screen back onto the screen | Aim re-acquires the crosshair cleanly when the ray re-enters the TV | | |

### 2f. Feel — latency, jitter, framerate

| # | Test | Steps | Expected | Pass/Fail | Notes |
|---|---|---|---|---|---|
| F1 | Aim latency | Wave the gun quickly and watch the crosshair | Crosshair follows with no perceptible lag | | |
| F2 | Jitter | Hold the gun as still as possible on a fixed point | Crosshair holds steady; no visible tremor/jump beyond natural hand shake | | |
| F3 | Framerate while aiming | Aim continuously while a busy scene runs | No frame drops / stutter attributable to the per-frame raycast in `LightGunMgr.tick` | | |
| F4 | Framerate two TVs | (Multi-console) aim with multiple TVs in the rack | Raycast against all screen meshes does not tank framerate | | |
| F5 | Sustained | Play a full gun-game level | Aim/trigger stay responsive over minutes; no degradation | | |

### 2g. Per-system pass summary

| System | Gun | Grab OK | Aim accurate | Trigger hits | Off-screen reload | Overall Pass/Fail | Notes |
|---|---|---|---|---|---|---|---|
| NES | Zapper | | | | | | |
| SNES | Super Scope | | | | | | |
| Genesis | Menacer | | | | | | |
| SMS | Light Phaser | | | | | | |

---

## 3. Known issues to watch

- **Arm reload ends the XR session.** Grabbing the gun reloads the page
  (`armLightGunAndReload`), which on a Quest **drops you out of immersive VR**.
  This is a known characteristic (the libretro gun device only attaches at a fresh
  core boot, and the primary console owns `#canvas`). Verify §2b: re-entry must be
  clean and the game must resume with the gun connected. Flag if recovery is
  confusing or fails on the headset.
- **SMS Light Phaser shares controller port 0 with the pad.** On SMS the gun sits
  on **port 0** (player 1), the same port the gamepad uses — so arming the gun can
  conflict with normal pad input. Watch for: pad input lost when the Phaser is
  armed, or the gun not registering because the pad device holds the port. (NES/
  SNES/Genesis guns are on port 1 and do not have this conflict.)
- **Two guns on ONE console: supported — and aim-sharing is now a BUG, file it.**
  This entry used to say the opposite ("`rwebinput` exposes a single mouse … co-op
  is not yet supported … do not file aim-sharing as a bug"). That stopped being
  true on 2026-06-21 and is left here only so an older printout of this checklist
  isn't trusted. The **multiport patch**
  (`docs/patches/rwebinput-lightgun-multiport.diff`) gives every libretro port its
  own pointer slot behind the exported setter `rwebinput_set_lightgun(port,x,y,
  buttons)`, so each gun on a console drives its own aim state. Cores built with
  it are listed in `public/cores/PATCHED.json` (checked on every `npm test` by
  `scripts/test-patched-cores.mjs`). **If two guns on one console share a
  crosshair, that is a regression — file it.**
  What has actually been verified, and by what:
  - **SNES Justifier** (2026-06-21) — real patched `snes9x`, headless, 9/9: the
    core's own per-gun crosshairs follow their own ports, swap when the aims swap,
    and stay isolated. See `docs/LIGHTGUN_SUPPORT.md` §"SNES Konami Justifier".
  - **PSX GunCon** (2026-07-29) — real core + real commercial disc,
    `npm run probe:psx-twogun` 23/23: both ports seated (device 260 on ports 0+1),
    both aims carried by the per-port setter with distinct coordinates at the same
    instant, two crosshairs drawn simultaneously in their per-port colours, and the
    same shot at the same point registering differently depending only on `port`.
  - **Scope limit — read this before signing anything off.** Both are *core-level*
    evidence plus per-port isolation. Nobody has played a 2-player co-op session
    through: no one has driven Point Blank or Lethal Enforcers I & II through their
    2P menus with two guns, and the SNES result came from a headless harness, not
    a headset. **The in-VR routing hop has never been exercised for PSX at all** —
    `LightGunMgr._portForGun` → `libretroGunPortFor(_gunSlotIndex(gun), twoGunPorts)`
    → `sendLightgun(u,v,trigger,port)` is what turns "which jack the gun's cord is
    plugged into" into a libretro port, and it is exactly the leg a headless probe
    cannot reach and **you can**. So: plug two guns into one console, note which
    jack each cord sits in, and check each gun drives the crosshair the seating
    order predicts — then swap the two cords between jacks and confirm the players
    swap with them. Record the result; that hop is currently unvalidated.
  - Two guns on **different** consoles remain independent (separate clients,
    canvases and pointers) — that path predates the multiport patch.

---

## 4. Telemetry — MOSTLY IMPLEMENTED (spec kept for the two that aren't)

**Corrected 2026-07-29.** This section used to open "today there are **zero**
gun-specific `logger.event` calls" and was headed SPEC ONLY. That is no longer
true — most of it was built. What actually ships today, all readable from
`dionysus.dk/logs?session=<room>`:

| Event | Where | Spec below |
|---|---|---|
| `lightgun-boot` | `src/main.js:753` | — |
| `lightgun-grab` | `src/main.js:2304` | 4.1 |
| `lightgun-aim` (throttled) | `src/LightGunMgr.js:186` | 4.4 |
| `lightgun-fire` (rising edge) | `src/LightGunMgr.js:185` | 4.5 |
| `lightgun-arm-reboot` / `-fallback` | `src/main.js:5143` / `:5157` | 4.3 (renamed) |
| `lightgun-disarm` / `-fail` | `src/main.js:5246` / `:5262` | — |

**Still missing: `lightgun-release` (4.2) and `lightgun-mgr-init` (4.6).**
Without `lightgun-release` a spotter cannot tell a *deliberate* put-down from a
tracking dropout, which matters for the new port-release behaviour — releasing a
gun now clears its core-side port (`clearLightgun`), so a spurious release is
visible in-game as the gun handing aim back to the shared pointer for a frame.

There is also worker-side gun telemetry in the metrics block (not the log
stream): `gun.multiport`, `gun.devices`, and `gun.ports[port] = {x, y, buttons,
path}` where `path` is `dom` or `multiport`. **On a two-gun PSX session both
ports must read `path: "multiport"`** — if either reads `dom`, the guns are
sharing one pointer and that is the bug to file.

The spec below is kept verbatim for 4.2 and 4.6, and as a record of intent for
the rest; where an implemented event's name or fields differ from its spec, the
**code is the truth**.

### 4.1 `lightgun-grab` — gun picked up
- **Where:** the `onObjectGrabbed` handler in `src/main.js` (line ~1613, the
  `obj?.userData?.kind === 'lightgun'` branch), and/or `GrabMgr.onObjectGrabbed`
  dispatch (`src/GrabMgr.js` ~line 364).
- **Fields:**
  ```
  logger.event('lightgun-grab', {
    hand,            // 'left' | 'right' (the hand that grabbed; GrabMgr knows it)
    system,          // currentMeta?.system
    consoleId,       // console the gun will plug into, or null
    alreadyArmed,    // boolean — window.__lightgunArmed at grab time
  })
  ```

### 4.2 `lightgun-release` — gun put down
- **Where:** the gun's release path in `GrabMgr` (the `onObjectReleased`/equivalent
  for `kind === 'lightgun'`).
- **Fields:**
  ```
  logger.event('lightgun-release', { hand, consoleId })
  ```

### 4.3 `lightgun-arm-reload` — arm bridge fired
- **Where:** `armLightGunAndReload()` in `src/main.js` (line ~3552), logged
  **before** `location.reload()` so the breadcrumb survives the reload.
- **Fields:**
  ```
  logger.event('lightgun-arm-reload', {
    system,          // currentMeta?.system
    gun,             // lightgunForSystem(sys)?.label
    file: m.file,
    core: m.core,
    title: m.title,
    alreadyArmedConsole: !!_lightgunArmedConsole,  // true → early-returned, no reload
  })
  ```
  Pair with an existing/extended boot event on resume (e.g. add `lightgun: true`
  to the `boot-attempt`/`console-loaded` fields when `__lightgunArmed`) so the
  `/logs` reader can see arm → reload → re-boot-with-gun as one chain.

### 4.4 `lightgun-aim` — per-frame aim (THROTTLED)
- **Where:** `LightGunMgr.tick()` in `src/LightGunMgr.js`, right after the
  on-screen/off-screen decision (around the `client?.sendLightgun(...)` calls,
  lines ~99–105). **Must be throttled** — do NOT log every frame (72–90 Hz would
  flood the ring buffer). Throttle to ~2–4 Hz, or log only on meaningful change
  (on/off-screen transition, or u/v moved > a small epsilon).
- **Fields:**
  ```
  logger.event('lightgun-aim', {
    consoleId,       // myConsole (this gun's console)
    tvId,            // the TV mesh hit, or null
    onScreen,        // boolean
    u, v,            // canvas u,v sent (rounded to ~3dp); -1,-1 when off-screen
  })
  ```

### 4.5 `lightgun-fire` — trigger rising edge
- **Where:** `LightGunMgr.tick()`, on the rising edge already detected for the
  muzzle flash (`if (trigger && !this._wasTriggered.get(gun))`, line ~110). Log
  here so every actual shot is recorded (NOT throttled — fires are sparse).
- **Fields:**
  ```
  logger.event('lightgun-fire', {
    consoleId,       // myConsole
    tvId,            // TV hit, or null
    onScreen,        // boolean — true = on-screen shot, false = off-screen (reload)
    u, v,            // where it hit (canvas u,v), or -1,-1
  })
  ```

### 4.6 (optional) `lightgun-mgr-init` — manager wired up
- **Where:** wherever `LightGunMgr` is constructed in `src/main.js`.
- **Fields:**
  ```
  logger.event('lightgun-mgr-init', { curvature, targets /* count of screen meshes */ })
  ```
  Useful once: confirms the manager booted and how many TV targets it raycasts, so
  a "nothing happens when I aim" report can be told apart from "manager never ran".

> With 4.1–4.5 in place, a `/logs` reader can reconstruct, blind: gun grabbed (which
> hand/console) → arm reload → re-boot → aim sweeping across the screen (u,v + TV) →
> on/off-screen transitions → each shot and whether it was on-screen or a reload —
> i.e. every failure mode in §2 becomes diagnosable from the PC.
