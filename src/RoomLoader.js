// RoomLoader — PURE parse/normalize of a *.room.json into a canonical room
// descriptor. No THREE, no DOM. The imperative builder ([[src/RoomBuilder.js]])
// consumes this descriptor and drives the existing scene factories
// (createShelf/Console/Cartridge/...). This mirrors the split the project
// already uses for games: Collection.js parses, main.js/RoomBuilder builds.
// Keeping the parsing pure is what lets `npm test` cover it in Node without a
// browser. See docs/ROOM_AND_COLLECTIONS.md §3 for the schema.

export const ROOM_SCHEMA = 'libretrowebxr/room@1';

// Prop kinds the builder knows how to instantiate. Unknown kinds are dropped
// (with a warning at build time), not fatal — forward-compatibility for rooms
// authored against a newer builder.
export const PROP_TYPES = ['shelf', 'console', 'gamepad', 'tv', 'poster', 'model'];
const PROP_SET = new Set(PROP_TYPES);

function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

/** Coerce to a [x,y,z] number triple; missing/!finite components become `d`. */
export function vec3(v, d = 0) {
  if (Array.isArray(v)) return [num(v[0], d), num(v[1], d), num(v[2], d)];
  return [d, d, d];
}

/**
 * Normalize one raw prop. `rot` stays in DEGREES (Euler XYZ) — the builder
 * converts to radians so room files read naturally. Returns null for an
 * unknown/missing type so the whole room doesn't blank on one bad prop.
 */
export function normalizeProp(raw, i = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').toLowerCase();
  if (!PROP_SET.has(type)) return null;
  return {
    ...raw,
    type,
    id: raw.id || `${type}-${i + 1}`,
    pos: vec3(raw.pos, 0),
    rot: vec3(raw.rot, 0),
  };
}

/** Normalize one portal. Requires a `target` (room id or URL) or it's dropped. */
export function normalizePortal(raw, i = 0) {
  if (!raw || !raw.target) return null;
  return {
    ...raw,
    id: raw.id || `portal-${i + 1}`,
    pos: vec3(raw.pos, 0),
    rot: vec3(raw.rot, 0),
    target: String(raw.target),
    radius: num(raw.radius, 0.6),
  };
}

/**
 * Every collection a room needs to load, de-duplicated in declared order:
 * top-level `collections[]` first, then any `collection` a shelf names that
 * wasn't already listed. Entries are URLs or ids (strings) or {url|id} objects.
 */
export function roomCollectionRefs(room) {
  const out = [];
  const seen = new Set();
  const add = (c) => {
    const ref = typeof c === 'string' ? c : (c?.url || c?.id);
    if (ref && !seen.has(ref)) { seen.add(ref); out.push(ref); }
  };
  (room?.collections || []).forEach(add);
  (room?.props || []).forEach((p) => { if (p?.collection) add(p.collection); });
  return out;
}

/**
 * Parse + normalize a raw room object into a canonical descriptor. Tolerant:
 * a missing/garbage field degrades to an empty default rather than throwing,
 * so a partially-authored room still renders what it can.
 */
export function parseRoom(obj, { sourceLabel = 'room' } = {}) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const props = (Array.isArray(o.props) ? o.props : [])
    .map((p, i) => normalizeProp(p, i)).filter(Boolean);
  const portals = (Array.isArray(o.portals) ? o.portals : [])
    .map((p, i) => normalizePortal(p, i)).filter(Boolean);
  const collections = (Array.isArray(o.collections) ? o.collections : [])
    .map((c) => (typeof c === 'string' ? c : (c?.url || c?.id)))
    .filter(Boolean);
  return {
    schema: o.schema || ROOM_SCHEMA,
    id: o.id || sourceLabel,
    title: o.title || o.id || sourceLabel,
    author: o.author,
    collections,
    environment: o.environment && typeof o.environment === 'object' ? o.environment : {},
    props,
    portals,
  };
}

/**
 * The built-in room that reproduces the historical hardcoded layout: two
 * wall-mounted shelves holding the left/right halves of the collection, plus
 * a console + gamepad on the TV stand. Used whenever no `?room=` is supplied,
 * so default behavior is unchanged from before RoomLoader existed.
 *
 * `half: 'left'|'right'` is a layout hint the builder honors by splitting the
 * shelf's collection in two (mirrors the old main.js split, adapts to any
 * game count). `rot` is in degrees.
 */
export function defaultRoom(collectionRef = 'roms/manifest.json') {
  return {
    schema: ROOM_SCHEMA,
    id: 'default',
    title: 'LibretroWebXR',
    collections: [collectionRef],
    environment: {},
    props: [
      { type: 'shelf',   id: 'shelf-left',  collection: collectionRef, half: 'left',
        pos: [-2.85, 1.25, -1.5], rot: [0, 90, 0] },
      { type: 'shelf',   id: 'shelf-right', collection: collectionRef, half: 'right',
        pos: [2.85, 1.25, -1.5],  rot: [0, -90, 0] },
      { type: 'console', id: 'console-1',   pos: [0, 0.74, -2.4],     rot: [0, 0, 0] },
      { type: 'gamepad', id: 'gamepad-1',   pos: [0.55, 0.78, -2.15], rot: [0, 0, 0] },
    ],
    portals: [],
  };
}
