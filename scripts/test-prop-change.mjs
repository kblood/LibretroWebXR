// Unit tests for Change mode — cycling a selected prop's options
// ([[src/PropChangeMode.js]]).
//
// WHY THIS SUITE EXISTS. Nothing under scripts/ imports src/main.js, so a green
// run says nothing about code that still lives there. PropChangeMode is step 3
// of the P2 #12 extraction and this suite is what makes the move checkable at
// all: it drives the REAL module, against the REAL buildProp / EnvEditor /
// RoomLoader helpers it calls (not stubs of them), the way main.js wires it.
//
// The assertions below deliberately pin the things a "pure move" could silently
// break and nothing else would notice:
//   * THE LIVE-GETTER CONTRACT. All six ctx fields are `let`s main.js reassigns
//     AFTER the module is constructed. If anyone destructures `ctx` in the
//     module, every one of them freezes at its construction-time null and
//     Change mode quietly does nothing. Section 12 swaps the editor / grabMgr /
//     collections / room out from under a live module and insists it notices.
//   * THE ROLLBACK. Cycling a shelf or bookcase onto an empty collection must
//     put `prop.collection` BACK. Props are net-synced ([[src/net/PropSync.js]])
//     and the host publishes a baseline, so a descriptor left pointing at a
//     collection that built nothing desynchronises other players' worlds — this
//     is the half of the block with real blast radius.
//   * FIX D — cycling to a built-in poster texture clears `prop.imageFile`, so a
//     later re-resolution cannot override the art the user just picked. Both
//     paths (one poster, All Posters) do it; both are checked.
//   * The exact status strings, because they are the only feedback the in-VR
//     user gets and three of them are the "nothing happened, here is why" cases.
//
// Pure logic: no ports, no browser, no WebGL. A fake `document` stands in for
// the label canvases (see below), and poster art here is always `builtin:` so
// applyPosterTexture takes its no-URL path and never constructs a TextureLoader.

// --- Fake DOM, only deep enough for the label canvases ------------------------
// Rebuilding a shelf or a bookcase really does build cartridges and a cover
// plaque, and those draw their labels into a 2D canvas. THREE's CanvasTexture
// only stores whatever object it is handed, so nothing here has to draw: every
// context method returns the same permissive value object, which answers the
// two things the label code actually reads back — `measureText(...).width` and
// `createLinearGradient(...).addColorStop`. No WebGL is ever touched.
//
// Installed BEFORE the module is loaded. Static `import` is hoisted above
// statements, so the module below is pulled in with a dynamic import instead.
const ctxValue = { width: 10, addColorStop() {}, data: [] };
const fakeCtx = new Proxy({}, { get: (_t, p) => (p === 'canvas' ? undefined : () => ctxValue) });
globalThis.document = {
  createElement() { return { width: 0, height: 0, style: {}, getContext: () => fakeCtx }; },
};

const THREE = await import('three');
const { createPropChangeMode } = await import('../src/PropChangeMode.js');

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
};

// --- Stubs --------------------------------------------------------------------
const makeScene = () => {
  const added = [], removed = [];
  return { added, removed, addObject: (o) => added.push(o), removeObject: (o) => removed.push(o) };
};
const makeGrabMgr = () => {
  const added = [], removed = [];
  return { added, removed, addGrabbable: (o) => added.push(o), removeGrabbable: (o) => removed.push(o) };
};
// Just enough RoomEditor: a selection plus the three placed-object calls
// rebuildShelf makes.
const makeEditor = (sel = null) => {
  const calls = [];
  return {
    calls,
    sel,
    selectedProp: () => sel,
    removePlaced: (o) => calls.push(['removePlaced', o]),
    registerPlaced: (p, o) => calls.push(['registerPlaced', p, o]),
    select: (o) => calls.push(['select', o]),
  };
};
const game = (id) => ({ id, title: `Game ${id}`, system: 'nes', core: 'fceumm', file: `${id}.nes` });
const collection = (id, n) => ({ id, title: `Coll ${id}`, games: Array.from({ length: n }, (_, i) => game(`${id}${i}`)) });
const makeCollections = (...cols) => {
  const byKey = new Map();
  for (const c of cols) byKey.set(c.id, c);
  return { byKey, list: cols.slice() };
};

