// The static undefined-identifier gate, run as a normal `npm test` suite.
//
// WHAT IT GATES
// -------------
// `eslint.config.js` turns on exactly five correctness rules — no-undef,
// no-unreachable, no-dupe-keys, no-const-assign, no-unused-vars — and nothing
// stylistic. This file runs them over src/, scripts/, test/ and the root config
// files and fails the run on the first error. Read eslint.config.js's header for
// why those five
// and why the globals lists look the way they do.
//
// The bug it was written for: the §3.1 extraction deleted
// `import { makeGamepadHoldKey } from './GhostGamepadMgr.js'` and left four call
// sites behind, so every multiplayer gamepad grab threw a ReferenceError inside
// the XR frame callback. `node --check`, `npm test` (52 suites), `npm run build`
// and a headless boot of the real app were ALL green over it, because the call
// sites sit behind a `net &&` guard and only fire in a room — on a headset.
//
// WHY A SUITE AND NOT A SEPARATE CI STEP
// --------------------------------------
// Because this repo already made the opposite choice and paid for it.
// run-tests.mjs DISCOVERS every scripts/test-*.mjs precisely so that membership
// cannot rot: four suites once existed, were green, and were in nobody's `&&`
// chain. A hand-added `- run: npx eslint …` step in ci.yml is that same
// hand-maintained list, one file further away, and it would also be invisible to
// `npm test` on a developer box — where this check is worth the most, since it is
// the one that runs before the headset does. As a suite it is in the gate the
// moment the file exists, it runs locally with everything else, and ci.yml needs
// no edit at all.
//
// TIER HYGIENE: this is pure logic. It imports `eslint` and reads files; it binds
// no port, spawns no child process and needs no browser. run-tests.mjs's
// MISCLASSIFIED check (ws / puppeteer / node:http / node:net / node:child_process)
// is satisfied by construction — ESLint's programmatic API is used exactly so this
// file never shells out.
//
// NEGATIVE CONTROLS. Each of the five rules is fed a snippet that violates it and
// is required to report it, and the no-undef control is the SHIPPED BUG, not a toy:
// `net.setObjectState(makeGamepadHoldKey(cableId), null)`. Without those, a green
// run would prove only that ESLint started. There is also a COVERAGE control — the
// tree really was walked, and src/main.js (the 8,000-line file no suite imports,
// i.e. the whole reason this exists) really was one of the files — so an `ignores`
// entry or a glob typo cannot quietly reduce this to a green no-op.
//
// Run standalone: node scripts/test-lint.mjs      (also `npm run lint`)
// Exit 0 = clean, 1 = any lint error or any failed control.

