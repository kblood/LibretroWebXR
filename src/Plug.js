// Plug — a grabbable connector at the end of a patch cord. This is the EmuVR
// repatch handle: grab the plug, drag it to a jack, release to seat it (the
// caller rewires the pure patch graph [[src/Patchbay.js]] to match); release in
// mid-air to pull it out (clear the edge). The cord ([[src/Cord.js]]) is drawn
// separately from the source device's out-anchor to this plug each frame.
//
// It rides the same [[src/GrabMgr.js]] pipeline as cartridges/gamepads via
// userData.kind = 'plug'; GrabMgr hands releases to a callback that does the
// snap ([[src/Snap.js]]) + repatch. plugKind ('video' | 'controller') tells the
// caller which jack family this plug is allowed to seat into.

import * as THREE from 'three';

export class Plug {
  /**
   * @param {object} opts
   * @param {string} opts.id          stable id (e.g. `vplug-console0`)
   * @param {string} opts.plugKind    'video' | 'controller'
   * @param {string} opts.sourceId    the device this cord comes FROM (consoleId)
   * @param {number} [opts.color]     body tint (defaults by plugKind)
   */
  constructor({ id, plugKind, sourceId, color }) {
    const tint = color ?? (plugKind === 'video' ? 0xccaa22 : 0x33cc55);

    const group = new THREE.Group();
    group.name = `plug-${id}`;

    // A stubby barrel + a pin, so it reads as a connector you can grab.
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.022, 0.026, 0.05, 12),
      new THREE.MeshStandardMaterial({ color: tint, roughness: 0.45, metalness: 0.5 }),
    );
    barrel.rotation.x = Math.PI / 2;           // lie along Z so the pin points -Z
    group.add(barrel);

    const pin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.008, 0.03, 8),
      new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.3, metalness: 0.7 }),
    );
    pin.rotation.x = Math.PI / 2;
    pin.position.z = -0.035;                    // sticks out the front (insertion end)
    group.add(pin);

    // Where the cord attaches (the back of the barrel).
    const cordAnchor = new THREE.Object3D();
    cordAnchor.position.set(0, 0, 0.03);
    group.add(cordAnchor);

    group.userData = {
      kind: 'plug',           // GrabMgr routes releases by this
      plugKind,               // 'video' | 'controller'
      sourceId,               // consoleId the cord originates from
      plugId: id,
      cordAnchor,
      // Hint shown by GrabMgr's laser/hover (grabbable in play mode).
      grabbable: true,
    };

    this.id = id;
    this.plugKind = plugKind;
    this.sourceId = sourceId;
    this.group = group;
    this.cordAnchor = cordAnchor;
  }
}
