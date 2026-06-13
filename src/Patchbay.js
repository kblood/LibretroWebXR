// Patchbay: the AV rack as a pure, typed patch graph — which controller is
// plugged into which console port (→ player), and which console feeds which TV.
//
// This generalizes [[src/CableMgr.js]] (one console: gamepad→port→player) to the
// EmuVR-style multi-console rack: many consoles each with their own controller
// ports AND a video-out, many TVs each with a video-in. It stays pure — no
// THREE, no DOM — so the npm-test harness exercises the real wiring logic
// (scripts/test-patchbay.mjs). The 3D side ([[src/GrabMgr.js]] plug/seat on
// release, [[src/Cord.js]] tubes, [[src/Console.js]] port sockets, the future
// [[src/TV.js]]) calls the mutators; the runtime side ([[src/RackMgr.js]],
// per-console [[src/GameInputMgr.js]]) reads the queries.
//
// Edge types:
//   • controller → console[port]   (couch-co-op input; port index → player N)
//   • console     → tv             (video; one source feeds one-or-many TVs)
//
// Invariants enforced by the mutators:
//   • a controller drives at most one console port (re-plug moves it)
//   • a console port holds at most one controller (re-plug evicts the prior)
//   • a TV samples at most one console (re-connect swaps its source)
//   • a console may fan its video out to several TVs (a splitter is legal)
// Port→player is fixed: port 0 = player 1, port 1 = player 2, … matching
// EXTRA_PLAYER_KEYS in [[src/ControllerMaps.js]].

import { MAX_PORTS } from './systems.js';

/** port index (0-based) → player number (1-based). */
export function playerForPort(port) {
  return port + 1;
}

export class Patchbay {
  constructor() {
    // node registries
    this._consoles = new Map();    // consoleId -> { ports }
    this._tvs = new Set();         // tvId
    this._controllers = new Set(); // controllerId

    // controller edges
    this._ctrlPlug = new Map();    // controllerId -> { consoleId, port }
    this._portOcc = new Map();     // `${consoleId}#${port}` -> controllerId

    // video edges
    this._tvSource = new Map();    // tvId -> consoleId   (a TV samples ≤1 console)
    this._consoleTvs = new Map();  // consoleId -> Set<tvId>
  }

  _portKey(consoleId, port) { return `${consoleId}#${port}`; }

  // ---- node lifecycle ----

  // Register a console with a fixed number of controller ports (clamped to the
  // hardware ceiling). Re-adding an existing console only updates its port count
  // and prunes any now-out-of-range controller plugs.
  addConsole(consoleId, { ports = MAX_PORTS } = {}) {
    if (consoleId == null) return null;
    const limit = Math.max(0, Math.min(MAX_PORTS, ports | 0));
    this._consoles.set(consoleId, { ports: limit });
    if (!this._consoleTvs.has(consoleId)) this._consoleTvs.set(consoleId, new Set());
    // Drop controllers seated in ports that no longer exist.
    for (const [cid, plug] of [...this._ctrlPlug]) {
      if (plug.consoleId === consoleId && plug.port >= limit) this.unplugController(cid);
    }
    return consoleId;
  }

  addTV(tvId) {
    if (tvId == null) return null;
    this._tvs.add(tvId);
    return tvId;
  }

  addController(controllerId) {
    if (controllerId == null) return null;
    this._controllers.add(controllerId);
    return controllerId;
  }

  // Remove a console and every edge touching it (controller plugs + TV feeds).
  removeConsole(consoleId) {
    for (const [cid, plug] of [...this._ctrlPlug]) {
      if (plug.consoleId === consoleId) this.unplugController(cid);
    }
    for (const tvId of [...(this._consoleTvs.get(consoleId) || [])]) {
      this.disconnectVideo(tvId);
    }
    this._consoleTvs.delete(consoleId);
    this._consoles.delete(consoleId);
  }

  removeTV(tvId) {
    this.disconnectVideo(tvId);
    this._tvs.delete(tvId);
  }

  removeController(controllerId) {
    this.unplugController(controllerId);
    this._controllers.delete(controllerId);
  }

  // ---- controller ⇄ console port ----

