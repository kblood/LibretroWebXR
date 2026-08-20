// Toolchain and dependency POLICY, asserted instead of assumed (CODEX_REVIEW
// TST-4). Run standalone:  node scripts/test-toolchain.mjs
// Discovered automatically by scripts/run-tests.mjs, so this is in `npm test`.
//
// WHY THIS EXISTS
// ---------------
// Every rule below was, until now, either a comment or nothing at all:
//
//   * WHICH NODE. `package.json` declares `engines.node >= 22.13.0` — the true
//     transitive floor from the lockfile, not a guess — and ci.yml pins ONE exact
//     interpreter. Nothing checked that the pin was inside the declared range, or
//     that the declared floor was actually high enough for every dependency. Both
//     drift silently: a `npm i vite@latest` that raises vite's floor leaves this
//     repo claiming support for a Node that cannot run its own build.
//
//   * WHICH VITE. The dev-server advisories behind the loopback-only default
//     (GHSA-fx2h-pf6j-xcff and the esbuild arbitrary-file-read) are fixed
//     upstream; pinning a floor here means a lockfile rollback cannot quietly
//     reintroduce them.
//
//   * LOOPBACK BY DEFAULT. vite.config.js binds 127.0.0.1 unless LAN=1, because
//     the same advisories need a 0.0.0.0 bind on Windows to be exploitable. That
//     is the whole mitigation, it is one ternary, and it had no test. This suite
//     imports the REAL config and reads the host out of it, in both states.
//
//   * WHAT THE DEPLOY INSTALLS. `scripts/deploy.ps1` is gitignored (it holds
//     connection details); `scripts/deploy.example.ps1` is the tracked template
//     the real one is copied from, so the template is what a reviewer sees and
//     what a new machine starts from. It must ship server/package-lock.json and
//     install with `npm ci` — otherwise the deployed relay resolves `^8.21.1`
//     against the registry at deploy time and is the one component whose
//     dependency set was never the tested one.
//
//   * WHO WATCHES THE DEPENDENCIES. ci.yml deliberately excludes `npm audit`
//     (a registry error must not read as clean) and said so while pointing at a
//     "separate, explicitly-scheduled workflow" that did not exist.
//
// Pure logic: reads tracked files and imports vite.config.js. No port, no
// browser, no network, no install required — every version fact comes from the
// LOCKFILE, which is tracked, rather than from node_modules, which is not.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL  ${name}${detail ? `\n  ${detail}` : ''}`); }
};
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const readText = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const serverPkg = readJson('server/package.json');

// --- a deliberately small semver subset ------------------------------------
// No `semver` dependency: adding one to check the dependency policy would be
// funny but is a new supply-chain edge for a job that needs `>=`, `^`, `~`, `<`
// and `||`. Anything this cannot parse is reported as a FAILURE, never skipped —
// a range checker that silently passes on syntax it does not understand is
// exactly the kind of false green the rest of the suite exists to catch.
// Partial versions are real: `>=18 <23` and `^20.19` both appear in the wild, and
// treating them as unparseable would report UNKNOWN (a failure) for a range this
// can perfectly well judge. Missing parts default to 0, as semver does.
const parseV = (v) => {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
};
const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

/** @returns {boolean|null} null = the range used syntax this cannot judge. */
function satisfies(version, range) {
  const v = parseV(version);
  if (!v) return null;
  const clauses = String(range).split('||');
  let sawUnknown = false;
  for (const clause of clauses) {
    const parts = clause.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    let all = true;
    for (const part of parts) {
      const m = /^(>=|<=|>|<|\^|~|=)?\s*(.+)$/.exec(part);
      const target = parseV(m?.[2]);
      if (!target) { sawUnknown = true; all = false; break; }
      const c = cmp(v, target);
      const op = m[1] || '=';
      let hit;
      if (op === '>=') hit = c >= 0;
      else if (op === '>') hit = c > 0;
      else if (op === '<=') hit = c <= 0;
      else if (op === '<') hit = c < 0;
      else if (op === '=') hit = c === 0;
      else if (op === '^') hit = c >= 0 && v[0] === target[0];       // no 0.x nuance needed here
      else if (op === '~') hit = c >= 0 && v[0] === target[0] && v[1] === target[1];
      else { sawUnknown = true; hit = false; }
      if (!hit) { all = false; break; }
    }
    if (all) return true;
  }
  return sawUnknown ? null : false;
}

