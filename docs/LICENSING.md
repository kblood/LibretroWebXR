# Licensing & Copyright Policy

How LibretroWebXR stays shareable and legally clean. Summary of research done
2026-05-31. **Not legal advice** — a good-faith summary; get review before any
commercial use.

## The three things with separate legal status

1. **Our frontend code** — MIT (`LICENSE`). Maximally reusable.
2. **libretro cores** — each keeps its upstream license; **not distributed in
   this repo** (see below). Listed in `THIRD_PARTY_LICENSES.md`.
3. **ROMs & BIOS** — copyrighted by their owners; **never** in this repo;
   user-supplied from media they own. Free/homebrew/public-domain test content
   is the only game content we ship (see `public/roms/README.md`).

## Core policy: fetch at runtime, never bundle

We do **not** commit cores to the repository. Reasons:
- Several cores are **non-commercial** (snes9x, genesis_plus_gx, picodrive,
  mame2003*, fbneo) — not OSI-open and **not GPL-compatible**. Bundling them into
  a single distributed artifact creates a license conflict and would forbid any
  future commercial use.
- Bundling GPL cores into one artifact would force the whole artifact to GPL
  (this is exactly why EmulatorJS itself is GPL-3.0). By keeping cores as
  **separate, runtime-loaded files**, our own code can stay MIT.
- Keeps the repo small (cores are 2–5 MB each).

**This matches how the repo already behaves** — `public/cores/` is gitignored.
`scripts/fetch-cores.mjs` populates it locally for development; the deploy server
hosts the cores it serves. Loading a separately-distributed core at runtime is
much weaker coupling than static linking (the prevailing community/EmulatorJS
position), though the FSF's view on plugins is contested — hence: stay
non-commercial-friendly and keep cores easy to drop.

### Where cores come from
- **libretro buildbot (Emscripten):** the canonical source, but ships only a
  single ~760 MB `RetroArch.7z`; `fetch-cores.mjs` extracts the few `*_libretro.{js,wasm}`
  we need. The original prototype's `public/cores/` was built this way (mix of
  legacy "classic" cores and modern MODULARIZE buildbot cores).
- **EmulatorJS CDN** (`https://cdn.emulatorjs.org/<ver>/data/cores/`) hosts cores
  too, but as EmscriptenFS `.data` bundles — a *different* format from the raw
  `.js/.wasm` our loader currently expects. Usable only if we adapt the loader.
- **Self-host:** rehost the extracted cores on the deploy server / a release
  asset. Recommended for production so the app isn't coupled to a third-party CDN.

## BIOS — never distributed
PSX (`scph550x.bin`, Sony), GBA (`gba_bios.bin`, Nintendo, optional with mGBA's
HLE BIOS), Sega CD (`bios_CD_*.bin`, Sega), arcade system BIOS — all copyrighted,
all user-supplied. NES/SNES/GB/GBC/Genesis-cart/N64 need no BIOS.

## ROMs — never distributed
Only free/homebrew/public-domain/CC content ships, each with its license and
credit recorded in the collection JSON (`license`, `credits` fields). Everything
else is the user's, supplied at runtime via the ROM sources in
`docs/ROOM_AND_COLLECTIONS.md`. See `public/roms/README.md`.

## If the project ever goes commercial
Drop the non-commercial cores entirely (snes9x → use a different SNES core only
if a permissive/GPL one exists; genesis_plus_gx/picodrive → reconsider Sega
support), re-audit every remaining core, and re-evaluate the GPL/runtime-loading
question with a lawyer.

## Sources
See `THIRD_PARTY_LICENSES.md` and `docs/EMUVR_RESEARCH.md` for the full source
list (libretro core-info metadata, per-core LICENSE files, EmulatorJS docs,
libretro buildbot, emulation legal references).
