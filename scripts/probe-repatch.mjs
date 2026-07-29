// Video patch-cord regression probe (Phase RACK / Phase 4).
//
// CLAIM UNDER TEST: dragging a console's video plug onto another TV's jack
// (window.__rack.repatch) actually changes which console's picture that TV
// shows, and pulling the plug out (window.__rack.unpatch) leaves the TV idle.
//
// SHAPE: WITHIN-RUN RELATIVE. Every check is a pair of arms taken at the same
// instant on the same booted room, differing in exactly ONE variable, each
// measured against its own immediately-prior fingerprint:
//   * repatch: the CONTROL arm re-seats a cord into the jack it is already in
//     (destination = current TV) and must move NOTHING (delta === 0); the TEST
//     arm is the identical call with only the destination jack changed and must
//     move the picture. An absolute before/after diff would not distinguish a
//     real rewire from spawn/boot/animation drift — the control arm is what
//     rules that out.
//   * unpatch: the pulled console's TV is the TEST arm, the OTHER TV at the
//     same instant is the CONTROL arm and must be byte-identical.
//
// It fingerprints the SCENE, not just the graph: for each TV we record the
// Patchbay edge (`graph`), TV.sourceCanvas (`src`) and the canvas actually
// bound to the CRT shader's tDiffuse uniform (`bound`) — the last is literally
// what gets displayed, so a rewire that updates the graph but never re-points
// the texture still goes red.
//
// VALIDATED BOTH WAYS AGAINST NEGATIVE CONTROLS (2026-07-29). Real repo: 9/9,
// exit 0. In a scratch checkout with the capability broken:
//   A) handlePlugReleased() returns early for plugKind 'video' (repatch and
//      unpatch become no-ops)                       -> 3/9, exit 1
//   B) the routeVideo() call is deleted from handlePlugReleased() (graph
//      rewires, TVs never re-point — the classic silent regression)
//                                                    -> 3/9, exit 1
// In both, only the three CONTROL arms (A1, D2, E1) stay green, which is what
// they are for. The pre-2026-07-29 version of this file had NO assertions at
// all — it printed a routing table and exited 0. It exited 0 under control A
// with every cord dead, and under control B it printed a perfect-looking graph
// swap while its own tvs() lines showed the TVs had never moved. Do not weaken
// this back into a dumper.
//
// Run: node scripts/probe-repatch.mjs [url]
// Default target is a LOCAL vite dev server, not production — a regression
// guard must test the working tree. Pass a URL to point it elsewhere.
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const URL = process.argv[2] || 'http://localhost:5173/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync);
if (!CHROME) { console.error('probe-repatch: no system Chrome/Edge found'); process.exit(2); }

console.log(`[probe-repatch] target: ${URL}`);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'] });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text().slice(0, 160)); });
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => Array.isArray(window.__games) && window.__games.length && window.__rack, { timeout: 30000 });

