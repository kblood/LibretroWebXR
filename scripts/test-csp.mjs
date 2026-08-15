// Content-Security-Policy contract test (CODEX_REVIEW SEC-6).
// Pure logic — no browser, no server, no port; it imports vite.config.js and
// reads files off disk. That is what qualifies it for the `npm test` chain
// (the pure-logic tier described in CLAUDE.md, which is the CI gate), and
// `node scripts/test-csp.mjs` is the exact command that chain runs.
//   Run standalone: node scripts/test-csp.mjs
//   Exit 0 = all pass, 1 = any failure. It never skips: a missing file, a
//   failed import and a broken page all print FAIL lines and still reach the
//   `N passed, M failed` summary.
//
// WHY THIS EXISTS
// The CSP is written down TWICE — `CSP_DIRECTIVES` in vite.config.js (dev and
// preview headers) and `Header set Content-Security-Policy` in
// public/.htaccess (what dionysus.dk actually serves). Nothing kept those two
// in step, and nothing noticed that the policy they both shipped BLOCKED an
// inline <script> in public/headset-test.html — so the in-headset checklist
// silently did nothing on the one device where you cannot open a console.
// This test locks down all three halves of that bug:
//   1. the two copies of the policy are equivalent (same directives, same
//      sources — order and whitespace are allowed to differ, content is not),
//      and .htaccess names the header exactly ONCE with `Header set` — no
//      later unset/append/edit that would make the compared value fiction;
//   2. the baseline directives the review asked for are actually present, and
//      the ones whose VALUE is load-bearing (default-src, base-uri, object-src,
//      frame-ancestors, form-action) are pinned to that value, not merely
//      present — a directive widened to `*` is a directive that isn't there;
//   3. no shipped HTML page contains an inline <script> body again.
//
// WE CHECK THE HEADER THE SERVER EMITS, NOT A LITERAL THAT LOOKS LIKE IT
// The first version of this file text-scraped the `const CSP_DIRECTIVES = [ … ]`
// array out of vite.config.js and asserted everything against THAT. The round-4
// verifier (2026-08-15) then replaced only `export const CSP =
// CSP_DIRECTIVES.join('; ')` with the pre-SEC-6 two-directive string — reverting
// the whole vite half of the fix — and this suite still printed "50 passed, 0
// failed", because nothing tied the array to the value the middleware hands to
// `res.setHeader`. So now we IMPORT the real vite.config.js, pull the real
// `cross-origin-isolation` plugin out of its real default export, run its dev
// and preview middlewares against a recording `res`, and assert against the
// header string those middlewares actually produced. That value cannot differ
// from what the dev/preview server sends, because it IS what the server sends.
// (The array literal is still checked — against the emitted header — so it can
// never quietly decay into documentation.)
//
// Importing vite.config.js is NOT self-comparison, which is what the earlier
// version of this comment claimed: public/.htaccess is an independent file
// maintained by hand, so diffing the real emitted header against it compares
// two genuinely separate sources. The import does pull in `vite` (for
// `defineConfig`) and scripts/check-dist.mjs, but neither touches the network,
// a port or a browser at import time — this stays in the pure tier.
//
// NEGATIVE CONTROLS
// Every claim above is paired with a synthetic input that exercises the SAME
// function with the bug present and asserts it is caught — see the
// "negative control" block at the bottom. Without those, a differ that always
// returns [] and a scanner that never matches would both pass.
//
// CSP_TEST_ROOT=<dir> points the file-reading half at a copy of the repo
// instead of the repo itself. That is how the out-of-process negative control
// (mutate the copies, expect exit 1) runs without ever leaving the real tree
// broken. NOTE: since this test imports the COPY's vite.config.js, the copy
// needs a `node_modules` (a junction/symlink to the repo's is enough) or the
// import fails — which this test reports as a FAIL, never as a skip.

import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The REAL ship filter. vite.config.js's excludePrivateAssets plugin copies
// public/ into dist/ with exactly this filter, so "what gets scanned" and "what
// gets published" are derived from one source.
import { matchDeny } from './check-dist.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.CSP_TEST_ROOT ? path.resolve(process.env.CSP_TEST_ROOT) : REPO_ROOT;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Drive a vite plugin hook that installs a header middleware and record what
 * that middleware sets. This is the whole point of the file: the value under
 * test is the one `res.setHeader` receives, so a stale literal, a hardcoded
 * string, or a dev/preview mismatch all show up as a different HEADER rather
 * than being invisible behind a matching array literal.
 *
 * @param {object} plugin  a vite plugin object
 * @param {'configureServer'|'configurePreviewServer'} hook
 * @returns {{headers: Map<string,string>, nexted: boolean, installed: boolean}}
 */
