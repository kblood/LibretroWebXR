import * as THREE from 'three';
import { EmulatorClient } from './EmulatorClient.js';
import { InputMgr } from './InputMgr.js';
import { Placeholder } from './Placeholder.js';
import { SceneMgr } from './SceneMgr.js';
import { createConsole } from './Console.js';
import { createGamepad } from './Gamepad.js';
import { GrabMgr } from './GrabMgr.js';
import { LocomotionMgr } from './LocomotionMgr.js';
import { GameInputMgr } from './GameInputMgr.js';
import { installXRRafShim } from './XRRafShim.js';
import { installSpatialAudio } from './SpatialAudio.js';
import { createMemoryCard } from './MemoryCard.js';
import { saveState, loadState, listStates } from './SaveState.js';
import { createDebugHud } from './DebugHud.js';
import { createControlsPanel } from './ControlsPanel.js';
import { createMenuPanel } from './MenuPanel.js';
import { MenuMgr } from './MenuMgr.js';
import { CORES, coreForFile, portsForSystem } from './systems.js';
import { CableMgr } from './CableMgr.js';
import { loadCollection, parseCollection } from './Collection.js';
import { resolve as resolveRom, pickLibraryDirectory, fileSystemAccessSupported } from './RomResolver.js';
import { parseRoom, defaultRoom, roomCollectionRefs } from './RoomLoader.js';
import { buildRoom, buildProp, buildPortal, applyPosterTexture } from './RoomBuilder.js';
import { RoomEditor } from './RoomEditor.js';
import { cycleSurface, cycleTimeOfDay, cyclePosterTexture } from './EnvEditor.js';
import {
  createProp, createPortal,
  addProp as appendProp, addPortal as appendPortal,
} from './PropCreator.js';

// CORES and the system registry now live in src/systems.js (system-first,
// single source of truth). detectCore() is coreForFile() from there; the
// room/collection layer (Collection.js) consumes the same registry.
const detectCore = coreForFile;

const $ = (sel) => document.querySelector(sel);
const stage = $('#stage');
const placeholderCanvas = $('#placeholder-canvas');
// MUST be id="canvas" — RetroArch's input driver hardcodes that selector.
const emuCanvas = $('#canvas');
const romInput = $('#rom-input');
const resetBtn = $('#reset-btn');
const status = $('#status');
const titleEl = $('header h1');

const setStatus = (text) => { status.textContent = text; };
const setSystemLabel = (core) => {
  const label = core ? (CORES[core]?.label || core) : 'idle';
  titleEl.textContent = `LibretroWebXR · ${label}`;
};

if (!self.crossOriginIsolated) {
  console.warn('Page is not cross-origin isolated. SharedArrayBuffer unavailable; some cores will fail.');
}

const urlParams = new URLSearchParams(location.search);
const coreOverride = urlParams.get('core');

const client = new EmulatorClient();
const input = new InputMgr(client);
// Tracks the core + file actually currently loaded (after `ready` fires).
// Used to decide between in-place ROM swap and page-reload-with-state for
// cross-system swaps, and to tag any save-state written from this session.
let currentCore = null;
let currentMeta = null;
const placeholder = new Placeholder(placeholderCanvas);
placeholder.setMessage('Pick up a cartridge');
placeholder.start();

// All controller→emulator input is owned by GameInputMgr now, polled each
// frame from the gamepad-holding controller's inputSource.gamepad. The
// per-event selectstart/squeeze hooks SceneMgr forwards are unused for the
// emulator (kept available for future non-game features like teleport).
const scene = new SceneMgr({
  container: stage,
  sourceCanvas: placeholderCanvas,
  onControllerButton: () => {},
});
// Keep the libretro core's window.rAF main loop running while presenting in
// VR. Quest browser otherwise freezes the page's rAF queue during an XR
// session; see src/XRRafShim.js.
installXRRafShim(scene.renderer);
// Reroute the core's audio through THREE.PositionalAudio anchored on the TV.
// Must happen BEFORE the core ever runs `new AudioContext()` — see
// src/SpatialAudio.js.
installSpatialAudio({ listener: scene.audioListener, sourceObject: scene.tvGroup });
window.__scene = scene;
window.__client = client;

// --- Build the VR cartridge world ----------------------------------------
//
// The world is now declarative (Phase R.3): a parsed *.room.json descriptor
// ([[src/RoomLoader.js]]) is handed to RoomBuilder, which drives the same
// Shelf/Console/Cartridge/Gamepad factories that used to be called by hand
// here. main.js keeps ownership of everything stateful (grab/input/menus,
// save states, portal navigation). With no ?room= the built-in defaultRoom()
// reproduces the historical two-shelf layout exactly.

