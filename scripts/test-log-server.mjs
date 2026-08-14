// Regression test for server/log-server.mjs hardening.
//
//   node scripts/test-log-server.mjs            (exit 0 = pass, 1 = fail)
//   LOG_PORT=8895 node scripts/test-log-server.mjs
//
//   Env: LOG_PORT        port to run every phase on          (default 8891)
//        LOG_MOD         module PHASE 1/2 exercise           (default server/log-server.mjs)
//        LOG_PREFIX_REF  git ref PHASE 0 takes its pre-fix baseline from
//                        (default: the pinned commit below — see PREFIX_REF)
//
// ─── How this suite proves things ────────────────────────────────────────────
//
// Every claim runs against a REAL server on a REAL port, in a child process.
// The negative control is not a hand-written stand-in: PHASE 0 extracts the
// ACTUAL pre-hardening module out of git (`git archive <ref> server/…` piped
// into `tar -x`, into a temp dir — the working tree is never touched) and boots
// THAT. The same probe functions then run against both servers, so each
// "hardened does X" pass is backed by a measured "pre-fix did NOT do X".
//
// <ref> is PINNED to the last commit that actually touched the module
// (PREFIX_REF below), NOT HEAD. Using HEAD made this suite destroy itself the
// moment the hardening was committed: HEAD's copy is then the HARDENED module,
// PHASE 0 boots it as its own "negative control", and 12 assertions that say
// "pre-fix did the bad thing" flip to FAIL — turning `npm test` red and, via
// the `&&` chain in package.json, blocking every suite after it.
//
//   PHASE 0 — the real pre-fix module (git <PREFIX_REF>:server/log-server.mjs).
//   PHASE 1 — the hardened module, no LOG_TOKEN (the shipped default).
//   PHASE 2 — the hardened module with LOG_TOKEN + LOG_CORS_ORIGINS set.
//
// ─── What this suite does NOT claim ──────────────────────────────────────────
//
// It does NOT claim to have closed a path-traversal hole. There wasn't one: the
// pre-fix code already did `sessionId.replace(/[^\w-]/g,'_').slice(0,64)`, so
// no hostile session id ever escaped the log directory, and PHASE 0 measures
// exactly that against the real pre-fix server. The escape checks below are
// REGRESSION GUARDS on a property that already held — they are labelled as
// such, and they are counted once, not once per hostile id.
//
// The one genuine filename difference is Windows device names: pre-fix wrote a
// real `CON.log` / `nul.log` / `lpt1.log` into the log dir, the hardened version
// writes `_CON.log`. PHASE 0 asserts the bad behaviour, PHASE 1 asserts the fix.

import { spawn, spawnSync }  from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { connect }           from 'node:net';
import { tmpdir }            from 'node:os';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT     = Number(process.env.LOG_PORT || 8891);
const BASE     = `http://127.0.0.1:${PORT}`;
const REPO     = dirname(dirname(fileURLToPath(import.meta.url)));
// LOG_MOD points PHASE 1/2 at a different module. It exists so a reviewer can
// copy server/log-server.mjs somewhere, revert ONE fix in the copy, and watch
// exactly which assertions below go red — i.e. so every claim here can be shown
// to be falsifiable without touching the working tree.
const REAL_MOD = process.env.LOG_MOD || join(REPO, 'server', 'log-server.mjs');

const TMP      = mkdtempSync(join(tmpdir(), 'logsrv-test-'));
const LOG_DIR  = join(TMP, 'logs');
const PRE_TMP  = mkdtempSync(join(tmpdir(), 'logsrv-prefix-'));
const PRE_LOG  = join(PRE_TMP, 'logs');

let passed = 0, failed = 0, skipped = 0;
const ok = (cond, msg) => {
  if (cond) { passed++;  console.log(`  OK   ${msg}`); }
  else      { failed++; console.error(`  FAIL ${msg}`); }
};
const skip = (msg) => { skipped++; console.log(`  SKIP ${msg}`); };

/**
 * The one summary line, printed from every exit path. When PHASE 0 could not
 * run, it says so in a way nobody can miss: a skipped negative control means
 * the PHASE 1/2 passes are unbacked — they are still real measurements, but
 * nothing proved the assertions can go red.
 */
let negativeControlSkipReason = '';
function summarize() {
  if (negativeControlSkipReason) {
    console.log('\n' + '!'.repeat(78));
    console.log('!! NEGATIVE CONTROL SKIPPED — PHASE 0 did not run.');
    console.log(`!! ${negativeControlSkipReason}`);
    console.log('!! Every PHASE 1/2 pass below is therefore UNBACKED: this run did not');
    console.log('!! demonstrate that any of those assertions is capable of failing.');
    console.log('!! Run it in a full (non-shallow) clone to get the real verdict.');
    console.log('!'.repeat(78));
  }
  console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} SKIPPED` : ''}`);
}

// ─── Constants DERIVED from the module under test, never re-typed ────────────
// These used to be hand-copied (`const MAX_CONN = 64;  // mirrors …`), so the
// cap assertions measured a number this suite invented rather than the one the
// module enforces. Measured, with the module retuned to MAX_CONNECTIONS = 24:
// the hand-copied version opened 70 sockets, saw the cap refuse 46 of them
// exactly as designed, and reported "served count sits far below the cap" —
// i.e. it went red about a cap that was working perfectly. (Retune the other
// way, past the 70 sockets the probe opens, and `refused > 0` goes red for the
// same reason.) Read them out of the module source instead — source text, not
// `import`, because importing this module starts a server on LOG_PORT as a
// side effect, which is exactly what this process must not do. A missing
// constant is a hard error, never a default.

const REAL_SRC = readFileSync(REAL_MOD, 'utf8');
function moduleConst(name) {
  const m = REAL_SRC.match(new RegExp(`^const\\s+${name}\\s*=\\s*([0-9_]+)\\s*;`, 'm'));
  if (!m) {
    console.error(`  FATAL: could not read ${name} out of ${REAL_MOD}. ` +
                  `The cap assertions below would measure a number this suite invented. Aborting.`);
    process.exit(1);
  }
  return Number(m[1].replace(/_/g, ''));
}
const MAX_CONN     = moduleConst('MAX_CONNECTIONS');
const KEEPALIVE_MS = moduleConst('KEEPALIVE_TIMEOUT');

// ─── The negative control: the REAL pre-fix module, straight out of git ──────
// `git archive <PREFIX_REF> <path> | tar -x -C <tmp>`. Deliberately NOT
// `git show <ref>:file > file` — that would clobber the working tree.

