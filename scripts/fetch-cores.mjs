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

// Candidate local source dirs, in priority order.
function candidateDirs() {
  const dirs = [];
  const argFrom = process.argv.indexOf('--from');
  if (argFrom !== -1 && process.argv[argFrom + 1]) dirs.push(process.argv[argFrom + 1]);
  if (process.env.LIBRETRO_CORES_DIR) dirs.push(process.env.LIBRETRO_CORES_DIR);
  // The scratch workspace this repo was forked from (see PROVENANCE.md).
  dirs.push('C:\\LLM\\Projects\\ClaudeTest\\LibretroWebXR\\public\\cores');
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
  return copied;
}

function instructions() {
  console.log(`
No local core source found. Get the cores one of these ways:

  A) Copy from a folder you already have:
       node scripts/fetch-cores.mjs --from <dir-with-*_libretro.js/.wasm>

  B) From the libretro buildbot (official; ships ONE ~760 MB archive):
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
