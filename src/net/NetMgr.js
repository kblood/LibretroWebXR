// NetMgr: the browser side of M0 presence. Owns the WebSocket to the room
// server, the pure [[src/net/PresenceState.js]] registry, and the
// [[src/net/AvatarMgr.js]] that reflects it into the scene. Each frame it
// samples the local head + hand world transforms, throttles them out at ~12 Hz,
// and applies whatever the server relays from other peers.
//
// Opt-in: main.js only constructs this when the URL has `?session=<room>`, so
// single-player is completely untouched (no socket, no avatars).
//
// Pose space: we send WORLD transforms (camera / controllers decomposed from
// matrixWorld), and avatars live at scene root, so a remote head appears exactly
// where that player stands. In XR the head comes from renderer.xr.getCamera()
// (the real headset pose); on desktop it's the flat-screen camera.

import * as THREE from 'three';
import { PresenceState } from './PresenceState.js';
import { RoomObjects } from './RoomObjects.js';
import { AvatarMgr } from './AvatarMgr.js';
import { VoiceMgr } from './VoiceMgr.js';
import { VideoMgr } from './VideoMgr.js';
import {
  MSG, makeJoin, makePose, makeSignal, makeState, makeInput, makeWire, hostInputTarget, encode, decode,
  PROTOCOL_VERSION, judgeServerVersion, isPermanentClose,
} from './NetProtocol.js';
import { stableSessionId, spawnSeatOffset } from './SessionUtils.js';
import { FALLBACK_HOST_KEY, normaliseClaim, resolveFallbackHost } from './HostElection.js';

// Client-side fallback host election (see [[src/net/HostElection.js]]): how long
// to wait after HELLO for a server-side election before electing among ourselves.
// Only ever used against a room server too OLD to know about host election.
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

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

function worldPose(obj) {
  obj.updateWorldMatrix(true, false);
  obj.matrixWorld.decompose(_p, _q, _s);
  return [_p.x, _p.y, _p.z, _q.x, _q.y, _q.z, _q.w];
}

function defaultServerUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/`;
}

export class NetMgr {
  constructor({ scene, room, serverUrl, nick, color, sendHz = 12, onObjectState = null, onGameInput = null, onWire = null, onPeerLeave = null, onHostChange = null, onFatal = null, onRetry = null, videoCanvas = null, videoAudio = null, onHostVideo = null, onHostVideoEnded = null, iceServers = null, sessionId = null, now = () => performance.now() }) {
    this.scene = scene;
    this.room = room || 'lobby';
    this.nick = nick || 'Player';
    this.color = color || '#88aaff';
    this.serverUrl = serverUrl || defaultServerUrl();
    this.sendHz = sendHz;
    this._now = now;
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
    // Stable per-tab id so the server can give us the host role back after our
    // OWN page reload (cross-core cartridge swap) instead of migrating it away.
    this.sessionId = sessionId || stableSessionId();
    // Auto-reconnect bookkeeping (an unexpected close, not disconnect()).
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
    // NetMgr is DONE: the pair is incompatible, so retrying the same build can
    // only produce the same refusal. `onFatal({code, reason})` is the app's hook
    // for saying so in the UI instead of leaving the user in a room that never
    // fills; it fires exactly once, from _noteFatal, and only for a PERMANENT
    // close (a 1006 blip does not invoke it). Asserted in scripts/test-net.mjs,
    // case 3c of the "Client reconnect gate" section, against this real class.
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
    // never asked to connect.
    this.lastClose = null;       // { code, reason, attempt, delayMs } | null
    this._onRetry = onRetry;
    this.serverVersion = null;   // what the room server said in HELLO (null = pre-COR-9)
    // M0 hardening: optional TURN/STUN config for the WebRTC meshes (voice +
    // video). null → each manager uses its built-in STUN-only default. A full
    // list (built via NetProtocol.buildIceServers) is shared by both meshes so
    // peers behind symmetric NAT can relay through TURN.
    this.iceServers = iceServers;

    // Avatar spawn seat (see spawnSeatOffset): where THIS peer stands relative to
    // the room's default rig position. Assigned on HELLO from our seniority in the
    // roster; null until then (and for a peer that never connects). `_rigHome` is
    // the rig position as it was when this NetMgr was built, so re-seating on a
    // reconnect is absolute and can never accumulate drift.
    this.spawnSeat = null;
    this._rigHome = this.scene?.playerRig?.position?.clone?.() ?? null;

    this.presence = new PresenceState({ ttlMs: 5000 });
    // M0.5 room-object sync: shared key→value state (the loaded game, etc.).
    // onObjectState(key, value, id) is invoked when a remote change arrives so
    // main.js can reflect it into the scene (e.g. boot the same game on the TV).
    this.objects = new RoomObjects();
    this._onObjectState = onObjectState;
    // M1 game sync: a host receives remote players' RetroPad inputs here.
    // onGameInput({ from, player, btn, down }) lets main.js feed them to its core.
    this._onGameInput = onGameInput;
    // M2 transient relay: per-frame ephemera from peers (held-pad button bitmasks,
    // live prop drag). onWire(ch, data, fromId) lets main.js animate ghosts / move
    // props in real time. Not persisted — purely "what's happening right now".
    this._onWire = onWire;
    // Keyboard-latch fix: fired with the departing peer's id whenever a peer
    // leaves cleanly (MSG.LEAVE) or is pruned as stale. main.js wires this to
    // gameInput.clearRemote() so mid-keypress disconnects don't latch remote keys.
    this._onPeerLeave = onPeerLeave;
    this._recvInputs = []; // small debug ring of the last received inputs
    this.avatars = new AvatarMgr({ scene });
    this.ws = null;
    this._connected = false;
    this._acc = 0;

    // M0.4 voice: WebRTC mesh signaled over this same socket. Constructed eagerly
    // (cheap) but inert until enableVoice() grabs the mic on a user gesture.
    this.voice = new VoiceMgr({
      scene,
      avatars: this.avatars,
      getSelfId: () => this.presence.selfId,
      iceServers: this.iceServers ?? undefined,
      send: ({ to, kind, data }) => {
        if (this._connected && this.ws) {
          try { this.ws.send(encode(makeSignal({ to, kind, data }))); } catch { /* mid-close */ }
        }
      },
    });

    // M1.2 host video stream: a host→client WebRTC video of the running game,
    // signaled over the same socket but on channel:'video' so it never collides
    // with the voice mesh. Inert until a host calls startVideoBroadcast(); a
    // client paints the received frames onto its TV via onHostVideo (and reverts
    // on onHostVideoEnded). update() is driven from tick() with the live roster
    // + host id. The capturable canvas is supplied by main.js (the emulator's).
    this.video = new VideoMgr({
      getSelfId: () => this.presence.selfId,
      // videoCanvas may be a live getter (a fn) so the capture follows a primary
      // console reboot's new canvas; a plain canvas is still accepted unchanged.
      getCaptureCanvas: () => (typeof videoCanvas === 'function' ? videoCanvas() : videoCanvas),
      // Game AUDIO for the stream: a MediaStream tapped off the host's emulator
      // audio branch (see SpatialAudio.captureStream). Without it a watching
      // client would see the host's game in complete silence — canvas.captureStream()
      // carries no audio at all.
      getCaptureAudio: () => (typeof videoAudio === 'function' ? videoAudio() : videoAudio),
      iceServers: this.iceServers ?? undefined,
      onHostVideo,
      onHostVideoEnded,
      send: ({ to, kind, data }) => {
        if (this._connected && this.ws) {
          try { this.ws.send(encode(makeSignal({ to, kind, data, channel: 'video' }))); } catch { /* mid-close */ }
        }
      },
    });
  }

  // --- M1.2 host video stream -----------------------------------------------

  // Host: begin streaming our emulator canvas to the rest of the room. Called by
  // main.js when this peer boots the room's game (it becomes the tv-state owner).
  startVideoBroadcast() { return this.video.startBroadcast(); }
  stopVideoBroadcast() { this.video.stopBroadcast(); }
  // Client: re-hand the live host <video> to the app. Needed because a local
  // video re-route (power toggle, console spawn, primary reboot, repatch) paints
  // a LOCAL canvas over the host's picture; without this the client stares at a
  // blank canvas for the rest of the session even though the stream is healthy.
  reattachHostVideo() { return this.video.reattach(); }
  // True while the socket is open. A peer with no socket is not the room's
  // authority whatever its last known role was, so the app's host gates check it.
  get connected() { return this._connected; }

  async enableVoice() {
    const ok = await this.voice.enable();
    if (ok) this.voice.syncPeers(this.presence.peers().map((p) => p.id));
    return ok;
  }

  // --- M0.5 room-object sync ------------------------------------------------

  // Apply an incoming STATE message and notify main.js only when it actually
  // changed (the registry dedups echoes / idempotent late-join replays).
  _applyState(msg) {
    const r = this.objects.apply(msg);
    // M1.4 fallback election rides this channel (see [[src/net/HostElection.js]]).
    // Internal, never surfaced to the app.
    if (r && r.key === FALLBACK_HOST_KEY) {
      this._noteFallbackClaim(r.value);
      return;
    }
    if (r && r.changed && this._onObjectState) {
      try { this._onObjectState(r.key, r.value, r.id); } catch (e) { console.warn('[net] onObjectState', e); }
    }
  }

  /**
   * Broadcast a shared room-object value (e.g. setObjectState('tv', {file,…})).
   * Updates the local registry immediately so our own get() is consistent, then
   * sends it; the server persists it and relays to the rest of the room. A null
   * value clears the key. No-ops (unchanged value) are not re-sent.
   */
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

  // --- M2 transient relay (non-persisted per-frame ephemera) ----------------

  /**
   * Broadcast a transient payload on channel `ch` to the rest of the room. Used
   * for high-rate data that must NOT be persisted (a held pad's button bitmask,
   * a prop's live drag transform). Fire-and-forget; dropped if disconnected.
   */
  sendWire(ch, data = null) {
    if (!this._connected || !this.ws) return false;
    try { this.ws.send(encode(makeWire({ ch, data }))); return true; }
    catch { return false; }
  }

  // A peer's transient payload arrived. Hand it to main.js (no dedup/persist —
  // it's "right now" data; a dropped packet just means a slightly stale frame).
  _applyWire(msg) {
    if (!this._onWire) return;
    try { this._onWire(msg.ch, msg.data, msg.id || null); }
    catch (e) { console.warn('[net] onWire', e); }
  }

  // --- M1 game sync (host-authoritative input over the relay) ---------------

  // This peer's server-assigned id (null until HELLO arrives).
  get selfId() { return this.presence.selfId; }

  // The room's authoritative host (M1.4): the peer that has been in the room
  // longest, as elected by the server. Stable — it changes ONLY when the current
  // host disconnects (then the longest-present remaining peer takes over), never
  // as a side effect of an in-room action. null until HELLO arrives.
  hostId() { return this._hostId; }

  // True when WE are the host → we run the ONE authoritative core, broadcast its
  // video, and inject remote peers' inputs. A false here means "display-only
  // client": never boot a core locally, just show the host's stream.
  isHost() {
    const self = this.presence.selfId;
    return !!self && self === this._hostId;
  }

  // Record a server-announced host and notify the app when it actually changed.
  // Fired from HELLO (`host`), MSG.HOST (migration / reclaim), the fallback
  // election, and the socket `close` handler (which demotes us: a peer with no
  // socket is not the room's authority any more, whatever it used to be).
  //
  // `silent` suppresses the app callback — used by the DELIBERATE disconnect()
  // teardown, where main.js has already reverted the screen and resumed the local
  // core: firing a demotion there would immediately re-pause the game the user
  // just went back to playing solo (and could bounce them into a room-adoption
  // reload of the room they asked to leave).
  _setHost(id, { silent = false } = {}) {
    const next = id == null ? null : String(id);
    if (next === this._hostId) return false;
    const prev = this._hostId;
    this._hostId = next;
    if (this._onHostChange && !silent) {
      try { this._onHostChange({ hostId: next, prevHostId: prev, isHost: this.isHost(), connected: this._connected }); }
      catch (e) { console.warn('[net] onHostChange', e); }
    }
    return true;
  }

  // --- COR-9 protocol compatibility ----------------------------------------

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
    console.error(`[net] room server refused this build permanently (${this._fatal.code}): ${this._fatal.reason} — not reconnecting (client protocol ${PROTOCOL_VERSION}, server ${this.serverVersion ?? 'unknown'})`);
    if (this._onFatal) {
      try { this._onFatal(this._fatal); } catch (e) { console.warn('[net] onFatal', e); }
    }
  }

  /**
   * Judge the room server's HELLO version (COR-9). Returns true when it is safe
   * to go on processing this message.
   *
   * The DECISION is not made here: NetProtocol.judgeServerVersion owns it, and
   * DesktopNet's copy of this method calls the same function (CODEX ARC-2 — two
   * connection lifecycles, one protocol rule). This method only performs the side
   * effects, which is the part that legitimately differs between the two clients
   * (log prefix, and NetMgr's extra teardown).
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
        console.warn(`[net] room server announced no protocol version — pre-COR-9 relay, continuing (client speaks ${PROTOCOL_VERSION})`);
      }
      return true;
    }
    this._noteFatal({ code: verdict.code, reason: verdict.reason });
    try { this.ws?.close(verdict.code, verdict.reason); } catch { /* already closing */ }
    return false;
  }

  // --- M1.4 fallback election (pre-M1.4 room server) ------------------------

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
    const selfId = this.presence.selfId;
    if (!selfId) return;
    if (!this._fallbackClaims.has(selfId)) {
      // Our own claim timestamp is when WE joined — the seniority signal.
      this._fallbackClaims.set(selfId, { id: selfId, at: this._joinedAt ?? Date.now() });
    }
    const stored = this.objects.get(FALLBACK_HOST_KEY);
    this._noteStoredClaim(stored);
    const { hostId, announce } = resolveFallbackHost({
      claims: [...this._fallbackClaims.values()],
      presentIds: [selfId, ...this.presence.peers().map((p) => p.id)],
      selfId,
      now: this._joinedAt ?? Date.now(),
      stored,
    });
    if (announce) this.setObjectState(FALLBACK_HOST_KEY, announce);
    this._setHost(hostId);
  }

  // A claim relayed through the shared STATE (also replayed to late joiners).
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
      console.warn('[net] no host announced by the room server — electing among peers (legacy server?)');
      this._runFallbackElection();
    }, FALLBACK_ELECT_MS);
  }

  _clearFallbackTimer() {
    if (this._fallbackTimer) { clearTimeout(this._fallbackTimer); this._fallbackTimer = null; }
  }

  // Forward one captured local logical input to the host, if there is a remote
  // one. Pure routing decision lives in NetProtocol.hostInputTarget; no-op when
  // we're the host or there is no host yet. Returns true if a message was sent.
  forwardGameInput({ player, btn, down }) {
    const to = hostInputTarget({ hostId: this._hostId, selfId: this.presence.selfId });
    if (!to) return false;
    return this.sendGameInput({ to, player, btn, down });
  }

  /**
   * Send one logical RetroPad button transition to the host peer `to` (the peer
   * running the game). Used by a non-host client so the host can drive `player`
   * (a console port slot) in its core. No-op if disconnected.
   */
  sendGameInput({ to, player, btn, down }) {
    if (!this._connected || !this.ws || !to) return false;
    try { this.ws.send(encode(makeInput({ to, player, btn, down }))); return true; }
    catch { return false; }
  }

  // A remote player's input arrived (we're the host). Record for debug and hand
  // it to main.js to inject into the core.
  _applyGameInput(msg) {
    const ev = { from: msg.from || null, player: msg.player, btn: msg.btn, down: msg.down };
    this._recvInputs.push(ev);
    if (this._recvInputs.length > 64) this._recvInputs.shift();
    if (this._onGameInput) {
      try { this._onGameInput(ev); } catch (e) { console.warn('[net] onGameInput', e); }
    }
  }

  connect() {
    const sep = this.serverUrl.includes('?') ? '&' : '?';
    // sid rides the connect URL (not the later JOIN) because the server has to
    // decide the host BEFORE it sends HELLO. See server/Hub.js connect().
    const url = `${this.serverUrl}${sep}room=${encodeURIComponent(this.room)}&sid=${encodeURIComponent(this.sessionId)}`;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { console.warn('[net] connect failed', e); return this; }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this._connected = true;
      this._closing = false;
      // NOT `_reconnectTries = 0` — see _noteSessionEstablished(). An 'open' is
      // now also what a soft capacity refusal looks like, one close frame before
      // it arrives.
      this._joinedAt = Date.now();
      ws.send(encode(makeJoin({ nick: this.nick, color: this.color })));
      console.log(`[net] connected to "${this.room}" as ${this.nick}`);
    });
    ws.addEventListener('message', (e) => {
      const msg = decode(typeof e.data === 'string' ? e.data : '');
      if (!msg) return;
      // COR-9: the server states its protocol version in HELLO. An OLD SERVER
      // talking to a NEW app is the half the server-side JOIN check cannot catch
      // (it doesn't know the field exists), so the client judges it here — before
      // acting on the roster, because an incompatible HELLO's contents are
      // exactly what we must not trust.
      if (msg.type === MSG.HELLO && !this._checkServerProtocol(msg.v)) return;
      // A compatible HELLO is the first proof we have a SESSION and not merely a
      // socket — which is what the backoff must key on. See below.
      if (msg.type === MSG.HELLO) this._noteSessionEstablished();
      if (msg.type === MSG.SIGNAL) {                                  // WebRTC negotiation
        if (msg.channel === 'video') this.video.handleSignal(msg);   // host↔client game video
        else this.voice.handleSignal(msg);                           // voice mesh (default)
      }
      else if (msg.type === MSG.STATE) this._applyState(msg);         // room-object sync
      else if (msg.type === MSG.INPUT) this._applyGameInput(msg);     // game sync (host side)
      else if (msg.type === MSG.WIRE) this._applyWire(msg);           // transient ephemera
      else if (msg.type === MSG.HOST) {                               // M1.4 host election
        this._serverElects = true;
        this._clearFallbackTimer();
        this._setHost(msg.id);
      }
      else {
        // Roster + poses. For LEAVE we also fire the peer-leave callback so
        // callers (main.js) can clear any latched remote input from that peer.
        const leftId = (msg.type === MSG.LEAVE) ? msg.id : null;
        this.presence.apply(msg, this._now());
        if (msg.type === MSG.HELLO) {
          // Take a spawn seat before anything else: presence.apply(HELLO) has just
          // registered every peer that was ALREADY here (self excluded), so
          // presence.size is exactly our join order — 0 for the first peer in the
          // room, 1 for the next, and so on. Without this every peer stands at the
          // same origin and their avatars occlude each other's TV.
          this._takeSpawnSeat(this.presence.size);
          // A server that knows about host election ALWAYS sends the key (even as
          // null, e.g. during a departed host's reclaim window). Its total absence
          // means a pre-M1.4 relay → the peers must elect among themselves, or
          // nobody would ever be host and the boot gate would refuse every game.
          if ('host' in msg) {
            this._serverElects = true;
            this._clearFallbackTimer();
            this._setHost(msg.host ?? null);
          } else {
            this._armFallbackElection();
          }
        }
        if (leftId != null) {
          try { this._onPeerLeave?.(leftId); } catch (e) { console.warn('[net] onPeerLeave', e); }
          // A departing fallback host hands over to the earliest remaining claim.
          if (!this._serverElects) {
            this._fallbackClaims.delete(String(leftId));
            if (this._hostId === String(leftId)) this._setHost(null);
            this._runFallbackElection();
          }
        }
      }
    });
    // An UNEXPECTED close (Wi-Fi blip, server restart, proxy timeout): we are no
    // longer the room's authority — the server has our sid in its reclaim window
    // and will migrate the role if we don't come back. Demote ourselves so we
    // can't keep running + publishing as a second host (the exact "two
    // simultaneous hosts" bug), then try to reconnect and reclaim.
    ws.addEventListener('close', (ev) => {
      this._connected = false;
      // CONNECTION LOST (or our own close, already announced above): the socket
      // is gone, so a 'bye' cannot reach anyone — tear the capture down locally
      // and don't pretend to announce it.
      this.video.stopBroadcast({ announce: false });
      // COR-9: a PERMANENT refusal (4010 — the server rejected our protocol
      // major) must break the backoff chain. Every other close is retried, which
      // is right for a Wi-Fi blip or a server restart (1001) but is a silent
      // infinite loop against a server that will refuse this build every time.
      if (isPermanentClose(ev?.code)) {
        this._noteFatal({ code: ev.code, reason: String(ev.reason || 'incompatible protocol') });
        this._setHost(null);
        return;
      }
      // EVERY non-permanent close is retried, INCLUDING one on the very first
      // connect. The gate here used to be `wasConnected || this._reconnectTries`,
      // and on a fresh NetMgr's first connect both are falsy — so a relay that
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
    });
    ws.addEventListener('error', () => { /* close follows */ });
    return this;
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
  // roster is meaningless); the shared object state is replayed by the server.
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
    console.warn(`[net] disconnected from "${this.room}"${code ? ` (${code}${reason ? `: ${reason}` : ''})` : ''} — retrying in ${delay}ms (attempt ${this._reconnectTries})`);
    if (this._onRetry) {
      try { this._onRetry({ ...this.lastClose }); } catch (e) { console.warn('[net] onRetry', e); }
    }
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._closing) return;
      console.log(`[net] reconnecting to "${this.room}" (attempt ${this._reconnectTries})`);
      this.avatars.removeAll();
      this.presence.clear();
      this._fallbackClaims.clear();
      // The old socket is genuinely gone here (this path only runs after an
      // UNEXPECTED close), so the local teardown must still happen but the byes
      // cannot be sent — that is correct, not a regression. `announce:false`
      // says so explicitly instead of leaning on the send gate to swallow them.
      this.video.disable({ announce: false });
      this.connect();
    }, delay);
  }

  /**
   * Move the local player rig onto its spawn seat (see SessionUtils'
   * spawnSeatOffset). Absolute — always `home + offset`, never `+=` — so a
   * reconnect that re-seats us cannot accumulate drift, and _clearSpawnSeat()
   * puts the rig back where it started. No-ops without a rig (Node unit tests
   * pass a stub scene).
   *
   * @param {number} index  join order (0 = first peer in the room)
   * @returns {{index:number, offset:number[]}|null}
   */
  _takeSpawnSeat(index) {
    const offset = spawnSeatOffset(index);
    this.spawnSeat = { index: Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0, offset };
    const rig = this.scene?.playerRig;
    if (rig && this._rigHome) {
      rig.position.set(this._rigHome.x + offset[0], this._rigHome.y + offset[1], this._rigHome.z + offset[2]);
    }
    return this.spawnSeat;
  }

  /** Put the rig back on the room's default spot (leaving the session). */
  _clearSpawnSeat() {
    const rig = this.scene?.playerRig;
    if (rig && this._rigHome && this.spawnSeat) rig.position.copy(this._rigHome);
    this.spawnSeat = null;
  }

  // Head + both hands as world-space 7-tuples (hands null when not connected).
  _sampleLocalPose() {
    const r = this.scene.renderer;
    const head = (r?.xr?.isPresenting) ? worldPose(r.xr.getCamera()) : worldPose(this.scene.camera);
    const ctrls = this.scene.controllers || [];
    // controllers[0]/[1] are the XR controllers; [2] is the synthetic desktop
    // one (no inputSource.gamepad) — handPose returns null for it.
    const handPose = (c) => (c && c.userData?.inputSource?.gamepad) ? worldPose(c) : null;
    return { head, left: handPose(ctrls[0]), right: handPose(ctrls[1]) };
  }

  // Called every frame from SceneMgr's tick loop.
  tick(dtMs = 16) {
    // Reflect remote peers into the scene (prune stale → sync meshes → ease).
    // pruned ids are peers that timed out without a clean LEAVE (tab closed,
    // network drop). Fire onPeerLeave for each so latched remote keys are cleared.
    const pruned = this.presence.prune(this._now());
    if (pruned.length && this._onPeerLeave) {
      for (const id of pruned) {
        try { this._onPeerLeave(id); } catch (e) { console.warn('[net] onPeerLeave (prune)', e); }
      }
    }
    const peers = this.presence.peers();
    this.avatars.sync(peers);
    this.avatars.tick(dtMs);
    // Both consumers below want the ids, not the peer records, and both only
    // READ them — so take the roster-versioned cached array instead of mapping
    // the peer list twice more every rendered frame (PERF-4(b)).
    const peerIds = this.presence.ids();
    // Keep the voice mesh in step with the roster (no-op until voice enabled).
    if (this.voice.enabled) this.voice.syncPeers(peerIds);
    // Reconcile the host→client video connections against the roster + who the
    // server-elected host is. No-op for a non-host with no host streaming.
    this.video.update({ peerIds, selfId: this.presence.selfId, hostId: this._hostId });

    // Throttle the local pose out.
    if (!this._connected || !this.ws) return;
    this._acc += dtMs;
    const interval = 1000 / this.sendHz;
    if (this._acc >= interval) {
      this._acc = 0;
      try { this.ws.send(encode(makePose(this._sampleLocalPose()))); } catch { /* socket mid-close */ }
    }
  }

  disconnect() {
    // Deliberate leave: suppress the reconnect chain AND the demotion callback
    // (main.js has already reverted the screen + resumed the local core — see
    // _setHost's `silent` note).
    this._closing = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._clearFallbackTimer();
    // ANNOUNCE BEFORE CLOSING. Everything whose teardown has to REACH the other
    // peers must run while the socket is still open and `_connected` is still
    // true, because the send closures handed to VoiceMgr/VideoMgr above are gated
    // on exactly that pair. Closing first made VideoMgr.disable()'s teardown
    // 'bye' inert on this path — the internal "stopBroadcast first" ordering
    // inside disable() cannot help when the gate is already shut — so a HOST that
    // left the room left every client sitting on a frozen picture until ICE
    // consent expired (~30 s), the exact symptom the bye exists to prevent.
    //
    // Nothing here awaits: these are synchronous ws.send() calls, so leaving is
    // not delayed, and there is no send-after-close race because close() happens
    // strictly after them (the close frame is queued behind the data frames).
    this.voice.disable();
    this.video.disable();   // → one 'bye' per client we were streaming to
    try { this.ws?.close(); } catch { /* already closing */ }
    this._connected = false;
    this._setHost(null, { silent: true });
    this._serverElects = false;
    this._fallbackClaims.clear();
    this.avatars.removeAll();
    this.presence.clear();
    // Give up our spawn seat — solo play belongs at the room's default spot, and a
    // later re-join re-seats from a clean home instead of stacking offsets.
    this._clearSpawnSeat();
    // Drop the room's shared state too: leaving means the host's `tv`/`room`
    // snapshot is no longer ours to converge on (a stale copy left here made the
    // post-leave code think it still had to adopt the host's room).
    this.objects.clear();
  }

  // Debug snapshot for headless probes (window.__net).
  debugApi() {
    return {
      connected: () => this._connected,
      selfId: () => this.presence.selfId,
      peerCount: () => this.presence.size,
      avatarCount: () => this.avatars.count,
      peers: () => this.presence.peers().map((p) => ({ id: p.id, nick: p.nick })),
      sampleLocalPose: () => this._sampleLocalPose(),
      avatarPositions: () => this.avatars.positions(),
      // Spawn seats (see SessionUtils.spawnSeatOffset). takeSpawnSeat() is here so
      // a test can force the PRE-FIX world — every peer on seat 0, stacked on the
      // room origin — and assert that the avatar-occlusion measurement really does
      // go red there. Nothing in the app calls it.
      spawnSeat: () => this.spawnSeat,
      takeSpawnSeat: (index) => this._takeSpawnSeat(index),
      enableVoice: () => this.enableVoice(),
      toggleMute: () => this.voice.toggleMute(),
      voice: this.voice.debugApi(),
      // M0.5 room-object sync
      objectState: (key) => this.objects.get(key),
      objectEntries: () => this.objects.entries(),
      setObjectState: (key, value) => this.setObjectState(key, value),
      // M1 game sync
      sendGameInput: (m) => this.sendGameInput(m),
      forwardGameInput: (m) => this.forwardGameInput(m),
      hostId: () => this.hostId(),
      isHost: () => this.isHost(),
      sessionId: () => this.sessionId,
      // Diagnostics: who last wrote the shared `tv` state. Informational only —
      // it is NOT how the host is chosen any more (M1.4).
      tvOwner: () => this.objects.ownerOf('tv'),
      recvInputs: () => this._recvInputs.slice(),
      // M2 transient relay
      sendWire: (ch, data) => this.sendWire(ch, data),
      // M1.2 host video stream
      video: this.video.debugApi(),
      startVideoBroadcast: () => this.startVideoBroadcast(),
      stopVideoBroadcast: () => this.stopVideoBroadcast(),
      reattachHostVideo: () => this.reattachHostVideo(),
      // M1.4 diagnostics: did the SERVER elect the host, or did we fall back to
      // electing among peers (pre-M1.4 relay)?
      serverElects: () => this._serverElects,
      fallbackClaims: () => [...this._fallbackClaims.values()],
      // COR-9 diagnostics: what we speak, what the server said, and whether we
      // gave up permanently (a probe that sees `fatal` knows the socket is not
      // coming back and should not wait for a reconnect that will never happen).
      // `fatal()` hands out a COPY so a probe cannot mutate client state. All
      // three are asserted in scripts/test-net.mjs, case 7 of the "Client
      // reconnect gate" section — delete any of them and that goes red.
      protocolVersion: () => PROTOCOL_VERSION,
      serverProtocol: () => this.serverVersion,
      fatal: () => (this._fatal ? { ...this._fatal } : null),
      // …and the TRANSIENT half: why the last socket went away and which retry
      // we are on. A probe (or a future widget) that sees `fatal() === null` but
      // a `lastClose()` needs to say "reconnecting", not "Offline".
      lastClose: () => (this.lastClose ? { ...this.lastClose } : null),
    };
  }
}
