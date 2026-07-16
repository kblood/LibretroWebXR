// Snap — pure nearest-anchor geometry for seating a grabbed connector plug into
// the closest compatible jack. The patch graph ([[src/Patchbay.js]]) decides
// what a connection MEANS; this decides WHERE a released plug lands: the nearest
// jack within an acceptance radius, or none (→ the plug is left dangling and the
// edge is cleared, EmuVR's "pull the plug out and drop it in mid-air").
//
// Kept pure (plain {x,y,z}, no THREE) so the snap decision unit-tests in
// `npm test` (scripts/test-snap.mjs); the THREE side just feeds world positions.

/**
 * Squared distance between two points (cheap; avoids the sqrt for comparison).
 */
function dist2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Find the nearest anchor to `point` within `maxDist`.
 *
 * @param {{x:number,y:number,z:number}} point          the plug's world position
 * @param {Array<{id:string,x:number,y:number,z:number}>} anchors  candidate jacks
 * @param {number} maxDist                               acceptance radius (m)
 * @param {(a:object)=>boolean} [accept]                 optional per-anchor filter
 *   (e.g. "this jack is free / compatible"). Rejected anchors are ignored.
 * @returns {{id:string, dist:number, anchor:object}|null}
 */
export function nearestAnchor(point, anchors, maxDist, accept = null) {
  if (!point || !anchors || !anchors.length) return null;
  const maxD2 = maxDist * maxDist;
  let best = null, bestD2 = maxD2;
  for (const a of anchors) {
    if (accept && !accept(a)) continue;
    const d2 = dist2(point, a);
    if (d2 < bestD2) { bestD2 = d2; best = a; }
  }
  return best ? { id: best.id, dist: Math.sqrt(bestD2), anchor: best } : null;
}

/**
 * Find the anchor an aim ray is pointing at — the "point at a socket and let
 * go" counterpart to `nearestAnchor`'s "drop it near a socket". For each
 * anchor, projects it onto the ray and keeps candidates whose projection
 * falls within [0, maxDist] along the ray AND within maxPerp of the ray
 * itself (anchors are single points, not colliders, so this is perpendicular-
 * distance tolerance rather than mesh raycasting). Among candidates, picks
 * the one most precisely aimed at (smallest perpendicular distance), tying
 * on the nearer one along the ray.
 *
 * @param {{x:number,y:number,z:number}} origin   ray start (controller position)
 * @param {{x:number,y:number,z:number}} dir       ray direction (need not be unit length)
 * @param {Array<{id:string,x:number,y:number,z:number}>} anchors  candidate jacks
 * @param {{maxDist?:number, maxPerp?:number, accept?:(a:object)=>boolean}} [opts]
 * @returns {{id:string, along:number, perp:number, anchor:object}|null}
 */
export function nearestAnchorAlongRay(origin, dir, anchors, opts = {}) {
  if (!origin || !dir || !anchors || !anchors.length) return null;
  const { maxDist = Infinity, maxPerp = 0.25, accept = null } = opts;
  const dirLen = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
  if (dirLen < 1e-9) return null;
  const ux = dir.x / dirLen, uy = dir.y / dirLen, uz = dir.z / dirLen;

  let best = null, bestAlong = 0, bestPerp2 = maxPerp * maxPerp;
  for (const a of anchors) {
    if (accept && !accept(a)) continue;
    const rx = a.x - origin.x, ry = a.y - origin.y, rz = a.z - origin.z;
    const along = rx * ux + ry * uy + rz * uz;
    if (along < 0 || along > maxDist) continue;
    const px = origin.x + ux * along, py = origin.y + uy * along, pz = origin.z + uz * along;
    const perp2 = dist2(a, { x: px, y: py, z: pz });
    if (perp2 < bestPerp2 || (best && perp2 === bestPerp2 && along < bestAlong)) {
      best = a; bestAlong = along; bestPerp2 = perp2;
    }
  }
  return best ? { id: best.id, along: bestAlong, perp: Math.sqrt(bestPerp2), anchor: best } : null;
}
