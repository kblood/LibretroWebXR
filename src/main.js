import * as THREE from 'three';
import { EmulatorClient } from './EmulatorClient.js';
import { InputMgr } from './InputMgr.js';
import { Placeholder } from './Placeholder.js';
import { SceneMgr } from './SceneMgr.js';
import { createConsole } from './Console.js';
import { createGamepad } from './Gamepad.js';
import { GrabMgr } from './GrabMgr.js';
import { LocomotionMgr } from './LocomotionMgr.js';
import { DesktopControls } from './DesktopControls.js';
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
import { computeRouting as routeControllers } from './Routing.js';
import { NetMgr } from './net/NetMgr.js';
import { buildIceServers } from './net/NetProtocol.js';
import { GhostCartMgr } from './GhostCartMgr.js';
import { makeHoldKey, parseHolds } from './net/HoldState.js';
import { loadCollection, parseCollection } from './Collection.js';
import { resolve as resolveRom, pickLibraryDirectory, fileSystemAccessSupported } from './RomResolver.js';
import { parseRoom, defaultRoom, roomCollectionRefs } from './RoomLoader.js';
import { buildRoom, buildProp, buildPortal, applyPosterTexture } from './RoomBuilder.js';
import { RoomEditor } from './RoomEditor.js';
import { cycleSurface, cycleTimeOfDay, cyclePosterTexture, cycleShelfCollection } from './EnvEditor.js';
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

