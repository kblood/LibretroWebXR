// Memory-card mesh: a thin grabbable rectangle with a CanvasTexture label
// showing slot number and (when filled) the title of the game it was saved
// from. LED at the bottom: green when filled, dim grey when empty, pulses
// white on a successful save/load and red on refusal (wrong-game insert).

import * as THREE from 'three';

const CARD_W = 0.085;
const CARD_H = 0.115;
const CARD_D = 0.010;

export const CARD_DIMS = { W: CARD_W, H: CARD_H, D: CARD_D };

export function createMemoryCard({ slot, savedMeta = null }) {
  const group = new THREE.Group();
  group.name = `memory-card:${slot}`;

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(CARD_W, CARD_H, CARD_D),
    new THREE.MeshStandardMaterial({ color: 0xe8e8ee, roughness: 0.45 }),
  );
  group.add(body);

  // Connector pins along the bottom edge — like a real memory card.
  const pins = new THREE.Mesh(
    new THREE.BoxGeometry(CARD_W * 0.85, CARD_H * 0.06, CARD_D * 0.7),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.4, metalness: 0.6 }),
  );
  pins.position.y = -CARD_H * 0.47;
  group.add(pins);

  const canvas = document.createElement('canvas');
  canvas.width = 160; canvas.height = 200;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(CARD_W * 0.86, CARD_H * 0.78),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
  );
  label.position.set(0, CARD_H * 0.08, CARD_D / 2 + 0.0006);
  group.add(label);

  const led = new THREE.Mesh(
    new THREE.SphereGeometry(0.0045, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0x222222, toneMapped: false }),
  );
  led.position.set(CARD_W * 0.30, -CARD_H * 0.38, CARD_D / 2 + 0.001);
  group.add(led);

  const drawLabel = (meta) => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const bg = ctx.createLinearGradient(0, 0, 0, canvas.height);
    if (meta) { bg.addColorStop(0, '#1f3a22'); bg.addColorStop(1, '#0e1f10'); }
    else      { bg.addColorStop(0, '#444a55'); bg.addColorStop(1, '#2a2f38'); }
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#0d0d0d';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);

    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = 'bold 28px system-ui,sans-serif';
    ctx.fillText(`SLOT ${slot}`, canvas.width / 2, 40);

    if (meta) {
      ctx.font = 'bold 14px system-ui,sans-serif';
      ctx.fillStyle = '#9aff9a';
      ctx.fillText((meta.system || '').toUpperCase(), canvas.width / 2, 64);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 18px system-ui,sans-serif';
      const title = meta.title || meta.file || '(saved)';
      const max = canvas.width - 16;
      let t = title;
      while (t.length > 4 && ctx.measureText(t).width > max) t = t.slice(0, -1);
      if (t !== title) t = t.slice(0, -1) + '…';
      ctx.fillText(t, canvas.width / 2, 100);
      const d = new Date(meta.ts || 0);
      ctx.font = '12px system-ui,sans-serif';
      ctx.fillStyle = '#cfe9d3';
      ctx.fillText(d.toLocaleDateString(), canvas.width / 2, 130);
    } else {
      ctx.font = '18px system-ui,sans-serif';
      ctx.fillStyle = '#bbb';
      ctx.fillText('EMPTY', canvas.width / 2, 100);
      ctx.font = '12px system-ui,sans-serif';
      ctx.fillStyle = '#888';
      ctx.fillText('insert to save', canvas.width / 2, 130);
    }
    tex.needsUpdate = true;
  };

  drawLabel(savedMeta);

  const restingColor = () => (group.userData.savedMeta ? 0x22cc22 : 0x222222);
  let pulseEndAt = 0;

  group.userData = {
    kind: 'memory-card',
    slot,
    savedMeta, // null = empty, otherwise { core, file, title, system, ts }
    homePosition: null,
    homeQuaternion: null,
    pinAxis: new THREE.Vector3(0, -1, 0),
    setSaved(meta) {
      this.savedMeta = meta;
      drawLabel(meta);
      led.material.color.setHex(restingColor());
    },
    pulse(color = 0xffffff, durationMs = 280) {
      led.material.color.setHex(color);
      pulseEndAt = performance.now() + durationMs;
      setTimeout(() => {
        if (performance.now() >= pulseEndAt - 5) led.material.color.setHex(restingColor());
      }, durationMs);
    },
  };
  led.material.color.setHex(restingColor());

  return group;
}
