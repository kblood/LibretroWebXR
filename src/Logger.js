// Logger: remote log shipping for the WebXR session.
//
// The killer use case: the app runs on a Quest headset where you CANNOT see the
// browser console. This module captures console.log/warn/error and global error
// events and POSTs them in batches to a server-side /log endpoint so a developer
// at a PC can read them live from GET /logs.
//
// Design:
//   • Chain (never clobber) existing console.* and window error handlers.
//   • Buffer entries; flush every FLUSH_MS or when the buffer hits BATCH_MAX.
//   • POST to `serverUrl + '/log'` with JSON. Never throws — if the endpoint
//     is down the app keeps running. Backoff on repeated failures.
//   • Safe in a WebXR session (no DOM manipulation, keepalive fetch).
//   • Pure formatEntry / buildBatch helpers exported for unit tests.
//
// Init (in src/main.js, first lines):
//   import { Logger } from './Logger.js';
//   const logger = new Logger();          // console-only until init()
//   logger.init();                        // call ASAP (before other imports run)
//
// Remote shipping is opt-in. Logger.init() derives the endpoint from:
//   1. ?log=<url>  in the URL — explicit server.
//   2. Auto-derive from origin when origin matches the production host
//      (window.location.origin + '/log') — enables Quest sessions automatically
//      when the app is loaded from the production server.
//   3. Anything else — console-only, no network traffic.
//
// Structured app events (call these from app code):
//   logger.event('boot', { core: 'snes9x', file: 'game.sfc' });
//   logger.event('input', { btn: 'A', down: true });
//   logger.event('net', { action: 'connect', room: 'lobby' });

const FLUSH_MS   = 800;   // batch window
const BATCH_MAX  = 40;    // flush early if buffer exceeds this
const RING_MAX   = 2000;  // max buffered entries before we start dropping oldest
const BACKOFF_MS = [0, 2000, 5000, 15000, 30000]; // retry delays after failures

// ─── Pure helpers (exported for unit tests) ──────────────────────────────────

/**
 * Format one log entry as a plain-object record.
 *
 * @param {'log'|'info'|'warn'|'error'|'event'} level
 * @param {string|string[]} args - raw console args or a single string message
 * @param {object} [extra] - structured fields to merge in (for event())
 * @returns {{ level, ts, msg, [key]: * }}
 */
