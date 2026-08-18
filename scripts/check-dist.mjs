#!/usr/bin/env node
/**
 * check-dist.mjs — refuse to publish anything that isn't ours to publish.
 *
 * WHY THIS EXISTS
 * ---------------
 * `.gitignore` is not the publishing boundary of this project. Vite copies the
 * WHOLE of `public/` into `dist/`, and `scripts/deploy.ps1` scp's every top-level
 * item of `dist/` to a public web server. Nothing checked what was in there, so
 * a stray `.env`, an editor backup, a pre-patch `*.wasm.bak` core (8 of them were
 * being shipped), or a ROM nobody has redistribution rights to would go out
 * silently. This file re-derives the verdict from the bytes actually on disk, so
 * it holds even if the Vite plugin is deleted, mis-ordered, silently no-ops, or
 * someone hand-copies a file into `dist/`. It deliberately imports nothing from
 * the build and knows nothing about how `dist/` was produced.
 *
 * `public/roms/local/` IS DELIBERATE — READ THIS BEFORE "FIXING" IT
 * ----------------------------------------------------------------
 * Both whole-repo reviews (CLAUDE_REVIEW.md §4.7, CODEX_REVIEW.md SEC-1) rank
 * "`npm run deploy` can publish the private ROM library" as their single CRITICAL
 * finding. For a normal project they would be right. Here they are not, and this
 * has now been re-litigated twice:
 *
 *   - 2026-06-24: a `stripLocalRoms` guard was added to vite.config.js (0df8aeb)
 *     and REVERTED (b192911) once the user corrected the intent.
 *   - 2026-08-14: acting on the two reviews, it was added again — and reverted
 *     again, for the same reason.
 *
 * The constraint is about the GIT REPO, not the deploy. `.gitignore` keeps
 * `public/roms/local/` out of git; dionysus.dk is the USER'S OWN box, and putting
 * those ROMs on it is the only practical way to test light guns on a real Quest
 * (real HTTPS = WebXR secure context, no `adb reverse`). The redistributable
 * light-gun game universe is essentially empty — Zap Ruder, SMS-A-Sketch, SGDK
 * joy-test — which is why this project authors its own CC0 galleries. The user,
 * asked directly on 2026-08-14: "Its just some test roms. Hard to make sure
 * lightguns work without real lightgun games. Its temporary."
 *
 * So `roms/local/` is PUBLISHED BY DEFAULT and merely REPORTED here, loudly, with
 * its file count and size — you should always know what you just put on the web.
 * Stripping it also strips `roms/local/amiga/kick*.A500`, and `src/systems.js`
 * points PUAE's `systemFiles` there, so deployed Amiga silently stops booting.
 *
 *   --strict  (or CHECK_DIST_STRICT=1) flips it to a hard refusal.
 *
 * Use `--strict` for a genuinely public release — a shared demo, a link to
 * strangers, anything that is not the user's own test box. Everything else in
 * this file (backups, credentials, VCS/deps, scratch output, unlisted ROMs under
 * roms/freeware/, size budgets) is a hard refusal in BOTH modes.
 *
 * ROMS ARE ALLOWLISTED BY IDENTITY, NOT BY FOLDER
 * ------------------------------------------------
 * `roms/freeware/` used to be blanket-allowed: any name, any extension, no size
 * check. That left exactly one route by which a private ROM could still ride out
 * — drop it in `public/roms/freeware/` (or hand-copy it into `dist/roms/freeware/`)
 * and the guard said "OK". A commercial `lethal-enforcers.smc` planted there
 * passed with exit 0. Extension can never separate a freeware SNES ROM from a
 * commercial one (both are `.sfc`/`.smc`), so the discriminator is IDENTITY: a
 * file may ship out of `roms/freeware/` only if its name is on FREEWARE_ALLOW
 * below, or is referenced by one of the git-TRACKED descriptors in
 * `public/roms/*.json`. Both are reviewable, committed acts. Dropping a file into
 * a folder is not.
 *
 * USAGE
 *   node scripts/check-dist.mjs             # check ./dist
 *   node scripts/check-dist.mjs path/to/dir # check another directory
 *
 *   node scripts/check-dist.mjs --strict    # also refuse the private ROM tree
 *
 * Exit codes:  0 = clean   1 = violations found   2 = usage / no dist
 *
 * Env overrides (numbers, in MiB):
 *   CHECK_DIST_MAX_FILE_MB   per-file budget    (default 32)
 *   CHECK_DIST_MAX_TOTAL_MB  whole-tree budget  (default 400)
 *   CHECK_DIST_MAX_ROM_MB    per-ROM budget for roms/freeware/ (default 16)
 *   CHECK_DIST_STRICT=1      refuse public/roms/local/ too (same as --strict)
 *
 * The size budgets deliberately EXCLUDE the private tree: it is the user's own
 * multi-GB library and measuring the app against it would make the budget useless.
 *
 * PER-CHUNK JS BUDGETS  (BUNDLE_BUDGETS, below)
 * ---------------------------------------------
 * The three budgets above are ASSET budgets — they catch a stray 40 MiB video,
 * not a bundle regression. The whole of `dist/assets/` is ~1.05 MiB of JS, so the
 * only ceiling it ever faced was the generic 32 MiB per-file rule: an import
 * regression pulling `three` into the desktop chunk, or an eager Collection/TestApi
 * import tripling main.js, cleared every gate in the project (`npm test` does not
 * build; rollup's chunk-size warning is advisory and was at its default). Nothing
 * measured the compressed size at all — the number that actually governs how long
 * a Quest stares at a black screen on a first load.
 *
 * So each named chunk gets a raw AND a gzip ceiling, seeded from measured sizes
 * with ~20% headroom, and gzip is the one to care about. Unnamed/lazy chunks fall
 * back to DEFAULT_BUNDLE_BUDGET.
 *
 * RAISING A BUDGET IS A DELIBERATE, REVIEWED ACT. A number bumped in the same
 * commit as the growth that broke it is not a budget, it is a changelog. If a
 * chunk legitimately grew, say why in the commit message; if it grew by accident,
 * the violation message names the chunk and the overage — go find the import.
 * `checkDist(dir, { chunkBudgets: false })` turns just this rule off — for
 * auditing a dist/ that came from somewhere else, where a bundle policy about
 * OUR chunk names means nothing. There is no env var for it on purpose: the
 * build and the deploy must not be able to opt out.
 *
 * `vite.config.js` sets `build.chunkSizeWarningLimit` to the LARGEST budget here,
 * because rollup only has one global threshold: at anything lower it warns about
 * `three` on every single build, and an advisory that fires on a known-good chunk
 * teaches people to ignore it. The per-chunk policy lives here, where it can be
 * per-chunk and can actually fail.
 *
 * Used as a postbuild step AND as the pre-upload gate in scripts/deploy.ps1 —
 * a deploy aborts before the first scp if this exits nonzero. vite.config.js also
 * calls checkDist() on the RESOLVED build.outDir and throws, so a build into a
 * non-default `--outDir` is guarded too (the npm `postbuild` hook only ever looks
 * at ./dist).
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MiB = 1024 * 1024;

export const DEFAULT_MAX_FILE_MB = 32;
export const DEFAULT_MAX_TOTAL_MB = 400;
/** Per-file ceiling for anything under roms/freeware/. Biggest today is ~1.0 MiB. */
export const DEFAULT_MAX_ROM_MB = 16;

