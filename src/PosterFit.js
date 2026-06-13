// PosterFit — PURE UV-mapping helpers for poster fit modes.
//
// No THREE, no DOM — safe to import from Node unit tests.
// Consumed by:
//   [[src/RoomBuilder.js]] — applyFitUV()
//   [[src/EnvEditor.js]]   — FIT_MODE_OPTIONS (re-exported here for convenience)
//   [[scripts/test-imagelibrary.mjs]] — unit tests

/** Valid fit modes for poster image display. */
export const FIT_MODES = ['contain', 'cover', 'stretch'];
export const DEFAULT_FIT_MODE = 'contain';

/**
 * Compute THREE.js Texture repeat/offset so an image of natural size
 * (imgW × imgH) maps onto a plane of (planeW × planeH) under the given mode.
 *
 * Returns { repeatX, repeatY, offsetX, offsetY }. For 'stretch' this is always
 * { 1, 1, 0, 0 } regardless of aspect. For 'contain'/'cover' the short/long
 * axis is scaled so the image fits/fills the plane and the result is centred.
 *
 * Pure — no THREE, no DOM. Unit-tested in Node via scripts/test-imagelibrary.mjs.
 *
 * @param {number} imgW   natural pixel width  of the image
 * @param {number} imgH   natural pixel height of the image
 * @param {number} planeW plane width  in metres
 * @param {number} planeH plane height in metres
 * @param {string} mode   'contain' | 'cover' | 'stretch'
 * @returns {{ repeatX: number, repeatY: number, offsetX: number, offsetY: number }}
 */
export function fitModeUV(imgW, imgH, planeW, planeH, mode) {
  // Guard: fall back to stretch if geometry is degenerate.
  if (!imgW || !imgH || !planeW || !planeH) {
    return { repeatX: 1, repeatY: 1, offsetX: 0, offsetY: 0 };
  }

  const imgAspect   = imgW / imgH;
  const planeAspect = planeW / planeH;

  if (mode === 'stretch' || !mode) {
    return { repeatX: 1, repeatY: 1, offsetX: 0, offsetY: 0 };
  }

  let repeatX, repeatY;
  if (mode === 'contain') {
    // Scale so the image fits entirely inside the plane (letterbox on long axis).
    if (imgAspect > planeAspect) {
      // Image is wider than the plane → constrained by width.
      repeatX = 1;
      repeatY = planeAspect / imgAspect;
    } else {
      // Image is taller (or equal) → constrained by height.
      repeatX = imgAspect / planeAspect;
      repeatY = 1;
    }
  } else {
    // 'cover': scale so the image fills the plane (crop on short axis).
    if (imgAspect > planeAspect) {
      // Image is wider than the plane → fill by height, crop left/right.
      repeatX = planeAspect / imgAspect;
      repeatY = 1;
    } else {
      // Image is taller (or equal) → fill by width, crop top/bottom.
      repeatX = 1;
      repeatY = imgAspect / planeAspect;
    }
  }

  // Centre the image in the plane.
  const offsetX = (1 - repeatX) / 2;
  const offsetY = (1 - repeatY) / 2;
  return { repeatX, repeatY, offsetX, offsetY };
}
