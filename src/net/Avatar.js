// Avatar: the visible body of one remote peer in a shared room — a head (with a
// colored visor so you can tell who's looking at you) + two floating hands + a
// nameplate. Imperative THREE (like Cartridge/Shelf/Console), driven by
// [[src/net/AvatarMgr.js]] from the pure [[src/net/PresenceState.js]] peer list.
//
// Poses arrive in ROOM/WORLD space (the sender reads the world transform of its
// camera + controllers), and avatars live at scene root, so a peer's head shows
// up exactly where they're standing. Updates land at the pose rate (~12 Hz) but
// we render at 72-90 Hz, so update() only sets a TARGET and tick() eases toward
// it each frame — otherwise remote avatars would visibly step.

import * as THREE from 'three';

const HEAD_SIZE = 0.22;
const HAND_SIZE = 0.07;

function makeNameplate(nick, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = color; ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(nick).slice(0, 16), canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(0.5, 0.125, 1);
  sprite.position.set(0, HEAD_SIZE + 0.12, 0);
  sprite.renderOrder = 999;
  return sprite;
}

function makeHand(colorHex) {
  // A little wedge that points -Z (the way a controller's ray goes), so a
  // peer's hands read as "pointing" rather than as featureless cubes.
  const geom = new THREE.ConeGeometry(HAND_SIZE, HAND_SIZE * 2.4, 6);
  geom.rotateX(-Math.PI / 2); // cone tip → -Z
  const mat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.5, metalness: 0.1 });
  return new THREE.Mesh(geom, mat);
}

export class Avatar {
  constructor({ nick = 'Player', color = '#88aaff' } = {}) {
    this.nick = nick;
    this.color = color;
    const colorHex = new THREE.Color(color).getHex();

    this.group = new THREE.Group();
    this.group.name = `avatar:${nick}`;

    // Head: dark box + a bright visor plane on the front face.
    this.head = new THREE.Group();
    const skull = new THREE.Mesh(
      new THREE.BoxGeometry(HEAD_SIZE, HEAD_SIZE, HEAD_SIZE * 1.1),
      new THREE.MeshStandardMaterial({ color: 0x2a2a33, roughness: 0.7 }),
    );
    this.head.add(skull);
    const visor = new THREE.Mesh(
      new THREE.PlaneGeometry(HEAD_SIZE * 0.82, HEAD_SIZE * 0.42),
      new THREE.MeshStandardMaterial({ color: colorHex, emissive: colorHex, emissiveIntensity: 0.6, roughness: 0.3 }),
    );
    visor.position.set(0, HEAD_SIZE * 0.05, -HEAD_SIZE * 0.56);
    this.head.add(visor);
    this.head.add(makeNameplate(nick, color));
    this.group.add(this.head);

    this.leftHand = makeHand(colorHex);
    this.rightHand = makeHand(colorHex);
    this.group.add(this.leftHand);
    this.group.add(this.rightHand);

    // Per-part targets the render loop eases toward.
    this._targets = {
      head: { pos: new THREE.Vector3(0, -10, 0), quat: new THREE.Quaternion(), on: false },
      left: { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), on: false },
      right: { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), on: false },
    };
    // Start parked below the floor so the first ease-in slides them up into place.
    this.head.position.set(0, -10, 0);
  }

  _setTarget(name, part) {
    const t = this._targets[name];
    if (!part) { t.on = false; return; }
    t.pos.set(part[0], part[1], part[2]);
    t.quat.set(part[3], part[4], part[5], part[6]);
    t.on = true;
  }

  /** Push a new pose ({head,left,right} of 7-tuples|null) as the ease target. */
  update(pose) {
    if (!pose) return;
    this._setTarget('head', pose.head);
    this._setTarget('left', pose.left);
    this._setTarget('right', pose.right);
  }

  /** Ease toward the latest target. dtMs is the frame delta from SceneMgr. */
  tick(dtMs = 16) {
    const tau = 80; // ms; smaller = snappier
    const a = 1 - Math.exp(-dtMs / tau);
    this._easePart(this.head, this._targets.head, a);
    this._easePart(this.leftHand, this._targets.left, a);
    this._easePart(this.rightHand, this._targets.right, a);
  }

  _easePart(obj, target, a) {
    obj.visible = target.on;
    if (!target.on) return;
    obj.position.lerp(target.pos, a);
    obj.quaternion.slerp(target.quat, a);
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
      }
    });
  }
}