let grabMgr = null;
let gameInput = null;
let cartridges = [];
let consoleObj = null;
let gamepadObj = null;
// Local-multiplayer cable system: which gamepad is plugged into which console
// port → which player it drives ([[src/CableMgr.js]]). Each gamepad object gets
// a stable userData.cableId; the default one auto-plugs into port 0 (player 1).
const cable = new CableMgr();
let gamepadCount = 0;
const registerGamepad = (obj) => {
  if (obj && obj.userData.cableId == null) obj.userData.cableId = `gp-${++gamepadCount}`;
  return obj;
};

// Which player each hand drives this frame, for GameInputMgr ([[src/
// GameInputMgr.js]]). Policy: one held gamepad → both hands forward to its
// player (the original two-hands-one-player feel for >4-button systems); two
// held gamepads → each holding hand drives only its own gamepad's player.
function computeRouting() {
  if (!grabMgr) return [];
  const held = [];
  for (const ctrl of scene.controllers) {
    const obj = grabMgr.heldObject(ctrl);
    if (obj?.userData?.kind === 'gamepad') held.push({ ctrl, obj });
  }
  if (held.length === 0) return [];
  if (held.length === 1) {
    const { ctrl: holdCtrl, obj } = held[0];
    const player = cable.playerOf(obj.userData.cableId);
    const routing = [{ ctrl: holdCtrl, player, hand: 'holding' }];
    for (const ctrl of scene.controllers) {
      if (ctrl !== holdCtrl && grabMgr.isControllerFree(ctrl)) {
        routing.push({ ctrl, player, hand: 'free' });
      }
    }
    return routing;
  }
  return held.map(({ ctrl, obj }) => ({
    ctrl, player: cable.playerOf(obj.userData.cableId), hand: 'holding',
  }));
}
let debugHud = null;
let editor = null;       // Phase E.1 in-VR room editor (set in buildCartridgeWorld)
let currentRoom = null;  // the parsed room descriptor we serialize back on export
let roomPosters = [];    // Phase E.2: { prop, object } for each poster, for live env edits
let currentCollections = null; // Phase E.3: { byKey, list } — needed to build a new shelf in-VR
let activePortals = [];  // Phase E.3: live portal records the proximity tick navigates (mutable)
let editButton = null;   // Phase E.3: the menu's Edit Room button, so addProp can sync its label

const DROP_KEY = 'libretrowebxr.dropped';

async function fetchJson(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    return await r.json();
  } catch (e) {
    console.warn('[main] fetch json failed:', e.message || e);
    return null;
  }
}

