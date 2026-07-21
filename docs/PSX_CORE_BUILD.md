# Building the PSX (Beetle PSX HW + Lightrec + Wasm JIT) core

Unlike the PS2 (`play`) core (see [[PS2_CORE_BUILD.md]]), the PSX core's
build tooling is **not vendored in this repo** — it lives in its own
published repository, [`kblood/psx-wasm-jit-libretro`](https://github.com/kblood/psx-wasm-jit-libretro),
because it's independently useful outside this app (a standalone,
reproducible core build + a Lightrec↔Play--CodeGen Wasm-JIT adapter). This
doc only covers getting the built artifacts into this repo's `public/cores/`
and how the integration on this side is wired — for the actual build recipe,
patches, and JIT-adapter design, see that repo.

## Why this core is different from every other one here

Every existing web PSX core (including the classic
`mednafen_psx_hw_libretro` build referenced by `webretro`) ships with
Beetle PSX's Lightrec dynarec **disabled** — Lightrec's native code
generator (GNU Lightning) emits real AArch64/x86 machine code bytes into a
buffer, which is just inert data under Wasm; there's no way to jump to it.
Every existing browser PSX core therefore falls back to Beetle's plain
interpreter, which is why PSX has historically been considered infeasible
for in-browser emulation at full speed (this project's own
`docs/research/psx-n64-feasibility.md` reached exactly that conclusion,
independently, before this integration existed — see the note at the
bottom of this doc).

`psx-wasm-jit-libretro` avoids that by reusing the **same trick this
project's own PS2 (`play`) core already proved**: instead of emitting
native machine code, adapt Lightrec's IR to Play--CodeGen's `Jitter`
framework and its existing `Jitter_CodeGen_Wasm` backend, which emits a
real, valid WebAssembly module per compiled block, instantiates it in the
CPU-emulation worker's own JS realm, and publishes it into Emscripten's
growable indirect function table via `addFunction()` so Lightrec can call
it as an ordinary C function pointer. Unsupported/cold blocks still fall
back to Lightrec's own interpreter — this is a real guest-code JIT, not a
faster interpreter.

## Getting the artifacts

```sh
git clone https://github.com/kblood/psx-wasm-jit-libretro.git
cd psx-wasm-jit-libretro
bash core-build/build.sh   # from WSL; see that repo's README for prerequisites
cp core-build/dist/mednafen_psx_jit_libretro.{js,wasm,worker.js,build.json} \
   <this-repo>/public/cores/
```

`public/cores/` is gitignored here — same convention as every other core
(`play_libretro.*`, etc.): build once, place on disk, never commit the
binary.

Pinned inputs at the time this integration was built (see that repo's own
`manifest.env`/`dist/*.build.json` for the current, authoritative pins —
these will drift as the upstream repo evolves):

| Component | Commit |
|---|---|
| RetroArch | `45246ce85eec8fb36d11c3bf551b9b81d3a426a1` |
| beetle-psx-libretro | `d6caed07fcba47c211ff23c4fa1b20b894830ff2` |
| Play--CodeGen | `a5009f7dca062695b8e5aebbd71e67b4ddfa9251` |
| Play--Framework | `587f278917acc0026bf5fc34b39f995fc26bd015` |
| Emscripten (emsdk) | `3.1.46` |

`buildHash` in `systems.js`'s `CORES.mednafen_psx_hw` entry
(`beetle-d6caed07-codegen-a5009f7d-jit-dev`) is derived from the Beetle and
Play--CodeGen pins above — it's a human-readable label, not
cryptographically bound to the artifact; the real integrity check is the
per-artifact SHA-256 in the adjacent `.build.json` manifest, which
`RuntimeEmulatorClient.resolveCoreBuildHash()` reads at boot and threads
through into save-state compatibility checks (`checkSaveStateCompatibility`
in `src/SaveState.js`).

## How this repo integrates it

The build artifact is a standard execution-worker-contract module (ES
`MODULARIZE`, adjacent `.js`/`.wasm`/`.worker.js`, shared Wasm memory,
growable indirect function table, `FS`/`callMain`/`addFunction`/
`removeFunction` exported) — the same shape `src/runtime/
EmulatorWorkerRuntime.js` already expects for any worker-mode core, so no
PSX-specific worker code was needed. What PSX-specific integration exists:

