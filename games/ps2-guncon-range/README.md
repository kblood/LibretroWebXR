# LWX GunCon Range

A CC0 **PlayStation 2** GunCon2 light-gun shooting gallery for LibretroWebXR —
the PS2 companion to the NES Zapper (`games/nes-gallery`) and SNES Super Scope
(`games/snes-scope`) galleries. A bright target box appears at a random spot
on a dark field; aim the GunCon2 (crosshair follows the gun) and pull the
trigger. On target = **HIT** (+1 score, green flash, target respawns); off
target = **MISS** (red flash); 5 misses ends the round with a brief flash,
then score/misses reset and a new round starts immediately — no menu, always
replayable. A bare **PS2 ELF** homebrew that the libretro **Play!** core
(`play_libretro`) boots directly.

## Why a real USB LDD driver, not Play!'s `SetGunState()` shortcut

Play! exposes a libretro-side `SetGunState()` hook for its emulated GunCon2
input device, but this game is built to also work with a **real, physical**
GunCon2 attached over USB when the core is deployed outside the browser
sandbox (and to double as this project's from-scratch GunCon2 USB driver
proof — see `[[ps2-guncon2-real-driver-verified]]`). The `iop/guncon2_ldd/`
module is a real `sceUsbdLddOps` USB Low-Level Device driver: it probes/opens
a USB pipe, polls the GunCon2's 6-byte input report every frame, and exposes
`{ connected, buttons, x, y }` to the EE side over a SIF RPC server. The game
itself only ever talks to `guncon2_state_t` via `SifCallRpc()` — it has no
idea whether the state came from real USB hardware or (when run under the
libretro core, as on the website) the core's own emulated GunCon2 device
feeding the same input pipeline further down. Zero game-specific logic lives
in the IOP module, so it's reused byte-for-byte from
`~/ps2-guncon2-test/iop/guncon2_ldd/` (a WSL2 scratch tree, not part of this
repo).

## Build

```
node scripts/make-ps2-guncon-range.mjs      # from the repo root
```

Builds with the **PS2SDK** via the `ps2dev/ps2dev` Docker image, run from
WSL2 (same toolchain as the `play_libretro` core itself — see
`docs/PS2_CORE_BUILD.md`). Two-stage build: the IOP module
(`iop/guncon2_ldd/`) builds first into `guncon2_ldd.irx`, which the `ee/`
Makefile then `bin2c`s into `guncon2_ldd_irx.c` and links directly into the
EE ELF (`SifExecModuleBuffer` loads it from memory at boot — no separate
`.irx` file needs to ship). The build script syncs the game into a WSL2-native
scratch directory first (avoids `/mnt/c/...` Docker-volume friction), then
copies the stripped ELF to `public/roms/freeware/lwx-ps2-guncon-range.elf`.

## Files

| File | Origin | License |
|---|---|---|
| `ee/main.c` | **ours** — the game logic (boot/RPC-poll structure adapted from the `~/ps2-guncon2-test` driver-test harness) | CC0 |
| `ee/Makefile` | ours (adapted from PS2SDK sample Makefile templates) | CC0 |
| `guncon2_rpc.h` | ours — shared EE/IOP RPC contract | CC0 |
| `iop/guncon2_ldd/guncon2_ldd.c`, `Makefile`, `imports.lst` | ours — real USB LDD GunCon2 driver, no game-specific logic | CC0 |

PS2SDK (the toolchain) is used only to compile/link — its own license does
not taint the output binary. All game and driver source here is CC0, and the
compiled ELF ships as CC0.

## Controls

- **Aim** the GunCon2 at the screen (crosshair tracks it directly) and **pull
  the trigger** to shoot.
- Screen stays **yellow** until the gun reports `connected`.
- In VR: grab the light-gun prop — the frontend boots the Play! core with the
  GunCon2 on port 1 (`"lightgun": true` in the manifest) and feeds your aim as
  the gun position via `EmulatorClient.sendLightgun()`.

## Verifying

`tmp/verify-ps2-guncon-range.mjs` drives the **real shipped Play! core**
headlessly through the actual `EmulatorClient`/manifest boot path with
`lightgunLoadConfig('ps2', {})` wiring. It reads the EE-RAM-resident probe
struct (`retro_get_memory_data`) to confirm `connected` plus that firing on
the target's known position increments `score` and firing off it increments
`misses` — the authoritative, timing-independent signal — and takes
screenshots after a hit and a miss to visually confirm the green/red flash
and the target/crosshair boxes render correctly.

## Notes

- 640×448 `GS_PSM_32` framebuffer, no menu/title screen — boots straight into
  a playable round.
- GunCon2 device id **260** on controller port index **0** (player 1) — see
  `docs/LIGHTGUN_SUPPORT.md` and `src/systems.js` (`SYSTEMS.ps2.lightgun`).
- Content loads as a plain ELF (the pre-existing `_writeRom` MEMFS path in
  `EmulatorClient.js`) — this game does not use the `discImage`/
  `DiscImageDevice` shim built for real PS2 disc images.
