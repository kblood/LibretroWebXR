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
import { MSG, makeJoin, makePose, makeSignal, makeState, makeInput, makeWire, hostInputTarget, encode, decode } from './NetProtocol.js';

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
  constructor({ scene, room, serverUrl, nick, color, sendHz = 12, onObjectState = null, onGameInput = null, onWire = null, onPeerLeave = null, videoCanvas = null, onHostVideo = null, onHostVideoEnded = null, iceServers = null, now = () => performance.now() }) {
    this.scene = scene;
    this.room = room || 'lobby';
    this.nick = nick || 'Player';
    this.color = color || '#88aaff';
    this.serverUrl = serverUrl || defaultServerUrl();
    this.sendHz = sendHz;
    this._now = now;
    // M0 hardening: optional TURN/STUN config for the WebRTC meshes (voice +
    // video). null → each manager uses its built-in STUN-only default. A full
    // list (built via NetProtocol.buildIceServers) is shared by both meshes so
    // peers behind symmetric NAT can relay through TURN.
    this.iceServers = iceServers;

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

  // The host = the peer that owns the shared `tv` state (whoever last booted the
  // room's game via setObjectState('tv', …)). null until someone has.
  hostId() { return this.objects.ownerOf('tv'); }

  // True when WE are the host (we own the tv state) → we run the authoritative
  // core and inject remote inputs, rather than forwarding our own.
  isHost() {
    const self = this.presence.selfId;
    return !!self && self === this.objects.ownerOf('tv');
  }

  // Forward one captured local logical input to the host, if there is a remote
  // one. Pure routing decision lives in NetProtocol.hostInputTarget; no-op when
  // we're the host or no game is loaded. Returns true if a message was sent.
  forwardGameInput({ player, btn, down }) {
    const to = hostInputTarget({ hostId: this.objects.ownerOf('tv'), selfId: this.presence.selfId });
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
    const url = `${this.serverUrl}${sep}room=${encodeURIComponent(this.room)}`;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { console.warn('[net] connect failed', e); return this; }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this._connected = true;
      ws.send(encode(makeJoin({ nick: this.nick, color: this.color })));
      console.log(`[net] connected to "${this.room}" as ${this.nick}`);
    });
    ws.addEventListener('message', (e) => {
      const msg = decode(typeof e.data === 'string' ? e.data : '');
      if (!msg) return;
      if (msg.type === MSG.SIGNAL) {                                  // WebRTC negotiation
        if (msg.channel === 'video') this.video.handleSignal(msg);   // host↔client game video
        else this.voice.handleSignal(msg);                           // voice mesh (default)
      }
      else if (msg.type === MSG.STATE) this._applyState(msg);         // room-object sync
      else if (msg.type === MSG.INPUT) this._applyGameInput(msg);     // game sync (host side)
      else if (msg.type === MSG.WIRE) this._applyWire(msg);           // transient ephemera
      else {
        // Roster + poses. For LEAVE we also fire the peer-leave callback so
        // callers (main.js) can clear any latched remote input from that peer.
        const leftId = (msg.type === MSG.LEAVE) ? msg.id : null;
        this.presence.apply(msg, this._now());
        if (leftId != null) {
          try { this._onPeerLeave?.(leftId); } catch (e) { console.warn('[net] onPeerLeave', e); }
        }
      }
    });
    ws.addEventListener('close', () => { this._connected = false; });
    ws.addEventListener('error', () => { /* close follows */ });
    return this;
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
    // Keep the voice mesh in step with the roster (no-op until voice enabled).
    if (this.voice.enabled) this.voice.syncPeers(peers.map((p) => p.id));
    // Reconcile the host→client video connections against the roster + who the
    // host is (the tv-state owner). No-op for a non-host with no host streaming.
    this.video.update({ peerIds: peers.map((p) => p.id), selfId: this.presence.selfId, hostId: this.objects.ownerOf('tv') });

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
    try { this.ws?.close(); } catch { /* already closing */ }
    this._connected = false;
    this.voice.disable();
    this.video.disable();
    this.avatars.removeAll();
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
      recvInputs: () => this._recvInputs.slice(),
      // M2 transient relay
      sendWire: (ch, data) => this.sendWire(ch, data),
      // M1.2 host video stream
      video: this.video.debugApi(),
      startVideoBroadcast: () => this.startVideoBroadcast(),
      stopVideoBroadcast: () => this.stopVideoBroadcast(),
    };
  }
}
