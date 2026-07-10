// Cartridge mesh: a small box with a color stripe by system and a
// CanvasTexture label on the front face. Each cartridge stores its manifest
// entry (file, core, system, title) on userData so the GrabMgr and the
// Console mesh can dispatch a "load this game" intent without looking it
// up elsewhere.

import * as THREE from 'three';
import { drawTextLabel, drawBoxartLabel, drawUnavailableBadge, loadFirstBoxart } from './MediaLabel.js';
import { isUnresolvableHere } from './RomResolver.js';

const CART_W = 0.12;
const CART_H = 0.13;
const CART_D = 0.022;

export function createCartridge(meta) {
  const group = new THREE.Group();
  group.name = `cartridge:${meta.file}`;

  // Body
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(CART_W, CART_H, CART_D),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(meta.color || '#444'), roughness: 0.7, metalness: 0.05 }),
  );
  group.add(body);

  // Label sticker on the front face. Start with a text label, then upgrade
  // to the boxart image once it loads (async) so we don't block the scene
  // on a CDN fetch.
  const labelCanvas = document.createElement('canvas');
  labelCanvas.width = 256; labelCanvas.height = 160;
  drawTextLabel(labelCanvas, meta.title, meta.system);
  const labelTex = new THREE.CanvasTexture(labelCanvas);
  labelTex.colorSpace = THREE.SRGBColorSpace;
  labelTex.minFilter = THREE.LinearFilter;
  labelTex.magFilter = THREE.LinearFilter;
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(CART_W * 0.88, CART_H * 0.55),
    new THREE.MeshBasicMaterial({ map: labelTex, toneMapped: false }),
  );
  label.position.set(0, CART_H * 0.05, CART_D / 2 + 0.0005);
  group.add(label);

  // Try box-art candidates in order (filename → title → tag-stripped, per
  // ArtResolver), falling through to the next on load failure. Legacy callers
  // that only set `meta.boxart` still work — it's the single-element list.
  const boxartList = meta.boxartList?.length ? meta.boxartList
                   : (meta.boxart ? [meta.boxart] : []);
  if (boxartList.length) {
    loadFirstBoxart(boxartList).then((img) => {
      drawBoxartLabel(labelCanvas, img, meta.title);
      labelTex.needsUpdate = true;
    }).catch(() => { /* keep text label */ });
  }

  // Pre-flight "you don't have this" affordance (see RomResolver.js) — mainly
  // for a multiplayer peer looking at a cart another peer loaded from THEIR
  // local folder/pick. Runs after the label/boxart drawing above so the badge
  // always composites on top, regardless of which finishes first.
  isUnresolvableHere(meta).then((unresolvable) => {
    if (!unresolvable) return;
    group.userData.unresolvable = true;
    drawUnavailableBadge(labelCanvas);
    labelTex.needsUpdate = true;
  }).catch(() => { /* not worth failing the cart over */ });

  // Top "shoulder" — a slightly darker strip above the label, like a SNES
  // cart's molded top. Reads as a cartridge silhouette at a glance.
  const shoulder = new THREE.Mesh(
    new THREE.BoxGeometry(CART_W * 0.78, CART_H * 0.12, CART_D + 0.002),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(meta.color || '#444').multiplyScalar(0.6), roughness: 0.8 }),
  );
  shoulder.position.y = CART_H * 0.44;
  group.add(shoulder);

  // Connector pins at the bottom — the part that "goes into" the console.
  const pins = new THREE.Mesh(
    new THREE.BoxGeometry(CART_W * 0.85, CART_H * 0.08, CART_D * 0.6),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.4, metalness: 0.6 }),
  );
  pins.position.y = -CART_H * 0.46;
  group.add(pins);

  group.userData = {
    kind: 'cartridge',
    medium: 'cartridge',
    file: meta.file,
    system: meta.system,
    core: meta.core,
    title: meta.title,
    color: meta.color,
    // ROM provenance (source/sha1/sources) so re-inserting this cart re-resolves
    // the right bytes. Without it a picked/local ROM would fall back to a `url`
    // fetch (roms/<file>) and 404. See [[src/RomResolver.js]].
    rom: meta.rom || null,
    homePosition: null, // filled in by Shelf — drop-zone returns the cart here on release-without-target
    homeQuaternion: null,
    pinAxis: new THREE.Vector3(0, -1, 0), // local-space direction of the connector pins; console slot aligns to this
  };

  return group;
}

export const CARTRIDGE_DIMS = { W: CART_W, H: CART_H, D: CART_D };
