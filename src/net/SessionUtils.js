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

// --- Avatar spawn seats ----------------------------------------------------
//
// Every peer used to build its world with the player rig at the SAME room origin
// (SceneMgr's `playerRig.position.set(0, 0, 1.5)`), and poses go out in world
// space — so a remote peer's avatar head/visor plane materialised exactly at the
// watcher's own camera and occluded most of the TV it had just joined to watch.
// It reads as "the shared screen is broken" on a headset; it was catalogued as a
// known cosmetic trap in docs/MULTIPLAYER.md and docs/HANDOFF.md (M1.4c) for
// exactly that reason.
//
// The fix is a small deterministic per-seat offset, keyed on join order
// (seniority = how many peers were already in the room when we arrived, which is
// also how the server picks the host). Seat 0 — the senior peer / host — keeps
// the canonical origin, so solo play and every existing single-peer expectation
// are byte-identical; each later joiner takes the next spot in an alternating
// left/right arc that fans out in front of the screen.
//
// Not a seating algorithm: no collision checks, no furniture awareness, no
// re-seating when someone leaves. Just "don't stand inside each other by
// default". Locomotion (src/LocomotionMgr.js) still moves anyone anywhere.
const SEAT_STEP_X = 0.75;   // m sideways per ring
const SEAT_STEP_Z = 0.30;   // m backwards per ring (fanning out from the screen)
const SEAT_RINGS  = 3;      // rings before the pattern wraps (keeps |x| ≤ 2.25 in a 6 m room)
const SEAT_WRAP_Z = 0.45;   // extra m back per wrap, so seat 1 and seat 7 don't collide

/**
 * Deterministic spawn offset for the `index`-th peer to join a room, as
 * `[dx, dy, dz]` metres to ADD to the room's default rig position.
 *
 * Seat 0 → `[0, 0, 0]`. Odd seats go left, even seats right, stepping further
 * out and back every pair. Pure: same index ⇒ same offset, on every peer, so two
 * clients agree on where everyone stands without exchanging seat assignments.
 *
 * @param {number} index  join order / seniority (0 = the room's senior peer)
 * @returns {[number, number, number]}
 */
export function spawnSeatOffset(index) {
  const i = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
  if (i === 0) return [0, 0, 0];
  const pair = Math.ceil(i / 2) - 1;             // 0,0,1,1,2,2,…
  const ring = (pair % SEAT_RINGS) + 1;          // 1..SEAT_RINGS
  const wrap = Math.floor(pair / SEAT_RINGS);    // how many times the arc wrapped
  const side = (i % 2 === 1) ? -1 : 1;           // odd → left, even → right
  return [side * SEAT_STEP_X * ring, 0, SEAT_STEP_Z * ring + wrap * SEAT_WRAP_Z];
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
