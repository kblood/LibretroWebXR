// RoomSerializer — PURE inverse of [[src/RoomLoader.js]]'s parseRoom: turn a
// canonical room descriptor (plus the live transforms harvested from the scene
// by the in-VR editor) back into a clean, shareable *.room.json object. No
// THREE, no DOM — so `npm test` covers it in Node, mirroring the parse-here /
// build-there split the project already uses (RoomLoader parses, RoomBuilder
// builds; here we serialize what the editor moved).
//
// The division of labour that makes this work (see docs/HANDOFF "core idea"):
// the descriptor carries every NON-spatial field (a shelf's collection/half/
// filter, a poster's texture, a tv's shader, a portal's target/radius) that a
// THREE.Object3D can't reproduce; the live objects carry the authoritative
// pos/rot after editing. So serialization = the original descriptor with each
// prop/portal's pos/rot refreshed from the `transforms` map by id.

import { ROOM_SCHEMA } from './RoomLoader.js';

// Keys we never want to echo back into the exported file: the canonical fields
// we re-emit explicitly, plus parser/editor bookkeeping. Everything else on a
// prop (collection, half, filter, slice, size, texture, shader, asset, scale,
// …) is an authored extra and is preserved verbatim.
const PROP_OMIT = new Set(['type', 'id', 'pos', 'rot']);
const PORTAL_OMIT = new Set(['id', 'pos', 'rot', 'target', 'radius']);

/** Round a finite number to `dp` decimals; pass non-finite through as 0. */
export function round(n, dp = 3) {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** dp;
  // +0 normalizes -0 → 0 so JSON never shows "-0".
  return Math.round(n * f) / f + 0;
}

const roundVec = (v, dp = 3) =>
  (Array.isArray(v) ? [round(v[0], dp), round(v[1], dp), round(v[2], dp)] : [0, 0, 0]);

// Copy the authored extras off a normalized entry, skipping the canonical keys
// we emit by hand. Keeps forward-authored fields (e.g. a future prop option)
// intact through an edit→export round-trip.
function extras(entry, omit) {
  const out = {};
  for (const [k, val] of Object.entries(entry)) {
    if (!omit.has(k) && val !== undefined) out[k] = val;
  }
  return out;
}

/** pos/rot for an entry: the live transform if the editor moved it, else the descriptor's. */
function transformFor(entry, transforms) {
  const t = transforms && typeof transforms.get === 'function' ? transforms.get(entry.id) : null;
  return {
    pos: roundVec(t?.pos ?? entry.pos),
    rot: roundVec(t?.rot ?? entry.rot),
  };
}

/**
 * Serialize a parsed room descriptor + live transforms into a clean room@1
 * object ready for JSON.stringify / download.
 *
 * @param {object} room  a descriptor from RoomLoader.parseRoom / defaultRoom.
 * @param {Map<string,{pos:number[],rot:number[]}>} [transforms]  live pos (m)
 *        + rot (DEGREES, Euler XYZ) by prop/portal id. Missing ids keep the
 *        descriptor's values, so an empty map is an identity round-trip.
 */
export function serializeRoom(room, transforms = new Map()) {
  const r = room && typeof room === 'object' ? room : {};
  const props = (Array.isArray(r.props) ? r.props : []).map((p) => {
    const { pos, rot } = transformFor(p, transforms);
    return { type: p.type, id: p.id, ...extras(p, PROP_OMIT), pos, rot };
  });
  const portals = (Array.isArray(r.portals) ? r.portals : []).map((p) => {
    const { pos, rot } = transformFor(p, transforms);
    return { id: p.id, target: p.target, radius: p.radius, ...extras(p, PORTAL_OMIT), pos, rot };
  });

  const out = {
    schema: r.schema || ROOM_SCHEMA,
    id: r.id || 'room',
    title: r.title || r.id || 'room',
    collections: Array.isArray(r.collections) ? r.collections.slice() : [],
    environment: r.environment && typeof r.environment === 'object' ? r.environment : {},
    props,
    portals,
  };
  if (r.author) out.author = r.author;
  return out;
}
