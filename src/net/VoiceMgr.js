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
// That rule has ONE implementation, _isOfferer(); every site that constructs a
// peer must go through it. A PC built with the wrong role is unrecoverable: the
// larger id never offers, so nothing ever renegotiates. See _isOfferer().
//
// Liveness rules (CODEX_REVIEW COR-7, 2026-08-15 — all three were missing, and
// each one silently and PERMANENTLY killed a call):
//   • **Trickle ICE is buffered until the remote description exists.** Candidates
//     routinely beat the offer/answer they belong to through the relay, and
//     addIceCandidate() before setRemoteDescription() throws — the old code
//     swallowed that in the shared catch, so the candidate was simply GONE. On a
//     link where the surviving candidates don't pair, the call degrades to silence
//     with every diagnostic still saying "negotiating". The queue is bounded so a
//     broken/hostile peer that never sends an SDP can't grow it forever.
//   • **A dead RTCPeerConnection is closed, dropped and rebuilt.** Nothing watched
//     connectionState/iceConnectionState, and syncPeers() only ever creates a peer
//     whose id is ABSENT from the map — so a `failed` PC sat in the map for the
//     rest of the session and that peer's voice never came back. Rebuild attempts
//     use bounded exponential backoff so a peer that can't be reached (symmetric
//     NAT, no TURN) doesn't become an offer/ICE flood. The backoff FLATTENS, it
//     never stops: see _scheduleRebuild().
//   • **A negotiation epoch rides every signal.** The offerer mints it per PC and
//     the answerer mirrors it back, so an answer or candidate still in flight when
//     a connection was torn down cannot be applied to its replacement (which has
//     entirely different ICE credentials — it would never connect, and never say
//     why). Same idiom as [[src/net/VideoMgr.js]]'s `epoch`. An absent/0 epoch
//     means a peer on an older build: honoured unconditionally, as there. The
//     epoch of a torn-down connection outlives it in _lastDeadEpoch, because the
//     stragglers routinely arrive while no entry exists at all.
// This deliberately mirrors VideoMgr's grace/rebuild path (_onPeerBroken) rather
// than inventing a second idiom for the same problem.
//
// Round 4 (2026-08-15) — the first cut of the rebuild path RE-CREATED COR-7 in
// its own teardown window. While the entry was absent (the whole backoff window,
// and forever once retries were given up) a single inbound signal ran
// handleSignal's `_ensurePeer(msg.from, false)` and rebuilt the peer HARD-CODED
// as the answerer. The offerer thereby lost its offerer role permanently; by the
// glare rule nobody offered, the new PC never left connectionState 'new' so no
// failure event ever fired, and syncPeers() saw the id in _pcs and never rebuilt
// it — i.e. exactly "that peer's voice never came back", reintroduced by the fix
// for it. The review found three more holes around it: the epoch gate could not
// see stragglers that arrive while the entry is absent (which is when they
// actually arrive), the retry give-up was terminal despite a log line claiming
// otherwise, and _onPeerBroken carried a guard that was unreachable dead code.
// Every change that closes those is marked `round 4` below, and each one is
// pinned by an assertion in [[scripts/test-voice-recovery.mjs]] that fails when
// that specific mechanism is removed.
//
// Round 5 (2026-08-15) — the round-4 watermark exempted 'offer' but not 'ice', so
// for the very case the exemption was written for (a peer that RELOADS in place,
// keeps its id and mints epochs from 1 again) every candidate that beat its offer
// through the relay was silently deleted: COR-7 bullet 1, reintroduced on a
// narrower path. Candidates the watermark cannot tell apart from stragglers are
// now parked instead of dropped (_parkIce / _adoptParkedIce). Four mechanisms
// that had no assertion at all now have one (the `self != null` guard and
// _isOfferer() at the reconciliation site, disable() clearing the watermarks, and
// the Math.max that stops a lower-epoch teardown from lowering one).
//
// Round 6 (2026-08-15) — the SAME reload case, one gate further in. Rounds 4 and 5
// exempted a reloaded peer's offer and parked its candidates while our entry was
// ABSENT; with an entry still live the lower-epoch branch dropped everything,
// offer included. But a reloaded peer's epochs restart at 1, so its first offer is
// normally LOWER than the one we were last talking to — and an offer can never be
// a straggler, since it starts a negotiation rather than continuing one. The pair
// went permanently silent: we kept answering into a PC the peer no longer had, the
// peer waited for an answer that never came, and no failure fired on either side.
// A lower-epoch OFFER now rebuilds exactly like a higher-epoch one, and a
// lower-epoch candidate is parked rather than deleted (round 5's remedy, applied
// on this path too). Both are pinned in [[scripts/test-voice-recovery.mjs]].

