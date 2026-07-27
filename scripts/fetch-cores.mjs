#!/usr/bin/env node
// Populate public/cores/ with the libretro cores LibretroWebXR uses.
//
// Cores are NOT committed to this repo (licensing — see docs/LICENSING.md);
// this script fetches/copies them locally for development, and a deploy step
// rehosts them on the server.
//
// Strategies (in order):
//   1. --from <dir>  or  $LIBRETRO_CORES_DIR : copy *_libretro.{js,wasm} from
//      a local directory you already have (fastest, offline).
//   2. The original source workspace this project was forked from, if present.
//   3. Otherwise: print instructions for the libretro buildbot (the only
//      official source ships a single ~760 MB RetroArch.7z; extract the few
//      files listed below).
//
// Usage:
//   node scripts/fetch-cores.mjs                 # auto-detect a local source
//   node scripts/fetch-cores.mjs --from D:\cores # copy from a folder
//   LIBRETRO_CORES_DIR=/path node scripts/fetch-cores.mjs

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DEST = join(ROOT, 'public', 'cores');

// Light-gun patched cores: local builds carrying the rwebinput LIGHTGUN patch
// (docs/patches/rwebinput-lightgun.diff). They are NOT on the buildbot, so a
// routine fetch (e.g. `npm run deploy` → fetch-cores) would overwrite them with
// stock no-lightgun versions and silently break gun games. We read the local
// marker public/cores/PATCHED.json and SKIP those cores when a build already
// exists here, unless --refresh-patched is passed (or the entry is removed).
// Fresh checkout: no marker + no build → nothing to protect, stock is fetched.
const REFRESH_PATCHED = process.argv.includes('--refresh-patched');
function patchedCores() {
  if (REFRESH_PATCHED) return new Set();
  try {
    const m = JSON.parse(readFileSync(join(DEST, 'PATCHED.json'), 'utf8'));
    return new Set(Array.isArray(m.cores) ? m.cores : []);
  } catch { return new Set(); }
}
const PATCHED = patchedCores();
// A patched core is only protected if its build is actually present here.
const isProtected = (core) =>
  PATCHED.has(core) && existsSync(join(DEST, `${core}_libretro.wasm`));

// The cores referenced by src/main.js's CORES map (basenames; each has .js+.wasm)
const CORES = [
  'snes9x', 'nestopia', 'stella2014', 'genesis_plus_gx', 'mgba', 'mednafen_vb',
  'picodrive', 'gearsystem', 'fceumm', 'gambatte', 'mednafen_pce_fast',
  'vice_x64', 'vice_xvic', 'puae',
  // DOS (VirtualXT). Prebuilt module-style on the buildbot. NOTE: the current
  // buildbot binary boot-traps in this loader (RuntimeError: unreachable after
  // mounting the disk) — see docs/DOS_CORE_BUILD.md. Listed so deploy fetches it
  // alongside the others once a working build is available.
  'virtualxt',
];

// PS2/PSX/N64 (2026-07-17..22 work): CUSTOM cores built from source in WSL2,
// NOT on the libretro buildbot — this script can only COPY already-built
// artifacts, it cannot build them. See docs/PS2_CORE_BUILD.md,
// docs/PSX_CORE_BUILD.md, docs/N64_CORE_BUILD.md for the actual build
// recipes. Registry basenames (src/systems.js CORES keys) can differ from
// the on-disk file basename — e.g. the PSX registry entry is keyed
// `mednafen_psx_hw` but its built artifact is `mednafen_psx_jit_libretro.*`
// (systems.js's `url` field is the source of truth). The worker-execution
// ones (PSX, N64) also ship a `.worker.js` (pthreads) and a `.build.json`
// (sha256 manifest RuntimeEmulatorClient.resolveCoreBuildHash reads for
// save-state compatibility checks) — copied best-effort alongside .js/.wasm.
//
// A 2026-07-24 review (docs/research/psx-ps2-n64-review-2026-07-24.md)
// found `npm run deploy` was silently shipping a build where these three
// systems are registered and visible in the app but their core files 404 —
// this script had no idea they existed. See the hard-error check below.
const CUSTOM_CORES = ['play', 'mednafen_psx_jit', 'mupen64plus_next'];
const CUSTOM_CORE_EXTRA_EXTS = ['worker.js', 'build.json']; // best-effort, no warning if absent

// Candidate local source dirs, in priority order. No hardcoded sibling-
// checkout path here on purpose (2026-07-24 review finding: this used to
// default to `C:\LLM\Projects\ClaudeTest\LibretroWebXR\public\cores`, the
// OLD archived checkout this repo was forked from — not guaranteed to exist,
// not guaranteed correct, and not this machine's canonical source anymore).
// Use --from / $LIBRETRO_CORES_DIR, or just keep whatever's already in
// public/cores/ from a previous fetch (the hard-error check below only
// cares about the end state of DEST, not how it got there).
function candidateDirs() {
  const dirs = [];
  const argFrom = process.argv.indexOf('--from');
  if (argFrom !== -1 && process.argv[argFrom + 1]) dirs.push(process.argv[argFrom + 1]);
  if (process.env.LIBRETRO_CORES_DIR) dirs.push(process.env.LIBRETRO_CORES_DIR);
  return dirs.filter(Boolean);
}

