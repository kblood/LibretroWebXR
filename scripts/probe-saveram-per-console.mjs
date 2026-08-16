// COR-6 in a real browser: does main.js actually give EVERY running console its
// own SaveRAM identity, and does a secondary console's card reach IndexedDB?
//
// scripts/test-saveram-guard.mjs pins the guard's logic. The bug, though, was in
// the WIRING — persistence read two module-level variables that only ever
// described console0 — so the claim that matters can only be made against the
// real app: boot the primary, spawn a rack console, and look at what each one is
// tracked as and where its bytes land.
//
// WHAT THIS PROBE PROVES / DOES NOT PROVE
//   PROVES: both consoles are tracked with their own (boot core, content) save
//           identity; a flush attempts every tracked console; and a SECONDARY
//           console's bytes reach the real SaveRamStore record in IndexedDB,
//           under the key a restore reads (coreId|contentId|slot).
//   DOES NOT PROVE: that a real core produces those bytes. It cannot — see
//           scripts/probe-worker-audio-saveram.mjs's B4 note: no ROM we can boot
//           headless has a recognised save type, so flushSaveRam() legitimately
//           returns nothing. The BYTES here come from a stub installed on the
//           console's client; everything downstream of it (the guard, the store,
//           the key, IndexedDB, the dedup) is the real shipped path.
//
// Content: public/roms/freeware/lwx-n64-scene.z64 (CC0, already shipped), booted
// through the real cartridge-insert path — a worker-execution core, which is the
// only kind with a native SaveRAM path (main-thread cores have no contentId and
// no flushSaveRam, and are deliberately left untracked).
//
// VALIDATED BOTH WAYS on 2026-08-16 (mutation applied to the real tree, run,
// reverted):
//   * as shipped                                     → 20/20, exit 0
//   * both flushes that cover a content swap removed (loadCartridgeIntoConsole's
//     `content-swap` flush and buildStartOptions' `pre-restore` flushAll)
//                                                    → 19/20, and the red one is
//     "the swap persisted the outgoing card": the record still holds the
//     PREVIOUS bytes, which is the shipped data loss, exactly.
//   * spawnConsole's trackConsoleSaveRam() call removed — i.e. the pre-COR-6
//     behaviour, where a rack console is never tracked → 9/17 (of the 17 checks
//     that existed at that point), and the six red ones are exactly the
//     rack-console checks. TWO others passed VACUOUSLY in that run — "every
//     attempt reached a client" over a one-element list, and "unchanged is not
//     rewritten" comparing two MISSING records. Both were tightened immediately
//     afterwards so they cannot pass that way again; see their call sites.
//
// Usage: node scripts/probe-saveram-per-console.mjs
// Exit code: 0 = all assertions passed, 1 = at least one failed / setup error.
// Needs real Chrome + a fetched N64 core; never part of `npm test`.

import puppeteer from 'puppeteer-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 5197;
const BASE = `http://localhost:${PORT}/?experimental=1`;
const ROM = resolve(ROOT, 'public', 'roms', 'freeware', 'lwx-n64-scene.z64');
const META = { file: 'lwx-n64-scene.z64', core: 'mupen64plus_next', system: 'n64', title: 'SaveRAM Per-Console Probe' };

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
].find(existsSync);

if (!CHROME) { console.error('ERROR: no Chrome binary found'); process.exit(1); }
if (!existsSync(ROM)) { console.error(`ERROR: test ROM not found at ${ROM}`); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

const romB64 = readFileSync(ROM).toString('base64');

// Same stale-server guard as the sibling probes: --strictPort means OUR vite
// exits if the port is taken, and every assertion would then silently measure a
// different source tree.
if (await fetch(`http://localhost:${PORT}/`).then(() => true).catch(() => false)) {
  console.error(`ERROR: something is already listening on http://localhost:${PORT}/ — refusing to run.`);
  console.error('       Stop it by PID/port (pwsh scripts/kill-dev.ps1) — never blanket-kill node.');
  process.exit(1);
}

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true });

function killPort(port) {
  if (process.platform !== 'win32') return;
  try {
    const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }).stdout || '';
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
      if (m && Number(m[1]) === port) pids.add(m[2]);
    }
    for (const pid of pids) spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' });
  } catch (_) {}
}

async function waitForServer(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch (_) {}
    await sleep(500);
  }
  return false;
}

