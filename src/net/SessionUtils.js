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

// --- Randomness ------------------------------------------------------------
//
// SEC-5 (2026-08-14): everything below draws from the platform CSPRNG rather than
// Math.random(). It matters for stableSessionId() (see the long note there — that
// value is a host-reclaim bearer capability); the room suffix is only cosmetic,
// but it shares the helper so there is exactly one randomness path to audit.
//
// Source order, and WHY:
//   1. crypto.getRandomValues — the primitive, and the one source that is present
//      in an INSECURE context. We routinely test on a headset over plain http://
//      on the LAN (`$env:LAN=1; npm run dev`), where `crypto.randomUUID` is
//      undefined (secure-contexts only) while `getRandomValues` still works, so
//      this is the branch that actually runs on the device we test on. The order
//      is a preference, not a safety net: because branch 2 is gated on
//      `typeof c.randomUUID === 'function'`, swapping 1 and 2 would behave
//      identically in that insecure context — an earlier revision of this comment
//      claimed otherwise and was simply wrong (corrected 2026-08-15). We take the
//      primitive first because it is the direct byte source, with no UUID string
//      to parse back into bytes.
//   2. crypto.randomUUID — for a (hypothetical) context that has it and nothing
//      else, and as the degrade target if branch 1 throws. Each UUID carries 122
//      random bits; we consume its hex digits.
//   3. Math.random — NOT cryptographically strong. Only here so a context with no
//      `crypto` at all still boots instead of throwing; such a peer gets a
//      guessable sid, which is no worse than every peer got before this change.
const HEX = '0123456789abcdef';

/**
 * `n` bytes of randomness from the strongest source this context actually has.
 * Looked up per call (not cached at module load) so tests can substitute a
 * globalThis.crypto and observe that the value really comes from it.
 *
 * A FAILING CSPRNG DEGRADES, IT DOES NOT THROW (2026-08-15). Nothing this function
 * touches on the crypto object is outside a try: the `globalThis.crypto` accessor
 * read, the `typeof c.getRandomValues` / `typeof c.randomUUID` property reads and
 * the calls themselves are each inside a try/catch, and a failure falls through to
 * the next source, so the Math.random tail is always reachable. (The first revision
 * of this guard, 2026-08-15, wrapped only the two CALLS; a hardened realm whose
 * `crypto` accessor or property read throws still propagated, which is the same
 * import-time-crash shape the guard exists to prevent. Widened the same day.)
 *
 * Before any of this a throwing CSPRNG
 * propagated all the way out of randomRoomSuffix(), and src/main.js evaluates
 * that at MODULE SCOPE (`const _defaultNick = \`Player-${randomRoomSuffix()}\``),
 * so one throw was an import-time crash of the entire app rather than a degraded
 * id. stableSessionId() is likewise called unguarded from the NetMgr and
 * DesktopNet constructors. A conforming browser's getRandomValues only throws for
 * a >65536-byte buffer or a non-integer TypedArray (we ask for 8 or 16 bytes of
 * Uint8Array), so this is insurance against a broken/hardened environment, not a
 * path we expect to take — but "the whole app fails to import" is too steep a
 * price for a cosmetic room suffix.
 *
 * @param {number} n
 * @returns {Uint8Array}
 */
function randomBytes(n) {
  const out = new Uint8Array(n);
  // Even reading `globalThis.crypto` is inside the try: a hardened realm can
  // install a throwing accessor, and that throw would escape exactly like a
  // throwing getRandomValues() used to.
  let c = null;
  try { c = globalThis.crypto; } catch { c = null; }
  if (c) {
    try {
      // The `typeof` read is inside the try too — a throwing property getter on
      // the crypto object must degrade to the next source, not propagate.
      if (typeof c.getRandomValues === 'function') {
        c.getRandomValues(out);
        return out;
      }
    } catch { /* hardened/broken CSPRNG → try the next source below */ }
    try {
      if (typeof c.randomUUID === 'function') {
        let hex = '';
        while (hex.length < n * 2) hex += c.randomUUID().replace(/-/g, '');
        for (let i = 0; i < n; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        return out;
      }
    } catch { /* same → fall through to the weak-but-never-throwing last resort */ }
  }
  // Every byte is overwritten here, so a partial fill by a source that threw
  // mid-way cannot leak through. (Held to account by section 4b-v of
  // scripts/test-session-id.mjs: a stub that fills bytes with 0xfe and THEN
  // throws, with Math.random frozen, so the expected id is byte-exact and any
  // surviving stub byte fails it.)
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256) & 0xff;
  return out;
}

/**
 * `n` lowercase hex characters of randomness. Hex keeps the value URL-safe with
 * no escaping (the sid rides `?sid=` on the connect URL) and keeps the alphabet
 * fixed, so a length check is also an entropy check.
 *
 * @param {number} n  number of hex CHARACTERS (2 per byte; must be even)
 * @returns {string}
 */