// --- M0 shared-room presence (opt-in via ?session=<room>) ----------------
// Avatars + (later) voice for everyone in the same named room. Wired here at
// module scope — BEFORE buildCartridgeWorld()'s buildMemoryCards await (which
// stalls headless) — so presence works regardless of that path. Single-player
// (no ?session) constructs nothing: no socket, no avatars. See src/net/.
let net = null;
const sessionRoom = urlParams.get('session');
if (sessionRoom) {
  const palette = ['#88aaff', '#ff8866', '#66dd99', '#ffd166', '#cc88ff', '#66ccee'];
  const nick = urlParams.get('nick') || `Player-${Math.random().toString(36).slice(2, 6)}`;
  const color = urlParams.get('color') || palette[Math.floor(Math.random() * palette.length)];
  // M0 hardening: optional TURN relay for peers behind symmetric NAT (STUN
  // alone fails there). Supplied via ?turn=turn:host:3478&turnUser=…&turnCred=…
  // (or omit for the STUN-only default). Shared by the voice + video meshes.
  const turn = urlParams.get('turn');
  const iceServers = turn
    ? buildIceServers({ turn, turnUsername: urlParams.get('turnUser'), turnCredential: urlParams.get('turnCred') })
    : undefined;
  net = new NetMgr({
    scene,
    room: sessionRoom,
    serverUrl: urlParams.get('server') || undefined, // default: wss://<host>/ws/
    nick,
    color,
    iceServers,
    // M0.5 room-object sync: reflect a remote peer's shared state into our scene.
    onObjectState: (key, value) => { if (key === 'tv') applyRemoteTv(value); },
    // M1.1 host-authoritative input: a remote player's RetroPad button reached
    // us. We inject it into our core ONLY when we're the host (the tv-state
    // owner running the authoritative game); otherwise it isn't ours to apply.
    onGameInput: (ev) => { if (net?.isHost()) gameInput?.setRemoteButton(ev); },
    // M1.2 host video stream: the host captures THIS canvas; a non-host paints
    // the received frames onto its TV (onHostVideo) and reverts to its own
    // local canvas when the stream ends (onHostVideoEnded). While watching the
    // host's frames we PAUSE our own core (M1.2 follow-up) — it isn't authoritative
    // and we aren't showing it, so emulating it just burns Quest CPU/battery.
    // The stream ending (host left, or we became the host) resumes it so our TV
    // shows our local core again.
    videoCanvas: emuCanvas,
    onHostVideo: (videoEl) => { scene.setScreenVideo(videoEl); client.pause(); },
    onHostVideoEnded: () => { scene.setScreenSource(emuCanvas); client.resume(); },
  });
  net.connect();
  scene.addTickCallback((dt) => net.tick(dt));
  window.__net = net.debugApi();

  // Voice button: first click grabs the mic + joins the WebRTC mesh; later
  // clicks toggle mute. getUserMedia needs this user gesture. Shown only in a
  // session; in VR a menu item would mirror it (deferred).
  const voiceBtn = document.getElementById('voice-btn');
  if (voiceBtn) {
    voiceBtn.hidden = false;
    voiceBtn.addEventListener('click', async () => {
      if (!net.voice.enabled) {
        voiceBtn.disabled = true;
        const ok = await net.enableVoice();
        voiceBtn.disabled = false;
        voiceBtn.textContent = ok ? '🎤 Mute' : '🎤 (no mic)';
        if (!ok) voiceBtn.title = 'Microphone unavailable or denied';
      } else {
        const muted = net.voice.toggleMute();
        voiceBtn.textContent = muted ? '🔇 Unmute' : '🎤 Mute';
      }
    });
  }
}

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
  // The policy lives in [[src/Routing.js]] (pure, unit-tested); here we just
  // bind it to live grab + cable state.
  return routeControllers({
    controllers: scene.controllers,
    heldObject: (ctrl) => grabMgr.heldObject(ctrl),
    isControllerFree: (ctrl) => grabMgr.isControllerFree(ctrl),
    playerOf: (cableId) => cable.playerOf(cableId),
  });
}
let debugHud = null;
let editor = null;       // Phase E.1 in-VR room editor (set in buildCartridgeWorld)
let currentRoom = null;  // the parsed room descriptor we serialize back on export
let roomPosters = [];    // Phase E.2: { prop, object } for each poster, for live env edits
let currentCollections = null; // Phase E.3: { byKey, list } — needed to build a new shelf in-VR
let activePortals = [];  // Phase E.3: live portal records the proximity tick navigates (mutable)
// Switch editor mode (off/move/change/add). The menu builder replaces this with
// a version that also toggles the per-mode sub-panels; until then it just sets
// the editor mode. addProp/ensureEditMode call it so adding a prop enters Add.
let applyMode = (m) => editor?.setMode(m);

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
    // Three edit modes: in 'change' mode a grip selects a prop instead of moving
    // it; the menu then cycles the selected prop's options.
    getMode: () => editor?.getMode() || 'off',
    onSelectProp: (obj) => editor?.select(obj),
    // Held-object sync (M0): announce/clear which cartridge we're holding so
    // peers can show it as a ghost in our avatar's hand. No-op outside a session.
    onCartridgeGrabbed: (cart, hand) => {
      const id = net?.presence?.selfId;
      if (net && id) net.setObjectState(makeHoldKey(cart.userData.file), { holder: id, hand });
    },
    onCartridgeReleased: (cart) => {
      if (net) net.setObjectState(makeHoldKey(cart.userData.file), null);
    },
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
    shelf:    () => addProp('shelf'),
    console:  () => addProp('console'),
    gamepad:  () => addProp('gamepad'),
    poster:   () => addProp('poster'),
    bookcase: () => addProp('bookcase'),
    cupboard: () => addProp('cupboard'),
    table:    () => addProp('table'),
    portal:   () => addPortal(),
  };
  // Drive the three edit modes headlessly (the menu is raycast-only). __change
  // cycles the currently-selected prop's options (poster art / shelf collection).
  window.__mode = (m) => editor.setMode(m);
  window.__change = () => cycleSelected();

  // Held-object sync (M0): show a ghost cartridge in a remote peer's hand (and
  // hide our copy) for each cart they're holding. Reconciles each frame from the
  // shared STATE channel. Only in a session; exposed early for headless smokes.
  if (net) {
    const getCartByObjId = (objId) => cartridges.find((c) => c.userData.file === objId) || null;
    const ghostMgr = new GhostCartMgr({ avatars: net.avatars, getCartByObjId });
    scene.addTickCallback(() => {
      const presentIds = new Set(net.presence.peers().map((p) => p.id));
      ghostMgr.sync(parseHolds(net.objects.entries(), { selfId: net.presence.selfId, presentIds }));
    });
    window.__ghost = {
      count: () => ghostMgr.ghostCount,
      hidden: () => ghostMgr.hiddenCount,
      has: (file) => ghostMgr.hasGhost(file),
    };
  }

  // Flat-screen controls: mouse-look + WASD + click-to-interact, so the in-VR
  // features are usable on a desktop. Inert while presenting (XR controllers win).
  // Built here (before the buildMemoryCards await) so `window.__desktop` is
  // exposed even when that await stalls headless, like the hooks above. It only
  // needs the scene/camera/rig/controller; GrabMgr (already built) auto-wired the
  // synthetic controller's squeeze events.
  const desktop = new DesktopControls({
    renderer: scene.renderer,
    camera: scene.camera,
    playerRig: scene.playerRig,
    controller: scene.desktopController,
    domElement: scene.renderer.domElement,
    scene,
  });
  window.__desktop = desktop.debugApi();

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
    // M1.1 networked client: forward each logical RetroPad transition to the
    // host (no-op when we ARE the host or no game is loaded — see
    // NetMgr.forwardGameInput → NetProtocol.hostInputTarget). We still dispatch
    // locally too, so this peer keeps seeing its own game until host video
    // streaming (M1.2) lands. Inert in single-player (net === null).
    onLogicalInput: (ev) => net?.forwardGameInput(ev),
  });

  scene.addTickCallback((dt) => desktop.tick(dt));
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
// Furniture (bookcase/cupboard/table) has a floor-contact origin, so it spawns
// at y=0 (standing on the floor); shelves/console/poster keep their old heights.
const SPAWN_Y = { shelf: 1.25, console: 0.74, gamepad: 0.78, poster: 1.5, portal: 0,
                  bookcase: 0, cupboard: 0, table: 0 };

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

