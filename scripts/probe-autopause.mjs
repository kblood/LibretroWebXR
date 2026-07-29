// Rack auto-pause toggle probe — WITHIN-RUN RELATIVE, assertion-bearing.
//
// Claim under test: with several over-budget consoles loaded, the rack's
// auto-pause setting is what decides whether the non-focused excess runs.
// Auto-pause ON pauses the excess; OFF resumes every loaded console.
//
// HISTORY / WHY THIS SHAPE (2026-07-29 probe audit). The original version of
// this file was a "Throwaway" JSON dumper: it printed
// {defaultAutoPause, withAutoPauseOn, afterDisable, afterReEnable} and exited 0
// unconditionally. It carried NO assertion of any kind, yet commit 1d6afdc
// ("Rack auto-pause: gate on >1 core + make it a toggleable setting") cites it
// as "Verified live (scripts/probe-autopause.mjs): 3 over-budget consoles ->
// ON pauses the excess, OFF keeps all live, re-enable pauses again".
// Demonstrated during that audit: with `RackMgr.applyBudget()`'s
// `!this._budgetEnabled ||` clause deleted in a scratch checkout — i.e. the
// toggle reports OFF but the budget keeps pausing anyway, the exact regression
// this file is cited to rule out — the old script still exited 0 and printed a
// near-identical blob (the only tell was one `"live": false` a human had to
// eyeball). It proved nothing on its own.
//
// The replacement never reads absolute live/paused state as evidence. Every
// gating assertion is a DELTA across a single `autoPause()` call, snapshotting
// the live-set immediately before and immediately after, so elapsed time, core
// churn and boot-order drift cancel out. Each test arm is paired with a CONTROL
// arm run at the same instant on the same rack through the same code path,
// differing ONLY in the value passed to `autoPause()`: re-asserting the value
// the rack already has must move EXACTLY ZERO consoles. A real effect therefore
// has to show up as "flipping the value moves consoles, restating it moves
// none" — a bare state difference cannot satisfy that.
//
// Validated both ways during the audit (numbers in the report): PASSES on the
// real tree, FAILS red on the negative control above.
//
// Also fixed here: the old default URL was https://dionysus.dk/... , so a local
// run silently tested DEPLOYED code rather than the working tree (the known
// "debug default URL" gotcha). This now serves the working tree itself via
// vite; pass an explicit URL as argv[2] to override.
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5217;
const EXPLICIT_URL = process.argv[2] || null;
const URL = EXPLICIT_URL || `http://localhost:${PORT}/`;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function waitForServer(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch (_) { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

let vite = null;
if (!EXPLICIT_URL) {
  vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
}

let browser;
let out = null;
try {
  if (!(await waitForServer(URL))) throw new Error(`server never came up at ${URL}`);

  browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(
    () => window.__rack && Array.isArray(window.__games) && window.__games.length,
    { timeout: 60000 },
  );

  out = await page.evaluate(async () => {
    const r = { steps: [] };
    const snap = () => Object.fromEntries(window.__rack.live().map((c) => [c.id, c.live]));
    // Transitions between two live-set snapshots taken around ONE toggle.
    const delta = (before, after) => {
      const paused = [];   // live -> paused
      const resumed = [];  // paused -> live
      for (const id of Object.keys(after)) {
        if (!(id in before)) continue;         // console appeared mid-step: not a transition
        if (before[id] && !after[id]) paused.push(id);
        if (!before[id] && after[id]) resumed.push(id);
      }
      return { paused, resumed };
    };
    // One measured step: snapshot, call autoPause(value), snapshot again.
    // `value` is the ONLY thing that differs between a control arm and its
    // paired test arm — same call, same instant, same rack.
    const step = (name, value) => {
      const before = snap();
      const auto = window.__rack.autoPause(value);
      const after = snap();
      const d = delta(before, after);
      const rec = { name, requested: value, autoReadback: auto, before, after, ...d };
      r.steps.push(rec);
      return rec;
    };

    r.defaultAutoPause = window.__rack.autoPause();
    const g = window.__games.find((x) => x.system === 'snes') || window.__games[0];
    await window.__loadCartridge(g);
    await new Promise((s) => setTimeout(s, 1200));
    await window.__rack.spawn('genesis').catch(() => {});
    await window.__rack.spawn('gba').catch(() => {});
    await new Promise((s) => setTimeout(s, 2500));

    r.focused = window.__rack.focused();
    r.baseline = window.__rack.live();
    r.consoleCount = r.baseline.length;
    r.pausedAtBaseline = r.baseline.filter((c) => !c.live).map((c) => c.id);

    // CONTROL A: restate the value the rack already has (ON -> ON).
    r.controlOn = step('control: autoPause(true) while already ON', true);
    // TEST A: same call, flipped value (ON -> OFF). Must resume the excess.
    r.testOff = step('test: autoPause(false)', false);
    // CONTROL B: restate the new value (OFF -> OFF).
    r.controlOff = step('control: autoPause(false) while already OFF', false);
    // TEST B: flip back (OFF -> ON). Must re-pause the same excess.
    r.testOn = step('test: autoPause(true)', true);

    r.final = window.__rack.live();
    return r;
  });

  console.log(JSON.stringify(out, null, 2));
  console.log('\n--- assertions ---');

  const excess = out.pausedAtBaseline;
  const sameSet = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

  // Fixture preconditions. These are not the claim; they establish that the
  // rack was actually in the over-budget, multi-console state the claim is
  // about. If they fail, the arms below are meaningless, so they gate too.
  ok('fixture: 3+ consoles in the rack', out.consoleCount >= 3, `consoleCount=${out.consoleCount}`);
  ok('fixture: over budget with auto-pause ON (at least one console paused at baseline)',
     excess.length >= 1, `paused=[${excess}] of ${out.consoleCount}`);
  ok('fixture: the focused console is NOT among the paused excess',
     out.focused == null || !excess.includes(out.focused), `focused=${out.focused} paused=[${excess}]`);

  // CONTROL arms — must be EXACTLY ZERO. Same code path, same instant, the
  // value restated rather than flipped. Any movement here means the live-set
  // drifts on its own and the test arms below measure drift, not the toggle.
  ok('CONTROL (ON->ON): restating the current value moves EXACTLY 0 consoles',
     out.controlOn.paused.length === 0 && out.controlOn.resumed.length === 0,
     `paused=${out.controlOn.paused.length} resumed=${out.controlOn.resumed.length}`);
  ok('CONTROL (OFF->OFF): restating the current value moves EXACTLY 0 consoles',
     out.controlOff.paused.length === 0 && out.controlOff.resumed.length === 0,
     `paused=${out.controlOff.paused.length} resumed=${out.controlOff.resumed.length}`);

  // GATING assertion, arm A: flipping the single variable OFF resumes exactly
  // the excess its paired control left untouched, and pauses nothing.
  ok('GATING A: autoPause(false) RESUMES exactly the paused excess (and pauses none)',
     sameSet(out.testOff.resumed, excess) && out.testOff.paused.length === 0,
     `resumed=[${out.testOff.resumed}] expected=[${excess}] paused=[${out.testOff.paused}]`);
  // GATING assertion, arm B: flipping it back ON re-pauses that same set.
  ok('GATING B: autoPause(true) RE-PAUSES exactly that same set (and resumes none)',
     sameSet(out.testOn.paused, excess) && out.testOn.resumed.length === 0,
     `paused=[${out.testOn.paused}] expected=[${excess}] resumed=[${out.testOn.resumed}]`);

  // The delta is symmetric: what OFF resumed is what ON re-paused. Guards the
  // failure mode where the toggle moves *something* but not the same consoles.
  ok('the OFF-resumed set and the ON-repaused set are identical',
     sameSet(out.testOff.resumed, out.testOn.paused),
     `off.resumed=[${out.testOff.resumed}] on.paused=[${out.testOn.paused}]`);

  // The setting itself must report what was asked (catches a no-op setter).
  ok('autoPause() readback follows the requested value in every step',
     out.controlOn.autoReadback === true && out.testOff.autoReadback === false
     && out.controlOff.autoReadback === false && out.testOn.autoReadback === true,
     `readbacks=[${out.steps.map((s) => `${s.requested}->${s.autoReadback}`).join(', ')}]`);

  // With the budget disabled, NOTHING may be paused — the end state of arm A.
  ok('with auto-pause OFF every loaded console is live',
     Object.values(out.testOff.after).every(Boolean),
     `after=${JSON.stringify(out.testOff.after)}`);
} catch (err) {
  fail++;
  console.log(`  FAIL  probe threw — ${err.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (vite) {
    try {
      spawn('taskkill', ['/pid', String(vite.pid), '/t', '/f'], { stdio: 'ignore' });
    } catch (_) { /* best effort */ }
    vite.kill();
  }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
