// mp-harness — the Node-side driver for window.__testApi (src/TestApi.js).
//
// Purpose: a multi-browser test should read like a script of USER ACTIONS, not
// like a pile of page.evaluate() strings. Compare:
//
//   const host = await mp.openHost('Host');
//   const client = await mp.open('Client');
//   await host.loadFile({ url: 'roms/freeware/lwx-nes-pong.nes' });
//   await client.press('Down', { player: 2 });
//   t.ok(await mp.samePicture(host, client) > 0.9, 'both peers see one game');
//
// …with the equivalent raw-Puppeteer version. Everything here is a thin wrapper
// over `__testApi.call(path, args)`, so there is exactly ONE contract between
// Node and the page and no per-test hook archaeology.
//
// Uses puppeteer-core (already a devDependency, and what every existing smoke in
// scripts/ uses) with one browser PROCESS per peer — separate processes, not
// separate tabs, because WebRTC between two contexts of one browser does not
// exercise the same ICE path two real machines do.
//
// See docs/TEST_AUTOMATION.md for the tutorial.

import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

export const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function findChrome() {
  const found = CHROME_CANDIDATES.find(existsSync);
  if (!found) throw new Error('no Chrome/Edge found — set --chrome=<path>');
  return found;
}

/**
 * Launch flags every MP test needs. Getting these wrong is a classic source of
 * a "failing" test that is really a harness problem:
 *  - autoplay-policy: a received <video> that the autoplay policy pauses freezes
 *    the TEXTURE too, so the picture looks dead for reasons unrelated to sync.
 *  - WebRtcHideLocalIpsWithMdns off: without it, two browser processes on one
 *    machine never complete an ICE pair and host→client video never arrives.
 *  - SharedArrayBuffer: threaded cores refuse to boot without it.
 */
export const LAUNCH_ARGS = [
  '--no-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  '--enable-features=SharedArrayBuffer',
  '--disable-features=WebRtcHideLocalIpsWithMdns',
  '--mute-audio',
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse `--k=v` / `--flag` argv into an object (the convention every smoke uses). */
export function parseArgs(argv = process.argv.slice(2)) {
  return Object.fromEntries(argv.map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
  }));
}

/** Thrown when `__testApi` reports `{ ok: false }`. Carries the page-side code. */
export class TestApiError extends Error {
  constructor(peer, path, error) {
    super(`[${peer}] ${path} → ${error.code}: ${error.message}`);
    this.name = 'TestApiError';
    this.code = error.code;
    this.detail = error.detail ?? null;
    this.peer = peer;
    this.path = path;
  }
}

/** Pearson correlation — the same maths TestApi.correlate() uses page-side. */
export function correlate(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return null;
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

/**
 * Centre of mass of a 1-D luma profile (see __testApi.tv.profile). Returns a
 * 0..1 position along the profile's axis, weighted by how far each band rises
 * above the profile's own floor — i.e. "where is the bright thing". Use it to
 * follow a sprite (a Pong paddle, a cursor) without knowing the game.
 * null when the profile is flat (nothing to locate).
 */
export function brightCentroid(values, { minSpread = 6 } = {}) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (hi - lo < minSpread) return null;
  let wsum = 0, w = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] - lo;
    wsum += v * i; w += v;
  }
  if (w === 0) return null;
  return (wsum / w) / (values.length - 1);
}

// ---------------------------------------------------------------------------
// Peer
// ---------------------------------------------------------------------------

/**
 * One browser process running one client of the app. Every method mirrors a
 * `__testApi` path 1:1; see docs/TEST_AUTOMATION.md for the full table.
 */
export class Peer {
  constructor({ name, browser, page, harness }) {
    this.name = name;
    this.browser = browser;
    this.page = page;
    this.harness = harness;
    this.consoleErrors = [];
    this.pageErrors = [];
  }

  /** Raw dispatch. Never returns an error object — it throws TestApiError. */
  async call(path, args = []) {
    const res = await this.page.evaluate(
      (p, a) => window.__testApi.call(p, a),
      path, args,
    );
    if (!res) throw new Error(`[${this.name}] ${path} → no response (page reloading?)`);
    if (!res.ok) throw new TestApiError(this.name, path, res.error);
    return res.value;
  }

