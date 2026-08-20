// GhostLightGunMgr: COMPATIBILITY SHIM (CLAUDE_REVIEW §3.3).
//
// The implementation moved to [[src/GhostPeripheralMgr.js]] (one manager for
// all three port-bound peripherals) and the gun's per-device facts — mesh
// factory, ghost offsets, translucent tint, the `gun:` hold-key prefix, and the
// deliberate scope limit that a remote gun's trigger-pull is NOT mirrored —
// moved to the LIGHTGUN descriptor in [[src/CabledPeripheral.js]]. Nothing
// about the wire format, the aim tracking or the visuals changed.
//
// This file stays for one release so existing importers (and
// scripts/test-lightgun-share.mjs / scripts/test-session-lifecycle.mjs) keep
// their subject. Delete it once those have moved to the descriptor API.

import { LIGHTGUN, makeHoldKeyFor, isHoldKeyFor, cableIdFromHoldKeyFor } from './CabledPeripheral.js';
import { GhostPeripheralMgr } from './GhostPeripheralMgr.js';

/** @deprecated use LIGHTGUN.holdKeyPrefix */
export const GUN_HOLD_PREFIX = LIGHTGUN.holdKeyPrefix;

/** STATE key for holding the gun with the given cableId. */
export function makeGunHoldKey(cableId) {
  return makeHoldKeyFor(LIGHTGUN, cableId);
}

/** True if a STATE key refers to a held light gun. */
export function isGunHoldKey(key) {
  return isHoldKeyFor(LIGHTGUN, key);
}

/** Extract the cableId from a gun hold key, or null. */
export function cableIdFromGunHoldKey(key) {
  return cableIdFromHoldKeyFor(LIGHTGUN, key);
}

/** @deprecated use `new GhostPeripheralMgr(LIGHTGUN, { avatars, objs })`. */
export class GhostLightGunMgr extends GhostPeripheralMgr {
  constructor({ avatars, lightGunObjs }) {
    super(LIGHTGUN, { avatars, objs: lightGunObjs });
    this.lightGunObjs = lightGunObjs;   // kept: the old public field name
  }
}
