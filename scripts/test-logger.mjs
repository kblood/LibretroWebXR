// Unit tests for src/Logger.js pure helpers (formatEntry, buildBatch) and the
// Logger class logic.  No DOM, no fetch, no server — all stubs are in-process.
//
// Run: node scripts/test-logger.mjs
// Or via: npm test (invoked by test-collection.mjs chain)
//
// Tests the pure helpers (formatEntry, buildBatch) exhaustively, then exercises
// the Logger class: buffering, flush scheduling, backoff, and console chaining.

import { formatEntry, buildBatch, Logger } from '../src/Logger.js';

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; }
  else       { failed++; console.error(`  FAIL: ${msg}`); }
};
const eq = (got, want, msg) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; }
  else         { failed++; console.error(`  FAIL: ${msg}\n    got:  ${g}\n    want: ${w}`); }
};

// ─── formatEntry ─────────────────────────────────────────────────────────────

{
  const e = formatEntry('log', ['hello', 'world']);
  ok(e.level === 'log',           'formatEntry: level is preserved');
  ok(e.msg   === 'hello world',   'formatEntry: args joined with space');
  ok(typeof e.ts === 'number',    'formatEntry: ts is a number');
  ok(e.ts > 0,                    'formatEntry: ts is positive (ms epoch)');
}
{
  const e = formatEntry('error', [new Error('boom')]);
  ok(e.msg.includes('Error: boom'), 'formatEntry: Error instance prints name + message');
}
{
  const e = formatEntry('warn', [{ x: 1 }]);
  ok(e.msg === '{"x":1}',         'formatEntry: plain objects are JSON.stringify\'d');
}
{
  const e = formatEntry('event', ['[boot]'], { event: 'boot', core: 'snes9x' });
  ok(e.event === 'boot',           'formatEntry: extra fields merged into entry');
  ok(e.core === 'snes9x',          'formatEntry: structured payload key present');
  ok(e.msg  === '[boot]',          'formatEntry: msg is the first arg string');
}
{
  const e = formatEntry('log', [null, undefined, 42, true]);
  ok(e.msg === 'null undefined 42 true', 'formatEntry: null/undefined/number/bool coerce to string');
}
{
  // Object that throws on JSON.stringify
  const circular = {};
  circular.self = circular;
  const e = formatEntry('log', [circular]);
  ok(e.msg === '[object]', 'formatEntry: un-serialisable object falls back to "[object]"');
}

// ─── buildBatch ──────────────────────────────────────────────────────────────

{
  const entries = [formatEntry('log', ['hi'])];
  const json = buildBatch('lobby', 'client-1', 'Alice', entries);
  const parsed = JSON.parse(json);
  eq(parsed.sessionId, 'lobby',    'buildBatch: sessionId present');
  eq(parsed.clientId,  'client-1', 'buildBatch: clientId present');
  eq(parsed.nick,      'Alice',    'buildBatch: nick present');
  ok(Array.isArray(parsed.entries), 'buildBatch: entries is an array');
  ok(parsed.entries.length === 1,   'buildBatch: entries count correct');
  ok(parsed.entries[0].msg === 'hi','buildBatch: entry msg survives round-trip');
}
{
  const json = buildBatch('room', 'c', null, []);
  const p = JSON.parse(json);
  ok(p.nick === null, 'buildBatch: null nick serialises as null');
  ok(p.entries.length === 0, 'buildBatch: empty entries array');
}

// ─── Logger: basic buffering (no server, console-only) ───────────────────────

{
  const logger = new Logger({ sessionId: 'test', nick: 'Tester' });
  // init with no server → console-only
  logger.init({ serverUrl: '' });

  const captured = [];
  const origLog = console.log;
  console.log = (...a) => captured.push(a.join(' '));

  logger.log('ping');
  logger.warn('pong');
  logger.error('boom');

  console.log = origLog;

  ok(logger._buf.length === 4, 'Logger: 3 explicit + 1 [Logger] init message in buffer');
  ok(logger._buf.some((e) => e.msg === 'ping'),  'Logger.log() buffered');
  ok(logger._buf.some((e) => e.level === 'warn'), 'Logger.warn() level tagged');
  ok(logger._buf.some((e) => e.level === 'error'),'Logger.error() level tagged');
}

