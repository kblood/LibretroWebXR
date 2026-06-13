// Smoke test for the remote log server (server/log-server.mjs).
//
// Starts the log server in-process on a dedicated test port, POSTs a sample
// batch to POST /log, then GETs /logs.json to confirm the entries appear, and
// GETs /logs to verify the HTML viewer renders.
//
//   node scripts/smoke-log.mjs           (exit 0 = pass, 1 = fail)
//   npm run smoke-log

const LOG_PORT = 8798; // isolated test port; won't clash with production 8788
process.env.LOG_PORT = String(LOG_PORT);

// Importing log-server.mjs starts the HTTP server as a side-effect.
// We grab the server handle so we can close it cleanly before exit (avoids a
// Windows libuv assertion when process.exit() fires with an open TCP server).
const { logServer } = await import('../server/log-server.mjs');

// Give the server a tick to bind before sending requests.
await new Promise((r) => setTimeout(r, 100));

// ─── Test helpers ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++;  console.log(`  OK   ${msg}`); }
  else       { failed++; console.error(`  FAIL ${msg}`); }
};

const BASE = `http://127.0.0.1:${LOG_PORT}`;

async function post(path, payload) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, text: await res.text() };
}

async function get(path) {
  const res = await fetch(BASE + path);
  return { status: res.status, text: await res.text() };
}

// ─── 1. POST a structured batch ───────────────────────────────────────────────

const now = Date.now();
const batch = {
  sessionId: 'smoke-test-room',
  clientId:  'smoke-client-001',
  nick:      'SmokeBot',
  entries: [
    { level: 'info',  ts: now,      msg: '[Logger] remote logging active → http://localhost:8788' },
    { level: 'event', ts: now + 1,  msg: '[boot]', event: 'boot', core: 'nestopia', file: 'game.nes' },
    { level: 'warn',  ts: now + 2,  msg: 'controllers not found (expected in headless smoke)' },
    { level: 'error', ts: now + 3,  msg: 'Uncaught: simulated error for smoke verification' },
  ],
};

const postRes = await post('/log', batch);
ok(postRes.status === 204,
  `POST /log returns 204 (got ${postRes.status})`);

// ─── 2. GET /logs.json — verify entries stored ────────────────────────────────

const jsonRes = await get('/logs.json?session=smoke-test-room');
ok(jsonRes.status === 200,
  `GET /logs.json returns 200 (got ${jsonRes.status})`);

let parsed = null;
try { parsed = JSON.parse(jsonRes.text); } catch { /* handled below */ }

ok(parsed !== null,
  'GET /logs.json: valid JSON body');
ok(Array.isArray(parsed?.entries),
  'GET /logs.json: entries is array');
ok(parsed?.entries?.length === 4,
  `GET /logs.json: 4 entries stored (got ${parsed?.entries?.length})`);
ok(parsed?.entries?.[0]?.nick === 'SmokeBot',
  'GET /logs.json: nick preserved in entries');
ok(parsed?.entries?.[0]?.clientId === 'smoke-client-001',
  'GET /logs.json: clientId preserved');
ok(parsed?.entries?.[1]?.event === 'boot',
  'GET /logs.json: structured event field preserved');
ok(parsed?.sessions?.includes('smoke-test-room'),
  'GET /logs.json: session listed in sessions array');

// ─── 3. GET /logs — HTML viewer ───────────────────────────────────────────────

const htmlRes = await get('/logs?session=smoke-test-room');
ok(htmlRes.status === 200,
  `GET /logs returns 200 (got ${htmlRes.status})`);
ok(htmlRes.text.includes('<table>'),
  'GET /logs: HTML viewer contains a table');
ok(htmlRes.text.includes('SmokeBot'),
  'GET /logs: nick appears in HTML viewer');
ok(htmlRes.text.includes('[boot]'),
  'GET /logs: boot event msg appears in viewer');
ok(htmlRes.text.includes('controllers not found'),
  'GET /logs: warn msg appears in viewer');
ok(htmlRes.text.includes('smoke-test-room'),
  'GET /logs: session name appears in viewer');

// ─── 4. Bad JSON → 400 ───────────────────────────────────────────────────────

const badRes = await fetch(BASE + '/log', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: 'this is { not json',
});
ok(badRes.status === 400,
  `POST /log with malformed JSON returns 400 (got ${badRes.status})`);

// ─── 5. GET unknown path → 404 ────────────────────────────────────────────────

const notFound = await get('/nope');
ok(notFound.status === 404,
  `GET /nope returns 404 (got ${notFound.status})`);

// ─── 6. Second session — /logs.json with no filter returns all sessions ───────

const batch2 = {
  sessionId: 'other-session',
  clientId:  'other-client',
  nick:      'Alice',
  entries: [
    { level: 'log', ts: Date.now(), msg: 'from other session' },
  ],
};
await post('/log', batch2);

const allJsonRes = await get('/logs.json');
const all = JSON.parse(allJsonRes.text);
ok(all.sessions.length >= 2,
  `GET /logs.json (no filter): at least 2 sessions listed (got ${all.sessions.length})`);

// ─── Print summary ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1; // signal failure without an immediate exit call

// Close the server so Node's event loop drains naturally and the process exits.
// (Calling process.exit() directly with open undici/fetch handles causes a
// Windows libuv assertion on Node 24 — let the loop drain instead.)
logServer.close();