const result = await page.evaluate(async () => {
  const out = { checks: [], notes: [] };
  const ok = (id, pass, detail) => { out.checks.push({ id, pass: !!pass, detail }); return !!pass; };

  // ── fingerprint ───────────────────────────────────────────────────────────
  // Stable per-canvas identity (the emu canvases have DOM ids, the placeholder
  // does too; anything unnamed still gets a stable tag pinned to the object).
  let anon = 0;
  const cid = (c) => {
    if (!c) return null;
    if (!c.__fpId) c.__fpId = c.id || `anon-${++anon}`;
    return c.__fpId;
  };
  const fp = () => {
    const graph = Object.fromEntries(window.__rack.video().map((e) => [e.tv, e.console]));
    return window.__scene._tvs.map((t) => ({
      id: t.id,
      graph: graph[t.id] ?? null,                                   // Patchbay edge
      src: cid(t.sourceCanvas),                                     // TV's declared source
      bound: cid(t.material?.uniforms?.tDiffuse?.value?.image),     // what the shader samples
    }));
  };
  const at = (f, id) => f.find((e) => e.id === id);
  // Field-level delta between two fingerprints of the same room.
  const delta = (a, b) => {
    const diffs = [];
    for (const before of a) {
      const after = at(b, before.id);
      if (!after) { diffs.push(`${before.id}:gone`); continue; }
      for (const k of ['graph', 'src', 'bound']) {
        if (before[k] !== after[k]) diffs.push(`${before.id}.${k}: ${before[k]} -> ${after[k]}`);
      }
    }
    return diffs;
  };

  // ── boot a two-console room ───────────────────────────────────────────────
  const games = window.__games;
  const primary = games.find((g) => g.system === 'snes') || games[0];
  await window.__loadCartridge(primary);
  await new Promise((r) => setTimeout(r, 2000));
  const second = games.find((g) => ['nes', 'gb', 'sms'].includes(g.system)) || games.find((g) => g.system !== primary.system);
  await window.__rack.spawn(second.system, { game: second });
  await new Promise((r) => setTimeout(r, 2000));

  const F0 = out.F0 = fp();
  // Preconditions — without two TVs fed by two DISTINCT canvases there is no
  // routing to prove, and a green run would be meaningless. Bail loudly.
  const tvA = F0[0], tvB = F0[1];
  if (!tvA || !tvB || !tvA.src || !tvB.src || tvA.src === tvB.src || tvA.graph === tvB.graph) {
    out.precondition = `need 2 TVs on 2 distinct console canvases, got ${JSON.stringify(F0)}`;
    return out;
  }
  const c0 = tvA.graph, c1 = tvB.graph;         // console on tvA / tvB
  out.notes.push(`baseline ${tvA.id}<-${c0} (${tvA.src}), ${tvB.id}<-${c1} (${tvB.src})`);

  // ── REPATCH: control arm vs test arm, one variable (destination jack) ─────
  // A) CONTROL: re-seat c0's cord into the jack it is ALREADY in. Same call,
  //    same cord, same instant — only the destination differs from arm B.
  //    A working rewire is idempotent here, so this MUST move nothing. If this
  //    goes red, any "it changed!" reading in arm B is drift, not routing.
  window.__rack.repatch(c0, tvA.id);
  const FA = out.FA = fp();
  const dA = delta(F0, FA);
  ok('A1 control: re-seating a cord in its own jack changes nothing', dA.length === 0, dA);

  // B) TEST: identical call, destination jack changed to the other TV.
  window.__rack.repatch(c0, tvB.id);
  const FB = out.FB = fp();
  const dB = delta(FA, FB);
  const fbB = at(FB, tvB.id), fbA = at(FB, tvA.id), faA = at(FA, tvA.id);
  ok('B1 test: the target TV now shows the moved console\'s picture',
    fbB.src === faA.src && fbB.bound === faA.bound && fbB.graph === c0,
    { expectedSrc: faA.src, got: fbB });
  ok('B2 test: the vacated TV stops showing it (goes idle)',
    fbA.graph === null && fbA.src !== faA.src,
    { before: faA, after: fbA });
  out.deltaB = dB;

  // C) Complete the swap and require a FULL exchange vs the baseline.
  window.__rack.repatch(c1, tvA.id);
  const FC = out.FC = fp();
  const fcA = at(FC, tvA.id), fcB = at(FC, tvB.id);
  ok('C1 swap: TV A now shows what TV B showed',
    fcA.src === tvB.src && fcA.bound === tvB.bound && fcA.graph === c1, { got: fcA, wanted: tvB });
  ok('C2 swap: TV B now shows what TV A showed',
    fcB.src === tvA.src && fcB.bound === tvA.bound && fcB.graph === c0, { got: fcB, wanted: tvA });
  // The scene must agree with the graph — catches a rewire that updates the
  // Patchbay but never re-points the texture.
  ok('C3 scene agrees with graph after the swap',
    fcA.graph === c1 && fcA.src === tvB.src && fcB.graph === c0 && fcB.src === tvA.src,
    { tvA: fcA, tvB: fcB });

  // ── UNPATCH: pulled TV is the test arm, the other TV is the control arm ──
  window.__rack.unpatch(c0);                    // c0 is now on tvB
  const FD = out.FD = fp();
  const fdB = at(FD, tvB.id), fdA = at(FD, tvA.id);
  ok('D1 test: pulling the cord leaves that TV idle',
    fdB.graph === null && fdB.src !== fcB.src && fdB.bound !== fcB.bound,
    { before: fcB, after: fdB });
  ok('D2 control (same instant): the untouched TV is unchanged',
    fdA.graph === fcA.graph && fdA.src === fcA.src && fdA.bound === fcA.bound,
    { before: fcA, after: fdA });

  // E) CONTROL: unpatching an already-unpatched console must move nothing.
  window.__rack.unpatch(c0);
  const FE = out.FE = fp();
  const dE = delta(FD, FE);
  ok('E1 control: unpatching an already-pulled cord changes nothing', dE.length === 0, dE);
  return out;
});

await browser.close();

if (result.precondition) {
  console.log('[probe-repatch] COULD NOT TEST —', result.precondition);
  process.exit(2);
}
for (const n of result.notes) console.log(`  note: ${n}`);
let pass = 0;
for (const c of result.checks) {
  console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.id}`);
  if (!c.pass) console.log(`        ${JSON.stringify(c.detail)}`);
  if (c.pass) pass++;
}
console.log(JSON.stringify({ F0: result.F0, FA: result.FA, FB: result.FB, FC: result.FC, FD: result.FD, FE: result.FE }, null, 2));
console.log(`[probe-repatch] ${pass}/${result.checks.length} checks passed`);
process.exit(pass === result.checks.length ? 0 : 1);