const PREFIX_PATH = 'server/log-server.mjs';

// The last commit that TOUCHED server/log-server.mjs before the 2026-08
// hardening, i.e. the newest commit whose copy of the file is still pre-fix:
//
//   git log -1 --format=%H -- server/log-server.mjs   → 2291fa1…
//
// Pinned rather than HEAD on purpose (see the header). Re-pin — or export
// LOG_PREFIX_REF — only when the pre-fix BASELINE itself moves, which is
// essentially never; committing the hardening must NOT require touching this.
const PREFIX_REF = process.env.LOG_PREFIX_REF || '2291fa122d2e85483ae04548ca52625797e5fe07';

// Cheap fingerprint of a genuinely PRE-FIX copy, so a wrong or re-pointed ref
// is reported as a broken pin instead of quietly producing a dozen nonsense
// "the pre-fix server didn't misbehave" failures.
const PREFIX_MUST_HAVE     = 'levelColor = {';        // plain object literal
const PREFIX_MUST_NOT_HAVE = 'Object.create(null)';   // the hardened lookup table

/**
 * @returns {{path:string|null, absent:boolean, why:string}}
 *   path   — the extracted pre-fix module, or null.
 *   absent — true when this checkout simply CANNOT supply the baseline (no git,
 *            or a shallow clone / CI checkout without that commit). That is an
 *            environment limitation, not a defect: PHASE 0 then skips LOUDLY.
 *            false means the ref IS reachable and extraction genuinely broke,
 *            or the pin points at something that is not pre-fix → hard fail.
 */
