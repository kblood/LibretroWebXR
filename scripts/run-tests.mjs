// The test runner for both tiers described in CLAUDE.md.
//
//   node scripts/run-tests.mjs           → the PURE-LOGIC tier (this is `npm test`,
//                                          and the CI gate): every scripts/test-*.mjs
//                                          that is not a server suite, then the
//                                          node:test files under test/.
//   node scripts/run-tests.mjs --servers → the SERVER tier (`npm run test:servers`):
//                                          the suites that spawn the room/log servers
//                                          and drive them over real sockets.
//   node scripts/run-tests.mjs a b       → only the suites whose filename contains
//                                          'a' or 'b' (substring match, any tier).
//
// WHY THIS EXISTS, in two parts:
//
//  1. `npm test` was a ~40-command `&&` chain in package.json. `&&` stops at the
//     first non-zero exit, so one broken suite hid every later one and a full
//     picture took as many runs as there were failures. This runs ALL of them and
//     reports every failure at the end.
//
//  2. Membership was hand-maintained, and it silently rotted: test-csp,
//     test-remote-owner, test-session-id and test-voice-recovery were all written,
//     all green, and NONE of them were in the chain — one of them shipped a comment
//     claiming, present tense, that `npm test` ran it. Suites are now DISCOVERED
//     from the filesystem, so writing scripts/test-<x>.mjs is all it takes to be in
//     CI. That is the point: a test nobody runs is worse than no test, because it
//     reads as coverage.
//
// The one thing discovery cannot know is which tier a new file belongs to, so the
// server tier is an explicit list (SERVER_SUITES) and everything else is logic. To
// stop a browser/socket suite from silently joining the CI gate that way, a
// logic-tier file that imports ws / puppeteer / node:http / node:net /
// node:child_process is reported as MISCLASSIFIED and fails the run, with the fix
// spelled out. That check is static (it reads the source, it does not run it), so
// it costs nothing and cannot itself hang.

import { readdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPTS, '..');

// Suites that need real ports/sockets. Kept OUT of `npm test` on purpose (CLAUDE.md):
// CI must not depend on ports being free. Order matters only for readability.
const SERVER_SUITES = [
  'test-net-signal.mjs',
  'test-log-server.mjs',
  'test-room-limits.mjs',
  'test-room-protocol.mjs',
];

// node:test files, run as one suite at the end of the logic tier (the `test:node`
// script). They are not scripts/test-*.mjs, so discovery cannot see them.
const NODE_TEST_FILES = [
  'test/psx-foundations.test.js',
  'test/runtime.test.js',
  'test/disc-identity.test.js',
];

// Modules that mean "this suite is not pure logic". Matched against import/require
// specifiers only, so a mention in a COMMENT does not trip it (test-csp.mjs has
// exactly that, and it is a legitimate logic-tier suite).
const IMPURE = ['ws', 'puppeteer', 'puppeteer-core', 'node:http', 'node:https', 'node:net', 'node:child_process'];

const SUITE_TIMEOUT_MS = 180000;   // a hung suite must not wedge CI for ever

const args = process.argv.slice(2);
const serverTier = args.includes('--servers');
const filters = args.filter((a) => !a.startsWith('-'));

const discovered = readdirSync(SCRIPTS)
  .filter((f) => f.startsWith('test-') && f.endsWith('.mjs'))
  .sort();

const logicSuites = discovered.filter((f) => !SERVER_SUITES.includes(f));
const missingServer = SERVER_SUITES.filter((f) => !discovered.includes(f));

// --- Tier hygiene: a logic-tier suite that pulls in a server/browser module ---
const specifiers = (src) => {
  const out = [];
  const re = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
};
const misclassified = [];
if (!serverTier) {
  for (const f of logicSuites) {
    const bad = specifiers(readFileSync(resolve(SCRIPTS, f), 'utf8')).filter((s) => IMPURE.includes(s));
    if (bad.length) misclassified.push({ file: f, bad });
  }
}

const run = (cmd, cmdArgs, label) => new Promise((res) => {
  const t0 = Date.now();
  console.log(`\n=== ${label} ===`);
  const child = spawn(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit' });
  const timer = setTimeout(() => {
    console.error(`  !! ${label} exceeded ${SUITE_TIMEOUT_MS / 1000}s — killed`);
    child.kill('SIGKILL');
  }, SUITE_TIMEOUT_MS);
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    res({ label, ok: code === 0 && !signal, code: signal ? `signal ${signal}` : code, ms: Date.now() - t0 });
  });
  child.on('error', (e) => {
    clearTimeout(timer);
    res({ label, ok: false, code: e.message, ms: Date.now() - t0 });
  });
});

const wanted = (name) => !filters.length || filters.some((f) => name.includes(f));

const tier = serverTier ? SERVER_SUITES : logicSuites;
const results = [];
for (const f of tier.filter(wanted)) {
  results.push(await run(process.execPath, [resolve(SCRIPTS, f)], f));
}
if (!serverTier && wanted('test:node')) {
  results.push(await run(process.execPath, ['--test', ...NODE_TEST_FILES], 'node --test (test/*.test.js)'));
}

// --- Summary ---------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(60)}`);
console.log(`${serverTier ? 'SERVER' : 'LOGIC'} tier: ${results.length - failed.length}/${results.length} suites passed`);
for (const r of failed) console.error(`  FAILED  ${r.label}  (exit ${r.code}, ${Math.round(r.ms / 1000)}s)`);
for (const m of misclassified) {
  console.error(`  MISCLASSIFIED  scripts/${m.file} imports ${m.bad.join(', ')} — it is not pure logic.`);
  console.error(`                 Add it to SERVER_SUITES in scripts/run-tests.mjs (and to the`);
  console.error(`                 test:servers docs), or drop the dependency.`);
}
for (const f of missingServer) console.error(`  MISSING  SERVER_SUITES lists scripts/${f}, which does not exist`);
if (!results.length) console.error('  NOTHING RAN — the filter matched no suite');

const bad = failed.length + misclassified.length + missingServer.length + (results.length ? 0 : 1);
process.exit(bad ? 1 : 0);
