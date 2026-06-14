// PropSync: pure helpers for shared room-prop EXISTENCE + PLACEMENT sync over
// the STATE channel. When a peer adds a poster/console/TV, moves a prop in the
// in-VR editor, or removes one, the change is broadcast as a `prop:<id>` STATE
// key so all current and future peers converge to the same room layout.
//
// ID scheme:
//   - Peer-spawned props (added at runtime via the editor Add menu):
//       `prop-<selfId>-<n>` — globally unique across peers (a bare counter
//       would collide when two peers add props simultaneously, exactly like
//       gamepad ids in GamepadSync.js).
//   - Built-in room props (loaded from room.json at startup):
//       their existing descriptor `id` (e.g. `poster-1`, `console-1`). All
//       peers parse the same room file so these are deterministic and shared.
//
// Payload (stored as STATE value):
//   { type, pos[3], rot[3], ...typeSpecificFields }
//   where pos is [x,y,z] in metres and rot is [x,y,z] in DEGREES (Euler XYZ).
//   Type-specific fields:
//     poster  → texture, size?, fit?, scale?
//     console → (none beyond pos/rot for physical placement)
//     tv      → (pos/rot only — TV mesh exists on every peer from the room)
//     others  → (pos/rot only — just physical placement)
//
// A null value clears the key (prop removed).
//
// Disconnect policy: `prop:` keys are NOT auto-cleared by the Hub when the
// setter disconnects. Room layout is persistent shared state — like the `tv`
// game state, it should survive a peer leaving. A peer that adds a poster and
// leaves should NOT cause the poster to vanish for everyone else. This is the
// correct EmuVR-room-layout semantics and contrasts with the ephemeral
// `hold:` / `gamepad:` keys that clean up when their owner departs.
//
// Echo guard: the reconciler sets object.userData._propSyncApplying = true
// while applying a remote transform, and clears it after. The main.js
// onEditRelease broadcast checks this flag and skips re-broadcasting a
// position that just arrived from the network (last-writer-wins is already
// guaranteed by the server; we only want to broadcast OUR own moves).
//
// Mirror of [[src/net/GamepadSync.js]]: pure + unit-tested (no THREE/DOM).

export const PROP_STATE_PREFIX = 'prop:';

/** STATE key for a room prop. */
export function makePropStateKey(propId) {
  return `${PROP_STATE_PREFIX}${propId}`;
}

/** True if a STATE key is a prop sync key. */
export function isPropStateKey(key) {
  return typeof key === 'string' && key.startsWith(PROP_STATE_PREFIX);
}

/** Extract the propId from a prop state key, or null. */
export function propIdFromStateKey(key) {
  if (!isPropStateKey(key)) return null;
  return key.slice(PROP_STATE_PREFIX.length);
}

/**
 * Build a globally-unique propId for a peer-spawned prop.
 * selfId: the peer's server-assigned id; counter: a local integer that
 * increments each time THIS peer adds a prop.
 * Returns a string like `prop-<selfId>-<counter>`.
 */
