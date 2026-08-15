// Unit tests for the CSPRNG session id in src/net/SessionUtils.js (CODEX_REVIEW
// SEC-5, fixed 2026-08-14). Pure logic: no browser, no server, no port.
// Run: node scripts/test-session-id.mjs
// Exit 0 = all pass, 1 = any failure.
//
// WHAT IS ACTUALLY UNDER TEST
// The sid is a host-reclaim BEARER VALUE: it rides `?sid=` on the room-server
// connect URL and server/Hub.js hands the host role back to whoever presents the
// departed host's sid inside HOST_RECLAIM_MS. It used to be
// `Math.random().toString(36).slice(2,10) + Date.now().toString(36)` — a weak PRNG
// glued to a predictable clock. So every claim below is paired with a NEGATIVE
// CONTROL that runs the *identical* assertion against `legacySessionId()`, the
// verbatim old expression, and requires it to FAIL. If a check would pass for the
// old generator too, it proves nothing and this file is supposed to say so.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stableSessionId, randomRoomSuffix } from '../src/net/SessionUtils.js';

let passed = 0;
let failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
};
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; }
  else { failed++; console.error(`  FAIL: ${name}\n    got:  ${g}\n    want: ${w}`); }
};

const HERE = dirname(fileURLToPath(import.meta.url));

