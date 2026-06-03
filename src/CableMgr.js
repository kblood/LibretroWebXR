// CableMgr: the local-multiplayer "cable system" — which gamepad is plugged
// into which console port, and therefore which player number it drives.
//
// Pure bookkeeping, no THREE / no DOM, so it unit-tests in the npm-test
// harness. The 3D side ([[src/GrabMgr.js]] plug-on-release, [[src/Console.js]]
// port sockets) calls plug/unplug; the input side ([[src/GameInputMgr.js]] via
// main.js's getRouting) reads playerOf() to know which player's RetroPad keys a
// held gamepad should send. Port→player is fixed: port 0 = player 1, port 1 =
// player 2, … (see EXTRA_PLAYER_KEYS in [[src/ControllerMaps.js]] for the
// keyboard binds players 2-4 ultimately dispatch).

import { MAX_PORTS } from './systems.js';

/** port index (0-based) → player number (1-based). */
export function playerForPort(port) {
  return port + 1;
}

export class CableMgr {
  constructor() {
    this._portOf = new Map();   // gamepadId -> port index
    this._byPort = new Map();   // port index -> gamepadId
  }

  // Plug a gamepad into a port. A gamepad can occupy only one port and a port
  // only one gamepad, so any prior tenancy on either side is cleared first.
  // Returns the port, or null if the port index is out of range.
  plug(gamepadId, port) {
    if (gamepadId == null) return null;
    if (!Number.isInteger(port) || port < 0 || port >= MAX_PORTS) return null;
    this.unplug(gamepadId);                 // this gamepad leaves its old port
    const prev = this._byPort.get(port);    // evict whoever was in this port
    if (prev != null) this._portOf.delete(prev);
    this._portOf.set(gamepadId, port);
    this._byPort.set(port, gamepadId);
    return port;
  }

  // Remove a gamepad from whatever port it's in (no-op if unplugged).
  unplug(gamepadId) {
    const port = this._portOf.get(gamepadId);
    if (port == null) return;
    this._portOf.delete(gamepadId);
    this._byPort.delete(port);
  }

  /** Port index a gamepad is plugged into, or null. */
  portOf(gamepadId) {
    const p = this._portOf.get(gamepadId);
    return p == null ? null : p;
  }

  /** Player number a gamepad drives (port+1), or 1 if unplugged. */
  playerOf(gamepadId) {
    const p = this._portOf.get(gamepadId);
    return p == null ? 1 : playerForPort(p);
  }

  /** gamepadId in a given port, or null. */
  occupantOf(port) {
    const g = this._byPort.get(port);
    return g == null ? null : g;
  }

  isPortFree(port) {
    return !this._byPort.has(port);
  }

  // Lowest free port index in [0, maxPorts), or null if all are taken.
  // maxPorts clamps to the hardware ceiling so a 2-port system never hands out
  // port 2/3.
  firstFreePort(maxPorts = MAX_PORTS) {
    const limit = Math.max(0, Math.min(MAX_PORTS, maxPorts));
    for (let p = 0; p < limit; p++) {
      if (!this._byPort.has(p)) return p;
    }
    return null;
  }
}
