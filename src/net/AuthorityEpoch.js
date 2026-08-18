/**
 * COR-3: make ROOM AUTHORITY part of a boot transaction.
 *
 * A cartridge boot is not atomic — main.js's loadCartridge awaits a ROM fetch (on
 * a headset's Wi-Fi, a PS2 disc is seconds), a .cue resolution, a BIOS/SaveRAM
 * lookup and finally the core's own start. The host check that guards the boot
 * sits at the ENTRY of that function, and nothing re-asks the question afterwards.
 * So the server migrating the host away mid-fetch (the previous host's socket
 * blipped past the reclaim window, or they hit Leave) left the demoted peer
 * finishing the boot anyway and resuming its own core behind the new host's video
 * feed — precisely the "each computer runs its own game" divergence the M1.4
 * display-only gate exists to prevent. Demotion pauses the rack, but it knows
 * nothing about an in-flight boot, and the load GENERATION main.js already keeps
 * only orders competing loads: no newer load exists, so it happily says "go".
 *
 * The shape here mirrors that generation counter deliberately: bump on every
 * SETTLED authority transition, capture the value when a boot starts, and refuse
 * to commit if it moved. `isAuthoritative` folds in the live role as well, so a
 * boot that began before we ever had a role — or that is somehow still running
 * after the epoch settled back to the same number — is refused too.
 *
 * Kept in its own module (no THREE, no DOM, no net imports) so the rule is
 * testable in the pure-logic CI tier; main.js itself is not.
 */

/**
 * @param {object} [opts]
 * @param {() => boolean} [opts.isAuthoritative] live "may I act as the authority
 *        right now?" predicate. main.js passes mayRunLocalCore(), NOT amRoomHost()
 *        — see its comment there: keying this on host role alone would abandon a
 *        live host's in-flight boot on every Wi-Fi blip. Defaults to always.
 * @param {(epoch:number, reason:string) => void} [opts.onBump] observer, for logs.
 */
export function createAuthorityEpoch({ isAuthoritative = () => true, onBump = null } = {}) {
  let epoch = 0;
  // Fails CLOSED, unlike ConsoleRuntime.runAllowed(): a predicate that throws
  // cannot be read as "yes, still the host" — the whole point of this guard is to
  // refuse a boot it is not sure about, and the cost of a false refusal is one
  // un-booted cartridge (the user re-inserts it) versus two live cores.
  const authoritative = () => {
    try { return isAuthoritative() !== false; }
    catch (e) { console.warn('[AuthorityEpoch] isAuthoritative threw', e); return false; }
  };
  return {
    /** Current epoch. Only interesting for logging/tests. */
    get epoch() { return epoch; },

    /**
     * A settled authority transition happened (promotion, demotion, leaving the
     * room). Callers MUST NOT bump for an UNDECIDED role — main.js returns early
     * on `hostId === null` precisely because a momentary socket blip is not a
     * demotion, and bumping there would abort a live host's legitimate boots.
     * @returns {number} the new epoch
     */
    bump(reason = '') {
      epoch += 1;
      try { onBump?.(epoch, reason); } catch (_) { /* logging must never break a role change */ }
      return epoch;
    },

    /**
     * Capture the authority as it is RIGHT NOW and get back the predicate to
     * consult after every await: true means "this work no longer has the
     * authority it started with — abandon it".
     * @returns {() => boolean}
     */
    guard() {
      const at = epoch;
      return () => at !== epoch || !authoritative();
    },
  };
}
