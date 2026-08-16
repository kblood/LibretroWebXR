// SaveRamGuard — native SaveRAM persistence for EVERY running console, keyed by
// the identity that console actually booted (CODEX_REVIEW COR-6).
//
// THE BUG THIS EXISTS TO FIX
// main.js used to persist SaveRAM through one global function that read two
// module-level variables: `currentMeta` (the PRIMARY console's game) and
// `client` (the PRIMARY console's client). Everything else in the rack restored
// its saves at boot (buildStartOptions → SaveRamStore.load) and never wrote one:
//
//   • a game on a secondary/rack console lost every battery save it ever made —
//     the 30s timer and the pagehide flush both wrote console0's card, whatever
//     console the player was actually sitting at;
//   • replacing a runtime (swapConsoleCore / a gun-arm reboot / any boot-config
//     change) disposed the old core with no write at all, so even the primary
//     lost up to 30s of play across a swap;
//   • the write was keyed on `currentMeta.core` — the CARTRIDGE's core — while
//     the restore is keyed on the core that actually BOOTED. Those differ for a
//     light-gun boot (SMS → genesis_plus_gx), so a gun game's card was written
//     under a key nothing ever reads back.
//
// So: one guard, N tracked runtimes, each with its own save identity, and a
// flush at every moment a runtime can stop being the thing that owns those bytes.
//
// THREE PROPERTIES WORTH KNOWING
//   • The client is resolved LATE (track() accepts a thunk). The primary
//     console's client object is REPLACED on a live reboot; a captured reference
//     would flush a dead core for ever after. Same lesson as src/net/LiveAvatars.js.
//   • Writes for one id are SERIALISED and deduplicated. The 30s timer, a
//     pagehide and a replacement can all fire within a frame of each other; the
//     store does read-modify-write (it rotates backups), so overlapping writes
//     would rotate a good backup out for no reason. Identical bytes are not
//     written at all.
//   • retire() is generation-guarded. It flushes and then forgets — but a
//     replacement boots the new core BEFORE the old runtime is removed, so a
//     naive forget-when-done would drop the tracking of the runtime that just
//     replaced it. Each track() bumps a generation; retire only forgets the
//     generation it started with.

/**
 * @param {object} opts
 * @param {{save: Function}} opts.store   SaveRamStore (or a fake in tests)
 * @param {{event?: Function}} [opts.logger]
 * @param {(e: unknown, id: string) => void} [opts.onError] — reporter for a
 *   failing flush. Defaults to a console warning; injectable so tests can assert
 *   a failure is REPORTED rather than swallowed.
 */
