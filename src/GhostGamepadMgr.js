// GhostGamepadMgr: COMPATIBILITY SHIM (CLAUDE_REVIEW §3.3).
//
// The implementation moved to [[src/GhostPeripheralMgr.js]] (one manager for
// all three port-bound peripherals) and the gamepad's per-device facts — mesh
// factory, ghost offsets, the per-player emissive tint, the `gp:` hold-key
// prefix — moved to the GAMEPAD descriptor in [[src/CabledPeripheral.js]].
// Nothing about the wire format or the visuals changed.
//
// This file stays for one release so existing importers (and
// scripts/test-session-lifecycle.mjs, which asserts every manager main.js
// registers a cleanup for really has removeAll()) keep their subject. Delete it
// once those have moved to the descriptor API.

import { GAMEPAD, makeHoldKeyFor, isHoldKeyFor, cableIdFromHoldKeyFor } from './CabledPeripheral.js';
import { GhostPeripheralMgr } from './GhostPeripheralMgr.js';

/** @deprecated use GAMEPAD.holdKeyPrefix */
export const GP_HOLD_PREFIX = GAMEPAD.holdKeyPrefix;

/** STATE key for holding gamepad with the given cableId. */
export function makeGamepadHoldKey(cableId) {
  return makeHoldKeyFor(GAMEPAD, cableId);
}

/** True if a STATE key refers to a held gamepad. */
export function isGamepadHoldKey(key) {
  return isHoldKeyFor(GAMEPAD, key);
}

/** Extract the cableId from a gamepad hold key, or null. */
export function cableIdFromHoldKey(key) {
  return cableIdFromHoldKeyFor(GAMEPAD, key);
}

/** @deprecated use `new GhostPeripheralMgr(GAMEPAD, { avatars, objs })`. */
export class GhostGamepadMgr extends GhostPeripheralMgr {
  constructor({ avatars, gamepadObjs }) {
    super(GAMEPAD, { avatars, objs: gamepadObjs });
    this.gamepadObjs = gamepadObjs;   // kept: the old public field name
  }
}
