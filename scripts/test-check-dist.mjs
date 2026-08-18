// Unit tests for scripts/check-dist.mjs — the guard that decides what may be
// published. Run standalone:  node scripts/test-check-dist.mjs
// Discovered automatically by scripts/run-tests.mjs, so this is in `npm test`.
//
// WHY THIS EXISTS
// ---------------
// check-dist is the pre-upload gate: `npm run build` (postbuild), the vite plugin
// (which THROWS, so a --outDir build is gated too) and `scripts/deploy.ps1` all
// run it, and a deploy aborts before its first scp if it exits nonzero. It was
// the one piece of publishing policy in this repo with no test of its own — 49
// discovered suites and not one of them ran it — so every rule it enforces was
// gated only by the fact that nobody had broken it yet.
//
// Pure logic: builds throwaway directory fixtures under the OS temp dir and calls
// checkDist() on them. No port, no browser, no network, no `dist/` needed.
//
// THE POLICY TEST AT THE BOTTOM IS THE IMPORTANT ONE. `public/roms/local/` — the
// user's private sideload — is PUBLISHED BY DEFAULT and only refused under
// `--strict`. That is deliberate (it is the only practical way to test light guns
// on a headset; see CLAUDE.md and check-dist.mjs's own header) and it has been
// "fixed" into a hard refusal and reverted TWICE. Until now the policy lived only
// in comments, which is exactly the kind of thing a well-meaning review deletes.
// It is now an executable assertion in the CI gate.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  BUNDLE_BUDGETS,
  DEFAULT_BUNDLE_BUDGET,
  FREEWARE_ALLOW,
  bundleBudgetFor,
  checkDist,
  chunkNameOf,
  freewareVerdict,
  isPrivateRomPath,
  romsPathAllowed,
} from './check-dist.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL  ${name}${detail ? `\n  ${detail}` : ''}`); }
};

// --- fixture helpers --------------------------------------------------------
const roots = [];
/**
 * Build a throwaway dist/ from `{ 'rel/path': <Buffer|string|number> }`.
 * A number means "a file of N bytes of compressible filler".
 */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'lwx-check-dist-'));
  roots.push(root);
  for (const [rel, spec] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof spec === 'number' ? Buffer.alloc(spec, 0x61) : spec);
  }
  return root;
}
/**
 * Incompressible bytes: raw size stays under budget while gzip refuses to shrink.
 * xorshift32 via Math.imul, NOT `s * 1103515245` — the plain multiply overflows
 * 2^53, the sequence degenerates, and the "random" buffer gzips 4.5:1, which
 * silently turned this fixture into a compressible one and the gzip test green
 * for the wrong reason. Deterministic on purpose: a size assertion must not be
 * flaky.
 */
function noise(n) {
  const b = Buffer.alloc(n);
  let s = 0x2f6e2b1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    b[i] = s & 0xff;
  }
  return b;
}
const rules = (res) => res.violations.map((v) => v.rule).sort();
const has = (res, rule) => res.violations.some((v) => v.rule === rule);

// A repoRoot with no public/roms/ so trackedRomRefs() contributes nothing and the
// freeware gate is exactly FREEWARE_ALLOW. Otherwise these tests would quietly
// depend on whatever descriptors the working tree happens to hold.
const BARE_REPO = mkdtempSync(join(tmpdir(), 'lwx-check-dist-repo-'));
roots.push(BARE_REPO);
const base = { repoRoot: BARE_REPO };

// ---------------------------------------------------------------------------
console.log('--- chunk naming ---');
// ---------------------------------------------------------------------------
ok('hashed chunk yields its rollup name', chunkNameOf('assets/three-CQREgBuk.js') === 'three');
ok('a name containing no dash still resolves', chunkNameOf('assets/main-DORpfqBE.js') === 'main');
ok('a multi-word chunk keeps its whole name',
   chunkNameOf('assets/EmulatorWorkerRuntime-DdW6BZJd.js') === 'EmulatorWorkerRuntime');
ok('css chunks are budgeted too', chunkNameOf('assets/style-abcdef12.css') === 'style');
ok('a hashed image in assets/ is NOT a chunk', chunkNameOf('assets/logo-abcdef12.png') === null);
ok('files outside assets/ are NOT chunks', chunkNameOf('cores/three-CQREgBuk.js') === null);
ok('an unnamed chunk falls back to the default budget',
   bundleBudgetFor('SomeNewLazyChunk') === DEFAULT_BUNDLE_BUDGET);
ok('a named chunk gets its own budget', bundleBudgetFor('three') === BUNDLE_BUDGETS.three);

