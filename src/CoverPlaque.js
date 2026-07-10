// CoverPlaque — a small canvas-texture signage plane mounted on a shelf or
// bookcase, labelling which collection it's showing (the "front-plane" the
// deferred "shelf/bookcase cover image" item asked for). Derives its text
// straight from the collection's own `title` ([[src/Collection.js]]) — no new
// room-descriptor field needed, so it round-trips through RoomSerializer for
// free (the existing `prop.collection` reference is all that's persisted).
//
// Browser-only (touches `document`/canvas), like [[src/C64Keyboard.js]] and
// [[src/NowPlayingPanel.js]] — never imported by the Node test suite.

import * as THREE from 'three';

const CANVAS_W = 512;
const CANVAS_H = 128;

function renderLabelCanvas(text) {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2a1c10';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.strokeStyle = '#c9a86a';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, CANVAS_W - 6, CANVAS_H - 6);
  ctx.fillStyle = '#f2e6c9';
  ctx.font = 'bold 44px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const label = String(text || 'Games').slice(0, 28);
  ctx.fillText(label, CANVAS_W / 2, CANVAS_H / 2);
  return canvas;
}

/**
 * Build a small header-plaque mesh showing `text` (a collection's display
 * title). `width` sizes the plane to roughly match the shelf/bookcase it sits
 * on; height follows the canvas's fixed aspect ratio. Faces +Z (this
 * project's furniture "front"), unrotated.
 */
export function createCoverPlaque(text, { width = 0.5 } = {}) {
  const canvas = renderLabelCanvas(text);
  const texture = new THREE.CanvasTexture(canvas);
  if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
  const height = width * (CANVAS_H / CANVAS_W);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }),
  );
  mesh.name = 'coverPlaque';
  mesh.userData.kind = 'coverPlaque';
  return mesh;
}
