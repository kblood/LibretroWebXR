// Rack-persistence probe — does RackPersistence really re-spawn a saved console
// after a page reload (re-booting its core) and replay the video patch?
//
// Run: node scripts/probe-persist.mjs [url]        (default: local vite dev server)
// Exit code IS the verdict: 0 = all gating assertions passed, 1 = a regression.
//
// ---------------------------------------------------------------------------
// WHY THIS IS SHAPED THE WAY IT IS (2026-07-29 probe audit)
//
// Until this rewrite the script was a JSON DUMPER: it collected `out.spawned`
// (the descriptor saved before the reload) and `out.afterReload` (the live rack
// after it), printed both, and exited 0 unconditionally. It was cited as
// evidence that Phase-5 rack persistence worked. It proved nothing: a negative
// control that commented out the single `restoreRack()` call in src/main.js
// produced `afterReload.count = 1, ids = ["console0"]` — the console demonstrably
// NOT restored — and the script still printed happily and EXITED 0, byte-for-byte
// as green as the working repo.
//
// The fix is a WITHIN-RUN RELATIVE comparison. Counting consoles after one
// reload is an ABSOLUTE measurement: it cannot tell "the rack was restored from
// a save" apart from "the app happens to start with two consoles". So this probe
// reloads TWICE against the same page, in the same run, differing in exactly one
// variable — whether a rack descriptor exists in localStorage:
//
//   arm SAVE  : descriptor present  → restoreRack() should re-create it
//   arm CLEAR : descriptor removed  → nothing should come back
//
// and gates on the DELTA between the two arms, plus on the restored ids/core/
// video edges matching the descriptor that was actually saved. Every gating
// assertion below has been SEEN GOING RED against the restoreRack()-disabled
// negative control (numbers recorded next to each one).
// ---------------------------------------------------------------------------
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

// Default to a LOCAL dev server, not production. The old default was
// https://dionysus.dk/... — a probe whose exit code now means something must not
// silently grade whatever happens to be deployed instead of the working tree.
const URL = process.argv[2] || 'http://localhost:5173/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

if (!CHROME) { console.error('ERROR: no Chrome/Edge binary found'); process.exit(2); }

let failures = 0;
const ok = (label, pass, detail) => {
  if (!pass) failures++;
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
};
const sameSet = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
const edgeKey = (e) => `${e.tv}=>${e.console || 'null'}`;

console.log(`probe-persist: ${URL}`);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'] });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log('  [page error]', m.text().slice(0, 160)); });
const ready = () => page.waitForFunction(() => Array.isArray(window.__games) && window.__games.length && window.__rack, { timeout: 30000 });
// Read the live rack. Used identically for both arms so the two are comparable.
const readRack = () => page.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 4000));   // let restoreRack re-boot the saved core
  return {
    count: window.__rackMgr.count(),
    ids: window.__rackMgr.ids(),
    video: window.__rack.video(),
    runtimes: window.__rackMgr.runtimes().map((r) => ({ id: r.id, core: r.coreName, loaded: r.isLoaded() })),
  };
});

