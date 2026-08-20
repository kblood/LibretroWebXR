// DesktopNet — the multiplayer layer for the FLAT-SCREEN desktop build. It is a
// slimmed-down sibling of [[src/net/NetMgr.js]]: same room server, same wire
// protocol, same host-authoritative netplay + host→client video, but with the
// VR-only parts removed (no avatars, no per-frame head/hand pose sync, no
// three.js). The VR NetMgr can't be reused directly because it imports three and
// samples scene transforms every frame; everything ELSE it relies on is pure and
// is reused here verbatim: PresenceState, RoomObjects, VideoMgr, NetProtocol —
// and, since CODEX ARC-2 was closed, the whole connection lifecycle itself
// ([[src/net/RoomConnection.js]], composed below as `this._conn`).
//
// Netplay model (unchanged from the VR build, see [[src/net/VideoMgr.js]]):
//   • The HOST is elected by the SERVER (M1.4): the peer that has been in the
//     room longest, re-elected only when it disconnects. It runs the one
//     authoritative core and streams its canvas to peers.
//   • A non-host CLIENT never boots a core of its own: it shows the host's video
//     and forwards its controls to the host as player 2 (MSG.INPUT, routed by
//     NetProtocol.hostInputTarget).
//
// Liveness: we don't send VR poses, so peers would otherwise be pruned after the
// presence TTL. Instead we send a tiny empty POSE as a heartbeat (~every 2s); the
// server relays it and PresenceState.applyPose refreshes lastSeen. Clean and dead
// disconnects both still produce a LEAVE (the server terminates silent sockets).

import { PresenceState } from '../net/PresenceState.js';
import { RoomObjects } from '../net/RoomObjects.js';
import { VideoMgr } from '../net/VideoMgr.js';
import {
  MSG, makePose, makeState, makeSignal, makeInput,
  hostInputTarget, encode,
  PROTOCOL_VERSION,
} from '../net/NetProtocol.js';
import { stableSessionId } from '../net/SessionUtils.js';
import { FALLBACK_HOST_KEY } from '../net/HostElection.js';
import { RoomConnection } from '../net/RoomConnection.js';

// The socket, the COR-9 handshake, the reconnect/soft-refusal backoff and the
// M1.4 host election are NOT written here any more: they live in
// [[src/net/RoomConnection.js]], which this class COMPOSES (`this._conn`) and
// NetMgr composes too. That is CODEX ARC-2 closed — before it, this file held a
// second hand-written copy of all of it, and the COR-9 gate, the fatal/no-retry
// rule and the whole soft-refusal retry path each had to be implemented twice
// (this file grew 405 → 479 lines doing exactly that). RoomConnection imports no
// `three`, so composing it keeps the flat-screen chunk inside the budget
// scripts/check-dist.mjs enforces on it. What is left below is this build's
// PRESENTATION half: the DOM video wiring, the roster callback, the heartbeat.
const HEARTBEAT_MS = 2000;

