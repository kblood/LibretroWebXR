// Change mode: cycle a selected prop's options — poster art, a shelf's or a
// bookcase's collection (with a live in-place rebuild), a portal's target room.
//
// Extracted VERBATIM from src/main.js (the P2 #12 / §3.1 extraction plan, step
// 3, after [[src/MemoryCardUI.js]] and [[src/ConsoleRegistry.js]]+[[src/PowerMgr.js]]).
// The code below is the same code, moved: same order, same comments, same
// behaviour — including the two inline comments inside rebuildBookcase that talk
// their way through a dead end ("Actually, we import lockBookcaseHomes above;
// replicate the logic here directly") and the vestigial destructure of a null
// `buildBookcaseCarts` they refer to. That is ugly, and it stays ugly: nothing
// in this file may be tidied in the same change that moves it, because main.js
// has no test coverage and a behavioural change hidden inside a move would be
// undetectable. Clean-ups are a separate, reviewable diff.
//
// THE ONLY EDITS MADE WHILE MOVING (all mechanical, all forced by the move):
//   * every line indented by two spaces, because the block is now nested inside
//     createPropChangeMode();
//   * fifteen CODE lines had a bare main.js binding prefixed with `ctx.`:
//     `currentRoom` (1), `currentCollections` (2 lines, 3 uses), `grabMgr` (5),
//     `editor` (4), `roomPosters` (2), `activePortals` (1). Comment lines that
//     merely MENTION those names were left exactly as they were.
// Nothing else changed. No renames, no reordering, no reformatting.
//
// WHY `ctx` IS READ THROUGH LIVE GETTERS AND NEVER DESTRUCTURED. All six of
// those bindings are `let`s in main.js that are REASSIGNED after this module is
// constructed — `currentRoom`/`currentCollections` on every room load,
// `roomPosters` when the room is built, `grabMgr` and `editor` inside
// buildCartridgeWorld, `activePortals` when the portals are built. main.js hands
// us an object whose properties are getters onto those bindings, so
// `ctx.editor` reads the CURRENT value every time. Destructure it — here, or in
// any function added later — and you freeze the null that was there at
// construction, and Change mode silently does nothing forever. Same reason
// PowerMgr takes `getNet`/`getMenuMgr` and MemoryCardUI takes
// `getClient`/`getMeta`. `scene`, `setStatus` and `KNOWN_ROOMS` are consts in
// main.js by this point and are passed by value.
//
// BE CAREFUL HERE — props are net-synced ([[src/net/PropSync.js]]) and the host
// publishes a baseline, so a mistake in this file desynchronises OTHER players'
// worlds, not just the local one. Note what this module deliberately does NOT
// touch: it never reads or writes `_knownPropPayloads` (main.js's sync cache).
// Cycling mutates the prop descriptor in place and rebuilds the local object;
// main.js's own prop-sync tick is what notices and publishes. Keep it that way —
// the stale-`_knownPropPayloads` bug (TEARDOWN-1) came from a second writer.

import { buildProp, applyPosterTexture, lockBookcaseHomes } from './RoomBuilder.js';
import { createMedia } from './Media.js';
import { createCoverPlaque } from './CoverPlaque.js';
import { cyclePosterTexture, cycleShelfCollection, cyclePortalTarget } from './EnvEditor.js';
import { roomCollectionRefs } from './RoomLoader.js';

