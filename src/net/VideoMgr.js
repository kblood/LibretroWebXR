// VideoMgr: M1.2 host-authoritative game video. The HOST captures its emulator
// canvas (`canvas.captureStream()`) and sends it, send-only, to every other peer
// over a WebRTC connection; each non-host CLIENT receives the track, wraps it in
// a <video> element, and (via onHostVideo) paints it onto its in-world TV. So a
// peer that isn't running the game still sees the host's frames.
//
// Mirrors [[src/net/VoiceMgr.js]] (one RTCPeerConnection per peer, signaled over
// the room WebSocket) with two differences:
//   1. **Directional, not a mesh.** Media flows host→client only. The host is the
//      sole offerer for every pair, so there's no glare to break — no
//      smaller-id-offers rule needed.
//   2. **Separate signaling channel.** Its SIGNAL messages carry channel:'video'
//      (see [[src/net/NetProtocol.js]] makeSignal) so they never collide with the
//      voice mesh's offers/answers/ice on the same relay. NetMgr routes by it.
//
// Owned by [[src/net/NetMgr.js]]: NetMgr routes video-channel SIGNALs here, calls
// update() each frame with the roster + who the host is (the `tv`-state owner),
// and exposes startVideoBroadcast()/stopVideoBroadcast() to main.js. The host is
// whoever booted the room's game; on a host change we tear down and rebuild.

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

export class VideoMgr {
  constructor({ send, getSelfId, getCaptureCanvas, onHostVideo, onHostVideoEnded, iceServers = DEFAULT_ICE, fps = 30 }) {
    this.send = send;                       // ({to,kind,data}) → ws, channel-stamped by NetMgr
    this.getSelfId = getSelfId;             // () => string|null
    this.getCaptureCanvas = getCaptureCanvas || (() => null); // () => HTMLCanvasElement
    this.onHostVideo = onHostVideo || (() => {});         // (videoEl, hostId) => void
    this.onHostVideoEnded = onHostVideoEnded || (() => {}); // (hostId) => void
    this.iceServers = iceServers;
    this.fps = fps;

    this.sourceStream = null;   // host only: the captured canvas MediaStream
    this.amHost = false;
    this.hostId = null;
    this._lastHostId = null;
    this._pcs = new Map();      // peerId -> { pc, initiator, stream, videoEl, addedSource }
  }

  // --- Host side: start / stop broadcasting our canvas ----------------------

  // Begin capturing the emulator canvas. Idempotent. The actual sender PCs are
  // (re)built on the next update() once we're recognised as the host; if any
  // sender PCs already exist, add the track now so they renegotiate.
  startBroadcast() {
    if (this.sourceStream) return true;
    const canvas = this.getCaptureCanvas();
    if (!canvas || typeof canvas.captureStream !== 'function') {
      console.warn('[video] no capturable canvas');
      return false;
    }
    try { this.sourceStream = canvas.captureStream(this.fps); }
    catch (e) { console.warn('[video] captureStream failed', e); return false; }
    for (const entry of this._pcs.values()) if (entry.initiator) this._addSource(entry);
    return true;
  }

  stopBroadcast() {
    if (this.sourceStream) for (const t of this.sourceStream.getTracks()) t.stop();
    this.sourceStream = null;
    // Drop our sender connections; clients revert to their local TV on close.
    for (const id of [...this._pcs.keys()]) if (this._pcs.get(id).initiator) this._closePeer(id);
  }

  // --- Reconcile connections against the roster + host role (per frame) -----

