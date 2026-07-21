# LWX N64 Orbit Cubes

A CC0 **libdragon** homebrew ROM for Nintendo 64. Unlike `games/n64-smoke`
(a flat-fill boot smoke test), this is real 3D content: a hand-rolled
software transform pipeline rotates a cube every frame (yaw + pitch,
perspective projection, painter's-algorithm depth sort) and hands the RDP
six flat-shaded faces (12 filled triangles) to rasterize per frame.

Serves as this project's "representative 3D title" stand-in for N64 Phase N0
fps measurement (`[[docs/research/n64-wasm-jit-plan.md]]`) — no commercial
N64 ROM is available or sourced for this repo, so an authored CC0 scene
fills that role, matching every other system here (`games/nes-gallery`,
`games/snes-scope`, `games/ps2-guncon-range`).

Also exercises the rest of Phase N0's item 4 in the same ROM:
- **Analog input**: the real controller stick (continuous x/y, not just
  digital direction) drives yaw/pitch speed.
- **EEPROM save**: a persistent boot counter is read/incremented/written
  through libdragon's `eepfs_*` API every boot.
- **Audio HLE**: a continuously generated tone is pushed through
  `audio_set_buffer_callback()` / the AI audio path the whole time the ROM
  runs.

## Build

```
node scripts/make-n64-scene.mjs      # from the repo root
```

Builds with **libdragon** via the `anacierdem/libdragon` Docker image, run
from WSL2 (same environment used to build the `mupen64plus_next` core
itself — see `docs/N64_CORE_BUILD.md`). Needs WSL2 with Docker available
and the image pulled (`docker pull anacierdem/libdragon`).

Output: `public/roms/freeware/lwx-n64-scene.z64`, registered in
`public/roms/manifest.json` under system `n64`, core `mupen64plus_next`.
