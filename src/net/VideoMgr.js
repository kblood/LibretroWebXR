// VideoMgr: M1.2 host-authoritative game video. The HOST captures its emulator
// canvas (`canvas.captureStream()`) plus the game's audio and sends them,
// send-only, to every other peer over a WebRTC connection; each non-host CLIENT
// receives the tracks, wraps them in a <video> element, and (via onHostVideo)
// paints it onto its in-world TV. So a peer that isn't running the game still
// sees — and hears — the host's frames.
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
// update() each frame with the roster + the SERVER-ELECTED host (M1.4 — no longer
// "whoever last wrote the tv state"), and exposes startVideoBroadcast() /
// stopVideoBroadcast() / reattach() to main.js.
//
// Liveness rules that this class is responsible for (all of them were missing
// before M1.4, which made every interruption permanent AND invisible):
//   • startBroadcast() re-captures when the host's canvas CHANGED (a live primary
//     reboot — arming the light gun / mouse, a cross-core swap — stands up a whole
//     new canvas) and replaceTrack()s it into the live sender connections.
//     Otherwise every client froze on the last frame of the retired canvas while
//     every diagnostic still said "healthy".
//   • Every PC reports connection/ICE failure and every received track reports
//     `ended`, so a dead path is torn down (→ onHostVideoEnded) instead of leaving
//     a stopped stream on the TV with receivingCount() still saying 1.
//   • An `epoch` rides each offer: when the host rebuilds a peer's PC from
//     scratch, the client throws away its stale answering PC rather than trying to
//     renegotiate a connection that no longer exists on the other side.
//   • reattach() re-hands the live <video> to the app, because a local re-route on
//     the client (power toggle, console spawn, repatch) overwrites the TV texture
//     with a local canvas and nothing else would ever put the stream back.

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

export class VideoMgr {
  constructor({ send, getSelfId, getCaptureCanvas, getCaptureAudio, onHostVideo, onHostVideoEnded, iceServers = DEFAULT_ICE, fps = 30 }) {
    this.send = send;                       // ({to,kind,data}) → ws, channel-stamped by NetMgr
    this.getSelfId = getSelfId;             // () => string|null
    this.getCaptureCanvas = getCaptureCanvas || (() => null); // () => HTMLCanvasElement
    this.getCaptureAudio = getCaptureAudio || (() => null);   // () => MediaStream|null
    this.onHostVideo = onHostVideo || (() => {});         // (videoEl, hostId, stream) => void
    this.onHostVideoEnded = onHostVideoEnded || (() => {}); // (hostId) => void
    this.iceServers = iceServers;
    this.fps = fps;

    this.sourceStream = null;   // host only: the captured canvas (+audio) MediaStream
    this._sourceCanvas = null;  // which canvas sourceStream was captured from
    this._epoch = 0;            // bumped per sender PC creation (stale-offer guard)
    this.amHost = false;
    this.hostId = null;
    this._lastHostId = null;
    this._pcs = new Map();      // peerId -> { pc, initiator, stream, videoEl, addedSource, epoch }
  }

  // --- Host side: start / stop broadcasting our canvas ----------------------