/**
 * Per-chunk JS/CSS budgets for `dist/assets/`, keyed by rollup CHUNK NAME (the
 * part before the content hash). See the header for why these exist and what
 * raising one means.
 *
 * Seeded 2026-08-17 from a real build, with ~20% headroom:
 *
 *   chunk                   raw       gzip     ← measured
 *   three                 616,936   157,976
 *   main                  307,845    98,658
 *   Collection            107,271    33,720
 *   EmulatorWorkerRuntime  29,960     8,664
 *   desktop                25,554     9,429
 *   DiscIdentity            3,218     1,511
 *   RackSpike               3,256     1,598
 *
 * Only the first five get named budgets below. `DiscIdentity` and `RackSpike` are
 * ~3 KB and deliberately fall through to DEFAULT_BUNDLE_BUDGET — pinning a 3 KB
 * chunk buys nothing and would fail the build on any honest edit to it.
 *
 * `desktop` is the tight one on purpose: the flat-screen entry never imports
 * three, and its budget is what turns "the desktop chunk quietly swallowed the
 * renderer" from a 25x size regression nobody notices into a failed build.
 */
export const BUNDLE_BUDGETS = {
  three: { bytes: 740_000, gzip: 190_000 },
  main: { bytes: 380_000, gzip: 120_000 },
  Collection: { bytes: 140_000, gzip: 45_000 },
  EmulatorWorkerRuntime: { bytes: 60_000, gzip: 20_000 },
  desktop: { bytes: 60_000, gzip: 20_000 },
};

