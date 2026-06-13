// Cord: the visual rope that runs from a controller (gamepad mesh) to its
// connector plug. Plugging the connector into a console port is what assigns a
// controller to a player ([[src/CableMgr.js]]); the cord just makes that wiring
// visible in VR — you can see, at a glance, which controller is in which port.
//
// Two layers, mirroring the rest of the codebase's pure/visual split:
//   • cordCurvePoints(from, to, opts) — PURE catenary-ish sag sampling. No
//     THREE, no DOM, so it unit-tests in `npm test` (scripts/test-cord.mjs).
//   • Cord — a thin THREE wrapper that tubes those points into a mesh and
//     re-shapes itself per frame as the two endpoints move.

import * as THREE from 'three';

// Default rope look. Radius is in metres (~6 mm — a chunky console cable).
const DEFAULT_RADIUS = 0.006;
const DEFAULT_SEGMENTS = 18;     // curve samples between the two ends
const DEFAULT_RADIAL = 6;        // tube cross-section sides (cheap, reads round)
// Sag: a cord droops more the longer it is, but clamped so a long span doesn't
// hit the floor and a short one still bows a little.
const SAG_FACTOR = 0.28;
const SAG_MIN = 0.02;
const SAG_MAX = 0.35;

/**
 * Sample points along a drooping cord between two anchor points.
 *
 * The curve is the straight line from `from` to `to` with a downward parabolic
 * sag added (max at the midpoint), which reads as a hanging cable without the
 * cost/complexity of a real catenary. Pure: takes/returns plain {x,y,z}.
 *
 * @param {{x:number,y:number,z:number}} from
 * @param {{x:number,y:number,z:number}} to
 * @param {object} [opts]
 * @param {number} [opts.segments]  number of spans (returns segments+1 points)
 * @param {number} [opts.sagFactor] sag as a fraction of total length
 * @param {number} [opts.sagMin]    minimum sag depth (m)
 * @param {number} [opts.sagMax]    maximum sag depth (m)
 * @returns {Array<{x:number,y:number,z:number}>}
 */
export function cordCurvePoints(from, to, opts = {}) {
  const segments = Math.max(1, opts.segments ?? DEFAULT_SEGMENTS);
  const sagFactor = opts.sagFactor ?? SAG_FACTOR;
  const sagMin = opts.sagMin ?? SAG_MIN;
  const sagMax = opts.sagMax ?? SAG_MAX;

  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const sag = Math.min(sagMax, Math.max(sagMin, dist * sagFactor));

  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    // Parabola peaking at t=0.5: 4t(1-t) ∈ [0,1].
    const droop = sag * 4 * t * (1 - t);
    pts.push({
      x: from.x + dx * t,
      y: from.y + dy * t - droop,
      z: from.z + dz * t,
    });
  }
  return pts;
}

/**
 * A cord mesh between two moving endpoints. Call update(from, to) each frame;
 * it only rebuilds the (otherwise immutable) TubeGeometry when an endpoint has
 * actually moved past a small threshold, so resting controllers cost nothing.
 */
export class Cord {
  /**
   * @param {object} [opts]
   * @param {number} [opts.color]   hex tube colour (player tint)
   * @param {number} [opts.radius]  tube radius (m)
   */
  constructor({ color = 0x222228, radius = DEFAULT_RADIUS } = {}) {
    this.radius = radius;
    this._segments = DEFAULT_SEGMENTS;
    this.material = new THREE.MeshStandardMaterial({
      color, roughness: 0.7, metalness: 0.1,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = 'controller-cord';
    this.mesh.castShadow = false;
    this._from = new THREE.Vector3();
    this._to = new THREE.Vector3();
    this._built = false;
  }

  /** Recolour the cord (e.g. when its connector changes port/player). */
  setColor(hex) { this.material.color.setHex(hex); }

  setVisible(v) { this.mesh.visible = v; }

  /**
   * Reshape the cord between two world-space points. Cheap no-op when neither
   * end moved since the last build (threshold ~1 mm).
   * @param {THREE.Vector3} from
   * @param {THREE.Vector3} to
   */
  update(from, to) {
    if (this._built &&
        this._from.distanceToSquared(from) < 1e-6 &&
        this._to.distanceToSquared(to) < 1e-6) {
      return;
    }
    this._from.copy(from);
    this._to.copy(to);

    const pts = cordCurvePoints(from, to, { segments: this._segments })
      .map((p) => new THREE.Vector3(p.x, p.y, p.z));
    const curve = new THREE.CatmullRomCurve3(pts);
    const geom = new THREE.TubeGeometry(curve, this._segments, this.radius, DEFAULT_RADIAL, false);

    this.mesh.geometry.dispose();
    this.mesh.geometry = geom;
    this._built = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
