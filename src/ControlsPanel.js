// Wall-mounted reference card showing the current core's two-hand control
// mapping. Updated by [[src/main.js]] whenever the loaded core changes.
// Hidden by default, toggled visible from the menu panel.
//
// Layout: two columns — left=Holding hand, right=Free hand. Each row is a
// physical Quest input (trigger / face A / face B / stick click /
// thumbstick) and shows which logical RetroPad button it fires on that
// hand for the current system. With SNES-class systems the two columns
// differ — e.g., holding-hand trigger = Y while free-hand trigger = L.

import * as THREE from 'three';
import { mapForSystem } from './ControllerMaps.js';

const W_PX = 720;
const H_PX = 520;
const W_M = 0.78;
const H_M = 0.56;

// Per-system label for each logical RetroPad button — what's silkscreened
// on a real controller for that system. RetroPad 'A' on SNES is the right
// face button labelled "A"; on SMS it's "Button 2". 'Start' is sometimes
// "Run" or "Pause" depending on hardware.
const SYSTEM_LABELS = {
  nes:       { A: 'A',         B: 'B',         X: 'X',       Y: 'Y',     L: 'L',       R: 'R',       Start: 'Start',  Select: 'Select' },
  snes:      { A: 'A',         B: 'B',         X: 'X',       Y: 'Y',     L: 'L',       R: 'R',       Start: 'Start',  Select: 'Select' },
  gb:        { A: 'A',         B: 'B',         X: 'X',       Y: 'Y',     L: 'L',       R: 'R',       Start: 'Start',  Select: 'Select' },
  gbc:       { A: 'A',         B: 'B',         X: 'X',       Y: 'Y',     L: 'L',       R: 'R',       Start: 'Start',  Select: 'Select' },
  gba:       { A: 'A',         B: 'B',         X: 'X',       Y: 'Y',     L: 'L',       R: 'R',       Start: 'Start',  Select: 'Select' },
  atari2600: { A: 'Fire',      B: 'Fire',      X: '—',       Y: '—',     L: '—',       R: '—',       Start: 'Reset',  Select: 'Select' },
  vb:        { A: 'A',         B: 'B',         X: '—',       Y: '—',     L: 'L',       R: 'R',       Start: 'Start',  Select: 'Select' },
  sms:       { A: 'Button 2',  B: 'Button 1',  X: '—',       Y: '—',     L: '—',       R: '—',       Start: 'Pause',  Select: '—' },
  gg:        { A: 'Button 2',  B: 'Button 1',  X: '—',       Y: '—',     L: '—',       R: '—',       Start: 'Start',  Select: '—' },
  pce:       { A: 'II',        B: 'I',         X: '—',       Y: '—',     L: '—',       R: '—',       Start: 'Run',    Select: 'Select' },
  c64:       { A: 'Fire',      B: 'Space',     X: '—',       Y: '—',     L: '—',       R: '—',       Start: 'F1',     Select: 'F7' },
  genesis:   { A: 'C',         B: 'A',         X: 'X',       Y: 'B',     L: 'Y',       R: 'Z',       Start: 'Start',  Select: 'Mode' },
  default:   { A: 'A',         B: 'B',         X: 'X',       Y: 'Y',     L: 'L',       R: 'R',       Start: 'Start',  Select: 'Select' },
};

const INPUT_ROWS = [
  { key: 'trigger',    label: 'Trigger' },
  { key: 'faceA',      label: 'Face A/X' },
  { key: 'faceB',      label: 'Face B/Y' },
  { key: 'stickClick', label: 'Stick click' },
];

export function createControlsPanel({ position = new THREE.Vector3(-2.99, 1.55, -3.5), rotationY = Math.PI / 2 } = {}) {
  const group = new THREE.Group();
  group.name = 'controls-panel';
  group.position.copy(position);
  group.rotation.y = rotationY;
  group.visible = false;

  const canvas = document.createElement('canvas');
  canvas.width = W_PX;
  canvas.height = H_PX;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;

  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(W_M + 0.015, H_M + 0.015),
    new THREE.MeshBasicMaterial({ color: 0x000000 }),
  );
  back.position.z = -0.002;
  group.add(back);

  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(W_M, H_M),
    new THREE.MeshBasicMaterial({ map: tex }),
  );
  group.add(panel);

  const draw = ({ system = null, coreLabel = '(no game loaded)' } = {}) => {
    const map = mapForSystem(system || 'default');
    const labels = SYSTEM_LABELS[system] || SYSTEM_LABELS.default;
    const labelFor = (retroBtn) => labels[retroBtn] || retroBtn;

    ctx.clearRect(0, 0, W_PX, H_PX);
    ctx.fillStyle = '#0c0c1c';
    ctx.fillRect(0, 0, W_PX, H_PX);

    ctx.fillStyle = '#88ddff';
    ctx.font = 'bold 30px monospace';
    ctx.fillText('Controls', 24, 42);

    ctx.fillStyle = '#aaa';
    ctx.font = '16px monospace';
    ctx.fillText(coreLabel, 24, 66);

    ctx.strokeStyle = '#334';
    ctx.beginPath();
    ctx.moveTo(24, 80);
    ctx.lineTo(W_PX - 24, 80);
    ctx.stroke();

    const col1X = 24;        // Quest input label
    const col2X = 230;       // Holding-hand action
    const col3X = 470;       // Free-hand action

    ctx.font = 'bold 18px monospace';
    ctx.fillStyle = '#888';
    ctx.fillText('Quest input', col1X, 110);
    ctx.fillStyle = '#ffd060';
    ctx.fillText('Holding hand',  col2X, 110);
    ctx.fillStyle = '#88ddff';
    ctx.fillText('Free hand',     col3X, 110);

    ctx.font = '20px monospace';
    let y = 148;
    for (const row of INPUT_ROWS) {
      ctx.fillStyle = '#ddd';
      ctx.fillText(row.label, col1X, y);
      const hRetro = map.holding[row.key];
      const fRetro = map.free[row.key];
      ctx.fillStyle = '#fff';
      ctx.fillText(`${labelFor(hRetro)}`, col2X, y);
      ctx.fillStyle = '#fff';
      ctx.fillText(`${labelFor(fRetro)}`, col3X, y);
      ctx.fillStyle = '#666';
      ctx.font = '13px monospace';
      ctx.fillText(`RetroPad ${hRetro}`, col2X, y + 16);
      ctx.fillText(`RetroPad ${fRetro}`, col3X, y + 16);
      ctx.font = '20px monospace';
      y += 44;
    }

    // Thumbstick row applies to both hands identically (always d-pad).
    ctx.fillStyle = '#ddd';
    ctx.fillText('Thumbstick', col1X, y);
    ctx.fillStyle = '#fff';
    ctx.fillText('D-pad', col2X, y);
    ctx.fillText('D-pad', col3X, y);
    y += 30;

    ctx.fillStyle = '#ddd';
    ctx.fillText('Grip', col1X, y);
    ctx.fillStyle = '#888';
    ctx.fillText('Grab / release (never sent to game)', col2X, y);

    ctx.fillStyle = '#666';
    ctx.font = '13px monospace';
    ctx.fillText('Both hands forward input — hold the gamepad in one hand, use the', 24, H_PX - 36);
    ctx.fillText('other for stick + extra buttons. Drop the gamepad to walk or use menu.', 24, H_PX - 18);

    tex.needsUpdate = true;
  };

  group.userData.update = draw;
  group.userData.setVisible = (v) => { group.visible = v; };
  draw();

  return group;
}
