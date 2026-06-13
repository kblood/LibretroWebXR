// RoomPersistence — pure helpers for persisting and restoring the room layout.
// No THREE, no DOM. Two storage slots:
//   localStorage  key: libretrowebxr.lastRoom  — survives page closes (Goal B)
//   sessionStorage key: libretrowebxr.savedRoom — survives same-tab reloads only,
//       used to bridge a cross-core reload (Goal A) without touching the long-term save.
//
// Escape hatch: callers may pass ?room=default in the URL to skip both stores
// (handled in main.js resolveWorld; this module is purely storage I/O).

export const LAST_ROOM_KEY  = 'libretrowebxr.lastRoom';   // localStorage
export const ROOM_BRIDGE_KEY = 'libretrowebxr.savedRoom'; // sessionStorage

// --- localStorage (Goal B: auto-load last saved room) ----------------------

/**
 * Persist a serialized room JSON string to localStorage.
 * Silently no-ops if storage is unavailable (private mode, quota exceeded).
 * @param {string} json  the result of JSON.stringify(editor.serialize())
 */
export function saveLastRoom(json) {
  if (typeof json !== 'string' || !json) return;
  try { localStorage.setItem(LAST_ROOM_KEY, json); }
  catch (e) { console.warn('[RoomPersistence] localStorage write failed:', e); }
}

/**
 * Load the last persisted room JSON from localStorage.
 * Returns the parsed object, or null if nothing is saved / parse fails.
 * Pure: callers decide what to do with it (pass to parseRoom).
 */
export function loadLastRoom() {
  try {
    const raw = localStorage.getItem(LAST_ROOM_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[RoomPersistence] localStorage read/parse failed:', e);
    return null;
  }
}

/**
 * Clear the persisted room from localStorage.
 * Use to reset to default (escape hatch) or after a corrupt save.
 */
export function clearLastRoom() {
  try { localStorage.removeItem(LAST_ROOM_KEY); }
  catch (e) { /* swallow — read-only storage */ }
}

// --- sessionStorage (Goal A: cross-core reload bridge) ---------------------

/**
 * Stash a serialized room JSON string in sessionStorage so it survives the
 * location.reload() triggered by a cross-core ROM swap. Call this immediately
 * before the reload. The stash is one-time-read: resumeRoomBridge() consumes it.
 * @param {string} json
 */
export function stashRoomBridge(json) {
  if (typeof json !== 'string' || !json) return;
  try { sessionStorage.setItem(ROOM_BRIDGE_KEY, json); }
  catch (e) { console.warn('[RoomPersistence] sessionStorage stash failed:', e); }
}

/**
 * Consume the cross-core-reload bridge stash from sessionStorage.
 * Returns the parsed object, or null. Clears the key on read so it's one-shot.
 */
export function consumeRoomBridge() {
  try {
    const raw = sessionStorage.getItem(ROOM_BRIDGE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(ROOM_BRIDGE_KEY);
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[RoomPersistence] sessionStorage bridge read/parse failed:', e);
    return null;
  }
}

// --- Guards ----------------------------------------------------------------

/**
 * Quick sanity check: does `obj` look like a parsed room descriptor?
 * Rejects null, non-objects, and anything lacking `props` or `schema`.
 * Used to guard against a localStorage value that was corrupted or from an
 * incompatible future schema version.
 */
export function looksLikeRoom(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (!Array.isArray(obj.props)) return false;
  // Accept any libretrowebxr/room@N schema so minor bumps still load.
  const schema = typeof obj.schema === 'string' ? obj.schema : '';
  return schema.startsWith('libretrowebxr/room');
}