function tryCopyFrom(srcDir) {
  if (!existsSync(srcDir)) return 0;
  const have = new Set(readdirSync(srcDir));
  mkdirSync(DEST, { recursive: true });
  let copied = 0;
  for (const core of CORES) {
    if (isProtected(core)) {
      console.warn(`  ⚠ keeping PATCHED ${core} (light-gun build) — not overwriting with stock. Use --refresh-patched to override.`);
      continue;
    }
    for (const ext of ['js', 'wasm']) {
      const name = `${core}_libretro.${ext}`;
      if (have.has(name)) {
        copyFileSync(join(srcDir, name), join(DEST, name));
        copied++;
      } else {
        console.warn(`  ! missing in source: ${name}`);
      }
    }
  }
  for (const core of CUSTOM_CORES) {
    // Same PATCHED.json protection as the buildbot-core loop above: a custom
    // core (currently only mednafen_psx_jit) can ALSO carry a local rwebinput
    // light-gun rebuild (docs/PSX_CORE_BUILD.md's "Light-gun (GunCon) support"
    // section, fixed 2026-07-27) that a --from/$LIBRETRO_CORES_DIR copy from
    // another machine/session's un-patched build would otherwise silently
    // overwrite, leaving SYSTEMS.psx.lightgun.broken=false pointed at a core
    // that can't actually register a shot again.
    if (isProtected(core)) {
      console.warn(`  ⚠ keeping PATCHED ${core} (light-gun build) — not overwriting with a different custom-core build. Use --refresh-patched to override.`);
      continue;
    }
    for (const ext of ['js', 'wasm', ...CUSTOM_CORE_EXTRA_EXTS]) {
      const name = `${core}_libretro.${ext}`;
      if (have.has(name)) {
        copyFileSync(join(srcDir, name), join(DEST, name));
        copied++;
      } else if (ext === 'js' || ext === 'wasm') {
        console.warn(`  ! missing in source (custom-built core — see the CUSTOM_CORES comment above): ${name}`);
      }
    }
  }
  return copied;
}

// Hard-error if a custom core's .js/.wasm are missing from DEST once every
// candidate source has been tried — checked against the END STATE of
// public/cores/, not just this run's copy count, so a core already fetched
// by a prior run (and simply not overwritten this time) doesn't false-fail.
// `play` (PS2) ships live/default; PSX/N64 are gated behind ?experimental=1
// (src/systems.js) but still need real files for anyone testing with that
// flag — and for `npm run deploy`, which halts on this script's exit code.
function checkCustomCoresPresent() {
  const missing = [];
  for (const core of CUSTOM_CORES) {
    const hasJs = existsSync(join(DEST, `${core}_libretro.js`));
    const hasWasm = existsSync(join(DEST, `${core}_libretro.wasm`));
    if (!hasJs || !hasWasm) missing.push(core);
  }
  if (!missing.length) return;
  console.error(`
ERROR: custom-built core(s) missing from ${DEST}: ${missing.join(', ')}

These are NOT on the libretro buildbot — this script can only copy an
already-built artifact, never build one. See:
  docs/PS2_CORE_BUILD.md   (play)
  docs/PSX_CORE_BUILD.md   (mednafen_psx_jit)
  docs/N64_CORE_BUILD.md   (mupen64plus_next)

Build (or copy from wherever they were last built) into ${DEST} and re-run,
or pass --allow-missing-custom-cores if you deliberately don't need these
systems yet (e.g. a fresh clone only doing classic-console work).
`);
  if (!process.argv.includes('--allow-missing-custom-cores')) process.exit(1);
}

function instructions() {
  console.log(`
No local core source found. Get the cores one of these ways:

  A) Copy from a folder you already have:
       node scripts/fetch-cores.mjs --from <dir-with-*_libretro.js/.wasm>

  B) From the libretro buildbot (official; ships ONE ~760 MB archive) — only
     covers the standard cores below. It does NOT have play/mednafen_psx_jit/
     mupen64plus_next (custom WSL builds — see the CUSTOM_CORES comment near
     the top of this script for the build docs):
       1. Download https://buildbot.libretro.com/nightly/emscripten/RetroArch.7z
       2. Extract just the cores we need, e.g.:
${CORES.map(c => `            7z e RetroArch.7z -o"${DEST}" retroarch/${c}_libretro.js retroarch/${c}_libretro.wasm`).join('\n')}

  C) From the EmulatorJS CDN (cdn.emulatorjs.org) — note their cores are
     packaged as EmscriptenFS .data bundles, a different format than the raw
     .js/.wasm this loader currently expects; only use if you adapt the loader.

See docs/LICENSING.md. Cores keep their upstream licenses; some are
non-commercial. Never commit them to git.
`);
}

let total = 0;
for (const dir of candidateDirs()) {
  console.log(`Trying core source: ${dir}`);
  const n = tryCopyFrom(dir);
  if (n > 0) { total = n; console.log(`Copied ${n} files into ${DEST}`); break; }
}
if (total === 0) instructions();
// Always check the END STATE of public/cores/ for the custom cores, even
// when nothing was copied this run (e.g. no --from/$LIBRETRO_CORES_DIR given
// but a prior run already populated DEST) — this is what actually stops
// `npm run deploy` from silently shipping 404 core URLs.
checkCustomCoresPresent();
