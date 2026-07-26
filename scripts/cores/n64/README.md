# N64 core (mupen64plus-next) source patches

Native patches applied to the WSL2 build checkout of
`github.com/libretro/mupen64plus-libretro-nx` (pinned commit `98c1b0d`)
that are **not** upstream and would otherwise be lost if that checkout is
recreated. The built `.wasm`/`.js` artifacts themselves are gitignored
(`public/cores/`), so these patches are the only durable record of the
core-side source deltas.

See `docs/N64_CORE_BUILD.md` for the full build recipe and for the other
core-side fixes that were made during initial bring-up (libco Emscripten
fiber backend, `ai_controller.c` RDRAM address masking, the GLideN64
WebGL2 buffer-mapping gating, the `glsym_es3.c` symbol renames) — those
are documented in prose there; only the patch below is carried as a file.

## `gliden64-fill-mode-lle-triangle-color.patch`

Fixes flat-colored **fill-mode low-level RDP triangles** rendering solid
black. `LLETriangle::draw()` never wrote `vtx->r/g/b/a` for a non-shaded
triangle (RDP command `0x08`/`0x09`), and in `G_CYC_FILL` the color
combiner is replaced by a shade-only program — so the fragment color was
uninitialised stack memory. Real hardware writes `SET_FILL_COLOR` in FILL
mode; `gDPFillRectangle()` already reproduced that for rectangles but
triangles had no equivalent.

Affects any content using libdragon's pre-`rdpq` API
(`rdp_enable_primitive_fill()` + `rdp_set_primitive_color()` +
`rdp_draw_filled_triangle()`), e.g. `games/n64-scene`.

Apply with:

```bash
cd ~/n64-build/mupen64plus-libretro-nx
git apply /path/to/gliden64-fill-mode-lle-triangle-color.patch
```

Regression guard: `npm run probe:n64-scene-render` (its bright-face-color
assertions fail without this patch).
