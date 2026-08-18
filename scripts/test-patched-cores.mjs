// Verifies that every core listed in public/cores/PATCHED.json ACTUALLY carries
// the patch that marker claims. Run standalone:  node scripts/test-patched-cores.mjs
// Or via npm test: wired into the package.json test chain.
//
// WHY THIS EXISTS
// ---------------
// public/cores/ is gitignored, so the core binaries are outside version control
// and nothing but PATCHED.json records which of them are local light-gun builds.
// PATCHED.json is hand-maintained, and fetch-cores.mjs trusts it: a listed core
// is SKIPPED rather than refreshed from the buildbot, on the assumption that the
// local copy is the better (patched) one.
//
// On 2026-07-29 that assumption was found to be false. `genesis_plus_gx` had been
// listed since 2026-06-20, but the multiport relink had only ever landed in the
// WSL build tree (~/lightgun-build/genesis/RetroArch/) — the artifacts were never
// copied into public/cores/. So the marker was actively PROTECTING a build that
// did not have the patch it was listed for, and fetch-cores would never repair it.
// It shipped that way for five weeks and no test could have noticed.
//
// The same sweep found the INVERSE gap: `play` and `mupen64plus_next` both carry
// the multiport patch but were absent from `cores`, so any
// `fetch-cores --from <dir>` / $LIBRETRO_CORES_DIR run copying from a machine with
// stock builds would have silently clobbered them (fetch-cores.mjs's CUSTOM_CORES
// loop only skips a core when PATCHED.has(core)). Both are listed now.
//
// TWO LISTS, ONE TEST
// -------------------
// PATCHED.json holds two intentionally-different lists, and this test checks them
// against each other AND against the artifacts on disk:
//   `cores`       — the PROTECTION list. What fetch-cores must not overwrite.
//   `patchLevels` — the FACT record. Which patches each build actually contains:
//                   "base"      = docs/patches/rwebinput-lightgun.diff
//                                 (single-gun RETRO_DEVICE_LIGHTGUN case, exports
//                                  NOTHING)
//                   "multiport" = docs/patches/rwebinput-lightgun-multiport.diff
//                                 (per-port state + the exported setters)
// They are allowed to differ: `mednafen_psx_jit` is a custom core (not on the
// buildbot) so it needs protecting whatever its patch level. Recording each level
// as fact rather than papering over it is the whole point; the base-only assertion
// below is a TRIPWIRE that goes red the moment someone relinks a core, forcing the
// record to be updated instead of drifting.
//
// History worth keeping, because it cost two days: mednafen_psx_jit was recorded
// here as base-only and cited as "the documented PSX two-gun blocker behind
// SYSTEMS.psx.lightgun2.broken (commit f98e549)". Both halves were wrong. The
// artifact on disk actually carried NEITHER patch (a 2026-07-27 restore of a
// pre-gun-work backup clobbered the gun-enabled rebuild the same day), and the
// core was never the whole blocker anyway: PSX is the only worker-execution gun
// system, and EmulatorWorkerRuntime.forwardLightgun() had no multiport branch, so
// two guns shared one DOM pointer for app-side reasons no rebuild could fix. Both
// were fixed on 2026-07-29 and the gate came down. Moral: an artifact-level record
// like this one proves what a BUILD contains, never that a FEATURE works — that
// takes a probe (npm run probe:psx-twogun).
//
// The check is deliberately dumb and artifact-level: read the emitted JS glue and
// look for the exported symbol name. Do NOT try to byte-search the .wasm instead —
// export names live in the wasm name/export section in a form that a naive byte
// search misses, and it returns false for cores that demonstrably DO work
// (verified: searching snes9x_libretro.wasm finds nothing while its JS glue and
// its runtime behaviour both prove the export is present). The `.worker.js` is no
// good either — it is pthread bootstrap glue, byte-identical between patched and
// unpatched builds of the same core, and never references the gun symbols in ANY
// core. The JS glue is the only reliable signal, because Emscripten writes a
// literal `_rwebinput_set_lightgun = Module["_rwebinput_set_lightgun"] = ...`
// thunk there.
//
// WHAT THIS TEST REFUSES TO SKIP  (adversarial review, 2026-07-29)
// ----------------------------------------------------------------
// A green run has to MEAN something. The first cut of this file exited 0 on
// five separate reachable states, each of which is either the genesis_plus_gx
// incident wearing a different hat or something strictly worse. All five were
// reproduced against a throwaway copy of public/cores/, not theorised:
//
//   1. HALF-APPLIED PATCH. The multiport branch asserted both exported setters
//      but the base-only branch asserted only the absence of the SET one, so a
//      core exporting `rwebinput_clear_lightgun` alone — a partial relink — was
//      green. Both branches now assert both names.
//
//   2. PRESENT .wasm + ABSENT .js. This used to SKIP, justified by "fetch-cores
//      only protects a listed core when its build actually exists". That is
//      wrong for the exact files involved: fetch-cores.mjs's `isProtected`
//      (:47-48) keys on the **.wasm**, not the .js, and its buildbot
//      `for (const core of CORES)` loop inside `tryCopyFrom` (:189-204) has no
//      completeness escape hatch at all — only the `for (const core of
//      CUSTOM_CORES)` loop (:205-245, via its `hasCompleteBuild` check) verifies
//      a complete build before honoring
//      protection. So a listed core with a .wasm but no .js is protected,
//      unrepairable by any `--from` fetch, and 404s the loader at runtime. It is
//      a hard FAIL now. A core that is genuinely absent entirely (no .js AND no
//      .wasm) is still a stale marker entry and still just a SKIP.
//
//   3. FALSY MARKER. `JSON.parse` happily returns null/0/false/"" for a
//      truncated or zeroed PATCHED.json, the old `if (marker)` fell through, and
//      the run reported "0 passed, 0 failed" with exit 0. The marker must now be
//      a non-null object.
//
//   4. MARKER DELETED, PATCHED CORES PRESENT. "PATCHED.json absent = clean
//      clone" was asserted in a comment and never checked. Deleting only the
//      marker while the built cores sat on disk produced a SKIP and exit 0 —
//      and that is the worst state this repo can be in, because every patched
//      build is then unprotected and the next `fetch-cores --from` clobbers all
//      of them at once.
//      The first fix over-corrected and failed on ANY core build with no
//      marker, which hard-failed the normal onboarding path (PATCHED.json is
//      gitignored and nothing in the repo creates it, so `git clone && npm run
//      fetch-cores --from <buildbot extract> && npm test` always lands there
//      with stock cores and no marker — a state where there is provably nothing
//      to protect). The check now discriminates by ARTIFACT instead of by
//      count: with no marker it scans the JS glue of every build on disk and
//      FAILS only when one actually exports the light-gun setters, i.e. a real
//      patched build is sitting unprotected. Stock-only, empty dir, and absent
//      dir all SKIP.
//
//   5. TYPO'D PATCH LEVEL. `level.includes('multiport')` was the sole
//      discriminator, so ["multiPort"], ["mutliport"] and ["base","multi-port"]
//      all fell through to the base-only TRIPWIRE and asserted that a correctly
//      patched core does NOT export the symbol — a silent inversion of the whole
//      test. Every level value must now be exactly 'base' or 'multiport'.
//
// Corollary for future edits: `continue`/SKIP in this file is only ever correct
// when there is provably no artifact to be wrong about. If a file exists and we
// cannot check it, that is a failure, not a skip.

