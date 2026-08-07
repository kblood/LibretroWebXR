// Unit tests for src/net/TvState.js — the shape of the room's shared `tv` key,
// specifically the multi-disc (.m3u) fields that used to be missing from it.
// Run: node scripts/test-tvstate.mjs
//
// NEGATIVE CONTROL BUILT IN: the last block re-implements the PRE-FIX publish
// (`{file, core, system, title}` and nothing else) and asserts that the very
// checks below FAIL against it. Without that, "the disc index is published" is
// the sort of green tick this project has been burned by — see
// docs/TEST_AUTOMATION.md § Negative controls.

import { discFields, tvStateValue, mergeDiscIntoTv, discStatusFromTv } from '../src/net/TvState.js';

let passed = 0;
let failed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { failed++; console.error(`  FAIL: ${msg}`); } };
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) passed++;
  else { failed++; console.error(`  FAIL: ${name}\n    got:  ${g}\n    want: ${w}`); }
};

// A DiscControlBridge.status() for a 3-disc game sitting on disc 2 (index 1).
const threeDisc = (index = 1, extra = {}) => ({ index, discCount: 3, ejected: false, supported: true, explicit: true, ...extra });
const meta = { file: 'psx/game.m3u', core: 'beetle_psx_hw', system: 'psx', title: 'A Three-CD Game' };

console.log('--- discFields: only speaks up for real multi-disc content ---');
{
  eq('3-disc on disc 2', discFields(threeDisc(1)), { disc: 1, discCount: 3 });
  eq('disc 1 is still published', discFields(threeDisc(0)), { disc: 0, discCount: 3 });
  eq('open tray carries through', discFields(threeDisc(2, { ejected: true })), { disc: 2, discCount: 3, discEjected: true });

  // Silence in every case where DiscSwapPanel would hide itself. A plain
  // cartridge insert must not start adding disc keys to `tv`.
  eq('null status', discFields(null), {});
  eq('single-disc content', discFields({ index: 0, discCount: 1, supported: true }), {});
  eq('core without disc control', discFields({ index: 1, discCount: 3, supported: false }), {});
  eq('missing discCount', discFields({ index: 0, supported: true }), {});
  eq('non-integer discCount', discFields({ index: 0, discCount: 2.5, supported: true }), {});
  eq('missing index defaults to 0', discFields({ discCount: 2, supported: true }), { disc: 0, discCount: 2 });
}

console.log('--- tvStateValue: game identity, plus the disc when it applies ---');
{
  const withDisc = tvStateValue(meta, threeDisc(1));
  eq('multi-disc value', withDisc, { ...meta, disc: 1, discCount: 3 });
  ok(withDisc.disc === 1, 'the disc index is actually in the published value');

  const plain = tvStateValue({ file: 'nes/pong.nes', core: 'fceumm', system: 'nes', title: 'Pong' }, null);
  eq('single-disc/cartridge value is unchanged from before the fix',
    plain, { file: 'nes/pong.nes', core: 'fceumm', system: 'nes', title: 'Pong' });
  ok(!('disc' in plain), 'no disc key for a cartridge (would be wire noise on every insert)');
}

console.log('--- mergeDiscIntoTv: patch an already-published value ---');
{
  const published = { ...meta };                       // what a boot publishes synchronously
  const merged = mergeDiscIntoTv(published, threeDisc(1));
  eq('fills in the disc fields', merged, { ...meta, disc: 1, discCount: 3 });

  // The whole point of the merge path: a disc SWAP does not re-boot, so this is
  // the only thing that tells the room the index moved.
  eq('a swap to disc 3 changes the value', mergeDiscIntoTv(merged, threeDisc(2)), { ...meta, disc: 2, discCount: 3 });

  // No-change ⇒ null ⇒ the caller skips the broadcast entirely.
  eq('idempotent republish is null', mergeDiscIntoTv(merged, threeDisc(1)), null);
  eq('single-disc on a plain value is null', mergeDiscIntoTv({ file: 'a', core: 'b' }, null), null);
  eq('no tv value at all', mergeDiscIntoTv(null, threeDisc(1)), null);
  eq('tv value with no file', mergeDiscIntoTv({ core: 'x' }, threeDisc(1)), null);

  // Losing disc control (a swap to a single-disc game) must CLEAR the fields,
  // not leave a stale "disc 2 of 3" advertised to the room.
  eq('clears stale disc fields', mergeDiscIntoTv(merged, null), { ...meta });
}

console.log('--- discStatusFromTv: what a coreless watcher shows ---');
{
  const s = discStatusFromTv({ ...meta, disc: 1, discCount: 3 });
  eq('room state → panel status', s, { index: 1, discCount: 3, ejected: false, supported: true, remote: true });
  ok(s.supported === true, 'supported: the HOST\'s core is what supports it');
  ok(s.remote === true, 'flagged as second-hand knowledge');
  eq('ejected tray', discStatusFromTv({ ...meta, disc: 0, discCount: 2, discEjected: true })?.ejected, true);
  eq('missing disc defaults to 0', discStatusFromTv({ ...meta, discCount: 2 })?.index, 0);

  // Null ⇒ DiscSwapPanel.setStatus hides the panel, which is what we want for
  // every non-multi-disc game.
  eq('single-disc → null', discStatusFromTv({ ...meta, disc: 0, discCount: 1 }), null);
  eq('no disc fields → null', discStatusFromTv(meta), null);
  eq('no value → null', discStatusFromTv(null), null);

  // A malformed/hostile index must not make the panel render "disc 9 / 3".
  eq('clamps above range', discStatusFromTv({ ...meta, disc: 9, discCount: 3 })?.index, 2);
  eq('clamps below range', discStatusFromTv({ ...meta, disc: -4, discCount: 3 })?.index, 0);
}

console.log('--- round trip: host publishes, watcher reads back the same disc ---');
{
  // The end-to-end contract in one line each: what stepDisc(+1) publishes is
  // exactly what a watcher's panel then displays.
  for (const index of [0, 1, 2]) {
    const wire = tvStateValue(meta, threeDisc(index));
    const seen = discStatusFromTv(wire);
    ok(seen?.index === index && seen.discCount === 3, `disc ${index + 1}/3 survives the round trip`);
  }
}

console.log('--- NEGATIVE CONTROL: the pre-fix publish fails these checks ---');
{
  // Exactly what main.js published before this change, at all three sites.
  const preFix = (m) => ({ file: m.file, core: m.core, system: m.system, title: m.title });

  const old = preFix(meta);
  ok(!('disc' in old), 'sanity: the old value really has no disc key');
  ok(discStatusFromTv(old) === null,
    'RED: a watcher reading the OLD value learns nothing about the disc');
  ok(discStatusFromTv(old)?.index !== 1,
    'RED: the old value cannot report "on disc 2" (this is the bug)');

  // And the fixed publisher is genuinely different from the old one for the same
  // input — if this ever passes, the fix has been reverted.
  ok(JSON.stringify(tvStateValue(meta, threeDisc(1))) !== JSON.stringify(old),
    'RED: fixed publish differs from the pre-fix publish for multi-disc content');
  // …while being byte-identical for the single-disc case, so nothing else moved.
  const cart = { file: 'nes/pong.nes', core: 'fceumm', system: 'nes', title: 'Pong' };
  ok(JSON.stringify(tvStateValue(cart, null)) === JSON.stringify(preFix(cart)),
    'and identical to the pre-fix publish for a cartridge');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
