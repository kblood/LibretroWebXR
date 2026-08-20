// NetMgr: the browser side of M0 presence. Drives the WebSocket to the room
// server (through the shared [[src/net/RoomConnection.js]] it composes), the
// pure [[src/net/PresenceState.js]] registry, and the
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
  MSG, makePose, makeSignal, makeState, makeInput, makeWire, hostInputTarget, encode,
  PROTOCOL_VERSION,
} from './NetProtocol.js';
import { stableSessionId, spawnSeatOffset } from './SessionUtils.js';
import { FALLBACK_HOST_KEY } from './HostElection.js';
import { RoomConnection } from './RoomConnection.js';

// The socket, the COR-9 handshake, the reconnect/soft-refusal backoff and the
// M1.4 host bookkeeping are NOT here any more: they live in
// [[src/net/RoomConnection.js]], which this class COMPOSES (`this._conn`) and
// [[src/desktop/DesktopNet.js]] composes too. That module carries the long "why"
// notes for every one of those rules — the two backoff tables, the sticky
// `_retryLater`, `_noteSessionEstablished`, the pre-M1.4 fallback election,
// `_noteFatal`/`_checkServerProtocol` — because until CODEX ARC-2 was closed
// each of them had to be written TWICE, once here and once there. Everything
// below is the VR PRESENTATION half: avatars, voice, per-frame pose sampling,
// and the message routing that feeds them.

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

function worldPose(obj) {
  obj.updateWorldMatrix(true, false);
  obj.matrixWorld.decompose(_p, _q, _s);
  return [_p.x, _p.y, _p.z, _q.x, _q.y, _q.z, _q.w];
}

export class NetMgr {
  constructor({ scene, room, serverUrl, nick, color, sendHz = 12, onObjectState = null, onGameInput = null, onWire = null, onPeerLeave = null, onHostChange = null, onFatal = null, onRetry = null, videoCanvas = null, videoAudio = null, onHostVideo = null, onHostVideoEnded = null, iceServers = null, sessionId = null, now = () => performance.now() }) {
    this.scene = scene;
    this.sendHz = sendHz;
    this._now = now;
    // Stable per-tab id so the server can give us the host role back after our
    // OWN page reload (cross-core cartridge swap) instead of migrating it away.
    const sid = sessionId || stableSessionId();
    // THE TRANSPORT HALF (CODEX ARC-2, [[src/net/RoomConnection.js]]). Every
    // field this constructor used to declare for the socket, the reconnect
    // backoff, the COR-9 handshake and the M1.4 host election now has exactly one
    // home, shared with DesktopNet — with the "why" notes that go with them. The
    // delegating accessors further down keep `this.ws` / `this._connected` /
    // `this._fatal` / `this.lastClose` / … reading (and writing) exactly the way
    // the rest of this file, scripts/test-net.mjs and src/main.js always did.
    //
    // The hooks below are the only parts of the lifecycle that are genuinely
    // this client's: what to route a message to, and what VR-side scene state to
    // tear down. DesktopNet passes its own, and neither can drift from the shared
    // rules any more.
    this._conn = new RoomConnection({
      room, nick, color, serverUrl, sessionId: sid,
      logPrefix: '[net]',
      onHostChange, onFatal, onRetry,
      presence: () => this.presence,
      objects: () => this.objects,
      setObjectState: (key, value) => this.setObjectState(key, value),
      isHost: () => this.isHost(),
      reopen: () => this.connect(),
      onMessage: (msg) => this._route(msg),
      // CONNECTION LOST (or our own close, already announced): the socket is
      // gone, so a 'bye' cannot reach anyone — tear the capture down locally
      // and don't pretend to announce it.
      onSocketClosed: () => { this.video.stopBroadcast({ announce: false }); },
      onBeforeReopen: () => {
        // Presence/avatars are cleared because the server assigns a NEW peer id
        // on reconnect, so the old roster is meaningless; the shared object state
        // is replayed by the server.
        this.avatars.removeAll();
        this.presence.clear();
        // The old socket is genuinely gone here (this path only runs after an
        // UNEXPECTED close), so the local teardown must still happen but the byes
        // cannot be sent — that is correct, not a regression. `announce:false`
        // says so explicitly instead of leaning on the send gate to swallow them.
        this.video.disable({ announce: false });
      },
    });
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
    // `ws` / `_connected` are initialised by the RoomConnection above.
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

  // --- transport state, delegated to the composed RoomConnection -------------
  //
  // Accessors, not a rename. The socket state moved into
  // [[src/net/RoomConnection.js]] so DesktopNet and this class share ONE copy of
  // it (CODEX ARC-2), but the field NAMES are load-bearing public surface:
  // src/main.js reads `net._connected`, `net.room` and `net.lastClose`;
  // src/TestApi.js reads `_serverElects`; scripts/test-net.mjs reads AND WRITES
  // `_fatal` and `_reconnectTimer` to isolate the reconnect guard. Getter+setter
  // pairs keep every one of those working byte-for-byte while there is still only
  // one copy of the value.
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

  // …and the methods, for the same reason: these names are what the close
  // handler's siblings, main.js and the suites call. Each is one line to the
  // shared implementation.
  _setHost(id, opts) { return this._conn._setHost(id, opts); }
  _noteFatal(f) { return this._conn._noteFatal(f); }
  _checkServerProtocol(v) { return this._conn._checkServerProtocol(v); }
  _noteSessionEstablished() { return this._conn._noteSessionEstablished(); }
  _scheduleReconnect(why = null) { return this._conn._scheduleReconnect(why); }
  _noteFallbackClaim(raw) { return this._conn._noteFallbackClaim(raw); }
  _runFallbackElection() { return this._conn._runFallbackElection(); }
  _armFallbackElection() { return this._conn._armFallbackElection(); }
  _clearFallbackTimer() { return this._conn._clearFallbackTimer(); }

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
    // The socket itself belongs to [[src/net/RoomConnection.js]] (CODEX ARC-2):
    // the URL, the JOIN, the COR-9 HELLO gate, the reconnect/soft-refusal backoff
    // and the whole close handler are shared with DesktopNet. What is left here
    // is this client's routing table plus the VR-side teardown hooks handed to
    // the connection in the constructor.
    this._conn.open();
    return this;
  }

  // A decoded message from the room server. Reached through the RoomConnection's
  // `onMessage` hook, which has ALREADY judged a HELLO's protocol version and
  // noted the session — so a HELLO that arrives here is one we have decided to
  // trust, and the roster below can be acted on.
  _route(msg) {
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
    this._conn.beginDisconnect();
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
    this._conn.closeSocket();
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