// Build a module wired to mutable holders, so a test can reassign any ctx field
// after construction exactly the way main.js does.
const setup = (opts = {}) => {
  const state = {
    scene: opts.scene ?? makeScene(),
    grabMgr: 'grabMgr' in opts ? opts.grabMgr : makeGrabMgr(),
    editor: 'editor' in opts ? opts.editor : makeEditor(),
    currentRoom: opts.currentRoom ?? { collections: [], props: [] },
    currentCollections: opts.currentCollections ?? makeCollections(),
    roomPosters: opts.roomPosters ?? [],
    activePortals: opts.activePortals ?? [],
  };
  const status = [];
  const mod = createPropChangeMode({
    scene: state.scene,
    setStatus: (s) => status.push(s),
    KNOWN_ROOMS: opts.knownRooms ?? ['roms/bedroom.room.json', 'roms/arcade.room.json'],
    ctx: {
      get editor() { return state.editor; },
      get grabMgr() { return state.grabMgr; },
      get currentRoom() { return state.currentRoom; },
      get currentCollections() { return state.currentCollections; },
      get roomPosters() { return state.roomPosters; },
      get activePortals() { return state.activePortals; },
    },
  });
  return { ...mod, state, status, last: () => status[status.length - 1] };
};

// --- 1. short() ----------------------------------------------------------------
{
  const h = setup();
  ok(h.short('builtin:teal') === 'teal', 'drops the builtin: prefix');
  ok(h.short('roms/art/x.png') === 'roms/art/x.png', 'leaves a URL alone');
  ok(h.short('a:builtin:b') === 'a:builtin:b', 'only strips a LEADING prefix');
  ok(h.short(null) === '' && h.short(undefined) === '', 'null/undefined → empty string, never a throw');
}

// --- 2. collectionKeys() reads the room LIVE -----------------------------------
{
  const h = setup({ currentRoom: { collections: ['a.json'], props: [{ type: 'shelf', collection: 'b.json' }] } });
  const keys = h.collectionKeys();
  ok(keys.includes('a.json') && keys.includes('b.json'),
    'top-level collections AND any shelf prop refs count as cyclable keys');
  // main.js reassigns currentRoom on every room load — the module must see it.
  h.state.currentRoom = { collections: ['c.json'], props: [] };
  ok(h.collectionKeys().join() === 'c.json', 'a reassigned currentRoom is picked up (live getter)');
}

// --- 3. cycleAllPosters() ------------------------------------------------------
{
  const h = setup();
  h.cycleAllPosters();
  ok(h.last() === 'no posters in this room', 'empty room says so and does nothing');
}
{
  const mat = () => ({ color: { set() {} }, map: null, needsUpdate: false });
  const posters = [
    { prop: { type: 'poster', texture: 'builtin:teal', imageFile: 'user.png' }, object: { material: mat() } },
    { prop: { type: 'poster', texture: 'builtin:teal', imageFile: 'user2.png' }, object: { material: mat() } },
  ];
  const h = setup({ roomPosters: posters });
  h.cycleAllPosters();
  ok(posters.every((p) => p.prop.texture !== 'builtin:teal'), 'every poster advanced to new art');
  ok(posters.every((p) => !('imageFile' in p.prop)),
    'FIX D: the user-picked imageFile is cleared on every poster, not just the last');
  ok(h.last() === `All posters: ${h.short(posters[1].prop.texture)}`,
    'status names the LAST poster, prefix-stripped');
}

// --- 4. cycleSelected(): nothing selected --------------------------------------
{
  const h = setup();
  h.cycleSelected();
  ok(h.last() === 'Change: grip a prop to select it first', 'tells the user to select something');
  h.state.editor = null;               // main.js's `editor` is null until buildCartridgeWorld
  h.cycleSelected();
  ok(h.status.length === 2 && h.last() === 'Change: grip a prop to select it first',
    'a null editor is the same status line, not a crash');
}

// --- 5. cycleSelected(): poster ------------------------------------------------
{
  const rec = {
    prop: { type: 'poster', texture: 'builtin:teal', imageFile: 'user.png' },
    object: { material: { color: { set() {} }, map: null, needsUpdate: false } },
  };
  const h = setup({ editor: makeEditor(rec) });
  h.cycleSelected();
  ok(rec.prop.texture !== 'builtin:teal', 'poster art advanced');
  ok(!('imageFile' in rec.prop), 'FIX D: imageFile cleared');
  ok(h.last() === `Poster art: ${h.short(rec.prop.texture)}`, 'status reports the new art');
}