// ---------------------------------------------------------------------------
console.log('--- per-chunk JS budgets (PERF-5) ---');
// ---------------------------------------------------------------------------
{
  // Within budget: 20 KiB of filler is under desktop's 60 KB raw / 20 KB gzip.
  const res = checkDist(fixture({ 'index.html': '<html>', 'assets/desktop-AAAAAAAA.js': 20_000 }), base);
  ok('a chunk inside its budget is clean', res.ok, JSON.stringify(rules(res)));
  ok('and its measured sizes are reported', res.chunkSizes.length === 1
     && res.chunkSizes[0].chunk === 'desktop' && res.chunkSizes[0].gzip > 0,
     JSON.stringify(res.chunkSizes));
}
{
  // THE desktop regression this budget exists for: three (~600 KB) lands in the
  // flat-screen chunk that is supposed to never import a renderer.
  const res = checkDist(fixture({ 'index.html': '<html>', 'assets/desktop-AAAAAAAA.js': 620_000 }), base);
  ok('a chunk over its RAW budget is refused', has(res, 'oversize-chunk'), JSON.stringify(rules(res)));
  ok('the message names the chunk and the budget',
     res.violations.some((v) => v.why.includes("'desktop'") && v.why.includes('raw budget')),
     JSON.stringify(res.violations.map((v) => v.why)));
}
{
  // Raw under budget, gzip over: 50 KB of incompressible bytes sails past
  // desktop's 60 KB raw ceiling and blows its 20 KB gzip ceiling. This is the
  // case a raw-bytes-only budget cannot see, and gzip is what the headset
  // actually downloads.
  const res = checkDist(fixture({ 'index.html': '<html>', 'assets/desktop-AAAAAAAA.js': noise(50_000) }), base);
  ok('a chunk under its raw budget but over GZIP is refused', has(res, 'oversize-chunk'),
     JSON.stringify(rules(res)));
  ok('the gzip message says so', res.violations.some((v) => v.why.includes('gzip budget')),
     JSON.stringify(res.violations.map((v) => v.why)));
}
{
  // A brand-new chunk nobody added a budget for still has a ceiling.
  const res = checkDist(fixture({ 'index.html': '<html>', 'assets/BrandNew-AAAAAAAA.js': 250_000 }), base);
  ok('an unbudgeted new chunk is held to DEFAULT_BUNDLE_BUDGET', has(res, 'oversize-chunk'),
     JSON.stringify(rules(res)));
  ok('and the message says the default applied',
     res.violations.some((v) => v.why.includes('DEFAULT_BUNDLE_BUDGET')),
     JSON.stringify(res.violations.map((v) => v.why)));
}
{
  // Escape hatch, so an audit of a foreign dist/ can skip the bundle policy.
  const res = checkDist(fixture({ 'index.html': '<html>', 'assets/desktop-AAAAAAAA.js': 620_000 }),
    { ...base, chunkBudgets: false });
  ok('chunkBudgets:false disables only the chunk rule', res.ok, JSON.stringify(rules(res)));
}

// ---------------------------------------------------------------------------
console.log('--- asset budgets ---');
// ---------------------------------------------------------------------------
{
  const dir = fixture({ 'index.html': '<html>', 'assets/main-AAAAAAAA.js': 4096 });
  const over = checkDist(dir, { ...base, maxFileMB: 0.001 }); // 1 KiB per file
  ok('oversize-file fires on the per-file budget', has(over, 'oversize-file'), JSON.stringify(rules(over)));
  const total = checkDist(dir, { ...base, maxTotalMB: 0.001 }); // 1 KiB whole tree
  ok('oversize-total fires on the whole-tree budget', has(total, 'oversize-total'), JSON.stringify(rules(total)));
  ok('oversize-total names the tree, not a file',
     total.violations.some((v) => v.rule === 'oversize-total' && v.rel === '(whole tree)'));
}

// ---------------------------------------------------------------------------
console.log('--- deny rules and the top-level allowlist ---');
// ---------------------------------------------------------------------------
{
  const res = checkDist(fixture({
    'index.html': '<html>',
    'cores/nestopia_libretro.wasm.bak': 16,   // the 8 pre-patch cores that shipped once
  }), base);
  ok('a *.bak core is refused', has(res, 'backup-file'), JSON.stringify(rules(res)));
}
{
  const res = checkDist(fixture({ 'index.html': '<html>', '.env': 'SECRET=1' }), base);
  ok('a stray .env is refused', has(res, 'credential'), JSON.stringify(rules(res)));
}
{
  const res = checkDist(fixture({ 'index.html': '<html>', 'src/main.js': 'x' }), base);
  ok('an unlisted top-level dir is refused', has(res, 'not-allowlisted'), JSON.stringify(rules(res)));
}
{
  const res = checkDist(fixture({ 'index.html': '<html>', 'assets/notes.docx': 16 }), base);
  ok('an unpublishable file type is refused', has(res, 'unexpected-type'), JSON.stringify(rules(res)));
}

