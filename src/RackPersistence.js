// RackPersistence — persist the live AV rack (spawned consoles + the video
// patch graph) so it survives page reloads, including the cross-core reload the
// ROM-swap path triggers ([[src/RoomPersistence.js]] handles room props; this
// handles the running consoles, which live only in memory otherwise).
//
// Pure serialize/parse (no THREE, no DOM, unit-tested) + a thin localStorage
// I/O pair. The primary console (console0) is always present and is NOT stored;
// only user-spawned consoles ([[src/main.js]] spawnConsole) and the full
// TV→console video mapping are. On load main.js re-spawns each console (which
// re-boots its core from the same library game) and replays the video edges.

export const RACK_KEY = 'libretrowebxr.rack';   // localStorage
const SCHEMA = 'libretrowebxr/rack@1';

/**
 * Build the persistable rack descriptor.
 * @param {Array<{system:string,file:string,core:string,title:string}>} consoles
 *   spawned (non-primary) consoles, in spawn order.
 * @param {Array<{tv:string,console:(string|null)}>} video  full TV→console map.
 * @param {{transforms?:Object<string,{pos:number[],rot:number[]}>, power?:Object<string,boolean>}} [layout]
 *   Physical layout of EVERY rack object (primary + spawned), keyed by id
 *   ('console0','tv0','console1',…): position+rotation (so a moved console/TV
 *   survives the cross-core reload instead of snapping back to its default slot)
 *   and on/off power state. Optional + backward-compatible (older saves omit it).
 * @returns {object}
 */
export function serializeRack(consoles, video, layout) {
  const desc = {
    schema: SCHEMA,
    consoles: (consoles || []).map((c) => ({
      system: c.system, file: c.file, core: c.core, title: c.title,
    })),
    video: (video || [])
      .filter((e) => e && e.tv)
      .map((e) => ({ tv: e.tv, console: e.console ?? null })),
  };
  if (layout && (layout.transforms || layout.power)) {
    desc.layout = {
      transforms: layout.transforms || {},
      power: layout.power || {},
    };
  }
  return desc;
}

// Validate a parsed layout block (optional). Drops malformed entries rather than
// rejecting the whole save, so a future/garbled layout never blocks a rack
// restore. Returns { transforms, power } or null.
function parseLayout(layout) {
  if (!layout || typeof layout !== 'object') return null;
  const transforms = {};
  const power = {};
  const t = layout.transforms;
  if (t && typeof t === 'object') {
    for (const [id, v] of Object.entries(t)) {
      if (v && Array.isArray(v.pos) && v.pos.length === 3 && v.pos.every((n) => typeof n === 'number')) {
        const rot = Array.isArray(v.rot) && v.rot.length === 3 && v.rot.every((n) => typeof n === 'number')
          ? v.rot.slice() : [0, 0, 0];
        transforms[id] = { pos: v.pos.slice(), rot };
      }
    }
  }
  const p = layout.power;
  if (p && typeof p === 'object') {
    for (const [id, v] of Object.entries(p)) power[id] = !!v;
  }
  return { transforms, power };
}

/**
 * Validate + normalize a parsed rack descriptor. Returns { consoles, video }
 * or null if it doesn't look like a rack save (so callers can ignore garbage /
 * future schemas). A console entry needs at least a system + file to re-spawn.
 */
export function parseRack(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.schema !== 'string' || !obj.schema.startsWith('libretrowebxr/rack')) return null;
  const consoles = Array.isArray(obj.consoles) ? obj.consoles : [];
  const video = Array.isArray(obj.video) ? obj.video : [];
  const cleanConsoles = consoles
    .filter((c) => c && typeof c.system === 'string' && typeof c.file === 'string')
    .map((c) => ({ system: c.system, file: c.file, core: c.core || null, title: c.title || c.file }));
  const cleanVideo = video
    .filter((e) => e && typeof e.tv === 'string')
    .map((e) => ({ tv: e.tv, console: e.console || null }));
  return { consoles: cleanConsoles, video: cleanVideo, layout: parseLayout(obj.layout) };
}

/** True if the descriptor has nothing worth restoring (no spawned consoles). */
export function isEmptyRack(parsed) {
  return !parsed || !parsed.consoles || parsed.consoles.length === 0;
}

// --- localStorage I/O -------------------------------------------------------

export function saveRack(consoles, video, layout) {
  try {
    const desc = serializeRack(consoles, video, layout);
    if (isEmptyRack(desc)) { localStorage.removeItem(RACK_KEY); return; }
    localStorage.setItem(RACK_KEY, JSON.stringify(desc));
  } catch (e) { console.warn('[RackPersistence] save failed:', e); }
}

export function loadRack() {
  try {
    const raw = localStorage.getItem(RACK_KEY);
    if (!raw) return null;
    return parseRack(JSON.parse(raw));
  } catch (e) { console.warn('[RackPersistence] load failed:', e); return null; }
}

export function clearRack() {
  try { localStorage.removeItem(RACK_KEY); } catch (_) {}
}