const out = {};
try {
  await page.goto(URL, { waitUntil: 'load' });
  await ready();

  // ---- Set up: clean slate, spawn one console, capture the saved descriptor.
  await page.evaluate(() => window.__rack.clearSaved());
  out.spawned = await page.evaluate(async () => {
    const g = window.__games.find((x) => x.system === 'snes') || window.__games[0];
    await window.__loadCartridge(g);
    await new Promise((r) => setTimeout(r, 1500));
    const id = await window.__rack.spawnNext();
    await new Promise((r) => setTimeout(r, 2000));
    return {
      id,
      saved: window.__rack.saved(),
      video: window.__rack.video(),
      count: window.__rackMgr.count(),
      ids: window.__rackMgr.ids(),
    };
  });
  const saved = out.spawned.saved;

  // Precondition, NOT the headline: a descriptor with at least one spawned
  // console must exist, otherwise both arms below are trivially equal and the
  // delta means nothing. Green in the negative control too (the break is on the
  // restore side, not the save side) — which is exactly why it can't be gating.
  const savedConsoles = saved?.consoles?.length || 0;
  ok('precondition: spawning a console wrote a rack descriptor',
     savedConsoles >= 1, `saved.consoles=${savedConsoles}, live count=${out.spawned.count}`);
  if (savedConsoles < 1) throw new Error('nothing was saved — cannot compare arms');

  // ---- ARM "SAVE": reload with the descriptor in localStorage.
  await page.reload({ waitUntil: 'load' });
  await ready();
  out.armSave = await readRack();

  // ---- ARM "CLEAR": same page, same code, descriptor removed. The ONLY
  // variable between the two arms.
  await page.evaluate(() => window.__rack.clearSaved());
  await page.reload({ waitUntil: 'load' });
  await ready();
  out.armClear = await readRack();

  // ---- Gating assertions (all relative: SAVE arm vs CLEAR arm) ------------
  // Floor: with no save, only the primary console exists. If this ever fails the
  // delta below is not interpretable (e.g. the app started shipping 2 consoles).
  ok('baseline (CLEAR arm): no saved rack ⇒ primary console only',
     out.armClear.count === 1 && sameSet(out.armClear.ids, ['console0']),
     `count=${out.armClear.count} ids=[${out.armClear.ids}]`);

  // HEADLINE. Negative control (restoreRack() disabled): 1 − 1 = 0, expected 1 → RED.
  // Working repo: 2 − 1 = 1, expected 1 → GREEN.
  const delta = out.armSave.count - out.armClear.count;
  ok('RESTORE DELTA: consoles present with the save minus without it == saved.consoles.length',
     delta === savedConsoles, `${out.armSave.count} − ${out.armClear.count} = ${delta}, expected ${savedConsoles}`);

  // HEADLINE. The restored rack must be the SAME rack, not merely the same size.
  // Negative control: ids=[console0] vs pre-reload [console0,console1] → RED.
  ok('RESTORE IDENTITY: ids after reload match the ids that were saved',
     sameSet(out.armSave.ids, out.spawned.ids),
     `after=[${out.armSave.ids}] before=[${out.spawned.ids}]`);

  // HEADLINE. "re-booting its core" — each saved console must come back as a
  // LOADED runtime running the core the descriptor named, and must be absent
  // from the CLEAR arm (so a core that boots regardless can't fake this).
  // Negative control: no console1 runtime at all → RED.
  const restored = out.armSave.runtimes.filter((r) => !out.armClear.ids.includes(r.id));
  const coreOk = saved.consoles.every((c, i) => {
    const r = restored[i];
    return r && r.loaded === true && (!c.core || r.core === c.core);
  });
  ok('RESTORE CORE: every saved console re-booted (loaded, matching coreName) and exists ONLY in the SAVE arm',
     restored.length === savedConsoles && coreOk,
     `restored=${JSON.stringify(restored)} saved=${JSON.stringify(saved.consoles.map((c) => c.core))}`);

  // HEADLINE. "replaying the video patch" — every saved edge that pointed at a
  // restored console must be back in the SAVE arm and NOT in the CLEAR arm.
  // Negative control: tv1 has no source at all → RED.
  const wanted = (saved.video || []).filter((e) => e.console && e.console !== 'console0');
  const saveEdges = new Set(out.armSave.video.map(edgeKey));
  const clearEdges = new Set(out.armClear.video.map(edgeKey));
  const replayed = wanted.filter((e) => saveEdges.has(edgeKey(e)));
  const leaked = wanted.filter((e) => clearEdges.has(edgeKey(e)));
  ok('RESTORE VIDEO PATCH: saved TV→console edges are replayed in the SAVE arm and absent in the CLEAR arm',
     wanted.length >= 1 && replayed.length === wanted.length && leaked.length === 0,
     `wanted=${wanted.map(edgeKey)} replayed=${replayed.length}/${wanted.length} leakedIntoClearArm=${leaked.length}`);
} finally {
  // Cleanup so the next run / a real user isn't stuck with a restored console.
  try { await page.evaluate(() => window.__rack.clearSaved()); } catch (_) {}
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}

console.log(failures ? `FAILURES: ${failures}` : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
