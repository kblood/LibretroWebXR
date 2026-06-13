// Cartridge mesh: a small box with a color stripe by system and a
// CanvasTexture label on the front face. Each cartridge stores its manifest
// entry (file, core, system, title) on userData so the GrabMgr and the
// Console mesh can dispatch a "load this game" intent without looking it
// up elsewhere.

import * as THREE from 'three';

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

function drawTextLabel(c, title, system) {
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const grad = ctx.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, '#f5f0e0');
  grad.addColorStop(1, '#dcd6c2');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, c.width - 6, c.height - 6);
  ctx.fillStyle = '#222';
  ctx.font = 'bold 18px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText((system || '').toUpperCase(), 14, 28);
  ctx.fillStyle = '#111';
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  wrap(ctx, title, c.width / 2, 80, c.width - 24, 34);
}

function drawBoxartLabel(c, img, title) {
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  // Letterbox the boxart on a dark backing so portrait box scans don't
  // distort to the label's 256×160 aspect.
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, c.width, c.height);
  const targetAspect = c.width / c.height;
  const imgAspect = img.width / img.height;
  let dw, dh, dx, dy;
  if (imgAspect > targetAspect) {
    dw = c.width; dh = c.width / imgAspect;
    dx = 0; dy = (c.height - dh) / 2;
  } else {
    dh = c.height; dw = c.height * imgAspect;
    dy = 0; dx = (c.width - dw) / 2;
  }
  ctx.drawImage(img, dx, dy, dw, dh);
  // Tiny thin title strip at the bottom for context.
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(0, c.height - 22, c.width, 22);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Truncate if too long.
  let t = title;
  while (t.length > 4 && ctx.measureText(t).width > c.width - 12) t = t.slice(0, -1);
  if (t !== title) t = t.slice(0, -1) + '…';
  ctx.fillText(t, c.width / 2, c.height - 11);
  ctx.textBaseline = 'alphabetic';
}

function loadBoxart(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`boxart load failed: ${url}`));
    img.src = url;
  });
}

// Resolve with the first candidate URL that loads; reject only if all fail.
function loadFirstBoxart(urls) {
  return urls.reduce(
    (p, url) => p.catch(() => loadBoxart(url)),
    Promise.reject(new Error('no boxart candidates')),
  );
}

function wrap(ctx, text, x, y, maxW, lineH) {
  const words = String(text).split(/\s+/);
  let line = '';
  const lines = [];
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  const start = y - ((lines.length - 1) * lineH) / 2;
  lines.forEach((l, i) => ctx.fillText(l, x, start + i * lineH));
}