// A room/collection JSON dropped onto the page is stashed and the page
// reloads (same robust path as a cross-core swap); we pick it up here.
function readDroppedWorld() {
  const raw = sessionStorage.getItem(DROP_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(DROP_KEY);
  try {
    const { kind, text } = JSON.parse(raw);
    const obj = JSON.parse(text);
    if (kind === 'room') return { room: parseRoom(obj, { sourceLabel: 'dropped room' }), inline: [] };
    const col = parseCollection(obj, { sourceLabel: 'dropped collection' });
    const ref = `dropped:${col.id || 'collection'}`;
    return { room: defaultRoom(ref), inline: [[ref, col]] };
  } catch (e) {
    console.warn('[main] bad dropped world:', e);
    return null;
  }
}

// Decide what to build: a dropped file wins; else ?room=URL loads a full
// room; else ?collection=URL (or the default manifest) drops a bare
// collection into the built-in room layout.
async function resolveWorld() {
  const dropped = readDroppedWorld();
  if (dropped) return dropped;

  const roomUrl = urlParams.get('room');
  if (roomUrl) {
    const obj = await fetchJson(roomUrl);
    return { room: parseRoom(obj || {}, { sourceLabel: roomUrl }), inline: [] };
  }

  const collectionUrl = urlParams.get('collection') || 'roms/manifest.json';
  return { room: defaultRoom(collectionUrl), inline: [] };
}

// Load every collection a room references into a { byKey, list } the builder
// can resolve shelves against. Inline (dropped) collections are pre-seeded.
async function loadRoomCollections(room, inline) {
  const byKey = new Map();
  const list = [];
  const register = (refs, col) => {
    if (!col) return;
    list.push(col);
    for (const r of refs) if (r) byKey.set(r, col);
    if (col.id) byKey.set(col.id, col);
  };
  for (const [ref, col] of inline) register([ref], col);
  for (const ref of roomCollectionRefs(room)) {
    if (byKey.has(ref)) continue;
    register([ref], await loadCollection(ref));
  }
  return { byKey, list };
}

async function buildCartridgeWorld() {
  const { room, inline } = await resolveWorld();
  currentRoom = room;
  const collections = await loadRoomCollections(room, inline);
  currentCollections = collections; // Phase E.3: build a new shelf against these
  const allGames = collections.list.flatMap((c) => c.games);
  window.__games = allGames; // debug hook: harness boots via these metas
  setStatus(allGames.length ? `${allGames.length} games` : 'no games');

  const built = buildRoom({ scene, room, collections });
  cartridges = built.cartridges;
  consoleObj = built.consoleObj;
  gamepadObj = built.gamepadObj;
  roomPosters = built.placed.filter((e) => e.prop.type === 'poster');

  // A room may omit a console/gamepad; the load + input wiring below needs
  // both, so fall back to the default placements.
  if (!consoleObj) {
    consoleObj = createConsole({ position: new THREE.Vector3(0, 0.74, -2.4) });
    scene.addObject(consoleObj);
  }
  if (!gamepadObj) {
    gamepadObj = createGamepad({ position: new THREE.Vector3(0.55, 0.78, -2.15) });
    scene.addObject(gamepadObj);
  }
  // The default gamepad is player 1: logically plug it into port 0 (it stays at
  // its rest spot — only explicit re-plugging moves the mesh). This also marks
  // port 0 taken so the first "Add Gamepad" auto-plugs into port 1 (player 2).
  registerGamepad(gamepadObj);
  cable.plug(gamepadObj.userData.cableId, 0);
  // Show the controller-port count for the current system (2 until a game loads).
  consoleObj.userData.setPorts?.(portsForSystem(currentMeta?.system));

  // Live gamepad debug readout floats above the controller mesh. Parented
  // to the gamepad so it follows whether the gamepad is sitting at rest or
  // being held — the user can glance at it to see exactly which button
  // indices are firing on Quest.
  debugHud = createDebugHud();
  debugHud.position.set(0, 0.30, 0);
  debugHud.rotation.x = -Math.PI / 6;
  gamepadObj.add(debugHud);

  grabMgr = new GrabMgr({
    scene: scene.scene,
    controllers: scene.controllers,
    console: consoleObj,
    cable,
    onCartridgeInserted: handleCartridgeInserted,
    onGamepadHeldChanged: (held) => {
      // When the gamepad is released, flush any still-pressed keys so the
      // emulator doesn't latch a held button on the controller's last
      // pre-drop state.
      if (!held) gameInput.flushReleases();
    },
    // Plugging/unplugging a gamepad changes which player it drives; flush so a
    // key held under the old assignment doesn't latch on the core.
    onGamepadPlugged: () => gameInput?.flushReleases(),
    onMemoryCardInserted: handleMemoryCardInserted,
    // Phase E: deferred arrows — `editor` is assigned just below and these are
    // only called at tick/release time, never during GrabMgr construction.
    isEditMode: () => editor?.isEditMode() || false,
    onEditRelease: (obj) => editor?.onEditRelease(obj),
  });
  cartridges.forEach((c) => grabMgr.addGrabbable(c));
  grabMgr.addGrabbable(gamepadObj);

  // In-VR room editor (Phase E.1): registers the room's props as editable
  // grabbables (inert until edit mode) and serializes them back on export.
  editor = new RoomEditor({
    scene, room: currentRoom, placed: built.placed, grabMgr, onStatus: setStatus,
  });
  // Debug hooks exposed early (before the awaits below) so they're available
  // even if a later async step (e.g. IndexedDB) is slow. __add drives Phase E.3
  // prop creation headlessly (the menu buttons are raycast-only, and the menu is
  // built after the buildMemoryCards await that stalls in headless Chrome).
  window.__editor = editor;
  window.__grab = grabMgr;
  window.__cable = cable; // debug: inspect port↔player↔gamepad assignments
  window.__add = {
    shelf:   () => addProp('shelf'),
    console: () => addProp('console'),
    gamepad: () => addProp('gamepad'),
    poster:  () => addProp('poster'),
    portal:  () => addPortal(),
  };

  await buildMemoryCards();

  const locomotion = new LocomotionMgr({
    renderer: scene.renderer,
    playerRig: scene.playerRig,
    camera: scene.camera,
    controllers: scene.controllers,
    isHandFree: (ctrl) => grabMgr.isControllerFree(ctrl),
    // While the gamepad is held both thumbsticks become d-pad input, so
    // locomotion must yield entirely or the player walks every time they
    // press a direction in-game.
    isGamepadHeld: () => grabMgr.isGamepadHeld(),
  });

  gameInput = new GameInputMgr({
    controllers: scene.controllers,
    client,
    isControllerHoldingGamepad: (ctrl) => grabMgr.isControllerHoldingGamepad(ctrl),
    isGamepadHeld: () => grabMgr.isGamepadHeld(),
    // Local-multiplayer routing: which player each hand drives this frame.
    getRouting: computeRouting,
    // LED pulse for every emulator keydown — visible in-VR feedback that
    // gamepad input is reaching the core.
    onKeyDown: () => consoleObj.userData.pulse?.(0xffffff, 90),
  });

  scene.addTickCallback((dt) => grabMgr.tick(dt));
  scene.addTickCallback((dt) => locomotion.tick(dt));
  scene.addTickCallback(() => gameInput.tick());
  // DebugHud reads from GameInputMgr each frame and redraws its canvas
  // texture. Cheap (~480×360 fill) but throttle if needed.
  scene.addTickCallback(() => debugHud.userData.update(gameInput.getDebugState()));
  // Drive the gamepad mesh's per-button depress + glow from the union of
  // both hands' inputs — so even a free-hand press lights up the
  // corresponding slot on the visual gamepad. Axis preference: holding
  // hand wins, else free hand.
  scene.addTickCallback(() => {
    const s = gameInput.getDebugState();
    if (!s) { gamepadObj.userData.setInput?.({}); return; }
    const h = s.holding, f = s.free;
    const or = (i) => !!(h?.buttons[i]?.pressed) || !!(f?.buttons[i]?.pressed);
    const ax = (i) => (h?.axes[i] ?? 0) || (f?.axes[i] ?? 0);
    gamepadObj.userData.setInput?.({
      a:      or(0),  // trigger
      b:      or(4),  // face A/X
      start:  or(5),  // face B/Y
      select: or(3),  // stick click
      axisX:  ax(2),
      axisY:  ax(3),
    });
  });

  activePortals = built.portals; // Phase E.3: addPortal() appends to this live list
  buildMenuAndControlsPanel();
  installPortals();

  window.__locomotion = locomotion;
  window.__gameInput = gameInput;
  window.__room = room;

  // After everything's built, see if we're resuming a cross-system swap.
  await resumePendingLoad();
}

// Portals navigate to another room (a *.room.json URL) when the player walks
// into the doorway. We change the URL and let the page rebuild from scratch —
// the same clean-slate approach used for cross-core swaps (libretro cores
// can't cleanly unload). Proximity is checked on the rig's XZ position.
function installPortals() {
  let navigated = false;
  const playerPos = new THREE.Vector3();
  scene.addTickCallback(() => {
    if (navigated) return;
    if (editor?.isEditMode()) return; // don't teleport while dragging a portal
    if (!activePortals.length) return;
    scene.playerRig.getWorldPosition(playerPos);
    for (const p of activePortals) {
      const dx = playerPos.x - p.object.position.x;
      const dz = playerPos.z - p.object.position.z;
      if (Math.hypot(dx, dz) <= p.radius) {
        navigated = true;
        setStatus(`entering ${p.target}…`);
        location.assign(`${location.pathname}?room=${encodeURIComponent(p.target)}`);
        break;
      }
    }
  });
}

// --- Phase E.3: create new props/portals in-VR ---------------------------
//
// E.1 moves existing props; E.2 edits the room's look; E.3 ADDS to the
// descriptor. Each "Add X" spawns a fresh prop in front of the player, builds
// it through the same RoomBuilder factory the loaded room uses, pushes the
// descriptor into currentRoom, and registers it as an editable grabbable — so
// E.1 move + E.2 look-editing + Export Room all apply to it immediately.

// Default spawn height per type so a new prop lands at a sensible level (the
// user then grabs it to its final spot). Posters go on walls; shelves/consoles
// at furniture height.
const SPAWN_Y = { shelf: 1.25, console: 0.74, gamepad: 0.78, poster: 1.5, portal: 0 };

// Example rooms a new portal can target (URL today; a local-id registry is a
// deferred item). addPortal aims at one that isn't the current room so
// walk-through navigation is verifiable out of the box.
const KNOWN_ROOMS = ['roms/bedroom.room.json', 'roms/arcade.room.json'];

// A spot ~1.4 m in front of the player on the floor plane, with a yaw that faces
// the new prop back toward them. Reads the camera's last-rendered world pose
// (controller events fire outside the XR rAF, so the pose is a frame stale —
// fine for an initial placement the user adjusts by grabbing).
function spawnTransform(y = 1.2) {
  const camPos = new THREE.Vector3();
  const dir = new THREE.Vector3();
  scene.camera.getWorldPosition(camPos);
  scene.camera.getWorldDirection(dir); // points where the player looks (into the room)
  dir.y = 0;
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
  dir.normalize();
  const p = camPos.clone().addScaledVector(dir, 1.4);
  // Face the prop's +Z back toward the player (opposite the look direction).
  const yawDeg = (Math.atan2(-dir.x, -dir.z) * 180) / Math.PI;
  return { pos: [p.x, y, p.z], rot: [0, yawDeg, 0] };
}

// Force edit mode on (so the freshly added prop is immediately grabbable) and
// keep the Edit Room button's label in sync if the menu's been built.
function ensureEditMode() {
  if (!editor || editor.isEditMode()) return;
  editor.setEditMode(true);
  editButton?.setLabel('Exit Edit');
}

// Add a new prop of `type` in front of the player. Returns the descriptor (or
// null if it couldn't be built — e.g. a shelf with no collection to fill it).
function addProp(type) {
  if (!editor || !currentRoom) return null;
  const t = spawnTransform(SPAWN_Y[type] ?? 1.2);
  const prop = createProp(currentRoom, type, t);
  if (!prop) { setStatus(`can't add ${type}`); return null; }

  const r = buildProp(prop, { scene, collections: currentCollections });
  if (!r) { setStatus(`add ${type} failed (nothing to build)`); return null; }

  appendProp(currentRoom, prop);
  editor.registerPlaced(prop, r.object);
  // A new shelf's cartridges are play-mode grabbables (NOT editable props), like
  // any other cartridge — register them so they can be picked up and inserted.
  if (r.kind === 'shelf') r.cartridges.forEach((c) => grabMgr.addGrabbable(c));

  // A new gamepad joins the cable system: register it, make it grabbable, and
  // auto-plug it into the next free port so one tap yields the next player.
  // It seats at the port (no placement step) rather than spawning mid-air.
  if (r.kind === 'gamepad') {
    registerGamepad(r.object);
    grabMgr.addGrabbable(r.object);
    const port = seatGamepadInFreePort(r.object);
    setStatus(port == null ? 'added gamepad (no free port)' : `added gamepad → player ${port + 1}`);
    return prop;
  }

  ensureEditMode();
  setStatus(`added ${type} — grab to place`);
  return prop;
}

// Plug a gamepad into the lowest free, enabled console port and snap its mesh
// onto that port's seat. Returns the port index, or null if all are taken.
function seatGamepadInFreePort(obj) {
  const cu = consoleObj?.userData;
  if (!cu?.portAnchors) return null;
  const port = cable.firstFreePort(cu.activePorts);
  if (port == null) return null;
  const anchor = cu.portAnchors[port];
  const p = new THREE.Vector3(), q = new THREE.Quaternion();
  anchor.getWorldPosition(p);
  anchor.getWorldQuaternion(q);
  obj.position.copy(p);
  obj.quaternion.copy(q);
  cable.plug(obj.userData.cableId, port);
  return port;
}

// Add a new portal aimed at an example room (one that isn't the current room),
// register it for proximity navigation, and make it editable-grabbable.
function addPortal() {
  if (!editor || !currentRoom) return null;
  const here = urlParams.get('room');
  const target = KNOWN_ROOMS.find((u) => u !== here) || KNOWN_ROOMS[0];
  const t = spawnTransform(SPAWN_Y.portal);
  const portal = createPortal(currentRoom, { target, pos: t.pos, rot: t.rot });
  if (!portal) { setStatus('add portal failed'); return null; }

  const object = buildPortal(portal);
  scene.addObject(object);
  appendPortal(currentRoom, portal);
  editor.registerPlaced(portal, object);
  // Proximity nav reads object.position; the record mirrors buildRoom's shape.
  activePortals.push({ object, prop: portal, target: portal.target, radius: portal.radius });

  ensureEditMode();
  setStatus(`added portal → ${target} — grab to place`);
  return portal;
}

// --- In-VR menu + controls panel -----------------------------------------

let controlsPanel = null;
function buildMenuAndControlsPanel() {
  controlsPanel = createControlsPanel();
  scene.addObject(controlsPanel);
  // Make the controls panel reflect whichever core is currently running.
  updateControlsPanel();

  const menuMgr = new MenuMgr({
    controllers: scene.controllers,
    // When the gamepad is held BOTH hands are forwarding emulator input,
    // so neither should fire menu clicks — otherwise pressing the in-game
    // A button also toggles the menu.
    isGamepadHeld: () => grabMgr.isGamepadHeld(),
  });

  const menu = createMenuPanel({
    title: 'Menu',
    items: [
      { label: 'Show Controls', onActivate: () => {} },
      { label: 'Show Debug',    onActivate: () => {} },
      { label: 'Reset Game',    onActivate: () => client.reset() },
      { label: 'Edit Room',     onActivate: () => {} },
      { label: 'Snap: Off',     onActivate: () => {} },
      { label: 'Export Room',   onActivate: () => editor?.export() },
      // Phase E.2 — in-VR environment editing. Each cycles a palette and
      // re-applies live; the change rides out through Export Room.
      { label: 'Wallpaper',     onActivate: () => {} },
      { label: 'Floor',         onActivate: () => {} },
      { label: 'Lighting',      onActivate: () => {} },
      { label: 'Posters',       onActivate: () => {} },
      // Phase E.3 — create new props/portals in-VR. Each spawns in front of the
      // player, becomes an editable grabbable, and rides out through Export Room.
      { label: 'Add Shelf',     onActivate: () => addProp('shelf') },
      { label: 'Add Console',   onActivate: () => addProp('console') },
      { label: 'Add Poster',    onActivate: () => addProp('poster') },
      { label: 'Add Portal',    onActivate: () => addPortal() },
    ],
  });
  scene.addObject(menu);

  // Wire each button's onActivate now that the panel exists (the toggle
  // closures need to mutate the same button to relabel between Show/Hide).
  const [controlsBtn, debugBtn, , editBtn, snapBtn] = menu.userData.buttons;
  editButton = editBtn; // Phase E.3: addProp's ensureEditMode keeps this label in sync
  let controlsVisible = false;
  controlsBtn.onActivate = () => {
    controlsVisible = !controlsVisible;
    controlsPanel.userData.setVisible(controlsVisible);
    controlsBtn.setLabel(controlsVisible ? 'Hide Controls' : 'Show Controls');
  };
  let debugVisible = true;
  debugBtn.onActivate = () => {
    debugVisible = !debugVisible;
    debugHud.userData.setVisible(debugVisible);
    debugBtn.setLabel(debugVisible ? 'Hide Debug' : 'Show Debug');
  };
  debugBtn.setLabel('Hide Debug');

  // Phase E.1: toggle the in-VR room editor + its free/grid snap setting.
  editBtn.onActivate = () => {
    const on = editor?.toggle();
    editBtn.setLabel(on ? 'Exit Edit' : 'Edit Room');
  };
  snapBtn.onActivate = () => {
    const on = editor?.setSnap(!editor?.snapEnabled());
    snapBtn.setLabel(on ? 'Snap: On' : 'Snap: Off');
  };

  // Phase E.2: environment editing. Cycle a palette, mutate the live room
  // descriptor (so Export Room captures it), and re-apply immediately.
  const short = (v) => String(v || '').replace(/^builtin:/, '');
  const [wallpaperBtn, floorBtn, lightingBtn, postersBtn] = menu.userData.buttons.slice(6);
  wallpaperBtn.onActivate = () => {
    const v = cycleSurface(currentRoom, 'wallpaper');
    scene.applyEnvironment(currentRoom.environment);
    setStatus(`Wallpaper: ${short(v)}`);
  };
  floorBtn.onActivate = () => {
    const v = cycleSurface(currentRoom, 'floor');
    scene.applyEnvironment(currentRoom.environment);
    setStatus(`Floor: ${short(v)}`);
  };
  lightingBtn.onActivate = () => {
    const v = cycleTimeOfDay(currentRoom);
    scene.applyEnvironment(currentRoom.environment);
    setStatus(`Lighting: ${v}`);
  };
  postersBtn.onActivate = () => {
    if (!roomPosters.length) { setStatus('no posters in this room'); return; }
    let last;
    for (const { prop, object } of roomPosters) {
      last = cyclePosterTexture(prop); // advance each poster from its own value
      applyPosterTexture(object.material, prop.texture);
    }
    setStatus(`Posters: ${short(last)}`);
  };

  for (const b of menu.userData.buttons) {
    menuMgr.addItem(b.mesh, b.onActivate);
  }

  scene.addTickCallback(() => menuMgr.tick());
  window.__menu = menuMgr;
  // Debug hook: drive the E.2 env edits headlessly (the menu is raycast-only).
  window.__env = {
    wallpaper: wallpaperBtn.onActivate,
    floor: floorBtn.onActivate,
    lighting: lightingBtn.onActivate,
    posters: postersBtn.onActivate,
  };
}

function updateControlsPanel() {
  if (!controlsPanel) return;
  const coreInfo = currentMeta ? CORES[currentMeta.core] : null;
  controlsPanel.userData.update({
    system: currentMeta?.system || null,
    coreLabel: coreInfo ? coreInfo.label : '(no game loaded)',
  });
}

// --- Cartridge → load wiring ---------------------------------------------

const PENDING_KEY = 'libretrowebxr.pending';

function handleCartridgeInserted(meta) {
  if (!CORES[meta.core]) {
    setStatus(`unknown core ${meta.core}`);
    return;
  }
  // Same-core swap: keep the page, just feed the new ROM. Different core:
  // full page reload (libretro cores can't cleanly unload — they pin globals
  // on the window and own a WebGL context that survives even after callMain
  // returns). sessionStorage preserves the chosen ROM across the reload.
  if (currentCore && currentCore !== meta.core) {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({
      file: meta.file, core: meta.core, system: meta.system, title: meta.title,
    }));
    setStatus(`switching to ${meta.title}…`);
    location.reload();
    return;
  }
  loadCartridge(meta);
}

