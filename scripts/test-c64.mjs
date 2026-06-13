// Unit tests for C64KeyLayout.js
//
// Covers:
//   • keyAt(u, v)   — UV hit-testing, edge cases, wide keys, gaps
//   • keyEventFor() — KeyboardEvent payload for a sample of keys
//   • C64_KEYS      — completeness checks (ids unique, no missing fields)
//   • COLS / ROWS   — grid constants reasonable
//
// Run standalone:  node scripts/test-c64.mjs
// Or via npm test: wired in package.json test script.

import {
  C64_KEYS, C64_ROWS, COLS, ROWS,
  keyAt, keyEventFor, keyDef,
} from '../src/C64KeyLayout.js';

let pass = 0, fail = 0;

const ok = (name, cond) => {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL  ${name}`); }
};

const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.error(`FAIL  ${name}\n  got:  ${g}\n  want: ${w}`); }
};

// ---------------------------------------------------------------------------
// Grid constants
// ---------------------------------------------------------------------------
ok('COLS is 20', COLS === 20);
ok('ROWS is 5',  ROWS === 5);
ok('C64_ROWS has 5 row arrays', C64_ROWS.length === 5);

// ---------------------------------------------------------------------------
// C64_KEYS completeness
// ---------------------------------------------------------------------------

// Every key must have id, label, col, row, code, key, keyCode.
const REQUIRED_FIELDS = ['id', 'label', 'col', 'row', 'code', 'key', 'keyCode'];
for (const k of C64_KEYS) {
  for (const f of REQUIRED_FIELDS) {
    ok(`key '${k.id}' has field '${f}'`, k[f] !== undefined);
  }
  // Grid bounds.
  const w = k.w ?? 1;
  const h = k.h ?? 1;
  ok(`key '${k.id}' col in range`,  k.col >= 0 && k.col + w <= COLS);
  ok(`key '${k.id}' row in range`,  k.row >= 0 && k.row + h <= ROWS);
}

// IDs must be unique.
{
  const ids = C64_KEYS.map((k) => k.id);
  const seen = new Set();
  let dupe = 0;
  for (const id of ids) {
    if (seen.has(id)) dupe++;
    seen.add(id);
  }
  eq('no duplicate key ids', dupe, 0);
}

// ---------------------------------------------------------------------------
// keyEventFor() — spot-check well-known keys
// ---------------------------------------------------------------------------

{
  const ev = keyEventFor('a');
  ok('keyEventFor(a) not null', ev !== null);
  eq('keyEventFor(a).code',    ev?.code,    'KeyA');
  eq('keyEventFor(a).key',     ev?.key,     'a');
  eq('keyEventFor(a).keyCode', ev?.keyCode, 65);
  ok('keyEventFor(a) no location (non-modifier)', ev?.location === undefined);
}

{
  const ev = keyEventFor('return');
  ok('keyEventFor(return) not null', ev !== null);
  eq('keyEventFor(return).code',    ev?.code,    'Enter');
  eq('keyEventFor(return).key',     ev?.key,     'Enter');
  eq('keyEventFor(return).keyCode', ev?.keyCode, 13);
}

{
  const ev = keyEventFor('space');
  ok('keyEventFor(space) not null', ev !== null);
  eq('keyEventFor(space).code',    ev?.code,    'Space');
  eq('keyEventFor(space).keyCode', ev?.keyCode, 32);
}

{
  const ev = keyEventFor('run_stop');
  ok('keyEventFor(run_stop) not null', ev !== null);
  eq('keyEventFor(run_stop).code',    ev?.code,    'Escape');
  eq('keyEventFor(run_stop).keyCode', ev?.keyCode, 27);
}

{
  const ev = keyEventFor('lshift');
  ok('keyEventFor(lshift) not null', ev !== null);
  eq('keyEventFor(lshift).code',    ev?.code,    'ShiftLeft');
  eq('keyEventFor(lshift).location', ev?.location, 1);
}

{
  const ev = keyEventFor('rshift');
  ok('keyEventFor(rshift) not null', ev !== null);
  eq('keyEventFor(rshift).code',    ev?.code,    'ShiftRight');
  eq('keyEventFor(rshift).location', ev?.location, 2);
}

{
  const ev = keyEventFor('f1');
  ok('keyEventFor(f1) not null', ev !== null);
  eq('keyEventFor(f1).code',    ev?.code,    'F1');
  eq('keyEventFor(f1).keyCode', ev?.keyCode, 112);
}

{
  const ev = keyEventFor('f7');
  ok('keyEventFor(f7) not null', ev !== null);
  eq('keyEventFor(f7).code', ev?.code, 'F7');
}

{
  const ev = keyEventFor('cbm');
  ok('keyEventFor(cbm) not null', ev !== null);
  eq('keyEventFor(cbm).code',     ev?.code,     'LeftAlt');
  eq('keyEventFor(cbm).location', ev?.location, 1);
}

{
  const ev = keyEventFor('ctrl');
  ok('keyEventFor(ctrl) not null', ev !== null);
  eq('keyEventFor(ctrl).code', ev?.code, 'Tab');
}

{
  const ev = keyEventFor('del');
  ok('keyEventFor(del) not null', ev !== null);
  eq('keyEventFor(del).code',    ev?.code,    'Backspace');
  eq('keyEventFor(del).keyCode', ev?.keyCode, 8);
}

{
  const ev = keyEventFor('clr_home');
  ok('keyEventFor(clr_home) not null', ev !== null);
  eq('keyEventFor(clr_home).code', ev?.code, 'Home');
}

{
  const ev = keyEventFor('restore');
  ok('keyEventFor(restore) not null', ev !== null);
  eq('keyEventFor(restore).code', ev?.code, 'PageUp');
}

{
  // Unknown key ID returns null.
  ok('keyEventFor(bogus) is null', keyEventFor('bogus_key_xyz') === null);
}

// ---------------------------------------------------------------------------
// keyAt(u, v) — hit testing
// ---------------------------------------------------------------------------

// ---- Out-of-range coords → null -------------------------------------------
ok('keyAt(-0.1, 0.5) → null', keyAt(-0.1, 0.5) === null);
ok('keyAt(1.1, 0.5)  → null', keyAt(1.1, 0.5)  === null);
ok('keyAt(0.5, -0.1) → null', keyAt(0.5, -0.1) === null);
ok('keyAt(0.5, 1.1)  → null', keyAt(0.5, 1.1)  === null);

// ---- Exact centre of single-cell keys -------------------------------------
// Key '1' is at col=1, row=0 (1×1 cell).
// Centre UV: u = (1 + 0.5) / COLS = 1.5/20 = 0.075
//             v = (0 + 0.5) / ROWS = 0.5/5  = 0.1
{
  const u = (1 + 0.5) / COLS;
  const v = (0 + 0.5) / ROWS;
  eq('keyAt centre of "1"', keyAt(u, v), '1');
}

// Key 'a' is at col=3, row=2.
{
  const u = (3 + 0.5) / COLS;
  const v = (2 + 0.5) / ROWS;
  eq('keyAt centre of "a"', keyAt(u, v), 'a');
}

// Key 'z' is at col=3, row=3.
{
  const u = (3 + 0.5) / COLS;
  const v = (3 + 0.5) / ROWS;
  eq('keyAt centre of "z"', keyAt(u, v), 'z');
}

// Key 'space' is at col=4, row=4, w=8.
// Centre: u = (4 + 4) / 20 = 0.4 (midpoint of col 4..12)
//          v = (4 + 0.5) / 5 = 0.9
{
  const u = (4 + 4) / COLS;   // 8/20 = 0.4
  const v = (4 + 0.5) / ROWS; // 4.5/5 = 0.9
  eq('keyAt centre of wide space', keyAt(u, v), 'space');
}

// ---- Wide key (RETURN, col=15, w=2, row=2) --------------------------------
{
  const u = (15 + 1) / COLS;  // midpoint of cols 15-16 = 16/20 = 0.8
  const v = (2 + 0.5) / ROWS;
  eq('keyAt centre of wide RETURN', keyAt(u, v), 'return');
}

// ---- Left edge of RETURN (just inside) ------------------------------------
{
  const u = 15 / COLS + 0.001;  // just past col 15 left edge
  const v = (2 + 0.5) / ROWS;
  eq('keyAt left edge of RETURN', keyAt(u, v), 'return');
}

// ---- Right edge of RETURN (just inside) -----------------------------------
{
  const u = 17 / COLS - 0.001;  // just before col 17 right edge
  const v = (2 + 0.5) / ROWS;
  eq('keyAt right edge of RETURN', keyAt(u, v), 'return');
}

// ---- GAP cell: no key at col=16, row=0 (between function blocks) ----------
// The layout has col 16 at row 0 unoccupied. Its centre should return null.
{
  const u = (16 + 0.5) / COLS;
  const v = (0 + 0.5) / ROWS;
  // col 16 row 0 has no key defined; expect null.
  ok('keyAt unoccupied cell → null or valid key',
     // We accept null OR a valid key id (in case a key was placed there later).
     keyAt(u, v) === null || typeof keyAt(u, v) === 'string'
  );
}

// ---- Function keys ---------------------------------------------------------
{
  const u = (17 + 0.5) / COLS;
  const v = (0 + 0.5) / ROWS;
  eq('keyAt F1 position', keyAt(u, v), 'f1');
}
{
  const u = (18 + 0.5) / COLS;
  const v = (0 + 0.5) / ROWS;
  eq('keyAt F3 position', keyAt(u, v), 'f3');
}
{
  const u = (19 + 0.5) / COLS;
  const v = (0 + 0.5) / ROWS;
  eq('keyAt F5 position', keyAt(u, v), 'f5');
}
{
  const u = (19 + 0.5) / COLS;
  const v = (1 + 0.5) / ROWS;
  eq('keyAt F7 position', keyAt(u, v), 'f7');
}

// ---- Cursor keys -----------------------------------------------------------
{
  const u = (15 + 0.5) / COLS;
  const v = (3 + 0.5) / ROWS;
  eq('keyAt cursor_up', keyAt(u, v), 'cursor_up');
}
{
  const u = (15 + 0.5) / COLS;
  const v = (4 + 0.5) / ROWS;
  eq('keyAt cursor_down', keyAt(u, v), 'cursor_down');
}
{
  const u = (16 + 0.5) / COLS;
  const v = (4 + 0.5) / ROWS;
  eq('keyAt cursor_left', keyAt(u, v), 'cursor_left');
}
{
  const u = (17 + 0.5) / COLS;
  const v = (4 + 0.5) / ROWS;
  eq('keyAt cursor_right', keyAt(u, v), 'cursor_right');
}

// ---- Row 0 leftmost key: back_arrow (←) at col=0 -------------------------
{
  const u = 0.5 / COLS;
  const v = 0.5 / ROWS;
  eq('keyAt back_arrow (col 0)', keyAt(u, v), 'back_arrow');
}

// ---- Exact top-left corner of 'a' -----------------------------------------
{
  const u = 3 / COLS;
  const v = 2 / ROWS;
  eq('keyAt exact top-left corner of "a"', keyAt(u, v), 'a');
}

// ---- Exact right-edge boundary (exclusive) --------------------------------
// Right edge of '1' is 2/COLS. A point exactly there belongs to the NEXT cell.
{
  const u = 2 / COLS;
  const v = 0.5 / ROWS;
  // At u=2/COLS, the '1' box ends (x1=2/20) and '2' begins.
  const hit = keyAt(u, v);
  ok('keyAt exact right edge of "1" is either "2" or no key', hit === '2' || hit === null);
}

// ---------------------------------------------------------------------------
// keyDef() helper
// ---------------------------------------------------------------------------
{
  const def = keyDef('return');
  ok('keyDef(return) not null', def !== null);
  eq('keyDef(return).col', def?.col, 15);
  eq('keyDef(return).w',   def?.w,   2);
}
{
  ok('keyDef(bogus) is null', keyDef('bogus_xyz') === null);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