// ---------------------------------------------------------------------------
console.log('--- the semver subset itself (it decides every check below) ---');
// ---------------------------------------------------------------------------
ok('>= floor', satisfies('22.12.0', '>=22.12.0') === true);
ok('>= below floor', satisfies('22.11.0', '>=22.12.0') === false);
ok('|| union, second branch', satisfies('24.7.0', '^20.19.0 || >=22.12.0') === true);
ok('|| union, first branch', satisfies('20.19.4', '^20.19.0 || >=22.12.0') === true);
ok('|| union, neither branch', satisfies('21.0.0', '^20.19.0 || >=22.12.0') === false);
ok('caret is major-bounded', satisfies('21.0.0', '^20.19.0') === false);
ok('an upper bound is honoured', satisfies('24.7.0', '>=18 <23') === false);
ok('unparseable syntax reports UNKNOWN, never true', satisfies('24.7.0', 'workspace:*') === null);

// ---------------------------------------------------------------------------
console.log('--- declared Node floor vs every direct dependency ---');
// ---------------------------------------------------------------------------
const declaredRange = pkg.engines?.node;
ok('package.json declares engines.node', typeof declaredRange === 'string' && declaredRange.length > 0,
   `engines = ${JSON.stringify(pkg.engines)}`);
const floor = /(\d+\.\d+\.\d+)/.exec(declaredRange || '')?.[1] ?? null;
ok('the declared floor is a concrete version', !!floor, `engines.node = ${declaredRange}`);

const directDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
ok('there are direct dependencies to check', Object.keys(directDeps).length > 0);

// CI pins ONE interpreter. Both it and the declared floor must satisfy every
// dependency's own engines range: the floor because that is what this project
// PROMISES to run on, the pin because that is the only version anything PROVES.
const ciYml = readText('.github/workflows/ci.yml');
const ciNode = /NODE_VERSION:\s*"?([\d.]+)"?/.exec(ciYml)?.[1] ?? null;
ok('.github/workflows/ci.yml pins an exact NODE_VERSION', !!ciNode, ciYml.slice(0, 200));
ok(`the CI pin (${ciNode}) is inside the declared engines range (${declaredRange})`,
   satisfies(ciNode, declaredRange) === true,
   'ci.yml proves a Node this package.json does not claim to support (or vice versa) — bump them together.');

for (const name of Object.keys(directDeps)) {
  const entry = lock.packages?.[`node_modules/${name}`];
  ok(`${name}: present in package-lock.json`, !!entry,
     'a direct dependency with no lockfile entry means `npm ci` cannot reproduce this tree');
  const range = entry?.engines?.node;
  if (!range) continue;   // the dependency states no Node requirement — nothing to check
  for (const [what, version] of [['declared floor', floor], ['CI pin', ciNode]]) {
    const verdict = satisfies(version, range);
    ok(`${name}: our ${what} ${version} satisfies its engines.node "${range}"`, verdict === true,
       verdict === null
         ? `could not parse "${range}" — teach satisfies() this syntax rather than ignoring it`
         : `${name}@${entry.version} requires "${range}". Raise package.json engines.node (and `
           + 'ci.yml NODE_VERSION) to match, or pin the dependency back.');
  }
}

// ---------------------------------------------------------------------------
console.log('--- vite floor (the dev-server advisories behind the loopback default) ---');
// ---------------------------------------------------------------------------
{
  const viteVersion = lock.packages?.['node_modules/vite']?.version ?? null;
  ok('vite is in the lockfile', !!viteVersion);
  ok(`the locked vite (${viteVersion}) is >= 7.3.5`, satisfies(viteVersion, '>=7.3.5') === true,
     'GHSA-fx2h-pf6j-xcff (server.fs.deny bypass via Windows alternate paths) and the esbuild '
     + 'arbitrary-file-read are fixed above this floor. `server.fs.strict: true` does NOT mitigate '
     + 'them; the loopback-only bind below is the other half of the mitigation.');
}

// ---------------------------------------------------------------------------
console.log('--- vite.config.js binds loopback unless LAN=1 ---');
// ---------------------------------------------------------------------------
{
  // vite.config.js reads process.env.LAN at MODULE scope, so each state needs its
  // own module instance — hence the cache-busting query on the import URL.
  const configUrl = pathToFileURL(join(ROOT, 'vite.config.js')).href;
  const saved = process.env.LAN;

  delete process.env.LAN;
  const off = (await import(`${configUrl}?lan=off`)).default;
  ok('LAN unset: the dev server binds 127.0.0.1', off.server?.host === '127.0.0.1',
     `server.host = ${JSON.stringify(off.server?.host)} — a 0.0.0.0 default is the exact `
     + 'precondition of the vite dev-server advisories on Windows.');
  ok('LAN unset: the preview server binds 127.0.0.1 too', off.preview?.host === '127.0.0.1',
     `preview.host = ${JSON.stringify(off.preview?.host)} — preview serves the same tree over the `
     + 'same stack; exposing it while locking down dev protects nothing.');
  ok('LAN unset: dev-server fs access stays strict', off.server?.fs?.strict === true,
     `server.fs.strict = ${JSON.stringify(off.server?.fs?.strict)}`);

  process.env.LAN = '1';
  const on = (await import(`${configUrl}?lan=on`)).default;
  ok('LAN=1: the opt-in still works (headset testing over LAN)',
     on.server?.host === '0.0.0.0' && on.preview?.host === '0.0.0.0',
     `server.host = ${JSON.stringify(on.server?.host)}, preview.host = ${JSON.stringify(on.preview?.host)} — `
     + 'if this fails the loopback default has become unconditional and `$env:LAN=1; npm run dev` '
     + 'no longer reaches a Quest.');

  if (saved === undefined) delete process.env.LAN; else process.env.LAN = saved;
}

