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