  /**
   * Begin (or re-point) the capture of the emulator canvas + game audio.
   *
   * Idempotent for an UNCHANGED canvas, but deliberately NOT a no-op when the
   * canvas identity changed or the existing capture died: a live primary reboot
   * (light-gun/mouse arm, cross-core swap) retires the old canvas and installs a
   * new one, and the old captureStream track stays `live` forever while painting
   * nothing. That silent freeze is what this re-capture path fixes; the new track
   * is swapped into existing sender PCs with replaceTrack (no renegotiation, no
   * visible reconnect).
   */
  startBroadcast() {
    const canvas = this.getCaptureCanvas();
    if (!canvas || typeof canvas.captureStream !== 'function') {
      console.warn('[video] no capturable canvas');
      return false;
    }
    const audioTrack = () => {
      try { return this.getCaptureAudio()?.getAudioTracks?.()[0] || null; }
      catch (e) { console.warn('[video] audio capture failed', e); return null; }
    };
    const hasLiveVideo = !!this.sourceStream
      && this.sourceStream.getVideoTracks().some((t) => t.readyState === 'live');
    if (hasLiveVideo && this._sourceCanvas === canvas) {
      // Already streaming exactly this canvas — just make sure every sender PC
      // actually carries the track (a PC created before startBroadcast wouldn't),
      // and pick up game audio that only appeared after the first capture (a core
      // installs its audio graph a moment after its canvas exists).
      const late = audioTrack();
      if (late && !this.sourceStream.getAudioTracks().some((t) => t.id === late.id)) {
        this.sourceStream.addTrack(late);
        for (const entry of this._pcs.values()) if (entry.initiator && entry.addedSource) this._replaceSource(entry);
      }
      for (const entry of this._pcs.values()) if (entry.initiator) this._addSource(entry);
      return true;
    }

    let captured;
    try { captured = canvas.captureStream(this.fps); }
    catch (e) { console.warn('[video] captureStream failed', e); return false; }
    const nextVideo = captured.getVideoTracks()[0] || null;
    if (!nextVideo) { console.warn('[video] captureStream produced no video track'); return false; }
    // Game audio: canvas.captureStream() carries none, so tap the emulator's
    // audio branch (main.js → SpatialAudio.captureStream) and add its track.
    const nextAudio = audioTrack();

    // ONE outbound MediaStream for the whole session, mutated in place. Its
    // identity is the `msid` the remote peer sees, and re-capturing into a FRESH
    // stream changed it: the swapped video track kept the old msid (replaceTrack
    // doesn't renegotiate) while the audio track was announced under the new one,
    // so the client's `ontrack` handed it an audio-ONLY stream. Its <video> then
    // had videoWidth 0 and decoded no frame ever again while every metric still
    // said "receiving" — the exact frozen-picture-after-a-host-reboot bug.
    const prevCanvas = this._sourceCanvas;
    if (!this.sourceStream) this.sourceStream = new MediaStream();
    const out = this.sourceStream;
    const retiredVideo = [];
    for (const t of out.getVideoTracks()) {
      if (t.id === nextVideo.id) continue;
      retiredVideo.push(t);              // ours (a canvas capture) — safe to stop
      out.removeTrack(t);
    }
    out.addTrack(nextVideo);
    if (nextAudio) {
      // Never stop() a retired audio track: it belongs to the app's audio graph
      // (a MediaStreamAudioDestinationNode tap), and stopping it would silence
      // that tap permanently. Dropping it from the stream is enough.
      for (const t of out.getAudioTracks()) if (t.id !== nextAudio.id) out.removeTrack(t);
      out.addTrack(nextAudio);
    }
    this._sourceCanvas = canvas;

    // Re-point every live sender at the new tracks (or add them if this is the
    // first capture for that PC).
    const swaps = [];
    for (const entry of this._pcs.values()) {
      if (!entry.initiator) continue;
      if (entry.addedSource) swaps.push(...this._replaceSource(entry));
      else this._addSource(entry);
    }
    // Stop the retired capture only once the swaps have landed, so clients don't
    // see a black gap while replaceTrack() is in flight.
    if (retiredVideo.length) {
      const stopPrev = () => { for (const t of retiredVideo) { try { t.stop(); } catch { /* ok */ } } };
      if (swaps.length) Promise.allSettled(swaps).then(stopPrev);
      else stopPrev();
    }
    if (prevCanvas && prevCanvas !== canvas) {
      console.log(`[video] capture re-pointed: #${prevCanvas?.id || '?'} → #${canvas.id || '?'}`);
    }
    return true;
  }