export function makePeerPropId(selfId, counter) {
  const safe = String(selfId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `prop-${safe}-${counter}`;
}

/**
 * Build the STATE payload for a prop's current position+type.
 * `prop` is the descriptor (from RoomLoader/PropCreator); `object` is the live
 * THREE Object3D whose current world position and rotation are the source of
 * truth after the editor has snapped it.
 *
 * We extract position from the object and convert rotation from radians to
 * degrees (matching the room.json convention). Additional type-specific fields
 * (texture, size, fit, scale) are carried through from the descriptor so a
 * remote peer can reconstruct the prop fully via buildProp.
 *
 * `roundTo` rounds coordinates to the given decimal places (3 = millimetre
 * precision, plenty for room layout). Non-finite values become 0.
 */
export function serializePropState(prop, object, { roundTo = 3 } = {}) {
  const f = 10 ** roundTo;
  const r = (n) => (Number.isFinite(n) ? Math.round(n * f) / f + 0 : 0);
  const RAD2DEG = 180 / Math.PI;

  const pos = [
    r(object.position.x),
    r(object.position.y),
    r(object.position.z),
  ];
  const rot = [
    r(object.rotation.x * RAD2DEG),
    r(object.rotation.y * RAD2DEG),
    r(object.rotation.z * RAD2DEG),
  ];

  const payload = { type: prop.type, pos, rot };

  // Carry type-specific authored fields so a remote peer can reconstruct.
  if (prop.type === 'poster') {
    if (prop.texture   !== undefined) payload.texture   = prop.texture;
    if (prop.size      !== undefined) payload.size      = prop.size;
    if (prop.fit       !== undefined) payload.fit       = prop.fit;
    if (prop.scale     !== undefined) payload.scale     = prop.scale;
    if (prop.imageFile !== undefined) payload.imageFile = prop.imageFile; // FIX 3c: persist source filename
  }
  // console: no extra fields needed (physical mesh only, game does not sync here)
  // tv: no extra fields — TV mesh exists on all peers from room.json
  // shelf/bookcase/cupboard/table: no extra fields needed for placement sync

  return payload;
}

/**
 * Parse `prop:*` entries from the RoomObjects state snapshot.
 * Returns an array of { propId, payload } for every key with a non-null value.
 */
export function parsePropEntries(entries) {
  const result = [];
  for (const [key, value] of entries) {
    if (!isPropStateKey(key)) continue;
    if (!value || typeof value !== 'object') continue;
    if (typeof value.type !== 'string') continue;
    const propId = propIdFromStateKey(key);
    if (propId) result.push({ propId, payload: value });
  }
  return result;
}

/**
 * Compute the diff between desired prop state (from parsePropEntries) and the
 * locally-known prop set. Returns:
 *   { toCreate, toUpdate, toRemove }
 * where:
 *   toCreate  — [{ propId, payload }] props that exist remotely but not locally
 *   toUpdate  — [{ propId, payload }] props that exist on both sides and whose
 *               state (position or descriptor) has changed
 *   toRemove  — [propId] props that exist locally but were cleared remotely
 *
 * `localProps` is a Map<propId, serializedPayload> — the caller provides the
 * current known state for each local prop (or the last synced payload). This
 * lets the diff detect moves (same propId, different pos/rot) versus the first
 * time a prop is seen.
 *
 * `staticIds` is an optional Set of propIds that were in the ORIGINAL room.json
 * (every peer already has them). These can receive toUpdate diffs but should
 * NEVER appear in toCreate or toRemove (removing a built-in TV/console from the
 * descriptor would break things — we only move them).
 */
export function diffPropSync({ desired, localProps, staticIds = new Set() }) {
  const desiredMap = new Map(desired.map((d) => [d.propId, d.payload]));
  const localMap = localProps instanceof Map ? localProps : new Map(localProps);

  const toCreate = [];
  const toUpdate = [];
  const toRemove = [];

  for (const { propId, payload } of desired) {
    if (localMap.has(propId)) {
      // Already known locally — check if transform/descriptor changed.
      const prev = localMap.get(propId);
      if (JSON.stringify(prev) !== JSON.stringify(payload)) {
        toUpdate.push({ propId, payload });
      }
    } else {
      // New prop we haven't seen yet.
      if (!staticIds.has(propId)) {
        toCreate.push({ propId, payload });
      } else {
        // Static prop that another peer moved — we treat as update (first sync).
        toUpdate.push({ propId, payload });
      }
    }
  }

  for (const propId of localMap.keys()) {
    if (!desiredMap.has(propId) && !staticIds.has(propId)) {
      // Cleared remotely and not a static prop → remove locally.
      toRemove.push(propId);
    }
  }

  return { toCreate, toUpdate, toRemove };
}