// Force edit mode on (so the freshly added prop is immediately grabbable). A
// freshly added prop is grab-to-place, so enter Add mode (and sync the menu's
// sub-panels via applyMode) unless we're already in some edit mode.
function ensureEditMode() {
  if (!editor || editor.isEditMode()) return;
  applyMode('add');
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

// --- Change mode: cycle a selected prop's options -------------------------

// Drop the `builtin:` prefix for terse status lines.
const short = (v) => String(v || '').replace(/^builtin:/, '');

// Ordered list of collection keys a shelf can cycle through. The room's declared
// refs (top-level `collections` + any shelf's `collection`) — these are exactly
// the strings currentCollections.byKey was keyed with, so each resolves to a
// loaded collection, and they match a shelf's `collection` field format (url or
// id). A room that lists only one collection naturally can't cycle.
function collectionKeys() {
  return roomCollectionRefs(currentRoom);
}

// Rebuild a shelf in place after its `collection` changed: build the new shelf
// FIRST (buildProp returns null + adds nothing for an empty collection, so we
// can abort cleanly), then swap out the old object from scene + grab set +
// editor, register the replacement, and re-select it. Returns true on success.
function rebuildShelf(rec) {
  const { prop, object } = rec;
  const r = buildProp(prop, { scene, collections: currentCollections });
  if (!r) return false; // empty collection — nothing built, old shelf untouched

  scene.removeObject(object);
  for (const child of object.children) {
    if (child.userData?.kind === 'cartridge') grabMgr.removeGrabbable(child);
  }
  grabMgr.removeGrabbable(object);
  editor.removePlaced(object);

  editor.registerPlaced(prop, r.object);
  r.cartridges.forEach((c) => grabMgr.addGrabbable(c));
  editor.select(r.object); // re-highlight the rebuilt shelf
  return true;
}

// Advance every poster in the room to its next art (the global "All Posters"
// Change-mode action; distinct from cycling one selected poster).
function cycleAllPosters() {
  if (!roomPosters.length) { setStatus('no posters in this room'); return; }
  let last;
  for (const { prop, object } of roomPosters) {
    last = cyclePosterTexture(prop);
    applyPosterTexture(object.material, prop.texture);
  }
  setStatus(`All posters: ${short(last)}`);
}

// Advance the selected prop's primary property: poster→art, shelf→collection
// (with a live rebuild). Furniture/console have nothing to cycle. Surfaced as a
// "Cycle Selected" menu button and the headless window.__change hook.
function cycleSelected() {
  const rec = editor?.selectedProp();
  if (!rec) { setStatus('Change: grip a prop to select it first'); return; }
  const { prop, object } = rec;
  if (prop.type === 'poster') {
    const v = cyclePosterTexture(prop);
    applyPosterTexture(object.material, prop.texture);
    setStatus(`Poster art: ${short(v)}`);
  } else if (prop.type === 'shelf') {
    const keys = collectionKeys();
    if (keys.length < 2) { setStatus('only one collection loaded'); return; }
    const prev = prop.collection;
    const v = cycleShelfCollection(prop, keys);
    if (!rebuildShelf(rec)) { prop.collection = prev; setStatus(`"${v}" has no games`); return; }
    setStatus(`Shelf collection: ${v}`);
  } else {
    setStatus(`nothing to change for ${prop.type}`);
  }
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

  // Main panel: always-available utilities + a Play/Move/Change/Add mode
  // selector. The three per-mode action panels (built below) appear one at a
  // time, driven by the selector.
  const menu = createMenuPanel({
    title: 'Menu',
    items: [
      { label: 'Show Controls', onActivate: () => {} },
      { label: 'Show Debug',    onActivate: () => {} },
      { label: 'Reset Game',    onActivate: () => client.reset() },
      { label: 'Export Room',   onActivate: () => editor?.export() },
      { label: 'Snap: Off',     onActivate: () => {} },
      { label: '► Play',        onActivate: () => {} },  // mode selector
      { label: 'Move',          onActivate: () => {} },
      { label: 'Change',        onActivate: () => {} },
      { label: 'Add',           onActivate: () => {} },
      // M0 hardening: in-VR voice toggle (the 🎤 header button is desktop-only).
      // Appended LAST and only in a networked session, so it never shifts the
      // positional button indices the mode selector below relies on.
      ...(net ? [{ label: 'Voice: Off', onActivate: () => {} }] : []),
    ],
  });
  scene.addObject(menu);
  const [controlsBtn, debugBtn, , , snapBtn, playBtn, moveBtn, changeBtn, addBtn] = menu.userData.buttons;
  const vrVoiceBtn = net ? menu.userData.buttons[9] : null;

  // Build a per-mode action sub-panel (hidden until its mode is active). All its
  // buttons are registered with menuMgr up front; MenuMgr's effVisible check
  // keeps a hidden panel's buttons un-clickable, so no add/remove churn.
  const sub = (title, items) => {
    const p = createMenuPanel({ title, items, position: new THREE.Vector3(-2.99, 1.5, -1.05) });
    p.visible = false;
    scene.addObject(p);
    p.userData.buttons.forEach((b) => menuMgr.addItem(b.mesh, b.onActivate));
    return p;
  };

  const movePanel = sub('Move', [
    { label: 'Grip a prop to move', onActivate: () => setStatus('Move: grip a prop and drag it') },
  ]);

  // Change mode: global look (wallpaper/floor/lighting/all posters) plus
  // per-prop edits on the grip-selected prop (poster art / shelf collection).
  const changePanel = sub('Change', [
    { label: 'Wallpaper',      onActivate: () => { const v = cycleSurface(currentRoom, 'wallpaper'); scene.applyEnvironment(currentRoom.environment); setStatus(`Wallpaper: ${short(v)}`); } },
    { label: 'Floor',          onActivate: () => { const v = cycleSurface(currentRoom, 'floor'); scene.applyEnvironment(currentRoom.environment); setStatus(`Floor: ${short(v)}`); } },
    { label: 'Lighting',       onActivate: () => { const v = cycleTimeOfDay(currentRoom); scene.applyEnvironment(currentRoom.environment); setStatus(`Lighting: ${v}`); } },
    { label: 'All Posters',    onActivate: () => cycleAllPosters() },
    { label: 'Cycle Selected', onActivate: () => cycleSelected() },
    { label: 'Selected: none', onActivate: () => {} },  // status line, updated on select
  ]);
  const selectedLabelBtn = changePanel.userData.buttons[5];
  editor.onSelect((rec) => selectedLabelBtn.setLabel(rec ? `Sel: ${rec.prop.id}` : 'Selected: none'));

  // Add mode: a furniture/prop catalogue. Each spawns in front of the player,
  // becomes editable-grabbable, and rides out through Export Room.
  const addPanel = sub('Add', [
    { label: 'Add Shelf',    onActivate: () => addProp('shelf') },
    { label: 'Add Bookcase', onActivate: () => addProp('bookcase') },
    { label: 'Add Cupboard', onActivate: () => addProp('cupboard') },
    { label: 'Add Table',    onActivate: () => addProp('table') },
    { label: 'Add Console',  onActivate: () => addProp('console') },
    { label: 'Add Poster',   onActivate: () => addProp('poster') },
    { label: 'Add Portal',   onActivate: () => addPortal() },
  ]);

  // Mode selector: set editor mode, show the matching sub-panel, mark the
  // active button with a ► . Replaces the module-level applyMode stub so
  // addProp/ensureEditMode/window.__mode all keep the panels in sync.
  const modeBtns = [
    { btn: playBtn,   mode: 'off',    label: 'Play' },
    { btn: moveBtn,   mode: 'move',   label: 'Move' },
    { btn: changeBtn, mode: 'change', label: 'Change' },
    { btn: addBtn,    mode: 'add',    label: 'Add' },
  ];
  applyMode = (m) => {
    const mode = editor.setMode(m); // normalizes unknown → 'off'
    movePanel.visible = mode === 'move';
    changePanel.visible = mode === 'change';
    addPanel.visible = mode === 'add';
    for (const { btn, mode: bm, label } of modeBtns) btn.setLabel((bm === mode ? '► ' : '') + label);
  };
  for (const { btn, mode } of modeBtns) btn.onActivate = () => applyMode(mode);

  // Utilities.
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
  snapBtn.onActivate = () => {
    const on = editor?.setSnap(!editor?.snapEnabled());
    snapBtn.setLabel(on ? 'Snap: On' : 'Snap: Off');
  };

  // In-VR voice: first select grabs the mic + joins the WebRTC mesh (the
  // controller select is the user gesture getUserMedia needs); later selects
  // toggle mute. Mirrors the desktop 🎤 button via the same NetMgr path. Only
  // present in a session. (Whether the Quest browser grants the mic mid-XR is
  // the open item for the real-headset smoke test.)
  if (vrVoiceBtn) {
    vrVoiceBtn.onActivate = async () => {
      if (!net.voice.enabled) {
        const ok = await net.enableVoice();
        vrVoiceBtn.setLabel(ok ? 'Voice: On' : 'Voice: (no mic)');
      } else {
        const muted = net.voice.toggleMute();
        vrVoiceBtn.setLabel(muted ? 'Voice: Muted' : 'Voice: On');
      }
    };
  }

  for (const b of menu.userData.buttons) menuMgr.addItem(b.mesh, b.onActivate);

  scene.addTickCallback(() => menuMgr.tick());
  window.__menu = menuMgr;
  // Debug hooks: drive the Change-mode env edits headlessly (menu is raycast-only).
  window.__env = {
    wallpaper: changePanel.userData.buttons[0].onActivate,
    floor:     changePanel.userData.buttons[1].onActivate,
    lighting:  changePanel.userData.buttons[2].onActivate,
    posters:   changePanel.userData.buttons[3].onActivate,
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

// `echo` controls whether a successful load re-announces the TV state to the
// room (M0.5). Local inserts echo (true, default); a load that is itself
// *reflecting* a remote peer's state passes echo:false so it never bounces the
// value back — otherwise a slow async load can re-broadcast a now-stale game on
// top of a newer overwrite.
function handleCartridgeInserted(meta, { echo = true } = {}) {
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
  loadCartridge(meta, { echo });
}

async function loadCartridge(meta, { echo = true } = {}) {
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
    // M0.5: tell the shared room which game is now on the TV. Suppressed when
    // this load is reflecting a remote peer's state (echo:false) so it can't
    // bounce a stale value back over a newer overwrite.
    if (echo) {
      // Booting a game ourselves makes us the host (tv-state owner). If we were
      // previously watching another host (core paused, M1.2 follow-up), make sure
      // our own core is running before we broadcast it.
      client.resume();
      net?.setObjectState('tv', { file: meta.file, core: meta.core, system: meta.system, title: meta.title });
      // M1.2: booting the game makes us the host (tv-state owner) — start
      // streaming our canvas to the room so non-hosts see it on their TV.
      net?.startVideoBroadcast();
    }
  } catch (e) {
    setStatus(`error: ${e.message || e}`);
  }
}
window.__loadCartridge = loadCartridge; // debug hook: boot a game via RomResolver

// M0.5: a remote peer loaded a game — reflect it onto our TV. A peer with
// nothing running (or running the same core) boots it seamlessly; we deliberately
// do NOT yank a player who's mid-game on a *different* core into a page reload —
// we just surface it. Late joiners (nothing running) always converge via the
// server's state snapshot. Loop-safe: the reflected load runs with echo:false so
// it never re-announces the value back to the room.
function applyRemoteTv(value) {
  if (!value || !value.file || !value.core || !CORES[value.core]) return;
  if (currentMeta && currentMeta.file === value.file && currentCore === value.core) return;
  if (currentCore && currentCore !== value.core) {
    setStatus(`${value.title || 'A game'} is playing in this room — insert it to join (different system)`);
    return;
  }
  handleCartridgeInserted({ file: value.file, core: value.core, system: value.system, title: value.title }, { echo: false });
  const cart = cartridges.find((c) => c.userData.file === value.file);
  if (cart && grabMgr) grabMgr.setInsertedCart(cart);
}

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