export function createSaveRamGuard({ store, logger = null, onError = null } = {}) {
  const tracked = new Map();     // consoleId -> {getClient, coreId, contentId, entryPath, slot, gen, key}
  const written = new Map();     // consoleId -> fingerprint of the last bytes written
  const chains = new Map();      // consoleId -> promise, serialising that id's writes
  const stats = { writes: 0, skipped: 0, failures: 0 };
  let gen = 0;
  const report = typeof onError === 'function'
    ? onError
    : (e, id) => console.warn(`[saveram] flush failed for ${id}`, e);

  const identityKey = (e) => `${e.coreId}|${e.contentId}|${e.slot}`;

  /**
   * Start tracking (or re-track) a console's SaveRAM identity.
   *
   * @param {string} id            console id (the rack key)
   * @param {object} info
   * @param {object|Function} info.client  the console's client, or a thunk
   *   returning it (PREFER the thunk — see the note above).
   * @param {string} info.coreId   the core that BOOTED (not the cartridge's
   *   declared core), because that is what the restore path keys on.
   * @param {string} info.contentId  content hash from the ContentBundle wrap;
   *   absent for main-thread cores, which have no native SaveRAM path.
   * @returns {boolean} whether this console is now tracked.
   */
  function track(id, { client, coreId, contentId, entryPath = null, slot = 1 } = {}) {
    if (!id) return false;
    if (!coreId || !contentId) { forget(id); return false; }
    const entry = {
      getClient: typeof client === 'function' ? client : () => client,
      coreId, contentId, entryPath, slot, gen: ++gen,
    };
    entry.key = identityKey(entry);
    // A different game (or a different core) on this console means the
    // dedup fingerprint from the previous one says nothing about the new one.
    const previous = tracked.get(id);
    if (!previous || previous.key !== entry.key) written.delete(id);
    tracked.set(id, entry);
    return true;
  }

  function forget(id) {
    written.delete(id);
    return tracked.delete(id);
  }

  function identity(id) {
    const e = tracked.get(id);
    return e ? { coreId: e.coreId, contentId: e.contentId, entryPath: e.entryPath, slot: e.slot } : null;
  }

  /**
   * Read this console's SaveRAM and persist it, unless nothing changed.
   * Never throws: a core with no battery RAM, a main-thread core with no
   * flushSaveRam at all, and a store write that fails all resolve to a reason.
   * @returns {Promise<{written: boolean, reason: string, id: string}>}
   */
  function flush(id, reason = 'manual') {
    const entry = tracked.get(id);
    if (!entry) return Promise.resolve({ written: false, reason: 'untracked', id });
    // Serialise per id: the store rotates backups read-modify-write, so two
    // concurrent writes for one card would rotate a good backup out for nothing.
    const next = (chains.get(id) || Promise.resolve()).then(() => _flushOnce(id, entry, reason));
    // Keep the chain alive even when a link rejects (it can't — _flushOnce
    // catches — but a future caller of the chain must not inherit a rejection).
    chains.set(id, next.catch(() => {}));
    return next;
  }

  async function _flushOnce(id, entry, reason) {
    // Re-read: the identity may have been replaced while we waited our turn.
    const live = tracked.get(id);
    if (!live || live.gen !== entry.gen) return { written: false, reason: 'superseded', id };
    try {
      const client = live.getClient();
      if (typeof client?.flushSaveRam !== 'function') {
        stats.skipped++;
        return { written: false, reason: 'unsupported', id };
      }
      const data = await client.flushSaveRam(live.slot);
      if (!data) { stats.skipped++; return { written: false, reason: 'empty', id }; }
      const mark = fingerprint(data);
      if (mark && written.get(id) === mark) {
        stats.skipped++;
        return { written: false, reason: 'unchanged', id };
      }
      await store.save({
        coreId: live.coreId,
        contentId: live.contentId,
        slot: live.slot,
        data,
        coreBuildHash: client.buildHash,
        entryPath: live.entryPath,
      });
      if (mark) written.set(id, mark);
      stats.writes++;
      logger?.event?.('saveram-flush', {
        consoleId: id, reason, coreId: live.coreId, contentId: live.contentId,
        bytes: byteLengthOf(data),
      });
      return { written: true, reason, id };
    } catch (e) {
      stats.failures++;
      report(e, id);
      return { written: false, reason: 'failed', id, error: e };
    }
  }

  /**
   * Flush every tracked console. One console's failure must not stop the rest,
   * which is the whole reason this isn't a bare `for … await`.
   * @returns {Promise<Array>} one result per console (settled).
   */
  function flushAll(reason = 'periodic') {
    return Promise.all([...tracked.keys()].map((id) => flush(id, reason)));
  }

  /**
   * Flush, then stop tracking — for a runtime that is being replaced or removed.
   * Generation-guarded: if something re-tracked this id while we were writing
   * (a replacement boots its new core before the old runtime is disposed), the
   * NEW tracking is left alone.
   */
  async function retire(id, reason = 'retired') {
    const entry = tracked.get(id);
    if (!entry) return { written: false, reason: 'untracked', id };
    const startedAt = entry.gen;
    const result = await flush(id, reason);
    const now = tracked.get(id);
    if (now && now.gen === startedAt) forget(id);
    return result;
  }

  return {
    track, forget, identity, flush, flushAll, retire,
    ids: () => [...tracked.keys()],
    size: () => tracked.size,
    stats: () => ({ ...stats, tracked: tracked.size }),
  };
}

function byteLengthOf(data) {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return data?.byteLength ?? null;
}

/**
 * A cheap content mark for "are these the same bytes I already wrote?" — length
 * plus FNV-1a. Returns null for anything not directly readable as bytes (a Blob,
 * a promise-shaped thing), which makes the caller write unconditionally: skipping
 * a write we aren't SURE is redundant would lose a save, the exact failure this
 * whole file exists to stop.
 */
export function fingerprint(data) {
  const bytes = data instanceof Uint8Array ? data
    : data instanceof ArrayBuffer ? new Uint8Array(data)
      : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : null;
  if (!bytes) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${bytes.length}:${(h >>> 0).toString(16)}`;
}
