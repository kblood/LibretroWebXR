// probe-focus — spawn a second console via the spawn-menu path
// (`__rack.spawnNext`) and prove that per-console audio muting FOLLOWS focus.
//
// WHY THIS SHAPE (2026-07-29 probe audit). The previous version of this file
// asserted NOTHING: it dumped `window.__rack.audio()` snapshots as JSON and
// exited 0 unconditionally. Run against a copy of the repo with
// `refreshAudioFocus()` in src/main.js reduced to a no-op — i.e. with the
// audio-follows-focus wiring completely removed, every branch stuck at
// gain 1 in every state — it produced the same exit code 0 and no complaint.
// It could not tell a working rack from a broken one.
//
// The replacement is a WITHIN-RUN RELATIVE comparison. Absolute gain values
// prove little (a branch can read gain 1 because focus works, or because
// focus was never applied at all). So every check below measures a DELTA
// against the immediately-prior snapshot of the same branches, and pairs the
// measurement with a same-instant control arm that differs only in the one
// variable under test:
//
//   CONTROL ARM  focus(<the already-focused console>)  → delta MUST be 0
//   TEST ARM     focus(<the other console>)            → delta MUST flip
//
// Two focus() calls, microseconds apart, on the same scene, same branches,
// same audio graph — the only difference is which id is passed. If the
// control arm ever moves, the measurement is picking up drift and the test
// arm's number means nothing. If the test arm does not flip, focus does not
// drive audio.
//
// Run: node scripts/probe-focus.mjs [url]
// Defaults to a local dev server (`npm run dev`) — NOT production, so that a
// green run is evidence about the code in this checkout. Pass a URL to
// override (e.g. to smoke a deployed build).
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const URL = process.argv[2] || 'http://localhost:5173/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

console.log(`[probe-focus] target ${URL}`);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'] });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log('  [page error]', m.text().slice(0, 160)); });
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => Array.isArray(window.__games) && window.__games.length && window.__rack, { timeout: 30000 });

const result = await page.evaluate(async () => {
  const out = { steps: [] };
  // Gains keyed by console id, so a delta can be taken branch-by-branch even
  // if the branch ORDER changes between snapshots.
  const gains = () => Object.fromEntries(window.__rack.audio().map((b) => [b.console, b.gain]));
  // Per-console delta between a snapshot and the one immediately before it.
  const delta = (before, after) => {
    const d = {};
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
      d[id] = Number(((after[id] ?? 0) - (before[id] ?? 0)).toFixed(4));
    }
    return d;
  };
  const moved = (d) => Object.values(d).some((v) => v !== 0);

  const primary = (window.__games.find((g) => g.system === 'snes')) || window.__games[0];
  await window.__loadCartridge(primary);
  await new Promise((r) => setTimeout(r, 2000));
  const primaryId = window.__rack.focused();
  out.afterPrimary = { focused: primaryId, audio: window.__rack.audio() };

  // --- Spawn-menu path -----------------------------------------------------
  const branchesBefore = Object.keys(gains());
  const id = await window.__rack.spawnNext();
  await new Promise((r) => setTimeout(r, 2500));
  const branchesAfter = Object.keys(gains());
  out.spawned = id;
  out.afterSpawn = { focused: window.__rack.focused(), audio: window.__rack.audio() };
  out.video = window.__rack.video();
  out.newBranches = branchesAfter.filter((b) => !branchesBefore.includes(b));

  out.steps.push({
    name: 'spawnNext returns a NEW console id',
    pass: !!id && id !== primaryId,
    detail: { spawned: id, primary: primaryId },
  });
  out.steps.push({
    name: 'spawn adds exactly one audio branch, for the spawned console',
    pass: out.newBranches.length === 1 && out.newBranches[0] === id,
    detail: { before: branchesBefore, after: branchesAfter, added: out.newBranches },
  });
  out.steps.push({
    name: 'spawned console owns a TV in the video graph',
    pass: out.video.some((v) => v.console === id) && out.video.some((v) => v.console === primaryId),
    detail: out.video,
  });

  // Everything below needs two live branches to compare; bail loudly instead
  // of "passing" a comparison there is nothing to compare.
  if (!id || branchesAfter.length < 2) {
    out.steps.push({ name: 'two audio branches available to compare', pass: false, detail: branchesAfter });
    return out;
  }

  // --- CONTROL ARM: re-focus the console that is ALREADY focused -----------
  // Same call, same instant, same graph; only the id differs from the test
  // arm below. A working rack moves nothing here. If this moves, the test
  // arm's flip could be drift rather than the focus switch, and the whole
  // measurement is void.
  const beforeControl = gains();
  const controlFocused = window.__rack.focus(window.__rack.focused());
  const afterControl = gains();
  const dControl = delta(beforeControl, afterControl);
  out.controlArm = { refocused: controlFocused, before: beforeControl, after: afterControl, delta: dControl };
  out.steps.push({
    name: 'CONTROL: re-focusing the already-focused console moves NO gain (delta exactly 0)',
    pass: !moved(dControl),
    detail: dControl,
  });

  // --- TEST ARM: focus the OTHER console, same instant ---------------------
  const beforeTest = gains();
  const testFocused = window.__rack.focus(id);
  const afterTest = gains();
  const dTest = delta(beforeTest, afterTest);
  out.testArm = { focused: testFocused, before: beforeTest, after: afterTest, delta: dTest };
  out.steps.push({
    name: 'TEST: focusing the spawned console REPORTS it focused',
    pass: testFocused === id,
    detail: { got: testFocused, want: id },
  });
  out.steps.push({
    name: 'TEST: same call, other id — spawned branch gains, primary branch loses (opposite-sign deltas)',
    pass: dTest[id] > 0 && dTest[primaryId] < 0,
    detail: dTest,
  });
  out.steps.push({
    name: 'TEST: after the switch only the spawned console is audible',
    pass: afterTest[id] === 1 && afterTest[primaryId] === 0,
    detail: afterTest,
  });

  // --- REVERSE ARM: focus back, deltas must mirror the test arm ------------
  const beforeBack = gains();
  const backFocused = window.__rack.focus(primaryId);
  const afterBack = gains();
  const dBack = delta(beforeBack, afterBack);
  out.reverseArm = { focused: backFocused, before: beforeBack, after: afterBack, delta: dBack };
  out.steps.push({
    name: 'REVERSE: focusing back flips the deltas the other way (mirror of the TEST arm)',
    pass: dBack[id] === -dTest[id] && dBack[primaryId] === -dTest[primaryId] && moved(dBack),
    detail: { test: dTest, reverse: dBack },
  });
  out.steps.push({
    name: 'REVERSE: after switching back only the primary console is audible',
    pass: afterBack[primaryId] === 1 && afterBack[id] === 0,
    detail: afterBack,
  });

  return out;
});

console.log(JSON.stringify(result, null, 2));
const steps = result.steps || [];
const passed = steps.filter((s) => s.pass).length;
for (const s of steps) console.log(`  ${s.pass ? 'PASS' : 'FAIL'}  ${s.name}`);
console.log(`\n[probe-focus] ${passed}/${steps.length} checks passed`);
await browser.close();
process.exit(steps.length && passed === steps.length ? 0 : 1);
