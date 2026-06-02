// RoomEditor — the imperative side of Phase E.1 (in-VR room editor). Owns the
// Edit-mode toggle, makes the room's props grabbable while editing, and
// harvests their live transforms back into a *.room.json on export. The pure
// serialization lives in [[src/RoomSerializer.js]]; grabbing/moving reuses the
// existing [[src/GrabMgr.js]] (this just flips it into edit mode and registers
// the props as editable grabbables). main.js wires the menu buttons to here.
//
// Division of labour (see RoomSerializer): the descriptor `this.room` keeps
// every non-spatial field; the live objects keep authoritative pos/rot. On
// export we read each placed object's transform and hand both to serializeRoom.

import { serializeRoom } from './RoomSerializer.js';

const DEG = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

const GRID_POS = 0.1;          // metres — snap step for position
const GRID_ROT = 15 * DEG;     // radians — snap step for rotation (15°)

const snap = (v, step) => Math.round(v / step) * step;

export class RoomEditor {
  /**
   * @param {object} o
   * @param {object} o.scene    SceneMgr (for status/feedback hooks if needed)
   * @param {object} o.room     parsed room descriptor (RoomLoader)
   * @param {Array<{prop,object}>} o.placed  prop↔object links from RoomBuilder
   * @param {GrabMgr} o.grabMgr the shared grab manager
   * @param {(msg:string)=>void} [o.onStatus]  surface a status line
   */
  constructor({ scene, room, placed, grabMgr, onStatus }) {
    this.scene = scene;
    this.room = room;
    this.placed = Array.isArray(placed) ? placed : [];
    this.grabMgr = grabMgr;
    this.onStatus = onStatus || (() => {});
    this._editing = false;
    this._snap = false;

    // Register every placed prop as an editable grabbable. GrabMgr's candidate
    // filter keeps them inert until edit mode is on, so this is safe to do once
    // up front (no behavior change in play mode).
    for (const { object } of this.placed) {
      object.userData.editable = true;
      this.grabMgr.addGrabbable(object);
    }
  }

  isEditMode() { return this._editing; }
  snapEnabled() { return this._snap; }

  /** Toggle edit mode on/off. Returns the new state. */
  toggle() {
    this._editing = !this._editing;
    this.onStatus(this._editing ? 'Edit mode: grab props to move them' : 'Edit mode off');
    return this._editing;
  }

  /** Free placement vs grid snapping (the "settings" switch). */
  setSnap(on) {
    this._snap = !!on;
    this.onStatus(`Snap ${this._snap ? 'on (0.1 m / 15°)' : 'off (free)'}`);
    return this._snap;
  }

  // Called by GrabMgr when an editable prop is released. Quantize to the grid
  // when snapping is on; otherwise leave it exactly where dropped.
  onEditRelease(object) {
    if (!this._snap) return;
    object.position.set(
      snap(object.position.x, GRID_POS),
      snap(object.position.y, GRID_POS),
      snap(object.position.z, GRID_POS),
    );
    object.rotation.set(
      snap(object.rotation.x, GRID_ROT),
      snap(object.rotation.y, GRID_ROT),
      snap(object.rotation.z, GRID_ROT),
    );
  }

  // Build a Map<id,{pos,rot}> of live transforms (pos in metres, rot in DEGREES
  // Euler XYZ) for every placed prop, keyed by descriptor id.
  _liveTransforms() {
    const m = new Map();
    for (const { prop, object } of this.placed) {
      const p = object.position;
      const r = object.rotation; // Euler XYZ, radians
      m.set(prop.id, {
        pos: [p.x, p.y, p.z],
        rot: [r.x * RAD2DEG, r.y * RAD2DEG, r.z * RAD2DEG],
      });
    }
    return m;
  }

  /** The current room as a clean room@1 object (descriptor + live transforms). */
  serialize() {
    return serializeRoom(this.room, this._liveTransforms());
  }

  /** Serialize + download a *.room.json and copy it to the clipboard. */
  export() {
    const room = this.serialize();
    const json = JSON.stringify(room, null, 2);
    const name = `${(room.id || 'room').replace(/[^a-z0-9_-]+/gi, '-')}.room.json`;

    try {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.warn('[RoomEditor] download failed:', e);
    }
    // Best-effort clipboard copy (requires a user gesture + permission; the
    // download above is the reliable path).
    navigator.clipboard?.writeText?.(json).catch(() => {});

    this.onStatus(`exported ${name}`);
    return json;
  }
}