/** Ceiling for a chunk with no entry above — i.e. any new or lazy-split chunk. */
export const DEFAULT_BUNDLE_BUDGET = { bytes: 200_000, gzip: 64_000 };

/**
 * Rollup chunk name for a hashed asset filename, or null if it doesn't look like
 * one. `three-CQREgBuk.js` -> `three`; `EmulatorWorkerRuntime-DdW6BZJd.js` ->
 * `EmulatorWorkerRuntime`. Only `.js`/`.css` are budgeted — a hashed .png in
 * assets/ is an asset, and the per-file budget already covers it.
 */
export function chunkNameOf(rel) {
  if (!rel.startsWith('assets/')) return null;
  const base = path.posix.basename(rel);
  const m = /^(.+)-[A-Za-z0-9_-]{6,12}\.(js|css)$/.exec(base);
  return m ? m[1] : null;
}

export function bundleBudgetFor(name) {
  return BUNDLE_BUDGETS[name] ?? DEFAULT_BUNDLE_BUDGET;
}

/** Repo root = parent of this scripts/ dir. Used to read the TRACKED descriptors. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Hard denies, matched against a POSIX-style path relative to dist/.
 * vite.config.js imports this list and uses it to filter the public/ copy, so
 * the build and the guard cannot drift apart on what "private" means.
 */
export const DENY_RULES = [
  {
    id: 'backup-file',
    why: 'editor/build backup file (e.g. the pre-patch *.wasm.bak cores)',
    test: (rel) => /\.(bak|orig|rej|swp|tmp)$/i.test(rel) || /\.bak(\.[^/]*)?$/i.test(rel),
  },
  {
    id: 'credential',
    why: 'looks like a credential or private key',
    test: (rel) => /(^|\/)(\.env(\..+)?|id_rsa|id_ed25519|.+\.pem|.+\.p12|.+\.pfx|.+\.key|.+\.ppk)$/i.test(rel),
  },
  {
    id: 'vcs-or-deps',
    why: 'source-control / dependency directory',
    test: (rel) => /(^|\/)(\.git|\.svn|node_modules)(\/|$)/.test(rel),
  },
  {
    id: 'scratch',
    why: 'local scratch/probe output, never shippable',
    test: (rel) => /(^|\/)(tmp|\.vite|coverage)(\/|$)/.test(rel),
  },
];

/** Only these may appear at the top level of dist/. */
export const TOP_LEVEL_ALLOW = new Set([
  '.htaccess',        // COOP/COEP headers — crossOriginIsolated depends on it
  'index.html',       // VR entry point
  'desktop.html',     // flat-screen entry point
  'headset-test.html',
  // Its script, extracted from an inline <script> so the shipped CSP can drop
  // 'unsafe-inline' (SEC-6, [[scripts/test-csp.mjs]]). It is a sibling of the
  // page above, not a bundle — vite copies it verbatim out of public/.
  'headset-test.js',
  'favicon.svg',
  'assets',           // vite bundles (content-hashed)
  'cores',            // libretro cores, fetched by scripts/fetch-cores.mjs
  'roms',             // gated further by romsPathAllowed() below
]);

/** Extensions permitted anywhere except roms/freeware/ (which ships ROM images). */
export const EXT_ALLOW = new Set([
  'html', 'htm', 'js', 'mjs', 'cjs', 'css', 'map', 'json', 'webmanifest', 'xml',
  'wasm', 'data', 'mem',
  'svg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'ico', 'avif',
  'woff', 'woff2', 'ttf', 'otf',
  'glb', 'gltf',
  'mp3', 'ogg', 'wav', 'mp4', 'webm',
  'txt', 'md',
]);

/** Extension-less files that are still fine (dotfiles, host config). */
export const NAME_ALLOW = new Set(['.htaccess', '.nojekyll', '_headers', '_redirects', 'robots.txt', 'LICENSE']);

/**
 * ROM/disc extensions that MAY appear under roms/freeware/ (and only there).
 * This is a type gate, NOT the security control — `.sfc`/`.smc`/`.bin` are the
 * same extensions a commercial dump uses. FREEWARE_ALLOW below is what actually
 * decides. Kept deliberately generous so adding a new authored system is a
 * one-line allowlist entry, not an extension archaeology session.
 */
