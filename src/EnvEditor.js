// EnvEditor — PURE option-cycling for in-VR environment editing (Phase E.2:
// swap wallpaper / floor / lighting / posters from the menu). Each function
// mutates a room descriptor's environment (or a poster prop's texture) to the
// next option in a fixed palette and returns the new value. The imperative
// caller (main.js menu buttons) then re-applies it live via
// [[src/SceneMgr.js]] `applyEnvironment` / [[src/RoomBuilder.js]]
// `applyPosterTexture`, and the change rides back out through
// [[src/RoomSerializer.js]] (which echoes `environment` + each prop's `texture`
// verbatim) on export — so editing in VR and re-sharing the room Just Works.
//
// No THREE, no DOM — so `npm test` covers it in Node, mirroring the pure
// (RoomSerializer) / imperative (RoomEditor) split the room layer already uses.

// Wall + floor palette — the keys SceneMgr's BUILTIN_SURFACES resolves to a
// flat colour (so no texture needs shipping). Keep in sync with that map.
export const SURFACE_OPTIONS = [
  'builtin:retro-blue', 'builtin:retro-green', 'builtin:retro-pink',
  'builtin:crt-grey', 'builtin:wood', 'builtin:dark',
];

// Poster palette — the keys RoomBuilder's BUILTIN_COLORS resolves (poster-1/2
// plus the shared retro tints). Keep in sync with that map.
export const POSTER_OPTIONS = [
  'builtin:poster-1', 'builtin:poster-2', 'builtin:retro-blue',
  'builtin:retro-green', 'builtin:retro-pink', 'builtin:crt-grey',
];

// Lighting presets SceneMgr's TIME_OF_DAY knows.
export const TIME_OF_DAY_OPTIONS = ['day', 'evening', 'night'];

/**
 * Next entry after `current` in `options` (wraps around). An absent/unknown
 * current value starts the cycle at the first option.
 */
export function nextInCycle(current, options) {
  const i = options.indexOf(current);
  return options[(i + 1) % options.length];
}

/** Ensure `room.environment.{surfaces,lighting}` exist; returns environment. */
export function ensureEnvironment(room) {
  if (!room || typeof room !== 'object') return { surfaces: {}, lighting: {} };
  if (!room.environment || typeof room.environment !== 'object') room.environment = {};
  const env = room.environment;
  if (!env.surfaces || typeof env.surfaces !== 'object') env.surfaces = {};
  if (!env.lighting || typeof env.lighting !== 'object') env.lighting = {};
  return env;
}

// A surface spec may be a bare string or `{ texture, tiling, color }`. Read the
// current texture/colour string so we can find our place in the cycle.
function currentTexture(spec) {
  if (typeof spec === 'string') return spec;
  if (spec && typeof spec === 'object') return spec.texture || spec.color;
  return undefined;
}

/**
 * Cycle a surface to the next palette entry. `key` is `'wallpaper'` (all walls)
 * or `'floor'` / `'ceiling'`. Writes back a flat `builtin:` string (both
 * applyEnvironment and the serializer accept that). Returns the new value.
 */
export function cycleSurface(room, key, options = SURFACE_OPTIONS) {
  const env = ensureEnvironment(room);
  const next = nextInCycle(currentTexture(env.surfaces[key]), options);
  env.surfaces[key] = next;
  return next;
}

/** Cycle the time-of-day lighting preset (lamps preserved). Returns new value. */
export function cycleTimeOfDay(room, options = TIME_OF_DAY_OPTIONS) {
  const env = ensureEnvironment(room);
  const next = nextInCycle(env.lighting.timeOfDay, options);
  env.lighting.timeOfDay = next;
  return next;
}

/** Advance one poster prop's `texture` to the next option. Returns new value. */
export function cyclePosterTexture(prop, options = POSTER_OPTIONS) {
  if (!prop || typeof prop !== 'object') return undefined;
  const next = nextInCycle(currentTexture(prop.texture), options);
  prop.texture = next;
  return next;
}
