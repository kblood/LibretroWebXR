// HostElection — PURE host-election helpers (M1.4).
//
// Normally the ROOM SERVER elects the host: the peer that has been in the room
// longest, re-elected only when the current host disconnects (see
// [[server/Hub.js]] and docs/MULTIPLAYER.md "Host election"). Its HELLO carries a
// `host` field and later changes arrive as MSG.HOST.
//
// This module is the CLIENT-SIDE FALLBACK for the case where the room server is
// OLDER than the client (a deployed relay that knows nothing about host
// election, so it never sends `host` / MSG.HOST at all). Without a fallback,
// `isHost()` would be false for every peer and the client-boot gate would refuse
// to boot anything anywhere — "two separate games" would become "no game at
// all". So when the HELLO has no `host` key whatsoever, peers elect among
// themselves over the ordinary persisted STATE channel (which every server
// version relays) using the rules below.
//
// The rule is a total order over CLAIMS, so every peer independently computes the
// same winner without any coordinator:
//
//   • a claim is `{ id, at }` — "peer <id> announced itself at <at>".
//   • the EARLIEST claim wins; ties break on the lexicographically smaller id.
//   • claims by peers that are no longer in the room are ignored, so when the
//     fallback host leaves, the earliest remaining claim wins — i.e. the
//     longest-present peer, exactly like the server's seniority rule.
//   • a peer with no valid claim in sight claims itself. Simultaneous claims are
//     harmless: everyone sees both and picks the earlier one.
//   • the winner re-announces its own claim whenever the shared STATE holds a
//     different one, because the STATE channel is last-writer-wins and a LOSING
//     claim can land last — a late joiner replaying that state would otherwise
//     disagree with everyone else.
//
// Pure (no DOM/WebSocket/THREE) so scripts/test-net.mjs covers it in Node.

/** The shared STATE key the fallback election announces claims under. */
export const FALLBACK_HOST_KEY = 'hostClaim';

/** Coerce anything into a `{id, at}` claim, or null if it isn't one. */
export function normaliseClaim(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id == null ? '' : String(raw.id);
  if (!id) return null;
  const at = Number(raw.at);
  return { id, at: Number.isFinite(at) ? at : 0 };
}

/** True when claim `a` beats claim `b` (earlier wins; ties → smaller id). */
export function claimWins(a, b) {
  if (!b) return !!a;
  if (!a) return false;
  if (a.at !== b.at) return a.at < b.at;
  return String(a.id) < String(b.id);
}

/** Same peer + same timestamp → the identical claim (no need to re-announce). */
export function sameClaim(a, b) {
  return !!a && !!b && String(a.id) === String(b.id) && Number(a.at) === Number(b.at);
}

/**
 * Decide the fallback host from every claim we have seen.
 *
 * @param {object} o
 * @param {Array<{id:string,at:number}>} o.claims   every claim seen (any order)
 * @param {string[]} o.presentIds  ids currently in the room (self included)
 * @param {string} o.selfId        our own peer id
 * @param {number} o.now           timestamp to stamp a fresh self-claim with
 * @param {object} [o.stored]      the claim currently in the shared STATE
 * @returns {{hostId:string|null, announce:{id:string,at:number}|null}}
 *          `hostId` is who everyone should treat as host; `announce` is a claim
 *          this peer must publish (null = nothing to publish).
 */
export function resolveFallbackHost({ claims = [], presentIds = [], selfId = null, now = 0, stored = null } = {}) {
  const self = selfId == null ? null : String(selfId);
  if (!self) return { hostId: null, announce: null };
  const present = new Set(presentIds.map((x) => String(x)));
  present.add(self);

  let best = null;
  for (const raw of claims) {
    const c = normaliseClaim(raw);
    if (!c || !present.has(c.id)) continue;      // stale claim by a departed peer
    if (claimWins(c, best)) best = c;
  }

  if (!best) {
    // Nobody credible has claimed the room — claim it ourselves.
    const mine = { id: self, at: Number(now) || 0 };
    return { hostId: self, announce: mine };
  }
  // The winner keeps the shared STATE pointing at itself (a losing claim can
  // land last on a last-writer-wins channel).
  const announce = (best.id === self && !sameClaim(normaliseClaim(stored), best)) ? best : null;
  return { hostId: best.id, announce };
}
