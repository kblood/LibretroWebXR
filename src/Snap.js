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
