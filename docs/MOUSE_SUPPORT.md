# Mouse support (in-world mouse peripheral → libretro RETRO_DEVICE_MOUSE)

Status: **Single-mouse path COMPLETE + verified** (2026-06-25). The mouse is a
first-class connectable peripheral: a grabbable in-world mouse prop with a cord
that plugs into a console port jack, routing RELATIVE motion + L/R buttons to that
console's libretro MOUSE device (RETRO_DEVICE_MOUSE, id 2). Desktop fallback drives
one mouse via Pointer Lock. Built to enable Amiga (PUAE) point-and-click games — The
Settlers — and reusable later by DOS. Mirrors the light-gun architecture
(`docs/LIGHTGUN_SUPPORT.md`).

---

## ✅ DE-RISK RESULT: RETRO_DEVICE_MOUSE works on stock PUAE — no core rebuild

The light gun needed a patched `rwebinput` because in-game LIGHTGUN *position* wasn't
fed under emscripten. The MOUSE device is DIFFERENT and **already works on the stock
puae core** via synthetic DOM mouse events:

- PUAE's emscripten JS stores `movementX`/`movementY` into the HTML5 mouse event
  struct (`HEAP32[idx+11/12]`), and RetroArch's `rwebinput` reads those as the
  relative mouse delta — exactly the pointer-lock path. It also handles
  `mousedown`/`mouseup` for buttons.
- **Verified headlessly** by booting the Settlers FairLight cracktro on the AROS
  Kickstart (no proprietary ROM needed), assigning `RETRO_DEVICE_MOUSE` (id 2) to
  port 0 via the `inputDevices`/`remapName` boot mechanism (the same one the guns
  use, `remapName: 'PUAE'`), and then:
  - **buttons:** a synthetic left-click advanced the cracktro to a Workbench screen
    (`tmp/derisk-mouse3.mjs`), and
  - **motion:** a press-and-drag on the Workbench window **moved the window**
    (`tmp/derisk-mouse5.mjs`, `tmp/verify-sendmouse.mjs`) — only possible if relative
    motion reached the core while the button was held.
- The same proof runs end-to-end through the real app: boot The Settlers via
  `window.__loadCartridge` with the mouse armed, then drive the in-world mouse via
  `window.__moveMouse` (cable → `MouseMgr.portForMouse` → `EmulatorClient.sendMouse`)
  — click advances, drag moves the window (`tmp/verify-mouse-integration.mjs`).

So: **single mouse → one console port works with the cores we already ship.**

## ⚠️ Two-mouse caveat (split-pointer 2-player)

The Settlers' 2-player mode wants TWO independent pointers — one per DB9 port. PUAE
reads each port's mouse from `input_playerN_mouse_index`, and in a web build there is
only ONE physical mouse (index 0), so **both Amiga ports follow the SAME pointer**.

