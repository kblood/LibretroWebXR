// Placement — pure, THREE-free surface-snapping for the in-VR room editor.
//
// Provides:
//   • ROOM_BOUNDS / roomBoundsFromDims() — room inner-extent model
//   • RESTING_Y / WALL_OFFSET            — per-kind surface constants
//   • clampToRoom(pos, bounds, margin)   — push a point inside the inner walls
//   • snapToSurface(pos, bounds, kind)   — floor or wall snap + facing yaw
//
// NO THREE.js imports — this module runs in Node (npm test) and the browser.
// Callers that need THREE vectors pass plain {x,y,z}; we return plain objects.
//
// Surface-snap coexists with the existing free/grid snap in RoomEditor:
//   – "Snap: grid" (editor._snap) quantises X/Z/Y to 0.1 m / 15° increments.
//   – "Surface snap" (editor._surfaceSnap) additionally pins floor or wall Y,
//     chosen independently by the user via a separate toggle in the Move panel.
// Neither disables the other; both can be on simultaneously.

// ---------------------------------------------------------------------------
// Per-kind surface rules
// ---------------------------------------------------------------------------

/**
 * Surface classification for each prop kind.
 *   'floor' — origin sits on the floor; Y is set to RESTING_Y[kind].
 *   'wall'  — back face flushes against the nearest wall; depth offset applied.
 */
export const SURFACE_KIND = {
  shelf:    'floor',
  console:  'floor',
  gamepad:  'floor',
  bookcase: 'floor',
  cupboard: 'floor',
  table:    'floor',
  poster:   'wall',
  portal:   'floor',
};

/**
 * Y coordinate (metres) at which each floor prop's origin rests on the floor.
 * These match the historical SPAWN_Y values in main.js so existing rooms do
 * not shift when surface-snap is applied.
 *
 * Furniture (bookcase / cupboard / table) has a floor-contact origin (geometry
 * starts at y=0), so their resting Y is 0. Shelf / console / gamepad have
 * their origin at the shelf rail / console base height, kept here for parity
 * with the historical SPAWN_Y in main.js.
 */
export const RESTING_Y = {
  shelf:    1.25,   // shelf rail above floor
  console:  0.74,   // console base height
  gamepad:  0.78,   // gamepad resting on surface
  bookcase: 0.0,    // floor-contact origin (geometry built upward from y=0)
  cupboard: 0.0,    // floor-contact origin
  table:    0.0,    // floor-contact origin
  portal:   0.0,    // floor-level portal arch
  default:  1.2,    // fallback for unknown kinds
};

/**
 * How far the poster's face is from the wall plane (metres). The poster mesh
 * origin is its centre, so the back face is half-depth away. We add a tiny gap
 * so the poster doesn't z-fight the wall.
 */
export const POSTER_DEPTH_OFFSET = 0.03; // metres from the wall plane

// ---------------------------------------------------------------------------
// Room-bounds model
// ---------------------------------------------------------------------------

/**
 * A room-bounds descriptor for `clampToRoom` and `snapToSurface`.
 *
 * @typedef {Object} RoomBounds
 * @property {number} minX   inner left wall X   (negative)
 * @property {number} maxX   inner right wall X  (positive)
 * @property {number} minZ   inner back wall Z   (negative)
 * @property {number} maxZ   inner front wall Z  (positive)
 * @property {number} floorY floor plane Y       (0 in standing-eye space)
 * @property {number} ceilY  ceiling plane Y
 */

/**
 * Build a RoomBounds from raw room dimensions (width/depth/height in metres,
 * centred on the world origin). Use this from callers that have access to
 * SceneMgr's `_roomDims`.
 *
 * @param {{ w:number, d:number, h:number }} dims
 * @returns {RoomBounds}
 */
export function roomBoundsFromDims({ w, d, h }) {
  return {
    minX: -(w / 2),
    maxX:   w / 2,
    minZ: -(d / 2),
    maxZ:   d / 2,
    floorY: 0,
    ceilY:  h,
  };
}

// Default bounds matching the 6 × 8 × 3.2 m room built in SceneMgr._initScene().
// Used as a fallback when no live SceneMgr is available (tests, headless).
export const DEFAULT_ROOM_BOUNDS = roomBoundsFromDims({ w: 6, d: 8, h: 3.2 });

// ---------------------------------------------------------------------------
// clampToRoom
// ---------------------------------------------------------------------------

