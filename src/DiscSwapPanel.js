// DiscSwapPanel: small in-VR panel for multi-disc (M3U-bundled) content —
// e.g. a real PSX game shipped as multiple CUE+BIN discs (see
// [[src/DiscControl.js]]'s DiscControlBridge, which the worker-execution
// runtime already exposes over setDisc()/setDiscEjected()/discStatus() —
// nothing on the main-thread side called any of them until this panel).
//
// Hidden whenever the loaded content has only one disc (the common case,
// including every main-thread core) — there's nothing to swap. The caller
// (main.js) is responsible for calling userData.setStatus(status) after
// every boot and after every successful setDisc()/setDiscEjected() call;
// there's no live 'change' event forwarded across the worker boundary
// today, so this is push-only, not self-updating.
//
// Follows the same CanvasTexture-on-PlaneGeometry + userData.kind =
// 'menu-button' convention as [[src/MenuPanel.js]]'s buttons (shared
// MenuMgr hover/click raycast), but laid out as a small fixed status+2-button
// strip like [[src/NowPlayingPanel.js]] rather than MenuPanel's vertical
// wall-mounted list — a disc swap is a quick in-context action next to the
// Now Playing readout, not a settings-menu entry.

import * as THREE from 'three';

const W_M = 0.50;
const H_M = 0.09;
const BTN_W = 0.14;
const BTN_H = 0.075;
const STATUS_W = W_M - BTN_W * 2 - 0.02;

function makeButton(label) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;

  let currentLabel = label;
  let hovered = false;

  const redraw = () => {
    ctx.clearRect(0, 0, 256, 128);
    ctx.fillStyle = hovered ? '#2a4a7a' : '#23232c';
    ctx.fillRect(0, 0, 256, 128);
    ctx.strokeStyle = hovered ? '#88ddff' : '#444';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, 250, 122);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 30px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(currentLabel, 128, 64);
    tex.needsUpdate = true;
  };
  redraw();

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(BTN_W, BTN_H),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }),
  );
  mesh.renderOrder = 999;
  mesh.userData.kind = 'menu-button';
  mesh.userData.setHover = (h) => { if (h !== hovered) { hovered = h; redraw(); } };
  mesh.userData.setLabel = (s) => { if (s !== currentLabel) { currentLabel = s; redraw(); } };
  return mesh;
}

export function createDiscSwapPanel({ onPrev, onNext } = {}) {
  const group = new THREE.Group();
  group.name = 'disc-swap-panel';
  group.visible = false; // shown by setStatus() once a multi-disc game is running

  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(W_M + 0.01, H_M + 0.01),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.82, depthTest: false }),
  );
  back.renderOrder = 998;
  group.add(back);

  // Status readout (non-interactive) — "DISC n/m", plus "(open)" while ejected.
  const statusCanvas = document.createElement('canvas');
  statusCanvas.width = 384;
  statusCanvas.height = 128;
  const sctx = statusCanvas.getContext('2d');
  const statusTex = new THREE.CanvasTexture(statusCanvas);
  statusTex.minFilter = THREE.LinearFilter;
  let _label = '';
  const redrawStatus = () => {
    sctx.clearRect(0, 0, 384, 128);
    sctx.fillStyle = '#88ddff';
    sctx.font = 'bold 20px monospace';
    sctx.textAlign = 'center';
    sctx.fillText('DISC', 192, 34);
    sctx.fillStyle = '#e8e8ff';
    sctx.font = 'bold 30px monospace';
    sctx.fillText(_label, 192, 78);
    statusTex.needsUpdate = true;
  };
  redrawStatus();

  const statusPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(STATUS_W, H_M),
    new THREE.MeshBasicMaterial({ map: statusTex, transparent: true, depthTest: false }),
  );
  statusPlane.position.z = 0.001;
  statusPlane.renderOrder = 999;
  group.add(statusPlane);

  const prevBtn = makeButton('< Prev');
  prevBtn.position.set(-(W_M / 2) + BTN_W / 2, 0, 0.001);
  group.add(prevBtn);

  const nextBtn = makeButton('Next >');
  nextBtn.position.set((W_M / 2) - BTN_W / 2, 0, 0.001);
  group.add(nextBtn);

  group.userData.buttons = [
    { mesh: prevBtn, onActivate: () => onPrev?.() },
    { mesh: nextBtn, onActivate: () => onNext?.() },
  ];

  // status: DiscControlBridge.status() shape — { index, discCount, ejected,
  // supported, ... } — or null/undefined (no disc control / single disc).
  // `supported` is checked separately from discCount: an M3U bundle can report
  // discCount > 1 (from its own file listing) while the loaded core exposes
  // neither the explicit nor sequential disc-control export — showing Prev/
  // Next there would just make every press fail with "does not expose disc
  // control" (Codex review finding, P2 on commit 8552959).
  group.userData.setStatus = (status) => {
    if (!status || !status.supported || !(status.discCount > 1)) {
      group.visible = false;
      return;
    }
    group.visible = true;
    _label = `${status.index + 1} / ${status.discCount}${status.ejected ? ' (open)' : ''}`;
    redrawStatus();
  };

  group.userData.setVisible = (v) => { group.visible = v; };

  return group;
}