import * as THREE from 'three';

const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

// How many remote candidates we'll hold for one peer while waiting for its SDP.
// A real ICE gathering run is a handful to a few dozen candidates; 64 is
// generous for the legitimate case and still a hard ceiling for a peer that
// trickles forever and never negotiates.
const ICE_QUEUE_MAX = 64;
const DISCONNECT_GRACE_MS = 4000;   // same 4 s grace VideoMgr gives 'disconnected'
const RETRY_BASE_MS = 1000;         // 1s, 2s, 4s, 8s, 15s, 15s …
const RETRY_MAX_MS = 15000;
const RETRY_LIMIT = 6;              // …then the ladder flattens to RETRY_COOLOFF_MS
// After the ladder is exhausted (~45 s of cumulative failure) we do NOT stop.
// Stopping was terminal in practice: the glare rule makes the larger id a pure
// answerer, so "until the peer re-offers" never happens for a peer that stays in
// the roster, and voice was dead for the rest of the session (COR-7 round 4).
// One attempt per minute is not a flood, and it means an unreachable peer that
// becomes reachable again (TURN comes up, Wi-Fi returns) recovers on its own.
const RETRY_COOLOFF_MS = 60000;

export class VoiceMgr {
  constructor({
    scene, avatars, send, getSelfId, iceServers = DEFAULT_ICE,
    // Recovery knobs. Defaults are the production values; they are constructor
    // options purely so the pure-logic tests ([[scripts/test-voice-recovery.mjs]])
    // can drive the backoff/grace paths without real timers or a real clock.
    iceQueueMax = ICE_QUEUE_MAX, disconnectGraceMs = DISCONNECT_GRACE_MS,
    retryBaseMs = RETRY_BASE_MS, retryMaxMs = RETRY_MAX_MS, retryLimit = RETRY_LIMIT,
    retryCooloffMs = RETRY_COOLOFF_MS,
    now = () => Date.now(),
  }) {
    this.scene = scene;          // SceneMgr — for .audioListener
    this.avatars = avatars;      // AvatarMgr — for getHead(peerId)
    this.send = send;            // ({ to, kind, data }) => void  (NetMgr → ws)
    this.getSelfId = getSelfId;  // () => string|null
    this.iceServers = iceServers;
    this.iceQueueMax = iceQueueMax;
    this.disconnectGraceMs = disconnectGraceMs;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.retryLimit = retryLimit;
    this.retryCooloffMs = retryCooloffMs;
    this._now = now;
    this.localStream = null;
    this.enabled = false;
    this.muted = false;
    this._epoch = 0;             // monotonic; only the offerer mints epochs
    this._pcs = new Map();       // peerId -> { pc, initiator, stream, audio, epoch, … }
    this._retry = new Map();     // peerId -> { attempts, notBefore } — rebuild backoff
    // peerId -> the highest negotiation epoch we have already torn down. Outlives
    // the entry on purpose (round 4): the epoch gates in handleSignal read the
    // live entry, and the stragglers this protocol exists to reject are exactly
    // the ones that arrive while there IS no live entry.
    this._lastDeadEpoch = new Map();
    // peerId -> { epoch, cands } — candidates that the watermark above cannot
    // tell apart from stragglers, held instead of discarded (round 5, see
    // handleSignal's entry-absent gate and _parkIce/_adoptParkedIce).
    this._parkedIce = new Map();
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
      // A peer whose PC we just tore down as FAILED is missing from _pcs and would
      // otherwise be rebuilt on the very next frame — i.e. ~60 offer storms a
      // second at a peer we already know we can't reach. _mayRebuild() holds it
      // off for the backoff window, which flattens to retryCooloffMs once the
      // ladder is exhausted but never stops (see _scheduleRebuild).
      if (!this._pcs.has(id)) {
        if (!this._mayRebuild(id)) continue;
        this._ensurePeer(id, this._isOfferer(id));
      } else if (self != null && this._pcs.get(id).initiator !== this._isOfferer(id)) {
        // Self-heal a role that disagrees with the glare rule (round 4). With the
        // creation sites fixed, the only way left to hold a wrong role is to have
        // built the peer while getSelfId() was still null (_isOfferer() answers
        // "answerer" then, by design) and to learn our id afterwards. That
        // ordering does not occur in the current wiring — HELLO sets selfId
        // before any peer is applied ([[src/net/PresenceState.js]] :48) and
        // NetMgr only syncs the mesh from the roster tick — so treat this as
        // reconciliation, not as a path anyone has observed. It is here because a
        // wrong role is unrecoverable silence (neither side offers, so the PC
        // never leaves 'new' and never reports a failure), which is too expensive
        // to owe to another file's ordering. Only acts once a self id exists, so
        // a transient null can never churn live calls.
        console.warn(`[voice] peer ${String(id).slice(0, 8)} had the wrong negotiation role — rebuilding`);
        this._closePeer(id);
        this._ensurePeer(id, this._isOfferer(id));
      }
      this._tryAttach(id);
    }
    for (const id of [...this._pcs.keys()]) if (!set.has(id)) this._closePeer(id);
    // Leaving the room is not a connection failure: forget the backoff so a peer
    // that rejoins gets a connection immediately instead of serving out the
    // penalty accrued by its previous session. The dead-epoch watermark goes with
    // it — a peer that rejoins mints epochs from 1 again, and a watermark left
    // over from its previous session would reject its first offers as stragglers.
    // Parked candidates go too: they belong to a negotiation of a session that is
    // over, and nothing will ever claim them.
    for (const id of [...this._retry.keys()]) if (!set.has(id)) this._retry.delete(id);
    for (const id of [...this._lastDeadEpoch.keys()]) if (!set.has(id)) this._lastDeadEpoch.delete(id);
    for (const id of [...this._parkedIce.keys()]) if (!set.has(id)) this._parkedIce.delete(id);
  }

  // The glare rule, in one place: the lexicographically smaller id is the sole
  // offerer. Round 4 — this used to be spelled out at the syncPeers() creation
  // site and hard-coded to `false` at the handleSignal() one, which is how the
  // offerer could silently be demoted to answerer and never negotiate again.
  // `self == null` (not joined yet) means we cannot compute the rule, so we take
  // the answering role: passive is always safe, and syncPeers() rebuilds with the
  // real answer once a self id exists.
  _isOfferer(peerId) {
    const self = this.getSelfId();
    return self != null && String(self) < String(peerId);
  }

  _ensurePeer(peerId, initiator) {
    let entry = this._pcs.get(peerId);
    if (entry) return entry;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    entry = {
      pc,
      initiator,
      stream: null,
      audio: null,
      epoch: initiator ? ++this._epoch : 0, // only the offerer mints epochs
      remoteEpoch: 0,                       // the offerer's epoch, as seen by the answerer
      remoteSet: false,                     // has setRemoteDescription landed?
      pendingIce: [],                       // candidates that beat the SDP here
      iceDropped: 0,
      graceTimer: null,
      closing: false,
    };
    this._pcs.set(peerId, entry);

    for (const t of this.localStream.getTracks()) pc.addTrack(t, this.localStream);

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const cand = e.candidate.toJSON ? e.candidate.toJSON() : e.candidate;
      // Stamp the pair's negotiation epoch alongside the candidate. Unknown
      // members of an RTCIceCandidateInit are ignored by the receiving
      // addIceCandidate(), so a peer on an older build is unaffected.
      this.send({ to: peerId, kind: 'ice', data: { ...cand, epoch: this._wireEpoch(entry) } });
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
        if (this._pcs.get(peerId) !== entry) return; // rebuilt while we awaited
        this.send({ to: peerId, kind: 'offer', data: { type: offer.type, sdp: offer.sdp, epoch: entry.epoch } });
      } catch (e) { console.warn('[voice] offer failed', e); }
    };
    // Failure detection. Without these a `failed` PC was permanent AND invisible:
    // nothing closed it, and syncPeers() only creates peers that are ABSENT from
    // the map, so that peer's voice was gone for the rest of the session.
    // `entry` (not just peerId) is handed to _onPeerBroken on purpose: these
    // events fire as tasks, so a PC we already replaced can still report its
    // death AFTER the replacement is live — a by-id lookup would have let a dead
    // connection tear down the healthy one that succeeded it.
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') { this._retry.delete(peerId); return; } // a good link clears the penalty
      if (st === 'failed' || st === 'closed' || st === 'disconnected') this._onPeerBroken(peerId, entry, `conn:${st}`);
    };
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === 'failed' || st === 'closed' || st === 'disconnected') this._onPeerBroken(peerId, entry, `ice:${st}`);
    };
    return entry;
  }

  // The epoch to stamp on what we send for this pair. The OFFERER owns the
  // number; the answerer only mirrors back the one it was offered (0 until the
  // offer arrives, which reads as "unstamped" on the other side).
  _wireEpoch(entry) { return entry.initiator ? entry.epoch : (entry.remoteEpoch || 0); }

  /**
   * A PC died — close it, drop it, and let syncPeers() rebuild it after a backoff.
   *
   * 'disconnected' is treated exactly as [[src/net/VideoMgr.js]] treats it: it is
   * routinely transient (a Wi-Fi blip, a roaming headset), so it gets a grace
   * window and only counts as a failure if it hasn't recovered by the time the
   * window closes. 'failed'/'closed' are terminal and act immediately.
   */
  _onPeerBroken(peerId, entry, why) {
    // One guard, and it covers both cases: our own close() (not a failure), AND a
    // PC we already superseded reporting its death late, because the only place
    // an entry is dropped from _pcs is _closePeer(), which sets closing = true
    // first. A second `this._pcs.get(peerId) !== entry` check used to sit here
    // claiming to catch the superseded case; it was unreachable and the round-4
    // verifier proved it — deleting it changed no test outcome.
    if (!entry || entry.closing) return;
    if (why.endsWith(':disconnected')) {
      if (entry.graceTimer) return;
      entry.graceTimer = setTimeout(() => {
        entry.graceTimer = null;
        // Defensive only, and labelled as such: _closePeer() clears this timer,
        // so there is no known path that reaches here on a closed entry. It is
        // NOT a tested guarantee — do not cite it as one.
        if (entry.closing) return;
        const st = entry.pc.connectionState;
        if (st === 'connected' || st === 'connecting' || st === 'new') return; // recovered
        console.warn(`[voice] peer ${String(peerId).slice(0, 8)} voice path broken (${why}) — rebuilding`);
        this._closePeer(peerId);
        this._scheduleRebuild(peerId);
      }, this.disconnectGraceMs);
      // Node's timers keep the process alive; the browser's are plain numbers.
      entry.graceTimer?.unref?.();
      return;
    }
    console.warn(`[voice] peer ${String(peerId).slice(0, 8)} voice path broken (${why}) — rebuilding`);
    this._closePeer(peerId);
    this._scheduleRebuild(peerId);
  }

  // Bounded exponential backoff, keyed by peer id so it survives the PC that
  // earned it. Cleared when a rebuilt connection actually reaches 'connected'
  // (see onconnectionstatechange), when the peer leaves the roster, or when the
  // peer opens a fresh negotiation (handleSignal's offer path).
  //
  // Round 4: past retryLimit the ladder FLATTENS to retryCooloffMs — it does not
  // stop. The previous version stopped and its log line claimed "its next offer
  // still works", which was false: the glare rule makes the larger id a pure
  // answerer, so for the offering side "the peer's next offer" never comes and
  // voice stayed dead for the rest of the session.
  _scheduleRebuild(peerId) {
    const r = this._retry.get(peerId) || { attempts: 0, notBefore: 0 };
    r.attempts += 1;
    const wait = r.attempts > this.retryLimit
      ? this.retryCooloffMs
      : Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** (r.attempts - 1)));
    r.notBefore = this._now() + wait;
    this._retry.set(peerId, r);
    if (r.attempts === this.retryLimit + 1) {
      console.warn(`[voice] peer ${String(peerId).slice(0, 8)} unreachable after ${r.attempts} attempts — slowing to one attempt every ${Math.round(this.retryCooloffMs / 1000)}s`);
    }
  }

  // True when the backoff window for this peer has expired. There is deliberately
  // no permanent give-up: an unreachable peer costs one offer per retryCooloffMs,
  // and a peer that becomes reachable again (TURN comes up, Wi-Fi returns) gets
  // its voice back without anyone rejoining the room.
  _mayRebuild(peerId) {
    const r = this._retry.get(peerId);
    if (!r) return true;
    return this._now() >= r.notBefore;
  }

  // Kinds the voice mesh actually negotiates with. NetProtocol.SIGNAL_KINDS is
  // wider than this (it also carries the M1.2 video teardown 'bye'), and this
  // class must not depend on a validator somewhere else staying correct: an
  // unhandled kind used to fall through to _ensurePeer() below, so a single
  // stray 'bye' — a mis-routed one, a peer on an older/newer build, a relay that
  // stopped enforcing bye's video-only rule — would have opened a whole
  // RTCPeerConnection (and published our mic to it) for nothing.
  static NEGOTIATION_KINDS = Object.freeze(['offer', 'answer', 'ice']);

  async handleSignal(msg) {
    if (!this.enabled || !msg.from) return;
    // 'bye' is the video layer's teardown message ([[src/net/VideoMgr.js]]); the
    // voice mesh has no such concept — a peer leaving is handled by syncPeers()
    // from the roster. Explicitly ignored, not silently fallen through.
    if (!VoiceMgr.NEGOTIATION_KINDS.includes(msg.kind)) return;
    const epoch = Number(msg.data?.epoch) || 0; // 0 = unstamped (older build)
    let entry = this._pcs.get(msg.from);

    // --- Epoch gate: never apply a dead connection's leftovers to its successor.
    if (entry && epoch && entry.initiator && epoch !== entry.epoch) {
      // We minted this number. An answer/candidate carrying a different one was
      // produced against a PC we have already torn down; its ICE credentials no
      // longer exist here, so applying it can only corrupt the live connection.
      return;
    }
    if (entry && epoch && !entry.initiator && entry.remoteEpoch && epoch !== entry.remoteEpoch) {
      if (epoch > entry.remoteEpoch || msg.kind === 'offer') {
        // Newer epoch: the offerer rebuilt from scratch. Our answering side is
        // dead too — renegotiating on it would silently never connect (VideoMgr's
        // offer path reaches the same conclusion). Candidates can arrive before
        // the new offer does, so this rebuild is driven by ANY newer-epoch signal.
        //
        // LOWER epoch, but an OFFER (round 6): "lower" does not mean "older"
        // here. Epochs are per-manager counters, so a peer that RELOADED and
        // rejoined under the same id mints them from 1 again — its very first
        // offer is normally lower than the number we were last talking to. An
        // offer also cannot be a straggler by construction: it STARTS a
        // negotiation rather than continuing one, and the side that sent it is
        // committed to that negotiation. Dropping it left the pair permanently
        // silent — us answering into a PC the peer no longer has, the peer
        // waiting for an answer that never comes, and neither side ever
        // failing over (nothing errors; the reloaded peer is not the offerer's
        // rebuild trigger). This mirrors the entry-absent gate below, which has
        // exempted 'offer' since round 4 for exactly the same reason.
        this._closePeer(msg.from);
        entry = null;
      } else {
        // Strictly older AND not an offer. Either a straggler from the
        // negotiation we just replaced, or the first candidates of a reloaded
        // peer's new one — indistinguishable here, since candidates routinely
        // beat their offer through the relay. Park rather than drop, keyed by
        // the epoch claimed: the offer branch above will rebuild and
        // _adoptParkedIce hands them over iff that negotiation carries this
        // exact epoch; anything else clears the park. Same treatment (and the
        // same reasoning) as the entry-absent case in round 5 — dropping them
        // here was the identical silent loss on a narrower path. Only the
        // answering side can reach this branch (!entry.initiator), which is the
        // only side a park could ever be claimed on.
        if (msg.kind === 'ice') this._parkIce(msg.from, epoch, msg.data);
        return;
      }
    }
    // --- Epoch gate, entry-absent case (round 4). Both clauses above need a live
    // entry to compare against, but the window this fix opened — the whole backoff
    // between a failure and its rebuild — is precisely when there is none, and a
    // straggler answer/candidate landing there would be adopted by whatever gets
    // built next. _lastDeadEpoch remembers the torn-down negotiation for exactly
    // this. An 'offer' is exempt: it STARTS a negotiation rather than continuing
    // one, and a peer that reloaded and rejoined under the same id mints epochs
    // from 1 again — rejecting those against a stale watermark would be the
    // permanent silence all over again.
    if (!entry && msg.kind !== 'offer' && epoch && epoch <= (this._lastDeadEpoch.get(msg.from) || 0)) {
      // Round 5: the exemption above covers the reloaded peer's OFFER, but its
      // candidates carry restarted numbers too — and candidates routinely beat
      // their offer through the relay (COR-7 bullet 1). Discarding them here was
      // that same silent loss on a narrower path: at this point a straggler from
      // the dead epoch and the first candidate of a reloaded peer's brand-new
      // negotiation are the same message. So park rather than delete, keyed by
      // the epoch claimed: parked candidates are handed over only to a negotiation
      // that turns out to carry that exact epoch, and are dropped the moment one
      // carrying any other epoch starts (_adoptParkedIce). The dead epoch is over
      // by definition, so a straggler is still never applied to anything — it just
      // stops being destroyed on arrival.
      // Only the answering side parks: with no entry, the offering side drops
      // every inbound signal regardless (see the role branch immediately below),
      // so a park there could never be claimed.
      if (msg.kind === 'ice' && !this._isOfferer(msg.from)) this._parkIce(msg.from, epoch, msg.data);
      return;
    }

    if (!entry) {
      if (this._isOfferer(msg.from)) {
        // WE open the connection to this peer; by the glare rule it only ever
        // answers. So an inbound signal with no PC of ours is a leftover from one
        // we already tore down — there is nothing here to continue. The pre-round-4
        // code created a PC anyway, hard-coded as the ANSWERER: that demoted us
        // permanently, so neither side ever offered again, the PC sat in 'new'
        // (no failure event → no rebuild) and syncPeers() skipped the peer because
        // the id was back in _pcs. Dropping it also keeps _mayRebuild()'s backoff
        // authoritative on the only side that can negotiate.
        return;
      }
      // The answering side. An inbound signal is remote-driven — it is not our
      // per-frame rebuild loop — so it deliberately does NOT go through
      // _mayRebuild(): the offerer is the only side that can start a negotiation,
      // so refusing its offer while our own backoff runs would deadlock the pair.
      // Role from the glare rule, never a literal at a creation site — that is the
      // whole defect. (It is provably false on this branch; deriving it anyway is
      // what keeps it correct if the branch above ever changes.)
      entry = this._ensurePeer(msg.from, this._isOfferer(msg.from));
      // A fresh offer is a new negotiation, not a retry of the one that failed, so
      // it retires the penalty. Only 'offer' does this: a stray candidate must not
      // be able to wipe a legitimate backoff.
      if (msg.kind === 'offer') this._retry.delete(msg.from);
    }
    if (!entry.initiator && epoch) entry.remoteEpoch = epoch;
    // A negotiation is live for this peer now, so anything parked can be settled:
    // adopted if it claims this negotiation's epoch, dropped otherwise.
    this._adoptParkedIce(msg.from, entry, epoch);

    const pc = entry.pc;
    try {
      if (msg.kind === 'offer') {
        await pc.setRemoteDescription(msg.data);
        if (this._pcs.get(msg.from) !== entry) return; // rebuilt/closed mid-await
        entry.remoteSet = true;
        await this._flushIce(msg.from, entry);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (this._pcs.get(msg.from) !== entry) return;
        this.send({ to: msg.from, kind: 'answer', data: { type: answer.type, sdp: answer.sdp, epoch: this._wireEpoch(entry) } });
      } else if (msg.kind === 'answer') {
        await pc.setRemoteDescription(msg.data);
        if (this._pcs.get(msg.from) !== entry) return;
        entry.remoteSet = true;
        await this._flushIce(msg.from, entry);
      } else if (msg.kind === 'ice') {
        // Trickle ICE regularly overtakes the SDP it belongs to. Before, this
        // called addIceCandidate() straight away, the PC threw
        // InvalidStateError ("remote description not set"), the shared catch
        // below swallowed it and the candidate was DISCARDED — one lost relay
        // candidate on a lossy link is a call that never connects.
        if (!entry.remoteSet) { this._queueIce(entry, msg.from, msg.data); return; }
        await pc.addIceCandidate(msg.data);
      }
    } catch (e) { console.warn('[voice] signal handling error', e); }
  }

  // Buffer one remote candidate. BOUNDED: a peer that trickles forever and never
  // sends an SDP (broken, or hostile) must not be able to grow this without
  // limit. Over the cap the OLDEST is dropped — the earliest candidates are the
  // host ones, which are the least likely to be the pair that ends up working
  // across a NAT, whereas srflx/relay candidates arrive last.
  _queueIce(entry, peerId, cand) {
    if (entry.pendingIce.length >= this.iceQueueMax) {
      entry.pendingIce.shift();
      entry.iceDropped += 1;
      if (entry.iceDropped === 1) console.warn(`[voice] peer ${String(peerId).slice(0, 8)} sent >${this.iceQueueMax} candidates before any SDP — dropping the oldest`);
    }
    entry.pendingIce.push(cand);
  }

  // Hold candidates that arrived while NO entry exists and that the dead-epoch
  // watermark cannot distinguish from stragglers (a reloaded peer restarts its
  // epoch counter). Bounded exactly like _queueIce, and for the same reason:
  // oldest out first, so a peer that trickles forever cannot grow it. Exactly one
  // negotiation is parked at a time: a candidate claiming a different epoch
  // replaces what was waiting, so leftovers of an older one can never ride into a
  // newer one's queue at adoption.
  _parkIce(peerId, epoch, cand) {
    let p = this._parkedIce.get(peerId);
    if (!p || p.epoch !== epoch) { p = { epoch, cands: [] }; this._parkedIce.set(peerId, p); }
    if (p.cands.length >= this.iceQueueMax) p.cands.shift();
    p.cands.push(cand);
  }

  // Settle the park now that a negotiation exists for this peer. Candidates that
  // claim THIS negotiation's epoch join its pre-SDP queue in arrival order (they
  // arrived before the offer, so that queue is where they belong); everything
  // else is from a negotiation that is over and is dropped here rather than
  // waiting for one that will never come. A parked epoch is always >= 1 (nothing
  // unstamped is ever parked), so an unstamped signal — epoch 0, a peer on an
  // older build — claims nothing and simply clears the park.
  _adoptParkedIce(peerId, entry, epoch) {
    const p = this._parkedIce.get(peerId);
    if (!p) return;
    this._parkedIce.delete(peerId);
    if (p.epoch !== epoch) return;
    for (const cand of p.cands) this._queueIce(entry, peerId, cand);
  }

  // Apply the buffered candidates, in arrival order, now that the remote
  // description exists. Sequential on purpose: order matters to ICE pairing, and
  // it gives us a place to bail out if the PC is rebuilt mid-flush.
  async _flushIce(peerId, entry) {
    if (!entry.pendingIce.length) return;
    const queued = entry.pendingIce;
    entry.pendingIce = [];
    for (const cand of queued) {
      if (this._pcs.get(peerId) !== entry) return; // rebuilt — the rest are stale
      try { await entry.pc.addIceCandidate(cand); }
      catch (e) { console.warn('[voice] queued ICE rejected', e); }
    }
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
    // Mark + unmap BEFORE close(): pc.close() fires onconnectionstatechange
    // ('closed'), which would otherwise be read as a failure and earn this peer
    // a backoff penalty for a teardown we asked for (leaving the room, a clean
    // epoch rebuild).
    entry.closing = true;
    this._pcs.delete(peerId);
    // Watermark the negotiation we just killed so its in-flight stragglers can
    // still be recognised once the entry is gone (round 4 — see handleSignal).
    // The offerer stamps what it minted; the answerer stamps the offerer's number,
    // which is the same value on the wire either way.
    const dead = entry.initiator ? entry.epoch : entry.remoteEpoch;
    if (dead) this._lastDeadEpoch.set(peerId, Math.max(dead, this._lastDeadEpoch.get(peerId) || 0));
    if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
    entry.pendingIce = [];
    if (entry.audio) { try { entry.audio.parent?.remove(entry.audio); entry.audio.disconnect?.(); } catch { /* ok */ } }
    try { entry.pc.close(); } catch { /* ok */ }
  }

  disable() {
    for (const id of [...this._pcs.keys()]) this._closePeer(id);
    this._retry.clear();
    this._lastDeadEpoch.clear();
    this._parkedIce.clear();
    if (this.localStream) for (const t of this.localStream.getTracks()) t.stop();
    this.localStream = null;
    this.enabled = false;
  }

  debugApi() {
    const connected = (e) => ['connected', 'completed'].includes(e.pc.iceConnectionState) || e.pc.connectionState === 'connected';
    return {
      enabled: () => this.enabled,
      muted: () => this.muted,
      // epoch/queuedIce/retry are here because a voice path that is stuck is
      // otherwise indistinguishable from one that is merely quiet on a headset:
      // a growing queuedIce means SDP never landed, a climbing retry means the
      // rebuild loop is running and failing.
      peerStates: () => [...this._pcs.entries()].map(([id, e]) => ({ id, conn: e.pc.connectionState, ice: e.pc.iceConnectionState, audio: !!e.audio, epoch: e.initiator ? e.epoch : e.remoteEpoch, remoteSet: e.remoteSet, queuedIce: e.pendingIce.length, droppedIce: e.iceDropped })),
      connectedCount: () => [...this._pcs.values()].filter(connected).length,
      receivingCount: () => [...this._pcs.values()].filter((e) => !!e.audio).length,
      retries: () => [...this._retry.entries()].map(([id, r]) => ({ id, attempts: r.attempts, notBefore: r.notBefore })),
      // The torn-down negotiations we still reject stragglers from, and the role
      // we currently hold toward each roster peer — a peer stuck silent with the
      // wrong role is otherwise indistinguishable from one that is merely quiet.
      deadEpochs: () => [...this._lastDeadEpoch.entries()].map(([id, epoch]) => ({ id, epoch })),
      // Candidates held for a negotiation that has not shown its offer yet. A
      // non-empty park that never drains is the signature of a peer whose offer
      // is not arriving at all — otherwise indistinguishable from silence.
      parkedIce: () => [...this._parkedIce.entries()].map(([id, p]) => ({ id, epoch: p.epoch, count: p.cands.length })),
      roles: () => [...this._pcs.entries()].map(([id, e]) => ({ id, initiator: e.initiator })),
    };
  }
}