// ---------------------------------------------------------------------------
console.log('--- server/ is a first-class package tree ---');
// ---------------------------------------------------------------------------
ok('server/package.json declares engines.node', typeof serverPkg.engines?.node === 'string',
   'without it the remote `npm ci` in the deploy accepts ANY Node on the box, so the deployed relay '
   + 'can run on an interpreter nothing has tested it against');
ok('server/ and the root declare the SAME Node floor', serverPkg.engines?.node === declaredRange,
   `root "${declaredRange}" vs server "${serverPkg.engines?.node}" — they are built, tested and `
   + 'deployed from one repo by one person; two floors is two things to forget.');
ok('server/package-lock.json exists', existsSync(join(ROOT, 'server', 'package-lock.json')),
   'the deploy ships it and installs from it; without one `npm ci` cannot run at all');

// ---------------------------------------------------------------------------
console.log('--- the tracked deploy template installs what CI tested ---');
// ---------------------------------------------------------------------------
{
  // scripts/deploy.ps1 is gitignored (it holds host/user/key). The .example is
  // the reviewable copy and the one a new machine starts from, so it is what a
  // test can hold to the policy. Keep the real one identical by hand.
  const tpl = readText('scripts/deploy.example.ps1');
  // Comment lines stripped: this file EXPLAINS the `npm install` it replaced, and
  // a naive grep would read that explanation as the defect it documents.
  const tplCode = tpl.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  ok('the room deploy ships server/package-lock.json', /server\\package-lock\.json/.test(tplCode),
     'without the lockfile the remote install resolves "^8.21.1" against the registry AT DEPLOY '
     + 'TIME: CI proves ws 8.21.3 and the box can get 8.22.x, ungated.');
  ok('the remote install is `npm ci`, not `npm install`', /npm ci --omit=dev/.test(tplCode),
     '`npm install` rewrites the tree from the registry; `npm ci` installs the locked one and '
     + 'hard-fails if package.json and the lockfile disagree.');
  ok('no plain `npm install` survives in the room deploy path', !/npm install\b/.test(tplCode),
     'one leftover `npm install` re-opens the whole gap');
}

// ---------------------------------------------------------------------------
console.log('--- dependency updates and audits are automated, and audit != CI ---');
// ---------------------------------------------------------------------------
{
  ok('.github/dependabot.yml exists', existsSync(join(ROOT, '.github', 'dependabot.yml')));
  const dep = existsSync(join(ROOT, '.github', 'dependabot.yml')) ? readText('.github/dependabot.yml') : '';
  ok('dependabot covers the root package tree', /directory:\s*"\/"/.test(dep));
  ok('dependabot covers server/ too', /directory:\s*"\/server"/.test(dep),
     'server/ is the tree that runs unattended on a public box — the one that least deserves to be skipped');

  ok('.github/workflows/audit.yml exists', existsSync(join(ROOT, '.github', 'workflows', 'audit.yml')),
     'ci.yml excludes `npm audit` and points at "a separate, explicitly-scheduled workflow"');
  const audit = existsSync(join(ROOT, '.github', 'workflows', 'audit.yml')) ? readText('.github/workflows/audit.yml') : '';
  ok('the audit runs on a schedule', /schedule:/.test(audit) && /cron:/.test(audit));
  ok('the audit can be run on demand', /workflow_dispatch:/.test(audit));
  ok('the audit treats an unparseable result as UNKNOWN, not clean', /UNKNOWN/.test(audit),
     'a gate that goes green on a registry error is worse than no gate (ci.yml says so itself)');
  ok('`npm audit` stays OUT of the push/PR gate', !/npm audit/.test(ciYml.replace(/^#.*$/gm, '')),
     'ci.yml must not gain an audit step: its result depends on a network call and on an advisory '
     + 'database that changes with no commit here.');
  ok('CI installs from the lockfile in both trees', (ciYml.match(/npm ci\b/g) || []).length >= 2,
     'a `npm install` in CI rewrites the tree it is supposed to be proving');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
