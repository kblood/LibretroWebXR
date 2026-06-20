// Bindings — the DESKTOP (flat-screen) input-binding model.
//
// On desktop the emulated RetroPad is driven entirely by synthetic key events
// ([[src/InputMgr.js]] → [[src/EmulatorClient.js]] sendInput). Historically the
// physical key the user pressed WAS the code forwarded to the core (KeyH → the
// core's A). This module adds a remappable indirection so a user can bind ANY
// physical key OR PC-gamepad button/axis to each logical RetroPad button, while
// the core still only ever sees the button's CANONICAL code(s) from
// [[src/ControllerMaps.js]] RETROPAD_KEYS. Translate, don't passthrough.
//
// Model (per player): logical RetroPad button → { key?, pad? } where
//   key  = a KeyboardEvent.code string (the physical key bound to this button)
//   pad  = { type:'button', index } | { type:'axis', index, dir:-1|+1 }
// Defaults reproduce today's behaviour EXACTLY: every default `key` is the
// physical key the old InputMgr forwarded, and the canonical codes it resolves
// to are unchanged. A fresh user (no saved config) notices zero difference.
//
// Player 1 is the MVP and the only player wired into the UI, but the storage is
// per-player (DEFAULTS / persistence are keyed by player) so players 2-4 are a
// natural extension. P2-4 still translate to their own EXTRA_PLAYER_KEYS codes.
//
// Persistence: localStorage under STORAGE_KEY. Bad/old JSON falls back to
// defaults silently — a corrupt config must never break input.

import {
  RETROPAD_KEYS, EXTRA_PLAYER_KEYS,
} from './ControllerMaps.js';

export const STORAGE_KEY = 'lwx.bindings.v1';

// The 14 logical RetroPad buttons, in a stable display order for the UI.
export const RETROPAD_BUTTONS = [
  'Up', 'Down', 'Left', 'Right',
  'A', 'B', 'X', 'Y',
  'L', 'R', 'L2', 'R2',
  'Start', 'Select',
];

// Canonical KeyboardEvent payloads for EVERY code the core can receive, keyed by
// code. This is the union of player-1 codes (RETROPAD_KEYS values) and the P2-4
// codes (EXTRA_PLAYER_KEYS). sendInput needs {key, keyCode, location} alongside
// the code; emscripten's HTML5 layer reads keyCode/which, and ShiftRight needs
// location:2. Kept here as the single source of truth for the desktop path so
// InputMgr/DesktopGamepad build identical events.  Mirrors GameInputMgr.KEY_TABLE
// for the overlapping codes (same key/keyCode values) — both feed the same cores.
export const KEY_PAYLOADS = {
  ArrowUp:    { code: 'ArrowUp',    key: 'ArrowUp',    keyCode: 38 },
  ArrowDown:  { code: 'ArrowDown',  key: 'ArrowDown',  keyCode: 40 },
  ArrowLeft:  { code: 'ArrowLeft',  key: 'ArrowLeft',  keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 },
  Enter:      { code: 'Enter',      key: 'Enter',      keyCode: 13 },
  Space:      { code: 'Space',      key: ' ',          keyCode: 32 },
  ShiftRight: { code: 'ShiftRight', key: 'Shift',      keyCode: 16, location: 2 },
  KeyH:       { code: 'KeyH',       key: 'h',          keyCode: 72 },
  KeyG:       { code: 'KeyG',       key: 'g',          keyCode: 71 },
  KeyX:       { code: 'KeyX',       key: 'x',          keyCode: 88 },
  KeyZ:       { code: 'KeyZ',       key: 'z',          keyCode: 90 },
  KeyY:       { code: 'KeyY',       key: 'y',          keyCode: 89 },
  KeyT:       { code: 'KeyT',       key: 't',          keyCode: 84 },
  KeyS:       { code: 'KeyS',       key: 's',          keyCode: 83 },
  KeyA:       { code: 'KeyA',       key: 'a',          keyCode: 65 },
  KeyE:       { code: 'KeyE',       key: 'e',          keyCode: 69 },
  KeyQ:       { code: 'KeyQ',       key: 'q',          keyCode: 81 },
  KeyP:       { code: 'KeyP',       key: 'p',          keyCode: 80 },
  KeyW:       { code: 'KeyW',       key: 'w',          keyCode: 87 },
  KeyR:       { code: 'KeyR',       key: 'r',          keyCode: 82 },
  KeyO:       { code: 'KeyO',       key: 'o',          keyCode: 79 },
};