export function formatEntry(level, args, extra) {
  const parts = Array.isArray(args)
    ? args.map((a) => {
        if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? '\n' + a.stack : ''}`;
        if (a === null || a === undefined) return String(a);
        if (typeof a === 'object') {
          try { return JSON.stringify(a); }
          catch { return '[object]'; }
        }
        return String(a);
      })
    : [String(args)];
  const entry = { level, ts: Date.now(), msg: parts.join(' ') };
  if (extra && typeof extra === 'object') Object.assign(entry, extra);
  return entry;
}

/**
 * Build the JSON payload for one POST batch.
 *
 * @param {string} sessionId - room/session name
 * @param {string} clientId  - random client identifier
 * @param {string} [nick]    - player nickname (optional)
 * @param {object[]} entries - array of formatEntry() results
 * @returns {string} JSON string
 */
export function buildBatch(sessionId, clientId, nick, entries) {
  return JSON.stringify({ sessionId, clientId, nick: nick || null, entries });
}

// ─── Logger class ────────────────────────────────────────────────────────────

export class Logger {
  /**
   * @param {object} [opts]
   * @param {string} [opts.sessionId] - room/session name (default: 'default')
   * @param {string} [opts.nick]      - player nick
   */
  constructor({ sessionId, nick } = {}) {
    this._sessionId = sessionId || 'default';
    this._nick = nick || null;
    // Stable per-tab id so a developer can correlate bursts of logs.
    this._clientId = _persistentClientId();
    this._serverUrl = null;   // null = console-only
    this._buf = [];           // ring buffer of formatEntry() objects
    this._flushTimer = null;
    this._flushPending = false;
    this._failCount = 0;      // consecutive POST failures → backoff
    this._backoffUntil = 0;
    this._installed = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Install console overrides + window error listeners, and auto-detect the
   * log server URL. Call once, as early as possible.
   *
   * @param {object} [opts]
   * @param {string} [opts.serverUrl] - override server URL (for testing)
   */
  init({ serverUrl } = {}) {
    if (this._installed) return;
    this._installed = true;

    this._serverUrl = serverUrl !== undefined
      ? serverUrl
      : _detectServerUrl();

    _installConsoleHooks(this);
    _installWindowHooks(this);
    this._push('info', ['[Logger] remote logging ' + (this._serverUrl ? 'active → ' + this._serverUrl : 'console-only')]);
  }

  /** Log a plain message at the given level (chains to the real console). */
  log  (...args) { this._push('log',   args); }
  info (...args) { this._push('info',  args); }
  warn (...args) { this._push('warn',  args); }
  error(...args) { this._push('error', args); }

  /**
   * Log a structured application event (e.g. boot, input, net).
   * @param {string} name     - event name, e.g. 'boot' | 'input' | 'net'
   * @param {object} [fields] - arbitrary payload merged into the entry
   */
  event(name, fields = {}) {
    this._push('event', [`[${name}]`], { event: name, ...fields });
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  /** Push a formatted entry into the ring buffer and schedule a flush. */
  _push(level, args, extra) {
    const entry = formatEntry(level, args, extra);
    // Ring: drop oldest if we're way ahead of the flush (headset offline, etc.)
    if (this._buf.length >= RING_MAX) this._buf.shift();
    this._buf.push(entry);
    this._scheduleFlush();
  }

  _scheduleFlush() {
    if (this._flushPending) return;
    if (this._buf.length >= BATCH_MAX) {
      // Urgent: flush immediately on the next microtask boundary.
      this._flushPending = true;
      Promise.resolve().then(() => this._flush());
      return;
    }
    if (this._flushTimer === null) {
      this._flushTimer = setTimeout(() => this._flush(), FLUSH_MS);
    }
  }

  _flush() {
    this._flushPending = false;
    this._flushTimer = null;
    if (this._buf.length === 0) return;
    if (!this._serverUrl) return; // console-only — nothing to POST

    // Backoff: skip this flush if we're in a cooldown window.
    const now = Date.now();
    if (now < this._backoffUntil) {
      // Reschedule — try again after the cooldown expires.
      const wait = this._backoffUntil - now + 50;
      this._flushTimer = setTimeout(() => this._flush(), wait);
      return;
    }

    const batch = this._buf.splice(0, BATCH_MAX);
    const body = buildBatch(this._sessionId, this._clientId, this._nick, batch);

    try {
      fetch(this._serverUrl + '/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true, // survive page-close / XR session transitions
      })
        .then((res) => {
          if (res.ok || res.status === 204) {
            this._failCount = 0;
          } else {
            this._onFailure();
          }
        })
        .catch(() => { this._onFailure(); });
    } catch {
      // fetch itself unavailable (e.g. SSR / test env without globals)
      this._onFailure();
    }

    // If there's more buffered already, schedule another flush.
    if (this._buf.length > 0) this._scheduleFlush();
  }

  _onFailure() {
    this._failCount++;
    const delay = BACKOFF_MS[Math.min(this._failCount, BACKOFF_MS.length - 1)];
    this._backoffUntil = Date.now() + delay;
  }
}

// ─── Auto-detect the server URL ──────────────────────────────────────────────

function _detectServerUrl() {
  // Safety: may run in test environments without a real `location`.
  try {
    const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    const explicit = params.get('log');
    if (explicit) return explicit.replace(/\/$/, '');

    // When loaded from the production host, auto-enable remote logging.
    // The room server is reverse-proxied at the same origin under /ws/;
    // the log endpoint will be proxied at /log/ (see deploy/log-proxy.conf).
    if (typeof location !== 'undefined') {
      const { protocol, hostname } = location;
      const known = ['dionysus.dk'];
      if (known.includes(hostname) && protocol === 'https:') {
        return location.origin;
      }
    }
  } catch { /* ignore */ }
  return null; // console-only
}

// ─── Stable per-tab client ID ────────────────────────────────────────────────

function _persistentClientId() {
  const KEY = 'libretrowebxr.logClientId';
  try {
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      // Generate a compact random id: 8 hex chars is plenty to distinguish tabs.
      id = Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
      sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

// ─── Console + window hook installation ──────────────────────────────────────

function _installConsoleHooks(logger) {
  if (typeof console === 'undefined') return;
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);             // call the REAL console first
      logger._push(level, args); // then buffer for remote shipping
    };
  }
}

function _installWindowHooks(logger) {
  if (typeof window === 'undefined') return;

  // Uncaught JS errors
  const origError = window.onerror;
  window.onerror = function (msg, src, line, col, err) {
    logger._push('error', [
      `Uncaught: ${msg} at ${src}:${line}:${col}`,
      ...(err ? [err] : []),
    ]);
    if (typeof origError === 'function') return origError.apply(this, arguments);
    return false;
  };

  // Unhandled promise rejections
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason;
    logger._push('error', [
      'UnhandledRejection: ' + (reason instanceof Error ? reason.stack || reason.message : String(reason)),
    ]);
  }, { capture: true });
}

// ─── Module-level singleton (imported by main.js) ────────────────────────────

/**
 * The shared logger instance. Import and init this as the very first thing in
 * main.js so it captures startup errors.
 *
 * Usage:
 *   import { logger } from './Logger.js';
 *   logger.init();   // call before any other imports complete their side-effects
 */
export const logger = new Logger();
