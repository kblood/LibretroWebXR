// DesktopNet — the multiplayer layer for the FLAT-SCREEN desktop build. It is a
// slimmed-down sibling of [[src/net/NetMgr.js]]: same room server, same wire
// protocol, same host-authoritative netplay + host→client video, but with the
// VR-only parts removed (no avatars, no per-frame head/hand pose sync, no
// three.js). The VR NetMgr can't be reused directly because it imports three and
// samples scene transforms every frame; everything ELSE it relies on is pure and
// is reused here verbatim: PresenceState, RoomObjects, VideoMgr, NetProtocol.
//
// Netplay model (unchanged from the VR build, see [[src/net/VideoMgr.js]]):
//   • The HOST is whoever owns the shared `tv` object-state (last to load a game).
//     The host runs the one authoritative core and streams its canvas to peers.
//   • A non-host CLIENT shows the host's video and forwards its controls to the
//     host as player 2 (MSG.INPUT, routed by NetProtocol.hostInputTarget).
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

const HEARTBEAT_MS = 2000;

function defaultServerUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/`;
}

export class DesktopNet {
  constructor({
    room, nick, color, serverUrl,
    getCaptureCanvas,
    onTvState = null,        // (value, ownerId) => void  — room's loaded game changed
    onGameInput = null,      // ({from,player,btn,down}) => void — host receives remote input
    onRoster = null,         // (peers[]) => void — roster changed (count/names)
    onHostVideo = null,      // (videoEl, hostId) => void — client got host's stream
    onHostVideoEnded = null, // (hostId) => void — stream ended; revert
    onConnect = null,        // (selfId) => void
    onDisconnect = null,     // () => void
    iceServers = null,
    now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  } = {}) {
    this.room = room || 'lobby';
    this.nick = nick || 'Player';
    this.color = color || '#88aaff';
    this.serverUrl = serverUrl || defaultServerUrl();
    this._now = now;

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

    this.video = new VideoMgr({
      getSelfId: () => this.presence.selfId,
      getCaptureCanvas: () => (typeof getCaptureCanvas === 'function' ? getCaptureCanvas() : getCaptureCanvas),
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
  hostId() { return this.objects.ownerOf('tv'); }
  isHost() {
    const self = this.presence.selfId;
    return !!self && self === this.objects.ownerOf('tv');
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
    if (r && r.changed && msg.key === 'tv' && this._onTvState) {
      try { this._onTvState(r.value, r.id); } catch (e) { console.warn('[desktop-net] onTvState', e); }
    }
  }

  // --- host video ------------------------------------------------------------

  startVideoBroadcast() { return this.video.startBroadcast(); }
  stopVideoBroadcast() { this.video.stopBroadcast(); }

  // --- game input relay ------------------------------------------------------

  // Client → host: forward one logical RetroPad transition. No-op when we're the
  // host or no game is loaded (hostInputTarget returns null).
  forwardGameInput({ player, btn, down }) {
    const to = hostInputTarget({ hostId: this.objects.ownerOf('tv'), selfId: this.presence.selfId });
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
      recvInputs: () => this._recvInputs.slice(),
      video: this.video.debugApi(),
    };
  }

  // --- connection ------------------------------------------------------------

  connect() {
    const sep = this.serverUrl.includes('?') ? '&' : '?';
    const url = `${this.serverUrl}${sep}room=${encodeURIComponent(this.room)}`;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { console.warn('[desktop-net] connect failed', e); return this; }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this._connected = true;
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
      } else if (msg.type === MSG.HELLO) {
        this.presence.apply(msg, this._now());
        if (this._onConnect) { try { this._onConnect(this.presence.selfId); } catch (_) {} }
        this._emitRoster();
      } else {
        // JOIN / LEAVE / POSE roster traffic.
        this.presence.apply(msg, this._now());
        this._emitRoster();
      }
    });
    ws.addEventListener('close', () => {
      this._connected = false;
      if (this._onDisconnect) { try { this._onDisconnect(); } catch (_) {} }
    });
    ws.addEventListener('error', () => { /* close follows */ });
    return this;
  }

  // Called every frame from the app's rAF tick.
  tick(dtMs = 16) {
    // Prune peers that went silent without a clean LEAVE, then reconcile video.
    const pruned = this.presence.prune(this._now());
    if (pruned.length) this._emitRoster();
    this.video.update({
      peerIds: this.presence.peers().map((p) => p.id),
      selfId: this.presence.selfId,
      hostId: this.objects.ownerOf('tv'),
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
    try { this.ws?.close(); } catch { /* already closing */ }
    this._connected = false;
    this.video.disable();
    this.presence.clear();
    this.objects.clear();
    this._lastRosterSig = '';
  }
}