export const ROM_EXT_ALLOW = new Set([
  'a26', 'adf', 'adz', 'bin', 'cdi', 'chd', 'col', 'cue', 'd64', 'dsk', 'elf',
  'gb', 'gba', 'gbc', 'gdi', 'gg', 'hdf', 'img', 'int', 'ipf', 'iso', 'lnx',
  'm3u', 'md', 'mds', 'n64', 'nes', 'ngc', 'ngp', 'pbp', 'pce', 'prg', 'rom',
  'sfc', 'sg', 'sgx', 'smc', 'sms', 't64', 'tap', 'toc', 'v64', 'vb', 'vec',
  'ws', 'wsc', 'z64', 'zip', '32x',
]);

/**
 * Sidecar extensions allowed to ride along with an allowlisted ROM of the SAME
 * stem — e.g. `lwx-psx-testdisc.cue` + `lwx-psx-testdisc.bin`. The stem must
 * already be allowlisted, so this cannot introduce a new title.
 */
export const SIDECAR_EXT = new Set(['bin', 'cue', 'ccd', 'sub', 'img', 'iso', 'm3u', 'toc', 'gdi', 'mds', 'mdf', 'sbi', 'nfo', 'txt']);

/**
 * THE freeware allowlist: exact filenames under roms/freeware/ that this project
 * has the right to publish. Everything here is CC0 content this repo BUILDS
 * (games/ + scripts/make-*.mjs) and git TRACKS — `.gitignore` force-includes
 * `public/roms/freeware/`, so `git ls-files public/roms/freeware/` regenerates
 * this list exactly.
 *
 * ADDING A GAME: add its filename here (and normally to public/roms/manifest.json
 * too). Rebuilding an existing game does NOT need a change — names are pinned,
 * not hashes, so `npm run make-*` never breaks the build.
 *
 * DO NOT add a title you don't hold redistribution rights to just to make the
 * build go green. That is the entire point of this list.
 */
export const FREEWARE_ALLOW = new Set([
  'lwx-amiga-demo.adf',
  'lwx-atari-dodger.a26',
  'lwx-demo.prg',
  'lwx-gb-snake.gb',
  'lwx-gba-paint.gba',
  'lwx-genesis-demo.md',
  'lwx-gg-arcade.gg',
  'lwx-n64-scene.z64',
  'lwx-n64-smoke.z64',
  'lwx-nes-bomberman.nes',
  'lwx-nes-gallery.nes',
  'lwx-nes-opwolf.nes',
  'lwx-nes-pong.nes',
  'lwx-nes-zapper-test.nes',
  'lwx-pce-pong.pce',
  'lwx-ps2-guncon-range.elf',
  'lwx-psx-testdisc.bin',
  'lwx-psx-testdisc.cue',
  'lwx-sms-arcade.sms',
  'lwx-snake.prg',
  'lwx-snes-demo.sfc',
  'lwx-snes-opwolf.sfc',
  'lwx-snes-scope.sfc',
  'lwx-vb-demo.vb',
  'lwx-vic20-demo.prg',
]);

/**
 * Second source of freeware identity: names referenced by the git-TRACKED
 * descriptors in `public/roms/*.json` (manifest.json, *.collection.json,
 * *.room.json). This is what lets a manually-downloaded homebrew pointer
 * (super-tilt-bro.nes, anguna.gba, …) ship without editing this file.
 *
 * Read from the REPO SOURCE, never from the directory being scanned: a
 * descriptor sitting inside dist/ is just bytes that arrived somehow, and
 * trusting it would let a planted `evil.collection.json` authorise a planted
 * ROM. `public/roms/*.json` is committed and shows up in review.
 *
 * Returns an empty set (with the pinned list still in force) if the repo source
 * isn't there — e.g. when auditing a dist/ downloaded from somewhere else.
 */
export function trackedRomRefs(repoRoot = REPO_ROOT) {
  const refs = new Set();
  const dir = path.join(repoRoot, 'public', 'roms');
  if (!existsSync(dir)) return refs;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return refs;
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    let txt;
    try {
      txt = readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const m of txt.matchAll(/freeware\/([A-Za-z0-9 ._()+-]+)/g)) refs.add(m[1]);
  }
  return refs;
}

