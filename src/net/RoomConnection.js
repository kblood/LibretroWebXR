// RoomConnection — the TRANSPORT half of a room client: the socket, the COR-9
// protocol handshake, the reconnect backoff, and the host bookkeeping that
// rides on them. No presentation of its own, and — deliberately — no `three`.
//
// WHY THIS MODULE EXISTS (CODEX ARC-2 / CLAUDE_REVIEW §3.4). There are two room
// clients: [[src/net/NetMgr.js]] (VR — avatars, voice, per-frame pose sync) and
// [[src/desktop/DesktopNet.js]] (flat screen — DOM video, a heartbeat instead of
// poses). Until this module landed, each owned its OWN hand-written copy of the
// connection lifecycle: 23 of DesktopNet's 28 methods shared a name with one of
// NetMgr's 31, and `_checkServerProtocol` was byte-identical apart from a log
// prefix. That is not a theoretical cost — it is a measured one. The COR-9
// version gate and the fatal/no-retry rule had to be written twice, and one
// session later the entire soft-refusal retry path (RETRY_LATER_DELAYS_MS,
// `_retryLater`, `_noteSessionEstablished`) had to be written twice AGAIN;
// DesktopNet grew 405 → 479 lines doing it. A protocol rule that lands in only
// one copy is a rule that only works in one of the two builds, and no CI gate
// can see the gap: the logic tier bans `ws`, so nothing drives either socket
// lifecycle end to end. One copy, two owners, is the fix.
//
// THE `three` CONSTRAINT IS LOAD-BEARING. The flat-screen entry must never pull
// three into its chunk — scripts/check-dist.mjs enforces a 60 KB raw / 20 KB
// gzip budget on the `desktop` chunk precisely to catch that regression — so
// everything in here is pure protocol plus timers. Each owner keeps its own
// presentation half (NetMgr: AvatarMgr/VoiceMgr/three; DesktopNet: its DOM video
// wiring) and COMPOSES one of these.
//
// ONLY TWO THINGS LEGITIMATELY DIFFER between the two lifecycles, so only those
// are parameterised: the LOG PREFIX (`[net]` vs `[desktop-net]`) and a small set
// of owner teardown hooks (DesktopNet fires its `onDisconnect` callback from the
// close handler, where NetMgr fires nothing; NetMgr also drops avatars before a
// reconnect). Everything else is shared, and a protocol change edited here
// reaches both clients at once.
//
// LOG TEXT: four messages (the permanent-refusal error, the pre-COR-9 relay
// warning, the "no host announced" warning and the retry warning) were spelled
// with ASCII hyphens in DesktopNet and em-dashes in NetMgr. The em-dash form is
// kept for BOTH — deliberately, not by accident. Log strings are a grep surface,
// so that was checked before unifying rather than after: nothing in scripts/,
// server/ or docs/ matches on those four texts, the log-server stores lines
// opaquely, and the only assertion anywhere on this class's log output keys on
// the PREFIX (`[desktop-net]`) and on the substring "4010", both unchanged. If
// you add a probe that scrapes one of these lines, match the prefix and the
// numeric code, never the punctuation.

import {
  MSG, makeJoin, encode, decode,
  PROTOCOL_VERSION, judgeServerVersion, isPermanentClose,
} from './NetProtocol.js';
import { FALLBACK_HOST_KEY, normaliseClaim, resolveFallbackHost } from './HostElection.js';