function extractPrefixModule() {
  const inRepo = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: REPO });
  if (inRepo.status !== 0) {
    return { path: null, absent: true,
             why: 'not a git checkout (or git is unavailable) — no history to take the baseline from' };
  }
  const hasRef = spawnSync('git', ['cat-file', '-e', `${PREFIX_REF}:${PREFIX_PATH}`], { cwd: REPO });
  if (hasRef.status !== 0) {
    const shallow = existsSync(join(REPO, '.git', 'shallow'));
    return { path: null, absent: true,
             why: `${PREFIX_REF.slice(0, 12)}:${PREFIX_PATH} is not in this checkout` +
                  `${shallow ? ' (SHALLOW clone — refetch with fetch-depth 0 to restore the negative control)' : ''}` };
  }

  const ar = spawnSync('git', ['archive', '--format=tar', PREFIX_REF, PREFIX_PATH],
    { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
  if (ar.status !== 0 || !ar.stdout?.length) {
    return { path: null, absent: false,
             why: `git archive failed (status ${ar.status}): ${String(ar.stderr || '').slice(0, 200)}` };
  }
  const tr = spawnSync('tar', ['-x', '-C', PRE_TMP], { input: ar.stdout });
  if (tr.status !== 0) {
    // `tar` is the one non-git external here; a box without it cannot supply
    // the baseline either, so that case skips rather than crying defect.
    return { path: null, absent: tr.error?.code === 'ENOENT',
             why: `tar -x failed (${tr.error?.code || `status ${tr.status}`}): ${String(tr.stderr || '').slice(0, 200)}` };
  }
  const p = join(PRE_TMP, 'server', 'log-server.mjs');
  if (!existsSync(p)) return { path: null, absent: false, why: `extracted, but ${p} is missing` };

  const src = readFileSync(p, 'utf8');
  if (!src.includes(PREFIX_MUST_HAVE) || src.includes(PREFIX_MUST_NOT_HAVE)) {
    return { path: null, absent: false,
             why: `${PREFIX_REF.slice(0, 12)}:${PREFIX_PATH} is NOT the pre-fix module ` +
                  `(contains "${PREFIX_MUST_HAVE}": ${src.includes(PREFIX_MUST_HAVE)}, ` +
                  `contains "${PREFIX_MUST_NOT_HAVE}": ${src.includes(PREFIX_MUST_NOT_HAVE)}) — the pin is wrong` };
  }
  return { path: p, absent: false, why: '' };
}

// ─── Child-process helpers ───────────────────────────────────────────────────

function startServer(modPath, extraEnv = {}) {
  const child = spawn(process.execPath, [
    '--input-type=module',
    '-e', `await import(${JSON.stringify(pathToFileURL(modPath).href)});`,
  ], {
    env: { ...process.env, LOG_PORT: String(PORT), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { stdout: '', stderr: '', exited: false, code: null };
  child.stdout.on('data', (d) => { out.stdout += d; });
  child.stderr.on('data', (d) => { out.stderr += d; });
  child.on('exit', (code) => { out.exited = true; out.code = code; });
  child.log = out;
  return child;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitListening(child, ms = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (child.log.stdout.includes(`listening on :${PORT}`)) {
      // The 'listening' line fires from the listen callback; give the loop a tick.
      await sleep(50);
      return true;
    }
    if (child.log.exited) return false;
    await sleep(50);
  }
  return false;
}

/**
 * Boot a phase's server and PROVE we are talking to that child and not to a
 * leftover listener.
 *
 * Both halves matter. On Windows a previous phase's sockets sit in TIME_WAIT
 * and (with SO_EXCLUSIVEADDRUSE) can make the next bind fail — and the module
 * only *logs* a bind error, it does not exit, so the phase would happily run
 * every assertion against whatever else is on the port. That is how a run of
 * this suite once reported pre-fix behaviour from PHASE 1. So: retry the bind,
 * then confirm identity by POSTing a marker session and checking THIS child's
 * stdout printed the corresponding ingest line.
 */
async function startOwnedServer(modPath, extraEnv = {}, label = 'server') {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const child = startServer(modPath, extraEnv);
    if (await waitListening(child, 6000)) {
      const marker = `self-check-${process.pid}-${attempt}`;
      await post({ sessionId: marker, clientId: 'c', nick: 'n',
                   entries: [{ level: 'log', ts: Date.now(), msg: 'identity probe' }] });
      await sleep(120);
      if (child.log.stdout.includes(`session="${marker}"`)) return child;
      console.error(`  ..   ${label}: port :${PORT} answered, but not from our child — retrying (attempt ${attempt})`);
    } else {
      console.error(`  ..   ${label}: not listening on :${PORT} (attempt ${attempt})` +
                    `${child.log.stderr ? ` — ${child.log.stderr.split('\n')[0]}` : ''}` +
                    `${child.log.stdout.includes('failed to bind') ? ' [bind failed]' : ''}`);
    }
    await stopServer(child);
    await sleep(1000 * attempt);
  }
  return null;
}

async function stopServer(child) {
  if (!child || child.log.exited) return;
  child.kill();
  const t0 = Date.now();
  while (!child.log.exited && Date.now() - t0 < 5000) await sleep(50);
  await sleep(200);   // let the OS release the port before the next phase binds
}

async function post(payload, { rawBody = null, headers = {} } = {}) {
  try {
    const res = await fetch(`${BASE}/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: rawBody !== null ? rawBody : JSON.stringify(payload),
    });
    return { status: res.status, text: await res.text(), acao: res.headers.get('access-control-allow-origin'), error: null };
  } catch (e) { return { status: 0, text: '', acao: null, error: String(e?.cause?.message || e?.message || e) }; }
}

async function get(path, headers = {}) {
  try {
    const res = await fetch(BASE + path, { headers });
    return {
      status: res.status,
      text: await res.text(),
      acao: res.headers.get('access-control-allow-origin'),
      vary: res.headers.get('vary'),
      error: null,
    };
  } catch (e) { return { status: 0, text: '', acao: null, vary: null, error: String(e?.cause?.message || e?.message || e) }; }
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let isDir = false;
    // A Windows device file (logs/CON.log, pre-fix) can refuse to stat — count
    // it as a file rather than letting the walk throw.
    try { isDir = statSync(p).isDirectory(); } catch { isDir = false; }
    if (isDir) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

// ─── Shared payloads ─────────────────────────────────────────────────────────

const XSS_IMG    = '<img src=x onerror=alert(1)>';
const XSS_SCRIPT = '<script>alert(2)</script>';

const xssBatch = {
  sessionId: 'xss-room',
  clientId:  '<script>c</script>',
  nick:      XSS_IMG,
  entries: [
    { level: 'error', ts: Date.now(), msg: XSS_SCRIPT },
    { level: '<b>lvl</b>', ts: Date.now(), msg: 'plain "quoted" & <b>bold</b>' },
  ],
};

// The exact payload CLAUDE_REVIEW §4.2 used to kill the process: valid JSON,
// valid array, entry with NO msg (and, second case, an out-of-range ts).
const CRASH_BATCH   = { sessionId: 'boom', clientId: 'c', entries: [{ level: 'log', ts: 1 }] };
const CRASH_BATCH_2 = { sessionId: 'boom', clientId: 'c', entries: [{}] };
const CRASH_BATCH_3 = { sessionId: 'boom', clientId: 'c', entries: [{ level: 'log', ts: 1e20, msg: 'x' }] };

// Session ids that a hostile client could POST. `traversal` is the historical
// list; only the WIN_DEVICES subset behaved differently before the fix.
const HOSTILE_IDS = [
  '../../pwned', '..\\..\\pwned-win', '/etc/passwd', 'C:\\Windows\\Temp\\pwn',
  '....//....//esc', 'a/../../b', 'CON', 'nul', 'lpt1', 'dots...', ' spaced ',
  'x\u0000y', '..', '.', '%2e%2e%2fesc',
];
const WIN_DEVICES = ['CON', 'nul', 'lpt1'];

// ─── Shared probes: the SAME code runs against pre-fix and hardened ──────────

/** Levels that resolve on Object.prototype when the colour table is a `{}`. */
const PROTO_LEVELS = ['constructor', 'toString', 'valueOf', '__proto__'];

async function probeLevelPrototype() {
  await post({
    sessionId: 'proto', clientId: 'c', nick: 'n',
    entries: PROTO_LEVELS.map((level) => ({ level, ts: Date.now(), msg: `lvl=${level}` })),
  });
  const html = (await get('/logs?session=proto')).text;
  return {
    html,
    // The tell-tale of Object.prototype reaching a style attribute.
    leaked: /native code|color:\[object Object\]/.test(html),
    // Every level cell should fall back to the default colour.
    defaultedRows: (html.match(/style="color:#ccc;text-transform:uppercase/g) || []).length,
  };
}

async function probeNestedExtras() {
  await post({
    sessionId: 'nest', clientId: 'c', nick: 'n',
    entries: [{
      level: 'event', ts: Date.now(), msg: '[net]',
      event: 'net',
      peers: ['a', 'b'],
      shallow: { room: 'lobby', n: 2 },
      deep: { l1: { l2: { l3: { l4: 'too deep' } } } },
      wide: Array.from({ length: 100 }, (_, i) => i),
    }],
  });
  const j = JSON.parse((await get('/logs.json?session=nest')).text);
  return j.entries[j.entries.length - 1] || {};
}

/**
 * POST an entry whose extra key is literally `__proto__`.
 *
 * Note the defineProperty: writing `__proto__:` in an object literal invokes the
 * prototype setter and puts NOTHING in the JSON, so the obvious way to write
 * this probe silently tests nothing.
 */
async function probeProtoKey() {
  const entry = { level: 'log', ts: Date.now(), msg: 'proto-key', ok: 1 };
  Object.defineProperty(entry, '__proto__',
    { value: { polluted: true }, enumerable: true, writable: true, configurable: true });
  const rawBody = JSON.stringify({ sessionId: 'protokey', clientId: 'c', nick: 'n', entries: [entry] });
  if (!rawBody.includes('__proto__')) throw new Error('probeProtoKey: payload lost its __proto__ key');
  await post(null, { rawBody });
  const raw = (await get('/logs.json?session=protokey')).text;
  return { raw, entry: JSON.parse(raw).entries.at(-1) || {} };
}

async function probeHostileSessionIds() {
  for (const sid of HOSTILE_IDS) {
    await post({ sessionId: sid, clientId: 'c', nick: 'n',
                 entries: [{ level: 'log', ts: Date.now(), msg: `sid=${sid}` }] });
  }
  await sleep(400);   // let the write streams flush
}

/**
 * Give the server back the connection slots THIS process is still holding.
 *
 * Every fetch() above leaves an idle keep-alive socket parked on the server,
 * and an idle keep-alive socket counts against `server.maxConnections` exactly
 * like a busy one. Measuring the cap without clearing them is what made the
 * old `served >= MAX_CONN - 12` window necessary: the count depended on how
 * many sockets undici happened to be reusing, which moves with load. The
 * server closes an idle keep-alive connection after KEEPALIVE_TIMEOUT (read
 * out of the module, not guessed), so waiting a little past that makes the
 * following measurement start from a known-empty table instead of a guess.
 */
async function quiesceConnections() {
  await sleep(KEEPALIVE_MS + 1500);
}

/**
 * Open `n` sockets to the log port, each of which sends a real HTTP GET and
 * stays open, and count how many got served. `server.maxConnections` makes the
 * excess sockets get destroyed on accept, which is a refusal path nothing else
 * in this repo exercises.
 *
 * @returns {Promise<{served:number, refused:number, close:() => void}>}
 */
async function probeConnectionCap(n) {
  const socks = [];
  let served = 0, refused = 0;
  for (let i = 0; i < n; i++) {
    const r = await new Promise((resolve) => {
      const sock = connect({ host: '127.0.0.1', port: PORT });
      socks.push(sock);
      let buf = '', done = false;
      const finish = (served_) => { if (!done) { done = true; clearTimeout(timer); resolve(served_); } };
      const timer = setTimeout(() => finish(false), 3000);
      sock.on('connect', () => {
        sock.write('GET /logs.json?session=__none__&tail=0 HTTP/1.1\r\n' +
                   `Host: 127.0.0.1:${PORT}\r\nConnection: keep-alive\r\n\r\n`);
      });
      sock.on('data', (d) => { buf += d; if (buf.includes('\r\n\r\n')) finish(/^HTTP\/1\.[01] 200/.test(buf)); });
      sock.on('error', () => finish(false));
      sock.on('close', () => finish(false));
    });
    if (r) served++; else refused++;
  }
  return { served, refused, close: () => { for (const s of socks) { try { s.destroy(); } catch { /* gone */ } } } };
}

// ═════ PHASE 0 — negative control: the REAL pre-fix module from git ══════════

console.log(`\nPHASE 0 — negative control: real pre-fix module (git ${PREFIX_REF.slice(0, 7)}) on :${PORT}`);

const PRE_FIX = extractPrefixModule();

if (PRE_FIX.absent) {
  // This checkout cannot supply the baseline (shallow clone, CI export, no
  // git or no tar). Skip the whole phase LOUDLY — never fail, never pass quietly.
  negativeControlSkipReason = PRE_FIX.why;
  skip(`PHASE 0 ENTIRELY — the negative control behind every PHASE 1 claim: ${PRE_FIX.why}`);
  console.log('       PHASE 1/2 still run, but nothing below is backed by a measured pre-fix failure.');
} else {
  const { path: PRE_MOD, why } = PRE_FIX;
  ok(PRE_MOD !== null, `negative control: pre-fix module extracted from git ${PREFIX_REF.slice(0, 7)} via \`git archive | tar -x\`${PRE_MOD ? ` → ${PRE_MOD}` : ` — ${why}`}`);

  if (!PRE_MOD) {
    console.error('  !! The baseline commit IS reachable here, so this is a real defect, not an environment limit.');
    console.error('  !! Without the real pre-fix module every PHASE 1 pass below is unverified. Aborting.');
    summarize();
    process.exit(1);
  }

  const pre = await startOwnedServer(PRE_MOD, { LOG_DIR: PRE_LOG }, 'pre-fix');
  ok(pre !== null, `negative control: pre-fix server is listening on :${PORT} and identified as our own child`);
  if (!pre) {
    console.error('  !! Could not own the port. Every PHASE 1 pass below would be unverified. Aborting.');
    summarize();
    process.exit(1);
  }

  // 0a. XSS — the assertions PHASE 1 makes must FAIL here.
  await post(xssBatch);
  const html = await get('/logs?session=xss-room');
  ok(html.status === 200, `negative control: GET /logs returns 200 (got ${html.status})`);
  ok(html.text.includes(XSS_IMG) === true,
     'negative control: raw <img onerror> IS present pre-fix (so the "absent" check can fail)');
  ok(html.text.includes('&lt;img src=x onerror=alert(1)&gt;') === false,
     'negative control: escaped form is ABSENT pre-fix (so the "present" check can fail)');

  // 0b. Level colour lookup on a `{}` table reaches Object.prototype.
  const proto = await probeLevelPrototype();
  ok(proto.leaked === true,
     'negative control: level="constructor" DOES put Object.prototype into style="color:…" pre-fix');
  console.log('       leaked cell:', (proto.html.match(/<td style="color:[^"]{0,60}/g) || []).find((s) => /native code/.test(s)) || '(none)');

  // 0c. Structured extras — pre-fix stored the raw value, nesting and all.
  const nest = await probeNestedExtras();
  ok(Array.isArray(nest.peers),
     'negative control: pre-fix stored peers as a REAL ARRAY (so the round-1 stringified form was a regression)');
  ok(nest.deep?.l1?.l2?.l3?.l4 === 'too deep',
     'negative control: pre-fix stored UNBOUNDED nesting (so the depth cap below can fail)');
  ok(Array.isArray(nest.wide) && nest.wide.length === 100,
     `negative control: pre-fix stored an UNBOUNDED 100-element array (so the item cap can fail, got ${nest.wide?.length})`);

  const pk0 = await probeProtoKey();
  ok(pk0.raw.includes('__proto__') === true,
     `negative control: pre-fix stored a literal "__proto__" extra key verbatim (so the "never reaches the record" check can fail) — ${(pk0.raw.match(/.{0,40}__proto__.{0,30}/) || [''])[0]}`);

  // 0d. Hostile session ids: no escape (there never was one) but real device files.
  await probeHostileSessionIds();
  const preFiles = walk(PRE_LOG).map((p) => p.slice(PRE_LOG.length + 1));
  const preEscaped = walk(PRE_TMP).filter((p) => !p.startsWith(PRE_LOG + sep) && !p.endsWith('.mjs'));
  ok(preEscaped.length === 0,
     `HONESTY: pre-fix ALSO kept every file inside the log dir — there was no traversal hole to close (found ${preEscaped.length} outside)`);
  ok(WIN_DEVICES.every((d) => preFiles.includes(`${d}.log`)),
     `negative control: pre-fix wrote raw Windows device names into the log dir (${preFiles.filter((f) => /^(CON|nul|lpt1)\.log$/.test(f)).join(' ') || 'none'}) — this is the ONE real filename fix`);

  // 0e. CORS — reads were wide open to every origin.
  const preCors = await get('/logs.json?session=xss-room', { Origin: 'https://evil.example' });
  ok(preCors.acao === '*',
     `negative control: pre-fix answered GET /logs.json with Access-Control-Allow-Origin: * (got ${preCors.acao}) — any page could read every session`);

  // 0f. No connection cap: 70 concurrent sockets are all served.
  const preCap = await probeConnectionCap(MAX_CONN + 6);
  ok(preCap.served === MAX_CONN + 6,
     `negative control: pre-fix served ALL ${MAX_CONN + 6} concurrent sockets (served=${preCap.served}, refused=${preCap.refused}) — no maxConnections`);
  preCap.close();
  await sleep(1000);   // let those 70 connections leave TIME_WAIT before the next bind

  // 0g. Crash: one POST + one GET kills the process (which in production is the
  //     room server too, because room-server.mjs imports this module). LAST —
  //     it ends the phase-0 server.
  const cPost = await post(CRASH_BATCH);
  ok(cPost.status === 204, `negative control: crash payload is ACCEPTED pre-fix (got ${cPost.status})`);
  const cGet = await get('/logs?session=boom');
  await sleep(500);
  ok(pre.log.exited === true,
     `negative control: process DIED after the viewer GET (exited=${pre.log.exited}, code=${pre.log.code})`);
  ok(/TypeError|RangeError/.test(pre.log.stderr),
     'negative control: death was an unhandled TypeError/RangeError out of the HTTP handler');
  ok(cGet.status !== 200,
     `negative control: the viewer GET did not return 200 (got ${cGet.status}${cGet.error ? ' / ' + cGet.error : ''})`);
  console.log('       stderr excerpt:', (pre.log.stderr.split('\n').find((l) => /Error/.test(l)) || '').trim());

  await stopServer(pre);
}

// ═════ PHASE 1 — hardened module, read gate OFF (default) ═══════════════════

console.log(`\nPHASE 1 — hardened server on :${PORT}, LOG_TOKEN unset (default open)`);

const srv = await startOwnedServer(REAL_MOD, { LOG_DIR, LOG_TOKEN: '', LOG_CORS_ORIGINS: '' }, 'hardened');
ok(srv !== null, `hardened server is listening on :${PORT} and identified as our own child`);
if (!srv) {
  console.error('  !! Nothing below could be trusted against a stale listener. Aborting.');
  summarize();
  process.exit(1);
}

// ── 1a. Stored XSS is escaped ────────────────────────────────────────────────

ok((await post(xssBatch)).status === 204, 'POST /log with XSS payload accepted (204)');
const h = await get('/logs?session=xss-room');
ok(h.status === 200, `GET /logs returns 200 (got ${h.status})`);
ok(h.text.includes(XSS_IMG) === false,
   'XSS: raw "<img src=x onerror=alert(1)>" is ABSENT from the HTML');
ok(h.text.includes('&lt;img src=x onerror=alert(1)&gt;') === true,
   'XSS: the nick appears ESCAPED (&lt;img …&gt;)');
ok(h.text.includes(XSS_SCRIPT) === false,
   'XSS: raw "<script>alert(2)</script>" msg is ABSENT');
ok(h.text.includes('&lt;script&gt;alert(2)&lt;/script&gt;') === true,
   'XSS: the msg appears ESCAPED');
ok(/<script/i.test(h.text) === false, 'XSS: no <script tag anywhere in the viewer output');
ok(/<[^>]*onerror/i.test(h.text) === false,
   'XSS: "onerror" never appears inside a real tag (only as escaped text)');
ok(h.text.includes('&lt;b&gt;lvl&lt;/b&gt;') === false && h.text.includes('<b>lvl</b>') === false,
   'XSS: hostile level is neutralised (neither raw nor smuggled through)');
ok(h.text.includes('&quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt;'),
   'XSS: quotes and ampersands escaped for attribute contexts too');

// Session id in <option value=…>, <title> and the echoed filter inputs.
await post({ sessionId: `s"><script>alert(3)</script>`, clientId: 'c', nick: 'n', entries: [{ level: 'log', ts: Date.now(), msg: 'hi' }] });
const hAll = await get('/logs');
ok(hAll.status === 200, `GET /logs (no session filter) returns 200 (got ${hAll.status})`);
ok(hAll.text.includes('"><script>') === false, 'XSS: hostile session id cannot break out of <option value="…">');
const hEcho = await get(`/logs?session=xss-room&since=${encodeURIComponent('"><script>alert(4)</script>')}&tail=${encodeURIComponent('"><b>x')}`);
ok(hEcho.status === 200, `GET /logs with hostile since/tail returns 200 (got ${hEcho.status})`);
ok(hEcho.text.includes('"><script>') === false && hEcho.text.includes('"><b>') === false,
   'XSS: hostile since/tail query values cannot break out of the echoed <input value="…">');

// ── 1a2. The level colour is NOT an unescaped interpolation ──────────────────
// PHASE 0 measured the pre-fix leak; this is the same probe against the fix.
//
// Measured falsifiability (copy the module, revert one thing, LOG_MOD=<copy>):
//   levelColor back to an object literal  → these 3 assertions go RED.
//   esc(col) removed, null-proto kept     → still green, because after the
//     null-prototype lookup `col` is provably one of six literals. The esc() is
//     defence-in-depth for a future edit, NOT something this suite can prove.

const proto1 = await probeLevelPrototype();
ok(proto1.leaked === false,
   'level colour: "constructor"/"toString"/"valueOf"/"__proto__" levels no longer reach Object.prototype');
ok(proto1.defaultedRows === PROTO_LEVELS.length,
   `level colour: all ${PROTO_LEVELS.length} prototype-named levels fell back to color:#ccc (got ${proto1.defaultedRows})`);
const levelCols = [...proto1.html.matchAll(/<td style="color:([^";]*);text-transform/g)].map((m) => m[1]);
ok(levelCols.length === PROTO_LEVELS.length && levelCols.every((c) => /^#[0-9a-f]{3,6}$/i.test(c)),
   `level colour: every level cell's colour is a literal hex value (got ${JSON.stringify(levelCols)})`);
ok(proto1.html.includes('__proto__') && proto1.html.includes('constructor'),
   'level colour: the level TEXT is still shown (escaped) — the fix drops the colour, not the row');

// ── 1b. Malformed input → 4xx, and the process stays up ──────────────────────

const crash1 = await post(CRASH_BATCH);
ok(crash1.status === 204, `historical crash payload (entry with no msg) accepted (got ${crash1.status})`);
const crash2 = await post(CRASH_BATCH_2);
ok(crash2.status === 204, `empty-entry payload {} accepted (got ${crash2.status})`);
const crash3 = await post(CRASH_BATCH_3);
ok(crash3.status === 204, `out-of-range ts payload accepted (got ${crash3.status})`);
const crashView = await get('/logs?session=boom');
ok(crashView.status === 200, `viewer GET on the crash session returns 200 instead of dying (got ${crashView.status})`);
ok(srv.log.exited === false, 'process still ALIVE after the payload that killed the pre-fix server');

const bad = [
  ['non-JSON body',            await post(null, { rawBody: 'this is { not json' }),           400],
  ['JSON array body',          await post([1, 2, 3]),                                          400],
  ['JSON scalar body',         await post(null, { rawBody: '"just a string"' }),               400],
  ['missing sessionId',        await post({ entries: [] }),                                    400],
  ['object sessionId',         await post({ sessionId: { a: 1 }, entries: [] }),               400],
  ['entries not an array',     await post({ sessionId: 'x', entries: { a: 1 } }),              400],
  ['entry is a string',        await post({ sessionId: 'x', entries: ['boom'] }),              400],
  ['entry is null',            await post({ sessionId: 'x', entries: [null] }),                400],
  ['entry is an array',        await post({ sessionId: 'x', entries: [[1, 2]] }),              400],
  ['too many entries',         await post({ sessionId: 'x', entries: Array.from({ length: 1001 }, () => ({ level: 'log', ts: 1, msg: 'm' })) }), 413],
  ['oversized body (1 MB)',    await post(null, { rawBody: JSON.stringify({ sessionId: 'x', entries: [{ level: 'log', ts: 1, msg: 'A'.repeat(1024 * 1024) }] }) }), 413],
];
for (const [label, res, want] of bad) {
  ok(res.status === want, `malformed POST (${label}) → ${want} (got ${res.status}${res.error ? ' / ' + res.error : ''})`);
}
ok(srv.log.exited === false, 'process still ALIVE after every malformed POST');
const stillServing = await get('/logs.json?session=xss-room');
ok(stillServing.status === 200, `server still SERVING after the malformed batch (GET /logs.json ${stillServing.status})`);
ok(JSON.parse(stillServing.text).entries.length === 2, 'earlier entries still readable after the malformed batch');

// ── 1c. Field caps ───────────────────────────────────────────────────────────

// Two POSTs, both deliberately UNDER the 128 KB body cap, so what is measured
// here is the per-field caps and not the body cap tested above.
const capsPost = await post({
  sessionId: 'caps', clientId: 'C'.repeat(500), nick: 'N'.repeat(500),
  entries: [{ level: 'L'.repeat(200), ts: Date.now(), msg: 'M'.repeat(64 * 1024) }],
});
ok(capsPost.status === 204, `caps POST accepted (got ${capsPost.status})`);
const fieldsPost = await post({
  sessionId: 'caps', clientId: 'c', nick: 'n',
  entries: [{
    level: 'log', ts: Date.now(), msg: 'fields',
    ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, 'v'.repeat(2000)])),
  }],
});
ok(fieldsPost.status === 204, `extra-fields POST accepted (got ${fieldsPost.status})`);