export function captureHeaders(plugin, hook) {
  const headers = new Map();
  let mw = null;
  let nexted = false;
  const fakeServer = { middlewares: { use: (fn) => { mw = fn; } } };
  plugin?.[hook]?.(fakeServer);
  if (typeof mw !== 'function') return { headers, nexted, installed: false };
  const req = { url: '/', headers: {} };
  const res = { setHeader: (k, v) => headers.set(String(k).toLowerCase(), String(v)) };
  mw(req, res, () => { nexted = true; });
  return { headers, nexted, installed: true };
}

/** Split a serialised policy string into its directives. */
export function splitPolicy(header) {
  return String(header ?? '').split(';').map((d) => d.trim()).filter(Boolean);
}

/**
 * Pull the policy out of vite.config.js's `const CSP_DIRECTIVES = [ … ];`
 * literal. This is NOT the primary source any more — captureHeaders() is — but
 * the literal is what a human reads and edits, so it is checked AGAINST the
 * emitted header to make sure it never becomes decoration.
 * @returns {string[]} raw directive strings, or [] if the literal is missing
 */
export function parseViteCsp(source) {
  const m = source.match(/const\s+CSP_DIRECTIVES\s*=\s*\[([\s\S]*?)\]\s*;/);
  if (!m) return [];
  // Only the quoted entries — comment lines inside the array are ignored.
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]).filter((s) => s.trim());
}

/**
 * EVERY uncommented mod_headers directive that targets Content-Security-Policy,
 * in file order, with the ACTION VERB it uses. Commented-out (`#`) lines are
 * skipped so the surrounding explanation can quote directive names freely.
 *
 * Why the verb matters, and why this is a list:
 * mod_headers applies its directives in file order and later ones modify what
 * earlier ones built, so ONLY the whole ordered list describes what a browser
 * receives. Two rounds of verification broke a parser that looked at less:
 *   • round 4 (2026-08-15) appended a SECOND `Header set Content-Security-Policy
 *     "script-src 'self' 'unsafe-inline' 'unsafe-eval'"` under the good line and
 *     the suite stayed green, because the parser returned on the FIRST match —
 *     `Header set` replaces, so the last one is the real policy;
 *   • round 5 appended `Header unset Content-Security-Policy`, which strips the
 *     header entirely (dionysus.dk then serves NO CSP at all) and was invisible
 *     to a parser that only matched `set`.
 * So match every action mod_headers defines — set, append, merge, add, unset,
 * echo, edit, `edit` with a trailing star, note — and let the caller insist on
 * exactly one `set` and nothing else.
 * `Header always set` / `Header onsuccess set` are matched too: same override,
 * different condition flag. The header name may be quoted (`Header set
 * "Content-Security-Policy" "…"`), which Apache accepts.
 * @returns {{verb: string, value: string|null}[]} first to last
 */
export function parseHtaccessCspDirectives(source) {
  const out = [];
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(
      /^\s*Header\s+(?:(?:always|onsuccess)\s+)?(set|append|merge|add|unset|echo|edit\*?|note)\s+"?Content-Security-Policy"?(?:\s+"([^"]*)"|\s+(\S+))?/i,
    );
    if (m) out.push({ verb: m[1].toLowerCase(), value: m[2] ?? m[3] ?? null });
  }
  return out;
}

/**
 * The `Header set` values only, first to last — the subset the drift check can
 * reason about. Anything else in the file is caught by the "exactly one `set`
 * and nothing else" assertion, not silently folded in here.
 * @returns {string[]} raw header values, first to last
 */
export function parseHtaccessCspLines(source) {
  return parseHtaccessCspDirectives(source).filter((d) => d.verb === 'set').map((d) => d.value ?? '');
}

/**
 * The policy Apache actually serves: the LAST `Header set` wins.
 * @returns {string[]} raw directive strings, or [] if the header is missing
 */
export function parseHtaccessCsp(source) {
  const lines = parseHtaccessCspLines(source);
  return lines.length ? splitPolicy(lines[lines.length - 1]) : [];
}

/**
 * Normalise a policy to {directive -> sorted source list}. CSP directive names
 * are case-insensitive and source order inside a directive is irrelevant, so
 * both are flattened away; the SET of sources is what must match.
 * @returns {Map<string, string[]>}
 */
export function normalise(directives) {
  const map = new Map();
  for (const d of directives) {
    const parts = d.trim().split(/\s+/);
    const name = parts.shift().toLowerCase();
    map.set(name, [...new Set(parts)].sort());
  }
  return map;
}

/**
 * Human-readable differences between two normalised policies. Empty array ⇒
 * the two are equivalent. Reports missing directives, extra directives AND
 * per-directive source drift, because "both files have img-src" is not the
 * claim — "both files have the SAME img-src" is.
 * @returns {string[]}
 */