function randomHex(n) {
  const b = randomBytes(Math.ceil(n / 2));
  let s = '';
  for (let i = 0; i < b.length; i++) s += HEX[b[i] >> 4] + HEX[b[i] & 0x0f];
  return s.slice(0, n);
}

const ROOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'; // 36 chars

/**
 * Generate a random room-name-safe suffix (4 lowercase alphanumeric chars).
 * Useful for auto-generating a default room when the user leaves the field blank.
 *
 * Not a secret — a room name is public by design — but it comes from the same
 * CSPRNG helper so there is no second, weaker randomness path in this module.
 * Rejection sampling (256 is not a multiple of 36) keeps the 36 characters
 * equally likely instead of biasing the first four. Section 7b of
 * scripts/test-session-id.mjs pins that: with a stubbed CSPRNG it asserts the
 * exact suffix for a byte stream containing tail bytes, so deleting the discard
 * (which would fold 252..255 onto 'a'..'d') changes the asserted string.
 *
 * @returns {string}  e.g. "k3f9"
 */
export function randomRoomSuffix() {
  let s = '';
  while (s.length < 4) {
    for (const b of randomBytes(8)) {
      if (b >= 252) continue;                 // 252 = 7 * 36 → discard the biased tail
      s += ROOM_ALPHABET[b % 36];
      if (s.length === 4) break;
    }
  }
  return s;
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

// The sid is a HOST-RECLAIM BEARER VALUE, not a display name (CODEX_REVIEW SEC-5,
// fixed 2026-08-14). It rides the room-server connect URL as `?sid=`, appended by
// NetMgr's `connect()` and DesktopNet's `connect()`, and server/Hub.js `connect()`
// hands the host role — and with it the running game, the shared screen and every
// host-only STATE key — straight back to whoever presents the departed host's sid
// inside HOST_RECLAIM_MS (`grace.sid === String(sid)`). Nothing else
// authenticates that claim.
//
// Anchors here are SYMBOL names on purpose: an earlier revision cited file:line
// and the numbers had already rotted by the time it was reviewed (2026-08-15).
//
// It used to be `Math.random().toString(36).slice(2,10) + Date.now().toString(36)`:
// ~40 bits from a non-CSPRNG PRNG whose internal state is recoverable from a
// couple of outputs, glued to a millisecond timestamp that anyone who saw the
// victim join could reconstruct outright. Now: 128 CSPRNG bits, hex-encoded.
//
// 16 bytes → 32 hex chars, so `sid-` + 32 = 36 characters. The server truncates
// anything longer than its `SID_MAX_LEN` (`envInt('ROOM_MAX_SID_LEN', 64)` in
// server/room-server.mjs) before comparing, so the whole id has to fit under that
// bound or a reclaim would silently compare truncated prefixes. 36 leaves plenty
// of headroom, and scripts/test-session-id.mjs parses that default out of the
// real server source rather than hardcoding 64. What that buys is precisely one
// thing: lowering the default BELOW the 36-character id length fails the test
// (measured 2026-08-15 — 40 and 36 stay green, 30 prints
// `FAIL: every id fits ROOM_MAX_SID_LEN=30`). It is a "the id still fits" guard,
// not a "the default is still 64" guard; an earlier revision of this comment said
// "lowering it fails the test" flatly, which overstated it.
const SID_BYTES = 16;
const SID_RE = /^sid-[0-9a-f]{32}$/;   // exactly what mintSessionId() produces

const mintSessionId = () => `sid-${randomHex(SID_BYTES * 2)}`;

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
 * UPGRADE PATH (deliberate, SEC-5): a stored id is reused only if it still looks
 * like a current-format id. A legacy Math.random()+Date.now() id — or any
 * corrupted/oversized value — is REPLACED on first load rather than honoured,
 * because honouring it would leave the guessable bearer alive for the lifetime of
 * that tab and the fix would do nothing for anyone already running. The cost of
 * rotating is bounded and tiny: the sid only means anything inside the server's
 * HOST_RECLAIM_MS window, so at worst one reload that happened to be mid-reclaim
 * at upgrade time migrates the host to a peer instead of reclaiming. No user
 * state, save data or room membership is tied to the sid.
 *
 * @returns {string}
 */
export function stableSessionId() {
  try {
    const s = globalThis.sessionStorage;
    if (s) {
      const stored = s.getItem(SID_KEY);
      if (stored && SID_RE.test(stored)) return stored;
      const id = mintSessionId();
      s.setItem(SID_KEY, id);
      return id;
    }
  } catch { /* sessionStorage blocked → in-memory fallback below */ }
  if (!_memSid) _memSid = mintSessionId();
  return _memSid;
}