const caps = JSON.parse((await get('/logs.json?session=caps')).text);
const capEntry   = caps.entries?.[0] || {};
const fieldEntry = caps.entries?.[1] || {};
ok((capEntry.msg || '').length <= 8 * 1024 + 16, `msg capped at ~8 KB (got ${(capEntry.msg || '').length} chars)`);
ok((capEntry.level || '').length <= 12, `level capped at 12 (got ${(capEntry.level || '').length})`);
ok((capEntry.clientId || '').length <= 64, `clientId capped at 64 (got ${(capEntry.clientId || '').length})`);
ok((capEntry.nick || '').length <= 64, `nick capped at 64 (got ${(capEntry.nick || '').length})`);
const extraKeys = Object.keys(fieldEntry).filter((k) => /^f\d+$/.test(k));
ok(extraKeys.length <= 24, `structured extra fields capped at 24 (got ${extraKeys.length})`);
ok((fieldEntry[extraKeys[0]] || '').length <= 1024,
   `extra field value capped at 1 KB (got ${(fieldEntry[extraKeys[0]] || '').length})`);

// ── 1c2. Nested structured extras keep their SHAPE, but bounded ──────────────
// PHASE 0 shows the pre-fix server stored these raw. The round-1 hardening
// stringified every container instead — `peers` came back as the STRING
// '["a","b"]' — which silently changed the /logs.json contract. These
// assertions fail against that behaviour and against an uncapped one.

