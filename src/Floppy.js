// Floppy disk mesh: a recognisable 5.25"-style floppy sleeve with a label
// area and hub detail. Sized to sit on the same shelves and insert the same
// way as a cartridge (same grab/insert/shelf mechanics).
//
// userData.kind is deliberately kept as 'cartridge' so all existing grab,
// insert-into-console, shelf-homing, and prop-sync code works unchanged.
// userData.medium = 'floppy' lets visuals and future slot-matching distinguish
// floppy from cartridge without touching the kind-based dispatch.

import * as THREE from 'three';
import { drawTextLabel, drawBoxartLabel, loadFirstBoxart } from './MediaLabel.js';

// 5.25" floppy sleeve dimensions (scaled to metres for the VR room).
// Slightly thinner and squarer than a cartridge so it reads differently
// on the shelf. The overall height is close to CART_H so slot spacing works.
const FLP_W = 0.115;  // sleeve width  (~133mm at 1:1.15 scale)
const FLP_H = 0.115;  // sleeve height (square)
const FLP_D = 0.006;  // sleeve thickness (thin — it's a disk sleeve)

export function createFloppy(meta) {
  const group = new THREE.Group();
  group.name = `cartridge:${meta.file}`; // 'cartridge:' prefix keeps name conventions uniform

  const sleeveColor = new THREE.Color(meta.color || '#1a1a2e');

  // Main sleeve body
  const sleeve = new THREE.Mesh(
    new THREE.BoxGeometry(FLP_W, FLP_H, FLP_D),
    new THREE.MeshStandardMaterial({ color: sleeveColor, roughness: 0.85, metalness: 0.02 }),
  );
  group.add(sleeve);

  // Hub oval — the circular cutout in the centre of a 5.25" floppy.
  // Represented as a flat dark disc on the front face.
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(FLP_W * 0.12, FLP_W * 0.12, 0.001, 16),
    new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.5 }),
  );
  hub.rotation.x = Math.PI / 2;
  hub.position.set(0, -FLP_H * 0.05, FLP_D / 2 + 0.0005);
  group.add(hub);

  // Write-protect notch — a small rectangle on the left edge, typical of
  // 5.25" floppies. Gives a quick read at shelf-distance.
  const notch = new THREE.Mesh(
    new THREE.BoxGeometry(FLP_W * 0.06, FLP_H * 0.08, FLP_D + 0.002),
    new THREE.MeshStandardMaterial({ color: sleeveColor.clone().multiplyScalar(0.4), roughness: 0.9 }),
  );
  notch.position.set(-FLP_W * 0.47, FLP_H * 0.28, 0);
  group.add(notch);

  // Label sticker — upper portion of the front face (same pipeline as Cartridge).
  // Start with a text label; upgrade async once boxart loads.
  const labelCanvas = document.createElement('canvas');
  labelCanvas.width = 256; labelCanvas.height = 128;
  drawTextLabel(labelCanvas, meta.title, meta.system);
  const labelTex = new THREE.CanvasTexture(labelCanvas);
  labelTex.colorSpace = THREE.SRGBColorSpace;
  labelTex.minFilter = THREE.LinearFilter;
  labelTex.magFilter = THREE.LinearFilter;
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(FLP_W * 0.85, FLP_H * 0.48),
    new THREE.MeshBasicMaterial({ map: labelTex, toneMapped: false }),
  );
  label.position.set(0, FLP_H * 0.22, FLP_D / 2 + 0.0006);
  group.add(label);

  // Async boxart upgrade — identical pattern to Cartridge.js.
  const boxartList = meta.boxartList?.length ? meta.boxartList
                   : (meta.boxart ? [meta.boxart] : []);
  if (boxartList.length) {
    loadFirstBoxart(boxartList).then((img) => {
      drawBoxartLabel(labelCanvas, img, meta.title);
      labelTex.needsUpdate = true;
    }).catch(() => { /* keep text label */ });
  }

  group.userData = {
    // kind stays 'cartridge' so all existing grab/insert/shelf/prop-sync code
    // works without modification. medium distinguishes visual type + slot-matching.
    kind: 'cartridge',
    medium: 'floppy',
    file: meta.file,
    system: meta.system,
    core: meta.core,
    title: meta.title,
    color: meta.color,
    rom: meta.rom || null,
    homePosition: null,   // filled in by Shelf after placement
    homeQuaternion: null,
    pinAxis: new THREE.Vector3(0, -1, 0), // same insert direction as cartridge
  };

  return group;
}

export const FLOPPY_DIMS = { W: FLP_W, H: FLP_H, D: FLP_D };
