// Collection — load and normalize a game collection into cartridge-ready
// entries. Accepts both the new `*.collection.json` schema and the legacy
// `roms/manifest.json` (a bare { cartridges: [...] }); they're supersets, so
// one loader handles both (see docs/ROOM_AND_COLLECTIONS.md).
//
// Normalization fills in what a cartridge needs but a collection may omit:
//   - core      : from the game's system's defaultCore (or detected from file)
//   - boxart    : an ordered candidate list via ArtResolver (Cartridge tries
//                 each until one loads); explicit boxart still wins
//   - system    : detected from the file extension if absent
//
// The output entry keeps the exact field names Cartridge.js/main.js already
// consume (file, system, core, title, color, boxart) plus extras (boxartList,
// license, credits, rom) that newer code can use and older code ignores.

import { SYSTEMS, coreForFile, systemForFile, CORES } from './systems.js';
import { boxartCandidates } from './ArtResolver.js';

/** Normalize one raw game/cartridge record. Returns null if unloadable. */
export function normalizeGame(raw) {
  if (!raw || !raw.file) return null;
  const g = { ...raw };

  // System: explicit, else detect from file extension.
  if (!g.system) g.system = systemForFile(g.file) || undefined;
  const sys = g.system ? SYSTEMS[g.system] : null;

  // Core: explicit (if known), else system default, else detect from file.
  if (!g.core || !CORES[g.core]) {
    g.core = (sys && sys.defaultCore) || coreForFile(g.file)?.name || g.core;
  }

  // Box art: ordered candidate list (explicit boxart kept first inside).
  const candidates = boxartCandidates(g, sys);
  g.boxartList = candidates;
  if (!g.boxart && candidates.length) g.boxart = candidates[0];

  return g;
}

/**
 * Parse a collection/manifest object into { id, title, games[] }.
 * Accepts:  { games: [...] }  (collection schema)
 *        or { cartridges: [...] }  (legacy manifest)
 * Unloadable entries are dropped (with a warning) rather than throwing, so one
 * bad row doesn't blank the whole wall.
 */
export function parseCollection(obj, { sourceLabel = 'collection' } = {}) {
  const rawList = Array.isArray(obj?.games) ? obj.games
                : Array.isArray(obj?.cartridges) ? obj.cartridges
                : [];
  const games = [];
  for (const raw of rawList) {
    const g = normalizeGame(raw);
    if (g) games.push(g);
    else console.warn(`[collection] dropped unloadable entry in ${sourceLabel}:`, raw);
  }
  return {
    id: obj?.id || sourceLabel,
    title: obj?.title || obj?.id || sourceLabel,
    author: obj?.author,
    games,
  };
}

/**
 * Fetch + parse a collection from a URL (browser only).
 * Returns { id, title, games[] } (games possibly empty on failure).
 */
export async function loadCollection(url, { fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(url);
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    const obj = await r.json();
    return parseCollection(obj, { sourceLabel: url });
  } catch (e) {
    console.warn('[collection] load failed:', e.message || e);
    return { id: url, title: url, games: [] };
  }
}