// The physical key the OLD InputMgr forwarded for each logical button = the
// FIRST canonical code in RETROPAD_KEYS (the webretro cfg key — what a user
// pressed pre-rebind). Default `key` bindings use these so behaviour is byte-for
// -byte unchanged. Select's first code is 'Space', Start's is 'Enter', etc.
const DEFAULT_P1_KEY = {};
for (const btn of RETROPAD_BUTTONS) DEFAULT_P1_KEY[btn] = RETROPAD_KEYS[btn]?.[0] || null;

// Build the default binding map for a player. P1 uses DEFAULT_P1_KEY (the
// historical physical keys); P2-4 use their single EXTRA_PLAYER_KEYS code. No
// default gamepad binding (pad undefined) — the user opts into the PC gamepad.
function defaultsForPlayer(player) {
  const map = {};
  for (const btn of RETROPAD_BUTTONS) {
    const key = player <= 1 ? DEFAULT_P1_KEY[btn] : (EXTRA_PLAYER_KEYS[player]?.[btn] || null);
    map[btn] = { key, pad: null };
  }
  return map;
}

// The canonical core code(s) a logical button dispatches for a player. P1 keeps
// the resilient double-dispatch (cfg key + RA stock); P2-4 send their one code.
// This is the SAME rule as GameInputMgr.codesFor — desktop + VR agree.
export function canonicalCodes(player, btn) {
  if (!btn) return [];
  if (player <= 1) return RETROPAD_KEYS[btn] || [];
  const code = EXTRA_PLAYER_KEYS[player]?.[btn];
  return code ? [code] : [];
}

export class Bindings {
  // players: which player indices to manage (default just P1 — the UI MVP).
  // Passing [1,2,3,4] would manage couch-co-op binds too.
  constructor({ players = [1], storage = (typeof localStorage !== 'undefined' ? localStorage : null) } = {}) {
    this.players = players;
    this.storage = storage;
    // player -> { btn -> { key, pad } }
    this.map = {};
    for (const p of players) this.map[p] = defaultsForPlayer(p);
    this.load();
    this._rebuildIndexes();
  }

  // --- reverse indexes (rebuilt after every mutation) ----------------------
  // Physical KeyboardEvent.code -> [{ player, btn }]  (a key can drive >1 button
  // in theory; we keep a list so nothing is silently dropped).
  // Gamepad signature -> [{ player, btn }] where signature is
  //   `b:<index>` for a button, `a:<index>:<dir>` for an axis direction.
  _rebuildIndexes() {
    this.byKey = new Map();
    this.byPad = new Map();
    for (const p of this.players) {
      const pm = this.map[p];
      for (const btn of RETROPAD_BUTTONS) {
        const b = pm[btn];
        if (!b) continue;
        if (b.key) {
          if (!this.byKey.has(b.key)) this.byKey.set(b.key, []);
          this.byKey.get(b.key).push({ player: p, btn });
        }
        if (b.pad) {
          const sig = padSig(b.pad);
          if (sig) {
            if (!this.byPad.has(sig)) this.byPad.set(sig, []);
            this.byPad.get(sig).push({ player: p, btn });
          }
        }
      }
    }
  }

