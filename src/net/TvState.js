// TvState: pure shaping of the room's shared `tv` key — the one entry that says
// "this is the game the room is playing". Written for the multi-disc case: a
// PSX `.m3u` bundle is several CD images, the host can swap between them at any
// time ([[src/DiscSwapPanel.js]] → main.js's stepDisc → [[src/DiscControl.js]]),
// and until this module the published value carried only `{file, core, system,
// title}`. So the disc a peer was ACTUALLY on was invisible to the room:
//
//   * a watcher's disc panel had nothing to show (and, since it has no core of
//     its own to ask, no way to ever learn the answer);
//   * a late joiner was told the game but not the disc;
//   * a peer PROMOTED to host resumed the room's game from disc 1 regardless of
//     which disc the departed host had in the drive — dropping the player back
//     to the start of a multi-CD game mid-play.
//
// Kept pure (no THREE, no DOM, no socket — mirroring RoomObjects/PresenceState)
// so `npm test` covers the shaping rules that main.js only wires up; see
// scripts/test-tvstate.mjs.

/**
 * The disc fields to publish for a DiscControlBridge status, or `{}` when there
 * is nothing worth saying.
 *
 * Deliberately silent unless the content really is multi-disc AND the loaded
 * core exposes disc control — the same two conditions DiscSwapPanel uses to
 * decide whether to show itself at all. A single-disc/main-thread boot must not
 * start adding keys to `tv`, or every plain cartridge insert would publish
 * `disc: 0` noise and (worse) look like a state change to peers.
 *
 * @param {{index?:number, discCount?:number, ejected?:boolean, supported?:boolean}|null} status
 * @returns {{disc?:number, discCount?:number, discEjected?:boolean}}
 */
export function discFields(status) {
  if (!status || !status.supported) return {};
  const count = Number(status.discCount);
  if (!Number.isInteger(count) || count <= 1) return {};
  const index = Number.isInteger(status.index) ? status.index : 0;
  const fields = { disc: index, discCount: count };
  if (status.ejected) fields.discEjected = true;
  return fields;
}

/**
 * The full value to publish under `tv`: the game identity every peer already
 * relied on, plus the disc fields when they apply.
 *
 * @param {{file?:string, core?:string, system?:string, title?:string}} meta
 * @param {object|null} [discStatus]
 */
export function tvStateValue(meta, discStatus = null) {
  return {
    file: meta?.file,
    core: meta?.core,
    system: meta?.system,
    title: meta?.title,
    ...discFields(discStatus),
  };
}

/**
 * Patch the disc fields of an ALREADY-published `tv` value in place of
 * republishing the whole thing. Returns the new value, or `null` when nothing
 * would change (so a caller can skip the broadcast entirely).
 *
 * Needed because a boot publishes `tv` synchronously while the disc status is
 * only knowable asynchronously (`client.discStatus()` crosses the worker
 * boundary): whichever of the two lands second calls this and fills in the rest.
 *
 * @param {object|null} tvValue      the room's current `tv` value
 * @param {object|null} discStatus   the local core's disc status
 * @returns {object|null}
 */
export function mergeDiscIntoTv(tvValue, discStatus) {
  if (!tvValue || !tvValue.file) return null;
  const fields = discFields(discStatus);
  const next = { file: tvValue.file, core: tvValue.core, system: tvValue.system, title: tvValue.title, ...fields };
  // JSON, not key-by-key: this is exactly how NetMgr.setObjectState decides
  // whether a value changed, so "no change" here means "no wire traffic there".
  return JSON.stringify(next) === JSON.stringify(tvValue) ? null : next;
}

/**
 * Turn a room `tv` value back into a DiscSwapPanel status, for a peer that has
 * no core of its own to ask (a display-only watcher) — or `null` when the room
 * isn't playing multi-disc content, which is the panel's "hide yourself" signal.
 *
 * `supported: true` is asserted because the HOST's core is what supports it;
 * `remote: true` marks the status as second-hand, so a reader can tell "the room
 * says disc 2" from "our own core reports disc 2".
 *
 * @param {object|null} tvValue
 * @returns {{index:number, discCount:number, ejected:boolean, supported:true, remote:true}|null}
 */
export function discStatusFromTv(tvValue) {
  const count = Number(tvValue?.discCount);
  if (!Number.isInteger(count) || count <= 1) return null;
  const raw = Number.isInteger(tvValue.disc) ? tvValue.disc : 0;
  return {
    index: Math.min(Math.max(raw, 0), count - 1),
    discCount: count,
    ejected: !!tvValue.discEjected,
    supported: true,
    remote: true,
  };
}
