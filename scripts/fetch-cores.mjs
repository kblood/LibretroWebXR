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
import { createHash } from 'node:crypto';

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
  // DOS (VirtualXT). Prebuilt module-style on the buildbot IN THEORY, but as
  // of 2026-07-29 it is ABSENT here (never copied by any local source this
  // repo has fetched from recently) AND 404s on the live deploy — this is a
  // routine "missing in source" warning below, not a hard error (virtualxt is
  // not in CUSTOM_CORES, so checkCustomCoresPresent() doesn't cover it). A
  // prior buildbot binary of this core was fetched once and boot-trapped
  // (RuntimeError: unreachable after mounting the disk) — see
  // docs/DOS_CORE_BUILD.md for both the trap history and the current absent/
  // 404 state. `dos` is flagged `experimental: true` in src/systems.js so it
  // isn't offered to real users either way. Left listed so deploy picks it up
  // automatically once a working build (buildbot or a from-scratch one) exists.
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
// All three are pthread/Emscripten builds and each actually ships a
// `.worker.js` (verified on disk 2026-07-27 — every one of
// play/mednafen_psx_jit/mupen64plus_next has one in public/cores/), so it's
// treated as REQUIRED alongside .js/.wasm below, not best-effort: a core
// missing its pthread pool worker file fails to boot (PTHREAD_POOL_SIZE>0
// needs it to spin up worker threads), which is exactly the kind of
// "registered but silently broken" gap the 2026-07-24 review below was
// about. `.build.json` stays best-effort — it's sha256/pin metadata with a
// documented fallback (RuntimeEmulatorClient.resolveCoreBuildHash), not
// something the core needs to boot.
const CUSTOM_CORE_REQUIRED_EXTS = ['js', 'wasm', 'worker.js'];
const CUSTOM_CORE_EXTRA_EXTS = ['build.json']; // best-effort, no warning if absent

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

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// Does `manifestPath` (a candidate .build.json from a source dir) actually
// describe the build sitting in DEST right now? A .build.json is a sha256
// manifest of a SPECIFIC set of binaries; handing a protected core a manifest
// from someone else's build would misreport its hashes, which is precisely the
// manifest/binary mismatch this protection exists to prevent (and would poison
// RuntimeEmulatorClient.resolveCoreBuildHash's save-state build pinning with a
// confident-but-wrong id — strictly worse than its 'unversioned' fallback).
// Verify every required artifact, not just the .wasm the frontend reads, so a
// partially-matching manifest can't sneak through.
function manifestDescribesLocalBuild(manifestPath, core) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch (e) { return { ok: false, reason: `unreadable/invalid JSON (${e.message})` }; }
  const artifacts = manifest?.artifacts;
  if (!artifacts || typeof artifacts !== 'object') {
    return { ok: false, reason: 'no `artifacts` map to verify against' };
  }
  for (const ext of CUSTOM_CORE_REQUIRED_EXTS) {
    const name = `${core}_libretro.${ext}`;
    const local = join(DEST, name);
    if (!existsSync(local)) return { ok: false, reason: `local ${name} is missing` };
    const claimed = String(artifacts[name]?.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(claimed)) {
      return { ok: false, reason: `manifest records no sha256 for ${name}` };
    }
    const actual = sha256File(local);
    if (actual !== claimed) {
      return { ok: false, reason: `sha256 mismatch on ${name} (manifest ${claimed.slice(0, 12)}…, local ${actual.slice(0, 12)}…) — it describes a different build` };
    }
  }
  return { ok: true };
}

// A protected core keeps its own .js/.wasm/.worker.js — but protection must not
// also freeze it out of acquiring a best-effort EXTRA file it simply doesn't
// have yet (today: .build.json, which `play` is missing). Copy only files
// ABSENT from DEST (never overwrite a protected core's existing metadata), and
// only when the manifest verifiably describes the protected binaries.
function copyMissingExtrasForProtected(srcDir, have, core) {
  let copied = 0;
  for (const ext of CUSTOM_CORE_EXTRA_EXTS) {
    const name = `${core}_libretro.${ext}`;
    if (existsSync(join(DEST, name))) continue; // present already — never overwrite
    if (!have.has(name)) continue;              // source hasn't got one either
    const verdict = manifestDescribesLocalBuild(join(srcDir, name), core);
    if (!verdict.ok) {
      console.warn(`  ⚠ NOT copying ${name} for PATCHED ${core}: ${verdict.reason}. Leaving it absent (resolveCoreBuildHash falls back to 'unversioned') rather than pinning save states to a manifest that doesn't match the binaries on disk. Regenerate the manifest from this build, or use --refresh-patched to take the source build wholesale.`);
      continue;
    }
    copyFileSync(join(srcDir, name), join(DEST, name));
    copied++;
    console.log(`  + ${name} — PATCHED ${core} was missing this metadata; source manifest's sha256s verified against the local build, so it's safe to adopt.`);
  }
  return copied;
}