const nest1 = await probeNestedExtras();
ok(Array.isArray(nest1.peers) && nest1.peers.join(',') === 'a,b',
   `extras: peers:['a','b'] reads back as a REAL ARRAY (got ${JSON.stringify(nest1.peers)})`);
ok(nest1.shallow && typeof nest1.shallow === 'object' && nest1.shallow.room === 'lobby' && nest1.shallow.n === 2,
   `extras: a nested object keeps its keys and value types (got ${JSON.stringify(nest1.shallow)})`);
ok(typeof nest1.deep?.l1?.l2?.l3 === 'string',
   `extras: nesting past MAX_EXTRA_DEPTH=3 degrades to a string stand-in (got ${typeof nest1.deep?.l1?.l2?.l3})`);
ok(Array.isArray(nest1.wide) && nest1.wide.length === 32,
   `extras: a 100-element array is truncated to MAX_EXTRA_ITEMS=32 (got ${nest1.wide?.length})`);
ok(nest1.event === 'net', 'extras: flat scalar fields are untouched');

// A container that is legal but huge must not be stored whole.
await post({ sessionId: 'nest', clientId: 'c', nick: 'n', entries: [{
  level: 'event', ts: Date.now(), msg: 'huge',
  big: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, 'x'.repeat(1000)])),
}] });
const nestBig = JSON.parse((await get('/logs.json?session=nest')).text).entries.at(-1);
ok(typeof nestBig.big === 'string' && nestBig.big.length <= 1024,
   `extras: a 32 KB container degrades to one ≤1 KB string (got ${typeof nestBig.big}, ${nestBig.big?.length} chars)`);

