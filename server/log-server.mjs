// log-server: HTTP companion to room-server.mjs.
//
// Mounts an in-process HTTP server (port LOG_PORT, default 8788) alongside the
// WebSocket room server so the browser's remote logger can POST batches without
// going through a WebSocket connection.
//
// API
//   POST /log   body: JSON { sessionId, clientId, nick, entries: [{level,ts,msg,...}] }
//               → 204 on success, 400 on parse error, 413 if body too large
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

import { createServer }       from 'node:http';
import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { join, dirname }      from 'node:path';
import { fileURLToPath }      from 'node:url';

const __dir      = dirname(fileURLToPath(import.meta.url));
const LOG_PORT   = parseInt(process.env.LOG_PORT   || '8788', 10);
const MAX_BODY   = 128 * 1024;          // 128 KB per POST — more than enough
const SESSION_RING_MAX = 5000;          // entries kept in memory per session
const MAX_SESSIONS     = 100;           // drop oldest sessions if we blow this

// ─── Optional file persistence ────────────────────────────────────────────────

const logsDir = process.env.LOG_DIR || join(__dir, 'logs');
let fileStreams = null; // Map<sessionId -> WriteStream> — set up lazily

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

function fileStreamFor(sessionId) {
  const streams = ensureFileLogging();
  if (!streams) return null;
  if (!streams.has(sessionId)) {
    const safe = sessionId.replace(/[^\w-]/g, '_').slice(0, 64) || 'unknown';
    try {
      const path = join(logsDir, `${safe}.log`);
      streams.set(sessionId, createWriteStream(path, { flags: 'a', encoding: 'utf8' }));
    } catch {
      return null;
    }
  }
  return streams.get(sessionId);
}

// ─── In-memory session store ──────────────────────────────────────────────────

// sessions: Map<sessionId -> { ring: Entry[], clients: Set<{ clientId, nick }> }>
const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, { ring: [], clients: new Set() });
  return sessions.get(id);
}

function storeEntries(sessionId, clientId, nick, entries) {
  // Drop oldest session if we're at the limit (LRU-ish: oldest insertion order).
  if (!sessions.has(sessionId) && sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    sessions.delete(oldest);
  }
  const sess = getSession(sessionId);

  // Track which clients we've seen (for the viewer header).
  sess.clients.add(JSON.stringify({ clientId, nick: nick || null }));

  // Append entries to the ring, evicting old ones when full.
  for (const e of entries) {
    const record = { ...e, sessionId, clientId, nick: nick || null };
    if (sess.ring.length >= SESSION_RING_MAX) sess.ring.shift();
    sess.ring.push(record);

    // Optional file persistence (NDJSON).
    const stream = fileStreamFor(sessionId);
    if (stream) {
      try { stream.write(JSON.stringify(record) + '\n'); } catch { /* non-fatal */ }
    }
  }
}

// ─── HTTP handlers ────────────────────────────────────────────────────────────

function handlePost(req, res) {
  let raw = '';
  let size = 0;
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end('Request too large');
      req.destroy();
      return;
    }
    raw += chunk;
  });
  req.on('end', () => {
    let batch;
    try { batch = JSON.parse(raw); } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad JSON');
      return;
    }
    const { sessionId, clientId, nick, entries } = batch;
    if (!sessionId || !Array.isArray(entries)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing sessionId or entries');
      return;
    }
    storeEntries(String(sessionId), String(clientId || 'unknown'), nick || null, entries);
    console.log(`[log-server] +${entries.length} entries  session="${sessionId}" client="${clientId}" nick="${nick}"`);
    res.writeHead(204);
    res.end();
  });
  req.on('error', () => {
    try { res.writeHead(400); res.end(); } catch { /* closed */ }
  });
}