// --- 6. cycleSelected(): shelf, fewer than two collections ---------------------
{
  const rec = { prop: { type: 'shelf', collection: 'a' }, object: { children: [] } };
  const h = setup({ editor: makeEditor(rec), currentRoom: { collections: ['a'], props: [] } });
  h.cycleSelected();
  ok(h.last() === 'only one collection loaded', 'refuses to cycle a single-collection room');
  ok(rec.prop.collection === 'a', 'and leaves the descriptor untouched');
}

// --- 7. cycleSelected(): shelf, real rebuild -----------------------------------
{
  const cols = makeCollections(collection('a', 3), collection('b', 2));
  const oldCart = { userData: { kind: 'cartridge' } };
  const oldShelf = { children: [oldCart, { userData: { kind: 'plank' } }] };
  const rec = { prop: { type: 'shelf', id: 's1', collection: 'a', pos: [0, 1, 0], rot: [0, 0, 0] }, object: oldShelf };
  const h = setup({
    editor: makeEditor(rec),
    currentCollections: cols,
    currentRoom: { collections: ['a', 'b'], props: [] },
  });
  h.cycleSelected();
  ok(rec.prop.collection === 'b', 'descriptor now points at the next collection');
  ok(h.state.scene.removed[0] === oldShelf, 'the old shelf left the scene');
  ok(h.state.scene.added.length === 1, 'and exactly one replacement was built into it');
  ok(h.state.grabMgr.removed.includes(oldCart) && h.state.grabMgr.removed.includes(oldShelf),
    'old carts AND the old shelf were un-grabbed (a leak here strands dead grabbables)');
  ok(h.state.grabMgr.added.length === 2, 'the two carts of collection b became grabbable');
  const kinds = h.state.editor.calls.map((c) => c[0]);
  ok(kinds.join() === 'removePlaced,registerPlaced,select',
    'editor sees remove → register → re-select, in that order (re-select keeps the highlight)');
  ok(h.state.editor.calls[1][2] === h.state.scene.added[0], 'the NEW object is what got registered');
  ok(h.last() === 'Shelf collection: b', 'status reports the new collection');
}

// --- 8. cycleSelected(): shelf rollback when the next collection is empty ------
{
  const cols = makeCollections(collection('a', 2), collection('empty', 0));
  const oldShelf = { children: [] };
  const rec = { prop: { type: 'shelf', id: 's1', collection: 'a', pos: [0, 1, 0], rot: [0, 0, 0] }, object: oldShelf };
  const h = setup({
    editor: makeEditor(rec),
    currentCollections: cols,
    currentRoom: { collections: ['a', 'empty'], props: [] },
  });
  h.cycleSelected();
  ok(rec.prop.collection === 'a',
    'ROLLBACK: an empty collection restores the previous one (a net-synced descriptor must not be left broken)');
  ok(h.state.scene.removed.length === 0 && h.state.scene.added.length === 0,
    'and the old shelf was never touched');
  ok(h.last() === '"empty" has no games', 'status names the collection that failed');
}

// --- 9. cycleSelected(): bookcase rebuild + rollback ---------------------------
{
  const cols = makeCollections(collection('a', 2), collection('b', 7));
  // A REAL THREE.Group here, not a stub: rebuildBookcase re-homes the carts
  // through lockBookcaseHomes, which needs real world matrices.
  const oldCart = new THREE.Object3D(); oldCart.userData.kind = 'cartridge';
  const oldPlaque = new THREE.Object3D(); oldPlaque.userData.kind = 'coverPlaque';
  const group = new THREE.Group();
  group.add(oldCart, oldPlaque);
  const rec = { prop: { type: 'bookcase', id: 'b1', collection: 'a', pos: [0, 0, 0], rot: [0, 0, 0] }, object: group };
  const h = setup({
    editor: makeEditor(rec),
    currentCollections: cols,
    currentRoom: { collections: ['a', 'b'], props: [] },
  });
  h.cycleSelected();
  ok(rec.prop.collection === 'b', 'bookcase descriptor advanced');
  ok(h.state.grabMgr.removed[0] === oldCart, 'the old cart was un-grabbed');
  const carts = group.children.filter((c) => c.userData?.kind === 'cartridge');
  ok(carts.length === 7, 'all 7 games of the new collection are on the shelves (3 rows x max 5)');
  ok(!carts.includes(oldCart), 'and the old cart is gone from the group');
  ok(h.state.grabMgr.added.length === 7, 'every new cart became grabbable');
  ok(group.children.filter((c) => c.userData?.kind === 'coverPlaque').length === 1,
    'exactly one cover plaque — the old one is replaced, not stacked');
  ok(h.last() === 'Bookcase collection: b', 'status reports the new collection');
  ok(h.state.scene.added.length === 0, 'the bookcase group itself is reused, never re-added to the scene');
}
{
  const cols = makeCollections(collection('a', 2), collection('empty', 0));
  const group = new THREE.Group();
  const rec = { prop: { type: 'bookcase', id: 'b1', collection: 'a', pos: [0, 0, 0], rot: [0, 0, 0] }, object: group };
  const h = setup({
    editor: makeEditor(rec),
    currentCollections: cols,
    currentRoom: { collections: ['a', 'empty'], props: [] },
  });
  h.cycleSelected();
  ok(rec.prop.collection === 'a', 'ROLLBACK: bookcase restores the previous collection too');
  ok(h.last() === '"empty" has no games', 'and says which one was empty');
}