async function loadCartridge(meta) {
  setStatus(`loading ${meta.title}…`);
  try {
    // RomResolver (Phase R.2) turns the entry into bytes from url / local
    // folder / picker / OPFS cache, per its rom.source (default: url).
    const buf = await resolveRom(meta);
    const core = CORES[meta.core];
    await client.start(emuCanvas, buf, { coreUrl: core.url, coreName: meta.core, moduleStyle: core.style });
    currentCore = meta.core;
    currentMeta = { core: meta.core, file: meta.file, title: meta.title, system: meta.system };
    gameInput?.setSystem(meta.system);
    // Enable exactly the controller ports this system's hardware accepts.
    consoleObj?.userData.setPorts?.(portsForSystem(meta.system));
    setSystemLabel(meta.core);
    updateControlsPanel();
  } catch (e) {
    setStatus(`error: ${e.message || e}`);
  }
}
window.__loadCartridge = loadCartridge; // debug hook: boot a game via RomResolver

async function resumePendingLoad() {
  const raw = sessionStorage.getItem(PENDING_KEY);
  if (!raw) return;
  sessionStorage.removeItem(PENDING_KEY);
  try {
    const meta = JSON.parse(raw);
    await loadCartridge(meta);
    // Snap the matching cart into the slot so the visual state matches the
    // running ROM — without this, after a cross-system reload the cart
    // appears back on its shelf even though the game is playing on the TV.
    const cart = cartridges.find((c) => c.userData.file === meta.file);
    if (cart && grabMgr) grabMgr.setInsertedCart(cart);
  } catch (e) {
    console.warn('[main] failed to resume pending load:', e);
  }
}