import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORES_DIR = join(__dirname, '..', 'public', 'cores');

let pass = 0, fail = 0;

// How many CORE ARTIFACTS this run actually inspected. It is the difference
// between "green" and "green and meaningful", and on a CI runner it is zero:
// public/cores/ is gitignored (.gitignore) except the .build.json provenance
// manifests, so `git ls-files public/cores` lists metadata but NOT ONE core
// BINARY; a hosted runner reaches the no-marker branch with `builtCores = []`, fires
// ONE vacuously-true assertion (`[].filter(...).length === 0`) and reports a
// passing suite for the light-gun patch protection while proving nothing about
// it. That is precisely the shape of false green this whole file was written to
// eliminate (see "WHAT THIS TEST REFUSES TO SKIP" above) — so rather than let the
// runner count it as coverage, the suite declares itself INERT and
// scripts/run-tests.mjs reports it separately in the summary.
let artifactChecks = 0;

const ok = (name, cond, detail) => {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL  ${name}${detail ? `\n  ${detail}` : ''}`); }
};

console.log('--- PATCHED.json records the truth about each core build ---');

// Only the multiport diff exports anything; the base diff adds the single-gun
// RETRO_DEVICE_LIGHTGUN case and exports no symbols at all. So the presence of
// these two names in the JS glue is exactly "this build has the multiport patch".
const MULTIPORT_EXPORT = 'rwebinput_set_lightgun';
const MULTIPORT_CLEAR_EXPORT = 'rwebinput_clear_lightgun';
// Verified 2026-07-29: every multiport core on disk (nestopia, snes9x,
// genesis_plus_gx, play, mupen64plus_next) exports BOTH names, so the clear
// setter is asserted too. If a future core ever ships one without the other,
// that is a real linker/patch problem worth failing on, not a reason to relax
// this.

// The complete vocabulary of `patchLevels` values. Exact, case-sensitive match
// only — see failure mode 5 in the header: an unrecognised value does not fail
// on its own, it quietly routes a multiport build into the base-only tripwire
// and asserts the opposite of the truth. Adding a third patch tier means adding
// it here AND giving it a branch below.
const VALID_LEVELS = ['base', 'multiport'];

const markerPath = join(CORES_DIR, 'PATCHED.json');

// "Clean clone" is a CLAIM about the cores dir, so verify it instead of
// inferring it from the marker's absence. But "marker absent + cores present"
// is TWO different states, and only one of them is dangerous:
//
//   * STOCK cores + no marker — the normal onboarding path. public/cores/ is
//     gitignored, nothing in this repo creates PATCHED.json, and no doc ships a
//     template, so `git clone && npm run fetch-cores --from <buildbot extract>
//     && npm test` lands here every time. There is nothing to protect: a fetch
//     that "clobbers" stock cores with stock cores loses nothing. Failing this
//     would hard-fail a clean clone with a message whose every claim is false on
//     that machine.
//   * PATCHED cores + no marker — the genuinely bad state. Every local
//     light-gun build is unprotected and the very next `fetch-cores --from <dir>`
//     overwrites all of them with stock binaries in one pass (fetch-cores.mjs
//     patchedCores()/isProtected() — no marker means an empty Set and
//     isProtected() false for everything).
//
// The marker cannot tell them apart, but the ARTIFACTS can: the multiport diff
// makes Emscripten emit the exported setter names into the JS glue, so
// `grep -c rwebinput_set_lightgun <core>_libretro.js` reads 1 on a patched build
// and 0 on a stock one — the same artifact-level signal the rest of this file
// uses. So scan the builds and fail only on the real hazard.
//
// Known limit, stated rather than hidden: this detects the MULTIPORT patch only.
// The base diff (docs/patches/rwebinput-lightgun.diff) exports no symbols, so a
// base-only build with no marker is indistinguishable from stock here and will
// SKIP. That is the same blind spot the base tripwire below exists to work
// around, and it is strictly better than the previous behaviour of failing every
// fresh clone.
const builtCores = existsSync(CORES_DIR)
  ? readdirSync(CORES_DIR).filter((f) => f.endsWith('_libretro.js'))
  : [];

// Read as a Buffer: these glue files are multi-MB and Buffer#includes matches a
// plain string without paying for a full utf8 decode.
const glueCarriesMultiport = (file) => {
  try {
    const buf = readFileSync(join(CORES_DIR, file));
    return buf.includes(MULTIPORT_EXPORT) || buf.includes(MULTIPORT_CLEAR_EXPORT);
  } catch {
    return false;
  }
};

if (!existsSync(markerPath)) {
  const unprotectedPatched = builtCores.filter(glueCarriesMultiport);
  artifactChecks += builtCores.length; // every glue file on disk was read
  ok('public/cores/PATCHED.json exists whenever PATCHED core builds do',
     unprotectedPatched.length === 0,
     `public/cores/ holds ${unprotectedPatched.length} core build(s) that ACTUALLY `
     + `carry the light-gun patch (${unprotectedPatched.slice(0, 3).join(', ')}) — `
     + `verified by the '${MULTIPORT_EXPORT}' export in their JS glue — but the `
     + `protection marker PATCHED.json is MISSING. Nothing records that these are `
     + `local light-gun builds, so fetch-cores.mjs protects none of them and the next `
     + `\`npm run fetch-cores --from <dir>\` / \`npm run deploy\` will clobber `
     + `them with stock builds. Restore public/cores/PATCHED.json `
     + `(see docs/LIGHTGUN_SUPPORT.md) listing these cores in \`cores\` with a `
     + `matching \`patchLevels\` entry, re-verified with `
     + `\`grep -c ${MULTIPORT_EXPORT} public/cores/<core>_libretro.js\`.`);
  if (unprotectedPatched.length === 0) {
    console.log(builtCores.length === 0
      ? 'SKIP  public/cores/PATCHED.json absent and no core builds present (clean clone)'
      : `SKIP  public/cores/PATCHED.json absent; ${builtCores.length} core build(s) present `
        + `but none exports ${MULTIPORT_EXPORT} — stock builds, nothing to protect `
        + `(normal after a fresh clone + fetch-cores)`);
  }
} else {
  let marker = null;
  let parsed = false;
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    parsed = true;
  } catch (e) {
    ok('PATCHED.json parses as JSON', false, String(e.message));
  }

  // JSON.parse succeeds on the bare literals `null`, `0`, `false` and `""`, so a
  // truncated/zeroed marker used to sail through the old `if (marker)` guard and
  // report "0 passed, 0 failed" with exit 0 — a green run that checked nothing.
  // The marker must be a real object before any of the assertions below mean
  // anything.
  const isObject = typeof marker === 'object' && marker !== null && !Array.isArray(marker);
  if (parsed) {
    ok('PATCHED.json is a JSON object', isObject,
       `PATCHED.json parsed to ${marker === null ? 'null' : Array.isArray(marker) ? 'an array' : typeof marker} `
       + `(${String(JSON.stringify(marker)).slice(0, 60)}). A falsy or non-object marker means `
       + `fetch-cores.mjs's patchedCores() protects NOTHING (it reads m.cores off this `
       + `value) while this test silently verifies nothing. Restore the marker.`);
  }

  if (isObject) {
    ok('PATCHED.json has a `cores` array', Array.isArray(marker.cores),
       `got: ${JSON.stringify(marker.cores)}`);

    ok('PATCHED.json names the multiport patch in its `patch` field',
       typeof marker.patch === 'string' && marker.patch.includes('multiport'),
       `patch: ${JSON.stringify(marker.patch)}`);

    const levels = marker.patchLevels;
    ok('PATCHED.json has a `patchLevels` object',
       levels && typeof levels === 'object' && !Array.isArray(levels),
       `got: ${JSON.stringify(levels)}`);

    const cores = Array.isArray(marker.cores) ? marker.cores : [];
    const levelKeys = (levels && typeof levels === 'object' && !Array.isArray(levels))
      ? Object.keys(levels) : [];

    // Drift guard, both directions. The two lists mean different things and may
    // legitimately hold different VALUES, but they must cover the same cores —
    // a protected core with no recorded patch level is exactly the blind spot
    // that let genesis_plus_gx ship stale, and a recorded level for an
    // unprotected core is a build nothing stops fetch-cores from clobbering.
    for (const core of cores) {
      ok(`${core}: protected in \`cores\` and recorded in \`patchLevels\``,
         Array.isArray(levels?.[core]) && levels[core].length > 0,
         `'${core}' is in PATCHED.json's \`cores\` (so fetch-cores will refuse to `
         + `overwrite it) but has no \`patchLevels\` entry, so nothing records — or `
         + `checks — which patches that build actually carries. Add `
         + `"${core}": ["base"] or ["base","multiport"], verified with `
         + `\`grep -c ${MULTIPORT_EXPORT} public/cores/${core}_libretro.js\` (1 = multiport).`);
    }
    for (const core of levelKeys) {
      ok(`${core}: recorded in \`patchLevels\` and protected in \`cores\``,
         cores.includes(core),
         `'${core}' has a \`patchLevels\` entry but is missing from \`cores\`, so `
         + `fetch-cores.mjs will happily overwrite this local light-gun build with a `
         + `stock one from --from/$LIBRETRO_CORES_DIR. Add it to \`cores\`.`);
    }

    for (const core of cores) {
      const level = Array.isArray(levels?.[core]) ? levels[core] : null;
      if (!level) continue; // already failed the drift check above

      // `level.includes('multiport')` is the single discriminator between the
      // two branches below, so a typo does not fail — it INVERTS the test.
      // ["multiPort"] / ["mutliport"] / ["base","multi-port"] all fall to the
      // base-only tripwire and then assert that a correctly patched core does
      // NOT export the setter. Validate the vocabulary before trusting it.
      const badLevels = level.filter((v) => !VALID_LEVELS.includes(v));
      ok(`${core}: patchLevels values are all ${VALID_LEVELS.map(v => `"${v}"`).join(' or ')}`,
         badLevels.length === 0,
         `'${core}' records ${JSON.stringify(badLevels)}, which this test does not `
         + `recognise. The only valid values are ${JSON.stringify(VALID_LEVELS)}; anything `
         + `else silently reads as "not multiport" and flips the export check into its `
         + `opposite. Fix the spelling in public/cores/PATCHED.json.`);
      if (badLevels.length) continue; // don't run an inverted assertion on garbage

      const glue = join(CORES_DIR, `${core}_libretro.js`);
      const wasm = join(CORES_DIR, `${core}_libretro.wasm`);
      const hasGlue = existsSync(glue);
      const hasWasm = existsSync(wasm);

      if (!hasGlue && !hasWasm) {
        // Genuinely absent — no artifact exists to be wrong about. isProtected()
        // (fetch-cores.mjs `isProtected`, :47-48) keys on the .wasm, so with no .wasm this entry
        // protects nothing and a fetch will simply install a stock build. Stale
        // marker entry, not a broken build.
        console.log(`SKIP  ${core}: listed in PATCHED.json but no build present (no .js, no .wasm)`);
        continue;
      }
      artifactChecks++; // a real build is on disk and is about to be checked

      // NOT a skip: .wasm present + .js missing is a genuinely broken, actively
      // protected, unrepairable build. isProtected() sees the .wasm and returns
      // true, and the buildbot `for (const core of CORES)` loop in
      // fetch-cores.mjs's `tryCopyFrom` (:189-204) has NO completeness escape
      // hatch — only the `for (const core of CUSTOM_CORES)` loop (:205-245,
      // via `hasCompleteBuild`) does —
      // so `--from` will refuse to restore the missing glue. Meanwhile the app
      // 404s on the .js at load. Same shape as the genesis_plus_gx incident with
      // a different file missing, and unlike it, immediately fatal at runtime.
      ok(`${core}: build is complete (.js present alongside .wasm)`, hasGlue,
         `${core}_libretro.wasm exists but ${core}_libretro.js does NOT. PATCHED.json `
         + `lists this core, and fetch-cores.mjs's isProtected() keys on the .wasm, so `
         + `this half-build is protected and \`fetch-cores --from <dir>\` will NOT repair `
         + `it (the buildbot CORES loop has no completeness check — only CUSTOM_CORES `
         + `does). The loader will 404 on the missing glue at runtime. Copy the matching `
         + `.js from the build tree (docs/LIGHTGUN_SUPPORT.md), or remove both the `
         + `orphaned .wasm and this core's PATCHED.json entries so a fetch can install a `
         + `stock build.`);
      if (!hasGlue) continue;

      const src = readFileSync(glue, 'utf8');
      const hasSet = src.includes(MULTIPORT_EXPORT);
      const hasClear = src.includes(MULTIPORT_CLEAR_EXPORT);

      if (level.includes('multiport')) {
        ok(`${core} exports ${MULTIPORT_EXPORT} (patchLevels says multiport)`,
           hasSet,
           `${core}_libretro.js has no '${MULTIPORT_EXPORT}' — PATCHED.json protects this core `
           + `from fetch-cores, so a stock/stale build here is invisible AND unrepairable. `
           + `Relink from the build tree (docs/LIGHTGUN_SUPPORT.md) and copy BOTH the .js and `
           + `.wasm into public/cores/, or correct this core's \`patchLevels\` entry to ["base"].`);

        ok(`${core} exports ${MULTIPORT_CLEAR_EXPORT} (patchLevels says multiport)`,
           hasClear,
           `${core}_libretro.js has no '${MULTIPORT_CLEAR_EXPORT}' — the multiport diff adds `
           + `BOTH setters, so a build carrying only one of them is a half-applied patch or a `
           + `partial relink. Rebuild per docs/LIGHTGUN_SUPPORT.md rather than trusting it.`);
      } else {
        // TRIPWIRE (see the header). A base-only core must NOT have EITHER
        // export. Asserting only `!hasSet` here left the branch half-blind and
        // asymmetric with the multiport branch above: a build carrying just
        // `rwebinput_clear_lightgun` (half-applied diff, partial relink, an
        // interrupted copy of the two artifacts) passed green while being
        // neither base-only nor a working multiport build. Both names, both
        // directions.
        const found = [hasSet && MULTIPORT_EXPORT, hasClear && MULTIPORT_CLEAR_EXPORT]
          .filter(Boolean);
        ok(`${core} exports NEITHER lightgun setter (patchLevels says base-only)`,
           !hasSet && !hasClear,
           `${core}_libretro.js DOES export ${found.map(f => `'${f}'`).join(' and ')}, but `
           + `PATCHED.json records '${core}' as base-only.\n  `
           + (found.length === 2
             ? `Both setters present = a full multiport build, expected after a rebuild: `
               + `update this core's \`patchLevels\` entry to ["base","multiport"]. Do NOT `
               + `treat that as two guns working — the export only makes it POSSIBLE. Also `
               + `confirm the app CALLS it on this core's execution path (main-thread cores `
               + `via EmulatorClient._resolveWebgun, worker-execution cores via `
               + `EmulatorWorkerRuntime.resolveWebgun), then verify with a probe before `
               + `flipping any SYSTEMS.<system>.lightgun2.broken to false.`
             : `Only ONE of the two setters is present, which is not a state either diff `
               + `produces — a half-applied patch or a partial relink. Rebuild per `
               + `docs/LIGHTGUN_SUPPORT.md rather than recording it as multiport.`));
      }
    }
  }
}