/** POSIX basename minus its final extension. */
function stemOf(base) {
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(0, i) : base;
}

/**
 * Decide whether one file under roms/freeware/ may be published.
 * @returns {null | string} null = allowed, otherwise the reason it is refused.
 */
export function freewareVerdict(rel, allowNames) {
  const base = path.posix.basename(rel);
  const ext = base.includes('.') && !base.startsWith('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';

  if (NAME_ALLOW.has(base)) return null;
  if (!EXT_ALLOW.has(ext) && !ROM_EXT_ALLOW.has(ext)) {
    return `file type '${ext || base}' is not publishable, even under roms/freeware/`;
  }
  if (allowNames.has(base)) return null;
  // Sidecar of an already-allowlisted title (cue/bin pairs, .m3u playlists).
  if (SIDECAR_EXT.has(ext)) {
    const stem = stemOf(base);
    for (const allowed of allowNames) if (stemOf(allowed) === stem) return null;
  }
  return (
    `'${base}' is not an allowlisted freeware title — roms/freeware/ is NOT a ` +
    'blanket "anything here is publishable" folder. Add the name to FREEWARE_ALLOW ' +
    'in scripts/check-dist.mjs (or reference it from a tracked public/roms/*.json) ' +
    'ONLY if this project may legally redistribute it.'
  );
}

/**
 * Mirrors .gitignore's public/roms/* policy: only the freeware tree and the
 * pointer-only descriptors ship. Anything ELSE under roms/ is assumed private,
 * so a future `public/roms/mydiscs/` is caught without editing this file.
 */
export function romsPathAllowed(rel) {
  const sub = rel.slice('roms/'.length);
  if (sub.startsWith('freeware/')) return true;
  if (sub.includes('/')) return false;
  return (
    sub === 'README.md' ||
    sub === 'manifest.json' ||
    sub.endsWith('.collection.json') ||
    sub.endsWith('.room.json')
  );
}

export function matchDeny(rel) {
  for (const rule of DENY_RULES) if (rule.test(rel)) return rule;
  return null;
}

/**
 * The user's private sideload. NOT a deny rule — see the header. Published by
 * default (that is the headset light-gun test path), refused under --strict.
 */
export const PRIVATE_ROMS_WHY =
  "the user's private ROM/disc sideload (public/roms/local — gitignored, commercial, multi-GB)";
export function isPrivateRomPath(rel) {
  return rel === 'roms/local' || rel.startsWith('roms/local/');
}

/** True when the caller asked for a public-release-grade check. */
export function strictFromEnv(env = process.env) {
  return /^(1|true|yes|on)$/i.test(env.CHECK_DIST_STRICT ?? '');
}

/** Recursive walk that never follows symlinks/junctions (they'd escape dist/). */
function walk(dir, base, out) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      out.push({ rel, size: 0, kind: 'symlink' });
      continue;
    }
    if (st.isDirectory()) {
      // Record denied directories as a single entry rather than recursing into
      // 3.7 GB of them — one clear line beats 65 duplicates. Same for the
      // private tree, which is allowed but is multi-GB and equally not worth
      // enumerating file by file.
      if (matchDeny(rel) || isPrivateRomPath(rel)) {
        out.push({ rel, size: dirSize(abs), kind: 'dir' });
        continue;
      }
      walk(abs, base, out);
      continue;
    }
    out.push({ rel, size: st.size, kind: 'file' });
  }
  return out;
}

function dirSize(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) continue;
    total += st.isDirectory() ? dirSize(abs) : st.size;
  }
  return total;
}

/**
 * @returns {{ok: boolean, violations: Array, entries: Array, totalBytes: number,
 *             maxFileBytes: number, maxTotalBytes: number}}
 */