// --- Memory cards (save states) ------------------------------------------

let memoryCards = [];

async function buildMemoryCards() {
  // Restore previously-saved cards from IndexedDB and render 4 cards on a
  // wall-mounted rack to the user's right.
  let saved = [];
  try { saved = await listStates(); } catch (e) { console.warn('[main] listStates failed:', e); }
  const bySlot = new Map(saved.map((s) => [s.slotId, s]));

  // Small plank mirroring the cartridge shelves but lower and shorter,
  // mounted on the right wall just within reach. Cards stand upright on it.
  const rack = new THREE.Group();
  rack.name = 'memory-card-rack';
  rack.position.set(2.85, 0.95, -0.2);
  rack.rotation.y = -Math.PI / 2;
  const plank = new THREE.Mesh(
    new THREE.BoxGeometry(0.55, 0.025, 0.10),
    new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.7 }),
  );
  rack.add(plank);
  scene.addObject(rack);

  for (let i = 1; i <= 4; i++) {
    const slotId = `slot-${i}`;
    const s = bySlot.get(slotId);
    const meta = s ? { core: s.core, file: s.file, title: s.title, system: s.system, ts: s.ts } : null;
    const card = createMemoryCard({ slot: i, savedMeta: meta });
    // Stand cards on the plank, evenly spaced along its long axis.
    const x = -0.225 + (i - 1) * 0.15;
    card.position.set(x, 0.075, 0);
    rack.add(card);
    // Compute world-space home from current parented transform so a refused
    // insert can snap the card back exactly here.
    rack.updateMatrixWorld(true);
    card.updateMatrixWorld(true);
    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    card.getWorldPosition(worldPos);
    card.getWorldQuaternion(worldQuat);
    card.userData.homePosition = worldPos.clone();
    card.userData.homeQuaternion = worldQuat.clone();
    // Reparent into scene root so locomotion / drop-handling treat it like
    // any other grabbable (rack is decorative — homes are world-space).
    scene.scene.attach(card);
    card.position.copy(worldPos);
    card.quaternion.copy(worldQuat);
    grabMgr.addGrabbable(card);
    memoryCards.push(card);
  }
}

