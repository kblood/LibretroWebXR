// TestApi — the ONE documented, stable automation surface for this app.
//
// See docs/TEST_AUTOMATION.md for the full reference and for how to write a new
// headless multiplayer test. This file is the implementation; the doc is the
// contract.
//
// WHY THIS EXISTS
// ---------------
// Before this module there were 40+ ad-hoc `window.__foo` debug hooks, each
// added by whichever session needed it, with inconsistent shapes (some sync,
// some async, some returning strings like 'no-client' as errors, several
// overlapping ways to load a ROM). Every headless test hand-rolled calls into
// whatever hook happened to exist, and several of those tests turned out to be
// VACUOUSLY GREEN — they asserted on something that could not fail:
//
//   * `window.__client.paused` — false on a client whose core had never booted.
//   * comparing two peers' room layouts when both had independently built the
//     same DEFAULT layout, so "they match" proved no sync at all.
//   * WebRTC `receivingCount()`/`connectedCount()` — reported a healthy stream
//     over a FROZEN picture (the track stays 'live' after the source canvas is
//     retired).
//
// The real bugs were only caught with better evidence channels: TV pixel
// correlation between peers, "did this browser fetch a core binary at all",
// decoded-frame progression, and negative-controlled reverts. This API's job is
// to make the GOOD evidence channels the easy ones to reach for, so a future
// test does not have to rediscover them.
//
// DESIGN RULES (please keep them)
// -------------------------------
//  1. THIN FACADE. NetMgr / RackMgr / GrabMgr / GameInputMgr / VideoMgr / the
//     real load functions stay the source of truth. Nothing here reimplements
//     app behaviour; every method delegates to the same function the real UI
//     calls. Where a method deliberately skips something (e.g. the 3D grab
//     gesture, which has no headless equivalent), the doc comment says so.
//  2. ONE CALLING CONVENTION. Everything is callable as
//     `await __testApi.call('ns.method', [args])` which NEVER rejects: it
//     resolves `{ ok: true, value }` or `{ ok: false, error: { code, message,
//     detail } }`. This survives structured cloning across `page.evaluate`,
//     so the Node harness does not have to parse exception strings. The
//     namespaced methods (`__testApi.session.join(...)`) are the same functions
//     and DO throw — convenient in devtools.
//  3. NO NEW TRUTH. Anything already exposed correctly by a subsystem's
//     `debugApi()` is re-exported, not recomputed.
//  4. DEPENDENCY-INJECTED. This module imports nothing (no THREE, no DOM at
//     module scope), so scripts/test-testapi.mjs can exercise it in Node with
//     fakes. Positions are plain `[x, y, z]` arrays for the same reason.
//
// ERROR CODES (stable — tests may assert on them)
//   no-such-method   the dotted path does not exist
//   unsupported      valid method, not available on this client kind
//   not-connected    needs an active room session
//   not-host         needs to be the room host
//   host-not-eligible  becomeHost() cannot promote this peer (server elects)
//   not-found        no such prop / console / tv / shelf entry
//   timeout          a wait* method ran out of time
//   blank            a pixel sample came back empty/uniform (tainted or unpainted)
//   failed           the underlying app call refused (message carries its reason)

/** Bumped when a method's signature or return shape changes incompatibly. */
export const TEST_API_VERSION = 1;

/** Error thrown by every namespaced method; `code` is from the table above. */
export class TestApiError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'TestApiError';
    this.code = code;
    this.detail = detail;
  }
}