export class DesktopNet {
  constructor({
    room, nick, color, serverUrl,
    getCaptureCanvas,
    getCaptureAudio = null,  // () => MediaStream|null - the host's game AUDIO tap
    onTvState = null,        // (value, ownerId) => void  — room's loaded game changed
    onGameInput = null,      // ({from,player,btn,down}) => void — host receives remote input
    onRoster = null,         // (peers[]) => void — roster changed (count/names)
    onHostVideo = null,      // (videoEl, hostId) => void — client got host's stream
    onHostVideoEnded = null, // (hostId) => void — stream ended; revert
    onConnect = null,        // (selfId) => void
    onDisconnect = null,     // () => void
    onHostChange = null,     // ({hostId,prevHostId,isHost}) => void — M1.4 election
    onFatal = null,          // ({code,reason}) => void — permanent refusal (COR-9 4010)
    onRetry = null,          // ({code,reason,attempt,delayMs}) => void — TRANSIENT drop, retrying
    iceServers = null,
    sessionId = null,
    now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  } = {}) {
    this._now = now;
    const sid = sessionId || stableSessionId();
    // THE TRANSPORT HALF (CODEX ARC-2, [[src/net/RoomConnection.js]]): the socket,
    // the COR-9 handshake, both backoff tables, `_retryLater`, `lastClose` and the
    // M1.4 host election — including the pre-M1.4 peer-side fallback — now have
    // exactly ONE implementation, shared with NetMgr. The delegating accessors
    // below keep every field name this class exposed (`_connected`, `_fatal`,
    // `_reconnectTimer`, `lastClose`, `serverVersion`, `room`, …) working
    // byte-for-byte, because src/desktop/main.js and scripts/test-net.mjs read
    // and in places WRITE them.
    //
    // The hooks are the only genuinely flat-screen parts of the lifecycle: where a
    // message goes, and the `onDisconnect` callback this class fires from its
    // close handler (NetMgr fires nothing there — that is the one asymmetry, so
    // it is a hook rather than a reason to keep two lifecycles).
    this._conn = new RoomConnection({
      room, nick, color, serverUrl, sessionId: sid,
      logPrefix: '[desktop-net]',
      onHostChange, onFatal, onRetry,
      presence: () => this.presence,
      objects: () => this.objects,
      setObjectState: (key, value) => this.setObjectState(key, value),
      isHost: () => this.isHost(),
      reopen: () => this.connect(),
      onMessage: (msg) => this._route(msg),
      // The socket is gone: tear the capture down locally, but don't pretend to
      // announce a 'bye' that could not possibly be delivered.
      onSocketClosed: () => { this.video.stopBroadcast({ announce: false }); },
      onFatalTeardown: () => { if (this._onDisconnect) { try { this._onDisconnect(); } catch (_) {} } },
      onClosed: () => { if (this._onDisconnect) { try { this._onDisconnect(); } catch (_) {} } },
      onBeforeReopen: () => {
        // The server assigns a NEW peer id on reconnect, so the old roster and the
        // old fallback claims are meaningless. Shared object state is replayed.
        this.presence.clear();
        // Connection genuinely lost (this path only runs after an UNEXPECTED
        // close): teardown yes, byes no — they could never reach a peer.
        this.video.disable({ announce: false });
      },
    });

    this.presence = new PresenceState({ ttlMs: 5000 });
    this.objects = new RoomObjects();
    this._onTvState = onTvState;
    this._onGameInput = onGameInput;
    this._onRoster = onRoster;
    this._onConnect = onConnect;
    this._onDisconnect = onDisconnect;

    // `ws`, `_connected`, `_closing`, the reconnect counters, `_retryLater`,
    // `_fatal`, `lastClose`, `serverVersion` and the M1.4 election bookkeeping are
    // all initialised by the RoomConnection above — one copy, shared with NetMgr.
    this._hbAcc = 0;
    this._lastRosterSig = '';
    this._recvInputs = []; // small ring of inputs we received as host (debug)

    this.video = new VideoMgr({
      getSelfId: () => this.presence.selfId,
      getCaptureCanvas: () => (typeof getCaptureCanvas === 'function' ? getCaptureCanvas() : getCaptureCanvas),
      // canvas.captureStream() is video-only, so without this the peer watched the
      // host's game in silence.
      getCaptureAudio: () => (typeof getCaptureAudio === 'function' ? getCaptureAudio() : getCaptureAudio),
      iceServers: iceServers ?? undefined,
      onHostVideo,
      onHostVideoEnded,
      send: ({ to, kind, data }) => {
        if (this._connected && this.ws) {
          try { this.ws.send(encode(makeSignal({ to, kind, data, channel: 'video' }))); } catch { /* mid-close */ }
        }
      },
    });
  }

  // --- identity / roles ------------------------------------------------------