function handleMemoryCardInserted(card) {
  const meta = card.userData.savedMeta;
  // Empty card → save current game state.
  if (!meta) {
    if (!currentMeta) {
      setStatus('insert a cartridge first');
      card.userData.pulse(0xcc2222);
      return false;
    }
    if (!client.canSerialize?.()) {
      setStatus(`${currentMeta.core} core has no save-state support`);
      card.userData.pulse(0xcc2222);
      return false;
    }
    setStatus(`saving ${currentMeta.title} to slot ${card.userData.slot}…`);
    client.serializeState().then((data) => {
      const payload = {
        data,
        core: currentMeta.core,
        file: currentMeta.file,
        title: currentMeta.title,
        system: currentMeta.system,
        ts: Date.now(),
      };
      return saveState(`slot-${card.userData.slot}`, payload).then(() => {
        card.userData.setSaved({ ...currentMeta, ts: payload.ts });
        card.userData.pulse(0xffffff);
        setStatus(`saved ${currentMeta.title} to slot ${card.userData.slot}`);
      });
    }).catch((e) => {
      console.warn('[main] save failed:', e);
      setStatus(`save failed: ${e.message || e}`);
      card.userData.pulse(0xcc2222);
    });
    return true;
  }

  // Filled card → only loads if the current game matches what was saved.
  // Loading a save from a different ROM would corrupt state; the cleanest
  // refusal here is a red pulse + bounce.
  if (!currentMeta || currentMeta.file !== meta.file || currentMeta.core !== meta.core) {
    setStatus(`slot ${card.userData.slot} holds ${meta.title}; load that cart first`);
    card.userData.pulse(0xcc2222);
    return false;
  }
  if (!client.canSerialize?.()) {
    setStatus(`${currentMeta.core} core has no save-state support`);
    card.userData.pulse(0xcc2222);
    return false;
  }
  setStatus(`loading slot ${card.userData.slot}…`);
  loadState(`slot-${card.userData.slot}`).then((row) => {
    if (!row?.data) {
      setStatus(`slot ${card.userData.slot} empty`);
      card.userData.pulse(0xcc2222);
      return;
    }
    return client.unserializeState(row.data).then(() => {
      card.userData.pulse(0xffffff);
      setStatus(`loaded ${meta.title} from slot ${card.userData.slot}`);
    });
  }).catch((e) => {
    console.warn('[main] load failed:', e);
    setStatus(`load failed: ${e.message || e}`);
    card.userData.pulse(0xcc2222);
  });
  return true;
}