export function checkDist(distDir, opts = {}) {
  const maxFileBytes = (opts.maxFileMB ?? Number(process.env.CHECK_DIST_MAX_FILE_MB) ?? NaN) * MiB;
  const maxTotalBytes = (opts.maxTotalMB ?? Number(process.env.CHECK_DIST_MAX_TOTAL_MB) ?? NaN) * MiB;
  const maxRomBytes = (opts.maxRomMB ?? Number(process.env.CHECK_DIST_MAX_ROM_MB) ?? NaN) * MiB;
  const fileBudget = Number.isFinite(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : DEFAULT_MAX_FILE_MB * MiB;
  const totalBudget = Number.isFinite(maxTotalBytes) && maxTotalBytes > 0 ? maxTotalBytes : DEFAULT_MAX_TOTAL_MB * MiB;
  const romBudget = Number.isFinite(maxRomBytes) && maxRomBytes > 0 ? maxRomBytes : DEFAULT_MAX_ROM_MB * MiB;

  // Union of the pinned list and whatever the tracked descriptors reference.
  const allowNames = new Set(FREEWARE_ALLOW);
  for (const n of trackedRomRefs(opts.repoRoot ?? REPO_ROOT)) allowNames.add(n);

  const strict = opts.strict ?? strictFromEnv();
  const violations = [];
  const entries = walk(distDir, distDir, []);
  const privatePaths = [];
  const chunkSizes = [];
  let totalBytes = 0;
  let privateBytes = 0;

  for (const e of entries) {
    // The private sideload is a deliberate, documented publication (see header).
    // Report it, never measure the app's size budgets against it, and only
    // refuse it when the caller explicitly asked for a public-release check.
    if (isPrivateRomPath(e.rel)) {
      privateBytes += e.size;
      privatePaths.push({ rel: e.rel + (e.kind === 'dir' ? '/' : ''), size: e.size });
      if (strict) {
        violations.push({ rule: 'private-roms', rel: e.rel + (e.kind === 'dir' ? '/' : ''), size: e.size, why: PRIVATE_ROMS_WHY });
      }
      continue;
    }

    totalBytes += e.size;
    const top = e.rel.split('/')[0];

    if (e.kind === 'symlink') {
      violations.push({ rule: 'symlink', rel: e.rel, size: 0, why: 'symlink/junction in build output (can point anywhere)' });
      continue;
    }

    const denied = matchDeny(e.rel);
    if (denied) {
      violations.push({ rule: denied.id, rel: e.rel + (e.kind === 'dir' ? '/' : ''), size: e.size, why: denied.why });
      continue;
    }

    if (!TOP_LEVEL_ALLOW.has(top)) {
      violations.push({ rule: 'not-allowlisted', rel: e.rel, size: e.size, why: `'${top}' is not an allowlisted top-level dist entry` });
      continue;
    }

    if (top === 'roms' && !romsPathAllowed(e.rel)) {
      violations.push({ rule: 'not-allowlisted', rel: e.rel, size: e.size, why: 'under roms/ only freeware/ and the *.json/README pointers may ship' });
      continue;
    }

    if (e.rel.startsWith('roms/freeware/')) {
      // roms/freeware/ ships actual ROM images, so it gets its OWN rules: an
      // identity allowlist (see freewareVerdict) and a tighter size ceiling.
      // It is NOT blanket-allowed — that was the last route out for a private ROM.
      const reason = freewareVerdict(e.rel, allowNames);
      if (reason) {
        violations.push({ rule: 'unlisted-rom', rel: e.rel, size: e.size, why: reason });
        continue;
      }
      if (e.size > romBudget) {
        violations.push({
          rule: 'oversize-rom',
          rel: e.rel,
          size: e.size,
          why: `exceeds the ${(romBudget / MiB).toFixed(0)} MiB per-ROM budget for roms/freeware/ ` +
            '(a commercial disc image looks exactly like this)',
        });
        continue;
      }
    } else {
      const base = path.posix.basename(e.rel);
      const ext = base.includes('.') && !base.startsWith('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
      if (!NAME_ALLOW.has(base) && !EXT_ALLOW.has(ext)) {
        violations.push({ rule: 'unexpected-type', rel: e.rel, size: e.size, why: `file type '${ext || base}' is not on the publishable allowlist` });
        continue;
      }
    }

    if (e.size > fileBudget) {
      violations.push({ rule: 'oversize-file', rel: e.rel, size: e.size, why: `exceeds the ${(fileBudget / MiB).toFixed(0)} MiB per-file budget` });
      continue;
    }

    // Per-chunk JS budget. Deliberately AFTER the per-file check: if a chunk is
    // already over the 32 MiB asset ceiling, gzipping it to report a second
    // number about the same file is pointless work on a build that is failing
    // anyway.
    const chunk = e.kind === 'file' ? chunkNameOf(e.rel) : null;
    if (chunk && opts.chunkBudgets !== false) {
      const budget = bundleBudgetFor(chunk);
      const named = Object.hasOwn(BUNDLE_BUDGETS, chunk);
      if (e.size > budget.bytes) {
        violations.push({
          rule: 'oversize-chunk',
          rel: e.rel,
          size: e.size,
          why: `chunk '${chunk}' is ${fmt(e.size)}, over its ${fmt(budget.bytes)} raw budget by ` +
            `${fmt(e.size - budget.bytes)}${named ? '' : ' (no named budget — DEFAULT_BUNDLE_BUDGET applies)'}. ` +
            'Find the import that grew it before raising the number in scripts/check-dist.mjs.',
        });
        continue;
      }
      // GZIP IS THE PRIMARY SIGNAL: it is what crosses the wire to the headset,
      // and raw size can stay flat while compressed size doubles (a minifier
      // change, an inlined data: URI, duplicated code that no longer dedupes).
      let gz = 0;
      try {
        gz = gzipSync(readFileSync(path.join(distDir, e.rel.split('/').join(path.sep))), { level: 9 }).length;
      } catch {
        // Unreadable is somebody else's violation to raise; don't invent one.
        gz = 0;
      }
      if (gz > budget.gzip) {
        violations.push({
          rule: 'oversize-chunk',
          rel: e.rel,
          size: e.size,
          why: `chunk '${chunk}' gzips to ${fmt(gz)}, over its ${fmt(budget.gzip)} gzip budget by ` +
            `${fmt(gz - budget.gzip)}${named ? '' : ' (no named budget — DEFAULT_BUNDLE_BUDGET applies)'}. ` +
            'Compressed size is what a Quest actually downloads on a cold load.',
        });
        continue;
      }
      chunkSizes.push({ rel: e.rel, chunk, bytes: e.size, gzip: gz, budget });
    }
  }

  if (totalBytes > totalBudget) {
    violations.push({
      rule: 'oversize-total',
      rel: '(whole tree)',
      size: totalBytes,
      why: `dist/ is ${fmt(totalBytes)}, over the ${(totalBudget / MiB).toFixed(0)} MiB total budget`,
    });
  }

  return {
    ok: violations.length === 0,
    violations,
    entries,
    totalBytes,
    maxFileBytes: fileBudget,
    maxTotalBytes: totalBudget,
    maxRomBytes: romBudget,
    allowNames,
    strict,
    privatePaths,
    privateBytes,
    chunkSizes,
  };
}

export function fmt(bytes) {
  if (bytes >= 1024 * MiB) return `${(bytes / (1024 * MiB)).toFixed(2)} GiB`;
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function main(argv) {
  const flags = argv.filter((a) => a.startsWith('-') && a !== '--');
  const args = argv.filter((a) => a !== '--' && !a.startsWith('-'));
  const strict = flags.includes('--strict') || strictFromEnv();
  const target = args[0] ? path.resolve(args[0]) : path.resolve(process.cwd(), 'dist');

  if (!existsSync(target)) {
    console.error(`check-dist: FAIL — no such directory: ${target}`);
    console.error('           run `npm run build` first (or pass the dist path explicitly).');
    return 2;
  }
  if (!lstatSync(target).isDirectory()) {
    console.error(`check-dist: FAIL — not a directory: ${target}`);
    return 2;
  }
  if (readdirSync(target).length === 0) {
    console.error(`check-dist: FAIL — ${target} is empty; nothing to publish.`);
    return 2;
  }

  const res = checkDist(target, { strict });
  const fileCount = res.entries.filter((e) => e.kind === 'file' && !isPrivateRomPath(e.rel)).length;

  // Always announce private content, pass or fail. Publishing the user's own
  // sideload is intended here, but it must never be a surprise.
  if (res.privatePaths.length && !res.strict) {
    console.log('');
    console.log(`check-dist: PUBLISHING PRIVATE CONTENT — ${fmt(res.privateBytes)} under roms/local/`);
    for (const p of res.privatePaths.slice(0, 6)) console.log(`            + ${p.rel}  (${fmt(p.size)})`);
    if (res.privatePaths.length > 6) console.log(`            ... and ${res.privatePaths.length - 6} more`);
    console.log('            This is deliberate: it is the light-gun headset test path, and');
    console.log('            dionysus.dk is the user\'s own box. Re-run with --strict to refuse it');
    console.log('            (do that for a genuinely public release). See this file\'s header.');
    console.log('');
  }

  if (res.ok) {
    const roms = res.entries.filter((e) => e.kind === 'file' && e.rel.startsWith('roms/freeware/')).length;
    console.log(`check-dist: OK — ${fileCount} files, ${fmt(res.totalBytes)} in ${target}${res.strict ? ' [strict]' : ''}`);
    console.log(
      `            (budgets: ${(res.maxFileBytes / MiB).toFixed(0)} MiB/file, ` +
        `${(res.maxRomBytes / MiB).toFixed(0)} MiB/rom, ${(res.maxTotalBytes / MiB).toFixed(0)} MiB total` +
        `${res.privateBytes ? `; roms/local/ excluded from the totals` : ''})`,
    );
    console.log(`            ${roms} freeware ROM file(s), each matched by name against the ${res.allowNames.size}-title allowlist.`);
    // Print the bundle table on every green run. A budget you only see when it
    // breaks tells you nothing about the trend that is about to break it.
    if (res.chunkSizes.length) {
      const total = res.chunkSizes.reduce((a, c) => a + c.bytes, 0);
      const totalGz = res.chunkSizes.reduce((a, c) => a + c.gzip, 0);
      console.log(`            JS chunks: ${fmt(total)} raw / ${fmt(totalGz)} gzip`);
      for (const c of [...res.chunkSizes].sort((a, b) => b.gzip - a.gzip)) {
        const pct = c.budget.gzip ? Math.round((c.gzip / c.budget.gzip) * 100) : 0;
        console.log(
          `              ${c.chunk.padEnd(22)} ${fmt(c.bytes).padStart(10)} raw  ` +
            `${fmt(c.gzip).padStart(10)} gzip  (${String(pct).padStart(3)}% of its gzip budget)`,
        );
      }
    }
    return 0;
  }

  console.error('');
  console.error(`check-dist: FAIL — ${res.violations.length} violation(s) in ${target}`);
  console.error('            This build MUST NOT be published.');
  console.error('');
  const shown = res.violations.slice(0, 40);
  for (const v of shown) {
    console.error(`  [${v.rule}] ${v.rel}  (${fmt(v.size)})`);
    console.error(`      ${v.why}`);
  }
  if (res.violations.length > shown.length) {
    console.error(`  ... and ${res.violations.length - shown.length} more.`);
  }
  console.error('');
  console.error(`  total scanned: ${fileCount} files, ${fmt(res.totalBytes)}`);
  console.error('  Fix: rebuild with `npm run build` (vite.config.js excludes private paths),');
  console.error('       or remove the offending files from dist/. Never delete anything under public/.');
  if (res.violations.some((v) => v.rule === 'unlisted-rom')) {
    console.error('');
    console.error('  [unlisted-rom] means a ROM under roms/freeware/ is not a title this project');
    console.error('  is known to be allowed to publish. If it IS yours to redistribute, add the');
    console.error('  exact filename to FREEWARE_ALLOW in scripts/check-dist.mjs. If it is a private');
    console.error('  dump, move it to public/roms/local/ instead — that tree is the sideload path,');
    console.error('  ships only to the user\'s own box, and is never git-tracked.');
  }
  if (res.violations.some((v) => v.rule === 'oversize-chunk')) {
    console.error('');
    console.error('  [oversize-chunk] a JS bundle grew past its budget in scripts/check-dist.mjs');
    console.error('  (BUNDLE_BUDGETS). Diagnose BEFORE you raise the number — the usual cause is an');
    console.error('  import that pulled a heavy module into a chunk that had no business with it');
    console.error('  (three in desktop, Collection eagerly imported from main). `npx vite build` then');
    console.error('  reading dist/assets/<chunk>-*.js for the unexpected symbol finds it in a minute.');
    console.error('  If the growth is real and wanted, raise the budget in its own reviewed commit and');
    console.error('  say why. Gzip is the number that matters: it is what a Quest downloads cold.');
  }
  if (res.violations.some((v) => v.rule === 'private-roms')) {
    console.error('');
    console.error('  [private-roms] only fires under --strict. In normal builds roms/local/ is');
    console.error('  published on purpose (headset light-gun testing). If you hit this from a');
    console.error('  plain `npm run build`, something set CHECK_DIST_STRICT — that is the bug.');
  }
  console.error('');
  return 1;
}

// Only run when invoked directly — vite.config.js imports DENY_RULES from here.
const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}

export { main };
export const __selfPath = fileURLToPath(import.meta.url);
