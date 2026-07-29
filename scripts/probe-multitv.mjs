// Multi-TV routing regression guard: boot the primary console, spawn a SECOND
// console+TV via window.__rack.spawn, and prove that the two TVs really sample
// TWO DIFFERENT, INDEPENDENTLY-RUNNING console canvases through the patch graph
// — the "game on both screens" regression this file exists to catch.
//
// Run:  node scripts/probe-multitv.mjs        (spawns its own vite on PORT below)
//       node scripts/probe-multitv.mjs http://localhost:5197/   (external server)
// Exit code: 0 = all checks passed, non-zero = at least one failed.
//
// WHY THE CHECKS ARE SHAPED THIS WAY (2026-07-29 probe audit)
// -----------------------------------------------------------
// The previous version of this file had NO assertions at all: it dumped
// window.__rack.tvs()/video() as JSON and exited 0 unconditionally, leaving the
// distinctness claim in its own header to the reader. It was verified against a
// negative control (routeVideo() rewritten to hand EVERY tv the primary
// console's canvas, i.e. both screens showing the same game) and its output was
// still exit 0 — worse, its `video` block, the part a reader would read as the
// routing evidence, was BYTE-IDENTICAL between working and broken, because
// __rack.video() reports the patch-graph INTENT (cable.sourceOf) rather than
// what each TV actually samples.
//
// So the pixel check below is a WITHIN-RUN RELATIVE comparison, never an
// absolute before/after diff (which would silently measure elapsed time and
// animation):
//
//   * All three snapshots are taken SYNCHRONOUSLY, in one task, with no await
//     between them — same instant, same page state, same everything.
//   * CONTROL ARM: tv0's source canvas snapshotted TWICE. Nothing differs
//     between those two reads, so the diff must be EXACTLY 0. If it isn't, the
//     comparison machinery is noisy and no other pixel number here means
//     anything — that is the built-in negative control for the metric itself.
//   * TEST ARM: tv0's source canvas vs tv1's source canvas at that SAME
//     instant. The only variable is which TV. It must be > 0.
//   * DEGENERACY ARM: each canvas must independently carry real picture (its
//     own grid signature is non-flat), so "different" cannot be satisfied by a
//     live screen next to a blank/idle one; and each canvas is compared against
//     ITS OWN immediately-prior snapshot so a fully frozen page is caught.
//     NOTE the per-canvas frame-advance number is reported but only gated in
//     aggregate: the bundled LWX SNES Demo legitimately renders a STATIC
//     screen (verified: byte-identical toDataURL over 6s), so requiring BOTH
//     canvases to advance would be a false red, not a real check.
//
// Validated BOTH ways on 2026-07-29: passes on the real repo, and goes RED on
// the negative control above (cross-TV diff collapses to 0, identity + routing
// checks fail).

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 5196;
// Default to a LOCAL server built from THIS checkout. (The old default pointed
// at the live production deploy, so a "green" run could reflect a build that
// had nothing to do with the working tree.)
const EXTERNAL = process.argv[2] || null;
const URL = EXTERNAL || `http://localhost:${PORT}/?experimental=1`;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!CHROME) { console.error('ERROR: no Chrome/Edge binary found'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

let vite = null;
if (!EXTERNAL) {
  vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) break; } catch (_) {}
    await sleep(500);
  }
}