  get selfId() { return this.presence.selfId; }
  get connected() { return this._connected; }
  // M1.4: the room's server-elected host (longest-present peer). Stable — it does
  // NOT follow the shared `tv` state any more.
  hostId() { return this._hostId; }
  isHost() {
    const self = this.presence.selfId;
    return !!self && self === this._hostId;
  }

  // --- transport state, delegated to the composed RoomConnection -------------
  //
  // Accessors, not a rename. The socket state moved into
  // [[src/net/RoomConnection.js]] so this class and NetMgr share ONE copy of it
  // (CODEX ARC-2), but the field NAMES are load-bearing: scripts/test-net.mjs
  // drives BOTH classes through the identical case table and reads — in two
  // cases WRITES — `_fatal`, `_reconnectTimer`, `_reconnectTries`, `_closing`,
  // `lastClose` and `serverVersion` as plain properties. Getter+setter pairs keep
  // all of that working byte-for-byte with only one copy of the value.
  get room() { return this._conn.room; }
  set room(v) { this._conn.room = v; }
  get nick() { return this._conn.nick; }
  set nick(v) { this._conn.nick = v; }
  get color() { return this._conn.color; }
  set color(v) { this._conn.color = v; }
  get serverUrl() { return this._conn.serverUrl; }
  set serverUrl(v) { this._conn.serverUrl = v; }
  get sessionId() { return this._conn.sessionId; }
  set sessionId(v) { this._conn.sessionId = v; }
  get ws() { return this._conn.ws; }
  set ws(v) { this._conn.ws = v; }
  get lastClose() { return this._conn.lastClose; }
  set lastClose(v) { this._conn.lastClose = v; }
  get serverVersion() { return this._conn.serverVersion; }
  set serverVersion(v) { this._conn.serverVersion = v; }
  get _connected() { return this._conn._connected; }
  set _connected(v) { this._conn._connected = v; }
  get _closing() { return this._conn._closing; }
  set _closing(v) { this._conn._closing = v; }
  get _reconnectTries() { return this._conn._reconnectTries; }
  set _reconnectTries(v) { this._conn._reconnectTries = v; }
  get _reconnectTimer() { return this._conn._reconnectTimer; }
  set _reconnectTimer(v) { this._conn._reconnectTimer = v; }
  get _retryLater() { return this._conn._retryLater; }
  set _retryLater(v) { this._conn._retryLater = v; }
  get _fatal() { return this._conn._fatal; }
  set _fatal(v) { this._conn._fatal = v; }
  get _hostId() { return this._conn._hostId; }
  set _hostId(v) { this._conn._hostId = v; }
  get _serverElects() { return this._conn._serverElects; }
  set _serverElects(v) { this._conn._serverElects = v; }
  get _fallbackClaims() { return this._conn._fallbackClaims; }

  // …and the methods, for the same reason. `_setHost`, the fallback election and
  // the COR-9 pair used to be written out in full here AND in NetMgr; each is now
  // one line to the shared implementation, which carries the long "why" notes.
  _setHost(id, opts) { return this._conn._setHost(id, opts); }
  _noteFatal(f) { return this._conn._noteFatal(f); }
  _checkServerProtocol(v) { return this._conn._checkServerProtocol(v); }
  _noteSessionEstablished() { return this._conn._noteSessionEstablished(); }
  _scheduleReconnect(why = null) { return this._conn._scheduleReconnect(why); }
  _noteFallbackClaim(raw) { return this._conn._noteFallbackClaim(raw); }
  _runFallbackElection() { return this._conn._runFallbackElection(); }
  _armFallbackElection() { return this._conn._armFallbackElection(); }
  _clearFallbackTimer() { return this._conn._clearFallbackTimer(); }

  peerCount() { return this.presence.size; }
  peers() { return this.presence.peers(); }

  // --- room-object (tv) state -----------------------------------------------