// The exact pre-fix generators, kept verbatim as the negative control.
const legacySessionId  = () => `sid-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
const legacyRoomSuffix = () => Math.random().toString(36).slice(2, 6);

const SID_RE = /^sid-[0-9a-f]{32}$/;

// A sessionStorage that never actually keeps anything, so every call mints a
// fresh id and we can sample the generator many times through the real code path.
const nonPersistingStorage = () => ({ getItem: () => null, setItem: () => {} });

// Swap globals for the duration of fn, always restoring (a leaked stubbed
// Date.now/Math.random would silently poison every later section).
// defineProperty, not assignment: Node exposes globalThis.crypto as a getter-only
// accessor, so `globalThis.crypto = stub` throws.
function withGlobals(patch, fn) {
  const saved = new Map();
  for (const [k, v] of Object.entries(patch)) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k) ?? null);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true, enumerable: true });
  }
  const savedRandom = Math.random, savedNow = Date.now;
  try { return fn(); }
  finally {
    Math.random = savedRandom; Date.now = savedNow;
    for (const [k, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
  }
}

// Install a raw PROPERTY DESCRIPTOR on globalThis for the duration of fn. Needed
// for the hardened-realm cases in 4b-iv, where the thing that throws is the
// `globalThis.crypto` ACCESSOR itself, which `withGlobals` (value descriptors)
// cannot express.
function withGlobalDescriptor(key, desc, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, key) ?? null;
  Object.defineProperty(globalThis, key, { configurable: true, ...desc });
  try { return fn(); }
  finally {
    if (saved) Object.defineProperty(globalThis, key, saved);
    else delete globalThis[key];
  }
}

// Fresh module instance (the module caches an in-memory sid in a closure).
let modSeq = 0;
const freshModule = () => import(`../src/net/SessionUtils.js?t=${++modSeq}`);

const draw = (n, gen) => Array.from({ length: n }, gen);
const uniq = (arr) => new Set(arr).size;

// === 1. Shape, alphabet, URL-safety, and the server's length bound ==========
{
  // The bound is read from the REAL server default, not hardcoded here: if
  // someone lowers ROOM_MAX_SID_LEN below our id length, reclaim would start
  // comparing truncated prefixes and this test has to be the thing that notices.
  const serverSrc = readFileSync(join(HERE, '..', 'server', 'room-server.mjs'), 'utf8');
  const m = /envInt\(\s*['"]ROOM_MAX_SID_LEN['"]\s*,\s*(\d+)\s*\)/.exec(serverSrc);
  ok(!!m, 'found the ROOM_MAX_SID_LEN default in server/room-server.mjs');
  const maxSid = m ? Number(m[1]) : NaN;
  ok(Number.isFinite(maxSid) && maxSid > 0, `ROOM_MAX_SID_LEN default parses (${maxSid})`);

  const ids = withGlobals({ sessionStorage: nonPersistingStorage() }, () => draw(2000, stableSessionId));

  const badShape = ids.filter((id) => !SID_RE.test(id));
  ok(badShape.length === 0, `all 2000 ids match ${SID_RE} (${badShape.length} bad, e.g. ${badShape[0]})`);
  ok(uniq(ids) === ids.length, `all 2000 ids are distinct (got ${uniq(ids)})`);
  ok(ids.every((id) => id.length <= maxSid), `every id fits ROOM_MAX_SID_LEN=${maxSid} (len ${ids[0].length})`);
  // It goes in a query parameter; it must survive that with no escaping at all.
  ok(ids.every((id) => encodeURIComponent(id) === id), 'ids are URL-safe verbatim (encodeURIComponent is a no-op)');

  // NEGATIVE CONTROL 1: the identical assertions against the old generator.
  const legacy = draw(2000, legacySessionId);
  const legacyShapeOk = legacy.every((id) => SID_RE.test(id));
  const legacyUniqueOk = uniq(legacy) === legacy.length;
  ok(!legacyShapeOk, 'NEG: legacy Math.random+Date.now ids FAIL the current-format shape check');
  console.log(`  [neg-1] legacy shape-ok=${legacyShapeOk} unique-ok=${legacyUniqueOk} sample=${legacy[0]} (len ${legacy[0].length})`);
  // Not asserted (it happens to hold): legacy ids are usually distinct too. That
  // is exactly why "two draws differ" is not evidence of anything here.
}

// === 2. The entropy really comes from crypto, not from Math.random/Date.now ==
// THE core control: freeze BOTH inputs the old generator used. A generator that
// still leans on them collapses to a single repeated value; ours must not.
{
  const FROZEN_NOW = 1_700_000_000_000;
  let calls = 0;
  // Deterministic fill, distinct per call (31 is odd, so call*31 mod 256 has
  // period 256 > our 200 draws). We know the exact bytes, so we can prove the id
  // is those bytes and nothing else — no Math.random spliced in anywhere.
  const stubByte = (call, i) => (call * 31 + i * 7) & 0xff;
  const cryptoStub = {
    getRandomValues(buf) {
      calls++;
      for (let i = 0; i < buf.length; i++) buf[i] = stubByte(calls, i);
      return buf;
    },
  };

  const ids = withGlobals({ crypto: cryptoStub, sessionStorage: nonPersistingStorage() }, () => {
    Math.random = () => 0.5;
    Date.now = () => FROZEN_NOW;
    return draw(200, stableSessionId);
  });

  ok(calls >= 200, `crypto.getRandomValues was called for every id (${calls} calls)`);
  ok(uniq(ids) === 200, `200 ids are still all distinct with Math.random and Date.now FROZEN (got ${uniq(ids)})`);
  // Byte-exactness: the first id came from calls === 1.
  const expectFirst = 'sid-' + Array.from({ length: 16 }, (_, i) => stubByte(1, i).toString(16).padStart(2, '0')).join('');
  eq('id is exactly the crypto bytes, hex-encoded', ids[0], expectFirst);

  // NEGATIVE CONTROL 2: same frozen globals, old generator.
  const legacy = withGlobals({}, () => {
    Math.random = () => 0.5;
    Date.now = () => FROZEN_NOW;
    return draw(200, legacySessionId);
  });
  ok(uniq(legacy) === 1, `NEG: with the same frozen globals the legacy generator emits ONE value 200 times (got ${uniq(legacy)} distinct)`);
  console.log(`  [neg-2] legacy under frozen Math.random/Date.now: ${uniq(legacy)} distinct, value=${legacy[0]}`);

  // And the timestamp tail is gone: under the old scheme the last 8 chars were
  // Date.now().toString(36) — identical for every id minted in the same run.
  ok(uniq(ids.map((s) => s.slice(-8))) > 190, 'no shared trailing timestamp across ids');
  ok(uniq(legacy.map((s) => s.slice(-8))) === 1, 'NEG: legacy ids all share the same trailing timestamp');
}

// === 3. Fallback: randomUUID-only context ===================================
// getRandomValues absent but randomUUID present. Still CSPRNG-derived, so it
// must still be independent of Math.random.
{
  let n = 0;
  const uuidOnly = {
    randomUUID() {
      // Deterministic but per-call-distinct stand-in for a real UUID.
      const hex = (n++).toString(16).padStart(32, 'a');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    },
  };
  const ids = withGlobals({ crypto: uuidOnly, sessionStorage: nonPersistingStorage() }, () => {
    Math.random = () => 0.5;
    Date.now = () => 1_700_000_000_000;
    return draw(100, stableSessionId);
  });
  ok(ids.every((id) => SID_RE.test(id)), 'randomUUID-only fallback still produces current-format ids');
  ok(uniq(ids) === 100, `randomUUID-only fallback ids vary with the UUID, not with Math.random (${uniq(ids)} distinct)`);
  ok(n >= 100, `randomUUID was the source that got called (${n} calls)`);

  // 3b. When BOTH are present, getRandomValues wins. Added 2026-08-15: the module
  //     documents that ordering, and the round-4 verifier showed that swapping the
  //     two branches changed nothing this suite could see. Not a security claim —
  //     both sources are CSPRNGs and the ordering is a preference for the direct
  //     byte source over a UUID string that has to be parsed back into bytes —
  //     but the comment is load-bearing, so something has to hold it to account.
  let uuidCalls = 0;
  const both = {
    getRandomValues(buf) { for (let i = 0; i < buf.length; i++) buf[i] = 0xab; return buf; },
    randomUUID() { uuidCalls++; return '00000000-0000-0000-0000-000000000000'; },
  };
  const id = withGlobals({ crypto: both, sessionStorage: nonPersistingStorage() }, () => stableSessionId());
  eq('with both sources present the id comes from getRandomValues', id, 'sid-' + 'ab'.repeat(16));
  ok(uuidCalls === 0, `randomUUID is not consulted while getRandomValues works (${uuidCalls} calls)`);
}

// === 4. Fallback: no crypto object at all ===================================
// Documented last resort (Math.random). The claim here is only "still boots and
// still returns a well-formed, in-bounds, URL-safe id" — NOT that it is strong.
{
  const ids = withGlobals({ crypto: undefined, sessionStorage: nonPersistingStorage() }, () => draw(200, stableSessionId));
  ok(ids.every((id) => SID_RE.test(id)), 'no-crypto fallback still returns current-format ids (does not throw)');
  ok(uniq(ids) === 200, `no-crypto fallback ids are at least distinct (${uniq(ids)})`);
}

// === 4b. A THROWING platform CSPRNG must degrade, never propagate ===========
// Added 2026-08-15. randomBytes() used to call c.getRandomValues(out) unguarded,
// so a throwing CSPRNG escaped stableSessionId()/randomRoomSuffix(). src/main.js
// evaluates `Player-${randomRoomSuffix()}` at MODULE SCOPE, so that throw was an
// import-time crash of the whole app; NetMgr's and DesktopNet's constructors call
// stableSessionId() unguarded too. Every call below goes through attempt() so a
// regression prints FAIL lines instead of killing the run at the first throw.
//
// NOTE ON THE PRE-FIX BASELINE: at HEAD neither generator touched crypto at all,
// so it "did not throw" for the trivial reason that it never called it. These
// assertions still bite there — the ids come out in the legacy format and the
// degrade-target checks below are byte-exact — but the load-bearing inversions
// for this section are edits to randomBytes(), measured 2026-08-15 against a
// scratch mirror of this file plus the real module:
//   • remove the two call try/catch blocks            → 4b-i..iii red (round 4)
//   • unwrap `try { c = globalThis.crypto }`          → 4 FAILs in 4b-iv(a)
//   • move the `typeof` reads back outside the trys   → 8 FAILs in 4b-iv(a,b,c)
//   • fill only still-zero bytes in the Math.random tail → 2 FAILs in 4b-v
// The last three each redden ONLY their own sub-block, so no sub-block is riding
// on another's guard. The first reddens all of 4b, as it must: every stub here
// ultimately depends on a thrown CSPRNG being caught somewhere.
{
  const attempt = (fn) => { try { return { threw: false, value: fn() }; } catch (e) { return { threw: true, err: e }; } };
  const throwing = () => { throw new Error('CSPRNG unavailable'); };

  // 4b-i. getRandomValues throws and there is no second CSPRNG → the documented
  //       Math.random last resort, i.e. a degraded id, not an exception.
  {
    const c = { getRandomValues: throwing };
    const r = attempt(() => withGlobals({ crypto: c, sessionStorage: nonPersistingStorage() }, () => draw(50, stableSessionId)));
    ok(!r.threw, `throwing getRandomValues does not propagate out of stableSessionId (${r.threw ? r.err.message : 'ok'})`);
    ok(!r.threw && r.value.every((id) => SID_RE.test(id)), 'throwing getRandomValues still yields current-format ids');
    ok(!r.threw && uniq(r.value) === 50, `degraded ids are still distinct (${r.threw ? 'n/a' : uniq(r.value)})`);

    // The room suffix is the one evaluated at module scope in src/main.js, so it
    // is the path where a throw is fatal to the whole import.
    const rs = attempt(() => withGlobals({ crypto: c }, () => draw(50, randomRoomSuffix)));
    ok(!rs.threw, `throwing getRandomValues does not propagate out of randomRoomSuffix (${rs.threw ? rs.err.message : 'ok'})`);
    ok(!rs.threw && rs.value.every((s) => /^[a-z0-9]{4}$/.test(s)), 'degraded room suffix still meets its contract');
  }

  // 4b-ii. getRandomValues throws but randomUUID works → degrade to the OTHER
  //        CSPRNG, not straight to Math.random. Byte-exact so it cannot pass by
  //        accidentally landing on the fallback.
  {
    let uuids = 0;
    const c = {
      getRandomValues: throwing,
      randomUUID() {
        const hex = (uuids++).toString(16).padStart(32, 'a');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
      },
    };
    const r = attempt(() => withGlobals({ crypto: c, sessionStorage: nonPersistingStorage() }, () => {
      Math.random = () => 0.5;                 // if we fell through to it, the ids would repeat
      return draw(3, stableSessionId);
    }));
    ok(!r.threw, `throwing getRandomValues degrades to randomUUID without propagating (${r.threw ? r.err.message : 'ok'})`);
    eq('degraded id is exactly the randomUUID hex', r.threw ? null : r.value[0], 'sid-' + 'a'.repeat(31) + '0');
    ok(uuids >= 3, `randomUUID was the source that got called after the throw (${uuids} calls)`);
  }

  // 4b-iii. BOTH CSPRNG entry points throw → still boots on Math.random.
  {
    const c = { getRandomValues: throwing, randomUUID: throwing };
    const r = attempt(() => withGlobals({ crypto: c, sessionStorage: nonPersistingStorage() }, () => draw(50, stableSessionId)));
    ok(!r.threw, `both CSPRNG sources throwing still does not propagate (${r.threw ? r.err.message : 'ok'})`);
    ok(!r.threw && r.value.every((id) => SID_RE.test(id)), 'both-throwing fallback still yields current-format ids');
    ok(!r.threw && uniq(r.value) === 50, `both-throwing fallback ids are at least distinct (${r.threw ? 'n/a' : uniq(r.value)})`);
  }

  // 4b-iv. The guard's headline is an ABSOLUTE ("a failing CSPRNG degrades, it
  //        does not throw"), so the reads have to be covered too, not just the
  //        calls: the first revision of the guard wrapped only
  //        c.getRandomValues(out) / c.randomUUID(), leaving `globalThis.crypto`
  //        and the two `typeof` property reads outside any try. A hardened realm
  //        that installs a throwing accessor still crashed the module-scope
  //        `Player-${randomRoomSuffix()}` in src/main.js — the exact shape the
  //        guard exists to prevent (found by the round-5 verifier, 2026-08-15).
  {
    // (a) the globalThis.crypto ACCESSOR throws.
    const boom = { get() { throw new Error('crypto accessor blocked'); } };
    const r = attempt(() => withGlobalDescriptor('crypto', boom, () =>
      withGlobals({ sessionStorage: nonPersistingStorage() }, () => draw(20, stableSessionId))));
    ok(!r.threw, `a throwing globalThis.crypto accessor does not propagate out of stableSessionId (${r.threw ? r.err.message : 'ok'})`);
    ok(!r.threw && r.value.every((id) => SID_RE.test(id)), 'throwing crypto accessor still yields current-format ids');

    const rs = attempt(() => withGlobalDescriptor('crypto', boom, () => draw(20, randomRoomSuffix)));
    ok(!rs.threw, `a throwing globalThis.crypto accessor does not propagate out of randomRoomSuffix (${rs.threw ? rs.err.message : 'ok'})`);
    ok(!rs.threw && rs.value.every((s) => /^[a-z0-9]{4}$/.test(s)), 'throwing crypto accessor still yields a contract-shaped room suffix');

    // (b) crypto exists, but READING .getRandomValues throws → degrade to the
    //     other CSPRNG. Byte-exact, so it cannot pass by landing on Math.random.
    let uuids = 0;
    const badRead = {
      get getRandomValues() { throw new Error('property read blocked'); },
      randomUUID() {
        const hex = (uuids++).toString(16).padStart(32, 'a');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
      },
    };
    const rb = attempt(() => withGlobals({ crypto: badRead, sessionStorage: nonPersistingStorage() }, () => {
      Math.random = () => 0.5;                 // falling through to it would show up in the bytes
      return stableSessionId();
    }));
    ok(!rb.threw, `a throwing getRandomValues property READ does not propagate (${rb.threw ? rb.err.message : 'ok'})`);
    eq('…and degrades to randomUUID, byte-exact', rb.threw ? null : rb.value, 'sid-' + 'a'.repeat(31) + '0');

    // (c) BOTH property reads throw → the Math.random last resort still boots.
    const bothBad = {
      get getRandomValues() { throw new Error('property read blocked'); },
      get randomUUID() { throw new Error('property read blocked'); },
    };
    const rc = attempt(() => withGlobals({ crypto: bothBad, sessionStorage: nonPersistingStorage() }, () => draw(20, stableSessionId)));
    ok(!rc.threw, `both property reads throwing still does not propagate (${rc.threw ? rc.err.message : 'ok'})`);
    ok(!rc.threw && rc.value.every((id) => SID_RE.test(id)), 'both-reads-throwing fallback still yields current-format ids');
  }

  // 4b-v. PARTIAL FILL THEN THROW. randomBytes() reuses ONE buffer across all
  //       three sources, and the module claims "every byte is overwritten here,
  //       so a partial fill by a source that threw mid-way cannot leak through".
  //       Nothing exercised that: the `throwing` stub above throws before writing
  //       a single byte. These stubs write first, then die. Math.random is frozen
  //       to 0.5 → Math.floor(0.5 * 256) === 0x80 for every byte, so the degraded
  //       id is byte-exact and ANY surviving stub byte shows up as a diff.
  {
    const expect = 'sid-' + '80'.repeat(16);

    // (a) half the buffer written, then throw.
    let halfCalls = 0;
    const half = {
      getRandomValues(buf) {
        halfCalls++;
        for (let i = 0; i < Math.ceil(buf.length / 2); i++) buf[i] = 0xfe;
        throw new Error('CSPRNG died mid-fill');
      },
    };
    const rh = attempt(() => withGlobals({ crypto: half, sessionStorage: nonPersistingStorage() }, () => {
      Math.random = () => 0.5;
      return stableSessionId();
    }));
    ok(!rh.threw, `a mid-fill throw does not propagate (${rh.threw ? rh.err.message : 'ok'})`);
    eq('a half-filled buffer from a source that threw does not leak into the id', rh.threw ? null : rh.value, expect);
    ok(halfCalls === 1, `the partially-filling source was actually consulted (${halfCalls} calls)`);

    // (b) the whole buffer written, then throw — the shape where a fallback that
    //     only fills the still-zero bytes would leak EVERY byte.
    const full = {
      getRandomValues(buf) {
        for (let i = 0; i < buf.length; i++) buf[i] = 0xfe;
        throw new Error('CSPRNG died after filling');
      },
    };
    const rf = attempt(() => withGlobals({ crypto: full, sessionStorage: nonPersistingStorage() }, () => {
      Math.random = () => 0.5;
      return stableSessionId();
    }));
    ok(!rf.threw, `a fill-then-throw does not propagate (${rf.threw ? rf.err.message : 'ok'})`);
    eq('a fully-written buffer from a source that threw does not leak into the id', rf.threw ? null : rf.value, expect);
  }
}

// === 5. Persistence and the legacy upgrade path =============================
{
  // 5a. Empty storage → mint once, persist, and return the SAME id next call.
  //     (This is the whole point of "stable": a reload must not change it.)
  const store = new Map();
  const s = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  const [first, second] = withGlobals({ sessionStorage: s }, () => [stableSessionId(), stableSessionId()]);
  ok(SID_RE.test(first), 'fresh tab mints a current-format id');
  eq('id is stable across calls (survives a reload)', second, first);
  eq('id was persisted under libretrowebxr.sid', store.get('libretrowebxr.sid'), first);

  // 5b. A stored CURRENT-format id is kept verbatim — nobody already running is
  //     logged out of their host reclaim by the upgrade.
  const existing = 'sid-' + 'a1b2c3d4'.repeat(4);   // 32 hex chars
  const store2 = new Map([['libretrowebxr.sid', existing]]);
  const s2 = { getItem: (k) => (store2.has(k) ? store2.get(k) : null), setItem: (k, v) => store2.set(k, v) };
  const got = withGlobals({ sessionStorage: s2 }, () => stableSessionId());
  eq('existing current-format id is reused, not regenerated', got, existing);
  eq('…and the stored value is left alone', store2.get('libretrowebxr.sid'), existing);

  // 5c. A stored LEGACY id is deliberately ROTATED. Honouring it would keep the
  //     guessable bearer alive for the life of the tab, which would make the fix
  //     a no-op for everyone already running. Cost is bounded to one in-flight
  //     host reclaim at upgrade time.
  const legacyStored = legacySessionId();
  const store3 = new Map([['libretrowebxr.sid', legacyStored]]);
  const s3 = { getItem: (k) => (store3.has(k) ? store3.get(k) : null), setItem: (k, v) => store3.set(k, v) };
  const rotated = withGlobals({ sessionStorage: s3 }, () => stableSessionId());
  ok(rotated !== legacyStored, `legacy stored id is rotated away (${legacyStored} → ${rotated})`);
  ok(SID_RE.test(rotated), 'the rotated id is current-format');
  // These two used to be written as `eq(stored, rotated)` and `eq(next, rotated)`,
  // which PASS at HEAD: there `rotated === legacyStored`, so both compared a value
  // against itself (flagged by the round-4 verifier, rewritten 2026-08-15). State
  // the property that is actually new — the STORED bytes changed and are current
  // format — so the assertion dies with the rotation.
  const storedAfter = store3.get('libretrowebxr.sid');
  ok(storedAfter !== legacyStored && SID_RE.test(storedAfter) && storedAfter === rotated,
     `the rotation is written back to storage (stored ${storedAfter}, returned ${rotated}, was ${legacyStored})`);
  // …and rotating happens exactly once: the next call is stable AND still not the
  // legacy value (a no-op implementation returns legacyStored twice and passes a
  // bare "stable" check).
  const again = withGlobals({ sessionStorage: s3 }, () => stableSessionId());
  ok(again === rotated && again !== legacyStored && SID_RE.test(again),
     `rotated id is then stable and stays current-format (${again})`);

  // 5d. Junk / oversized stored values are treated like legacy: replaced, never
  //     handed to the server (the server silently truncates to ROOM_MAX_SID_LEN,
  //     so an oversized sid could match a DIFFERENT peer's truncated prefix).
  for (const junk of ['', 'sid-', 'x'.repeat(500), 'sid-ZZZZ', 'sid-' + 'a'.repeat(31)]) {
    const st = new Map([['libretrowebxr.sid', junk]]);
    const sj = { getItem: (k) => (st.has(k) ? st.get(k) : null), setItem: (k, v) => st.set(k, v) };
    const out = withGlobals({ sessionStorage: sj }, () => stableSessionId());
    ok(SID_RE.test(out) && out !== junk, `junk stored sid ${JSON.stringify(junk.slice(0, 12))} is replaced`);
  }
}

// === 6. In-memory fallback (sessionStorage blocked: private mode, Node) =====
// Needs a FRESH module instance each time, because the fallback id is cached in
// a module-level closure for the life of the page.
{
  const thrower = { get getItem() { throw new Error('blocked'); } };
  const mod = await freshModule();
  const [a, b] = withGlobals({ sessionStorage: thrower }, () => [mod.stableSessionId(), mod.stableSessionId()]);
  ok(SID_RE.test(a), 'blocked sessionStorage → current-format in-memory id');
  eq('in-memory id is stable within the page', b, a);

  // A second, independent "page" gets a different one.
  const mod2 = await freshModule();
  const c = withGlobals({ sessionStorage: thrower }, () => mod2.stableSessionId());
  ok(c !== a, 'a separate page/module instance gets its own in-memory id');

  // No sessionStorage global at all (plain Node import) behaves the same way.
  const mod3 = await freshModule();
  const d = withGlobals({ sessionStorage: undefined }, () => mod3.stableSessionId());
  ok(SID_RE.test(d), 'no sessionStorage global → current-format in-memory id');
}

// === 7. randomRoomSuffix shares the CSPRNG path =============================
// Cosmetic, not a secret — but it must not be a second, weaker randomness path,
// and it must keep the contract scripts/test-session.mjs already asserts.
{
  const suffixes = withGlobals({}, () => {
    Math.random = () => 0.5;                       // freeze the OLD source
    return draw(200, randomRoomSuffix);
  });
  ok(suffixes.every((s) => s.length === 4), 'room suffix is still exactly 4 chars');
  ok(suffixes.every((s) => /^[a-z0-9]{4}$/.test(s)), 'room suffix is still lowercase alphanumeric');
  ok(uniq(suffixes) > 150, `room suffixes vary with Math.random FROZEN (${uniq(suffixes)}/200 distinct)`);

  // NEGATIVE CONTROL 7: the old suffix generator under the same frozen global.
  const legacy = withGlobals({}, () => { Math.random = () => 0.5; return draw(200, legacyRoomSuffix); });
  ok(uniq(legacy) === 1, `NEG: legacy room suffix collapses to one value when Math.random is frozen (got ${uniq(legacy)})`);
  console.log(`  [neg-7] legacy suffix under frozen Math.random: ${uniq(legacy)} distinct, value=${legacy[0]}`);

  // The rejection sampling should reach the whole 36-char alphabet.
  const seen = new Set(draw(2000, randomRoomSuffix).join('').split(''));
  ok(seen.size === 36, `all 36 alphabet characters occur across 2000 suffixes (saw ${seen.size})`);
}

// === 7b. The rejection-sampling discard itself ==============================
// `if (b >= 252) continue;` carries a load-bearing WHY comment ("keeps the 36
// characters equally likely instead of biasing the first four") and the round-5
// verifier showed that DELETING the line left the suite at 54/54 — a documented
// mechanism with zero coverage. Statistics won't catch it (the bias is 8/256 vs
// 7/256 on four characters), so drive it with a stubbed CSPRNG and assert the
// exact suffix: 252 = 7 * 36, so without the discard bytes 252..255 fold onto
// 'a','b','c','d' and the asserted string changes.
{
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const byteToChar = (b) => ALPHABET[b % 36];
  const fromBytes = (bytes) => ({ getRandomValues(buf) { for (let i = 0; i < buf.length; i++) buf[i] = bytes[i % bytes.length]; return buf; } });

  // (a) A batch that opens with the biased tail. Discarded → the suffix is built
  //     from the four usable bytes; kept → it would be the first four characters
  //     of the alphabet, which is exactly the bias the comment describes.
  const tail = [252, 253, 254, 255];          // the discarded range
  const usable = [10, 20, 30, 40];            // → 'k','u','4','e'
  const withTail = withGlobals({ crypto: fromBytes([...tail, ...usable]) }, () => randomRoomSuffix());
  eq('bytes in the biased tail are discarded, not folded onto the alphabet head',
     withTail, usable.map(byteToChar).join(''));
  // Spell out what the un-discarded reading would have been, so the control is
  // visible in the file and not just in the diff of a deleted line.
  eq('…and 252..255 really would collide with a,b,c,d (that is why they are dropped)',
     tail.map(byteToChar).join(''), 'abcd');

  // (b) The discard must RE-DRAW, not silently shorten the suffix: a batch that
  //     is entirely tail bytes contributes nothing and the loop asks for more.
  let calls = 0;
  const allTailThenUsable = {
    getRandomValues(buf) {
      calls++;
      for (let i = 0; i < buf.length; i++) buf[i] = calls === 1 ? 255 : 5 + i;
      return buf;
    },
  };
  const s2 = withGlobals({ crypto: allTailThenUsable }, () => randomRoomSuffix());
  eq('an all-tail batch yields no characters and the loop draws again', s2, 'fghi');
  ok(calls === 2, `the all-tail batch forced a second CSPRNG draw (${calls} calls)`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