- `src/systems.js` — `CORES.mednafen_psx_hw` registers the core with
  `execution: 'worker'`, `requiresThreads: true`, `contentIo:
  'transfer-memfs'`, `multiFile: true`, `companionExtensions: ['bin', 'img',
  'iso', 'sub', 'sbi']`, `firmwareProfile: 'psx'`. `SYSTEMS.psx` registers
  the system. Because `.cue`/`.chd`/`.exe` collide with the existing `play`
  (PS2) and `virtualxt` (DOS) cores at the filename-extension level, the
  default resolution for those three extensions favors the existing cores
  (see `AMBIGUOUS_EXT_DEFAULT` in `systems.js`); reaching PSX for those
  extensions requires an explicit `?core=mednafen_psx_hw` override (or,
  from the file picker, selecting a `.m3u`, which isn't ambiguous).
- `src/FirmwareStore.js` — validates and stores a user-imported BIOS
  (SCPH-5500/5501/5502) in IndexedDB; never fetches or ships one. Wired
  into `main.js`'s "Import BIOS" button and threaded into `client.start()`
  as `opts.firmware` whenever `coreInfo.firmwareProfile` is set.
- `src/SaveRamStore.js` — native SaveRAM (memory card), separate from
  save-state snapshots, keyed by core ID + content hash + slot with a
  rolling backup history. `main.js` restores it into the SAME `start()`
  call that boots the disc (`opts.restoredSaves`) and flushes it
  periodically + on `pagehide` (`flushCurrentSaveRam` in `main.js`).
- `src/ContentBundle.js` / `src/DiscControl.js` — multi-file CUE/M3U
  resolution (with recursive companion validation and a stable
  content-hash `contentId`) and the eject/select/insert RPC bridge.
- `src/RuntimeEmulatorClient.js` + `src/runtime/*` — the worker-execution
  facade every worker-mode core (currently only PSX) goes through; every
  other core keeps using `EmulatorClient.js` main-thread, unchanged.

## Verification

- `npm run test:psx-foundations` / `npm run test:runtime` — unit tests for
  the bundle/firmware/SaveRAM/registry logic above (no browser, no core
  binary required).
- `npm run probe:psx-core` — real browser (Puppeteer) boot of a legal,
  CC0 PS-X EXE smoke-test binary (`scripts/cores/psx/test-content/
  psx-jit-smoke.exe`) through the actual compiled core artifact, asserting
  on real rendered frame pixels, real native Lightrec JIT compilation
  counters (`psxJitCompiledBlocks`), and real forwarded PCM audio. Requires
  the built artifact to already be in `public/cores/` (see above).

Both were run against this integration and passed (2026-07-21): 6/6, 9/9,
and a real end-to-end browser boot with `psxJitCompiledBlocks: 95`,
non-blank rendered frames, and forwarded audio, with zero worker/console
errors.

## Known gap vs. `docs/research/psx-n64-feasibility.md`

That doc (uncommitted, in-progress research authored separately from this
integration) concludes PSX/N64 should be skipped because no Wasm-JIT
backend exists for Lightrec and building one would be a months-long,
nobody-has-done-this effort. This integration is exactly that effort,
already done, by adapting Lightrec to the existing, proven
`Jitter_CodeGen_Wasm` backend (the same one this project's own PS2 core
already ships) rather than writing a new native-code-generation backend
from scratch. That research doc has not been edited as part of this work
(it wasn't authored by this integration and may reflect research done
concurrently by someone else) — flagging the discrepancy here so whoever
next reads that doc knows to reconcile it against this one.

## Remaining work

- Beta-scope items from the upstream repo's own plan (Quest-performance
  gating, full native R3000A opcode coverage beyond the current
  integer/control-flow tier, `.m3u` multi-disc in-VR swap UX, long-session
  soak testing) are tracked there, not duplicated here.
- Multi-file OPFS re-caching and shelf-cartridge persistence for
  bundle-based (CUE+BIN) local picks are not implemented in this repo yet —
  a picked CUE+BIN set boots and plays but won't survive a page reload as a
  re-insertable shelf cartridge the way single-file main-thread cores do
  (see the comment above the `romInput` handler in `src/main.js`).
- Live `.cue`/`.chd` byte-level disc sniffing (to resolve the PS2/PSX
  extension collision automatically instead of via `?core=` override) isn't
  implemented — `src/DiscIdentity.js` exists but can't parse compressed CHD
  hunks or a CUE sheet's referenced BIN bytes without more infrastructure
  than currently exists here.
