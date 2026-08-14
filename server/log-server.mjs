// log-server: HTTP companion to room-server.mjs.
//
// Mounts an in-process HTTP server (port LOG_PORT, default 8788) alongside the
// WebSocket room server so the browser's remote logger can POST batches without
// going through a WebSocket connection.
//
// API
//   POST /log   body: JSON { sessionId, clientId, nick, entries: [{level,ts,msg,...}] }
//               → 204 on success, 400 on parse/validation error, 413 if body too large
//
//   GET  /logs  ?session=<id>&since=<epoch-ms>&tail=<n>
//               → HTML viewer showing stored log lines (developer's reading pane)
//
//   GET  /logs.json  same params but → raw JSON
//
// Storage
//   In-memory ring buffer per session (SESSION_RING_MAX entries). Optionally
//   appends to `server/logs/<sessionId>.log` when LOG_DIR env var is set or
//   the `server/logs/` directory already exists.  Log files use one JSON entry
//   per line (NDJSON) so they can be tail-followed.
//
// Apache proxy snippet: see deploy/log-proxy.conf.
//
// Invoked from room-server.mjs:
//   import './log-server.mjs';    // mounts on LOG_PORT automatically
//
// ─── Hardening notes (2026-08, closes CLAUDE_REVIEW §4.1/§4.2/§4.3, CODEX SEC-2)
//
// This module is reverse-proxied to the public internet (deploy/log-proxy.conf)
// and lives in the SAME PROCESS as the room server, so anything that throws out
// of a handler here takes multiplayer down with it. Three rules hold:
//
//   1. Nothing reaches the viewer HTML unescaped. Every interpolation that
//      lands in the response is either esc()'d — attribute values included —
//      or a fragment assembled entirely from esc()'d parts and literals
//      (`tokenField`, `sessionOptions`, `rowsHtml`, and the constant
//      ` selected`). The only interpolations NOT wrapped in esc() are the two
//      inside `client` (`e.nick`, `e.clientId`), and that whole string is
//      esc()'d on the way out — so no attacker-controlled value ever reaches
//      the HTML raw. The level colour is esc()'d too AND looked up on a
//      null-prototype table, so a level of "constructor"/"toString"/
//      "__proto__" cannot reach Object.prototype and end up inside a style
//      attribute. Only add markup through esc(), or through a fragment whose
//      every variable part already went through esc().
//   2. Nothing reaches the store unvalidated. `sanitizeEntry()` coerces and caps
//      every field on ingest, so the renderer can never meet a surprise type.
//   3. No handler may throw. Both handlers run inside try/catch and answer
//      400/500 instead of killing the process.
//
// What ingest does to structured event fields (`logger.event(name, extra)`)
//   Scalars (string/number/boolean/null) are kept as scalars, capped.
//   Arrays and plain objects are KEPT AS ARRAYS AND OBJECTS in /logs.json, but
//   pruned: at most MAX_EXTRA_DEPTH levels of nesting and MAX_EXTRA_ITEMS
//   entries per level, each string capped at MAX_EXTRA_VALUE, and if the whole
//   value still serialises to more than MAX_EXTRA_BYTES it degrades to a single
//   truncated string. Anything past the depth cap, and anything not
//   JSON-shaped (functions, symbols, bigints, cyclic values), becomes a short
//   string stand-in. So `logger.event('net', { peers:['a','b'] })` reads back as
//   a real array — but `peers` 8 levels deep reads back as a string.
//
// Environment variables
//   LOG_PORT   port to listen on                     (default 8788)
//   LOG_DIR    directory for NDJSON log files        (default server/logs)
//   LOG_TOKEN  OPTIONAL read gate for GET /logs and GET /logs.json.
//              DEFAULT: UNSET = wide open — the headset workflow
//              (dionysus.dk/logs?session=<room>) keeps working untouched.
//              When set, reads must present the token as `?token=<v>`, an
//              `X-Log-Token: <v>` header, or `Authorization: Bearer <v>`;
//              anything else gets 401. POST /log is NEVER gated (the Quest
//              has no way to carry a secret).
//   LOG_CORS_ORIGINS
//              Comma-separated CORS allowlist for the READ endpoints
//              (GET /logs, GET /logs.json).  DEFAULT: EMPTY = no
//              Access-Control-Allow-Origin on reads at all, i.e. same-origin
//              only.  That is exactly what the headset workflow needs: the
//              developer opens https://dionysus.dk/logs?session=<room> as a
//              top-level navigation, which CORS does not touch.  What it stops
//              is any random page on the internet fetch()ing /logs.json from
//              the visitor's browser and reading every session, which the old
//              blanket `Access-Control-Allow-Origin: *` allowed whenever
//              LOG_TOKEN was unset (the mandated default).
//              Set to a list (`https://a.example,https://b.example`) to allow
//              those origins, or to `*` to restore the old wide-open reads.
//              POST /log keeps `*` deliberately — see applyCors().