// Returns { copied, protectedSkips }. `protectedSkips` matters as much as
// `copied` for deciding whether a source dir was USABLE: a dir whose every core
// is deliberately skipped by PATCHED.json protection copied 0 files but was a
// perfectly good source, and must not be reported as "no local core source".
//
// CRITICAL: `protectedSkips` must only count skips where THIS SOURCE DIR really
// held a build we declined to take. isProtected() is a statement about DEST
// alone (PATCHED.json + DEST/<core>_libretro.wasm), so counting every protected
// core made *any* existing directory — including an empty one, or a typo'd path
// that happens to exist — report a nonzero "usable" score. That is a DEST-derived
// number masquerading as a fact about the source: the candidate loop below would
// break on the first such dir, never try $LIBRETRO_CORES_DIR, never print
// instructions(), and silently ship whatever stale/missing buildbot cores
// (stella2014, mgba, virtualxt — none of which checkCustomCoresPresent() covers)
// were already on disk. So gate every increment on srcHasBuild().
const srcHasBuild = (have, core) => have.has(`${core}_libretro.wasm`);

function tryCopyFrom(srcDir) {
  if (!existsSync(srcDir)) return { copied: 0, protectedSkips: 0 };
  const have = new Set(readdirSync(srcDir));
  mkdirSync(DEST, { recursive: true });
  let copied = 0;
  let protectedSkips = 0;
  for (const core of CORES) {
    if (isProtected(core)) {
      console.warn(`  ⚠ keeping PATCHED ${core} (light-gun build) — not overwriting with stock. Use --refresh-patched to override.`);
      if (srcHasBuild(have, core)) protectedSkips++;
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
    // Only honor the protection if the on-disk build is actually complete
    // (.js, .wasm AND .worker.js — the files checkCustomCoresPresent() hard-
    // requires below). A PATCHED entry pointing at a partial/tampered build
    // (e.g. .wasm present but .js or .worker.js missing) must NOT block a
    // supplied source from repairing it — that would silently ship (or
    // hard-fail on) a core that can't even boot, which is worse than losing
    // the light-gun patch.
    const hasCompleteBuild = CUSTOM_CORE_REQUIRED_EXTS.every(
      (ext) => existsSync(join(DEST, `${core}_libretro.${ext}`)));
    if (isProtected(core) && hasCompleteBuild) {
      console.warn(`  ⚠ keeping PATCHED ${core} (light-gun build) — not overwriting with a different custom-core build. Use --refresh-patched to override.`);
      // Same rule as the buildbot loop above: only a skip of a build this
      // source ACTUALLY offered says anything about the source dir.
      if (srcHasBuild(have, core)) protectedSkips++;
      // Protection covers the BINARIES, not metadata the core doesn't have
      // yet: still let it pick up a missing (and verified-matching) extra
      // like .build.json. See copyMissingExtrasForProtected.
      copied += copyMissingExtrasForProtected(srcDir, have, core);
      continue;
    }
    if (isProtected(core) && !hasCompleteBuild) {
      console.warn(`  ⚠ PATCHED ${core} is listed but its local build is incomplete (missing .js/.wasm/.worker.js) — repairing from source instead of protecting it.`);
    }
    for (const ext of [...CUSTOM_CORE_REQUIRED_EXTS, ...CUSTOM_CORE_EXTRA_EXTS]) {
      const name = `${core}_libretro.${ext}`;
      if (have.has(name)) {
        copyFileSync(join(srcDir, name), join(DEST, name));
        copied++;
      } else if (CUSTOM_CORE_REQUIRED_EXTS.includes(ext)) {
        console.warn(`  ! missing in source (custom-built core — see the CUSTOM_CORES comment above): ${name}`);
      }
    }
  }
  return { copied, protectedSkips };
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
    const complete = CUSTOM_CORE_REQUIRED_EXTS.every(
      (ext) => existsSync(join(DEST, `${core}_libretro.${ext}`)));
    if (!complete) missing.push(core);
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

// A source dir counts as FOUND if it either copied something or was fully
// honoured-but-skipped by PATCHED.json protection. Counting only copies made
// `--from <dir of already-protected cores>` print the "No local core source
// found … download the ~760 MB RetroArch.7z" instructions over a perfectly
// good source, and fall through to the next candidate — a false negative that
// only became reachable once every core in a source dir could be protected.
// The converse false POSITIVE is worse and is guarded in tryCopyFrom: a
// protected skip only counts when the source dir itself held that core's build
// (srcHasBuild), so an empty or typo'd `--from` dir still scores 0 and still
// falls through to the next candidate / instructions().
let found = false;
for (const dir of candidateDirs()) {
  console.log(`Trying core source: ${dir}`);
  const { copied, protectedSkips } = tryCopyFrom(dir);
  if (copied > 0 || protectedSkips > 0) {
    found = true;
    console.log(`Copied ${copied} files into ${DEST}${
      protectedSkips ? ` (${protectedSkips} PATCHED core(s) deliberately kept as-is)` : ''}`);
    break;
  }
}
if (!found) instructions();
// Always check the END STATE of public/cores/ for the custom cores, even
// when nothing was copied this run (e.g. no --from/$LIBRETRO_CORES_DIR given
// but a prior run already populated DEST) — this is what actually stops
// `npm run deploy` from silently shipping 404 core URLs.
checkCustomCoresPresent();