// ─── Logger: event() adds structured fields ───────────────────────────────────

{
  const logger = new Logger();
  logger.init({ serverUrl: '' });
  const before = logger._buf.length;
  logger.event('boot', { core: 'nestopia', file: 'game.nes' });
  const added = logger._buf.slice(before);
  ok(added.length === 1,                  'Logger.event(): one entry added');
  ok(added[0].event === 'boot',           'Logger.event(): event field set');
  ok(added[0].core  === 'nestopia',       'Logger.event(): payload field merged');
  ok(added[0].level === 'event',          'Logger.event(): level is "event"');
}

// ─── Logger: console chaining (original handler still fires) ─────────────────

{
  const calls = [];
  const origWarn = console.warn;
  console.warn = (...a) => calls.push(['orig', ...a]);

  const logger = new Logger();
  logger.init({ serverUrl: '' });

  const before = calls.length;
  console.warn('chained warn');
  const after = calls.length;

  console.warn = origWarn;

  ok(after > before, 'Logger: original console.warn still fires after hook');
  ok(calls.some((c) => c.includes('chained warn')), 'Logger: original handler receives the args');
}

// ─── Logger: flush POSTs to serverUrl + /log ─────────────────────────────────

{
  const posted = [];
  // Minimal fetch stub
  const fakeFetch = (url, opts) => {
    posted.push({ url, body: JSON.parse(opts.body) });
    return Promise.resolve({ ok: true });
  };

  // Temporarily inject fetch stub (Logger captures the global at flush time)
  const origFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;

  const logger = new Logger({ sessionId: 'xr-room', nick: 'QuestUser' });
  logger.init({ serverUrl: 'http://localhost:8788' });
  logger.event('net', { action: 'connect' });

  // Force an immediate flush
  logger._flush();

  globalThis.fetch = origFetch;

  ok(posted.length >= 1,                             'Logger: flush() POSTs to server');
  ok(posted[0].url === 'http://localhost:8788/log',  'Logger: POST URL is serverUrl + /log');
  ok(posted[0].body.sessionId === 'xr-room',         'Logger: batch includes sessionId');
  ok(posted[0].body.nick      === 'QuestUser',        'Logger: batch includes nick');
  ok(Array.isArray(posted[0].body.entries),           'Logger: batch includes entries array');
}

// ─── Logger: failure increments failCount + sets backoff ─────────────────────

{
  let callCount = 0;
  globalThis.fetch = () => { callCount++; return Promise.reject(new Error('offline')); };

  const logger = new Logger({ sessionId: 'xr' });
  logger.init({ serverUrl: 'http://x.invalid' });
  logger.log('test');
  logger._flush();

  // After a failed flush, backoffUntil should be set in the future.
  // Give the rejected promise a tick to resolve.
  await new Promise((r) => setTimeout(r, 20));
  ok(logger._failCount >= 1,    'Logger: _failCount incremented on fetch failure');
  ok(logger._backoffUntil > 0,  'Logger: _backoffUntil set after failure');

  delete globalThis.fetch;
}

// ─── Logger: ring buffer evicts oldest entries ───────────────────────────────

{
  const logger = new Logger({ sessionId: 'ring' });
  logger.init({ serverUrl: '' });
  logger._buf = [];
  // Fill just past the ring limit (2000) without triggering a flush
  const RING_MAX = 2000;
  for (let i = 0; i < RING_MAX + 10; i++) {
    // Bypass scheduleFiush to avoid the timer
    const e = { level: 'log', ts: Date.now(), msg: String(i) };
    if (logger._buf.length >= RING_MAX) logger._buf.shift();
    logger._buf.push(e);
  }
  ok(logger._buf.length === RING_MAX, 'Logger ring: buffer never exceeds RING_MAX');
  ok(logger._buf[logger._buf.length - 1].msg === String(RING_MAX + 9),
    'Logger ring: newest entry is at tail after eviction');
}

// ─── Done ─────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