// --- Client event wiring -------------------------------------------------

client.addEventListener('ready', () => {
  setStatus('running');
  resetBtn.disabled = false;
  input.attach(window);
  placeholder.stop();
  scene.setScreenSource(emuCanvas);
});

client.addEventListener('error', (e) => {
  setStatus('error: ' + e.detail);
  resetBtn.disabled = true;
});

// --- Legacy file-picker path (still useful for ad-hoc testing) -----------

romInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const core = detectCore(file.name, coreOverride);
  if (!core) { setStatus(`no core known for ${file.name}`); return; }
  // If the file-picker selection requires a different core than what's
  // already loaded, take the same reload path as a cartridge swap.
  if (currentCore && currentCore !== core.name) {
    setStatus(`file-picker swap to ${core.label} requires reload`);
    return;
  }
  setStatus(`loading ${file.name} on ${core.label}…`);
  const buffer = await file.arrayBuffer();
  await client.start(emuCanvas, buffer, { coreUrl: core.url, coreName: core.name, moduleStyle: core.style });
  currentCore = core.name;
  setSystemLabel(core.name);
});

resetBtn.addEventListener('click', () => client.reset());

// ROM library folder (Phase R.2): only meaningful where the File System Access
// API exists (desktop Chromium today; Quest support varies — pick/opfs are the
// fallbacks). Reveal the button only when supported.
const romFolderBtn = $('#rom-folder-btn');
if (romFolderBtn && fileSystemAccessSupported()) {
  romFolderBtn.hidden = false;
  romFolderBtn.addEventListener('click', async () => {
    try {
      await pickLibraryDirectory();
      setStatus('ROM library folder granted');
    } catch (e) {
      if (e?.name !== 'AbortError') setStatus(`folder grant failed: ${e.message || e}`);
    }
  });
}

