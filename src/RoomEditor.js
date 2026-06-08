// RoomEditor — the imperative side of the in-VR room editor. Owns the editor
// MODE, makes the room's props grabbable/selectable while editing, and harvests
// their live transforms back into a *.room.json on export. The pure
// serialization lives in [[src/RoomSerializer.js]]; grabbing/moving reuses the
// existing [[src/GrabMgr.js]] (this just flips it into a mode and registers
// the props as editable grabbables). main.js wires the menu buttons to here.
//
// Three modes (replacing the old single Edit toggle):
//   - 'move'   — grab a prop to reposition it (the original E.1 behaviour).
//   - 'change' — grip-SELECT a prop, then cycle its properties from the menu
//                (poster art, shelf collection); GrabMgr routes grip to select.
//   - 'add'    — spawn furniture; freshly added props are grab-to-place.
//   - 'off'    — play mode; props are inert.
//
// Division of labour (see RoomSerializer): the descriptor `this.room` keeps
// every non-spatial field; the live objects keep authoritative pos/rot. On
// export we read each placed object's transform and hand both to serializeRoom.

import { serializeRoom } from './RoomSerializer.js';

const DEG = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

const GRID_POS = 0.1;          // metres — snap step for position
const GRID_ROT = 15 * DEG;     // radians — snap step for rotation (15°)

const MODES = ['off', 'move', 'change', 'add'];
const HILITE_SCALE = 1.06;     // selected-prop highlight: a slight scale bump

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
    this._mode = 'off';
    this._snap = false;
    this._selected = null;        // { prop, object } currently selected (Change mode)
    this._onSelect = () => {};    // menu hook: fires with the selected record (or null)

    // Register every placed prop as an editable grabbable. GrabMgr's candidate
    // filter keeps them inert until edit mode is on, so this is safe to do once
    // up front (no behavior change in play mode).
    for (const { object } of this.placed) this._makeEditable(object);
  }

  // Mark an object as an editable prop and register it for grabbing. GrabMgr's
  // candidate filter keeps it inert until edit mode is on (and dedupes), so this
  // is safe in either mode. Used for the initial props and for props created
  // at runtime (Phase E.3 via registerPlaced).
  _makeEditable(object) {
    object.userData.editable = true;
    this.grabMgr.addGrabbable(object);
  }

  /** Any non-off mode counts as "editing" — GrabMgr's candidate filter keys off
   * this (editable props grabbable while editing, cartridges only in play). */
  isEditMode() { return this._mode !== 'off'; }
  getMode() { return this._mode; }
  snapEnabled() { return this._snap; }

  /**
   * Switch editor mode. Leaving 'change' clears any selection. Returns the new
   * mode. Unknown modes fall back to 'off'.
   */
  setMode(mode) {
    const m = MODES.includes(mode) ? mode : 'off';
    if (m === this._mode) return m;
    if (this._mode === 'change' && m !== 'change') this.clearSelection();
    this._mode = m;
    const msg = {
      off: 'Play mode',
      move: 'Move mode: grab props to reposition them',
      change: 'Change mode: grip a prop to select, then cycle its options',
      add: 'Add mode: pick furniture to place',
    }[m];
    this.onStatus(msg);
    return m;
  }

  /** Back-compat helper for addProp/ensureEditMode: on→'move', off→'off'. */
  setEditMode(on) {
    this.setMode(on ? 'move' : 'off');
    return this.isEditMode();
  }

  /** Toggle between play and move. Returns true if now editing. */
  toggle() {
    this.setMode(this.isEditMode() ? 'off' : 'move');
    return this.isEditMode();
  }

  // --- Change-mode selection ------------------------------------------------

  /** Register a callback fired with the selected `{prop,object}` record (or null). */
  onSelect(cb) { this._onSelect = cb || (() => {}); }

  /** The currently selected record `{prop,object}` (Change mode), or null. */
  selectedProp() { return this._selected; }

  /** Select a placed prop by its object (Change mode). No-op for unknown objects. */
  select(object) {
    const rec = this.placed.find((p) => p.object === object);
    if (!rec || rec === this._selected) return;
    this._unhighlight(this._selected?.object);
    this._selected = rec;
    this._highlight(rec.object);
    this.onStatus(`selected ${rec.prop.id}`);
    this._onSelect(rec);
  }

  /** Clear the current selection (restores highlight). */
  clearSelection() {
    if (!this._selected) return;
    this._unhighlight(this._selected.object);
    this._selected = null;
    this._onSelect(null);
  }

  _highlight(object) {
    if (!object || object.userData._hiliteOrig) return;
    object.userData._hiliteOrig = object.scale.clone();
    object.scale.multiplyScalar(HILITE_SCALE);
  }

  _unhighlight(object) {
    const orig = object?.userData?._hiliteOrig;
    if (!orig) return;
    object.scale.copy(orig);
    delete object.userData._hiliteOrig;
  }

  /**
   * Register a prop created at runtime (Phase E.3): link its descriptor↔object,
   * make it an editable grabbable, and add it to the placed set so the next
   * Export Room harvests its live transform. The caller (main.js `addProp`)
   * already pushed `prop` into the room descriptor and built `object` via
   * [[src/RoomBuilder.js]] `buildProp`/`buildPortal`.
   */
  registerPlaced(prop, object) {
    if (!prop || !object) return;
    object.userData.roomProp = prop;
    this.placed.push({ prop, object });
    this._makeEditable(object);
  }

  /**
   * Drop a placed prop's object from the editor's set (it keeps its descriptor
   * in `room.props`). Used by the in-VR Change-mode shelf rebuild, which swaps
   * the live object for a freshly built one while leaving the `prop` in place.
   * Clears the selection if it pointed at this object. The caller removes the
   * object from the scene and from GrabMgr.
   */
  removePlaced(object) {
    if (this._selected?.object === object) this.clearSelection();
    this._unhighlight(object);
    const i = this.placed.findIndex((p) => p.object === object);
    if (i >= 0) this.placed.splice(i, 1);
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
