// VoiceMgr: M0.4 spatial voice. A WebRTC mesh — one RTCPeerConnection per remote
// peer — signaled over the existing room WebSocket (SIGNAL messages relayed by
// [[server/Hub.js]]). The local mic is added to every connection; each remote
// stream becomes a THREE.PositionalAudio attached to that peer's avatar head, so
// voices pan/attenuate with where people stand in the room.
//
// Owned by [[src/net/NetMgr.js]]: NetMgr routes SIGNAL messages here, calls
// syncPeers() each frame with the current roster, and exposes enableVoice() to
// the UI (getUserMedia needs a user gesture). Voice is off until enabled — no
// mic is touched on load.
//
// Glare avoidance: for each pair, the peer with the lexicographically smaller id
// is the sole offerer; the other only answers. Simple and deterministic — enough
// for one audio track per peer (full perfect-negotiation is overkill for M0).

import * as THREE from 'three';

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

export class VoiceMgr {
  constructor({ scene, avatars, send, getSelfId, iceServers = DEFAULT_ICE }) {
    this.scene = scene;          // SceneMgr — for .audioListener
    this.avatars = avatars;      // AvatarMgr — for getHead(peerId)
    this.send = send;            // ({ to, kind, data }) => void  (NetMgr → ws)
    this.getSelfId = getSelfId;  // () => string|null
    this.iceServers = iceServers;
    this.localStream = null;
    this.enabled = false;
    this.muted = false;
    this._pcs = new Map();       // peerId -> { pc, initiator, stream, audio }
  }

  async enable() {
    if (this.enabled) return true;
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (e) {
      console.warn('[voice] microphone unavailable/denied', e);
      return false;
    }
    if (this.muted) for (const t of this.localStream.getAudioTracks()) t.enabled = false;
    this.enabled = true;
    console.log('[voice] enabled');
    return true;
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.localStream) for (const t of this.localStream.getAudioTracks()) t.enabled = !this.muted;
    return this.muted;
  }
  toggleMute() { return this.setMuted(!this.muted); }

  // Reconcile peer connections against the current roster. Opens a connection to
  // each new peer (as offerer iff our id sorts first), closes ones that left,
  // and (re)tries attaching any received stream now that an avatar may exist.
  syncPeers(peerIds) {
    if (!this.enabled) return;
    const self = this.getSelfId();
    const set = new Set(peerIds);
    for (const id of peerIds) {
      if (id === self) continue;
      if (!this._pcs.has(id)) this._ensurePeer(id, self != null && String(self) < String(id));
      this._tryAttach(id);
    }
    for (const id of [...this._pcs.keys()]) if (!set.has(id)) this._closePeer(id);
  }

  _ensurePeer(peerId, initiator) {
    let entry = this._pcs.get(peerId);
    if (entry) return entry;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    entry = { pc, initiator, stream: null, audio: null };
    this._pcs.set(peerId, entry);

    for (const t of this.localStream.getTracks()) pc.addTrack(t, this.localStream);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ to: peerId, kind: 'ice', data: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
    };
    pc.ontrack = (e) => {
      entry.stream = e.streams[0] || new MediaStream([e.track]);
      this._tryAttach(peerId);
    };
    pc.onnegotiationneeded = async () => {
      if (!initiator) return; // only the offerer negotiates
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.send({ to: peerId, kind: 'offer', data: { type: offer.type, sdp: offer.sdp } });
      } catch (e) { console.warn('[voice] offer failed', e); }
    };
    return entry;
  }

  async handleSignal(msg) {
    if (!this.enabled || !msg.from) return;
    const entry = this._pcs.get(msg.from) || this._ensurePeer(msg.from, false);
    const pc = entry.pc;
    try {
      if (msg.kind === 'offer') {
        await pc.setRemoteDescription(msg.data);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.send({ to: msg.from, kind: 'answer', data: { type: answer.type, sdp: answer.sdp } });
      } else if (msg.kind === 'answer') {
        await pc.setRemoteDescription(msg.data);
      } else if (msg.kind === 'ice') {
        await pc.addIceCandidate(msg.data);
      }
    } catch (e) { console.warn('[voice] signal handling error', e); }
  }

  // Attach a received stream to the peer's avatar head as positional audio, once
  // both the stream AND the avatar exist (they arrive on independent channels).
  _tryAttach(peerId) {
    const entry = this._pcs.get(peerId);
    if (!entry || !entry.stream || entry.audio) return;
    const head = this.avatars.getHead?.(peerId);
    if (!head) return; // avatar not built yet — retried next syncPeers
    const pa = new THREE.PositionalAudio(this.scene.audioListener);
    pa.setMediaStreamSource(entry.stream);
    pa.setRefDistance(1.0);
    pa.setDistanceModel('inverse');
    pa.setMaxDistance(14);
    pa.setRolloffFactor(1.4);
    head.add(pa);
    entry.audio = pa;
  }

  _closePeer(peerId) {
    const entry = this._pcs.get(peerId);
    if (!entry) return;
    if (entry.audio) { try { entry.audio.parent?.remove(entry.audio); entry.audio.disconnect?.(); } catch { /* ok */ } }
    try { entry.pc.close(); } catch { /* ok */ }
    this._pcs.delete(peerId);
  }

  disable() {
    for (const id of [...this._pcs.keys()]) this._closePeer(id);
    if (this.localStream) for (const t of this.localStream.getTracks()) t.stop();
    this.localStream = null;
    this.enabled = false;
  }

  debugApi() {
    const connected = (e) => ['connected', 'completed'].includes(e.pc.iceConnectionState) || e.pc.connectionState === 'connected';
    return {
      enabled: () => this.enabled,
      muted: () => this.muted,
      peerStates: () => [...this._pcs.entries()].map(([id, e]) => ({ id, conn: e.pc.connectionState, ice: e.pc.iceConnectionState, audio: !!e.audio })),
      connectedCount: () => [...this._pcs.values()].filter(connected).length,
      receivingCount: () => [...this._pcs.values()].filter((e) => !!e.audio).length,
    };
  }
}
