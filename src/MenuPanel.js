// Wall-mounted menu: a vertical strip of clickable buttons. Each button is
// a textured plane; the caller wires up onActivate via [[src/MenuMgr.js]].
// Clicked from XR by pointing the laser at a button and pulling the
// trigger (only valid when the controller isn't currently holding the
// gamepad — see MenuMgr).

import * as THREE from 'three';

const BTN_W = 0.36;
const BTN_H = 0.085;
const BTN_GAP = 0.012;
const PAD = 0.025;

export function createMenuPanel({
  position = new THREE.Vector3(-2.99, 1.55, -2.4),
  rotationY = Math.PI / 2,
  title = 'Menu',
  items = [],
} = {}) {
  const group = new THREE.Group();
  group.name = 'menu-panel';
  group.position.copy(position);
  group.rotation.y = rotationY;

  const titleH = 0.06;
  const totalH = items.length * BTN_H + (items.length - 1) * BTN_GAP + titleH + PAD * 3;
  const totalW = BTN_W + PAD * 2;

  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(totalW + 0.01, totalH + 0.01),
    new THREE.MeshBasicMaterial({ color: 0x000000 }),
  );
  back.position.z = -0.003;
  group.add(back);

  const body = new THREE.Mesh(
    new THREE.PlaneGeometry(totalW, totalH),
    new THREE.MeshBasicMaterial({ color: 0x1a1a26 }),
  );
  body.position.z = -0.001;
  group.add(body);

  // Title bar
  const titleCanvas = document.createElement('canvas');
  titleCanvas.width = 512;
  titleCanvas.height = 96;
  const tctx = titleCanvas.getContext('2d');
  tctx.fillStyle = '#0a0a18';
  tctx.fillRect(0, 0, 512, 96);
  tctx.fillStyle = '#88ddff';
  tctx.font = 'bold 44px monospace';
  tctx.textAlign = 'center';
  tctx.textBaseline = 'middle';
  tctx.fillText(title, 256, 48);
  const titleTex = new THREE.CanvasTexture(titleCanvas);
  const titleMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(BTN_W, titleH),
    new THREE.MeshBasicMaterial({ map: titleTex }),
  );
  titleMesh.position.y = totalH / 2 - PAD - titleH / 2;
  group.add(titleMesh);

  const firstBtnY = titleMesh.position.y - titleH / 2 - PAD - BTN_H / 2;
  const buttons = [];
  for (let i = 0; i < items.length; i++) {
    const btn = makeButton(items[i].label);
    btn.position.y = firstBtnY - i * (BTN_H + BTN_GAP);
    group.add(btn);
    buttons.push({ mesh: btn, onActivate: items[i].onActivate, setLabel: btn.userData.setLabel });
  }

  group.userData.buttons = buttons;
  return group;
}

function makeButton(label) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;

  let currentLabel = label;
  let hovered = false;

  const redraw = () => {
    ctx.clearRect(0, 0, 512, 128);
    ctx.fillStyle = hovered ? '#2a4a7a' : '#23232c';
    ctx.fillRect(0, 0, 512, 128);
    ctx.strokeStyle = hovered ? '#88ddff' : '#444';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, 506, 122);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 38px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(currentLabel, 256, 64);
    tex.needsUpdate = true;
  };
  redraw();

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(BTN_W, BTN_H),
    new THREE.MeshBasicMaterial({ map: tex }),
  );
  mesh.userData.kind = 'menu-button';
  mesh.userData.setHover = (h) => { if (h !== hovered) { hovered = h; redraw(); } };
  mesh.userData.setLabel = (s) => { if (s !== currentLabel) { currentLabel = s; redraw(); } };
  return mesh;
}