  /**
   * Stop capturing and drop every sender connection.
   *
   * `announce` distinguishes a CLEAN stop (the socket is still open — tell each
   * client with a 'bye' so it reverts immediately instead of waiting ~30 s for
   * ICE consent to expire) from a CONNECTION LOST stop (the socket is already
   * gone — the byes cannot possibly reach anyone, so don't even try). Callers
   * that hold the socket decide; see NetMgr.disconnect() vs the ws 'close'
   * handler / _scheduleReconnect().
   */
  stopBroadcast({ announce = true } = {}) {
    // Only the canvas-capture VIDEO tracks are ours to stop. The audio track is
    // borrowed from the app's audio graph (a cached MediaStreamAudioDestinationNode
    // tap), and a stopped track can never be restarted — stopping it here silenced
    // the game audio for the rest of the page's life, so a host that was demoted
    // and later promoted again broadcast a mute picture.
    if (this.sourceStream) for (const t of this.sourceStream.getVideoTracks()) { try { t.stop(); } catch { /* ok */ } }
    this.sourceStream = null;
    this._sourceCanvas = null;
    // Drop our sender connections; tell each client explicitly (a 'bye') so it
    // reverts immediately instead of waiting ~30s for ICE consent to expire.
    for (const id of [...this._pcs.keys()]) {
      const entry = this._pcs.get(id);
      if (!entry?.initiator) continue;
      if (announce) {
        try { this.send({ to: id, kind: 'bye', data: { epoch: entry.epoch } }); } catch { /* ok */ }
      }
      this._closePeer(id);
    }
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
      // when its offer arrives in handleSignal). Anything else is stale — and so
      // is the host's own PC once the host has dropped off the roster (a host
      // that died without a clean close: presence prunes it in ~5s, which is the
      // client-side liveness signal that the picture is gone).
      for (const id of [...this._pcs.keys()]) {
        if (id !== hostId || !present.has(id)) this._closePeer(id);
      }
    }
    // amHost && !sourceStream → not broadcasting yet; open nothing.
  }

  _ensurePeer(peerId, initiator) {
    const existing = this._pcs.get(peerId);
    if (existing) {
      // Reuse only in the SAME direction. A host-role flap can leave an answering
      // entry behind; handing it back to a caller that wants to SEND marked the
      // track "added" while onnegotiationneeded (closed over the old `initiator`)
      // refused to offer — that peer then got no video for the rest of the session.
      if (!!existing.initiator === !!initiator) return existing;
      this._closePeer(peerId);
    }
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const epoch = initiator ? ++this._epoch : 0;
    const entry = { pc, initiator, stream: null, videoEl: null, addedSource: false, epoch };
    this._pcs.set(peerId, entry);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ to: peerId, kind: 'ice', data: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
    };
    pc.ontrack = (e) => { // clients only — host PCs are send-only
      // Accumulate into OUR OWN stream rather than adopting e.streams[0]. The
      // remote stream a track arrives on is whatever msid the host announced it
      // under, and a host that re-captures mid-session announces its audio under
      // a new one — adopting it replaced the picture with an audio-only stream
      // (see the msid note in startBroadcast). Keyed by kind so a re-negotiated
      // track supersedes its predecessor instead of piling up.
      if (!entry.stream) entry.stream = new MediaStream();
      for (const t of entry.stream.getTracks()) {
        if (t.kind === e.track.kind && t.id !== e.track.id) entry.stream.removeTrack(t);
      }
      if (!entry.stream.getTracks().some((t) => t.id === e.track.id)) entry.stream.addTrack(e.track);
      // A VIDEO track that ENDS (host stopped capturing / renegotiated it away)
      // must revert the TV; without this the client kept a dead stream on screen
      // while every metric still reported "receiving". Audio ending is not a
      // reason to blank the picture, so it doesn't tear the connection down.
      if (e.track.kind === 'video') {
        try { e.track.addEventListener('ended', () => this._onTrackEnded(peerId)); } catch { /* ok */ }
      }
      this._attach(peerId);
    };
    pc.onnegotiationneeded = async () => {
      if (!entry.initiator) return; // only the host (offerer) negotiates
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.send({ to: peerId, kind: 'offer', data: { type: offer.type, sdp: offer.sdp, epoch: entry.epoch } });
      } catch (e) { console.warn('[video] offer failed', e); }
    };
    // Failure detection. Without these, an ICE failure was permanent AND silent:
    // nothing ever closed the PC, so no onHostVideoEnded fired and no new offer
    // was ever made.
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'failed' || st === 'closed' || st === 'disconnected') this._onPeerBroken(peerId, `conn:${st}`);
    };
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === 'failed' || st === 'closed') this._onPeerBroken(peerId, `ice:${st}`);
    };
    return entry;
  }

  // A PC died. Tear it down: as HOST update() re-creates it on the next tick
  // (fresh epoch → the client rebuilds too); as CLIENT the close reverts the TV
  // and we wait for the host's next offer.
  _onPeerBroken(peerId, why) {
    const entry = this._pcs.get(peerId);
    if (!entry) return;
    // 'disconnected' can be transient — only act if it hasn't recovered.
    if (why === 'conn:disconnected') {
      if (entry._graceTimer) return;
      entry._graceTimer = setTimeout(() => {
        entry._graceTimer = null;
        const cur = this._pcs.get(peerId);
        if (cur !== entry) return;
        const st = entry.pc.connectionState;
        if (st === 'connected' || st === 'connecting') return;
        console.warn(`[video] peer ${String(peerId).slice(0, 8)} video path broken (${why}) — rebuilding`);
        this._closePeer(peerId);
      }, 4000);
      return;
    }
    console.warn(`[video] peer ${String(peerId).slice(0, 8)} video path broken (${why})`);
    this._closePeer(peerId);
  }

  _onTrackEnded(peerId) {
    const entry = this._pcs.get(peerId);
    if (!entry || entry.initiator) return;
    console.warn('[video] host track ended — reverting the local screen');
    this._closePeer(peerId);
  }

  // Host: add the captured tracks to a sender PC (once) → renegotiation.
  _addSource(entry) {
    if (!this.sourceStream || !entry || entry.addedSource) return;
    for (const t of this.sourceStream.getTracks()) {
      try { entry.pc.addTrack(t, this.sourceStream); } catch (e) { console.warn('[video] addTrack', e); }
    }
    entry.addedSource = true;
  }

  // Host: swap a re-captured canvas/audio into an EXISTING sender PC in place.
  // Returns the pending replaceTrack promises so the caller can stop the old
  // tracks only once they've landed.
  _replaceSource(entry) {
    const pending = [];
    if (!this.sourceStream || !entry) return pending;
    const byKind = { video: this.sourceStream.getVideoTracks()[0] || null, audio: this.sourceStream.getAudioTracks()[0] || null };
    const seen = new Set();
    for (const sender of entry.pc.getSenders?.() || []) {
      const kind = sender.track?.kind || (sender.getParameters?.()?.encodings ? 'video' : null);
      if (!kind || !byKind[kind]) continue;
      seen.add(kind);
      try { pending.push(sender.replaceTrack(byKind[kind])); }
      catch (e) { console.warn('[video] replaceTrack', e); }
    }
    // A kind we now have but never sent (e.g. audio only appeared on this boot)
    // still needs a real addTrack → renegotiation.
    for (const [kind, track] of Object.entries(byKind)) {
      if (!track || seen.has(kind)) continue;
      try { entry.pc.addTrack(track, this.sourceStream); } catch (e) { console.warn('[video] addTrack', e); }
    }
    return pending;
  }

  /**
   * The host told us it stopped broadcasting (stopBroadcast's 'bye'). Revert the
   * TV now rather than waiting ~30 s for ICE consent to expire.
   *
   * Never executed before 2026-08-14 — 'bye' wasn't in SIGNAL_KINDS, so the
   * message was dropped by validate() at both ends. Two guards it needs now that
   * it can actually run:
   *   • RECEIVE side only. A bye means "I have stopped sending to you". Acting on
   *     our own SENDER entry would let any client tear down the host's outbound
   *     PC just by sending a bye — update() rebuilds it on the next tick, so it
   *     would be a peer-triggered reconnect flap, not a clean stop.
   *   • Epoch-matched, exactly like the offer path. The bye carries the epoch of
   *     the host PC it belongs to; if we have since rebuilt against a NEWER offer
   *     epoch, this bye is about a connection that no longer exists on our side
   *     and honouring it would kill a live picture. Epoch 0/absent means a sender
   *     that doesn't stamp epochs — honour it unconditionally.
   */
  _handleBye(msg) {
    const entry = this._pcs.get(msg.from);
    if (!entry || entry.initiator) return;
    const epoch = Number(msg.data?.epoch) || 0;
    if (epoch && entry.remoteEpoch != null && entry.remoteEpoch !== epoch) return;
    this._closePeer(msg.from);
  }

  async handleSignal(msg) {
    if (!msg.from) return;
    if (msg.kind === 'bye') {              // host stopped broadcasting, cleanly
      this._handleBye(msg);
      return;
    }
    let entry = this._pcs.get(msg.from);
    if (msg.kind === 'offer') {
      const epoch = Number(msg.data?.epoch) || 0;
      // A NEW epoch means the host rebuilt its PC from scratch — our answering
      // side is dead (different ICE credentials, possibly already closed), so
      // renegotiating on it would silently never connect. Rebuild instead.
      if (entry && !entry.initiator && entry.remoteEpoch != null && entry.remoteEpoch !== epoch) {
        this._closePeer(msg.from);
        entry = null;
      }
      if (!entry) entry = this._ensurePeer(msg.from, false);
      entry.remoteEpoch = epoch;
    }
    if (!entry) entry = this._ensurePeer(msg.from, false);
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

  // Client: wrap a received stream in an autoplaying <video> and hand it to
  // main.js to paint onto the TV (as a THREE.VideoTexture).
  //
  // The element stays MUTED on purpose: an unmuted element can be paused by the
  // browser's autoplay policy, which would freeze the TEXTURE too. The audio
  // track is handed to the app alongside it (onHostVideo's 3rd argument) so it
  // can route the sound through its own AudioContext (already user-gesture
  // resumed) — or unmute the element itself on the flat desktop page.
  _attach(peerId) {
    const entry = this._pcs.get(peerId);
    if (!entry || !entry.stream) return;
    // Re-bind (don't bail) when the element exists but points at a different
    // stream — renegotiation hands us a new MediaStream.
    if (entry.videoEl && entry.videoEl.srcObject === entry.stream) {
      this.onHostVideo(entry.videoEl, peerId, entry.stream);
      return;
    }
    const v = entry.videoEl || document.createElement('video');
    v.autoplay = true;
    v.muted = true;
    v.playsInline = true;
    v.srcObject = entry.stream;
    try { v.play?.()?.catch?.(() => {}); } catch { /* autoplay may defer */ }
    entry.videoEl = v;
    this.onHostVideo(v, peerId, entry.stream);
  }

  /**
   * Re-hand the live host video to the app (client side). main.js calls this after
   * ANY local video re-route, because those paint a local canvas over the host's
   * picture and there is otherwise no path back. Returns true if a stream was
   * re-handed.
   */
  reattach() {
    for (const [peerId, entry] of this._pcs) {
      if (entry.initiator || !entry.videoEl || !entry.stream) continue;
      const live = entry.stream.getVideoTracks().some((t) => t.readyState === 'live');
      if (!live) continue;
      try { entry.videoEl.play?.()?.catch?.(() => {}); } catch { /* ok */ }
      this.onHostVideo(entry.videoEl, peerId, entry.stream);
      return true;
    }
    return false;
  }

  /** The live host <video> element, or null (client side). */
  hostVideoEl() {
    for (const entry of this._pcs.values()) {
      if (!entry.initiator && entry.videoEl) return entry.videoEl;
    }
    return null;
  }

  _closePeer(peerId) {
    const entry = this._pcs.get(peerId);
    if (!entry) return;
    const wasReceiving = !!entry.videoEl;
    if (entry._graceTimer) { clearTimeout(entry._graceTimer); entry._graceTimer = null; }
    if (entry.videoEl) { try { entry.videoEl.srcObject = null; } catch { /* ok */ } }
    entry.videoEl = null;
    entry.stream = null;
    try { entry.pc.close(); } catch { /* ok */ }
    this._pcs.delete(peerId);
    if (wasReceiving) this.onHostVideoEnded(peerId); // client reverts to local TV
  }

  /**
   * Tear the whole video layer down (leaving the room, or re-opening the socket).
   *
   * stopBroadcast FIRST: it is the only thing that sends the teardown 'bye' to
   * each client, and it can only send to peers that still have an entry. The
   * old order closed every PC first, so leaving the room (or turning video off)
   * silently dropped the connection and every client sat on a frozen picture
   * until ICE consent expired — the same symptom as the missing SIGNAL_KIND.
   *
   * That internal reorder alone was INERT on the real path, though: the owner
   * (NetMgr / DesktopNet) closed the socket BEFORE calling us, and its send
   * closure is gated on `_connected && ws`, so every bye was swallowed anyway.
   * The owner now announces before it closes — and passes `announce:false` on
   * the paths where the socket is genuinely already gone (unexpected close →
   * reconnect), where the local teardown must still happen but no message can
   * ever reach a peer.
   */
  disable({ announce = true } = {}) {
    this.stopBroadcast({ announce });
    for (const id of [...this._pcs.keys()]) this._closePeer(id);
    this._lastHostId = null;
  }

  debugApi() {
    const connected = (e) => ['connected', 'completed'].includes(e.pc.iceConnectionState) || e.pc.connectionState === 'connected';
    const liveTracks = (stream) => (stream?.getTracks?.() || []).filter((t) => t.readyState === 'live').length;
    // "receiving" must mean a live VIDEO track. Counting any live track let an
    // audio-only stream report a healthy picture (see startBroadcast's msid note).
    const liveVideo = (stream) => (stream?.getVideoTracks?.() || []).filter((t) => t.readyState === 'live').length;
    return {
      amHost: () => this.amHost,
      sourcing: () => !!this.sourceStream,
      sourceCanvas: () => this._sourceCanvas?.id ?? null,
      sourceTracks: () => (this.sourceStream?.getTracks?.() || []).map((t) => `${t.kind}:${t.readyState}`),
      peerStates: () => [...this._pcs.entries()].map(([id, e]) => ({ id, initiator: e.initiator, conn: e.pc.connectionState, ice: e.pc.iceConnectionState, video: !!e.videoEl, epoch: e.epoch, liveTracks: liveTracks(e.stream) })),
      connectedCount: () => [...this._pcs.values()].filter(connected).length,
      // "receiving" now means a LIVE VIDEO track, not merely "an element was
      // created once" — the old definitions kept reporting 1 over a dead picture.
      receivingCount: () => [...this._pcs.values()].filter((e) => !!e.videoEl && liveVideo(e.stream) > 0).length,
      sendingCount: () => [...this._pcs.values()].filter((e) => e.addedSource).length,
      hasAudio: () => (this.sourceStream?.getAudioTracks?.().length || 0) > 0,
      receivingAudio: () => [...this._pcs.values()].some((e) => !e.initiator && (e.stream?.getAudioTracks?.().length || 0) > 0),
      // Client-side liveness of the host's picture. `receivingCount()` only says a
      // live track exists; a headless smoke needs to prove the FRAMES ADVANCE
      // (a frozen picture — decoder stalled, element auto-paused by the autoplay
      // policy — still counts as "receiving"). Sample twice and compare.
      hostVideo: () => {
        const el = this.hostVideoEl();
        if (!el) return null;
        let frames = null;
        try { frames = el.getVideoPlaybackQuality?.()?.totalVideoFrames ?? null; } catch { /* ok */ }
        return { time: el.currentTime, w: el.videoWidth, h: el.videoHeight, paused: !!el.paused, frames };
      },
      reattach: () => this.reattach(),
    };
  }
}
