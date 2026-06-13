// EnvEditor — PURE option-cycling for in-VR environment editing (Phase E.2:
// swap wallpaper / floor / lighting / posters from the menu). Each function
// mutates a room descriptor's environment (or a poster prop's texture/fit/scale)
// to the next option in a fixed palette and returns the new value. The imperative
// caller (main.js menu buttons) then re-applies it live via
// [[src/SceneMgr.js]] `applyEnvironment` / [[src/RoomBuilder.js]]
// `applyPosterTexture`, and the change rides back out through
// [[src/RoomSerializer.js]] (which echoes `environment` + each prop's fields
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

// Poster palette — the keys RoomBuilder's BUILTIN_COLORS resolves (poster-1/6
// plus the shared retro tints). Keep in sync with BUILTIN_COLORS in
// [[src/RoomBuilder.js]].  Custom URLs (set via the desktop "Set Poster Image…"
// affordance) are NOT part of this cycle — they are applied directly to the
// prop's `texture` field and round-trip through RoomSerializer as-is.
export const POSTER_OPTIONS = [
  'builtin:poster-1', 'builtin:poster-2', 'builtin:poster-3',
  'builtin:poster-4', 'builtin:poster-5', 'builtin:poster-6',
  'builtin:retro-blue', 'builtin:retro-green', 'builtin:retro-pink',
  'builtin:crt-grey', 'builtin:neon-purple', 'builtin:warm-amber',
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

/**
 * Advance a shelf prop's `collection` to the next entry in an ordered list of
 * collection keys (the keys RoomBuilder's `collections.byKey` resolves — a
 * collection url or id). Mutates `prop.collection` and returns the new value so
 * the imperative caller (main.js) can rebuild the shelf's cartridges. Pure: no
 * THREE/DOM, unit-tested in Node. A single-entry (or empty) list is a no-op.
 */
export function cycleShelfCollection(prop, collectionKeys) {
  if (!prop || typeof prop !== 'object') return undefined;
  const keys = Array.isArray(collectionKeys) ? collectionKeys.filter(Boolean) : [];
  if (keys.length === 0) return prop.collection;
  const next = nextInCycle(prop.collection, keys);
  prop.collection = next;
  return next;
}

// Fit-mode palette (matches FIT_MODES in RoomBuilder.js — kept in sync here
// so EnvEditor stays free of THREE/browser imports and remains unit-testable).
export const FIT_MODE_OPTIONS = ['contain', 'cover', 'stretch'];

// Scale steps for in-VR adjustment (factor applied to the image repeat, so
// 1.0 = natural fit, 2.0 = zoom in 2×, 0.5 = zoom out 2×).
const SCALE_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
const DEFAULT_SCALE = 1.0;

/**
 * Cycle a poster prop's `fit` field through contain → cover → stretch.
 * Writes back to `prop.fit` and returns the new value.
 * Pure: no THREE/DOM, unit-tested in Node.
 */
export function cycleFitMode(prop, options = FIT_MODE_OPTIONS) {
  if (!prop || typeof prop !== 'object') return undefined;
  const current = typeof prop.fit === 'string' ? prop.fit : undefined;
  const next = nextInCycle(current, options);
  prop.fit = next;
  return next;
}

/**
 * Step the poster's `scale` field to the next value in SCALE_STEPS.
 * `direction` is 'up' (zoom in → larger value) or 'down' (zoom out → smaller).
 * Clamps at the ends of the list. Returns the new scale value.
 * Pure: no THREE/DOM, unit-tested in Node.
 */
export function stepScale(prop, direction = 'up', steps = SCALE_STEPS) {
  if (!prop || typeof prop !== 'object') return DEFAULT_SCALE;
  const current = typeof prop.scale === 'number' ? prop.scale : DEFAULT_SCALE;
  let idx = steps.findIndex((s) => s >= current - 1e-6);
  if (idx < 0) idx = steps.length - 1;
  if (direction === 'up') {
    idx = Math.min(idx + 1, steps.length - 1);
  } else {
    // When current is already at or above the current step, go to idx-1; else stay.
    if (Math.abs(steps[idx] - current) < 1e-6 && idx > 0) idx--;
    else if (idx > 0) idx--;
    idx = Math.max(idx, 0);
  }
  prop.scale = steps[idx];
  return prop.scale;
}