export function diffPolicies(a, b, aName = 'A', bName = 'B') {
  const out = [];
  for (const [name, srcs] of a) {
    if (!b.has(name)) { out.push(`${name}: present in ${aName}, absent from ${bName}`); continue; }
    const other = b.get(name);
    if (srcs.join(' ') !== other.join(' ')) {
      out.push(`${name}: ${aName} has [${srcs.join(' ')}], ${bName} has [${other.join(' ')}]`);
    }
  }
  for (const name of b.keys()) {
    if (!a.has(name)) out.push(`${name}: present in ${bName}, absent from ${aName}`);
  }
  return out;
}

/**
 * Find executable inline <script> bodies in an HTML document.
 *
 * A tag counts as inline only if it has no `src=` attribute AND a non-empty
 * body — `<script src="x.js"></script>` is exactly what we want people to
 * write. HTML comments are stripped first: a commented-out script never runs,
 * so flagging one would be a false positive (and this very repo's
 * headset-test.html now explains the fix in a comment that names the tag).
 *
 * THE ATTRIBUTE TEST IS ANCHORED ON PURPOSE. It used to be `/\bsrc\s*=/i`, and
 * `-` is a word boundary in JS regex, so `data-src=` (and `foo-src=`,
 * `xlink:src=`) satisfied `\bsrc=` — an inline body on a tag carrying any such
 * attribute was waved through as "external: allowed", which is exactly the
 * regression this function exists to catch. A real `src` attribute can only
 * start after whitespace, or straight after a quoted attribute value (browsers
 * recover from the missing space), or at the very start of the attribute run.
 * @returns {string[]} one short excerpt per offending tag
 */