// A literal `__proto__` extra key is dropped rather than stored. Checked on the
// raw response text, because a `__proto__` own-property is invisible to a
// parsed-object check — PHASE 0 shows the pre-fix server DID emit it.
//
// Scope, measured: what this catches is sanitizeEntry() REBUILDING the record
// instead of spreading the POSTed entry (pre-fix spread it, and the key came
// straight back out). Removing just the `if (key === '__proto__') continue;`
// line leaves this green — that assignment swaps the record's prototype, which
// JSON.stringify never serialises, so it has no reachable effect through the
// HTTP API. The guard stays because it is one cheap line, not because a test
// here proves it.
const pk1 = await probeProtoKey();
ok(pk1.raw.includes('__proto__') === false,
   'extras: a literal "__proto__" extra key never reaches the stored record');
ok(pk1.entry.ok === 1 && pk1.entry.msg === 'proto-key',
   'extras: the rest of that entry is stored normally');

// ── 1d. Hostile session ids ──────────────────────────────────────────────────
// HONESTY: the pre-fix server already neutralised these (PHASE 0 measured it),
// so the "nothing escaped" checks below are regression guards on a property
// that already held — NOT evidence of a hole that was closed. They fail if
// safeSessionId() is ever loosened. The genuine fix is the device-name prefix.