// --- Honesty report --------------------------------------------------------
// A pass that inspected no artifact is not coverage. Say so on stdout for a
// human, and — when run under scripts/run-tests.mjs — in the machine-readable
// status file it hands us, so the tier summary can print "(1 inert)" instead of
// counting this run as a verified suite. Writing a FILE rather than parsing
// stdout keeps the runner's `stdio: 'inherit'` (and therefore the interleaving of
// every suite's own output) exactly as it was.
if (artifactChecks === 0) {
  console.log(
    'SUITE-STATUS: inert — 0 core artifacts inspected. public/cores/ is gitignored, so on a\n'
    + '              CI runner and on a fresh clone there is no build here to verify and the\n'
    + '              assertions above are structural or vacuous. Run `npm run fetch-cores`\n'
    + '              (or build the light-gun cores) to make this suite mean something.',
  );
} else {
  console.log(`SUITE-STATUS: ok — ${artifactChecks} core artifact(s) inspected`);
}
if (process.env.SUITE_STATUS_FILE) {
  try {
    writeFileSync(process.env.SUITE_STATUS_FILE,
      artifactChecks === 0 ? 'inert 0 core artifacts on disk (public/cores/ is gitignored)' : `ok ${artifactChecks} artifacts`);
  } catch { /* the report is a nicety; never fail the suite over it */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