let browser;
try {
  if (!(await waitForServer(`http://localhost:${PORT}/`))) throw new Error('vite dev server never came up');

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--enable-features=SharedArrayBuffer', '--no-sandbox', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(90000);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(BASE, { waitUntil: 'load' });
  const ready = await page.waitForFunction(
    () => !!window.__client && typeof window.__rom?.cacheRom === 'function'
       && typeof window.__addLocalRom === 'function' && typeof window.__insertCartridge === 'function'
       && typeof window.__rack?.spawn === 'function' && typeof window.__saveRam?.ids === 'function',
    { timeout: 40000 },
  ).then(() => true).catch(() => false);
  ok('app booted with the rack + saveram hooks ready', ready);
  if (!ready) throw new Error('app never finished initialising');

  // --- primary console: real mint + real cartridge insert --------------------
  const mint = await page.evaluate(async (b64, meta) => {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const sha1 = await window.__rom.cacheRom(buf.buffer);
    if (!sha1) return { ok: false, reason: 'cacheRom returned no sha1' };
    await window.__addLocalRom({ ...meta, rom: { sha1, sources: ['opfs'] } });
    return { ok: true, sha1 };
  }, romB64, META);
  ok('shelf cartridge minted', mint.ok, mint.reason || '');
  if (!mint.ok) throw new Error(mint.reason);

  const gameMeta = { ...META, rom: { sha1: mint.sha1, sources: ['opfs'] } };
  await page.evaluate(async (meta) => window.__insertCartridge(meta), gameMeta);
  const booted = await page.waitForFunction(
    () => window.__client?.mode === 'worker' && window.__client?.ready === true, { timeout: 60000 },
  ).then(() => true).catch(() => false);
  ok('the primary console booted a worker-execution core', booted);
  if (!booted) throw new Error('N64 core never reported ready on the primary');

  const primaryId = await page.evaluate(() => ({
    ids: window.__saveRam.ids(),
    identity: window.__saveRam.identity('console0'),
  }));
  ok('console0 is tracked for SaveRAM after its boot', primaryId.ids.includes('console0'), JSON.stringify(primaryId));
  ok('…keyed on the core that BOOTED and the content hash',
    primaryId.identity?.coreId === 'mupen64plus_next' && !!primaryId.identity?.contentId,
    JSON.stringify(primaryId.identity));

  // --- a rack console: the class that never saved at all ---------------------
  const spawned = await page.evaluate(async (meta) => {
    try { return { ok: true, id: await window.__rack.spawn('n64', { game: meta }) }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }, gameMeta);
  ok('a second console spawned with the same worker core', spawned.ok, spawned.reason || '');
  if (!spawned.ok) throw new Error(spawned.reason);
  const rackId = spawned.id;

  const tracked = await page.evaluate((id) => ({
    ids: window.__saveRam.ids(),
    identity: window.__saveRam.identity(id),
    stats: window.__saveRam.stats(),
  }), rackId);
  ok(`${rackId} is tracked too — before COR-6 no rack console ever was`,
    tracked.ids.includes(rackId), JSON.stringify(tracked.ids));
  ok('…with its own identity entry', tracked.identity?.coreId === 'mupen64plus_next' && !!tracked.identity?.contentId,
    JSON.stringify(tracked.identity));
  ok('the two consoles are tracked separately', tracked.ids.length >= 2, JSON.stringify(tracked.ids));

  // --- a flush attempts EVERY console ---------------------------------------
  const attempted = await page.evaluate(() => window.__saveRam.flushAll('probe-attempt'));
  ok('one flush result per tracked console', attempted.length >= 2, JSON.stringify(attempted));
  ok('the rack console was attempted, not just the primary',
    attempted.some((r) => r.id !== 'console0'), JSON.stringify(attempted));
  // 'empty' is the honest outcome for this ROM (no recognised save type) — what
  // matters is that the attempt reached the core at all.
  // `length >= 2 &&`: without it this passes vacuously when only the primary is
  // tracked, which is precisely the state the probe exists to catch.
  ok('every attempt reached a client (no console reported "untracked")',
    attempted.length >= 2 && attempted.every((r) => r.reason !== 'untracked'), JSON.stringify(attempted));

  // --- the write path, with the core's bytes stubbed -------------------------
  // Everything from here down is the real shipped path except the byte source.
  const readCard = async (id) => page.evaluate((consoleId) => new Promise((res) => {
    const ident = window.__saveRam.identity(consoleId);
    if (!ident) return res({ found: false, reason: 'untracked' });
    const key = `${encodeURIComponent(ident.coreId)}|${encodeURIComponent(ident.contentId)}|${ident.slot}`;
    const open = indexedDB.open('libretrowebxr-save-ram');
    open.onerror = () => res({ found: false, reason: 'db open failed' });
    open.onsuccess = () => {
      const db = open.result;
      const get = db.transaction('cards', 'readonly').objectStore('cards').get(key);
      get.onerror = () => res({ found: false, reason: 'get failed', key });
      get.onsuccess = () => {
        const rec = get.result;
        res(rec
          ? { found: true, key, bytes: Array.from(new Uint8Array(rec.data)), savedAt: rec.savedAt, coreId: rec.coreId }
          : { found: false, key });
      };
    };
  }), id);

  await page.evaluate((id) => {
    const rt = window.__rack.runtime(id);
    rt.__probeCard = new Uint8Array([0xc0, 0x06, 0x01]);
    rt.client.flushSaveRam = () => Promise.resolve(rt.__probeCard);
  }, rackId);

  await page.evaluate(() => window.__saveRam.flushAll('probe-write'));
  const card = await readCard(rackId);
  ok(`${rackId}'s card reached IndexedDB under the key a restore reads`,
    card.found && JSON.stringify(card.bytes) === JSON.stringify([0xc0, 0x06, 0x01]), JSON.stringify(card));
  ok('…under the BOOT core id', card.coreId === 'mupen64plus_next', JSON.stringify(card.coreId));

  // Unchanged bytes must not rewrite the record (the real store rotates a backup
  // on every write); changed bytes must.
  await page.evaluate(() => window.__saveRam.flushAll('probe-unchanged'));
  const again = await readCard(rackId);
  // `card.found &&`: two missing records also compare equal (undefined ===
  // undefined), so without it a console that never wrote anything would "prove"
  // the dedup works.
  ok('an unchanged card is not written again (savedAt unmoved)',
    card.found && again.found && again.savedAt === card.savedAt, `${card.savedAt} → ${again.savedAt}`);

  await sleep(5);
  await page.evaluate((id) => { window.__rack.runtime(id).__probeCard = new Uint8Array([0xc0, 0x06, 0x02]); }, rackId);
  await page.evaluate(() => window.__saveRam.flushAll('probe-changed'));
  const changed = await readCard(rackId);
  ok('a changed card IS written', JSON.stringify(changed.bytes) === JSON.stringify([0xc0, 0x06, 0x02]),
    JSON.stringify(changed));

  // --- the other half of COR-6: a console stops owning its card silently -----
  // Re-inserting content into a rack console replaces what it is running. The
  // old code wrote nothing at that moment (the only writes were the 30s timer
  // and pagehide, both on the primary), so up to 30 seconds of play vanished on
  // every swap. Attributable: the stub is REMOVED after the swap, so the bytes
  // can only have been written during it.
  await page.evaluate((id) => { window.__rack.runtime(id).__probeCard = new Uint8Array([0xc0, 0x06, 0x03]); }, rackId);
  const SWAP_TITLE = 'SaveRAM Swap Probe';
  const swapped = await page.evaluate(async (meta, id, title) => {
    try { await window.__insertCartridge({ ...meta, title, consoleId: id }); return { ok: true }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }, gameMeta, rackId, SWAP_TITLE);
  ok('re-inserting content into the rack console resolved', swapped.ok, swapped.reason || '');
  // handleCartridgeInserted does NOT await the secondary-console load (it is
  // fire-and-forget — main.js:~6180), so the call above returns long before the
  // core has swapped. Wait for the runtime to report the new content's title,
  // which ConsoleRuntime.load() sets only after the boot resolves — i.e. well
  // after the flush under test. Without this wait the probe reads the record
  // mid-swap and reports a false FAIL (measured 2026-08-16).
  const swapDone = await page.waitForFunction(
    (id, title) => window.__rack.runtime(id)?.title === title,
    { timeout: 90000 }, rackId, SWAP_TITLE,
  ).then(() => true).catch(() => false);
  ok('the rack console finished loading the re-inserted content', swapDone);
  await page.evaluate((id) => {
    const rt = window.__rack.runtime(id);
    rt.__probeCard = null;
    rt.client.flushSaveRam = () => Promise.resolve(null);   // nothing can write from here on
  }, rackId);
  const afterSwap = await readCard(rackId);
  ok('the swap persisted the outgoing card BEFORE loading the new content',
    JSON.stringify(afterSwap.bytes) === JSON.stringify([0xc0, 0x06, 0x03]), JSON.stringify(afterSwap));

  ok('NO pageerror across the whole probe', pageErrors.length === 0, JSON.stringify(pageErrors));
} catch (e) {
  console.error('ERROR', e);
  results.push(false);
} finally {
  if (browser) await browser.close();
  vite.kill();
  try { process.kill(-vite.pid); } catch (_) {}
  killPort(PORT);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length && results.length ? 0 : 1);
