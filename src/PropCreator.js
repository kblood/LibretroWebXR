// PropCreator — PURE descriptor minting for in-VR prop/portal creation (Phase
// E.3). E.1 moves existing props and E.2 edits the room's look; this is the part
// that ADDS new entries to the descriptor. Each function returns a normalized
// prop/portal (shaped exactly like one parsed by [[src/RoomLoader.js]], so it
// round-trips through [[src/RoomSerializer.js]] on Export Room) with a fresh,
// collision-free id. The imperative caller (main.js `addProp`/`addPortal`)
// builds the object via [[src/RoomBuilder.js]] `buildProp`/`buildPortal`,
// registers it as an editable grabbable through [[src/RoomEditor.js]], and
// appends the descriptor here.
//
// No THREE, no DOM — so `npm test` covers it in Node, matching the pure
// (RoomLoader/RoomSerializer/EnvEditor) / imperative (RoomBuilder/RoomEditor)
// split the room layer already uses.

import { normalizeProp, normalizePortal } from './RoomLoader.js';

// The prop types it makes sense to spawn in-VR: each maps to a scene factory
// RoomBuilder can build standalone. `tv` is excluded (it has no object — it only
// toggles the CRT shader) and `model` is excluded (it needs an asset URL there's
// no in-VR way to supply yet).
export const CREATABLE_PROP_TYPES = ['shelf', 'console', 'gamepad', 'poster', 'bookcase', 'cupboard', 'table'];

// Per-type non-spatial defaults baked into a freshly created prop.
// - shelf: no `collection` → RoomBuilder falls back to the room's first
//   collection, so a new shelf shows content immediately.
// - bookcase: same fallback; the collection can be changed via Change-mode
//   (cycleSelected → cycleShelfCollection, same as a shelf prop).
// - poster: gets a visible built-in texture; custom images set via the
//   desktop "Set Poster Image…" affordance override prop.texture directly.
const PROP_DEFAULTS = {
  poster:   { texture: 'builtin:poster-1', size: [0.8, 1.1] },
  shelf:    {},
  console:  {},
  gamepad:  {},
  bookcase: {},  // collection unset → falls back to first collection in RoomBuilder
  cupboard: {},
  table:    {},
};

/** Every id already used by a prop or portal in the room (for collision-free minting). */
export function existingIds(room) {
  const ids = new Set();
  for (const p of (room?.props || [])) if (p?.id) ids.add(p.id);
  for (const p of (room?.portals || [])) if (p?.id) ids.add(p.id);
  return ids;
}

/** First `${type}-<n>` id not already taken in the room. */
export function uniqueId(room, type) {
  const ids = existingIds(room);
  let n = 1;
  while (ids.has(`${type}-${n}`)) n++;
  return `${type}-${n}`;
}

/**
 * Mint a new normalized prop descriptor (does NOT append — call addProp for
 * that). Returns null for a type RoomBuilder can't build standalone, so the
 * caller can surface "can't add that" instead of pushing a dud. `pos` is metres,
 * `rot` is DEGREES (Euler XYZ) — same units a *.room.json uses.
 */
export function createProp(room, type, { pos, rot } = {}) {
  const t = String(type || '').toLowerCase();
  if (!CREATABLE_PROP_TYPES.includes(t)) return null;
  return normalizeProp({
    ...PROP_DEFAULTS[t],
    type: t,
    id: uniqueId(room, t),
    pos: Array.isArray(pos) ? pos : [0, 0, 0],
    rot: Array.isArray(rot) ? rot : [0, 0, 0],
  });
}

/** Mint a new normalized portal aimed at `target` (a room id or URL). Null without a target. */
export function createPortal(room, { target, pos, rot, radius } = {}) {
  if (!target) return null;
  return normalizePortal({
    id: uniqueId(room, 'portal'),
    target,
    radius,
    pos: Array.isArray(pos) ? pos : [0, 0, 0],
    rot: Array.isArray(rot) ? rot : [0, 0, 0],
  });
}

/** Append a prop to `room.props` (creating the array if needed). Returns the prop. */
export function addProp(room, prop) {
  if (!room || !prop) return null;
  if (!Array.isArray(room.props)) room.props = [];
  room.props.push(prop);
  return prop;
}

/** Append a portal to `room.portals` (creating the array if needed). Returns the portal. */
export function addPortal(room, portal) {
  if (!room || !portal) return null;
  if (!Array.isArray(room.portals)) room.portals = [];
  room.portals.push(portal);
  return portal;
}
