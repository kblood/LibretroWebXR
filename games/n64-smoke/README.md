# LWX N64 Smoke Test

A CC0 minimal **libdragon** homebrew ROM for Nintendo 64, used as the boot
smoke test for the `mupen64plus_next` core (see
`[[docs/N64_CORE_BUILD.md]]` and `[[docs/research/n64-wasm-jit-plan.md]]`'s
Phase N0). It has no gameplay: it just fills the screen with a
continuously shifting solid color and draws a text overlay, so a headless
probe can assert non-blank rendered frames without needing any commercial
content.

## Build

```
node scripts/make-n64-smoke.mjs      # from the repo root
```

Builds with **libdragon** via the `anacierdem/libdragon` Docker image, run
from WSL2 (same emsdk/WSL2 environment used to build the
`mupen64plus_next` core itself — see `docs/N64_CORE_BUILD.md`). Needs WSL2
with Docker available and the image pulled
(`docker pull anacierdem/libdragon`).

Output: `public/roms/freeware/lwx-n64-smoke.z64`, registered in
`public/roms/manifest.json` under system `n64`, core `mupen64plus_next`.