await probeHostileSessionIds();

const insideLogs = walk(LOG_DIR).map((p) => p.slice(LOG_DIR.length + 1));
const anywhere   = walk(TMP);
const escaped    = anywhere.filter((p) => !p.startsWith(LOG_DIR + sep));
ok(escaped.length === 0,
   `guard (also true pre-fix): no file landed outside ${LOG_DIR} (found ${escaped.length}${escaped.length ? ': ' + escaped.join(', ') : ''})`);
ok(insideLogs.length > 0 && insideLogs.every((n) => /^[A-Za-z0-9._-]+\.log$/.test(n) && !n.includes('..')),
   `guard (also true pre-fix): all ${insideLogs.length} filenames are in the safe alphabet with no ".." — ${insideLogs.join(' ')}`);
ok(WIN_DEVICES.every((d) => insideLogs.includes(`_${d}.log`) && !insideLogs.includes(`${d}.log`)),
   `REAL FIX: Windows device names are prefixed (${WIN_DEVICES.map((d) => `_${d}.log`).join(' ')} present, ${WIN_DEVICES.map((d) => `${d}.log`).join('/')} absent)`);

// Negative control for the escape detector itself: plant a file outside the log
// dir and confirm the same check reports it. Without this, "0 escaped files"
// could just mean the detector never looks anywhere.
writeFileSync(join(TMP, 'planted.log'), 'planted');
const escapedAfterPlant = walk(TMP).filter((p) => !p.startsWith(LOG_DIR + sep));
ok(escapedAfterPlant.length === 1,
   `negative control: the escape detector DOES fire on a planted outside file (found ${escapedAfterPlant.length})`);
rmSync(join(TMP, 'planted.log'));

// ── 1e. Open-file-handle cap (MAX_OPEN_FILES = 32) ───────────────────────────
// Pre-fix, one invented session id per request opened a write stream that was
// only ever closed when the whole server closed. 40 sessions here forces the
// LRU eviction path; the re-post then proves an evicted stream reopens in
// APPEND mode instead of truncating the session's history.

for (let i = 0; i < 40; i++) {
  await post({ sessionId: `lru-${String(i).padStart(2, '0')}`, clientId: 'c', nick: 'n',
               entries: [{ level: 'log', ts: Date.now(), msg: `first line ${i}` }] });
}
await sleep(300);
ok(srv.log.exited === false, 'file-handle cap: process alive after 40 distinct sessions (cap is 32 handles)');
const lruFiles = walk(LOG_DIR).map((p) => p.slice(LOG_DIR.length + 1)).filter((n) => n.startsWith('lru-'));
ok(lruFiles.length === 40, `file-handle cap: all 40 session files written (got ${lruFiles.length})`);
await post({ sessionId: 'lru-00', clientId: 'c', nick: 'n',
             entries: [{ level: 'log', ts: Date.now(), msg: 'second line after eviction' }] });
await sleep(300);
const lru0 = readFileSync(join(LOG_DIR, 'lru-00.log'), 'utf8').trim().split('\n');
ok(lru0.length === 2, `file-handle cap: evicted stream reopened in APPEND mode (got ${lru0.length} lines, want 2)`);
ok(lru0[0].includes('first line 0') && lru0[1].includes('second line after eviction'),
   'file-handle cap: both the pre-eviction and post-eviction lines survive');

// ── 1f. Read gate is OFF by default (the headset workflow must keep working) ──

ok((await get('/logs?session=xss-room')).status === 200, 'LOG_TOKEN unset: GET /logs is open (200)');
ok((await get('/logs.json?session=xss-room')).status === 200, 'LOG_TOKEN unset: GET /logs.json is open (200)');

// ── 1g. CORS: reads are same-origin by default, ingest stays open ────────────
// PHASE 0 measured `Access-Control-Allow-Origin: *` on reads pre-fix. These
// fail if that blanket header comes back.

const corsRead = await get('/logs.json?session=xss-room', { Origin: 'https://evil.example' });
ok(corsRead.status === 200,
   `CORS: GET /logs.json still SERVES the request (${corsRead.status}) — same-origin readers are unaffected`);
ok(corsRead.acao === null,
   `CORS: no Access-Control-Allow-Origin on /logs.json for an unlisted origin (got ${corsRead.acao}) — a hostile page cannot read the response`);
ok((corsRead.vary || '').includes('Origin'), `CORS: reads send Vary: Origin (got ${corsRead.vary})`);
const corsHtml = await get('/logs?session=xss-room', { Origin: 'https://evil.example' });
ok(corsHtml.status === 200 && corsHtml.acao === null,
   `CORS: /logs viewer likewise (${corsHtml.status}, ACAO ${corsHtml.acao})`);
const corsPost = await post({ sessionId: 'cors', clientId: 'c', nick: 'n', entries: [{ level: 'log', ts: Date.now(), msg: 'x' }] },
                            { headers: { Origin: 'http://localhost:5173' } });
ok(corsPost.status === 204 && corsPost.acao === '*',
   `CORS: POST /log KEEPS Access-Control-Allow-Origin: * (${corsPost.status}, ACAO ${corsPost.acao}) — ?log=<url> from localhost:5173 must keep working`);
const preflight = await (async () => {
  try {
    const r = await fetch(`${BASE}/log`, { method: 'OPTIONS', headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    } });
    return { status: r.status, acao: r.headers.get('access-control-allow-origin'), ach: r.headers.get('access-control-allow-headers') };
  } catch (e) { return { status: 0, acao: null, ach: null, error: String(e) }; }
})();
ok(preflight.status === 204 && preflight.acao === '*' && /Content-Type/i.test(preflight.ach || ''),
   `CORS: the JSON POST preflight still passes (OPTIONS ${preflight.status}, ACAO ${preflight.acao}, allow-headers "${preflight.ach}")`);

// ── 1h. Connection cap (server.maxConnections = 64) is a REAL refusal path ───
// PHASE 0 served all 70 sockets; the hardened server must refuse past the cap
// and must recover once they close. This is the assertion for "an untested
// refusal path behind Apache's keep-alive proxy pool": it is real, it is
// bounded, and it self-heals.