// Snapshot BOTH TVs' source canvases at the same instant, plus a duplicate read
// of tv0 as the in-run control. Returns per-canvas grid signatures (same
// readback approach as probe-psx-guncon.js / probe-psx-timecrisis.js).
const CAPTURE = async () => {
  const tvs = window.__scene?._tvs || [];
  if (tvs.length < 2) return { error: `only ${tvs.length} TV(s) in the scene` };
  const c0 = tvs[0].sourceCanvas || null;
  const c1 = tvs[1].sourceCanvas || null;
  if (!c0 || !c1) return { error: `missing sourceCanvas (tv0=${!!c0} tv1=${!!c1})` };
  // --- SAME-INSTANT reads: three synchronous toDataURL calls, no await between.
  const a0 = c0.toDataURL('image/png');
  const a0dup = c0.toDataURL('image/png');   // control arm
  const a1 = c1.toDataURL('image/png');      // test arm
  // ------------------------------------------------------------------
  const sig = async (dataUrl) => {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('canvas snapshot failed to decode'));
      im.src = dataUrl;
    });
    const off = document.createElement('canvas');
    off.width = img.width; off.height = img.height;
    const octx = off.getContext('2d');
    octx.drawImage(img, 0, 0);
    const { data } = octx.getImageData(0, 0, img.width, img.height);
    const GRID = 12;
    const cellW = Math.max(1, Math.floor(img.width / GRID));
    const cellH = Math.max(1, Math.floor(img.height / GRID));
    const out = [];
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = gy * cellH; y < Math.min(img.height, (gy + 1) * cellH); y += 2) {
          for (let x = gx * cellW; x < Math.min(img.width, (gx + 1) * cellW); x += 2) {
            const i = (y * img.width + x) * 4;
            r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
          }
        }
        if (n === 0) n = 1;
        out.push(Math.round(r / n), Math.round(g / n), Math.round(b / n));
      }
    }
    return { w: img.width, h: img.height, sig: out };
  };
  return {
    ids: [c0.id || null, c1.id || null],
    sameObject: c0 === c1,
    tvIds: [tvs[0].id, tvs[1].id],
    tv0: await sig(a0),
    tv0dup: await sig(a0dup),
    tv1: await sig(a1),
  };
};

// Sum of |Δ| over the grid signature; null if the two snapshots aren't comparable.
const diff = (a, b) => {
  if (!a || !b || a.sig.length !== b.sig.length) return null;
  let total = 0;
  for (let i = 0; i < a.sig.length; i++) total += Math.abs(a.sig[i] - b.sig[i]);
  return total;
};

// How much picture a single snapshot carries: a flat (blank / solid idle)
// screen has spread 0 regardless of its colour.
const spread = (a) => (a ? Math.max(...a.sig) - Math.min(...a.sig) : null);

