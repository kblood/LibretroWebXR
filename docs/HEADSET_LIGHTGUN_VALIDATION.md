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

1. On the Quest, open the browser and go to the deployed build (the
   `dionysus.dk` light-gun build — confirm with the orchestrator which path is
   live; remote logging only auto-enables on the `dionysus.dk` host over HTTPS,
   see [`src/Logger.js`](../src/Logger.js) `_detectServerUrl`).
2. Wait for the room to load (console + TV rack visible on a flat screen).
3. Note the **room id** — it is the multiplayer room you joined (default is
   `default` if you did not pick one). You need it to read logs (below).
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

where `<room>` is the room id from step 3 (e.g. `https://dionysus.dk/logs?session=default`).

- Logging is `logger.event(name, fields)` → JSON entries (see
  [`src/Logger.js`](../src/Logger.js)). Existing events you will see today include
  `boot-attempt`, `rom-resolved`, `console-loaded`, `boot-error`, `input`.
- **Today there is NO gun-specific telemetry** — see §4 for the events that should
  be added so a headset session is diagnosable without seeing the screen. Until
  those land, you are validating by **eye in VR** plus a **spotter watching the
  TV** and reading the generic boot/input events.
- Tip: have a second person at the PC with the `/logs` page open while the tester
  is in the headset, calling out what events arrive (or do not).

### Recommended crew

- 1 tester in the headset.
- 1 spotter at a PC: watches `/logs?session=<room>` AND, ideally, a cast/mirror of
  the headset view (Quest casting) so they can see where the in-game crosshair
  actually lands vs. where the tester says they are pointing.

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
| Genesis | genesis_plus_gx | Menacer | 1 (player 2) |
| SMS | genesis_plus_gx | Light Phaser | 0 (player 1) — shares the pad port |

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
- **Single-mouse → 2 guns on one console share aim.** `rwebinput` exposes a single
  mouse, so the patched core feeds the **same** aim point to every light-gun port
  on a console. Two guns on the **same** console (e.g. 2-player Duck Hunt) would
  share one crosshair — **co-op is not yet supported.** Two guns on **different**
  consoles are independent. Do not file aim-sharing on one console as a bug; note
  it as the expected co-op gap.

---

## 4. Telemetry to add (SPEC ONLY — do not write code here)

Today there are **zero** gun-specific `logger.event` calls, so a headset session
is effectively a black box: the spotter can only infer from generic boot/input
events. Add the events below so the whole gun loop is diagnosable purely from
`dionysus.dk/logs?session=<room>` without seeing the screen. Style matches the
existing `logger?.event?.('name', { …fields })` calls in `main.js`. The logger
instance is the module singleton exported from `src/Logger.js`; `LightGunMgr` does
not currently import it, so it must be injected (e.g. an `opts.logger` /
`opts.onAim` accessor on the constructor) rather than reaching for a global.

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