// MEASUREMENT TIGHTENED (round 3), not tolerance-widened: the old window was
// `served >= MAX_CONN - 12`, twelve sockets of slack to absorb however many
// keep-alive connections this process's earlier fetch()es happened to be
// parking on the server — the one assertion here likely to flake on a loaded
// box. quiesceConnections() removes the cause instead of tolerating it, so the
// expected value is now exactly the cap. The ±1 that remains covers a single
// socket still in teardown when the count is taken; it is NOT slack for load.
const CAP_TOLERANCE = 1;
await quiesceConnections();
const cap = await probeConnectionCap(MAX_CONN + 6);
ok(cap.refused > 0,
   `connection cap: ${MAX_CONN + 6} concurrent sockets → ${cap.refused} REFUSED, ${cap.served} served (pre-fix refused 0)`);
ok(cap.served <= MAX_CONN && cap.served >= MAX_CONN - CAP_TOLERANCE,
   `connection cap: served count sits AT the cap (served=${cap.served}, cap=${MAX_CONN}, read out of ${REAL_MOD}, tolerance ±${CAP_TOLERANCE})`);
ok(cap.served + cap.refused === MAX_CONN + 6,
   `connection cap: every socket is accounted for (${cap.served} served + ${cap.refused} refused = ${MAX_CONN + 6})`);
ok(srv.log.exited === false, 'connection cap: server survived being saturated');
cap.close();
await sleep(1000);   // as in PHASE 0: don't hand the next phase a pile of TIME_WAIT
const afterCap = await get('/logs.json?session=xss-room');
ok(afterCap.status === 200,
   `connection cap: service RESUMES once the held sockets close (got ${afterCap.status}${afterCap.error ? ' / ' + afterCap.error : ''})`);

// ── 1i. Existing behaviour still intact (smoke-log.mjs contract) ─────────────

await post({
  sessionId: 'smoke-shape', clientId: 'smoke-client-001', nick: 'SmokeBot',
  entries: [
    { level: 'info',  ts: Date.now(),     msg: '[Logger] remote logging active' },
    { level: 'event', ts: Date.now() + 1, msg: '[boot]', event: 'boot', core: 'nestopia', file: 'game.nes' },
  ],
});
const shape = JSON.parse((await get('/logs.json?session=smoke-shape')).text);
ok(shape.entries.length === 2, `compat: 2 entries stored (got ${shape.entries.length})`);
ok(shape.entries[0].nick === 'SmokeBot', 'compat: nick preserved');
ok(shape.entries[0].clientId === 'smoke-client-001', 'compat: clientId preserved');
ok(shape.entries[1].event === 'boot' && shape.entries[1].core === 'nestopia', 'compat: flat event fields preserved');
ok(shape.sessions.includes('smoke-shape'), 'compat: session listed in sessions array');
const compatHtml = await get('/logs?session=smoke-shape');
ok(compatHtml.text.includes('<table>') && compatHtml.text.includes('SmokeBot') && compatHtml.text.includes('[boot]'),
   'compat: HTML viewer still renders table, nick and message');
ok((await get('/nope')).status === 404, 'compat: unknown path still 404');

await stopServer(srv);

// ═════ PHASE 2 — read gate ON + a CORS allowlist ════════════════════════════

console.log(`\nPHASE 2 — hardened server on :${PORT}, LOG_TOKEN=s3cret, LOG_CORS_ORIGINS=https://ok.example`);

const gated = await startOwnedServer(REAL_MOD, {
  LOG_DIR: join(TMP, 'logs2'), LOG_TOKEN: 's3cret', LOG_CORS_ORIGINS: 'https://ok.example',
}, 'gated');
ok(gated !== null, `gated server is listening on :${PORT} and identified as our own child`);
if (!gated) {
  console.error('  !! Aborting rather than testing the read gate against a stale listener.');
  summarize();
  process.exit(1);
}

ok((await post({ sessionId: 'gated', clientId: 'c', nick: 'n', entries: [{ level: 'log', ts: Date.now(), msg: 'ingest is never gated' }] })).status === 204,
   'LOG_TOKEN set: POST /log is still open (the Quest carries no secret)');
ok((await get('/logs?session=gated')).status === 401,      'LOG_TOKEN set: GET /logs without a token → 401');
ok((await get('/logs.json?session=gated')).status === 401, 'LOG_TOKEN set: GET /logs.json without a token → 401');
ok((await get('/logs?session=gated&token=wrong')).status === 401, 'LOG_TOKEN set: wrong token → 401');
ok((await get('/logs?session=gated&token=s3cret')).status === 200, 'LOG_TOKEN set: correct ?token= → 200');
ok((await get('/logs?session=gated', { 'X-Log-Token': 's3cret' })).status === 200, 'LOG_TOKEN set: X-Log-Token header → 200');
ok((await get('/logs.json?session=gated', { Authorization: 'Bearer s3cret' })).status === 200, 'LOG_TOKEN set: Authorization: Bearer → 200');
const gatedHtml = await get('/logs?session=gated&token=s3cret');
ok(gatedHtml.text.includes('<input type="hidden" name="token" value="s3cret">'),
   'LOG_TOKEN set: viewer carries the token through the filter form');
ok(gatedHtml.text.includes('<meta http-equiv="refresh" content="5">'),
   'LOG_TOKEN set: meta-refresh re-requests the current URL (token + "newest session" behaviour preserved)');

const allowed = await get('/logs.json?session=gated&token=s3cret', { Origin: 'https://ok.example' });
ok(allowed.acao === 'https://ok.example',
   `LOG_CORS_ORIGINS: an allowlisted origin gets its own ACAO back (got ${allowed.acao})`);
const denied = await get('/logs.json?session=gated&token=s3cret', { Origin: 'https://ok.example.evil.test' });
ok(denied.acao === null,
   `LOG_CORS_ORIGINS: a look-alike origin gets NO ACAO (got ${denied.acao}) — exact match, not prefix`);
ok(denied.status === 200, `LOG_CORS_ORIGINS: the allowlist changes headers only, not status (got ${denied.status})`);

await stopServer(gated);

// ─── Summary ─────────────────────────────────────────────────────────────────

try { rmSync(TMP, { recursive: true, force: true }); rmSync(PRE_TMP, { recursive: true, force: true }); } catch { /* best effort */ }

summarize();
process.exitCode = failed ? 1 : 0;
