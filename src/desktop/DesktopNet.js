// DesktopNet — the multiplayer layer for the FLAT-SCREEN desktop build. It is a
// slimmed-down sibling of [[src/net/NetMgr.js]]: same room server, same wire
// protocol, same host-authoritative netplay + host→client video, but with the
// VR-only parts removed (no avatars, no per-frame head/hand pose sync, no
// three.js). The VR NetMgr can't be reused directly because it imports three and
// samples scene transforms every frame; everything ELSE it relies on is pure and
// is reused here verbatim: PresenceState, RoomObjects, VideoMgr, NetProtocol.
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
  MSG, makeJoin, makePose, makeState, makeSignal, makeInput,
  hostInputTarget, encode, decode,
} from '../net/NetProtocol.js';
import { stableSessionId } from '../net/SessionUtils.js';
import { FALLBACK_HOST_KEY, normaliseClaim, resolveFallbackHost } from '../net/HostElection.js';

const HEARTBEAT_MS = 2000;
// M1.4: how long to wait for the SERVER to name a host before the peers elect one
// among themselves. Only a pre-M1.4 room server (one that sends no `host` key in
// HELLO) ever reaches the deadline; against a current server the flag flips on the
// first HELLO and this never fires. Without it, deploying this page against an
// un-upgraded relay would leave hostId null forever - which the boot gate reads as
// "nobody may host", i.e. no game at all for anyone.
const FALLBACK_ELECT_MS = 1200;
// Backoff for re-opening the socket after an UNEXPECTED close.
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

function defaultServerUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/`;
}

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
    iceServers = null,
    sessionId = null,
    now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  } = {}) {
    this.room = room || 'lobby';
    this.nick = nick || 'Player';
    this.color = color || '#88aaff';
    this.serverUrl = serverUrl || defaultServerUrl();
    this._now = now;
    this._hostId = null;              // M1.4: server-elected, not tv-derived
    this._onHostChange = onHostChange;
    this.sessionId = sessionId || stableSessionId();

    this.presence = new PresenceState({ ttlMs: 5000 });
    this.objects = new RoomObjects();
    this._onTvState = onTvState;
    this._onGameInput = onGameInput;
    this._onRoster = onRoster;
    this._onConnect = onConnect;
    this._onDisconnect = onDisconnect;

    this.ws = null;
    this._connected = false;
    this._hbAcc = 0;
    this._lastRosterSig = '';
    this._recvInputs = []; // small ring of inputs we received as host (debug)
    // M1.4 election bookkeeping (mirrors NetMgr): has the SERVER named a host, and
    // the peer-side fallback claims used when it never does.
    this._serverElects = false;
    this._fallbackClaims = new Map();   // peerId -> { id, at }
    this._fallbackTimer = null;
    this._joinedAt = Date.now();
    // Reconnect bookkeeping. `_closing` distinguishes OUR disconnect() from a
    // dropped socket, which must not be silent (the role has to be given up).
    this._closing = false;
    this._reconnectTries = 0;
    this._reconnectTimer = null;

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
  // `silent` is for our OWN deliberate disconnect(): the app is tearing the session
  // down anyway, and firing a demotion callback mid-teardown made the role handler
  // run against a half-dismantled session.
  _setHost(id, { silent = false } = {}) {
    const next = id == null ? null : String(id);
    if (next === this._hostId) return false;
    const prev = this._hostId;
    this._hostId = next;
    if (this._onHostChange && !silent) {
      try { this._onHostChange({ hostId: next, prevHostId: prev, isHost: this.isHost(), connected: this._connected }); }
      catch (e) { console.warn('[desktop-net] onHostChange', e); }
    }
    return true;
  }

  // --- M1.4 fallback election (pre-M1.4 room server) -------------------------
  // Same algorithm as NetMgr's, over the same pure helper: the EARLIEST claim by a
  // still-present peer wins (ties broken by id), which reproduces the server's
  // seniority rule. Claims ride the persisted STATE channel so they're replayed to
  // late joiners.
  _noteFallbackClaim(raw) {
    const c = normaliseClaim(raw);
    if (!c) return;
    const prev = this._fallbackClaims.get(c.id);
    if (!prev || c.at < prev.at) this._fallbackClaims.set(c.id, c);
    if (!this._serverElects) this._runFallbackElection();
  }

  _runFallbackElection() {
    if (this._serverElects || !this._connected) return;
    const selfId = this.presence.selfId;
    if (!selfId) return;
    if (!this._fallbackClaims.has(selfId)) {
      this._fallbackClaims.set(selfId, { id: selfId, at: this._joinedAt });
    }
    const stored = this.objects.get(FALLBACK_HOST_KEY);
    this._noteFallbackClaimQuiet(stored);
    const { hostId, announce } = resolveFallbackHost({
      claims: [...this._fallbackClaims.values()],
      presentIds: [selfId, ...this.presence.peers().map((p) => p.id)],
      selfId,
      now: this._joinedAt,
      stored,
    });
    if (announce) this.setObjectState(FALLBACK_HOST_KEY, announce);
    this._setHost(hostId);
  }

  _noteFallbackClaimQuiet(raw) {
    const c = normaliseClaim(raw);
    if (!c) return;
    const prev = this._fallbackClaims.get(c.id);
    if (!prev || c.at < prev.at) this._fallbackClaims.set(c.id, c);
  }

  _armFallbackElection() {
    if (this._serverElects || this._fallbackTimer) return;
    this._fallbackTimer = setTimeout(() => {
      this._fallbackTimer = null;
      if (this._serverElects || this._hostId) return;
      console.warn('[desktop-net] no host announced by the room server - electing among peers (legacy server?)');
      this._runFallbackElection();
    }, FALLBACK_ELECT_MS);
  }

  _clearFallbackTimer() {
    if (this._fallbackTimer) { clearTimeout(this._fallbackTimer); this._fallbackTimer = null; }
  }
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
      recvInputs: () => this._recvInputs.slice(),
      video: this.video.debugApi(),
    };
  }

  // --- connection ------------------------------------------------------------

  connect() {
    const sep = this.serverUrl.includes('?') ? '&' : '?';
    const url = `${this.serverUrl}${sep}room=${encodeURIComponent(this.room)}&sid=${encodeURIComponent(this.sessionId)}`;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { console.warn('[desktop-net] connect failed', e); return this; }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this._connected = true;
      this._reconnectTries = 0;
      this._joinedAt = Date.now();
      ws.send(encode(makeJoin({ nick: this.nick, color: this.color })));
      console.log(`[desktop-net] connected to "${this.room}" as ${this.nick}`);
    });
    ws.addEventListener('message', (e) => {
      const msg = decode(typeof e.data === 'string' ? e.data : '');
      if (!msg) return;
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
    });
    // An UNEXPECTED close (Wi-Fi blip, server restart, proxy timeout): we are no
    // longer the room's authority. Stop streaming and give up the role - a host that
    // kept both would become a SECOND host the moment the server migrates - then
    // reconnect (the server holds our sid in its reclaim window, so a quick return
    // gets the role back). Our own disconnect() sets _closing and skips all this.
    ws.addEventListener('close', () => {
      const wasConnected = this._connected;
      this._connected = false;
      // The socket is gone: tear the capture down locally, but don't pretend to
      // announce a 'bye' that could not possibly be delivered.
      this.video.stopBroadcast({ announce: false });
      if (!this._closing) {
        this._setHost(null);
        if (wasConnected || this._reconnectTries) this._scheduleReconnect();
      }
      if (this._onDisconnect) { try { this._onDisconnect(); } catch (_) {} }
    });
    ws.addEventListener('error', () => { /* close follows */ });
    return this;
  }

  _scheduleReconnect() {
    if (this._closing || this._reconnectTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this._reconnectTries, RECONNECT_DELAYS_MS.length - 1)];
    this._reconnectTries++;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._closing) return;
      console.log(`[desktop-net] reconnecting to "${this.room}" (attempt ${this._reconnectTries})`);
      // The server assigns a NEW peer id on reconnect, so the old roster and the
      // old fallback claims are meaningless. Shared object state is replayed.
      this.presence.clear();
      this._fallbackClaims.clear();
      // Connection genuinely lost (this path only runs after an UNEXPECTED
      // close): teardown yes, byes no — they could never reach a peer.
      this.video.disable({ announce: false });
      this.connect();
    }, delay);
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
    this._closing = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._clearFallbackTimer();
    // ANNOUNCE BEFORE CLOSING — see the same note in NetMgr.disconnect(). The
    // VideoMgr send closure above is gated on `_connected && ws`, so tearing the
    // video down after the socket was closed made its teardown 'bye' inert and a
    // leaving host froze every client's picture until ICE consent expired.
    // Synchronous sends only: the leave is not delayed, and close() runs strictly
    // after them so there is no send-after-close race.
    this.video.disable();   // → one 'bye' per client we were streaming to
    try { this.ws?.close(); } catch { /* already closing */ }
    this._connected = false;
    this._setHost(null, { silent: true });
    this._serverElects = false;
    this._fallbackClaims.clear();
    this.presence.clear();
    this.objects.clear();
    this._lastRosterSig = '';
  }
}