This is the exact problem the light gun hit, and it has the exact same fix: a
multiport `rwebinput` patch that exports `rwebinput_set_mouse(port, dx, dy, buttons)`
so each port gets its own delta (DOM `movementX/Y` can't express two pointers on one
canvas). The current puae build has **no such export** (confirmed by scanning
`puae_libretro.js` — only emscripten's stock `set_mouse{down,move,up}` callbacks
exist). Building that patched puae is a **separate effort** (a core rebuild, like the
guns'), intentionally out of scope here.

The code is future-proofed for it:
- `EmulatorClient.sendMouse(dx,dy,buttons,port)` uses `rwebinput_set_mouse` when the
  core exports it (resolved lazily by `_resolveWebmouse`), else falls back to the
  shared DOM path. So a patched core is a drop-in — no app changes needed.
- The descriptors + helpers (`systems.js`) already define the two-mouse config
  (`amiga.mouse2`, devices `[2,2]`, ports `[0,1]`), and the routing
  (`MouseMgr.portForMouse` → `libretroMousePortFor`) feeds each mouse its own port.
- Until the patch lands, two mice on Amiga drive the SAME pointer (still better than
  nothing — both players nudge one cursor), and single-player is fully correct.

## Architecture (mirrors the light gun)

| Light gun | Mouse |
|---|---|
| `src/LightGun.js` (grabbable gun prop) | `src/Mouse.js` (grabbable mouse prop) |
| `src/LightGunMgr.js` (raycast → `sendLightgun`) | `src/MouseMgr.js` (position-delta → `sendMouse`) |
| `src/net/GunSync.js` (`gun:` port-binding) | `src/net/MouseSync.js` (`mouse:` port-binding) |
| `EmulatorClient.sendLightgun(u,v,trigger,port)` | `EmulatorClient.sendMouse(dx,dy,buttons,port)` |
| `lightgunLoadConfig` / `libretroGunPortFor` | `mouseLoadConfig` / `libretroMousePortFor` |

- **Prop** (`Mouse.js`): a small grabbable mouse with a `cordAnchor` (cable to a
  port) and a `tracker` Object3D whose world position `MouseMgr` diffs each frame.
- **MouseMgr** (`MouseMgr.js`): per held mouse, `worldDeltaToMouse()` maps the
  hand-motion delta (world X → dx, world Z → dy; lifting/world-Y ignored, like a real
  mouse) to integer libretro pixels (clamped), reads trigger/squeeze as L/R buttons,
  and calls the plugged console's `sendMouse`. `attachDesktop()` adds the Pointer-Lock
  desktop path (one pointer — a hardware limit, flagged).
- **Boot wiring** (`main.js` `loadCartridge`): a mouse-flagged game (`mouse: true`) or
  a session-armed mouse on a mouse-capable system connects `RETRO_DEVICE_MOUSE` on its
  port(s) via `mouseLoadConfig` (`twoMouse: true` → both ports). The device only
  attaches at a fresh boot, so grabbing the mouse (`armMouseAndReload`) live-reboots
  the same game with the device on (XR + net session survive).
- **Net sync** (`MouseSync.js`): each mouse's console+port binding rides the `mouse:`
  STATE channel so every peer agrees which mouse drives which port/player — the prop
  MESH itself rides `prop:*` (it's a placeable prop). Essential for 2-player.

## Desktop fallback

When not in VR, the computer mouse drives the primary in-world mouse via Pointer Lock
(click the app canvas to lock; relative `movementX/Y` + buttons route to `sendMouse`).
**Two desktop mice is a hardware limit** — only one OS pointer exists — so the desktop
path binds a single mouse. Two-player split-pointer is a VR-only affordance (two
controllers, two mice) and, even then, needs the multiport core patch above.

## Test content (gitignored — never committed)

`public/roms/local/amiga/` (fully gitignored) carries the user's own:
- `KICK13.ROM` — Kickstart 1.3 (wiring it as the PUAE system Kickstart is a follow-up;
  AROS is the no-Kickstart fallback and boots the cracktro fine).
- `settlers-boot.adf` / `settlers-disk{1,2}.adf` / `settlers.hdf` — The Settlers.
- `local.collection.json` / `amiga.collection.json` register Settlers with
  `mouse: true, twoMouse: true` so it boots in-room with the mouse armed.

## Verification scripts (`tmp/`)

- `derisk-mouse3.mjs` — buttons reach the core (cracktro advances on left-click).
- `derisk-mouse5.mjs` — relative MOTION reaches the core (press-drag moves a window).
- `verify-sendmouse.mjs` — same, through `EmulatorClient.sendMouse` (the real API).
- `verify-mouse-integration.mjs` — same, through the full app (boot via
  `__loadCartridge` + drive via `__moveMouse` → cable → `sendMouse`).

## Follow-ups

1. **Multiport `rwebinput_set_mouse` puae build** → true split-pointer 2-player.
2. ✅ **done** — Kickstart wired as the PUAE system firmware via `src/systems.js`'s
   `systemFiles` mechanism (`puae_kickstart: 'Automatic'` + `kick34005.A500`/
   `kick40068.A1200` provisioned into the core's system dir before boot; commit
   `6089ebe`), so Settlers boots the real game, not just the AROS cracktro.
3. **Headset validation** of the in-VR grab + positional-motion feel + gain tuning.
4. ✅ **done (2026-07-11, `a778b44`)** — desktop pointer-lock was ungated:
   `MouseMgr.attachDesktop()`'s click listener called `requestPointerLock()` on
   **any** click of the app canvas, regardless of system or whether a mouse
   device was actually wired to the seated console. A click while loading or
   playing an unrelated (non-mouse) ROM silently captured the OS cursor into
   relative/hidden-cursor motion — no error, just a broken-feeling mouse, which
   reads as the page having crashed. Fixed: `attachDesktop()` now takes a
   `getWired()` gate (true only when the current boot wired a real mouse
   device on that port); `loadCartridge`/`rebootPrimaryConsole` call the new
   `releaseDesktopLock()` to force-drop a stale lock left over from a prior
   mouse-capable boot. Tests: `scripts/test-mousemgr-pointerlock.mjs`.
5. ✅ **fixed (2026-07-11, disarm option)** — same shape as the light-gun arming
   leak (see `docs/LIGHTGUN_SUPPORT.md`): `window.__mouseArmed` is deliberately
   sticky for the session, but `isMouseCapable(systemId)` is system-level, not
   per-ROM. `wantMouse` in `main.js`
   (`!gun && isMouseCapable(meta.system) && (meta.mouse || window.__mouseArmed)`)
   meant once a mouse had been armed, any later boot of a mouse-capable-system
   ROM got the libretro MOUSE device wired regardless of whether that specific
   ROM uses one. Found 2026-07-11 alongside the gun version of the same bug.
   Fixed the same way: `disarmMouseAndReload()` clears `window.__mouseArmed` +
   its `sessionStorage` key, live-rebooting the CURRENT game without the mouse
   only if its own meta doesn't declare `mouse: true` (a legitimately-declared
   mouse game keeps its device; disarming there only stops the leak onto the
   *next* load). Also unplugs the mouse's in-world cable jack when the device is
   actually dropped. Exposed as `window.__disarmMouse()` and a "Disarm Mouse" /
   "Mouse: Off" menu button (same panel as the gun's). Verified end-to-end in
   `tmp/verify-disarm-mouse.mjs` (9/9 assertions: leak reproduced, fixed for
   undeclared games; the "declared" preservation branch shares the gun's tested
   code shape but has no second mouse-capable manifest title to reproduce
   against directly).