import { createServer }       from 'node:http';
import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { join, dirname }      from 'node:path';
import { fileURLToPath }      from 'node:url';
import { timingSafeEqual }    from 'node:crypto';

const __dir      = dirname(fileURLToPath(import.meta.url));
const LOG_PORT   = parseInt(process.env.LOG_PORT   || '8788', 10);
const LOG_TOKEN  = (process.env.LOG_TOKEN || '').trim();   // '' = read gate OFF

// CORS allowlist for the READ endpoints. '' (default) = send no
// Access-Control-Allow-Origin at all → same-origin reads only.
const CORS_READ_ORIGINS = (process.env.LOG_CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const CORS_READ_ANY = CORS_READ_ORIGINS.includes('*');

// ─── Resource limits ──────────────────────────────────────────────────────────
// Every one of these is a cap an unauthenticated remote client would otherwise
// control. Numbers are generous for the real logger (40 entries per 800 ms
// batch, ~200-char messages) and tiny for an attacker.

const MAX_BODY          = 128 * 1024;   // bytes per POST
const SESSION_RING_MAX  = 5000;         // entries kept in memory per session
const MAX_SESSIONS      = 100;          // distinct sessions held in memory
const MAX_ENTRIES_BATCH = 1000;         // entries accepted in one POST
const MAX_MSG_CHARS     = 8 * 1024;     // per-entry message, truncated past this
const MAX_ID_CHARS      = 64;           // sessionId / clientId / nick
const MAX_LEVEL_CHARS   = 12;
const MAX_EXTRA_FIELDS  = 24;           // structured event fields kept per entry
const MAX_EXTRA_KEY     = 64;
const MAX_EXTRA_VALUE   = 1024;         // chars per extra STRING
const MAX_EXTRA_DEPTH   = 3;            // nesting levels kept in an extra
const MAX_EXTRA_ITEMS   = 32;           // array elements / object keys per level
const MAX_EXTRA_BYTES   = 4096;         // serialised size of ONE extra value
const MAX_OPEN_FILES    = 32;           // concurrently open NDJSON write streams
const MAX_FILE_BYTES    = 32 * 1024 * 1024; // per-session file cap, then refuse
// Concurrent sockets on the log port. Beyond this, Node destroys the accepted
// socket — so this IS a refusal path, and scripts/test-log-server.mjs asserts
// both halves of it (the 65th connection is dropped; service resumes once the
// held sockets close). 64 is safe behind deploy/log-proxy.conf because that is
// a plain ProxyPass with no `keepalive=On`, so Apache opens one short-lived
// backend connection per request rather than parking a pool on us: reaching 64
// needs 64 log requests genuinely in flight at the same instant, where the real
// load is a handful of headsets POSTing an ~8 KB batch every 800 ms.
const MAX_CONNECTIONS   = 64;
const REQUEST_TIMEOUT   = 30_000;       // ms — drop slow/stalled requests
const HEADERS_TIMEOUT   = 10_000;       // ms — slowloris guard
// ms an IDLE keep-alive connection is held before the server closes it. This is
// Node's own default, stated explicitly because it is now load-bearing: an idle
// keep-alive socket still counts against MAX_CONNECTIONS, and
// scripts/test-log-server.mjs reads this number out of this file to know how
// long to wait for its own earlier requests to stop occupying slots before it
// measures the cap. Change it and that wait follows automatically.
const KEEPALIVE_TIMEOUT = 5_000;

// ─── Escaping ─────────────────────────────────────────────────────────────────

/**
 * HTML-escape a value for BOTH text and quoted-attribute contexts.
 *
 * Everything interpolated into the viewer goes through this — log messages,
 * levels, nicks, client ids, session ids in <option value=…> and in the
 * <title>, and the echoed query parameters. A POSTed log line is attacker
 * controlled; before this existed one could store `<img onerror=…>` and have it
 * execute in the developer's browser on the app's own origin.
 *
 * @param {*} v
 * @returns {string}
 */
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Input sanitising ─────────────────────────────────────────────────────────

// Windows reserves these basenames on EVERY directory; opening `logs/CON.log`
// talks to a device, not a file.
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Canonicalise a session id into something that is safe as BOTH a Map key and a
 * filename component. Applied identically on ingest and on read, so the viewer
 * and the store always agree on the key.
 *
 * Neutralises (never merely rejects — a headset session must keep logging):
 *   - path traversal: `..`, `/`, `\`, drive letters, absolute paths
 *   - NUL and every other control character
 *   - Windows reserved device names (CON, NUL, COM1, …) via a `_` prefix
 *   - trailing dots/spaces (Windows strips them, which un-sanitises the name)
 *   - unbounded length
 *
 * @param {*} raw
 * @returns {string} always a non-empty safe id
 */
function safeSessionId(raw) {
  let s = String(raw ?? '');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');    // control chars incl. NUL
  s = s.replace(/[^A-Za-z0-9._-]/g, '_');         // only this alphabet survives
  s = s.replace(/\.{2,}/g, '_');                  // no `..` anywhere
  s = s.replace(/^[.\s]+|[.\s]+$/g, '');          // no leading/trailing dot/space
  s = s.slice(0, MAX_ID_CHARS);
  if (!s) return 'unknown';
  if (WIN_RESERVED.test(s.split('.')[0])) s = `_${s}`;
  return s;
}

/** Short, control-char-free scalar (nick, clientId, level tokens…). */
function safeScalar(raw, max) {
  // eslint-disable-next-line no-control-regex
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

/**
 * Prune one structured-extra value into something bounded but still SHAPED like
 * what the app sent. `logger.event('net', { peers:['a','b'] })` has to read back
 * out of /logs.json as an array — an earlier hardening pass stringified every
 * container, which silently changed the stored contract.
 *
 * Bounds: MAX_EXTRA_DEPTH levels, MAX_EXTRA_ITEMS per level, MAX_EXTRA_VALUE
 * chars per string. Past the depth cap (and for anything JSON can't represent)
 * the value degrades to a short string stand-in, never to unbounded recursion.
 *
 * @param {*} v
 * @param {number} depth
 */
function safeExtraValue(v, depth) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return safeScalar(v, MAX_EXTRA_VALUE);
  if (typeof v !== 'object')  return safeScalar(String(v), MAX_EXTRA_VALUE);  // function/symbol/bigint

  if (depth >= MAX_EXTRA_DEPTH) {
    let s;
    try { s = JSON.stringify(v); } catch { s = null; }   // cycles land here
    return safeScalar(s ?? '[unserializable]', MAX_EXTRA_VALUE);
  }

  if (Array.isArray(v)) {
    return v.slice(0, MAX_EXTRA_ITEMS).map((x) => safeExtraValue(x, depth + 1));
  }

  // Null-prototype so a `__proto__` key can never re-point the prototype of the
  // object we hand back (`out.__proto__ = {...}` on a `{}` literal would).
  const out = Object.create(null);
  let n = 0;
  for (const [k, val] of Object.entries(v)) {
    if (n >= MAX_EXTRA_ITEMS) break;
    const key = safeScalar(k, MAX_EXTRA_KEY).replace(/[^\w.-]/g, '_');
    if (!key) continue;
    out[key] = safeExtraValue(val, depth + 1);
    n++;
  }
  return out;
}

/**
 * Coerce one POSTed entry into a record the renderer can always handle.
 *
 * Before this, `handleGetHtml` did `e.msg.replace(...)` and
 * `new Date(e.ts).toISOString()` on unvalidated input: a single POST of
 * `{"entries":[{}]}` made the next viewer GET throw a TypeError/RangeError out
 * of the HTTP request listener and kill the shared room-server process.
 *
 * @param {*} e
 * @returns {{level:string, ts:number, msg:string}|null} null if unusable
 */
function sanitizeEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;

  const level = safeScalar(e.level, MAX_LEVEL_CHARS).replace(/[^\w-]/g, '') || 'log';

  const tsRaw = Number(e.ts);
  // Date can only format roughly ±8.64e15 ms; anything else throws RangeError.
  const ts = Number.isFinite(tsRaw) && Math.abs(tsRaw) <= 8.64e15 ? tsRaw : Date.now();

  let msg = typeof e.msg === 'string' ? e.msg : (e.msg === undefined ? '' : String(e.msg));
  // eslint-disable-next-line no-control-regex
  msg = msg.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  if (msg.length > MAX_MSG_CHARS) msg = `${msg.slice(0, MAX_MSG_CHARS)}…[truncated]`;

  const out = { level, ts, msg };

  // Structured event fields (logger.event('boot', { core, file })) are kept —
  // scalars as scalars, containers as containers pruned by safeExtraValue() —
  // but only up to MAX_EXTRA_FIELDS of them, and each one only up to
  // MAX_EXTRA_BYTES serialised. An attacker does not get to spread an arbitrary
  // object into our store; the app does get its arrays back out of /logs.json.
  let extras = 0;
  for (const [k, v] of Object.entries(e)) {
    if (k === 'level' || k === 'ts' || k === 'msg') continue;
    if (k === 'sessionId' || k === 'clientId' || k === 'nick') continue; // set by us
    if (extras >= MAX_EXTRA_FIELDS) break;
    const key = safeScalar(k, MAX_EXTRA_KEY).replace(/[^\w.-]/g, '_');
    if (!key) continue;
    // `out` is an object literal, so out.__proto__ = {...} would swap its
    // prototype instead of storing a field. Never let that key through.
    if (key === '__proto__') continue;

    const val = safeExtraValue(v, 0);
    if (val !== null && typeof val === 'object') {
      // Bound the whole value, not just each leaf: 32 keys × 32 keys × 1 KB
      // strings is still far too much to keep per entry.
      let ser;
      try { ser = JSON.stringify(val); } catch { ser = null; }
      out[key] = (ser === null || ser.length > MAX_EXTRA_BYTES)
        ? safeScalar(ser ?? '[unserializable]', MAX_EXTRA_VALUE)
        : val;
    } else {
      out[key] = val;
    }
    extras++;
  }
  return out;
}

// ─── Optional file persistence ────────────────────────────────────────────────

const logsDir = process.env.LOG_DIR || join(__dir, 'logs');
// Map<safeSessionId -> { ws: WriteStream, bytes: number, refused: boolean }>
// Insertion-ordered, so the first key is the least-recently-opened stream.
let fileStreams = null; // null until ensureFileLogging() decides

function ensureFileLogging() {
  if (fileStreams) return fileStreams;
  try {
    mkdirSync(logsDir, { recursive: true });
    fileStreams = new Map();
  } catch {
    // Can't write to disk — stay in-memory only.
    fileStreams = null;
  }
  return fileStreams;
}

function closeStream(id) {
  if (!fileStreams) return;
  const rec = fileStreams.get(id);
  if (!rec) return;
  try { rec.ws.end(); } catch { /* already closing */ }
  fileStreams.delete(id);
}

/**
 * Get (or lazily open) the NDJSON stream for an ALREADY-SANITISED session id.
 *
 * Two limits live here: at most MAX_OPEN_FILES handles are open at once (the
 * least-recently-opened is closed to make room — a remote client used to be
 * able to open one file descriptor per invented session id and never give it
 * back), and a session file stops accepting writes past MAX_FILE_BYTES.
 *
 * @param {string} safeId  output of safeSessionId()
 */
function fileStreamFor(safeId) {
  const streams = ensureFileLogging();
  if (!streams) return null;
  if (streams.has(safeId)) return streams.get(safeId);

  while (streams.size >= MAX_OPEN_FILES) {
    const oldest = streams.keys().next().value;
    if (oldest === undefined) break;
    closeStream(oldest);
  }

  try {
    const path = join(logsDir, `${safeId}.log`);
    // Seed the byte counter from the file already on disk so the cap survives
    // restarts instead of resetting to zero every boot.
    let bytes = 0;
    try { bytes = statSync(path).size; } catch { bytes = 0; }
    const rec = { ws: createWriteStream(path, { flags: 'a', encoding: 'utf8' }), bytes, refused: false };
    rec.ws.on('error', () => { closeStream(safeId); });  // ENOSPC/EACCES → memory only
    streams.set(safeId, rec);
    return rec;
  } catch {
    return null;
  }
}

function appendToFile(safeId, record) {
  const rec = fileStreamFor(safeId);
  if (!rec) return;
  if (rec.bytes >= MAX_FILE_BYTES) {
    if (!rec.refused) {
      rec.refused = true;
      console.warn(`[log-server] session "${safeId}" hit the ${MAX_FILE_BYTES} byte file cap — memory only from here`);
    }
    return;
  }
  try {
    const line = `${JSON.stringify(record)}\n`;
    rec.bytes += Buffer.byteLength(line);
    rec.ws.write(line);
  } catch { /* non-fatal */ }
}

// ─── In-memory session store ──────────────────────────────────────────────────

// sessions: Map<safeSessionId -> { ring: Entry[] }>
//
// There used to be a per-session `clients` Set here "for the viewer header".
// Nothing ever read it, and it was capped with MAX_SESSIONS — the wrong
// constant, reused as a per-session client cap. Every entry already carries its
// own clientId/nick, which is what the viewer actually renders, so the whole
// set (and the bogus cap) is gone rather than given a constant it doesn't need.
const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, { ring: [] });
  return sessions.get(id);
}

function storeEntries(safeId, clientId, nick, entries) {
  // Drop oldest session if we're at the limit (LRU-ish: oldest insertion order).
  // Evicting also closes its file handle — leaking those was how a stream of
  // invented session ids exhausted file descriptors.
  if (!sessions.has(safeId) && sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) { sessions.delete(oldest); closeStream(oldest); }
  }
  const sess = getSession(safeId);

  for (const e of entries) {
    const record = { ...e, sessionId: safeId, clientId, nick: nick || null };
    if (sess.ring.length >= SESSION_RING_MAX) sess.ring.shift();
    sess.ring.push(record);
    appendToFile(safeId, record);
  }
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function send(res, code, type, body) {
  if (res.headersSent || res.writableEnded) return;
  try {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { /* socket already gone */ }
}

const fail = (res, code, msg) => send(res, code, 'text/plain; charset=utf-8', msg);

/**
 * Optional read gate (LOG_TOKEN). Returns true when the request may read logs.
 * With LOG_TOKEN unset this ALWAYS returns true — the default is open, because
 * silently breaking `dionysus.dk/logs?session=<room>` on a headset debugging
 * session is worse than the exposure it closes.
 */
function readAuthorized(req, url) {
  if (!LOG_TOKEN) return true;
  const header = req.headers['x-log-token'];
  const auth   = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const given  = url.searchParams.get('token') || (Array.isArray(header) ? header[0] : header) || bearer || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(LOG_TOKEN);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

// ─── HTTP handlers ────────────────────────────────────────────────────────────

function handlePost(req, res) {
  const chunks = [];
  let size = 0;
  let aborted = false;

  // Cheapest rejection first: a declared Content-Length over the cap is refused
  // before a single body byte is read, and the client still gets a clean 413
  // (destroying a half-uploaded request tends to surface as a socket error
  // instead of the status we meant to send).
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    aborted = true;
    fail(res, 413, 'Request too large');
    req.resume();                               // drain and discard
    return;
  }

  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;                       // Buffer chunks → real bytes
    if (size > MAX_BODY) {
      // Chunked upload with no Content-Length: stop buffering, answer, drain.
      aborted = true;
      fail(res, 413, 'Request too large');
      req.resume();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (aborted) return;
    try {
      let batch;
      try { batch = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
        return fail(res, 400, 'Bad JSON');
      }
      if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
        return fail(res, 400, 'Body must be a JSON object');
      }
      const { sessionId, clientId, nick, entries } = batch;
      if (typeof sessionId !== 'string' && typeof sessionId !== 'number') {
        return fail(res, 400, 'Missing or non-scalar sessionId');
      }
      if (!String(sessionId)) return fail(res, 400, 'Empty sessionId');
      if (!Array.isArray(entries)) return fail(res, 400, 'entries must be an array');
      if (entries.length > MAX_ENTRIES_BATCH) {
        return fail(res, 413, `Too many entries (max ${MAX_ENTRIES_BATCH})`);
      }

      const clean = [];
      for (const e of entries) {
        const rec = sanitizeEntry(e);
        if (!rec) return fail(res, 400, 'Each entry must be a JSON object');
        clean.push(rec);
      }

      const safeId  = safeSessionId(sessionId);
      const safeCid = safeScalar(clientId || 'unknown', MAX_ID_CHARS) || 'unknown';
      const safeNick = nick == null ? null : (safeScalar(nick, MAX_ID_CHARS) || null);

      storeEntries(safeId, safeCid, safeNick, clean);
      // Note: safeScalar() has already stripped control characters, so a hostile
      // nick can't paint the operator's terminal with ANSI escapes either.
      console.log(`[log-server] +${clean.length} entries  session="${safeId}" client="${safeCid}" nick="${safeNick}"`);
      send(res, 204, 'text/plain; charset=utf-8', '');
    } catch (err) {
      console.error('[log-server] POST /log failed:', err?.message || err);
      fail(res, 500, 'Log ingest failed');
    }
  });

  req.on('error', () => { aborted = true; fail(res, 400, 'Request error'); });
}

/** Shared query parsing for both read endpoints. */
function readQuery(url) {
  const rawSid = url.searchParams.get('session');
  const sid    = rawSid ? safeSessionId(rawSid) : null;
  const since  = parseInt(url.searchParams.get('since') || '0', 10) || 0;
  const tailRaw = parseInt(url.searchParams.get('tail') || '200', 10);
  const tail   = Number.isFinite(tailRaw) ? Math.max(0, Math.min(tailRaw, SESSION_RING_MAX)) : 200;
  return { sid, since, tail };
}

function handleGetJson(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  if (!readAuthorized(req, url)) return fail(res, 401, 'Unauthorized (LOG_TOKEN required)');

  const { sid, since, tail } = readQuery(url);

  let entries = sid
    ? (sessions.get(sid)?.ring || [])
    : [...sessions.values()].flatMap((s) => s.ring);

  if (since) entries = entries.filter((e) => e.ts >= since);
  if (tail > 0) entries = entries.slice(-tail);

  const payload = {
    sessions: sid ? (sessions.has(sid) ? [sid] : []) : [...sessions.keys()],
    entries,
  };
  send(res, 200, 'application/json', JSON.stringify(payload));
}

function handleGetHtml(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  if (!readAuthorized(req, url)) return fail(res, 401, 'Unauthorized (LOG_TOKEN required)');

  const { sid, since, tail } = readQuery(url);
  const sinceEcho = url.searchParams.get('since') || '';
  const token     = url.searchParams.get('token') || '';

  const sessionList = [...sessions.keys()];
  const targetSid   = sid || sessionList[sessionList.length - 1] || null;
  const targetSess  = targetSid ? sessions.get(targetSid) : null;

  let entries = targetSess ? [...targetSess.ring] : [];
  if (since) entries = entries.filter((e) => e.ts >= since);
  const tailN = tail > 0 ? tail : 200;
  entries = entries.slice(-tailN);

  // Null-prototype: with a plain object literal, a level of "constructor",
  // "toString", "valueOf" or "__proto__" resolves on Object.prototype and its
  // stringification (`function Object() { [native code] }`) lands in the style
  // attribute below. Not exploitable — the reachable set is quote-free — but it
  // is not what rule 1 in the header promises. Both the null prototype AND the
  // esc() on the way out are what make that promise true.
  const levelColor = Object.assign(Object.create(null),
    { log: '#ccc', info: '#8cf', warn: '#fc8', error: '#f88', event: '#af8' });
  const rowsHtml = entries.map((e) => {
    let hms = '';
    try { hms = new Date(e.ts).toISOString().slice(11, 23); } catch { hms = '??:??:??.???'; }
    const col = levelColor[e.level] || '#ccc';
    const client = e.nick ? `${e.nick}(${String(e.clientId || '').slice(0, 6)})`
                          : String(e.clientId || '').slice(0, 6);
    return `<tr>
      <td style="color:#888;white-space:nowrap">${esc(hms)}</td>
      <td style="color:${esc(col)};text-transform:uppercase;font-size:0.8em">${esc(e.level)}</td>
      <td style="color:#aaa;font-size:0.8em">${esc(client)}</td>
      <td style="word-break:break-word">${esc(e.msg)}</td>
    </tr>`;
  }).join('');

  const sessionOptions = sessionList.map((s) =>
    `<option value="${esc(s)}"${s === targetSid ? ' selected' : ''}>${esc(s)}</option>`
  ).join('');

  // The filter form submits a fresh GET, so a gated viewer would drop its token
  // on the first filter change without this hidden field. (The 5 s meta-refresh
  // needs no help: `content="5"` re-requests the CURRENT url, query string and
  // all — and deliberately keeps the original "no ?session ⇒ follow whatever
  // session is newest" behaviour that the headset workflow relies on.)
  const tokenField = token ? `<input type="hidden" name="token" value="${esc(token)}">` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>LibretroWebXR Logs${targetSid ? ` — ${esc(targetSid)}` : ''}</title>
  <meta http-equiv="refresh" content="5">
  <style>
    body { background:#111; color:#ccc; font-family:monospace; font-size:13px; margin:0; padding:8px; }
    h1   { color:#8cf; font-size:1em; margin:0 0 8px; }
    .controls { display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap; }
    select,input,button { background:#222; color:#ccc; border:1px solid #444; padding:3px 6px; border-radius:3px; }
    table { border-collapse:collapse; width:100%; }
    th    { background:#222; color:#888; text-align:left; padding:3px 6px; }
    td    { padding:2px 6px; border-bottom:1px solid #1a1a1a; vertical-align:top; }
    tr:hover td { background:#1a1a1a; }
    .empty { color:#555; padding:16px; }
  </style>
</head>
<body>
  <h1>LibretroWebXR Remote Logs</h1>
  <form method="GET" class="controls">
    ${tokenField}
    <label>Session:
      <select name="session" onchange="this.form.submit()">
        <option value="">— all —</option>
        ${sessionOptions}
      </select>
    </label>
    <label>Tail: <input name="tail" value="${esc(tailN)}" size="5"></label>
    <label>Since (epoch-ms): <input name="since" value="${esc(sinceEcho)}" size="14" placeholder="0 = all"></label>
    <button type="submit">Filter</button>
    <span style="color:#555">${esc(entries.length)} entries${targetSid ? ` in session ${esc(targetSid)}` : ''} · auto-refresh 5s</span>
  </form>
  <table>
    <thead><tr><th>Time (UTC)</th><th>Level</th><th>Client</th><th>Message</th></tr></thead>
    <tbody>
      ${rowsHtml || '<tr><td colspan="4" class="empty">No entries yet.</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;

  send(res, 200, 'text/html; charset=utf-8', html);
}

/**
 * CORS, per route.
 *
 * INGEST (/log) stays `Access-Control-Allow-Origin: *`. It is write-only — the
 * response is a bare 204 — so a permissive header leaks nothing, and the
 * documented dev workflow depends on it: `?log=<url>` in src/Logger.js points a
 * page served from localhost:5173 (or a LAN vite dev server, from the headset)
 * at a log server on another origin, and the JSON content type means that POST
 * is preflighted. Lock this down and cross-origin dev logging dies silently.
 *
 * READS (/logs, /logs.json) default to NO Access-Control-Allow-Origin. Reads
 * return every stored line of every session, and with LOG_TOKEN unset — the
 * mandated default — the old blanket `*` let any page the developer happened to
 * be visiting fetch() the whole store out of their browser. The headset
 * workflow is unaffected: dionysus.dk/logs?session=<room> is a same-origin
 * top-level navigation, and CORS has no say in those. Opt back in per origin
 * with LOG_CORS_ORIGINS, or `*` for the old behaviour.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} path  request pathname (OPTIONS preflight included)
 */
function applyCors(req, res, path) {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Log-Token');

  if (path === '/log') { res.setHeader('Access-Control-Allow-Origin', '*'); return; }

  if (CORS_READ_ANY) { res.setHeader('Access-Control-Allow-Origin', '*'); return; }

  // Response varies by Origin now, so caches must not share it across origins.
  res.setHeader('Vary', 'Origin');
  const origin = String(req.headers.origin || '');
  if (origin && CORS_READ_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  // Outermost net: this module shares a process with the room server, so an
  // exception escaping here would take multiplayer offline. Nothing gets past.
  try {
    // Path first: CORS is now per-route, so it needs to know the route. A
    // malformed URL gets the restrictive (read) treatment by falling through
    // with an empty path.
    let path = '';
    let badUrl = false;
    try { path = new URL(req.url || '/', 'http://localhost').pathname; } catch { badUrl = true; }

    applyCors(req, res, path);

    if (badUrl) return fail(res, 400, 'Bad request URL');

    if (req.method === 'OPTIONS') {
      send(res, 204, 'text/plain; charset=utf-8', '');
      return;
    }

    if (req.method === 'POST' && path === '/log') {
      handlePost(req, res);
    } else if (req.method === 'GET' && path === '/logs.json') {
      handleGetJson(req, res);
    } else if (req.method === 'GET' && path === '/logs') {
      handleGetHtml(req, res);
    } else {
      fail(res, 404, 'Not found');
    }
  } catch (err) {
    console.error('[log-server] request handler failed:', err?.message || err);
    fail(res, 500, 'Internal error');
  }
});

server.maxConnections = MAX_CONNECTIONS;
server.requestTimeout = REQUEST_TIMEOUT;
server.headersTimeout = HEADERS_TIMEOUT;
server.keepAliveTimeout = KEEPALIVE_TIMEOUT;

server.listen(LOG_PORT, '127.0.0.1', () => {
  console.log(`[log-server] listening on :${LOG_PORT} (POST /log · GET /logs · GET /logs.json)` +
              `${LOG_TOKEN ? ' · read gate ON (LOG_TOKEN)' : ''}`);
});

server.on('error', (err) => {
  console.error(`[log-server] failed to bind :${LOG_PORT}:`, err.message);
});

// Close all open file-log write streams when the HTTP server closes so Node
// can drain its handle queue and exit cleanly (especially important on Windows
// where open write streams keep the process alive after server.close()).
server.on('close', () => {
  if (fileStreams) {
    for (const rec of fileStreams.values()) { try { rec.ws.end(); } catch { /* ignore */ } }
    fileStreams.clear();
  }
});

// Export the server so smoke tests can close it cleanly before process.exit().
export { server as logServer };