// Export the current (possibly edited) room as *.room.json — desktop
// convenience mirroring the in-VR "Export Room" menu item (Phase E.1).
const exportRoomBtn = $('#export-room-btn');
if (exportRoomBtn) {
  exportRoomBtn.addEventListener('click', () => editor?.export());
}

// Drag-and-drop a *.room.json or *.collection.json onto the page to load it
// (Phase R.3 sharing model). We stash the file and reload — the build path
// then reads it from sessionStorage. Detecting room vs collection: a room has
// props/environment/portals or a room schema; everything else is a collection.
function installDragAndDrop() {
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file || !/\.json$/i.test(file.name)) return;
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      const isRoom = (typeof obj?.schema === 'string' && obj.schema.includes('room'))
                   || Array.isArray(obj?.props) || Array.isArray(obj?.portals)
                   || (obj?.environment != null && !Array.isArray(obj?.games) && !Array.isArray(obj?.cartridges));
      sessionStorage.setItem(DROP_KEY, JSON.stringify({ kind: isRoom ? 'room' : 'collection', text }));
      setStatus(`loading ${file.name}…`);
      location.reload();
    } catch (err) {
      setStatus(`bad drop: ${err.message || err}`);
    }
  });
}

installDragAndDrop();
setSystemLabel(null);
buildCartridgeWorld();