  // Plug a controller into a console port. A controller occupies one port and a
  // port holds one controller, so any prior tenancy on either side is cleared
  // first. The controller and console are auto-registered if unseen (keeps the
  // 3D callers simple). Returns { consoleId, port } or null if invalid.
  plugController(controllerId, consoleId, port) {
    if (controllerId == null || consoleId == null) return null;
    if (!this._consoles.has(consoleId)) this.addConsole(consoleId);
    this._controllers.add(controllerId);
    const { ports } = this._consoles.get(consoleId);
    if (!Number.isInteger(port) || port < 0 || port >= ports) return null;

    this.unplugController(controllerId);          // leave any old port
    const key = this._portKey(consoleId, port);
    const prev = this._portOcc.get(key);          // evict any current occupant
    if (prev != null) this._ctrlPlug.delete(prev);
    this._ctrlPlug.set(controllerId, { consoleId, port });
    this._portOcc.set(key, controllerId);
    return { consoleId, port };
  }

  // Remove a controller from whatever port it's in (no-op if unplugged).
  unplugController(controllerId) {
    const plug = this._ctrlPlug.get(controllerId);
    if (!plug) return;
    this._ctrlPlug.delete(controllerId);
    this._portOcc.delete(this._portKey(plug.consoleId, plug.port));
  }

  /** { consoleId, port } a controller is plugged into, or null. */
  portOf(controllerId) {
    return this._ctrlPlug.get(controllerId) || null;
  }

  /** { consoleId, player } a controller drives, or null if unplugged. */
  playerOf(controllerId) {
    const plug = this._ctrlPlug.get(controllerId);
    if (!plug) return null;
    return { consoleId: plug.consoleId, player: playerForPort(plug.port) };
  }

  /** controllerId seated in a given console port, or null. */
  occupantOf(consoleId, port) {
    const c = this._portOcc.get(this._portKey(consoleId, port));
    return c == null ? null : c;
  }

  isPortFree(consoleId, port) {
    return !this._portOcc.has(this._portKey(consoleId, port));
  }

  // Lowest free port index on a console, or null if full / unknown console.
  // `maxPorts` optionally restricts below the console's registered port count —
  // used when a system temporarily enables fewer ports than the hardware
  // ceiling (the console stays registered at full width so seated controllers
  // are never pruned, but new ones only seat within the enabled range).
  firstFreePort(consoleId, maxPorts = Infinity) {
    const meta = this._consoles.get(consoleId);
    if (!meta) return null;
    const limit = Math.min(meta.ports, Math.max(0, maxPorts));
    for (let p = 0; p < limit; p++) {
      if (this.isPortFree(consoleId, p)) return p;
    }
    return null;
  }

  // Controllers seated on a console, lowest port first:
  // [{ controllerId, port, player }].
  controllersOf(consoleId) {
    const meta = this._consoles.get(consoleId);
    if (!meta) return [];
    const out = [];
    for (let p = 0; p < meta.ports; p++) {
      const cid = this.occupantOf(consoleId, p);
      if (cid != null) out.push({ controllerId: cid, port: p, player: playerForPort(p) });
    }
    return out;
  }

  // ---- console → TV (video) ----

  // Route a console's video to a TV. A TV samples exactly one console, so its
  // prior source (if any) is detached first. Nodes are auto-registered. Returns
  // { consoleId, tvId } or null if invalid.
  connectVideo(consoleId, tvId) {
    if (consoleId == null || tvId == null) return null;
    if (!this._consoles.has(consoleId)) this.addConsole(consoleId);
    this._tvs.add(tvId);
    this.disconnectVideo(tvId);                   // a TV shows one console at a time
    this._tvSource.set(tvId, consoleId);
    this._consoleTvs.get(consoleId).add(tvId);
    return { consoleId, tvId };
  }

  // Detach whatever console is feeding a TV (no-op if none).
  disconnectVideo(tvId) {
    const consoleId = this._tvSource.get(tvId);
    if (consoleId == null) return;
    this._tvSource.delete(tvId);
    this._consoleTvs.get(consoleId)?.delete(tvId);
  }

  /** consoleId feeding a TV, or null. */
  sourceOf(tvId) {
    const c = this._tvSource.get(tvId);
    return c == null ? null : c;
  }

  /** TVs displaying a console's video, lowest-insertion-first as an array. */
  displaysOf(consoleId) {
    return [...(this._consoleTvs.get(consoleId) || [])];
  }

  // ---- node listings ----

  consoles() { return [...this._consoles.keys()]; }
  tvs() { return [...this._tvs]; }
  controllers() { return [...this._controllers]; }
  portsOf(consoleId) { return this._consoles.get(consoleId)?.ports ?? null; }
}