let browser = null;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'] });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text().slice(0, 160)); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => Array.isArray(window.__games) && window.__games.length && window.__rack, { timeout: 30000 });

  // 1) Boot the primary console (first SNES game, else first game), then spawn a
  //    second console with a LIGHT core so the perf budget keeps both live.
  const setup = await page.evaluate(async () => {
    const out = {};
    const games = window.__games;
    const primary = games.find((g) => g.system === 'snes') || games[0];
    await window.__loadCartridge(primary);
    await new Promise((r) => setTimeout(r, 2500));
    out.primary = { system: primary.system, core: primary.core, title: primary.title };
    const second = games.find((g) => ['nes', 'gb', 'sms'].includes(g.system)) || games.find((g) => g.system !== primary.system);
    try {
      const id = await window.__rack.spawn(second.system, { game: second });
      out.spawned = { id, system: second.system, core: second.core, title: second.title };
    } catch (e) { out.spawnError = String(e?.message || e); }
    await new Promise((r) => setTimeout(r, 2500));
    out.tvs = window.__rack.tvs();
    out.video = window.__rack.video();
    out.rack = {
      count: window.__rackMgr.count(),
      ids: window.__rackMgr.ids(),
      focus: window.__rackMgr.focusedId(),
      live: window.__rackMgr.runtimes().map((r) => ({ id: r.id, core: r.coreName, weight: r.weight, loaded: r.isLoaded(), live: r.isLive() })),
    };
    // Does each TV's ACTUAL sampled canvas match the console the patch graph
    // says feeds it? __rack.video() alone only reports the graph's intent, so a
    // routeVideo() that ignores the graph stays invisible to it.
    out.routingMatch = (window.__scene?._tvs || []).map((tv) => {
      const src = (out.video.find((v) => v.tv === tv.id) || {}).console || null;
      const want = src ? (window.__rackMgr.get(src)?.canvas || null) : null;
      return { tv: tv.id, console: src, sampled: tv.sourceCanvas?.id || null, expected: want?.id || null, match: !!want && tv.sourceCanvas === want };
    });
    return out;
  });

  ok('second console spawned without error', !setup.spawnError && !!setup.spawned?.id, setup.spawnError || setup.spawned?.id || '');
  ok('two consoles live in the rack', setup.rack.count === 2 && setup.rack.live.filter((r) => r.live).length === 2,
     JSON.stringify(setup.rack.live));
  ok('a second TV exists', setup.tvs.length === 2, JSON.stringify(setup.tvs));
  ok('each TV actually samples the canvas of the console patched to it',
     setup.routingMatch.length === 2 && setup.routingMatch.every((r) => r.match),
     JSON.stringify(setup.routingMatch));

  // 2) Two snapshots ~800ms apart. Within EACH, the control/test arms are taken
  //    at the same instant; ACROSS the two, each canvas is compared with its own
  //    immediately-prior frame (liveness).
  const t0 = await page.evaluate(CAPTURE);
  await sleep(800);
  const t1 = await page.evaluate(CAPTURE);
  if (t0.error || t1.error) {
    ok('canvas readback available for both TVs', false, t0.error || t1.error);
  } else {
    ok('canvas readback available for both TVs', true, `${t0.ids[0]} / ${t0.ids[1]}`);

    ok('the two TVs sample DIFFERENT canvas objects', !t1.sameObject,
       `tv0=${t1.ids[0]} tv1=${t1.ids[1]}`);

    // CONTROL ARM — same canvas, same instant, nothing varied: must be exactly 0.
    const ctl0 = diff(t0.tv0, t0.tv0dup);
    const ctl1 = diff(t1.tv0, t1.tv0dup);
    ok('CONTROL: re-reading the SAME canvas at the same instant diffs EXACTLY 0',
       ctl0 === 0 && ctl1 === 0, `t0=${ctl0} t1=${ctl1}`);

    // TEST ARM — same instant, only the TV varies: must be non-zero.
    const cross0 = diff(t0.tv0, t0.tv1);
    const cross1 = diff(t1.tv0, t1.tv1);
    ok('TEST: the two TVs show DIFFERENT pixels at that same instant',
       cross0 > 0 && cross1 > 0, `t0=${cross0} t1=${cross1} (control=${ctl0}/${ctl1})`);

    // DEGENERACY ARM (a) — each canvas must carry real picture of its own, so
    // "the two differ" can't be satisfied by one screen being blank/idle.
    const sp0 = spread(t1.tv0), sp1 = spread(t1.tv1);
    ok('each TV carries real picture of its own (non-flat signature)',
       sp0 > 8 && sp1 > 8, `tv0 spread=${sp0} tv1 spread=${sp1}`);

    // DEGENERACY ARM (b) — each canvas against its OWN immediately-prior frame.
    // Gated in aggregate only; see header (LWX SNES Demo is a static screen).
    const live0 = diff(t0.tv0, t1.tv0);
    const live1 = diff(t0.tv1, t1.tv1);
    ok('at least one console is advancing frames (page not frozen)',
       live0 + live1 > 0, `tv0 frame-advance=${live0} tv1 frame-advance=${live1}`);
  }

  console.log('\ndiagnostic: ' + JSON.stringify({ primary: setup.primary, spawned: setup.spawned, tvs: setup.tvs, video: setup.video, rack: setup.rack }, null, 2));
} catch (e) {
  console.error('ERROR', e);
  results.push(false);
} finally {
  if (browser) await browser.close();
  if (vite) { vite.kill(); try { process.kill(-vite.pid); } catch (_) {} }
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length && results.length ? 0 : 1);