// ---------------------------------------------------------------------------
console.log('--- roms/freeware/ is gated by IDENTITY, not by folder ---');
// ---------------------------------------------------------------------------
ok('an allowlisted title passes', freewareVerdict('roms/freeware/lwx-nes-pong.nes', FREEWARE_ALLOW) === null);
ok('a commercial dump in the same folder does NOT',
   typeof freewareVerdict('roms/freeware/lethal-enforcers.smc', FREEWARE_ALLOW) === 'string');
ok('a cue/bin sidecar of an allowlisted title rides along',
   freewareVerdict('roms/freeware/lwx-psx-testdisc.cue', FREEWARE_ALLOW) === null);
ok('roms/ pointers ship', romsPathAllowed('roms/manifest.json') && romsPathAllowed('roms/x.collection.json'));
ok('a future roms/<something-else>/ does not', romsPathAllowed('roms/mydiscs/thing.iso') === false);
{
  const res = checkDist(fixture({
    'index.html': '<html>',
    'roms/freeware/lwx-nes-pong.nes': 4096,
    'roms/freeware/lethal-enforcers.smc': 4096,
  }), base);
  ok('the planted commercial ROM is the only violation',
     rules(res).join(',') === 'unlisted-rom', JSON.stringify(res.violations));
  ok('the allowlisted ROM beside it still ships',
     !res.violations.some((v) => v.rel.includes('lwx-nes-pong')));
}
{
  const res = checkDist(fixture({ 'index.html': '<html>', 'roms/freeware/lwx-nes-pong.nes': 4096 }),
    { ...base, maxRomMB: 0.001 });
  ok('oversize-rom fires on the tighter per-ROM budget', has(res, 'oversize-rom'), JSON.stringify(rules(res)));
}

// ---------------------------------------------------------------------------
console.log('--- roms/local/ SHIPS BY DEFAULT and is refused only under --strict ---');
// ---------------------------------------------------------------------------
// Read CLAUDE.md and check-dist.mjs's header before touching this block. Making
// roms/local/ a hard refusal has been proposed by both whole-repo reviews as
// their #1 critical finding, shipped twice, and reverted twice: dionysus.dk is
// the user's own box, and the sideload is the only practical way to test light
// guns on a headset. Stripping it also strips roms/local/amiga/kick*.A500, which
// src/systems.js points PUAE's systemFiles at, so deployed Amiga stops booting.
// If this block ever goes red, the guard changed — not the test.
ok('a roms/local/ path is recognised as the private tree', isPrivateRomPath('roms/local/snes/x.sfc'));
ok('roms/localish/ is NOT the private tree (prefix, not substring)',
   isPrivateRomPath('roms/localish/x.sfc') === false);
{
  const files = {
    'index.html': '<html>',
    'roms/freeware/lwx-nes-pong.nes': 4096,
    'roms/local/snes/lethal-enforcers.smc': 8192,
    'roms/local/amiga/kick13.A500': 4096,   // PUAE's systemFiles live here
  };
  const normal = checkDist(fixture(files), base);
  ok('DEFAULT: the private sideload publishes cleanly', normal.ok, JSON.stringify(normal.violations));
  ok('DEFAULT: it is still REPORTED, loudly, with its size',
     normal.privatePaths.length > 0 && normal.privateBytes > 0,
     JSON.stringify({ paths: normal.privatePaths, bytes: normal.privateBytes }));
  ok('DEFAULT: it is excluded from the size budgets it would otherwise blow',
     normal.totalBytes < normal.privateBytes + normal.totalBytes && normal.totalBytes < 8192,
     `totalBytes=${normal.totalBytes} privateBytes=${normal.privateBytes}`);
  ok('DEFAULT: a commercial ROM under roms/local/ is NOT an unlisted-rom violation',
     !has(normal, 'unlisted-rom'), JSON.stringify(rules(normal)));

  const strict = checkDist(fixture(files), { ...base, strict: true });
  ok('--strict: the private sideload IS refused', has(strict, 'private-roms'), JSON.stringify(rules(strict)));
  ok('--strict: and only for that reason', rules(strict).every((r) => r === 'private-roms'),
     JSON.stringify(rules(strict)));
}

// ---------------------------------------------------------------------------
for (const r of roots) rmSync(r, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