// Client-side fallback host election (see [[src/net/HostElection.js]]): how long
// to wait after HELLO for a server-side election before electing among ourselves.
// Only ever used against a room server too OLD to know about host election.
//
// Only a pre-M1.4 room server (one that sends no `host` key in HELLO) ever
// reaches the deadline; against a current server the flag flips on the first
// HELLO and this never fires. Without it, deploying a page against an
// un-upgraded relay would leave hostId null forever - which the boot gate reads
// as "nobody may host", i.e. no game at all for anyone.
const FALLBACK_ELECT_MS = 1200;
// Auto-reconnect backoff after an UNEXPECTED socket close (Wi-Fi blip, room-server
// restart). The server remembers a departed host's sid for HOST_RECLAIM_MS, so a
// reconnect inside that window gets the host role — and the running game — back.
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
// The relay's "try again later" close (RFC 6455 1013). Spelled out here rather
// than imported from NetProtocol ON PURPOSE: NetProtocol owns the codes that are
// part of the client/server CONTRACT, and 1013 is deliberately not one of them —
// it must never join PERMANENT_CLOSE_CODES, because the whole point of it is that
// we come back. What it means to THIS class is only "pick the slower table", a
// client-local policy, so that is where it lives.
const TRY_AGAIN_CLOSE_CODE = 1013;
// Backoff for a relay that refused us on purpose (1013 + a reason: room full,
// address at its socket cap, relay at capacity). Deliberately an order of
// magnitude slower than the drop table above, and it is a SERVER-LOAD fix as much
// as a client one.
//
// A capacity refusal is soft — the relay accepts the upgrade and closes it, so
// 'open' fires — and the shipped clients used to reset `_reconnectTries` there.
// The backoff chain therefore never advanced past its first step and a refused
// client knocked at 2 Hz for the life of the page; two of them behind one NAT
// exhausted that address's whole upgrade budget and locked out the household,
// already-connected headsets included. Both halves are fixed: the counter now
// resets when a SESSION exists (the HELLO), not when a handshake completes, and a
// refusal picks this table. A full room polled at 5-30 s costs the relay ~2
// upgrades a minute per device instead of 120.
//
// What that costs the user, stated honestly rather than as "within seconds":
// ~10-30 s after a seat actually opens, in the case this table exists for. A
// household that drops off Wi-Fi without a clean close leaves ghost sockets the
// relay only reaps a heartbeat sweep after the ping they missed, so the seats
// free at ~18-20 s; each device's first retry is on the FAST table (a blip is a
// 1006), is refused 1013 because the ghosts still hold both the address slots and
// the room seats, and from there this table applies — the 10 s attempt is still
// too early and the room reassembles on the 20 s one. A peer that leaves CLEANLY
// frees its seat at once, so there the next scheduled attempt is the whole wait.
// This is also why the refusal reason has to reach the UI (src/main.js): during
// that gap the only honest thing to show is what the relay said and when we will
// ask again.
const RETRY_LATER_DELAYS_MS = [5000, 10000, 20000, 30000, 30000];

function defaultServerUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/`;
}

export class RoomConnection {
  /**
   * @param {object}   o
   * @param {string}   o.logPrefix       '[net]' or '[desktop-net]' — the ONE
   *                                     cosmetic difference between the two
   *                                     lifecycles, so it is a parameter rather
   *                                     than a reason to keep two copies.
   * @param {function} o.presence        () => PresenceState  (thunk: the owner
   *                                     builds it, possibly after us)
   * @param {function} o.objects         () => RoomObjects
   * @param {function} o.setObjectState  (key, value) => void — how a fallback
   *                                     claim reaches the room's shared state
   * @param {function} o.isHost          () => boolean — for the onHostChange payload
   * @param {function} o.reopen          () => void — the owner's connect()
   * @param {function} [o.onMessage]     (msg) => void — a decoded, protocol-checked
   *                                     message; the owner routes it
   * @param {function} [o.onSocketClosed] () => void — runs first in the close
   *                                     handler (both owners stop their capture)
   * @param {function} [o.onFatalTeardown] () => void — extra teardown on a
   *                                     PERMANENT refusal. DesktopNet fires its
   *                                     `onDisconnect` here; NetMgr has none.
   * @param {function} [o.onClosed]      () => void — tail of a NON-permanent close
   * @param {function} [o.onBeforeReopen] () => void — the owner's local teardown
   *                                     just before the backoff re-opens
   */
  constructor({
    room, nick, color, serverUrl, sessionId,
    logPrefix = '[net]',
    onHostChange = null,
    onFatal = null,
    onRetry = null,
    presence = () => null,
    objects = () => null,
    setObjectState = () => false,
    isHost = () => false,
    reopen = () => {},
    onMessage = null,
    onSocketClosed = null,
    onFatalTeardown = null,
    onClosed = null,
    onBeforeReopen = null,
  } = {}) {
    this.room = room || 'lobby';
    this.nick = nick || 'Player';
    this.color = color || '#88aaff';
    this.serverUrl = serverUrl || defaultServerUrl();
    this.sessionId = sessionId;
    this._log = logPrefix;
    this._presence = presence;
    this._objects = objects;
    this._setObjectState = setObjectState;
    this._isHost = isHost;
    this._reopen = reopen;
    this._onMessage = onMessage;
    this._onSocketClosed = onSocketClosed;
    this._onFatalTeardown = onFatalTeardown;
    this._onClosed = onClosed;
    this._onBeforeReopen = onBeforeReopen;

    // M1.4 host election: the room's host is decided by the SERVER (longest-present
    // peer, re-elected only when the host disconnects) and delivered in HELLO
    // (`host`) plus any later MSG.HOST. It is NOT derived from who last wrote the
    // shared `tv` state — that old rule made the role flip on every cartridge
    // insert and could elect a peer that doesn't even have the ROM.
    this._hostId = null;
    this._onHostChange = onHostChange;
    // True once the SERVER has spoken about the host (a `host` key in HELLO or any
    // MSG.HOST). While false we may be talking to a pre-M1.4 relay, in which case
    // the peers elect among themselves — see _runFallbackElection().
    this._serverElects = false;
    this._fallbackClaims = new Map();   // peerId -> { id, at } claim
    this._fallbackTimer = null;
    // Our seniority timestamp for the fallback election, re-stamped on every
    // 'open'. Initialised HERE (DesktopNet did; NetMgr left it undefined until
    // the first 'open') because an UNSET one is not merely missing — see
    // _runFallbackElection: normaliseClaim turns `at: undefined` into `at: 0`,
    // the earliest timestamp there is, so a peer would claim infinite seniority
    // and win the room over genuinely older peers. Keeping the eager init means
    // the two merged clients cannot differ on that, whatever a future path does.
    this._joinedAt = Date.now();

    this.ws = null;
    this._connected = false;
    // Auto-reconnect bookkeeping (an unexpected close, not disconnect()).
    // `_closing` distinguishes OUR disconnect() from a dropped socket, which must
    // not be silent (the role has to be given up).
    this._closing = false;
    this._reconnectTries = 0;
    this._reconnectTimer = null;
    // Sticky "the relay is refusing us, not dropping us": set by a 1013 close and
    // cleared only once a session exists. Sticky because the relay's SECOND-tier
    // refusal (an address over its soft-refusal budget) kills the upgrade
    // outright, which in a browser is a bare 1006 — indistinguishable from a
    // Wi-Fi blip. Without this flag a client that had just been told 1013 would
    // drop straight back to the fast table on the next attempt and hammer the
    // exact relay that asked it not to.
    this._retryLater = false;
    // COR-9 protocol handshake. `_fatal` is set once, and once it is set this
    // connection is DONE: the pair is incompatible, so retrying the same build can
    // only produce the same refusal. `onFatal({code, reason})` is the app's hook
    // for saying so in the UI instead of leaving the user in a room that never
    // fills; it fires exactly once, from _noteFatal, and only for a PERMANENT
    // close (a 1006 blip does not invoke it). Asserted in scripts/test-net.mjs,
    // case 3c of the "Client reconnect gate" section, against the real classes,
    // and in scripts/test-room-connection.mjs against this one.
    this._fatal = null;
    this._onFatal = onFatal;
    // The TRANSIENT counterpart of `_fatal`: why we are currently offline and
    // when we will try again. `onFatal` covers "never coming back"; this covers
    // the far commoner "not right now" — a relay restart, a Wi-Fi blip, or an
    // admission cap saying come back in a moment (the room server closes those
    // with 1013 + a reason rather than killing the upgrade, precisely so the
    // reason arrives). Written on every scheduled retry, and handed to `onRetry`
    // if the app supplied one — src/main.js does, and mpOfflineStatus() there
    // paints BOTH the header widget and the in-VR panel from this object rather
    // than latching the callback's copy, precisely because _noteSessionEstablished
    // clears it and the line then has to go away by itself. Without it a
    // first-connect failure is indistinguishable from an idle client that was
    // never asked to connect. A flat-screen host that wants the same status line
    // reads it the same way.
    this.lastClose = null;       // { code, reason, attempt, delayMs } | null
    this._onRetry = onRetry;
    this.serverVersion = null;   // what the room server said in HELLO (null = pre-COR-9)
  }

  // --- identity / roles ------------------------------------------------------

  // The room's authoritative host (M1.4): the peer that has been in the room
  // longest, as elected by the server. Stable — it changes ONLY when the current
  // host disconnects (then the longest-present remaining peer takes over), never
  // as a side effect of an in-room action. null until HELLO arrives.
  hostId() { return this._hostId; }

  // Record a server-announced host and notify the app when it actually changed.
  // Fired from HELLO (`host`), MSG.HOST (migration / reclaim), the fallback
  // election, and the socket `close` handler (which demotes us: a peer with no
  // socket is not the room's authority any more, whatever it used to be).
  //
  // `silent` suppresses the app callback — used by the DELIBERATE disconnect()
  // teardown, where main.js has already reverted the screen and resumed the local
  // core: firing a demotion there would immediately re-pause the game the user
  // just went back to playing solo (and could bounce them into a room-adoption
  // reload of the room they asked to leave). On the flat-screen side the same
  // flag stops a demotion callback running against a half-dismantled session.
  _setHost(id, { silent = false } = {}) {
    const next = id == null ? null : String(id);
    if (next === this._hostId) return false;
    const prev = this._hostId;
    this._hostId = next;
    if (this._onHostChange && !silent) {
      try { this._onHostChange({ hostId: next, prevHostId: prev, isHost: this._isHost(), connected: this._connected }); }
      catch (e) { console.warn(`${this._log} onHostChange`, e); }
    }
    return true;
  }

  // --- COR-9 protocol compatibility ----------------------------------------
  //
  // The DECISION is not made here: NetProtocol.judgeServerVersion / isPermanentClose
  // own it (see [[src/net/NetProtocol.js]]). What lives here are the SIDE EFFECTS,
  // which used to be the part each client wrote for itself.

  /**
   * Record a permanent, non-retryable refusal and surface it. Sets `_closing` so
   * every later path (the close handler, _scheduleReconnect) treats this session
   * as finished — the same flag a deliberate disconnect() uses, because from the
   * reconnect logic's point of view "we are never coming back" is the same state.
   * That `_closing = true` is NOT decoration: removing it turns
   * "a permanent refusal also marks the session closed" red in test-net.mjs.
   * Idempotent (the `_fatal` early return), so `onFatal` reaches the app once
   * however many later paths note the same refusal, and a throwing app callback
   * is contained rather than allowed to abort the close handler.
   */
  _noteFatal({ code, reason }) {
    if (this._fatal) return;
    this._fatal = { code: Number(code), reason: String(reason || '') };
    this._closing = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    console.error(`${this._log} room server refused this build permanently (${this._fatal.code}): ${this._fatal.reason} — not reconnecting (client protocol ${PROTOCOL_VERSION}, server ${this.serverVersion ?? 'unknown'})`);
    if (this._onFatal) {
      try { this._onFatal(this._fatal); } catch (e) { console.warn(`${this._log} onFatal`, e); }
    }
  }

  /**
   * Judge the room server's HELLO version (COR-9). Returns true when it is safe
   * to go on processing this message.
   *
   * A server with NO version is a pre-COR-9 relay and is ACCEPTED — the deployed
   * one was exactly that until this landed, and refusing it would mean an app
   * deploy could not precede a server deploy. An incompatible MAJOR (or a `v` of
   * any junk shape) closes the socket from OUR side with the same 4010 the server
   * would have used, so the two directions of the same failure read identically
   * in a log.
   */
  _checkServerProtocol(v) {
    const verdict = judgeServerVersion(v);
    this.serverVersion = verdict.serverVersion;
    if (verdict.action === 'accept') return true;
    if (verdict.action === 'accept-legacy') {
      if (!this._legacyServerLogged) {
        this._legacyServerLogged = true;
        console.warn(`${this._log} room server announced no protocol version — pre-COR-9 relay, continuing (client speaks ${PROTOCOL_VERSION})`);
      }
      return true;
    }
    this._noteFatal({ code: verdict.code, reason: verdict.reason });
    try { this.ws?.close(verdict.code, verdict.reason); } catch { /* already closing */ }
    return false;
  }

  // --- M1.4 fallback election (pre-M1.4 room server) ------------------------
  // The EARLIEST claim by a still-present peer wins (ties broken by id), which
  // reproduces the server's seniority rule. Claims ride the persisted STATE
  // channel so they're replayed to late joiners.

  // Remember a peer's fallback claim (ours or a relayed one) and re-resolve.
  _noteFallbackClaim(raw) {
    const c = normaliseClaim(raw);
    if (!c) return;
    const prev = this._fallbackClaims.get(c.id);
    // Keep the EARLIEST claim per peer: a re-announcement must not make a peer
    // look younger than it is (that would reshuffle seniority).
    if (!prev || c.at < prev.at) this._fallbackClaims.set(c.id, c);
    if (!this._serverElects) this._runFallbackElection();
  }

  // Elect a host among the peers themselves, for a room server too old to do it.
  // No-op the moment the server has spoken (_serverElects).
  _runFallbackElection() {
    if (this._serverElects || !this._connected) return;
    const selfId = this._presence()?.selfId;
    if (!selfId) return;
    if (!this._fallbackClaims.has(selfId)) {
      // Our own claim timestamp is when WE joined — the seniority signal.
      //
      // The `?? Date.now()` is NetMgr's (DesktopNet passed a bare `_joinedAt`),
      // and the merge keeps it as a BELT alongside the constructor's braces. The
      // two forms are not equivalent when `_joinedAt` is unset: a bare undefined
      // becomes `at: 0` through normaliseClaim, which beats every real claim and
      // makes this peer host forever — and the claim is published on the STATE
      // channel, so late joiners inherit the wrong winner. `?? Date.now()` lets
      // us lose an election we should lose. Unreachable in both clients (the
      // guard above needs `_connected`, and 'open' stamps `_joinedAt` in the same
      // turn it sets that), so this changes nothing today; it resolves the merge
      // toward the form that fails safe. Pinned in scripts/test-net.mjs,
      // "RoomConnection merge invariants".
      this._fallbackClaims.set(selfId, { id: selfId, at: this._joinedAt ?? Date.now() });
    }
    const stored = this._objects().get(FALLBACK_HOST_KEY);
    this._noteStoredClaim(stored);
    const { hostId, announce } = resolveFallbackHost({
      claims: [...this._fallbackClaims.values()],
      presentIds: [selfId, ...this._presence().peers().map((p) => p.id)],
      selfId,
      now: this._joinedAt ?? Date.now(),
      stored,
    });
    if (announce) this._setObjectState(FALLBACK_HOST_KEY, announce);
    this._setHost(hostId);
  }

  // A claim relayed through the shared STATE (also replayed to late joiners).
  // DesktopNet spelled this `_noteFallbackClaimQuiet`; same body, same reason —
  // it must NOT re-enter the election the way _noteFallbackClaim does.
  _noteStoredClaim(stored) {
    const c = normaliseClaim(stored);
    if (!c) return;
    const prev = this._fallbackClaims.get(c.id);
    if (!prev || c.at < prev.at) this._fallbackClaims.set(c.id, c);
  }

  // Arm the deadline after which, if the server still hasn't named a host, we
  // elect among ourselves. Idempotent.
  _armFallbackElection() {
    if (this._serverElects || this._fallbackTimer) return;
    this._fallbackTimer = setTimeout(() => {
      this._fallbackTimer = null;
      if (this._serverElects || this._hostId) return;
      console.warn(`${this._log} no host announced by the room server — electing among peers (legacy server?)`);
      this._runFallbackElection();
    }, FALLBACK_ELECT_MS);
  }

  _clearFallbackTimer() {
    if (this._fallbackTimer) { clearTimeout(this._fallbackTimer); this._fallbackTimer = null; }
  }

  // --- socket lifecycle ------------------------------------------------------

  /**
   * Open the socket and wire the four listeners. The owner supplies only what is
   * genuinely its own (how to route a message, what to tear down), which is why
   * this can be shared at all.
   */
  open() {
    const sep = this.serverUrl.includes('?') ? '&' : '?';
    // sid rides the connect URL (not the later JOIN) because the server has to
    // decide the host BEFORE it sends HELLO. See server/Hub.js connect().
    const url = `${this.serverUrl}${sep}room=${encodeURIComponent(this.room)}&sid=${encodeURIComponent(this.sessionId)}`;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { console.warn(`${this._log} connect failed`, e); return false; }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this._connected = true;
      // NetMgr's open handler cleared `_closing`; DesktopNet's did not. That is a
      // copy-paste gap, not a design difference, and the merge takes NetMgr's
      // form deliberately rather than parameterising it — there is no behaviour
      // on the desktop side to preserve. Every path that latches `_closing` also
      // closes the socket in the same turn (beginDisconnect → closeSocket;
      // _noteFatal → ws.close(); the close handler), and per the WebSocket spec a
      // close() during CONNECTING FAILS the connection without ever firing
      // 'open'. So this line is unreachable in both clients as they stand. What
      // it buys is that if a future path ever latches `_closing` WITHOUT closing
      // the socket, the two clients cannot disagree about what happens next. It
      // cannot resurrect a refused session either: `_fatal` outlives it and is
      // checked independently in _scheduleReconnect.
      this._closing = false;
      // NOT `_reconnectTries = 0` — see _noteSessionEstablished(). An 'open' is
      // now also what a soft capacity refusal looks like, one close frame before
      // it arrives.
      this._joinedAt = Date.now();
      ws.send(encode(makeJoin({ nick: this.nick, color: this.color })));
      console.log(`${this._log} connected to "${this.room}" as ${this.nick}`);
    });
    ws.addEventListener('message', (e) => {
      const msg = decode(typeof e.data === 'string' ? e.data : '');
      if (!msg) return;
      // COR-9: the server states its protocol version in HELLO. An OLD SERVER
      // talking to a NEW app is the half the server-side JOIN check cannot catch
      // (it doesn't know the field exists), so the client judges it here — before
      // acting on the roster, because an incompatible HELLO's contents are
      // exactly what we must not trust. This direction of the skew is only ever
      // caught here.
      if (msg.type === MSG.HELLO && !this._checkServerProtocol(msg.v)) return;
      // A compatible HELLO is the first proof we have a SESSION and not merely a
      // socket — which is what the backoff must key on. See below.
      if (msg.type === MSG.HELLO) this._noteSessionEstablished();
      if (this._onMessage) this._onMessage(msg);
    });
    // An UNEXPECTED close (Wi-Fi blip, server restart, proxy timeout): we are no
    // longer the room's authority — the server has our sid in its reclaim window
    // and will migrate the role if we don't come back. Demote ourselves so we
    // can't keep running + publishing as a second host (the exact "two
    // simultaneous hosts" bug), then try to reconnect and reclaim. Our own
    // disconnect() sets _closing and skips the reconnect half of this.
    ws.addEventListener('close', (ev) => {
      this._connected = false;
      // CONNECTION LOST (or our own close, already announced above): the socket
      // is gone, so a 'bye' cannot reach anyone — tear the capture down locally
      // and don't pretend to announce it.
      if (this._onSocketClosed) this._onSocketClosed();
      // COR-9: a PERMANENT refusal (4010 — the server rejected our protocol
      // major) must break the backoff chain. Every other close is retried, which
      // is right for a Wi-Fi blip or a server restart (1001) but is a silent
      // infinite loop against a server that will refuse this build every time.
      if (isPermanentClose(ev?.code)) {
        this._noteFatal({ code: ev.code, reason: String(ev.reason || 'incompatible protocol') });
        this._setHost(null);
        if (this._onFatalTeardown) this._onFatalTeardown();
        return;
      }
      // EVERY non-permanent close is retried, INCLUDING one on the very first
      // connect. The gate here used to be `wasConnected || this._reconnectTries`,
      // and on a fresh client's first connect both are falsy — so a relay that
      // was momentarily unreachable, or that refused the upgrade outright (its
      // admission caps used to answer 503/429 at the handshake), left the widget
      // on "Offline" for the rest of the page's life with no reason shown and
      // nothing retrying behind it. That is the same dead end COR-9 fixed for
      // 4010, reached from the other direction. `_fatal` — checked just above and
      // again inside _scheduleReconnect — is what stops a hopeless retry loop;
      // "we have not managed to connect yet" never was a reason to give up.
      if (!this._closing) {
        this._setHost(null);
        this._scheduleReconnect({ code: ev?.code, reason: ev?.reason });
      }
      if (this._onClosed) this._onClosed();
    });
    ws.addEventListener('error', () => { /* close follows */ });
    return true;
  }

  /**
   * A SESSION exists: the relay answered our JOIN with a HELLO, so we have a peer
   * id, a roster and (in a moment) the room's replayed state.
   *
   * This is where the reconnect backoff resets, and the distinction is not
   * academic. It used to reset in the socket's 'open' handler, which was correct
   * when the only way to get an 'open' was to be admitted — and stopped being
   * correct the moment the relay started refusing capacity SOFTLY (accept the
   * upgrade, then close 1013 + a reason, so a deployed client retries at all).
   * A refusal now MAKES 'open' fire, so resetting there meant every refusal reset
   * the backoff: 500 ms, open, refused, 500 ms, forever. 'open' means "the
   * handshake completed"; only a HELLO means "we are in".
   *
   * `lastClose` is cleared for the same reason — it is the TRANSIENT "why are we
   * offline right now", and we are not.
   */
  _noteSessionEstablished() {
    this._reconnectTries = 0;
    this._retryLater = false;
    this.lastClose = null;
  }

  // Re-open the socket with backoff after an unexpected close. Presence/avatars
  // are cleared first (the server assigns a NEW peer id on reconnect, so the old
  // roster and the old fallback claims are meaningless); the shared object state
  // is replayed by the server. What exactly "cleared" means is the owner's
  // (onBeforeReopen) — the VR client also drops its avatars.
  _scheduleReconnect(why = null) {
    // `_fatal` is checked here as well as in the close handler on purpose: this
    // is the only place that re-opens a socket, so the "never retry a permanent
    // refusal" rule holds even if some future caller reaches it another way.
    if (this._closing || this._fatal || this._reconnectTimer) return;
    // A close code of 0 means the socket never opened at all, which is not a code
    // worth showing, so it is normalised to null rather than printed as "(0)".
    const code = Number(why?.code ?? 0) || null;
    // 1013 = "we are busy, come back later", not "the network broke". Retrying it
    // on the 500 ms table is what turns one refused client into a 2 Hz flood.
    if (code === TRY_AGAIN_CLOSE_CODE) this._retryLater = true;
    const table = this._retryLater ? RETRY_LATER_DELAYS_MS : RECONNECT_DELAYS_MS;
    const delay = table[Math.min(this._reconnectTries, table.length - 1)];
    this._reconnectTries++;
    // Record and announce WHY before arming the timer.
    this.lastClose = {
      code,
      reason: String(why?.reason || ''),
      attempt: this._reconnectTries,
      delayMs: delay,
    };
    const { reason } = this.lastClose;
    console.warn(`${this._log} disconnected from "${this.room}"${code ? ` (${code}${reason ? `: ${reason}` : ''})` : ''} — retrying in ${delay}ms (attempt ${this._reconnectTries})`);
    if (this._onRetry) {
      try { this._onRetry({ ...this.lastClose }); } catch (e) { console.warn(`${this._log} onRetry`, e); }
    }
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._closing) return;
      console.log(`${this._log} reconnecting to "${this.room}" (attempt ${this._reconnectTries})`);
      // The old socket is genuinely gone here (this path only runs after an
      // UNEXPECTED close), so the local teardown must still happen but the byes
      // cannot be sent — that is correct, not a regression. Each owner says so
      // explicitly (`announce:false`) instead of leaning on the send gate.
      if (this._onBeforeReopen) this._onBeforeReopen();
      // AFTER the owner's teardown, not before — this is the order BOTH merged
      // copies had (NetMgr: avatars.removeAll → presence.clear → claims.clear;
      // DesktopNet: presence.clear → claims.clear), and the merge briefly
      // inverted it. Nothing reads the claims from inside the hook today, so the
      // inversion was invisible; the point of pinning it is that the hook is the
      // extension point, so the next thing added to it must see the same state
      // HEAD's teardown did. (video.disable() is the one step that ran AFTER the
      // clear in both copies and now runs before it — it lives in another module
      // and cannot reach this map, so that half carries no behaviour.)
      // Asserted in scripts/test-net.mjs, "RoomConnection merge invariants".
      this._fallbackClaims.clear();
      this._reopen();
    }, delay);
  }

  /**
   * First half of a DELIBERATE disconnect(): suppress the reconnect chain and the
   * pending fallback election. Split from closeSocket() because everything whose
   * teardown has to REACH the other peers must run BETWEEN the two — see the note
   * in each owner's disconnect().
   */
  beginDisconnect() {
    this._closing = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._clearFallbackTimer();
  }

  /**
   * Second half: close the socket and give up the role. `silent` on _setHost is
   * deliberate — the app has already reverted the screen and resumed its local
   * core, so firing a demotion here would re-pause the game the user just went
   * back to playing solo.
   */
  closeSocket() {
    try { this.ws?.close(); } catch { /* already closing */ }
    this._connected = false;
    this._setHost(null, { silent: true });
    this._serverElects = false;
    this._fallbackClaims.clear();
  }
}

export { RECONNECT_DELAYS_MS, RETRY_LATER_DELAYS_MS, TRY_AGAIN_CLOSE_CODE, FALLBACK_ELECT_MS };
