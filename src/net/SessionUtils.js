// SessionUtils: pure helpers for multiplayer session/room management.
// No DOM, no THREE, no socket — importable in Node for unit tests.

/**
 * Sanitise a room name: trim whitespace, collapse runs of characters that
 * are not alphanumeric / dash / underscore into a single dash, strip leading
 * and trailing dashes, and truncate to 40 characters.
 *
 * Returns null for empty or blank input so callers can substitute a default.
 *
 * @param {string} raw
 * @returns {string|null}
 */
export function sanitiseRoom(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || null;
}

/**
 * Generate a random room-name-safe suffix (4 lowercase alphanumeric chars).
 * Useful for auto-generating a default room when the user leaves the field blank.
 *
 * @returns {string}  e.g. "k3f9"
 */
export function randomRoomSuffix() {
  return Math.random().toString(36).slice(2, 6);
}

const SID_KEY = 'libretrowebxr.sid';
let _memSid = null;

/**
 * A stable per-tab session id, persisted in sessionStorage so it SURVIVES a
 * page reload but is unique per browser tab/window (two tabs on the same
 * machine are two distinct players).
 *
 * Used only for M1.4 host reclaim: the room server remembers the departing
 * host's sid for HOST_RECLAIM_MS, so the app's own cross-core `location.reload()`
 * doesn't hand the host role — and with it the running game — to a peer that has
 * nothing booted. Falls back to an in-memory id when sessionStorage is
 * unavailable (private mode, Node tests).
 *
 * @returns {string}
 */
export function stableSessionId() {
  try {
    const s = globalThis.sessionStorage;
    if (s) {
      let id = s.getItem(SID_KEY);
      if (!id) { id = `sid-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`; s.setItem(SID_KEY, id); }
      return id;
    }
  } catch { /* sessionStorage blocked → in-memory fallback below */ }
  if (!_memSid) _memSid = `sid-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  return _memSid;
}