// --- 10. cycleSelected(): portal -----------------------------------------------
{
  // Portals live in room.portals[], never get a `.type`, and are identified by
  // object.userData.kind — that is the branch condition being pinned here.
  const prop = { target: 'roms/bedroom.room.json' };
  const rec = { prop, object: { userData: { kind: 'portal', target: 'roms/bedroom.room.json' } } };
  const live = { prop, target: 'roms/bedroom.room.json' };
  const h = setup({ editor: makeEditor(rec), activePortals: [live, { prop: {}, target: 'other' }] });
  h.cycleSelected();
  ok(prop.target === 'roms/arcade.room.json', 'portal descriptor advanced to the next known room');
  ok(rec.object.userData.target === prop.target, 'the object mirror was updated');
  ok(live.target === prop.target,
    'the activePortals snapshot the proximity-nav tick reads was kept in sync (else you walk into a stale room)');
  ok(h.last() === 'Portal target: roms/arcade.room.json', 'status reports the new target');
}
{
  const rec = { prop: { target: 'x' }, object: { userData: { kind: 'portal' } } };
  const h = setup({ editor: makeEditor(rec), knownRooms: ['only.room.json'] });
  h.cycleSelected();
  ok(h.last() === 'only one known room' && rec.prop.target === 'x', 'one known room → refuse, unchanged');
}

// --- 11. cycleSelected(): a type with nothing to cycle -------------------------
{
  const rec = { prop: { type: 'furniture' }, object: { userData: {} } };
  const h = setup({ editor: makeEditor(rec) });
  h.cycleSelected();
  ok(h.last() === 'nothing to change for furniture', 'furniture/console fall through to a plain status line');
}

// --- 12. ctx is late-bound ------------------------------------------------------
// The extraction-specific regression test. main.js constructs this module at
// module-eval time, when `editor` and `grabMgr` are still null and no room is
// loaded; every one of those bindings is assigned later. Destructuring `ctx`
// anywhere in PropChangeMode.js turns all of Change mode into a silent no-op,
// and no other test in this repo would catch it.
{
  const h = setup({ editor: null, grabMgr: null });
  ok(h.collectionKeys().length === 0, 'no room yet → nothing to cycle');
  const rec = {
    prop: { type: 'poster', texture: 'builtin:teal' },
    object: { material: { color: { set() {} }, map: null, needsUpdate: false } },
  };
  h.state.editor = makeEditor(rec);    // ← buildCartridgeWorld happens
  h.cycleSelected();
  ok(h.last().startsWith('Poster art:'), 'an editor assigned AFTER construction is used');

  // Same for grabMgr + currentCollections + currentRoom, via the shelf rebuild.
  const cols = makeCollections(collection('a', 1), collection('b', 2));
  const shelfRec = {
    prop: { type: 'shelf', id: 's', collection: 'a', pos: [0, 1, 0], rot: [0, 0, 0] },
    object: { children: [] },
  };
  h.state.editor = makeEditor(shelfRec);
  h.state.grabMgr = makeGrabMgr();
  h.state.currentCollections = cols;
  h.state.currentRoom = { collections: ['a', 'b'], props: [] };
  h.cycleSelected();
  ok(h.last() === 'Shelf collection: b', 'a grabMgr / collections / room assigned after construction are all used');
  ok(h.state.grabMgr.added.length === 2, 'and it is the NEW grabMgr that received the carts');
}

console.log(`test-prop-change: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