  // Logical-button lookups for a physical input. Return [{player, btn, codes}].
  // codes is the canonical core code list to dispatch.
  lookupKey(code) {
    const hits = this.byKey.get(code);
    if (!hits) return [];
    return hits.map((h) => ({ ...h, codes: canonicalCodes(h.player, h.btn) }));
  }

  lookupPad(sig) {
    const hits = this.byPad.get(sig);
    if (!hits) return [];
    return hits.map((h) => ({ ...h, codes: canonicalCodes(h.player, h.btn) }));
  }

  // Is this physical code bound to ANY button? (InputMgr's forward gate.)
  hasKey(code) { return this.byKey.has(code); }

  // --- mutation ------------------------------------------------------------
  get(player, btn) { return this.map[player]?.[btn] || null; }

  // Set the key (or pad) binding for one button. Pass key=null to clear the key.
  setKey(player, btn, code) {
    if (!this.map[player]?.[btn]) return;
    this.map[player][btn].key = code || null;
    this._rebuildIndexes();
    this.save();
  }

  setPad(player, btn, pad) {
    if (!this.map[player]?.[btn]) return;
    this.map[player][btn].pad = pad || null;
    this._rebuildIndexes();
    this.save();
  }

  // Reset one player (or all managed players) to factory defaults.
  resetDefaults(player) {
    const list = player == null ? this.players : [player];
    for (const p of list) this.map[p] = defaultsForPlayer(p);
    this._rebuildIndexes();
    this.save();
  }

  // --- persistence ---------------------------------------------------------
  save() {
    if (!this.storage) return;
    try {
      // Only persist the managed players; merge with any other-player config
      // already stored so a P1-only UI doesn't clobber P2-4 binds someone set.
      let existing = {};
      try { existing = JSON.parse(this.storage.getItem(STORAGE_KEY) || '{}'); } catch (_) {}
      const out = { v: 1, players: { ...(existing.players || {}) } };
      for (const p of this.players) out.players[p] = this.map[p];
      this.storage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch (e) {
      // Storage full / disabled / private mode — binds just won't persist.
      console.warn('[Bindings] save failed:', e);
    }
  }

  // Load saved binds over the defaults. Unknown buttons are ignored; a missing
  // button keeps its default — so a partial/old config still produces a complete,
  // working map.
  load() {
    if (!this.storage) return;
    let raw;
    try { raw = JSON.parse(this.storage.getItem(STORAGE_KEY) || 'null'); } catch (_) { raw = null; }
    if (!raw || !raw.players) return;
    for (const p of this.players) {
      const saved = raw.players[p];
      if (!saved) continue;
      for (const btn of RETROPAD_BUTTONS) {
        const b = saved[btn];
        if (!b || typeof b !== 'object') continue;
        if ('key' in b) this.map[p][btn].key = b.key || null;
        if ('pad' in b) this.map[p][btn].pad = normalizePad(b.pad);
      }
    }
  }

  // Snapshot for the UI / debug — plain JSON of the managed players.
  toJSON() {
    const out = {};
    for (const p of this.players) out[p] = this.map[p];
    return out;
  }
}

// Canonical signature string for a pad binding (index into byPad).
export function padSig(pad) {
  if (!pad) return null;
  if (pad.type === 'button' && Number.isInteger(pad.index)) return `b:${pad.index}`;
  if (pad.type === 'axis' && Number.isInteger(pad.index) && (pad.dir === 1 || pad.dir === -1)) {
    return `a:${pad.index}:${pad.dir}`;
  }
  return null;
}

// Validate/normalize a stored pad object (guards against hand-edited localStorage).
function normalizePad(pad) {
  if (!pad || typeof pad !== 'object') return null;
  if (pad.type === 'button' && Number.isInteger(pad.index)) return { type: 'button', index: pad.index };
  if (pad.type === 'axis' && Number.isInteger(pad.index) && (pad.dir === 1 || pad.dir === -1)) {
    return { type: 'axis', index: pad.index, dir: pad.dir };
  }
  return null;
}