export function createPropChangeMode({ scene, setStatus, KNOWN_ROOMS, ctx }) {
  // Drop the `builtin:` prefix for terse status lines.
  const short = (v) => String(v || '').replace(/^builtin:/, '');

  // Ordered list of collection keys a shelf can cycle through. The room's declared
  // refs (top-level `collections` + any shelf's `collection`) — these are exactly
  // the strings currentCollections.byKey was keyed with, so each resolves to a
  // loaded collection, and they match a shelf's `collection` field format (url or
  // id). A room that lists only one collection naturally can't cycle.
  function collectionKeys() {
    return roomCollectionRefs(ctx.currentRoom);
  }

  // Rebuild a shelf in place after its `collection` changed: build the new shelf
  // FIRST (buildProp returns null + adds nothing for an empty collection, so we
  // can abort cleanly), then swap out the old object from scene + grab set +
  // editor, register the replacement, and re-select it. Returns true on success.
  function rebuildShelf(rec) {
    const { prop, object } = rec;
    const r = buildProp(prop, { scene, collections: ctx.currentCollections });
    if (!r) return false; // empty collection — nothing built, old shelf untouched

    scene.removeObject(object);
    for (const child of object.children) {
      if (child.userData?.kind === 'cartridge') ctx.grabMgr.removeGrabbable(child);
    }
    ctx.grabMgr.removeGrabbable(object);
    ctx.editor.removePlaced(object);

    ctx.editor.registerPlaced(prop, r.object);
    r.cartridges.forEach((c) => ctx.grabMgr.addGrabbable(c));
    ctx.editor.select(r.object); // re-highlight the rebuilt shelf
    return true;
  }

  // Advance every poster in the room to its next art (the global "All Posters"
  // Change-mode action; distinct from cycling one selected poster).
  function cycleAllPosters() {
    if (!ctx.roomPosters.length) { setStatus('no posters in this room'); return; }
    let last;
    for (const { prop, object } of ctx.roomPosters) {
      last = cyclePosterTexture(prop);
      // FIX D: cycling to a built-in texture must clear imageFile so a reload
      // re-resolution doesn't override the user's chosen built-in art.
      delete prop.imageFile;
      applyPosterTexture(object.material, prop.texture);
    }
    setStatus(`All posters: ${short(last)}`);
  }

  // Rebuild a bookcase in place after its `collection` changed. Mirrors
  // rebuildShelf but for bookcases: removes old carts, builds new carts, and
  // re-locks homes. Returns true on success, false if the new collection is empty.
  function rebuildBookcase(rec) {
    const { prop, object: bookcaseGroup } = rec;
    // Remove old cartridges from grabMgr and the group.
    for (const child of [...bookcaseGroup.children]) {
      if (child.userData?.kind === 'cartridge') {
        ctx.grabMgr.removeGrabbable(child);
        bookcaseGroup.remove(child);
      }
    }
    // Build new carts from the updated collection on the EXISTING bookcase object.
    // We don't replace the group (unlike rebuildShelf) since the bookcase geometry
    // doesn't change — only the carts on the shelves change.
    // The cart rebuild is inlined below rather than reusing RoomBuilder's
    // buildBookcaseCarts: importing it here would be a circular reference, and
    // going through buildProp to steal a temp object's children costs a whole
    // throwaway prop. (Carried across from main.js, where a vestigial
    // `const { buildBookcaseCarts: buildCarts } = { buildBookcaseCarts: null }`
    // sat above this comment doing nothing.)
    const col = (prop.collection && ctx.currentCollections.byKey.get(prop.collection)) || ctx.currentCollections.list[0];
    const games = col ? col.games.slice() : [];
    if (!games.length) return false;

    // Refresh the cover plaque to name the new collection (mirrors RoomBuilder's
    // initial-build plaque; find-and-replace since the group itself persists).
    const BOOKCASE_H_CONST = 1.8;
    const oldPlaque = bookcaseGroup.children.find((c) => c.userData?.kind === 'coverPlaque');
    if (oldPlaque) bookcaseGroup.remove(oldPlaque);
    if (col) {
      const plaque = createCoverPlaque(col.title, { width: 0.9 * 0.85 });
      plaque.position.set(0, BOOKCASE_H_CONST + 0.02, 0);
      bookcaseGroup.add(plaque);
    }

    // Reuse the exported function from RoomBuilder — but it's not exported as a
    // standalone. Rebuild via a throw-away buildProp call: build a temp descriptor
    // → steal carts → position them into the real bookcaseGroup.
    // Simpler: rebuild directly using the same geometry constants.
    const CART_W = 0.12, CART_H = 0.13;
    const BOOKCASE_T_CONST = 0.03;
    const SLOT = CART_W + 0.04;
    const BACK_LEAN = -0.08;
    const MAX_ROW = 5;
    const shelfYs = [1, 2, 3].map((i) => (1.8 * i) / 4 + BOOKCASE_T_CONST / 2);

    const newCarts = [];
    let gameIdx = 0;
    for (const shelfY of shelfYs) {
      const remaining = games.length - gameIdx;
      if (remaining <= 0) break;
      const count = Math.min(remaining, MAX_ROW);
      const startX = -(count - 1) * SLOT / 2;
      for (let i = 0; i < count; i++) {
        const cart = createMedia(games[gameIdx++]);
        cart.position.set(startX + i * SLOT, shelfY + CART_H / 2, 0);
        cart.quaternion.identity();
        cart.rotation.x = BACK_LEAN;
        bookcaseGroup.add(cart);
        newCarts.push(cart);
      }
    }
    lockBookcaseHomes(bookcaseGroup);
    newCarts.forEach((c) => ctx.grabMgr.addGrabbable(c));
    return true;
  }

  // Advance the selected prop's primary property: poster→art, shelf/bookcase→
  // collection (with a live rebuild). Furniture/console have nothing to cycle.
  // Surfaced as a "Cycle Selected" menu button and the headless window.__change.
  function cycleSelected() {
    const rec = ctx.editor?.selectedProp();
    if (!rec) { setStatus('Change: grip a prop to select it first'); return; }
    const { prop, object } = rec;
    if (prop.type === 'poster') {
      const v = cyclePosterTexture(prop);
      // FIX D: cycling to a built-in texture must clear imageFile so reload
      // re-resolution doesn't override the user's chosen built-in art.
      delete prop.imageFile;
      applyPosterTexture(object.material, prop.texture);
      setStatus(`Poster art: ${short(v)}`);
    } else if (prop.type === 'shelf') {
      const keys = collectionKeys();
      if (keys.length < 2) { setStatus('only one collection loaded'); return; }
      const prev = prop.collection;
      const v = cycleShelfCollection(prop, keys);
      if (!rebuildShelf(rec)) { prop.collection = prev; setStatus(`"${v}" has no games`); return; }
      setStatus(`Shelf collection: ${v}`);
    } else if (prop.type === 'bookcase') {
      const keys = collectionKeys();
      if (keys.length < 2) { setStatus('only one collection loaded'); return; }
      const prev = prop.collection;
      const v = cycleShelfCollection(prop, keys);
      if (!rebuildBookcase(rec)) { prop.collection = prev; setStatus(`"${v}" has no games`); return; }
      setStatus(`Bookcase collection: ${v}`);
    } else if (object.userData.kind === 'portal') {
      // Portal descriptors live in room.portals[] (not room.props[]) and never
      // get a `.type` field (see normalizePortal in RoomLoader.js) — the object's
      // userData.kind (set by buildPortal) is the only reliable signal here.
      if (KNOWN_ROOMS.length < 2) { setStatus('only one known room'); return; }
      const v = cyclePortalTarget(prop, KNOWN_ROOMS);
      object.userData.target = v;
      // activePortals holds a denormalized snapshot the proximity-nav tick reads
      // (see the addPortal() push below) — keep it in sync with prop.target.
      const live = ctx.activePortals.find((p) => p.prop === prop);
      if (live) live.target = v;
      setStatus(`Portal target: ${v}`);
    } else {
      setStatus(`nothing to change for ${prop.type}`);
    }
  }
  return { short, collectionKeys, cycleAllPosters, cycleSelected };
}