function handleGetJson(req, res) {
  const url   = new URL(req.url, 'http://localhost');
  const sid   = url.searchParams.get('session') || null;
  const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
  const tail  = parseInt(url.searchParams.get('tail')  || '200', 10);

  let entries = sid
    ? (sessions.get(sid)?.ring || [])
    : [...sessions.values()].flatMap((s) => s.ring);

  if (since) entries = entries.filter((e) => e.ts >= since);
  if (tail > 0) entries = entries.slice(-tail);

  const payload = {
    sessions: sid ? (sessions.has(sid) ? [sid] : []) : [...sessions.keys()],
    entries,
  };
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function handleGetHtml(req, res) {
  const url   = new URL(req.url, 'http://localhost');
  const sid   = url.searchParams.get('session') || '';
  const since = url.searchParams.get('since') || '';
  const tail  = url.searchParams.get('tail')  || '200';
  const autoRefresh = url.searchParams.has('auto') || true; // on by default

  const sessionList = [...sessions.keys()];
  const targetSid   = sid || sessionList[sessionList.length - 1] || null;
  const targetSess  = targetSid ? sessions.get(targetSid) : null;

  let entries = targetSess ? [...targetSess.ring] : [];
  if (since) {
    const sinceMs = parseInt(since, 10) || 0;
    if (sinceMs) entries = entries.filter((e) => e.ts >= sinceMs);
  }
  const tailN = parseInt(tail, 10) || 200;
  if (tailN > 0) entries = entries.slice(-tailN);

  const levelColor = { log: '#ccc', info: '#8cf', warn: '#fc8', error: '#f88', event: '#af8' };
  const rowsHtml = entries.map((e) => {
    const d   = new Date(e.ts);
    const hms = d.toISOString().slice(11, 23);
    const col = levelColor[e.level] || '#ccc';
    const msg = e.msg.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const client = e.nick ? `${e.nick}(${(e.clientId||'').slice(0,6)})` : (e.clientId||'').slice(0,6);
    return `<tr>
      <td style="color:#888;white-space:nowrap">${hms}</td>
      <td style="color:${col};text-transform:uppercase;font-size:0.8em">${e.level}</td>
      <td style="color:#aaa;font-size:0.8em">${client}</td>
      <td style="word-break:break-word">${msg}</td>
    </tr>`;
  }).join('');

  const sessionOptions = sessionList.map((s) =>
    `<option value="${s}"${s === targetSid ? ' selected' : ''}>${s}</option>`
  ).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>LibretroWebXR Logs${targetSid ? ' — ' + targetSid : ''}</title>
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
    <label>Session:
      <select name="session" onchange="this.form.submit()">
        <option value="">— all —</option>
        ${sessionOptions}
      </select>
    </label>
    <label>Tail: <input name="tail" value="${tailN}" size="5"></label>
    <label>Since (epoch-ms): <input name="since" value="${since}" size="14" placeholder="0 = all"></label>
    <button type="submit">Filter</button>
    <span style="color:#555">${entries.length} entries${targetSid ? ' in session ' + targetSid : ''} · auto-refresh 5s</span>
  </form>
  <table>
    <thead><tr><th>Time (UTC)</th><th>Level</th><th>Client</th><th>Message</th></tr></thead>
    <tbody>
      ${rowsHtml || '<tr><td colspan="4" class="empty">No entries yet.</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function handleCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  handleCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const path = (new URL(req.url || '/', 'http://localhost')).pathname;

  if (req.method === 'POST' && path === '/log') {
    handlePost(req, res);
  } else if (req.method === 'GET' && path === '/logs.json') {
    handleGetJson(req, res);
  } else if (req.method === 'GET' && path === '/logs') {
    handleGetHtml(req, res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(LOG_PORT, '127.0.0.1', () => {
  console.log(`[log-server] listening on :${LOG_PORT} (POST /log · GET /logs · GET /logs.json)`);
});

server.on('error', (err) => {
  console.error(`[log-server] failed to bind :${LOG_PORT}:`, err.message);
});

// Close all open file-log write streams when the HTTP server closes so Node
// can drain its handle queue and exit cleanly (especially important on Windows
// where open write streams keep the process alive after server.close()).
server.on('close', () => {
  if (fileStreams) {
    for (const ws of fileStreams.values()) { try { ws.end(); } catch { /* ignore */ } }
    fileStreams.clear();
  }
});

// Export the server so smoke tests can close it cleanly before process.exit().
export { server as logServer };