export function findInlineScripts(html) {
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
  const hits = [];
  for (const m of stripped.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const [, attrs, body] = m;
    if (/(?:^|[\s"'])src\s*=/i.test(attrs)) continue;  // external: allowed
    if (!body.trim()) continue;                        // empty tag: harmless
    hits.push(body.trim().split('\n')[0].slice(0, 70));
  }
  return hits;
}

// ── The HTML files that are served under this policy ─────────────────────────
// index.html / desktop.html are the two app entry points (vite
// rollupOptions.input). Everything else arrives from public/, and THE SHIPPING
// MECHANISM IS THE FILESYSTEM, NOT GIT: excludePrivateAssets() in vite.config.js
// `cpSync`s the whole publicDir into dist/ with only check-dist.mjs's DENY_RULES
// as a filter, and no deny rule matches `.html`. An earlier version of this scan
// listed `git ls-files -- public`, so the round-4 verifier (2026-08-15) dropped
// an UNTRACKED public/untracked.html carrying an inline <script> into the tree
// and the suite stayed green — while that file would have been copied to dist/
// and uploaded to dionysus.dk. So: walk the tree, apply the same deny filter the
// copy applies, and skip denied directories exactly as the cpSync filter does.
//
// The user's private sideload under public/roms/local/ IS walked, because it
// really is published (see scripts/check-dist.mjs's header). It holds ROM/disc
// images, not HTML; if one ever did contain an .html page, that page would ship
// and this scan is right to look at it.
// The fixtures under test/ are NOT included — puppeteer probes load those from
// their own directories; they are not part of the deploy.
export function shippedHtmlFiles(root) {
  const files = [];
  for (const entry of ['index.html', 'desktop.html']) {
    if (existsSync(path.join(root, entry))) files.push(entry);
  }
  const publicDir = path.join(root, 'public');
  const walk = (dir, rel) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (matchDeny(r)) continue;                 // never copied into dist/
      if (ent.isSymbolicLink()) continue;         // cpSync dereference:false
      if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
      else if (ent.name.toLowerCase().endsWith('.html')) files.push(`public/${r}`);
    }
  };
  if (existsSync(publicDir)) walk(publicDir, '');
  return files;
}

// === 0. The REAL emitted headers ===========================================
// Import the config under test and run its middlewares. A failure to import is
// a FAIL with a loud reason, never a silent skip — a skipped import would put
// this file straight back into the "green while the fix is reverted" state the
// verifier demonstrated.
let viteMod = null;
let importErr = null;
try {
  viteMod = await import(pathToFileURL(path.join(ROOT, 'vite.config.js')).href);
} catch (e) {
  importErr = e;
}
ok('vite.config.js imports (needed to read the header it really emits)', !!viteMod,
  importErr ? `${importErr.message} — a CSP_TEST_ROOT copy needs a node_modules junction` : '');

const plugin = viteMod?.default?.plugins?.find((p) => p?.name === 'cross-origin-isolation');
ok('vite config still registers the cross-origin-isolation plugin', !!plugin);

const dev = captureHeaders(plugin, 'configureServer');
const preview = captureHeaders(plugin, 'configurePreviewServer');
ok('dev middleware is installed and calls next()', dev.installed && dev.nexted);
ok('preview middleware is installed and calls next()', preview.installed && preview.nexted);

const devCsp = dev.headers.get('content-security-policy') ?? '';
const previewCsp = preview.headers.get('content-security-policy') ?? '';
ok('the dev middleware actually sets Content-Security-Policy', devCsp.length > 0);
ok('dev and preview emit the SAME Content-Security-Policy', devCsp === previewCsp,
  `dev=[${devCsp}] preview=[${previewCsp}]`);
// The exported constant is the documented handle other tooling uses; make sure
// it is the same string the middleware emitted rather than a parallel copy.
ok('the exported CSP constant is the header that is emitted', devCsp === (viteMod?.CSP ?? null),
  `emitted=[${devCsp}] exported=[${viteMod?.CSP}]`);

// === 1. The two copies of the policy agree =================================
// LEFT SIDE = the header the vite middleware really emitted (above).
// RIGHT SIDE = the header Apache really serves (last `Header set` wins).
// Read guarded, for the same reason the headset page is (see the block near the
// bottom): a deleted input must arrive as FAIL lines plus a summary, never as an
// uncaught ENOENT that kills the process before the negative controls run. An
// empty source flows through the parsers as "no policy", which every assertion
// below already reports.
const readIfPresent = (abs) => (existsSync(abs) ? readFileSync(abs, 'utf8') : null);
const viteConfigPath = path.join(ROOT, 'vite.config.js');
const htaccessPath = path.join(ROOT, 'public', '.htaccess');
const viteSrcOrNull = readIfPresent(viteConfigPath);
const htaccessSrcOrNull = readIfPresent(htaccessPath);
ok('vite.config.js is readable', viteSrcOrNull !== null, viteConfigPath);
ok('public/.htaccess is readable', htaccessSrcOrNull !== null, htaccessPath);
const viteSrc = viteSrcOrNull ?? '';
const htaccessSrc = htaccessSrcOrNull ?? '';

const htaccessDirectives = parseHtaccessCspDirectives(htaccessSrc);
const htaccessLines = parseHtaccessCspLines(htaccessSrc);
const htaccessList = parseHtaccessCsp(htaccessSrc);

ok('vite emits a non-empty policy', splitPolicy(devCsp).length > 0);
ok('public/.htaccess sets a Content-Security-Policy header', htaccessList.length > 0);
// One `set` and NOTHING ELSE. mod_headers runs in file order and later
// directives rewrite what earlier ones built, so any second CSP directive makes
// every assertion below a description of a policy nobody serves:
//   • a second `Header set` silently becomes the real policy (round-4 hole);
//   • `Header unset` deletes it, so dionysus.dk serves NO CSP (round-5 hole);
//   • append/merge/add/edit/echo all alter the served value too.
// This is the single assertion that keeps the drift check honest about what
// Apache actually emits, so it checks the VERB, not just the count.
ok('public/.htaccess sets Content-Security-Policy exactly ONCE and never modifies it again',
  htaccessDirectives.length === 1 && htaccessDirectives[0].verb === 'set',
  `found ${htaccessDirectives.length}: [${htaccessDirectives.map((d) => `Header ${d.verb}`).join(', ')}]`);
// Kept separate so a same-verb duplicate still names itself in the output.
ok('public/.htaccess has exactly one `Header set Content-Security-Policy`', htaccessLines.length === 1,
  `found ${htaccessLines.length}`);

const servedPolicy = normalise(splitPolicy(devCsp));
const htaccessPolicy = normalise(htaccessList);
const drift = diffPolicies(servedPolicy, htaccessPolicy, 'vite (emitted)', '.htaccess (served)');
ok('vite and public/.htaccess ship the SAME policy', drift.length === 0, drift.join(' | '));

// The hand-edited array literal must still BE the policy. Without this, someone
// could hardcode the header string and leave CSP_DIRECTIVES behind as a
// misleading, permanently-out-of-date comment.
const viteList = parseViteCsp(viteSrc);
ok('vite.config.js declares a CSP_DIRECTIVES list', viteList.length > 0);
const literalDrift = diffPolicies(normalise(viteList), servedPolicy, 'CSP_DIRECTIVES literal', 'emitted header');
ok('the CSP_DIRECTIVES literal is what actually gets emitted', literalDrift.length === 0, literalDrift.join(' | '));

// === 2. The baseline directives the review asked for are present ===========
// SEC-6: "omits default-src, base-uri, object-src, frame-ancestors,
// connect-src, img-src, and media-src". All of these read `servedPolicy`, i.e.
// the emitted header — not the array literal.
// `form-action` is on this list because both shipped comments (vite.config.js's
// "the rest" paragraph and public/.htaccess's per-directive summary) claim it is
// locked to 'none'. It had no assertion at all until round 5, so deleting it
// from BOTH copies left the suite fully green while two comments said otherwise
// — the cross-copy diff only catches a directive dropped from ONE side.
const REQUIRED = [
  'default-src', 'script-src', 'worker-src', 'style-src',
  'img-src', 'media-src', 'connect-src',
  'base-uri', 'object-src', 'frame-ancestors', 'form-action',
];
for (const d of REQUIRED) {
  ok(`policy declares ${d}`, servedPolicy.has(d) && htaccessPolicy.has(d));
}
// Specific values that other things depend on — a "hardening" edit that
// tightened any of these would break a shipped feature, so pin them.
ok("script-src keeps 'wasm-unsafe-eval' (PSX/PS2 runtime Wasm codegen)",
  servedPolicy.get('script-src')?.includes("'wasm-unsafe-eval'"));
// Checked on BOTH sides: the served .htaccess policy is the one an attacker's
// XSS would run under, and it is a separate file from the emitted header.
ok("script-src does NOT grant 'unsafe-eval' or 'unsafe-inline'",
  [servedPolicy, htaccessPolicy].every((p) =>
    !p.get('script-src')?.some((s) => s === "'unsafe-eval'" || s === "'unsafe-inline'")));
ok("style-src keeps 'unsafe-inline' (every page has a <style> block)",
  servedPolicy.get('style-src')?.includes("'unsafe-inline'"));
ok('worker-src allows blob: (Emscripten pthread workers)',
  servedPolicy.get('worker-src')?.includes('blob:'));
ok('connect-src allows ws: and wss: (?server= room socket, any origin)',
  servedPolicy.get('connect-src')?.includes('ws:') && servedPolicy.get('connect-src')?.includes('wss:'));
ok('connect-src allows https: and http: (?log= remote log server, any origin)',
  servedPolicy.get('connect-src')?.includes('https:') && servedPolicy.get('connect-src')?.includes('http:'));
ok('img-src allows blob: (ImageLibrary object URLs feed THREE.TextureLoader)',
  servedPolicy.get('img-src')?.includes('blob:'));
ok("object-src is 'none'", servedPolicy.get('object-src')?.join(' ') === "'none'");
ok("frame-ancestors is 'none'", servedPolicy.get('frame-ancestors')?.join(' ') === "'none'");
ok("form-action is 'none'", servedPolicy.get('form-action')?.join(' ') === "'none'",
  `got [${servedPolicy.get('form-action')?.join(' ')}]`);
// PRESENCE IS NOT THE CLAIM FOR THESE TWO. `default-src` is the fallback SEC-6
// was raised about ("everything else fell through to no policy at all") and
// `base-uri` is what stops an injected <base> from re-pointing every relative
// script URL; a presence-only check passes with either widened to `*`, which is
// indistinguishable from having no policy. Sources are sorted by normalise(),
// so these are set comparisons, not string-order ones.
ok("default-src is exactly 'self' blob: data:", servedPolicy.get('default-src')?.join(' ') === "'self' blob: data:",
  `got [${servedPolicy.get('default-src')?.join(' ')}]`);
ok("base-uri is 'none'", servedPolicy.get('base-uri')?.join(' ') === "'none'",
  `got [${servedPolicy.get('base-uri')?.join(' ')}]`);
// Backstop for every OTHER directive: a bare `*` (or `*:` / `https://*`) in any
// of them re-opens the same hole one directive over. Checked on both copies.
for (const [label, policy] of [['vite (emitted)', servedPolicy], ['.htaccess (served)', htaccessPolicy]]) {
  const wild = [...policy].filter(([, srcs]) => srcs.some((s) => s === '*' || s === "'*'" || s.includes('://*')));
  ok(`no directive in ${label} is widened to a wildcard host`, wild.length === 0,
    wild.map(([n, s]) => `${n} [${s.join(' ')}]`).join(', '));
}

// COOP/COEP are a SEPARATE contract that crossOriginIsolated depends on; a
// CSP edit must not quietly take them with it. Vite's side is read from the
// emitted headers for the same reason the CSP is.
ok('vite still sends COOP + COEP (dev and preview)',
  dev.headers.get('cross-origin-opener-policy') === 'same-origin'
  && dev.headers.get('cross-origin-embedder-policy') === 'require-corp'
  && preview.headers.get('cross-origin-opener-policy') === 'same-origin'
  && preview.headers.get('cross-origin-embedder-policy') === 'require-corp');
ok('.htaccess still sets COOP + COEP',
  /Header set Cross-Origin-Opener-Policy\s+"same-origin"/.test(htaccessSrc)
  && /Header set Cross-Origin-Embedder-Policy\s+"require-corp"/.test(htaccessSrc));

// === 3. No shipped HTML page contains an inline <script> body ==============
// This is the regression that produced SEC-6 in the first place.
const htmlFiles = shippedHtmlFiles(ROOT);
ok('found the shipped HTML pages to scan', htmlFiles.length >= 3, `saw ${htmlFiles.length}: ${htmlFiles.join(', ')}`);
for (const rel of htmlFiles) {
  const abs = path.join(ROOT, rel);
  const hits = findInlineScripts(readFileSync(abs, 'utf8'));
  ok(`${rel} has no inline <script> body (our own script-src would block it)`,
    hits.length === 0, hits.join(' | '));
}
// ONE guarded read of the page, reused everywhere below (including the negative
// control at the bottom). Round 5 deleted public/headset-test.html and the suite
// CRASHED with an uncaught ENOENT instead of printing FAIL lines: the assertion
// right below was carefully guarded with `!existsSync(…) ||`, but two other
// readFileSync calls of the same path were not, so the process died before the
// entire "NEGATIVE CONTROLS" block ran and no `N passed, M failed` summary was
// printed at all. A missing page is a real failure — it must READ as one.
const headsetHtmlPath = path.join(ROOT, 'public', 'headset-test.html');
const headsetHtml = existsSync(headsetHtmlPath) ? readFileSync(headsetHtmlPath, 'utf8') : null;
ok('public/headset-test.html exists', headsetHtml !== null, headsetHtmlPath);
// The extraction actually landed somewhere loadable. No `!existsSync(…) ||`
// escape hatch: that made this pass vacuously on the very input it should fail.
ok('headset-test.html loads its checklist from an external module',
  headsetHtml !== null && /<script[^>]+src=["']\.\/headset-test\.js["']/.test(headsetHtml));
const headsetJsPath = path.join(ROOT, 'public', 'headset-test.js');
ok('public/headset-test.js exists', existsSync(headsetJsPath));
// DOM contract: the extracted module still addresses the ids/selectors the page
// provides. A mechanical extraction that renamed or dropped one of these would
// leave the checklist dead in exactly the same invisible way the CSP did.
// Reported as FAILs rather than skipped when either half is missing — a skip
// here is how the whole block went quiet in round 5.
{
  const js = existsSync(headsetJsPath) ? readFileSync(headsetJsPath, 'utf8') : null;
  const html = headsetHtml;
  const both = js !== null && html !== null;
  ok('extracted module and page agree on #progress', both && js.includes("getElementById('progress')") && /id="progress"/.test(html));
  ok('extracted module and page agree on #reset', both && js.includes("getElementById('reset')") && /id="reset"/.test(html));
  ok('extracted module and page agree on ol.checks > li',
    both && js.includes("querySelectorAll('ol.checks > li')") && /<ol class="checks">/.test(html));
  ok('extracted module still keys storage on lwx-test-*', both && js.includes("'lwx-test-'"));
}

// === NEGATIVE CONTROLS =====================================================
// Same functions, synthetic inputs, bug present. If these pass trivially the
// assertions above are worthless — this repo has a documented history of
// false-green tests.
{
  // (a) captureHeaders must READ the middleware, not report a fixed answer.
  const fakePlugin = (value) => ({
    configureServer(server) {
      server.middlewares.use((_q, res, next) => { if (value !== null) res.setHeader('Content-Security-Policy', value); next(); });
    },
    configurePreviewServer() { /* deliberately installs nothing */ },
  });
  const weak = captureHeaders(fakePlugin("script-src 'self' 'unsafe-eval'"), 'configureServer');
  ok('[neg] captureHeaders returns the value the middleware set',
    weak.headers.get('content-security-policy') === "script-src 'self' 'unsafe-eval'");
  ok('[neg] a weaker emitted policy diffs against .htaccess',
    diffPolicies(normalise(splitPolicy(weak.headers.get('content-security-policy'))), htaccessPolicy).length > 0);
  ok('[neg] a middleware that sets no CSP is visible as an empty header',
    captureHeaders(fakePlugin(null), 'configureServer').headers.has('content-security-policy') === false);
  ok('[neg] a hook that installs no middleware is reported, not silently passed',
    captureHeaders(fakePlugin('x'), 'configurePreviewServer').installed === false);
  ok('[neg] a missing plugin does not throw and reports installed:false',
    captureHeaders(undefined, 'configureServer').installed === false);

  // (b) the differ must SEE drift, not just return [].
  const base = normalise(["default-src 'self'", "img-src 'self' blob: data:"]);
  ok('[neg] identical policies diff to []', diffPolicies(base, normalise(["img-src 'self' data: blob:", "default-src 'self'"])).length === 0);

  const droppedSource = diffPolicies(base, normalise(["default-src 'self'", "img-src 'self' blob:"]));
  ok('[neg] dropping ONE source from one copy is reported', droppedSource.length === 1 && droppedSource[0].startsWith('img-src:'));

  const addedSource = diffPolicies(base, normalise(["default-src 'self'", "img-src 'self' blob: data: https:"]));
  ok('[neg] adding a source to one copy is reported', addedSource.length === 1);

  const missingDirective = diffPolicies(base, normalise(["default-src 'self'"]));
  ok('[neg] a directive missing from one copy is reported',
    missingDirective.length === 1 && missingDirective[0].includes('absent from B'));

  const extraDirective = diffPolicies(base, normalise(["default-src 'self'", "img-src 'self' blob: data:", "object-src 'none'"]));
  ok('[neg] a directive only ONE copy has is reported',
    extraDirective.length === 1 && extraDirective[0].includes('absent from A'));

  // Case/whitespace must NOT count as drift (or the test becomes a nuisance
  // that people disable), but content must.
  ok('[neg] case + whitespace differences are not drift',
    diffPolicies(normalise(["Default-Src   'self'  blob:"]), normalise(["default-src 'self' blob:"])).length === 0);

  // (c) the inline-script scanner must SEE an inline script.
  const inlineTag = '<scr' + 'ipt>' + 'alert(1)' + '</scr' + 'ipt>'; // assembled so this file never contains the literal
  const externalTag = '<scr' + 'ipt type="module" src="./x.js"></scr' + 'ipt>';
  ok('[neg] an inline script body is detected', findInlineScripts(`<body>${inlineTag}</body>`).length === 1);
  ok('[neg] an external script is NOT flagged', findInlineScripts(`<body>${externalTag}</body>`).length === 0);
  ok('[neg] a commented-out script is NOT flagged', findInlineScripts(`<body><!-- ${inlineTag} --></body>`).length === 0);
  ok('[neg] an empty script tag is NOT flagged', findInlineScripts('<body><scr' + 'ipt></scr' + 'ipt></body>').length === 0);
  // Uses the hoisted, guarded read — a deleted page is a FAIL line here, not an
  // uncaught ENOENT that skips every control in this block.
  ok('[neg] re-adding an inline script to the REAL page would fail',
    headsetHtml !== null
    && findInlineScripts(headsetHtml.replace('</body>', `${inlineTag}</body>`)).length === 1);
  // `-` and `:` are word boundaries, so `\bsrc=` used to accept these as
  // "external" and wave the body straight through.
  const decoyAttr = (attr) => `<scr` + `ipt ${attr}="decoy">` + 'alert(1)' + '</scr' + 'ipt>';
  ok('[neg] a data-src decoy does NOT hide an inline body', findInlineScripts(decoyAttr('data-src')).length === 1);
  ok('[neg] an xlink:src decoy does NOT hide an inline body', findInlineScripts(decoyAttr('xlink:src')).length === 1);
  ok('[neg] a foo-src decoy does NOT hide an inline body', findInlineScripts(decoyAttr('foo-src')).length === 1);
  // …while every shape of a REAL src attribute still counts as external.
  ok('[neg] src at the very start of the attribute run is external',
    findInlineScripts('<scr' + 'ipt src="./x.js">junk</scr' + 'ipt>').length === 0);
  ok('[neg] src on its own line is external',
    findInlineScripts('<scr' + 'ipt type="module"\n  src="./x.js">junk</scr' + 'ipt>').length === 0);
  ok('[neg] src straight after a quoted value (no space) is external',
    findInlineScripts('<scr' + 'ipt type="module"src="./x.js">junk</scr' + 'ipt>').length === 0);

  // (d) the HTML enumerator must find an UNTRACKED page (the vac3 hole) and
  //     must skip what the dist filter would drop. Built in a throwaway temp
  //     dir with no git in it at all, so "tracked" cannot be what makes it pass.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lwx-csp-'));
  try {
    mkdirSync(path.join(tmp, 'public', 'sub'), { recursive: true });
    mkdirSync(path.join(tmp, 'public', 'tmp'), { recursive: true });
    writeFileSync(path.join(tmp, 'index.html'), '<html></html>');
    writeFileSync(path.join(tmp, 'public', 'untracked.html'), `<body>${inlineTag}</body>`);
    writeFileSync(path.join(tmp, 'public', 'sub', 'nested.html'), '<html></html>');
    writeFileSync(path.join(tmp, 'public', 'page.html.bak'), '<html></html>');  // backup-file deny rule
    writeFileSync(path.join(tmp, 'public', 'tmp', 'scratch.html'), '<html></html>'); // scratch deny rule
    const found = shippedHtmlFiles(tmp);
    ok('[neg] an untracked public/*.html is enumerated (it would ship)', found.includes('public/untracked.html'),
      found.join(', '));
    ok('[neg] nested public HTML is enumerated', found.includes('public/sub/nested.html'), found.join(', '));
    ok('[neg] deny-filtered HTML is NOT enumerated (it never reaches dist/)',
      !found.some((f) => f.endsWith('.bak') || f.startsWith('public/tmp/')), found.join(', '));
    ok('[neg] the inline script in that untracked page is caught',
      findInlineScripts(readFileSync(path.join(tmp, 'public', 'untracked.html'), 'utf8')).length === 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // (e) the parsers must actually parse — an always-[] parser would make the
  //     equivalence check vacuous, which the length>0 assertions above catch,
  //     but prove they read the real shape too.
  ok('[neg] vite parser returns [] when the literal is renamed',
    parseViteCsp(viteSrc.replace('CSP_DIRECTIVES', 'CSP_SOMETHING_ELSE')).length === 0);
  ok('[neg] htaccess parser ignores commented-out header lines',
    parseHtaccessCsp('# Header set Content-Security-Policy "script-src \'none\'"').length === 0);
  ok('[neg] htaccess parser reads a real header line',
    parseHtaccessCsp('  Header set Content-Security-Policy "a b; c d"').length === 2);
  // Apache semantics: the LAST `Header set` is what the browser gets.
  const twoLines = 'Header set Content-Security-Policy "good \'self\'"\nHeader set Content-Security-Policy "bad \'unsafe-eval\'"';
  ok('[neg] two header lines are BOTH collected', parseHtaccessCspLines(twoLines).length === 2);
  ok('[neg] the LAST header line is the one parsed', parseHtaccessCsp(twoLines).join('|') === "bad 'unsafe-eval'");
  ok('[neg] `Header always set` counts as an override too',
    parseHtaccessCspLines('Header always set Content-Security-Policy "x \'self\'"').length === 1);

  // (f) the VERB matters, not just the count. Appended under the good line,
  //     unset/append/merge/add/edit all change what dionysus.dk sends —
  //     `unset` worst of all, it removes the header outright, which is what
  //     round 5 slipped past a parser that only matched `set`. echo/note do not
  //     rewrite this header, but a CSP directive we did not put there is not
  //     something a drift check should shrug at either. So the shipped gate is
  //     "exactly one directive, and its verb is `set`", and every one of these
  //     has to be visible to parseHtaccessCspDirectives() for that to hold.
  const goodLine = 'Header set Content-Security-Policy "default-src \'self\'"';
  for (const verb of ['unset', 'append', 'merge', 'add', 'edit', 'edit*', 'echo', 'note']) {
    const arg = verb === 'unset' ? '' : ' "x"';
    const ds = parseHtaccessCspDirectives(`${goodLine}\nHeader ${verb} Content-Security-Policy${arg}`);
    ok(`[neg] a later \`Header ${verb} Content-Security-Policy\` is seen`,
      ds.length === 2 && ds[0].verb === 'set' && ds[1].verb === verb.toLowerCase(),
      JSON.stringify(ds));
    // …and the shipped gate (one directive, verb `set`) rejects it.
    ok(`[neg] the ONE-\`set\` gate rejects a trailing \`${verb}\``,
      !(ds.length === 1 && ds[0].verb === 'set'));
  }
  ok('[neg] `Header unset` alone leaves parseHtaccessCsp with a policy it cannot vouch for',
    parseHtaccessCspDirectives('Header unset Content-Security-Policy').length === 1
    && parseHtaccessCsp('Header unset Content-Security-Policy').length === 0);
  ok('[neg] a commented-out `Header unset` is ignored',
    parseHtaccessCspDirectives('  # Header unset Content-Security-Policy').length === 0);
  ok('[neg] a quoted header name is still matched',
    parseHtaccessCspDirectives('Header unset "Content-Security-Policy"')[0]?.verb === 'unset');
  ok('[neg] `Header onsuccess set` counts too',
    parseHtaccessCspDirectives('Header onsuccess set Content-Security-Policy "x \'self\'"')[0]?.verb === 'set');
  ok('[neg] directives for OTHER headers are not collected',
    parseHtaccessCspDirectives('Header unset X-Frame-Options\nHeader set Cache-Control "no-cache"').length === 0);
  ok('[neg] the good line alone passes the ONE-`set` gate',
    parseHtaccessCspDirectives(goodLine).length === 1 && parseHtaccessCspDirectives(goodLine)[0].verb === 'set');

  // (g) the value pins must be pins, not presence checks. `*` is what a
  //     "just make it work" edit reaches for, and it is what SEC-6 was about.
  const widened = normalise(splitPolicy("default-src *; base-uri *; object-src 'none'"));
  ok('[neg] a widened default-src is NOT equal to the pinned value',
    widened.get('default-src')?.join(' ') !== "'self' blob: data:");
  ok('[neg] a widened base-uri is NOT equal to the pinned value',
    widened.get('base-uri')?.join(' ') !== "'none'");
  ok('[neg] the wildcard backstop sees `*` in a directive',
    [...widened].filter(([, s]) => s.some((x) => x === '*' || x === "'*'" || x.includes('://*'))).length === 2);
  ok('[neg] the wildcard backstop sees a wildcard HOST source',
    [...normalise(splitPolicy('img-src https://*.example.com'))]
      .filter(([, s]) => s.some((x) => x === '*' || x === "'*'" || x.includes('://*'))).length === 1);
  ok('[neg] the wildcard backstop does NOT fire on the real policy sources',
    [...servedPolicy].filter(([, s]) => s.some((x) => x === '*' || x === "'*'" || x.includes('://*'))).length === 0);
  ok('[neg] form-action is one of the directives REQUIRED', REQUIRED.includes('form-action'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
