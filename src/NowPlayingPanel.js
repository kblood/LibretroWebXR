// NowPlayingPanel: world-space "Now Playing + Input" status panel, rendered
// as a CanvasTexture on a small plane positioned just below the TV.
//
// Shows:
//   • The current SYSTEM, CORE label, and ROM TITLE (or "no game loaded")
//   • A live INPUT indicator: the last RetroPad key that fired + a brief
//     "● INPUT" pulse so the user can see controller input reaching the core
//     without leaving the headset.
//
// Pattern: same CanvasTexture-on-PlaneGeometry approach used by DebugHud —
// cheap, no font loading, readable in VR. Text is only redrawn on change
// (game boot / key press / pulse fade), not every frame.
//
// Usage:
//   const panel = createNowPlayingPanel();
//   scene.addObject(panel);
//   panel.userData.setNowPlaying({ system, coreLabel, title });
//   panel.userData.notifyInput(code);   // called on every onKeyDown

import * as THREE from 'three';

const W_PX = 512;
const H_PX = 128;
// Physical dimensions in metres — roughly 50 cm wide, fits under the TV stand.
const W_M  = 0.50;
const H_M  = 0.125;

// How many milliseconds to keep "● INPUT" pulse lit.
const PULSE_MS = 400;

export function createNowPlayingPanel() {
  const group = new THREE.Group();
  group.name = 'now-playing-panel';

  // --- Canvas / texture -----------------------------------------------------
  const canvas = document.createElement('canvas');
  canvas.width  = W_PX;
  canvas.height = H_PX;
  const ctx = canvas.getContext('2d');

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;

  // Backing plane (black, slightly opaque) so text pops against any wall colour.
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(W_M + 0.01, H_M + 0.01),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.82, depthTest: false }),
  );
  back.renderOrder = 998;
  group.add(back);

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(W_M, H_M),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }),
  );
  plane.position.z = 0.001;
  plane.renderOrder = 999;
  group.add(plane);

  // --- State ----------------------------------------------------------------
  let _system    = null;
  let _coreLabel = null;
  let _title     = null;
  let _lastKey   = null;       // last key code that fired
  let _pulseUntil = 0;         // timestamp (ms) until pulse dot stays lit

  // --- Draw -----------------------------------------------------------------
  const redraw = () => {
    ctx.clearRect(0, 0, W_PX, H_PX);

    // Dark background (same dark blue as DebugHud).
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, W_PX, H_PX);

    const now = performance.now();
    const pulsing = now < _pulseUntil;

    // Top row: "NOW PLAYING" header + pulse dot
    ctx.font = 'bold 15px monospace';
    ctx.fillStyle = '#88ddff';
    ctx.fillText('NOW PLAYING', 10, 20);

    // Input pulse dot — bright green while active, dim grey otherwise.
    const dotX = W_PX - 14;
    const dotY = 13;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 7, 0, Math.PI * 2);
    ctx.fillStyle = pulsing ? '#55ff55' : '#2a2a2a';
    ctx.fill();

    // "● INPUT" label next to dot while pulsing.
    if (pulsing) {
      ctx.font = 'bold 13px monospace';
      ctx.fillStyle = '#55ff55';
      const label = _lastKey ? `● ${_lastKey}` : '● INPUT';
      const lw = ctx.measureText(label).width;
      ctx.fillText(label, dotX - 12 - lw, 19);
    }

    // Separator line.
    ctx.strokeStyle = '#333355';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(10, 27);
    ctx.lineTo(W_PX - 10, 27);
    ctx.stroke();

    if (!_title) {
      // No game loaded.
      ctx.font = '14px monospace';
      ctx.fillStyle = '#666';
      ctx.fillText('no game loaded', 10, 58);
      ctx.fillText('insert a cartridge to start', 10, 78);
    } else {
      // System + core row.
      ctx.font = 'bold 13px monospace';
      ctx.fillStyle = '#ffd060';
      const sysStr = [_system, _coreLabel].filter(Boolean).join(' · ');
      ctx.fillText(sysStr || '(unknown)', 10, 52);

      // Title row — truncate if needed.
      ctx.font = '14px monospace';
      ctx.fillStyle = '#e8e8ff';
      const maxChars = 46;
      const titleStr = (_title && _title.length > maxChars)
        ? _title.slice(0, maxChars - 1) + '…'
        : (_title || '(untitled)');
      ctx.fillText(titleStr, 10, 74);

      // Input status row.
      ctx.font = '12px monospace';
      ctx.fillStyle = pulsing ? '#55ff55' : '#444';
      ctx.fillText(pulsing ? `last input: ${_lastKey || '?'}` : 'waiting for input…', 10, 96);
    }

    tex.needsUpdate = true;
  };

  // Draw initial state.
  redraw();

  // --- Pulse ticker ---------------------------------------------------------
  // We only need to redraw once when the pulse expires (to dim the dot).
  // Schedule a single timeout each time notifyInput fires.
  let _pulseTimer = null;
  const schedulePulseFade = () => {
    if (_pulseTimer) clearTimeout(_pulseTimer);
    _pulseTimer = setTimeout(() => {
      _pulseTimer = null;
      redraw();
    }, PULSE_MS + 16); // +16 ms so the next draw is safely after expiry
  };

  // --- Public API (via userData) --------------------------------------------

  // Call after a game boots (or clears). Pass null/undefined to reset.
  group.userData.setNowPlaying = ({ system, coreLabel, title } = {}) => {
    _system    = system    || null;
    _coreLabel = coreLabel || null;
    _title     = title     || null;
    redraw();
  };

  // Call on every onKeyDown from GameInputMgr (receives the key code string).
  group.userData.notifyInput = (code) => {
    _lastKey     = code || null;
    _pulseUntil  = performance.now() + PULSE_MS;
    redraw();
    schedulePulseFade();
  };

  group.userData.setVisible = (v) => { group.visible = v; };

  return group;
}