  /** Like call(), but returns `{ ok, value, error }` for expected-failure tests. */
  async tryCall(path, args = []) {
    try { return { ok: true, value: await this.call(path, args) }; }
    catch (e) { return { ok: false, error: { code: e.code || 'driver', message: e.message } }; }
  }

  /** Wait for a page-side predicate written against __testApi (or anything else). */
  async waitFor(fn, { timeoutMs = 15000, everyMs = 200, what = 'condition', args = [] } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try { const v = await this.page.evaluate(fn, ...args); if (v) return v; }
      catch (_) { /* mid-navigation: the app reloads to adopt a host room */ }
      if (Date.now() >= deadline) throw new Error(`[${this.name}] timed out (${timeoutMs}ms) waiting for ${what}`);
      await sleep(everyMs);
    }
  }

  /** Poll a harness-side async predicate until it returns something truthy. */
  async until(fn, { timeoutMs = 20000, everyMs = 250, what = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let v = null;
      try { v = await fn(); } catch (_) { v = null; }
      if (v) return v;
      if (Date.now() >= deadline) throw new Error(`[${this.name}] timed out (${timeoutMs}ms) waiting for ${what}`);
      await sleep(everyMs);
    }
  }

  async ready(opts) { return this.call('ready', [opts ?? {}]); }
  async methods() { return this.call('methods'); }
  async supports(path) { return this.page.evaluate((p) => window.__testApi.supports(p), path); }
  async capabilities() { return this.page.evaluate(() => window.__testApi.capabilities()); }
  async clientKind() { return this.page.evaluate(() => window.__testApi.clientKind); }

  // -- session ------------------------------------------------------------
  sessionState() { return this.call('session.state'); }
  joinRoom(opts) { return this.call('session.join', [opts]); }
  leaveRoom() { return this.call('session.leave'); }
  isHost() { return this.call('session.isHost'); }
  waitForHostElection(opts) { return this.call('session.waitForHostElection', [opts ?? {}]); }
  becomeHost(opts) { return this.call('session.becomeHost', [opts ?? {}]); }
  peers() { return this.call('session.peers'); }
  /** This peer's own position + the spawn seat it was given on join. */
  viewpoint() { return this.call('session.viewpoint'); }
  /** Remote peers' avatar HEAD positions in world space (`[{id,nick,pos}]`). */
  avatars() { return this.call('session.avatars'); }
  /**
   * Smallest horizontal (XZ) distance in metres from this peer's own head to any
   * remote avatar's head. `null` when no avatar has a pose yet. A value near 0
   * means someone is standing inside us — the avatar-occlusion bug.
   */
  async nearestAvatarDistance() {
    const [vp, avs] = await Promise.all([this.viewpoint(), this.avatars()]);
    const positioned = avs.filter((a) => Array.isArray(a.pos) && a.pos[1] > -5);
    if (!positioned.length) return null;
    return Math.min(...positioned.map((a) => Math.hypot(a.pos[0] - vp.head[0], a.pos[2] - vp.head[2])));
  }
  objectState(key) { return this.call('session.objectState', [key]); }
  setObjectState(key, value) { return this.call('session.setObjectState', [key, value]); }
  wireRx(ch) { return this.call('session.wireRx', [ch]); }
  /** Host-side: forwarded controller inputs received from peers. */
  recvInputs() { return this.call('session.recvInputs'); }

  /** Wait until this peer knows it IS the host. */
  async waitUntilHost({ timeoutMs = 25000 } = {}) {
    return this.until(async () => (await this.isHost()) || null,
      { timeoutMs, what: `${this.name} to be the host` });
  }
  /** Wait until this peer knows it is NOT the host (a watcher). */
  async waitUntilWatching({ timeoutMs = 25000 } = {}) {
    return this.until(async () => {
      const s = await this.sessionState();
      return (s.hostId && !s.isHost) ? s : null;
    }, { timeoutMs, what: `${this.name} to become a watcher` });
  }
  async waitForPeers(n, { timeoutMs = 25000 } = {}) {
    return this.until(async () => {
      const s = await this.sessionState();
      return s.peerCount >= n ? s : null;
    }, { timeoutMs, what: `${this.name} to see ${n} peer(s)` });
  }

  // -- props --------------------------------------------------------------
  listProps() { return this.call('props.list'); }
  getProp(id) { return this.call('props.get', [id]); }
  grabProp(id) { return this.call('props.grab', [id]); }
  moveObjectTo(id, pos, opts) { return this.call('props.moveTo', [id, pos, opts ?? {}]); }
  releaseProp(id) { return this.call('props.release', [id]); }
  /** grab → moveTo → release. The one-liner for "a peer moved something". */
  moveObject(id, pos, opts) { return this.call('props.move', [id, pos, opts ?? {}]); }
  addProp(type, opts) { return this.call('props.add', [type, opts ?? {}]); }
  removeProp(id) { return this.call('props.remove', [id]); }
  waitForPropPosition(id, pos, opts) { return this.call('props.waitForPosition', [id, pos, opts ?? {}]); }
  waitForProp(id, opts) { return this.call('props.waitForProp', [id, opts ?? {}]); }

  // -- input --------------------------------------------------------------
  press(btn, opts) { return this.call('input.press', [btn, opts ?? {}]); }
  releaseButton(btn, opts) { return this.call('input.release', [btn, opts ?? {}]); }
  tap(btn, opts) { return this.call('input.tap', [btn, opts ?? {}]); }
  pressSequence(steps, opts) { return this.call('input.sequence', [steps, opts ?? {}]); }
  releaseAllButtons() { return this.call('input.releaseAll'); }
  inputState() { return this.call('input.state'); }
  setSystem(sys) { return this.call('input.setSystem', [sys]); }
  rawKey(code, key, down, opts) { return this.call('input.rawKey', [code, key, down, opts ?? {}]); }

  /** Hold a button for `ms` while running `during()`, then release it. */
  async hold(btn, ms, opts = {}, during = null) {
    await this.press(btn, opts);
    try {
      if (during) await during();
      else await sleep(ms);
    } finally { await this.releaseButton(btn, opts); }
  }

  // -- peripherals --------------------------------------------------------
  armGun() { return this.call('gun.arm'); }
  disarmGun() { return this.call('gun.disarm'); }
  gunState() { return this.call('gun.state'); }
  fireGun(opts) { return this.call('gun.fire', [opts]); }
  armMouse() { return this.call('mouse.arm'); }
  disarmMouse() { return this.call('mouse.disarm'); }
  moveMouse(dx, dy, buttons) { return this.call('mouse.move', [dx, dy, buttons ?? 0]); }

  // -- content ------------------------------------------------------------
  shelf() { return this.call('content.shelf'); }
  currentGame(opts) { return this.call('content.current', [opts ?? {}]); }
  /** Insert a shelf cart (by file/title) — the real cartridge-into-slot path. */
  insertCart(ref, opts) { return this.call('content.insert', [ref, opts ?? {}]); }
  /** Boot via the ROM resolver and await it. */
  loadRom(ref) { return this.call('content.load', [ref]); }
  /** Load ROM bytes as if picked from a file — `{url}` or `{name, bytes}`. */
  loadFile(opts) { return this.call('content.loadFile', [opts]); }
  waitForGame(ref, opts) { return this.call('content.waitForGame', [ref, opts ?? {}]); }

  // -- rack ---------------------------------------------------------------
  consoles() { return this.call('rack.list'); }
  spawnConsole(system, opts) { return this.call('rack.spawn', [system, opts ?? {}]); }
  focusConsole(id) { return this.call('rack.focus', [id]); }
  powerConsole(id, on) { return this.call('rack.power', [id, on]); }
  resetConsole(id) { return this.call('rack.reset', [id]); }
  mayRunLocalCore() { return this.call('rack.mayRunLocalCore'); }
  /** The honest "is a core genuinely running" check (samples over `ms`). */
  runningCores(opts) { return this.call('rack.running', [opts ?? {}]); }

  // -- tv / pixels --------------------------------------------------------
  tvs() { return this.call('tv.list'); }
  /** Multi-disc state: `{ panel:{visible,label,index,…}, published:{disc,…} }`. */
  discState() { return this.call('tv.disc'); }
  /** Drive the real in-world Prev/Next disc buttons. */
  stepDisc(delta) { return this.call('tv.step', [delta ?? 1]); }
  tvState(tvId) { return this.call('tv.get', [tvId]); }
  /** `{ hash, sig, kind, w, h, blank }` — see docs for hash vs sig. */
  sampleTv(tvId, opts) { return this.call('tv.sample', [tvId, opts ?? {}]); }
  async pixelHash(tvId, opts) { return (await this.sampleTv(tvId, opts)).hash; }
  async pixelSignature(tvId, opts) { return (await this.sampleTv(tvId, opts)).sig; }
  /** 1-D luma profile of a crop — feed to brightCentroid() to track a sprite. */
  tvProfile(tvId, opts) { return this.call('tv.profile', [tvId, opts ?? {}]); }
  tvProgress(tvId, opts) { return this.call('tv.progress', [tvId, opts ?? {}]); }
  waitForMotion(tvId, opts) { return this.call('tv.waitForMotion', [tvId, opts ?? {}]); }

  // -- video (host → client WebRTC) ---------------------------------------
  videoState() { return this.call('video.state'); }
  /** Decoded-frame progression — the only honest "picture is alive" check. */
  videoProgress(opts) { return this.call('video.progress', [opts ?? {}]); }
  waitForStream(opts) { return this.call('video.waitForStream', [opts ?? {}]); }
  startBroadcast() { return this.call('video.broadcast'); }
  stopBroadcast() { return this.call('video.stop'); }

  // -- room ---------------------------------------------------------------
  roomDescriptor() { return this.call('room.descriptor'); }
  publishedRoom() { return this.call('room.published'); }
  publishedTv() { return this.call('room.tv'); }

  // -- misc ---------------------------------------------------------------
  async screenshot(file) {
    mkdirSync(resolvePath(file, '..'), { recursive: true });
    await this.page.screenshot({ path: file });
    return file;
  }
  async close() { try { await this.browser.close(); } catch (_) {} }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export class MpHarness {
  /**
   * @param {object} opts
   * @param {string} [opts.app]   app URL (default http://localhost:5173/)
   * @param {string} [opts.ws]    room-server URL (default ws://localhost:8797/)
   * @param {string} [opts.room]  room id (default a fresh random one)
   * @param {boolean}[opts.headed]
   * @param {string} [opts.chrome] browser executable
   * @param {string} [opts.page]  'index' (VR/desktop-in-browser) | 'desktop'
   * @param {Function}[opts.log]
   */
  constructor(opts = {}) {
    this.app = opts.app || 'http://localhost:5173/';
    this.ws = opts.ws || 'ws://localhost:8797/';
    this.room = opts.room || `auto${Date.now().toString(36)}`;
    this.headed = !!opts.headed;
    this.chrome = opts.chrome || findChrome();
    this.pageName = opts.page || 'index';
    this.log = opts.log || ((...a) => console.log(...a));
    this.peers = [];
  }

  /** Build the URL for a peer. `session:false` opens the app OUTSIDE any room. */
  urlFor(nick, { session = true, extra = '' } = {}) {
    const base = this.pageName === 'desktop'
      ? this.app.replace(/\/?$/, '/') + 'desktop.html'
      : this.app;
    const q = new URLSearchParams();
    if (session) q.set('session', this.room);
    q.set('server', this.ws);
    if (nick) q.set('nick', nick);
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}${q.toString()}${extra}`;
  }

  /**
   * Open a peer: a fresh browser process, navigated to the app, with
   * `__testApi.ready()` already awaited. `session:false` opens it solo (use
   * `peer.joinRoom()` later to exercise the in-app widget-join path, which is a
   * DIFFERENT code path from `?session=`).
   */
  async open(nick, { session = true, extra = '', readyMs = 90000, quiet = true } = {}) {
    const browser = await puppeteer.launch({
      executablePath: this.chrome,
      headless: !this.headed,
      args: LAUNCH_ARGS,
    });
    const page = await browser.newPage();
    const peer = new Peer({ name: nick, browser, page, harness: this });
    this.peers.push(peer);
    page.on('pageerror', (e) => {
      peer.pageErrors.push(String(e));
      this.log(`  [${nick}] PAGEERROR ${String(e).slice(0, 220)}`);
    });
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (/Failed to load resource/.test(t)) return;
      peer.consoleErrors.push(t);
      if (!quiet) this.log(`  [${nick}] ${t.slice(0, 220)}`);
    });
    await page.goto(this.urlFor(nick, { session, extra }), { waitUntil: 'load' });
    // The API object appears at module eval; ready() waits for the world.
    await page.waitForFunction(() => !!window.__testApi, { timeout: 30000 });
    await peer.ready({ timeoutMs: readyMs });
    if (session) await peer.waitFor(() => window.__testApi.session.state().connected,
      { timeoutMs: 25000, what: 'the room socket' });
    return peer;
  }

  /**
   * Open a peer and wait until it is the room HOST. Because the server elects by
   * seniority (first peer in wins, see server/Hub.js), opening the intended host
   * FIRST is the only deterministic way to fix the role — `becomeHost()` cannot
   * promote a junior peer in a server-elected room. Call this before open()ing
   * the watchers.
   */
  async openHost(nick, opts = {}) {
    const peer = await this.open(nick, opts);
    await peer.waitForHostElection({ timeoutMs: 25000 });
    if (!(await peer.isHost())) {
      throw new Error(`[${nick}] expected to be host but the room already had one — open the host FIRST`);
    }
    return peer;
  }

  /**
   * How similar are two peers' screens RIGHT NOW? Correlates their TV luma
   * signatures, sampling a few times and keeping the best, because WebRTC
   * latency puts the two grabs a frame or two apart and a moving game changes
   * between them.
   *
   * ≈1  → the same picture (what a working session must show).
   * ≈0  → unrelated pictures. THIS is the check that catches "each peer is
   *        running its own copy of the game", which every connection-count
   *        check passes happily.
   * null→ one side was blank; no evidence either way (do NOT read as a pass).
   */
  async samePicture(a, b, { tries = 6, everyMs = 400, tvA, tvB, ...opts } = {}) {
    let best = null;
    for (let i = 0; i < tries; i++) {
      try {
        const [sa, sb] = await Promise.all([a.sampleTv(tvA, opts), b.sampleTv(tvB, opts)]);
        const c = correlate(sa.sig, sb.sig);
        if (c != null && (best == null || c > best)) best = c;
      } catch (_) { /* blank / mid-reload — retry */ }
      if (i < tries - 1) await sleep(everyMs);
    }
    return best;
  }

  /** Same, but for 1-D profiles (sprite tracking) rather than the whole screen. */
  async sameProfile(a, b, { tries = 5, everyMs = 400, ...opts } = {}) {
    let best = null;
    for (let i = 0; i < tries; i++) {
      try {
        const [pa, pb] = await Promise.all([a.tvProfile(undefined, opts), b.tvProfile(undefined, opts)]);
        const c = correlate(pa.values, pb.values);
        if (c != null && (best == null || c > best)) best = c;
      } catch (_) { /* retry */ }
      if (i < tries - 1) await sleep(everyMs);
    }
    return best;
  }

  /**
   * Track a sprite's position along one axis on a peer's screen. Returns the
   * MEDIAN centroid over `samples` grabs, which rejects the frame-to-frame
   * jitter of a moving ball sharing the crop.
   */
  async spritePosition(peer, { samples = 5, everyMs = 90, minSpread = 6, ...opts } = {}) {
    const seen = [];
    for (let i = 0; i < samples; i++) {
      try {
        const p = await peer.tvProfile(undefined, opts);
        const c = brightCentroid(p.values, { minSpread });
        if (c != null) seen.push(c);
      } catch (_) { /* retry */ }
      if (i < samples - 1) await sleep(everyMs);
    }
    if (!seen.length) return null;
    seen.sort((x, y) => x - y);
    return seen[Math.floor(seen.length / 2)];
  }

  async closeAll() {
    await Promise.all(this.peers.map((p) => p.close()));
    this.peers = [];
  }
}

// ---------------------------------------------------------------------------
// Tiny assertion recorder — every script in scripts/ hand-rolls this one.
// ---------------------------------------------------------------------------

export function makeChecks({ log = console.log } = {}) {
  const state = { passed: 0, failed: 0, results: [] };
  const ok = (cond, msg, detail) => {
    const pass = !!cond;
    state.results.push({ pass, msg, detail: detail ?? null });
    if (pass) { state.passed++; log(`  ok   ${msg}`); }
    else { state.failed++; log(`  FAIL ${msg}${detail !== undefined && detail !== null ? ` — ${JSON.stringify(detail)}` : ''}`); }
    return pass;
  };
  const section = (title) => log(`\n--- ${title}`);
  const summary = () => {
    log(`\n${state.failed === 0 ? 'PASS' : 'FAIL'} — ${state.passed} passed, ${state.failed} failed`);
    return state.failed === 0;
  };
  return { ok, section, summary, state };
}
