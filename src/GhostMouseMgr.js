// GhostMouseMgr: COMPATIBILITY SHIM (CLAUDE_REVIEW §3.3).
//
// The implementation moved to [[src/GhostPeripheralMgr.js]] (one manager for
// all three port-bound peripherals) and the mouse's per-device facts — mesh
// factory, ghost offsets, translucent tint, the `mouse:` hold-key prefix, and
// the deliberate scope limit that a remote peer's live cursor motion is NOT
// mirrored — moved to the MOUSE descriptor in [[src/CabledPeripheral.js]].
// Nothing about the wire format or the visuals changed. This file was itself
// the third copy of the manager, which is what §3.3 was about.
//
// It stays for one release so existing importers (and
// scripts/test-session-lifecycle.mjs) keep their subject. Delete it once those
// have moved to the descriptor API.

import { MOUSE, makeHoldKeyFor, isHoldKeyFor, cableIdFromHoldKeyFor } from './CabledPeripheral.js';
import { GhostPeripheralMgr } from './GhostPeripheralMgr.js';

/** @deprecated use MOUSE.holdKeyPrefix */
export const MOUSE_HOLD_PREFIX = MOUSE.holdKeyPrefix;

/** STATE key for holding the mouse with the given cableId. */
export function makeMouseHoldKey(cableId) {
  return makeHoldKeyFor(MOUSE, cableId);
}

/** True if a STATE key refers to a held mouse. */
export function isMouseHoldKey(key) {
  return isHoldKeyFor(MOUSE, key);
}

/** Extract the cableId from a mouse hold key, or null. */
export function cableIdFromMouseHoldKey(key) {
  return cableIdFromHoldKeyFor(MOUSE, key);
}

/** @deprecated use `new GhostPeripheralMgr(MOUSE, { avatars, objs })`. */
export class GhostMouseMgr extends GhostPeripheralMgr {
  constructor({ avatars, mouseObjs }) {
    super(MOUSE, { avatars, objs: mouseObjs });
    this.mouseObjs = mouseObjs;   // kept: the old public field name
  }
}