import { ESLint } from 'eslint';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORRECTNESS_RULES } from '../eslint.config.js';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPTS, '..');

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  FAIL: ${msg}`); } };
const section = (name) => console.log(`--- ${name} ---`);

// Everything the gate covers. Relative to ROOT, and ROOT is passed as `cwd` so
// the suite behaves identically however it is invoked.
const TARGETS = ['src', 'scripts', 'test', 'vite.config.js', 'eslint.config.js'];

const eslint = new ESLint({ cwd: ROOT });
const results = await eslint.lintFiles(TARGETS);
const rel = (p) => relative(ROOT, p).split(sep).join('/');

// --- 1. the gate itself ------------------------------------------------------
section('lint');
const errors = [];
for (const r of results) {
  for (const m of r.messages) {
    if (m.severity === 2) errors.push(`${rel(r.filePath)}:${m.line}:${m.column}  ${m.ruleId}  ${m.message}`);
  }
}
for (const e of errors) console.error(`  FAIL: ${e}`);
ok(errors.length === 0, `${errors.length} lint error(s) — see above. Fix the code, or (only if the host page really supplies the name) add the global to eslint.config.js. Never an inline disable.`);
console.log(`  ${results.length} files linted, ${errors.length} error(s)`);

// --- 2. coverage control -----------------------------------------------------
// A green run must mean "the tree was checked", not "the globs matched nothing".
section('coverage');
const linted = new Set(results.map((r) => rel(r.filePath)));
for (const f of [
  'src/main.js',              // the file no suite imports; the reason this exists
  'src/net/RoomConnection.js',
  'src/runtime/EmulatorWorkerRuntime.js',
  'src/desktop/DesktopNet.js',
  'scripts/run-tests.mjs',
  'scripts/test-lint.mjs',
  'test/runtime.test.js',
  'vite.config.js',
]) ok(linted.has(f), `${f} was not linted — check the files/ignores globs in eslint.config.js`);
ok(results.length > 200, `only ${results.length} files linted; the tree has ~270 — a glob has narrowed`);

// --- 3. negative controls: every gated rule really fires ---------------------
section('negative controls');
const lintText = async (code, filePath) => {
  const [r] = await eslint.lintText(code, { filePath: resolve(ROOT, filePath) });
  return r.messages.filter((m) => m.severity === 2);
};

// The shipped bug, verbatim in shape: a call to a name whose import was deleted.
const shippedBug = [
  'const net = { setObjectState() {} };',
  'export function onGamepadReleased(cableId) {',
  '  if (net && cableId) net.setObjectState(makeGamepadHoldKey(cableId), null);',
  '}',
].join('\n');
const undefHits = await lintText(shippedBug, 'src/__neg_undef.js');
ok(undefHits.some((m) => m.ruleId === 'no-undef' && m.message.includes('makeGamepadHoldKey')),
  '[neg] no-undef did NOT flag the shipped makeGamepadHoldKey bug — this gate is not gating');
ok(undefHits.length === 1, `[neg] the shipped-bug snippet produced ${undefHits.length} errors; exactly one (no-undef) was expected`);

// A name the host page DOES supply must stay quiet: the window.__* debug surface
// the probe scripts depend on is property access, and browser/WebXR globals are
// configured. This control is what stops a future globals edit from making the
// rule cry wolf on the very code this project ships on purpose.
const debugSurface = [
  'window.__testApi = { grabGamepad() {} };',
  'globalThis.__disarmGun = () => {};',
  'const layer = new XRWebGLLayer(session, gl);',
  'const t = new XRRigidTransform();',
  'const b = new SharedArrayBuffer(8);',
  'export default [layer, t, b, session, gl];',
  'let session, gl;',
].join('\n');
ok((await lintText(debugSurface, 'src/__neg_globals.js')).length === 0,
  '[neg] the window.__* debug surface / WebXR globals produced errors — the globals config is crying wolf');

ok((await lintText('export function f() { return 1; console.log(2); }', 'src/__neg_unreachable.js'))
  .some((m) => m.ruleId === 'no-unreachable'), '[neg] no-unreachable did not fire');
ok((await lintText('export const o = { a: 1, b: 2, a: 3 };', 'src/__neg_dupe.js'))
  .some((m) => m.ruleId === 'no-dupe-keys'), '[neg] no-dupe-keys did not fire');
ok((await lintText('const x = 1; x = 2; export default x;', 'src/__neg_const.js'))
  .some((m) => m.ruleId === 'no-const-assign'), '[neg] no-const-assign did not fire');
ok((await lintText("import { a } from './x.js'; export default 1;", 'src/__neg_unused.js'))
  .some((m) => m.ruleId === 'no-unused-vars'), '[neg] no-unused-vars did not fire on a dead import');

// The rule's OPTIONS are the part that can silently gut it: widen
// varsIgnorePattern and the tripwire goes quiet while still reporting green.
// So both halves are controlled — the exemption must hold, and it must not
// have grown to cover ordinary names.
ok((await lintText('const _parked = 1; export default 2;', 'src/__neg_unused_parked.js'))
  .length === 0, '[neg] a `_`-prefixed parked binding was reported — varsIgnorePattern is not being applied');
ok((await lintText('export function f(used, ignored) { return used; }', 'src/__neg_unused_args.js'))
  .length === 0, '[neg] an unused function ARG was reported — args:none is not being applied');

// --- 4. no gated rule may be silenced inline ---------------------------------
// eslint.config.js switches unused-directive reporting OFF (two files carry a
// no-new-func directive for a rule this config does not enable). That is the right
// call for rules we do not gate, and the wrong one for rules we do: an
// `// eslint-disable-next-line no-undef` would turn a latent ReferenceError back
// into a green run. So the five gated rules are un-disable-able, and this is the
// check that says so out loud rather than in a comment.
section('no inline silencing of the gated rules');
const GATED = Object.keys(CORRECTNESS_RULES);
// Not a text scan for the word "eslint-disable" — that flags prose (this file's
// own header talks about the directive) and misses nothing useful. ESLint reports
// what a directive ACTUALLY suppressed in `suppressedMessages`, so this asks the
// linter directly: did a comment hide a hit from one of the five gated rules?
const silencedIn = (r) => (r.suppressedMessages ?? [])
  .filter((m) => GATED.includes(m.ruleId))
  .map((m) => `${rel(r.filePath)}:${m.line}  a comment suppressed ${m.ruleId}: ${m.message}`);

const silenced = results.flatMap(silencedIn);
for (const s of silenced) console.error(`  FAIL: ${s}`);
ok(silenced.length === 0, `${silenced.length} suppressed hit(s) of a gated rule. A no-undef hit is a latent ReferenceError: fix the import, or declare the global in eslint.config.js with a reason.`);

// The control: the shipped bug WITH a disable comment over it must be caught here
// rather than vanish. Without this, "0 suppressed" would also be what a broken
// check prints.
const [suppressedRun] = await eslint.lintText(
  shippedBug.replace('  if (net', '  // eslint-disable-next-line no-undef\n  if (net'),
  { filePath: resolve(ROOT, 'src/__neg_suppressed.js') },
);
ok(suppressedRun.messages.filter((m) => m.severity === 2).length === 0,
  '[neg] the disable comment did not actually suppress the error — the control is not testing what it claims');
ok(silencedIn(suppressedRun).length === 1,
  '[neg] a disable comment over the shipped bug was NOT reported as silencing — this check cannot catch a real one');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
