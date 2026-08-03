// The XR-deferred room adoption path, verified WITHOUT a headset.
//
// A display-only client whose own room layout differs from the host's adopts the
// host's room by stashing it and reloading (_maybeAdoptHostRoomLive). While the
// user is PRESENTING in XR a reload would eject them from immersive, so adoption
// is deferred with the message "leave VR to adopt it".
//
// The bug: the one-shot stamp (sessionStorage ROOM_ADOPT_KEY, there to prevent a
// reload LOOP) was claimed BEFORE the XR check. So the deferral permanently
// consumed the snapshot: leaving VR — the very thing the message asks for — hit
// "already handled this snapshot" and returned false, and the client stayed in its
// own room for the rest of the session. Also nothing retried on XR exit at all,
// because adoption is driven by incoming ROOM state messages and the host's
// watcher only republishes on a real change.
//
// isPresenting is a plain property on three's WebXRManager and it is an
// EventDispatcher, so both halves are drivable from the page: override the flag,
// then dispatch 'sessionend'. That is what a headset would do to the app.
//
// Negative-controlled: with the pre-fix ordering restored (stamp claimed first,
// no 'sessionend' retry) this script goes RED on exactly two assertions — "the
// deferral did NOT claim the one-shot stamp" and "after leaving VR the client
// adopted the host's room" (it stays in `default` forever, the reported symptom).
//
// Usage: node scripts/smoke-xr-room-adopt.mjs --app=http://localhost:5399/ --ws=ws://localhost:8897/
//        (add --headed to watch it)

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const APP = args.app || 'http://localhost:5399/';
const WS = args.ws || 'ws://localhost:8897/';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LAUNCH = ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--enable-features=SharedArrayBuffer'];

const browsers = [];
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.error(`  FAIL ${m}`); } };

async function open(url) {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: !args.headed, args: LAUNCH });
  browsers.push(b);
  const p = await b.newPage();
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__room?.id && window.__scene, { timeout: 90000 });
  return p;
}
const roomOf = (p) => p.evaluate(() => window.__room?.id ?? null);

try {
  const room = `xra${Date.now().toString(36)}`;
  const q = (nick) => `session=${room}&server=${encodeURIComponent(WS)}&nick=${nick}`;

  // Host authors a DISTINCT room so the client's default layout must differ.
  const A = await open(`${APP}?room=roms/arcade.room.json&${q('Alice')}`);
  await A.waitForFunction(() => window.__net?.connected() && window.__net.isHost(), { timeout: 30000 });
  ok((await roomOf(A)) === 'arcade', `host is in its authored room (${await roomOf(A)})`);
  await sleep(3000);

  // Client B joins presenting in XR. Fake isPresenting BEFORE it can adopt.
  const B = await puppeteer.launch({ executablePath: CHROME, headless: !args.headed, args: LAUNCH });
  browsers.push(B);
  const pb = await B.newPage();
  await pb.evaluateOnNewDocument(() => { window.__FAKE_XR = true; });
  // Patch as early as the renderer exists: poll from a script that runs at document
  // start, so the flag is true before the first ROOM message can land.
  await pb.evaluateOnNewDocument(() => {
    const t = setInterval(() => {
      const xr = window.__scene?.renderer?.xr;
      if (!xr) return;
      clearInterval(t);
      Object.defineProperty(xr, 'isPresenting', { get: () => window.__FAKE_XR === true, configurable: true });
    }, 10);
  });
  // BARE url — no ?session=. The ?session= path does the room handoff inside
  // buildCartridgeWorld before anything is built, so a URL-joiner never reaches
  // _maybeAdoptHostRoomLive at all. Live adoption is the WIDGET-join path.
  await pb.goto(`${APP}?server=${encodeURIComponent(WS)}`, { waitUntil: 'load' });
  await pb.waitForFunction(() => window.__room?.id && window.__scene, { timeout: 90000 });
  const ownRoom = await roomOf(pb);
  ok(ownRoom !== 'arcade', `the client built its OWN room first (${ownRoom})`);
  await pb.evaluate((r) => {
    document.getElementById('mp-room-input').value = r;
    document.getElementById('mp-nick-input').value = 'Bob';
    document.getElementById('mp-join-btn').click();
  }, room);
  await pb.waitForFunction(() => window.__net?.connected(), { timeout: 30000 });
  await sleep(14000);

  const presenting = await pb.evaluate(() => window.__scene.renderer.xr.isPresenting);
  ok(presenting === true, 'the client reports itself as PRESENTING in XR');
  ok((await pb.evaluate(() => window.__net.isHost())) === false, 'the client is display-only');
  const deferredRoom = await roomOf(pb);
  ok(deferredRoom !== 'arcade', `while presenting, the client did NOT reload into the host's room (${deferredRoom})`);
  const status = await pb.evaluate(() => document.getElementById('status')?.textContent || '');
  ok(/leave VR/i.test(status), `the client is told how to recover (${JSON.stringify(status)})`);
  // THE BUG: the deferral must not consume the one-shot stamp.
  const stamp = await pb.evaluate(() => sessionStorage.getItem('libretrowebxr.roomAdopted'));
  ok(stamp === null, `the deferral did NOT claim the one-shot stamp (stamp=${JSON.stringify(stamp)})`);

  // Now "take the headset off": stop presenting and fire the XR sessionend event.
  console.log('\n--- leaving VR (isPresenting=false + sessionend) ---');
  await pb.evaluate(() => {
    window.__FAKE_XR = false;
    window.__scene.renderer.xr.dispatchEvent({ type: 'sessionend' });
  });
  const adopted = await pb.waitForFunction(() => window.__room?.id === 'arcade', { timeout: 60000, polling: 500 })
    .then(() => true).catch(() => false);
  ok(adopted, `after leaving VR the client adopted the host's room (now ${await roomOf(pb)})`);
  ok((await pb.evaluate(() => window.__net?.connected())) === true, 'the session survived the adoption reload');
  const stampAfter = await pb.evaluate(() => sessionStorage.getItem('libretrowebxr.roomAdopted'));
  ok(typeof stampAfter === 'string' && stampAfter.length > 0,
    'the reloading path DID claim the stamp (so it cannot loop)');
} catch (e) { fail++; console.error('EXCEPTION', e); }
finally {
  for (const b of browsers) { try { await b.close(); } catch {} }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
