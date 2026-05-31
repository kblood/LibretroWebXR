// In-world live readout of BOTH Quest controllers' `inputSource.gamepad`
// while the gamepad mesh is held: per-button pressed state + per-axis
// value for each hand, plus the set of synthetic keys [[src/
// GameInputMgr.js]] is currently dispatching. Makes Quest controller
// debugging possible from inside the headset — otherwise the user has no
// way to tell whether button[5] actually fires when they press B.
//
// The HUD is a CanvasTexture-backed plane that redraws once per frame.
// It's parented to whatever caller passes (currently the gamepad mesh),
// so it follows the gamepad both at rest and in-hand.

import * as THREE from 'three';

const W_PX = 560;
const H_PX = 400;
const W_M = 0.36;
const H_M = 0.257;

export function createDebugHud() {
  const group = new THREE.Group();
  group.name = 'debug-hud';

  const canvas = document.createElement('canvas');
  canvas.width = W_PX;
  canvas.height = H_PX;
  const ctx = canvas.getContext('2d');

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;

  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(W_M + 0.01, H_M + 0.01),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.85, depthTest: false }),
  );
  back.renderOrder = 998;
  group.add(back);

  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(W_M, H_M),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }),
  );
  panel.position.z = 0.001;
  panel.renderOrder = 999;
  group.add(panel);

  // Render one hand's column. xOff is the column's left edge in canvas px.
  const drawHand = (hand, label, xOff, colW) => {
    ctx.fillStyle = '#88ddff';
    ctx.font = 'bold 16px monospace';
    ctx.fillText(label, xOff, 70);

    if (!hand) {
      ctx.fillStyle = '#666';
      ctx.font = '13px monospace';
      ctx.fillText('(no controller)', xOff, 92);
      return;
    }

    ctx.fillStyle = '#aaa';
    ctx.font = '12px monospace';
    ctx.fillText(hand.handedness || '?', xOff, 88);

    ctx.font = '12px monospace';
    const buttons = hand.buttons || [];
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      ctx.fillStyle = b.pressed ? '#90ee90' : '#555';
      const x = xOff + (i % 2) * (colW / 2);
      const y = 110 + Math.floor(i / 2) * 18;
      ctx.fillText(`[${i}]${b.pressed ? 'D' : '-'}${b.value.toFixed(1)}`, x, y);
    }

    const axes = hand.axes || [];
    for (let i = 0; i < axes.length; i++) {
      const v = axes[i];
      ctx.fillStyle = Math.abs(v) > 0.15 ? '#90ee90' : '#555';
      const x = xOff + (i % 2) * (colW / 2);
      const y = 250 + Math.floor(i / 2) * 18;
      ctx.fillText(`ax${i}:${v >= 0 ? '+' : ''}${v.toFixed(2)}`, x, y);
    }
  };

  const draw = (state) => {
    ctx.clearRect(0, 0, W_PX, H_PX);
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, W_PX, H_PX);

    ctx.fillStyle = '#88ddff';
    ctx.font = 'bold 22px monospace';
    ctx.fillText('Gamepad Debug', 12, 28);

    if (!state) {
      ctx.fillStyle = '#888';
      ctx.font = '14px monospace';
      ctx.fillText('Hold the gamepad to enable input', 12, 56);
      tex.needsUpdate = true;
      return;
    }

    ctx.fillStyle = '#aaa';
    ctx.font = '13px monospace';
    ctx.fillText(`System: ${state.system || '?'}`, 12, 50);

    const colW = (W_PX - 36) / 2;
    drawHand(state.holding, 'HOLDING', 12, colW);
    drawHand(state.free,    'FREE',    12 + colW + 12, colW);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 13px monospace';
    ctx.fillText('Sending keys', 12, 320);
    ctx.font = '12px monospace';
    const keys = state.pressedKeys.length ? state.pressedKeys.join(', ') : '(none)';
    ctx.fillStyle = state.pressedKeys.length ? '#ffd060' : '#555';
    const maxChars = 64;
    if (keys.length <= maxChars) {
      ctx.fillText(keys, 12, 340);
    } else {
      ctx.fillText(keys.slice(0, maxChars), 12, 340);
      ctx.fillText(keys.slice(maxChars, maxChars * 2), 12, 358);
      if (keys.length > maxChars * 2) {
        ctx.fillText(keys.slice(maxChars * 2, maxChars * 3), 12, 376);
      }
    }

    tex.needsUpdate = true;
  };

  group.userData.update = draw;
  group.userData.setVisible = (v) => { group.visible = v; };
  draw(null);

  return group;
}