/**
 * Clamp a world-space position so it stays strictly inside the inner walls.
 * Does NOT modify Y (callers combine this with snapToSurface).
 *
 * @param {{ x:number, y:number, z:number }} pos
 * @param {RoomBounds} bounds
 * @param {number} [margin=0.2]  extra inset from each wall (metres)
 * @returns {{ x:number, y:number, z:number }}  clamped copy (never mutates input)
 */
export function clampToRoom(pos, bounds, margin = 0.2) {
  const { minX, maxX, minZ, maxZ } = bounds;
  return {
    x: Math.max(minX + margin, Math.min(maxX - margin, pos.x)),
    y: pos.y,
    z: Math.max(minZ + margin, Math.min(maxZ - margin, pos.z)),
  };
}

// ---------------------------------------------------------------------------
// snapToSurface
// ---------------------------------------------------------------------------

/**
 * Snap a position to the appropriate surface for the given prop kind.
 *
 * For FLOOR props  → set Y to RESTING_Y[kind]; X/Z are left as-is (combine
 *                    with clampToRoom for full safety).
 *
 * For WALL props   → find the wall plane whose inward-normal faces the point
 *                    (i.e. the nearest wall), push X or Z to that plane +
 *                    POSTER_DEPTH_OFFSET, and return the yaw (radians) the
 *                    prop should face to look into the room.
 *
 * @param {{ x:number, y:number, z:number }} pos   world position (mutable copy returned)
 * @param {RoomBounds} bounds
 * @param {string}  kind   prop type key (shelf / poster / …)
 * @returns {{ pos:{x,y,z}, yaw:number }}
 *   pos — snapped world position
 *   yaw — rotation about Y-axis (radians) so the prop faces into the room.
 *          0 for floor props (callers may override with the player-facing yaw).
 */
export function snapToSurface(pos, bounds, kind) {
  const surface = SURFACE_KIND[kind] || 'floor';

  if (surface === 'floor') {
    const restY = RESTING_Y[kind] ?? RESTING_Y.default;
    return {
      pos: { x: pos.x, y: restY, z: pos.z },
      yaw: 0,
    };
  }

  // Wall snap: measure distance to each of the four wall planes, pick nearest.
  // Wall normals point INTO the room:
  //   back  (z = minZ): normal +Z → yaw = 0  (faces +Z, i.e. into the room)
  //   front (z = maxZ): normal -Z → yaw = π
  //   left  (x = minX): normal +X → yaw = -π/2
  //   right (x = maxX): normal -X → yaw = +π/2
  const walls = [
    { axis: 'z', plane: bounds.minZ, dir: +1, yaw:          0 },   // back wall
    { axis: 'z', plane: bounds.maxZ, dir: -1, yaw:  Math.PI   },   // front wall
    { axis: 'x', plane: bounds.minX, dir: +1, yaw: -Math.PI / 2 }, // left wall
    { axis: 'x', plane: bounds.maxX, dir: -1, yaw:  Math.PI / 2 }, // right wall
  ];

  let bestWall = walls[0];
  let bestDist = Infinity;
  for (const w of walls) {
    const d = Math.abs(pos[w.axis] - w.plane);
    if (d < bestDist) { bestDist = d; bestWall = w; }
  }

  // Snap the relevant axis to the wall plane + a small depth offset (poster
  // origin is at the face centre; the offset seats it just in front of the wall).
  const snapped = { x: pos.x, y: pos.y, z: pos.z };
  snapped[bestWall.axis] = bestWall.plane + bestWall.dir * POSTER_DEPTH_OFFSET;

  return { pos: snapped, yaw: bestWall.yaw };
}

// ---------------------------------------------------------------------------
// Ghost-footprint helper
// ---------------------------------------------------------------------------

/**
 * Return { width, depth } of the bounding footprint (XZ) of a prop kind.
 * Used by the placement ghost to size the preview rectangle.
 * These are conservative fits, not exact mesh bounds.
 */
export const FOOTPRINT = {
  shelf:    { width: 1.2, depth: 0.3 },
  console:  { width: 0.4, depth: 0.3 },
  gamepad:  { width: 0.2, depth: 0.12 },
  bookcase: { width: 0.9, depth: 0.3 },
  cupboard: { width: 0.8, depth: 0.4 },
  table:    { width: 1.0, depth: 0.6 },
  poster:   { width: 0.8, depth: 0.05 },  // width × thin depth for wall mount
  portal:   { width: 1.2, depth: 0.1 },
  default:  { width: 0.5, depth: 0.5 },
};

/**
 * Return the footprint for a given kind (falling back to 'default').
 * @param {string} kind
 * @returns {{ width:number, depth:number }}
 */
export function footprintForKind(kind) {
  return FOOTPRINT[kind] || FOOTPRINT.default;
}