  update({ peerIds = [], selfId = null, hostId = null } = {}) {
    // A host handover invalidates every existing role/direction — wipe and
    // rebuild cleanly rather than trying to flip a send PC into a receive one.
    if (hostId !== this._lastHostId) {
      for (const id of [...this._pcs.keys()]) this._closePeer(id);
      this._lastHostId = hostId;
    }
    this.hostId = hostId;
    this.amHost = !!selfId && selfId === hostId;
    const present = new Set(peerIds);

    if (this.amHost && this.sourceStream) {
      // Stream to every other peer (we're the sole offerer).
      for (const id of peerIds) {
        if (id === selfId) continue;
        this._addSource(this._ensurePeer(id, true));
      }
      for (const id of [...this._pcs.keys()]) if (!present.has(id)) this._closePeer(id);
    } else if (!this.amHost) {
      // We only ever receive from the current host (its PC is created lazily
      // when its offer arrives in handleSignal). Anything else is stale.
      for (const id of [...this._pcs.keys()]) if (id !== hostId) this._closePeer(id);
    }
    // amHost && !sourceStream → not broadcasting yet; open nothing.
  }

  _ensurePeer(peerId, initiator) {
    let entry = this._pcs.get(peerId);
    if (entry) return entry;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    entry = { pc, initiator, stream: null, videoEl: null, addedSource: false };
    this._pcs.set(peerId, entry);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ to: peerId, kind: 'ice', data: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
    };
    pc.ontrack = (e) => { // clients only — host PCs are send-only
      entry.stream = e.streams[0] || new MediaStream([e.track]);
      this._attach(peerId);
    };
    pc.onnegotiationneeded = async () => {
      if (!initiator) return; // only the host (offerer) negotiates
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.send({ to: peerId, kind: 'offer', data: { type: offer.type, sdp: offer.sdp } });
      } catch (e) { console.warn('[video] offer failed', e); }
    };
    return entry;
  }

  // Host: add the captured video track to a sender PC (once) → renegotiation.
  _addSource(entry) {
    if (!this.sourceStream || entry.addedSource) return;
    for (const t of this.sourceStream.getVideoTracks()) entry.pc.addTrack(t, this.sourceStream);
    entry.addedSource = true;
  }

  async handleSignal(msg) {
    if (!msg.from) return;
    // A client meets the host here: its offer lazily creates the answering PC.
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
    } catch (e) { console.warn('[video] signal handling error', e); }
  }

  // Client: wrap a received stream in a muted, autoplaying <video> and hand it to
  // main.js to paint onto the TV (as a THREE.VideoTexture).
  _attach(peerId) {
    const entry = this._pcs.get(peerId);
    if (!entry || !entry.stream || entry.videoEl) return;
    const v = document.createElement('video');
    v.autoplay = true;
    v.muted = true;       // video track only; voice rides the separate audio mesh
    v.playsInline = true;
    v.srcObject = entry.stream;
    try { v.play?.()?.catch?.(() => {}); } catch { /* autoplay may defer */ }
    entry.videoEl = v;
    this.onHostVideo(v, peerId);
  }

  _closePeer(peerId) {
    const entry = this._pcs.get(peerId);
    if (!entry) return;
    const wasReceiving = !!entry.videoEl;
    if (entry.videoEl) { try { entry.videoEl.srcObject = null; } catch { /* ok */ } }
    try { entry.pc.close(); } catch { /* ok */ }
    this._pcs.delete(peerId);
    if (wasReceiving) this.onHostVideoEnded(peerId); // client reverts to local TV
  }

  disable() {
    for (const id of [...this._pcs.keys()]) this._closePeer(id);
    this.stopBroadcast();
    this._lastHostId = null;
  }

  debugApi() {
    const connected = (e) => ['connected', 'completed'].includes(e.pc.iceConnectionState) || e.pc.connectionState === 'connected';
    return {
      amHost: () => this.amHost,
      sourcing: () => !!this.sourceStream,
      peerStates: () => [...this._pcs.entries()].map(([id, e]) => ({ id, initiator: e.initiator, conn: e.pc.connectionState, ice: e.pc.iceConnectionState, video: !!e.videoEl })),
      connectedCount: () => [...this._pcs.values()].filter(connected).length,
      receivingCount: () => [...this._pcs.values()].filter((e) => !!e.videoEl).length,
      sendingCount: () => [...this._pcs.values()].filter((e) => e.addedSource).length,
    };
  }
}