  // Broadcast the loaded game so peers converge (and we become the host/owner).
  // Mirrors NetMgr.setObjectState: update locally first, then send; no-op if
  // unchanged. A null value clears it (nobody hosting).
  setObjectState(key, value = null) {
    const cur = this.objects.get(key);
    if (JSON.stringify(cur) === JSON.stringify(value ?? null)) return false;
    this.objects.apply(makeState({ key, value, id: this.presence.selfId }));
    if (this._connected && this.ws) {
      try { this.ws.send(encode(makeState({ key, value }))); } catch { /* mid-close */ }
    }
    return true;
  }
  getObjectState(key) { return this.objects.get(key); }

  _applyState(msg) {
    const r = this.objects.apply(msg);
    if (!r) return;
    // Fallback-election claims are protocol plumbing, never app state.
    if (msg.key === FALLBACK_HOST_KEY) { this._noteFallbackClaim(r.value); return; }
    if (r.changed && msg.key === 'tv' && this._onTvState) {
      try { this._onTvState(r.value, r.id); } catch (e) { console.warn('[desktop-net] onTvState', e); }
    }
  }

  // --- host video ------------------------------------------------------------

  startVideoBroadcast() { return this.video.startBroadcast(); }
  stopVideoBroadcast() { this.video.stopBroadcast(); }
  // Re-hand the live host <video> to the app (after a local DOM change detached it,
  // e.g. showCanvas() during a transient role flip).
  reattachHostVideo() { return this.video.reattach(); }
  hostVideoEl() { return this.video.hostVideoEl(); }

  // --- game input relay ------------------------------------------------------

  // Client → host: forward one logical RetroPad transition. No-op when we're the
  // host or no game is loaded (hostInputTarget returns null).
  forwardGameInput({ player, btn, down }) {
    const to = hostInputTarget({ hostId: this._hostId, selfId: this.presence.selfId });
    if (!to || !this._connected || !this.ws) return false;
    try { this.ws.send(encode(makeInput({ to, player, btn, down }))); return true; }
    catch { return false; }
  }

  _applyGameInput(msg) {
    const ev = { from: msg.from || null, player: msg.player, btn: msg.btn, down: msg.down };
    this._recvInputs.push(ev);
    if (this._recvInputs.length > 64) this._recvInputs.shift();
    if (!this._onGameInput) return;
    try { this._onGameInput(ev); }
    catch (e) { console.warn('[desktop-net] onGameInput', e); }
  }

  // Debug snapshot for headless probes (exposed via window.__desktop).
  debugApi() {
    return {
      connected: () => this._connected,
      selfId: () => this.presence.selfId,
      peerCount: () => this.presence.size,
      hostId: () => this.hostId(),
      isHost: () => this.isHost(),
      sessionId: () => this.sessionId,
      tvOwner: () => this.objects.ownerOf('tv'),
      serverElects: () => this._serverElects,
      fallbackClaims: () => [...this._fallbackClaims.values()],
      // COR-9 diagnostics (same shape as NetMgr's, and asserted the same way:
      // scripts/test-net.mjs drives case 7 of the "Client reconnect gate"
      // section through BOTH classes, so deleting these here goes red too).
      protocolVersion: () => PROTOCOL_VERSION,
      serverProtocol: () => this.serverVersion,
      fatal: () => (this._fatal ? { ...this._fatal } : null),
      lastClose: () => (this.lastClose ? { ...this.lastClose } : null),
      recvInputs: () => this._recvInputs.slice(),
      video: this.video.debugApi(),
    };
  }

  // --- connection ------------------------------------------------------------

  connect() {
    // The socket itself belongs to [[src/net/RoomConnection.js]] (CODEX ARC-2):
    // the URL, the JOIN, the COR-9 HELLO gate, both backoff tables and the whole
    // close handler are shared with NetMgr. What is left here is this build's
    // routing table plus the flat-screen teardown hooks handed to the connection
    // in the constructor.
    this._conn.open();
    return this;
  }