const fail = (code, message, detail = null) => { throw new TestApiError(code, message, detail); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until truthy. Resolves its value, or throws `timeout`. */
async function until(fn, { timeoutMs = 10000, everyMs = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try { v = await fn(); } catch (_) { v = null; }   // mid-reload / mid-boot
    if (v) return v;
    if (Date.now() >= deadline) fail('timeout', `timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------
// Pixel evidence
// ---------------------------------------------------------------------------
// Two DIFFERENT measurements, for two different questions. Mixing them up is
// how you write a vacuously-green test:
//
//   hash — a 32-bit FNV-1a over a downsampled RGB grab. Use it to ask
//          "did THIS peer's picture change between t0 and t1". It is exact, so
//          it is NOT comparable across peers: a watcher sees a WebRTC-re-encoded
//          version of the host's canvas, so the bytes always differ.
//
//   sig  — a coarse luma grid (default 8x6 cells). Use it to ask "are these two
//          peers looking at the same picture", by correlating two sigs
//          (Pearson). Same game ⇒ strongly positive; different games ⇒ ~0. This
//          is the check that caught the "watcher stuck on the retired canvas"
//          bug, which every connection-count check passed.
//
// Both are taken via drawImage into an offscreen 2D canvas, so a WebGL core
// canvas and a remote <video> element are sampled identically and we never
// touch gl.readPixels.

// Draw `src` (canvas or <video>) into an offscreen 2D canvas of `dw`x`dh`,
// optionally cropping a source rectangle first, and return its ImageData.
// null on anything unreadable (tainted, zero-sized, no 2D context).
// Normalise a crop spec. Accepts SOURCE PIXELS `{x,y,w,h}` or, preferably for
// cross-peer work, NORMALISED `{u0,v0,u1,v1}` (0..1) — the host samples its own
// canvas while a watcher samples a re-scaled WebRTC <video>, so the same
// normalised rect lands on the same part of the game on both, while a
// pixel rect would not.
function cropRect(rect, w, h) {
  if (!rect) return null;
  if (rect.u0 != null || rect.v0 != null) {
    const u0 = rect.u0 ?? 0, v0 = rect.v0 ?? 0, u1 = rect.u1 ?? 1, v1 = rect.v1 ?? 1;
    return { x: u0 * w, y: v0 * h, w: Math.max(1, (u1 - u0) * w), h: Math.max(1, (v1 - v0) * h) };
  }
  return rect;
}

function grab(doc, src, w, h, dw, dh, rectIn) {
  if (!src || !w || !h) return null;
  const rect = cropRect(rectIn, w, h);
  const off = doc.createElement('canvas');
  off.width = dw; off.height = dh;
  const ctx = off.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    if (rect) ctx.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, dw, dh);
    else ctx.drawImage(src, 0, 0, dw, dh);
  } catch (_) { return null; }
  try { return { data: ctx.getImageData(0, 0, dw, dh).data, w: dw, h: dh }; }
  catch (_) { return null; }              // tainted canvas
}

const luma = (d, i) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;

/**
 * Mean luma per band across one axis of (a crop of) the source — a 1-D profile.
 * axis:'y' gives one value per horizontal band (use it to locate something that
 * moves VERTICALLY, e.g. a Pong paddle); axis:'x' per vertical band.
 * Deliberately generic: the app has no idea what a paddle is, and neither
 * should this file — the test does the interpreting.
 */
function profileSource(doc, src, w, h, { rect = null, axis = 'y', bins = 32, samples = 16 } = {}) {
  const across = Math.max(2, samples | 0);
  const along = Math.max(2, bins | 0);
  const g = (axis === 'x')
    ? grab(doc, src, w, h, along, across, rect)
    : grab(doc, src, w, h, across, along, rect);
  if (!g) return null;
  const out = [];
  for (let b = 0; b < along; b++) {
    let sum = 0;
    for (let s = 0; s < across; s++) {
      const i = (axis === 'x') ? ((s * g.w + b) * 4) : ((b * g.w + s) * 4);
      sum += luma(g.data, i);
    }
    out.push(sum / across);
  }
  return out;
}

function sampleSource(doc, src, w, h, { gx = 8, gy = 6, cell = 8, rect = null } = {}) {
  const g = grab(doc, src, w, h, gx * cell, gy * cell, rect);
  if (!g) return null;
  const off = { width: g.w, height: g.h };
  const data = g.data;
  // FNV-1a over RGB (skip alpha: a canvas without alpha reads 255 everywhere).
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      hash ^= data[i + k];
      hash = (hash * 0x01000193) >>> 0;
    }
  }
  // Coarse luma grid.
  const sig = [];
  let min = Infinity, max = -Infinity;
  for (let cy = 0; cy < gy; cy++) {
    for (let cx = 0; cx < gx; cx++) {
      let sum = 0, n = 0;
      for (let y = cy * cell; y < (cy + 1) * cell; y++) {
        for (let x = cx * cell; x < (cx + 1) * cell; x++) {
          const i = (y * off.width + x) * 4;
          sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
          n++;
        }
      }
      const v = sum / n;
      sig.push(v);
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return {
    hash: (hash >>> 0).toString(16).padStart(8, '0'),
    sig,
    w, h,
    // A uniform image carries no evidence: correlating against it yields null,
    // and a "hash changed" check over two blank frames is meaningless. Callers
    // should treat blank:true as "no evidence yet", not as a pass.
    blank: !(max - min > 1),
    spread: max - min,
  };
}

/**
 * Pearson correlation of two luma signatures. null when either is flat (no
 * evidence) or the lengths differ. Exported so the Node harness uses the exact
 * same maths as the page.
 */
export function correlate(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return null;
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

/**
 * Build the automation facade.
 *
 * Every dep is optional: an absent one makes the methods that need it throw
 * `unsupported`, which is how the desktop client gets the SAME namespace shape
 * with a smaller feature set (a test can then probe `__testApi.methods()` /
 * `supports()` instead of sniffing `clientKind`).
 *
 * @param {object} deps
 * @param {'vr'|'desktop'} deps.clientKind
 * @param {Function} [deps.ready]        () => Promise — resolves when the world is built
 * @param {Function} [deps.net]          () => NetMgr|null (LIVE getter; net is reassigned on join)
 * @param {Function} [deps.connectToRoom] (room, nick, color) => NetMgr
 * @param {Function} [deps.disconnectFromRoom] () => void
 * @param {Function} [deps.amRoomHost]   () => boolean (true when solo)
 * @param {Function} [deps.mayRunLocalCore] () => boolean
 * @param {string}   [deps.fallbackHostKey] STATE key of the client-side election
 * @param {object}   [deps.props]        see the props section below
 * @param {Function} [deps.gameInput]    () => GameInputMgr
 * @param {Function} [deps.rack]         () => RackMgr
 * @param {Function} [deps.tvs]          () => TV[]  (scene._tvs)
 * @param {Function} [deps.tvSource]     (tvId) => consoleId|null  (cable.sourceOf)
 * @param {object}   [deps.content]      see the content section below
 * @param {object}   [deps.gun]          { arm, disarm, state, fire, port }
 * @param {object}   [deps.mouse]        { arm, disarm, state, move, port }
 * @param {Function} [deps.roomDescriptor] () => current room descriptor
 * @param {Function} [deps.currentMeta]  () => the primary console's loaded meta
 * @param {Function} [deps.nextFrame]    () => Promise — resolves after one app tick
 * @param {Document} [deps.document]
 * @param {object}   [deps.legacy]       names of the old hooks, for `raw()`
 */
export function createTestApi(deps = {}) {
  const doc = deps.document || (typeof document !== 'undefined' ? document : null);
  const kind = deps.clientKind || 'vr';
  const need = (v, what) => (v == null ? fail('unsupported', `${what} is not available on the ${kind} client`) : v);
  const netOf = () => (typeof deps.net === 'function' ? deps.net() : null);
  const liveNet = () => need(netOf(), 'a room session') && (netOf().connected ? netOf() : fail('not-connected', 'not connected to a room'));
  const nextFrame = deps.nextFrame || (() => sleep(20));

  // -- session --------------------------------------------------------------
  const session = {
    /** Everything role/connection related, in one snapshot. */
    state() {
      const n = netOf();
      if (!n) return { connected: false, room: null, selfId: null, peerCount: 0, peers: [], hostId: null, isHost: true, solo: true, serverElects: false, mayRunLocalCore: !!deps.mayRunLocalCore?.() };
      return {
        connected: !!n.connected,
        room: n.room ?? null,
        selfId: n.presence?.selfId ?? null,
        peerCount: n.presence?.size ?? 0,
        peers: (n.presence?.peers?.() || []).map((p) => ({ id: p.id, nick: p.nick })),
        hostId: n.hostId?.() ?? null,
        isHost: !!n.isHost?.(),
        solo: false,
        // false ⇒ the client-side fallback election is in charge (an old relay).
        // becomeHost() can only promote in that mode.
        serverElects: !!n._serverElects,
        sessionId: n.sessionId ?? null,
        mayRunLocalCore: !!deps.mayRunLocalCore?.(),
        tvOwner: n.objects?.ownerOf?.('tv') ?? null,
      };
    },
    /** Join (or switch to) a room. Resolves once the socket is up. */
    async join({ room, nick = 'test', color = '#88aaff', timeoutMs = 20000 } = {}) {
      if (!room) fail('failed', 'join() needs a room id');
      need(deps.connectToRoom, 'joining a room')(room, nick, color);
      await until(() => netOf()?.connected, { timeoutMs, what: `the socket for room "${room}"` });
      const s = session.state();
      return { room: s.room, selfId: s.selfId, connected: true };
    },
    /** Leave the room and restore solo state (the real Leave-button path). */
    async leave() {
      need(deps.disconnectFromRoom, 'leaving a room')();
      await nextFrame();
      return { left: true, connected: !!netOf()?.connected };
    },
    isHost() { return !!(deps.amRoomHost ? deps.amRoomHost() : true); },
    /**
     * Wait until this peer KNOWS the room's host (its own id or someone else's).
     * Use this instead of a bare sleep: before the HELLO lands every peer reads
     * hostId()===null, and a test that boots then is testing an undecided room.
     */
    async waitForHostElection({ timeoutMs = 20000 } = {}) {
      liveNet();
      await until(() => netOf()?.hostId?.(), { timeoutMs, what: 'the room host to be elected' });
      const s = session.state();
      return { hostId: s.hostId, isHost: s.isHost };
    },
    /**
     * Make THIS peer the host if that is possible without lying to the room.
     * - already host → resolves immediately.
     * - client-side fallback election (old relay, serverElects false) → writes a
     *   winning claim under the election's STATE key and waits for convergence.
     * - server-elected room → throws `host-not-eligible`, because the server
     *   picks by seniority and there is no promotion message. For a
     *   deterministic host, open that peer FIRST (the harness's openHost() does
     *   exactly this) or make the current host leave.
     */
    async becomeHost({ timeoutMs = 20000 } = {}) {
      liveNet();
      if (session.isHost()) return { isHost: true, hostId: session.state().hostId, via: 'already-host' };
      const n = netOf();
      if (n._serverElects) {
        fail('host-not-eligible',
          'the room server elects by seniority; this peer cannot promote itself',
          { hostId: n.hostId?.() ?? null, hint: 'open this peer first, or have the current host leave()' });
      }
      const key = deps.fallbackHostKey || 'hostClaim';
      const cur = n.getObjectState?.(key) || null;
      const at = Math.min(Number(cur?.at) || Date.now(), Date.now()) - 1;
      n.setObjectState(key, { id: n.presence.selfId, at });
      await until(() => deps.amRoomHost?.(), { timeoutMs, what: 'the fallback election to converge on us' });
      return { isHost: true, hostId: session.state().hostId, via: 'fallback-claim' };
    },
    peers() { return session.state().peers; },
    /**
     * Where THIS peer is standing, plus the spawn seat it was given on join
     * (see SessionUtils.spawnSeatOffset). `seatIndex` is its join order — 0 for
     * the room's senior peer, which keeps the canonical origin — and `rig`/`head`
     * are world-space `[x,y,z]`.
     *
     * Pair it with `avatars()` to answer the question a screenshot can't: is a
     * remote peer's head plane parked at my camera, occluding the TV?
     */
    viewpoint() {
      const n = netOf();
      const vp = need(deps.viewpoint, 'the player viewpoint')();
      return {
        ...vp,
        seatIndex: n?.spawnSeat?.index ?? null,
        seatOffset: n?.spawnSeat?.offset ?? null,
      };
    },
    /**
     * Every REMOTE peer's avatar head in world space: `[{id, nick, pos}]`.
     * Empty when solo. The honest measurement for avatar occlusion is the
     * horizontal distance between one of these and `viewpoint().head` — two
     * peers spawned on the same spot read ~0.
     */
    avatars() { return netOf()?.avatars?.positions?.() ?? []; },
    /** Shared room STATE (M0.5 channel). `key` e.g. 'tv', 'room', 'prop:<id>'. */
    objectState(key) { return liveNet().getObjectState?.(key) ?? null; },
    objectEntries() { return liveNet().objects?.entries?.() ?? []; },
    setObjectState(key, value) { return liveNet().setObjectState(key, value); },
    /** Transient relay (M2 'gp'/'drag'/'gun'/'insert'… channels). */
    sendWire(ch, data) { return liveNet().sendWire(ch, data); },
    /**
     * As HOST: the forwarded controller inputs received from other peers
     * (`{from, player, btn, down}`), newest last. Direct evidence that a
     * client's press crossed the network — pair it with a pixel check that the
     * host's GAME actually reacted, since "the message arrived" alone is the
     * kind of assertion this project has been burned by.
     */
    recvInputs() { return liveNet().debugApi?.().recvInputs?.() ?? []; },
    /** Ring buffer of received wire messages per channel (for assertions). */
    wireRx(ch) {
      const f = typeof deps.wireRx === 'function' ? deps.wireRx : null;
      return need(f, 'the wire receive log')(ch);
    },
    /** Raw NetMgr.debugApi() — escape hatch; prefer the methods above. */
    debug() { return netOf()?.debugApi?.() ?? null; },
  };

  // -- props ----------------------------------------------------------------
  // deps.props: {
  //   entries()          -> Map<propId, { prop, object }>   (the live _syncedProps)
  //   add(type, opts)    -> propId|null                     (the real addProp)
  //   remove(propId)     -> boolean
  //   editRelease(object)-> void   (grabMgr's onEditRelease: editor snap +
  //                                 _broadcastPropMove + persistRack — i.e. the
  //                                 exact callback a real VR release fires)
  //   serialize(prop, object) -> payload  (serializePropState)
  //   isStatic(propId)   -> boolean
  //   holdKeyFor(object) -> string|null   (network hold key for lockable kinds)
  // }
  const _testHeld = new Set();
  const P = () => need(deps.props, 'prop manipulation');
  const recOf = (id) => {
    const rec = P().entries().get(id);
    return rec || fail('not-found', `no synced prop "${id}"`, { known: [...P().entries().keys()].slice(0, 40) });
  };
  const propView = (id, rec) => ({
    id,
    type: rec.prop?.type ?? null,
    kind: rec.object?.userData?.kind ?? null,
    pos: [rec.object.position.x, rec.object.position.y, rec.object.position.z],
    rot: [rec.object.rotation.x, rec.object.rotation.y, rec.object.rotation.z],
    static: !!P().isStatic?.(id),
    cableId: rec.object?.userData?.cableId ?? null,
    heldByTest: _testHeld.has(id),
  });
  const props = {
    /** Every prop this peer syncs, with ids you can pass to grab/moveTo. */
    list() { return [...P().entries().entries()].map(([id, rec]) => propView(id, rec)); },
    get(id) { return propView(id, recOf(id)); },
    /**
     * Take ownership for a scripted move. There is no headless XR squeeze, so
     * this does not run GrabMgr's raycast; it takes the NETWORK side of a grab
     * (the exclusive hold key for gamepads/guns/mice, so peers really do see it
     * locked) and marks the prop so moveTo() streams live 'drag' frames like a
     * held prop does. release() then runs the real release callback.
     */
    grab(id) {
      const rec = recOf(id);
      _testHeld.add(id);
      const key = P().holdKeyFor?.(rec.object);
      const n = netOf();
      if (key && n?.connected) n.setObjectState(key, { holder: n.presence.selfId, hand: 'right' });
      return { id, held: true, holdKey: key || null };
    },
    /**
     * Move a grabbed prop. While grabbed this broadcasts on the transient
     * 'drag' channel — the same payload the per-frame drag tick sends — so a
     * peer's copy follows in real time. The AUTHORITATIVE transform is only
     * published by release().
     */
    async moveTo(id, pos, { rot = null } = {}) {
      const rec = recOf(id);
      if (Array.isArray(pos)) rec.object.position.set(pos[0], pos[1], pos[2]);
      if (Array.isArray(rot)) rec.object.rotation.set(rot[0], rot[1], rot[2]);
      rec.object.updateMatrixWorld?.(true);
      const n = netOf();
      if (_testHeld.has(id) && n?.connected && P().serialize) {
        n.sendWire('drag', { id, payload: P().serialize(rec.prop, rec.object) });
      }
      await nextFrame();
      return propView(id, recOf(id));
    },
    /**
     * Drop it: runs grabMgr's onEditRelease callback, which is what a real VR
     * release runs — editor snapping, the authoritative `prop:<id>` STATE
     * broadcast, and rack persistence for consoles/TVs.
     */
    async release(id) {
      const rec = recOf(id);
      _testHeld.delete(id);
      const key = P().holdKeyFor?.(rec.object);
      const n = netOf();
      if (key && n?.connected) n.setObjectState(key, null);
      need(P().editRelease, 'prop release')(rec.object);
      await nextFrame();
      return propView(id, recOf(id));
    },
    /** grab → moveTo → release in one call. The usual one to reach for. */
    async move(id, pos, opts = {}) {
      props.grab(id);
      await props.moveTo(id, pos, opts);
      return props.release(id);
    },
    /** Spawn a prop ('poster' | 'console' | 'tv' | 'shelf' | 'gamepad' | …). */
    async add(type, opts = {}) {
      const id = need(P().add, 'adding props')(type, opts);
      if (!id) fail('failed', `could not add a "${type}" prop`);
      await nextFrame();
      return props.get(id);
    },
    remove(id) {
      recOf(id);
      const okd = need(P().remove, 'removing props')(id);
      if (!okd) fail('failed', `could not remove prop "${id}" (static props cannot be removed)`);
      return { removed: true, id };
    },
    /** Wait until prop `id` is within `tol` metres of `pos`. Cross-peer check. */
    async waitForPosition(id, pos, { tol = 0.01, timeoutMs = 15000 } = {}) {
      const near = () => {
        const rec = P().entries().get(id);
        if (!rec) return null;
        const p = rec.object.position;
        return (Math.abs(p.x - pos[0]) <= tol && Math.abs(p.y - pos[1]) <= tol && Math.abs(p.z - pos[2]) <= tol)
          ? propView(id, rec) : null;
      };
      return until(near, { timeoutMs, what: `prop "${id}" to reach [${pos}]` });
    },
    /** Wait until prop `id` exists here at all (late-join / peer-spawned prop). */
    async waitForProp(id, { timeoutMs = 15000 } = {}) {
      return until(() => (P().entries().has(id) ? propView(id, P().entries().get(id)) : null),
        { timeoutMs, what: `prop "${id}" to arrive` });
    },
  };

  // -- input ---------------------------------------------------------------
  const GI = () => need(typeof deps.gameInput === 'function' ? deps.gameInput() : null, 'controller input');
  const input = {
    /**
     * Hold a RetroPad button. Routing is automatic and mirrors production:
     *  - host or solo → GameInputMgr.setRemoteButton(), i.e. the exact path a
     *    networked player's input takes into the host's core. Dispatch happens
     *    on the next tick, which this awaits.
     *  - non-host client → NetMgr.forwardGameInput(), i.e. the exact path a
     *    real client's controller takes to the host.
     * Override with `{ route: 'local' | 'net' }`.
     *
     * @param {string} btn   'A'|'B'|'X'|'Y'|'L'|'R'|'Start'|'Select'|'Up'|'Down'|'Left'|'Right'
     * @param {object} [opts] { player = 1 (port slot 1..4), consoleId, route }
     */
    async press(btn, opts = {}) { return input._set(btn, true, opts); },
    async release(btn, opts = {}) { return input._set(btn, false, opts); },
    /** press → wait ms → release. `ms` must exceed one core frame (~17ms). */
    async tap(btn, { ms = 120, ...opts } = {}) {
      await input._set(btn, true, opts);
      await sleep(ms);
      return input._set(btn, false, opts);
    },
    /** Run a list of taps/holds in order: [{btn, ms}, …]. */
    async sequence(steps = [], opts = {}) {
      const out = [];
      for (const s of steps) out.push(await input.tap(s.btn, { ms: s.ms ?? 120, ...opts, ...s.opts }));
      return out;
    },
    async _set(btn, down, { player = 1, consoleId, route = 'auto' } = {}) {
      if (!btn) fail('failed', 'press()/release() need a button name');
      const asNet = route === 'net' || (route === 'auto' && !session.isHost());
      if (asNet) {
        const sent = liveNet().forwardGameInput({ player, btn, down });
        if (!sent) fail('failed', `the room would not accept ${btn} (no host to forward to yet?)`);
        return { btn, down, player, via: 'net' };
      }
      GI().setRemoteButton({ player, btn, down, consoleId });
      await nextFrame();
      return { btn, down, player, consoleId: consoleId ?? null, via: 'local' };
    },
    /** Lift everything (a latched button survives a test otherwise). */
    async releaseAll() {
      const gi = GI();
      gi.clearRemote?.();
      gi.flushReleases?.();
      await nextFrame();
      return { released: true };
    },
    /** { system, holding, free, pressedKeys } — what actually reached the core. */
    state() {
      const gi = GI();
      return { system: gi.currentSystem?.() ?? null, debug: gi.getDebugState?.() ?? null };
    },
    setSystem(system) { GI().setSystem(system); return { system: GI().currentSystem?.() ?? null }; },
    /**
     * Raw key straight at a console's core — for keyboard systems (DOS, C64,
     * Amiga) where "RetroPad button" is the wrong abstraction.
     */
    async rawKey(code, key, down, { consoleId } = {}) {
      const r = need(deps.rack, 'consoles')();
      const cid = consoleId || r.focusedId?.() || r.ids?.()[0];
      const rt = r.get?.(cid) || fail('not-found', `no console "${cid}"`);
      rt.sendInput(down ? 'keydown' : 'keyup', code, key ?? code, 0, 0);
      await nextFrame();
      return { code, down, consoleId: cid };
    },
  };

  // -- peripherals ---------------------------------------------------------
  const peripheral = (name, d) => ({
    arm() { return need(d?.arm, `the ${name}`)(); },
    disarm() { return need(d?.disarm, `the ${name}`)(); },
    state() { return need(d?.state, `the ${name}`)(); },
    port(cableId) { return need(d?.port, `the ${name}`)(cableId); },
  });
  const gun = {
    ...peripheral('light gun', deps.gun),
    /**
     * Fire at a screen point. `{u, v}` (0..1 over the TV's framebuffer) is the
     * ergonomic form; `{pos, look}` world vectors are passed straight through
     * for aim-geometry tests. Runs one real LightGunMgr tick.
     */
    async fire({ u, v, trigger = true, pos, look, tvId } = {}) {
      const r = need(deps.gun?.fire, 'the light gun');
      const out = r({ u, v, trigger, pos, look, tvId });
      await nextFrame();
      return out;
    },
  };
  const mouse = {
    ...peripheral('mouse', deps.mouse),
    async move(dx, dy, buttons = 0) {
      const out = need(deps.mouse?.move, 'the mouse')(dx, dy, buttons);
      if (typeof out === 'string' && out !== 'moved') fail('failed', `mouse move refused: ${out}`);
      await nextFrame();
      return { dx, dy, buttons };
    },
  };

  // -- content -------------------------------------------------------------
  // deps.content: {
  //   shelf()            -> meta[]     (window.__games)
  //   localRoms()        -> meta[]
  //   insert(meta, opts) -> void       (handleCartridgeInserted — the real
  //                                     cartridge-into-slot path)
  //   load(meta)         -> Promise    (loadCartridge — the RomResolver path)
  //   pickFile(name, buf, opts) -> Promise  (the file-picker stand-in)
  //   addToShelf(meta)   -> Promise
  //   primaryConsoleId   -> string
  // }
  const C = () => need(deps.content, 'content loading');
  const resolveMeta = (ref) => {
    if (ref && typeof ref === 'object') return ref;
    const list = C().shelf?.() || [];
    const hit = list.find((g) => g.file === ref)
      || list.find((g) => g.title === ref)
      || list.find((g) => String(g.file || '').toLowerCase().includes(String(ref).toLowerCase()));
    return hit || fail('not-found', `no shelf entry matching "${ref}"`,
      { shelf: list.slice(0, 30).map((g) => g.file) });
  };
  const content = {
    /** Everything on the shelves, as insertable metas. */
    shelf() { return (C().shelf?.() || []).map((g) => ({ file: g.file, title: g.title, system: g.system, core: g.core })); },
    localRoms() { return need(C().localRoms, 'the local ROM library')(); },
    /** What the primary console (or `consoleId`) currently has loaded. */
    current({ consoleId } = {}) {
      if (!consoleId) return deps.currentMeta?.() ?? null;
      const rt = need(deps.rack, 'consoles')().get?.(consoleId) || fail('not-found', `no console "${consoleId}"`);
      return { core: rt.coreName, system: rt.system, title: rt.title, loaded: rt.isLoaded?.() };
    },
    /**
     * Insert a cart, by shelf file/title or by an explicit meta, optionally into
     * a specific console. This is `handleCartridgeInserted` — the same function
     * a physical cartridge snapping into a slot calls — so client-boot
     * suppression, same-core hot-swap and cross-core reload all behave exactly
     * as in the app. It is FIRE-AND-FORGET (the real path is too): follow it
     * with waitForGame().
     */
    insert(ref, { consoleId } = {}) {
      const meta = resolveMeta(ref);
      need(C().insert, 'cartridge insert')({ ...meta, ...(consoleId ? { consoleId } : {}) });
      return { requested: { file: meta.file, core: meta.core, system: meta.system, consoleId: consoleId ?? null } };
    },
    /** Boot through the ROM resolver (`loadCartridge`) and await it. */
    async load(ref) {
      const meta = resolveMeta(ref);
      await need(C().load, 'ROM loading')(meta);
      return { loaded: { file: meta.file, core: meta.core, system: meta.system } };
    },
    /**
     * Load ROM bytes as if the user had picked a file — from a URL, or from
     * bytes you supply. Host-only, like the real picker. `bytes` accepts an
     * ArrayBuffer/Uint8Array (in-page) or a base64 string (so it survives
     * page.evaluate from Node).
     */
    async loadFile({ url, name, bytes, system, core, ...opts } = {}) {
      let buf = null;
      let fname = name || null;
      if (url) {
        const res = await fetch(url);
        if (!res.ok) fail('failed', `fetch ${url} → HTTP ${res.status}`);
        buf = await res.arrayBuffer();
        fname = fname || decodeURIComponent(url.split('/').pop().split('?')[0]);
      } else if (typeof bytes === 'string') {
        const bin = atob(bytes);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        buf = u8.buffer;
      } else if (bytes) {
        buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer;
      }
      if (!buf || !fname) fail('failed', 'loadFile() needs {url} or {name, bytes}');
      return need(C().pickFile, 'the file picker')(fname, buf, { ...opts, ...(system ? { system } : {}), ...(core ? { core } : {}) });
    },
    addToShelf(meta) { return need(C().addToShelf, 'the shelf')(meta); },
    /**
     * Wait until a console really has this content loaded. Matches on file (or
     * title), so it works for the host's own boot AND for a watcher converging
     * on the host's published `tv` state.
     */
    async waitForGame(ref, { consoleId, timeoutMs = 60000 } = {}) {
      const want = (typeof ref === 'string') ? ref : (ref?.file || ref?.title);
      const hit = () => {
        const m = content.current({ consoleId: consoleId || undefined });
        if (!m) return null;
        const f = String(m.file || m.title || '');
        return (want && (f === want || f.includes(want) || String(m.title || '') === want)) ? m : null;
      };
      return until(hit, { timeoutMs, what: `"${want}" to be loaded${consoleId ? ` on ${consoleId}` : ''}` });
    },
  };

  // -- rack (consoles) -----------------------------------------------------
  const R = () => need(typeof deps.rack === 'function' ? deps.rack() : null, 'the console rack');
  const runtimeView = (rt) => ({
    id: rt.id,
    core: rt.coreName ?? null,
    system: rt.system ?? null,
    title: rt.title ?? null,
    loaded: !!rt.isLoaded?.(),
    // `live` = a core exists AND its main loop is not paused. It is still NOT
    // proof that the picture is moving (a wedged core reads live:true) — use
    // running()/progress() for that. It used to be bare `!paused`, which read
    // true for a runtime that never booted at all; ConsoleRuntime.isLive() now
    // requires hasCore(), so a coreless watcher honestly reports live:false.
    live: !!rt.isLive?.(),
    hasCore: rt.hasCore ? !!rt.hasCore() : null,
    allowed: !!rt.runAllowed?.(),
    canvasId: rt.canvas?.id ?? null,
    frames: rt.client?.frameBridge?.stats?.()?.framesPresented ?? null,
  });
  const rack = {
    list() { return R().runtimes().map(runtimeView); },
    focused() { return R().focusedId?.() ?? null; },
    focus(id) { return need(deps.rackFocus, 'focus')(id); },
    async spawn(system, opts = {}) {
      const id = await need(deps.rackSpawn, 'spawning a console')(system, opts);
      return { consoleId: id, list: rack.list() };
    },
    power(id, on) { return need(deps.rackPower, 'the power switch')(id, on); },
    reset(id) { return need(deps.rackReset, 'the reset button')(id); },
    /** false on a display-only client: this machine may run NO local core. */
    mayRunLocalCore() { return !!deps.mayRunLocalCore?.(); },
    budget() { return R().applyBudget(); },
    /**
     * "Is a core GENUINELY running here?" — the check `!paused` gets wrong.
     * A console counts as running only if it is loaded, unpaused, allowed to
     * run, AND its picture actually moved over `ms` (decoded worker frames when
     * the runtime reports them, else the canvas pixel hash changing).
     *
     * On a watching client every entry must read running:false. That is the
     * one-running-core invariant, and it is the assertion an MP test should
     * make instead of trusting `paused`.
     */
    async running({ ms = 1200 } = {}) {
      const before = new Map(R().runtimes().map((rt) => [rt.id, {
        frames: runtimeView(rt).frames,
        hash: rt.canvas && doc ? sampleSource(doc, rt.canvas, rt.canvas.width, rt.canvas.height)?.hash ?? null : null,
      }]));
      await sleep(ms);
      return R().runtimes().map((rt) => {
        const v = runtimeView(rt);
        const b = before.get(rt.id) || {};
        const now = rt.canvas && doc ? sampleSource(doc, rt.canvas, rt.canvas.width, rt.canvas.height) : null;
        const framesDelta = (v.frames != null && b.frames != null) ? v.frames - b.frames : null;
        const pixelsChanged = (b.hash != null && now?.hash != null) ? now.hash !== b.hash : null;
        const advanced = framesDelta != null ? framesDelta > 0 : !!pixelsChanged;
        return {
          ...v,
          framesDelta,
          pixelsChanged,
          blank: now ? now.blank : null,
          // The honest verdict. Deliberately requires evidence of motion, so an
          // idle-but-unpaused console does NOT read as running.
          running: !!(v.loaded && v.live && v.allowed && advanced),
        };
      });
    },
  };

  // -- tv ------------------------------------------------------------------
  const TVS = () => need(typeof deps.tvs === 'function' ? deps.tvs() : null, 'the in-world TVs');
  const tvOf = (tvId) => {
    const list = TVS();
    const tv = tvId ? list.find((t) => t.id === tvId) : list[0];
    return tv || fail('not-found', `no TV "${tvId}"`, { known: list.map((t) => t.id) });
  };
  const tvView = (tv) => ({
    id: tv.id,
    // THE question this replaces three.js spelunking for: is this screen
    // painting a LOCAL canvas or a REMOTE host's <video>?
    kind: tv.sourceVideo ? 'video' : (tv.sourceCanvas ? 'canvas' : 'none'),
    sourceId: tv.sourceCanvas?.id ?? null,
    active: !!tv.isActive?.(),
    console: deps.tvSource ? (deps.tvSource(tv.id) ?? null) : null,
    width: tv.sourceVideo ? (tv.sourceVideo.videoWidth || 0) : (tv.sourceCanvas?.width || 0),
    height: tv.sourceVideo ? (tv.sourceVideo.videoHeight || 0) : (tv.sourceCanvas?.height || 0),
  });
  const tv = {
    list() { return TVS().map(tvView); },
    get(tvId) { return tvView(tvOf(tvId)); },
    /**
     * Multi-disc (`.m3u`) state as this peer sees it:
     * `{ panel:{visible,label,index,discCount,ejected,remote}, published }`.
     *
     * `panel` is what the in-world DiscSwapPanel is really displaying (its own
     * getStatus, i.e. the label a user would read), and `published` is the disc
     * fields on the room's `tv` key. On a watcher `panel.remote` is true, because
     * a peer with no core of its own can only know the disc from the room state —
     * which is precisely what used to be missing.
     */
    disc() {
      const panel = need(deps.discPanel, 'the disc-swap panel')();
      const t = netOf()?.getObjectState?.('tv') ?? null;
      return {
        panel,
        published: t ? { disc: t.disc ?? null, discCount: t.discCount ?? null, ejected: !!t.discEjected } : null,
      };
    },
    /** Step the disc via the real Prev/Next buttons' handler (host-side). */
    async step(delta = 1) {
      await need(deps.stepDisc, 'the disc-swap control')(delta);
      await nextFrame();
      return tv.disc();
    },
    /**
     * Sample what is REALLY on the screen: `{ hash, sig, w, h, kind, blank }`.
     * hash → compare against this same peer later ("did it change").
     * sig  → correlate against ANOTHER peer ("same picture"), via
     *        harness.correlate / the exported correlate().
     */
    sample(tvId, opts = {}) {
      const t = tvOf(tvId);
      const v = tvView(t);
      const src = t.sourceVideo || t.sourceCanvas;
      if (!src) fail('blank', `TV "${v.id}" has no source at all`, v);
      if (!doc) fail('unsupported', 'no document to sample pixels with');
      const s = sampleSource(doc, src, v.width, v.height, opts);
      if (!s) fail('blank', `could not read pixels from TV "${v.id}" (tainted or zero-sized)`, v);
      return { ...v, ...s };
    },
    /**
     * 1-D luma profile of (a crop of) the screen — mean brightness per band.
     * This is how you locate a MOVING SPRITE without knowing anything about the
     * game: crop to the region it lives in, profile across the axis it moves
     * along, and compare the profiles before/after an input. Works identically
     * on a host's canvas and on a watcher's received <video>, so the same
     * measurement proves "the game changed" on BOTH sides of a session.
     *
     * @param {string} [tvId]
     * @param {object} [opts] { rect:{x,y,w,h} in SOURCE pixels, axis:'y'|'x',
     *                          bins, samples }
     * @returns {{id, kind, w, h, axis, bins, values:number[]}}
     */
    profile(tvId, opts = {}) {
      const t = tvOf(tvId);
      const v = tvView(t);
      const src = t.sourceVideo || t.sourceCanvas;
      if (!src) fail('blank', `TV "${v.id}" has no source at all`, v);
      if (!doc) fail('unsupported', 'no document to sample pixels with');
      const values = profileSource(doc, src, v.width, v.height, opts);
      if (!values) fail('blank', `could not read pixels from TV "${v.id}"`, v);
      return { ...v, axis: opts.axis || 'y', bins: values.length, values };
    },
    /** Did THIS peer's picture change over `ms`? (hash-based, peer-local.) */
    async progress(tvId, { ms = 1500, ...opts } = {}) {
      const a = tv.sample(tvId, opts);
      await sleep(ms);
      const b = tv.sample(tvId, opts);
      return { id: b.id, kind: b.kind, changed: a.hash !== b.hash, blank: b.blank, from: a.hash, to: b.hash, ms };
    },
    /** Wait until the picture is non-blank AND changing. */
    async waitForMotion(tvId, { timeoutMs = 30000, ms = 700, ...opts } = {}) {
      return until(async () => {
        const p = await tv.progress(tvId, { ms, ...opts });
        return (p.changed && !p.blank) ? p : null;
      }, { timeoutMs, everyMs: 0, what: `TV "${tvId ?? 'primary'}" to show a moving picture` });
    },
  };

  // -- video (host → client WebRTC) ---------------------------------------
  const V = () => need(netOf()?.video, 'the video manager');
  const video = {
    /**
     * Connection AND liveness in one snapshot. Read `hostVideo` before trusting
     * `receivingCount`: the counts stayed "healthy" over a frozen stream in a
     * real bug, which is why progress() exists.
     */
    state() {
      const v = V().debugApi ? V().debugApi() : V();
      return {
        amHost: v.amHost(), sourcing: v.sourcing(), sourceCanvas: v.sourceCanvas(),
        sourceTracks: v.sourceTracks(), sendingCount: v.sendingCount(),
        receivingCount: v.receivingCount(), connectedCount: v.connectedCount(),
        hasAudio: v.hasAudio(), receivingAudio: v.receivingAudio(),
        peers: v.peerStates(), hostVideo: v.hostVideo(),
      };
    },
    /**
     * Are DECODED FRAMES advancing on the received stream? Samples twice.
     * `advanced` is the only honest "the picture is alive" signal on a watcher.
     */
    async progress({ ms = 2500 } = {}) {
      const v = V().debugApi ? V().debugApi() : V();
      const a = v.hostVideo();
      if (!a) fail('not-found', 'no host <video> element on this peer (not receiving a stream)');
      await sleep(ms);
      const b = v.hostVideo();
      const dFrames = (b?.frames ?? 0) - (a.frames ?? 0);
      const dTime = (b?.time ?? 0) - (a.time ?? 0);
      const advanced = (b?.frames != null) ? dFrames > 0 : dTime > 0.1;
      return { advanced: !!(advanced && !b?.paused && (b?.w || 0) > 0), dFrames, dTime, paused: !!b?.paused, w: b?.w ?? 0, h: b?.h ?? 0, ms };
    },
    async waitForStream({ timeoutMs = 60000 } = {}) {
      await until(() => (V().debugApi ? V().debugApi() : V()).receivingCount() > 0,
        { timeoutMs, what: 'a live video track from the host' });
      return until(async () => {
        try { const p = await video.progress({ ms: 800 }); return p.advanced ? p : null; }
        catch (_) { return null; }
      }, { timeoutMs, everyMs: 0, what: 'the host stream to advance frames' });
    },
    broadcast() { return need(netOf()?.startVideoBroadcast?.bind(netOf()), 'video broadcast')(); },
    stop() { return need(netOf()?.stopVideoBroadcast?.bind(netOf()), 'video broadcast')(); },
    reattach() { return need(netOf()?.reattachHostVideo?.bind(netOf()), 'video broadcast')(); },
  };

  // -- room ----------------------------------------------------------------
  const room = {
    /** The room descriptor this peer built its world from. */
    descriptor() {
      const r = need(deps.roomDescriptor, 'the room descriptor')();
      return r ? { name: r.name ?? null, props: (r.props || []).length, raw: r } : null;
    },
    /** The HOST-published room layout (shared STATE key 'room'), or null. */
    published() { return session.objectState('room'); },
    /** The HOST-published game (shared STATE key 'tv'), or null. */
    tv() { return session.objectState('tv'); },
  };

  // -- dispatcher ----------------------------------------------------------
  // Which namespaces this client actually backs. Drives supports()/capabilities()
  // so a driver can adapt instead of sniffing clientKind (the VR and desktop
  // clients share the namespace but not every subsystem).
  const caps = {
    session: typeof deps.net === 'function',
    props: !!deps.props,
    input: typeof deps.gameInput === 'function',
    gun: !!deps.gun?.fire,
    mouse: !!deps.mouse?.move,
    content: !!deps.content,
    rack: typeof deps.rack === 'function',
    tv: typeof deps.tvs === 'function',
    video: typeof deps.net === 'function',
    room: true,
  };
  const api = {
    version: TEST_API_VERSION,
    clientKind: kind,
    session, props, input, gun, mouse, content, rack, tv, video, room,
    correlate,
    /** Resolves when the world is fully built and the API is safe to drive. */
    async ready({ timeoutMs = 90000 } = {}) {
      if (deps.ready) await Promise.race([
        deps.ready(),
        sleep(timeoutMs).then(() => fail('timeout', `world not built after ${timeoutMs}ms`)),
      ]);
      return true;
    },
    /** Every dotted path, for discovery + `supports()`. */
    methods() {
      const out = [];
      for (const [ns, obj] of Object.entries(api)) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'function' && !k.startsWith('_')) out.push(`${ns}.${k}`);
        }
      }
      return out.sort();
    },
    /**
     * Would `path` actually work on THIS client? Checks both that the method
     * exists and that the subsystem behind it was injected — so on the desktop
     * client `supports('props.list')` is false rather than "defined but throws".
     */
    supports(path) {
      if (typeof resolvePath(api, path) !== 'function') return false;
      const ns = String(path).split('.')[0];
      return caps[ns] !== false;
    },
    /** Per-namespace capability map, for a driver that adapts to the client. */
    capabilities() { return { ...caps }; },
    /** The legacy `window.__*` hooks this facade wraps — for migration only. */
    raw() { return deps.legacy || {}; },
    /**
     * THE calling convention for external drivers. Never rejects.
     * @returns {Promise<{ok:true,value:*}|{ok:false,error:{code,message,detail}}>}
     */
    async call(path, args = []) {
      const fn = resolvePath(api, path);
      if (typeof fn !== 'function') {
        return { ok: false, error: { code: 'no-such-method', message: `__testApi: no method "${path}"`, detail: null } };
      }
      try {
        const value = await fn(...(Array.isArray(args) ? args : [args]));
        return { ok: true, value: sanitise(value) };
      } catch (e) {
        return {
          ok: false,
          error: {
            code: e?.code || 'failed',
            message: String(e?.message ?? e),
            detail: sanitise(e?.detail ?? null),
          },
        };
      }
    },
  };
  return api;
}

function resolvePath(root, path) {
  if (typeof path !== 'string' || !path) return null;
  let cur = root;
  for (const part of path.split('.')) {
    if (cur == null) return null;
    cur = cur[part];
  }
  return cur;
}

/**
 * Make a return value survive structured cloning across page.evaluate. Drops
 * functions and anything cyclic/non-cloneable (THREE objects, DOM nodes) rather
 * than throwing an opaque "could not serialize" error from the driver.
 */
function sanitise(v, depth = 0, seen = new WeakSet()) {
  if (v == null) return v ?? null;
  const t = typeof v;
  if (t === 'number' || t === 'string' || t === 'boolean') return v;
  if (t === 'function' || t === 'symbol' || t === 'bigint') return undefined;
  if (depth > 6) return undefined;
  if (Array.isArray(v)) return v.map((x) => sanitise(x, depth + 1, seen)).filter((x) => x !== undefined);
  if (t === 'object') {
    if (seen.has(v)) return undefined;
    seen.add(v);
    // DOM nodes / THREE objects: report identity, not the graph.
    if (typeof v.nodeType === 'number') return { dom: v.tagName || 'node', id: v.id || null };
    if (v.isObject3D) return { object3D: v.name || v.type || 'Object3D' };
    const out = {};
    for (const k of Object.keys(v)) {
      const s = sanitise(v[k], depth + 1, seen);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined;
}