  // A decoded message from the room server. Reached through the RoomConnection's
  // `onMessage` hook, which has ALREADY judged a HELLO's announced protocol (an
  // OLD SERVER cannot check OUR JOIN version, so that direction of the skew is
  // only ever caught there) and noted the session.
  _route(msg) {
    if (msg.type === MSG.SIGNAL) {
      if (msg.channel === 'video') this.video.handleSignal(msg);
      // (voice signals are not used on desktop v1)
    } else if (msg.type === MSG.STATE) {
      this._applyState(msg);
    } else if (msg.type === MSG.INPUT) {
      this._applyGameInput(msg);
    } else if (msg.type === MSG.HOST) {
      this._serverElects = true;                   // M1.4 migration / reclaim
      this._clearFallbackTimer();
      this._setHost(msg.id);
    } else if (msg.type === MSG.HELLO) {
      this.presence.apply(msg, this._now());
      // A server that does host election ALWAYS sends the key (even as null,
      // during a departed host's reclaim window). Its ABSENCE means a pre-M1.4
      // relay, in which case the peers must elect among themselves - otherwise
      // nobody is ever host and the boot gate refuses every game.
      if ('host' in msg) {
        this._serverElects = true;
        this._clearFallbackTimer();
        this._setHost(msg.host ?? null);
      } else {
        this._armFallbackElection();
      }
      if (this._onConnect) { try { this._onConnect(this.presence.selfId); } catch (_) {} }
      this._emitRoster();
    } else {
      // JOIN / LEAVE / POSE roster traffic.
      const leftId = (msg.type === MSG.LEAVE) ? msg.id : null;
      this.presence.apply(msg, this._now());
      if (leftId != null && !this._serverElects) {
        // A departing fallback host hands over to the earliest remaining claim.
        this._fallbackClaims.delete(String(leftId));
        if (this._hostId === String(leftId)) this._setHost(null);
        this._runFallbackElection();
      }
      this._emitRoster();
    }
  }

  // Called every frame from the app's rAF tick.
  tick(dtMs = 16) {
    // Prune peers that went silent without a clean LEAVE, then reconcile video.
    const pruned = this.presence.prune(this._now());
    if (pruned.length) this._emitRoster();
    this.video.update({
      peerIds: this.presence.peers().map((p) => p.id),
      selfId: this.presence.selfId,
      hostId: this._hostId,
    });
    // Heartbeat so peers don't prune us (we send no VR poses).
    if (!this._connected || !this.ws) return;
    this._hbAcc += dtMs;
    if (this._hbAcc >= HEARTBEAT_MS) {
      this._hbAcc = 0;
      try { this.ws.send(encode(makePose({}))); } catch { /* mid-close */ }
    }
  }

  _emitRoster() {
    if (!this._onRoster) return;
    const peers = this.presence.peers();
    const sig = peers.map((p) => `${p.id}:${p.nick}`).sort().join('|');
    if (sig === this._lastRosterSig) return;
    this._lastRosterSig = sig;
    try { this._onRoster(peers); } catch (e) { console.warn('[desktop-net] onRoster', e); }
  }

  disconnect() {
    this._conn.beginDisconnect();
    // ANNOUNCE BEFORE CLOSING — see the same note in NetMgr.disconnect(). The
    // VideoMgr send closure above is gated on `_connected && ws`, so tearing the
    // video down after the socket was closed made its teardown 'bye' inert and a
    // leaving host froze every client's picture until ICE consent expired.
    // Synchronous sends only: the leave is not delayed, and close() runs strictly
    // after them so there is no send-after-close race.
    this.video.disable();   // → one 'bye' per client we were streaming to
    this._conn.closeSocket();
    this.presence.clear();
    this.objects.clear();
    this._lastRosterSig = '';
  }
}
