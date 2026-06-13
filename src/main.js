// Remote logger: imported first so it can capture startup errors before any
// other module runs. It chains onto console.* and window error events — the
// rest of the app is unaware of it.  Remote shipping is opt-in: it activates
// only when ?log=<url> is in the URL, or when the page is served from the
// production host (dionysus.dk). Console-only mode is the default elsewhere.
import { logger } from './Logger.js';
logger.init();

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
import { createNowPlayingPanel } from './NowPlayingPanel.js';
import { createControlsPanel } from './ControlsPanel.js';
import { createMenuPanel } from './MenuPanel.js';
import { MenuMgr } from './MenuMgr.js';
import { CORES, coreForFile, systemForFile, portsForSystem, MAX_PORTS } from './systems.js';
import { Patchbay } from './Patchbay.js';
import { computeRouting as routeControllers } from './Routing.js';
import { NetMgr } from './net/NetMgr.js';
import { buildIceServers } from './net/NetProtocol.js';
import { sanitiseRoom, randomRoomSuffix } from './net/SessionUtils.js';
import { GhostCartMgr } from './GhostCartMgr.js';
import { makeHoldKey, parseHolds } from './net/HoldState.js';
import { loadCollection, parseCollection } from './Collection.js';
import { resolve as resolveRom, pickLibraryDirectory, fileSystemAccessSupported } from './RomResolver.js';
import {
  pickImagesDirectory, hasImagesDirectory, listImages, entryObjectUrl,
  fileSystemAccessSupported as imgFolderSupported,
} from './ImageLibrary.js';
import { parseRoom, defaultRoom, roomCollectionRefs } from './RoomLoader.js';
import {
  saveLastRoom, loadLastRoom, clearLastRoom,
  stashRoomBridge, consumeRoomBridge, looksLikeRoom,
} from './RoomPersistence.js';
import { buildRoom, buildProp, buildPortal, applyPosterTexture, FIT_MODES, DEFAULT_FIT_MODE, lockBookcaseHomes } from './RoomBuilder.js';
import { createShelf, addCartridgeToShelf } from './Shelf.js';
import { createCartridge } from './Cartridge.js';
import { RoomEditor } from './RoomEditor.js';
import { cycleSurface, cycleTimeOfDay, cyclePosterTexture, cycleShelfCollection, cycleFitMode, stepScale } from './EnvEditor.js';
import {
  createProp, createPortal,
  addProp as appendProp, addPortal as appendPortal,
} from './PropCreator.js';
import {
  clampToRoom, snapToSurface, SURFACE_KIND,
} from './Placement.js';
import { C64Keyboard } from './C64Keyboard.js';

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

// --- M0 shared-room presence (opt-in via ?session=<room> or the in-app MP widget) --
//
// Avatars + voice + TV-sync for everyone in the same named room. Single-player
// (no session) constructs nothing: no socket, no avatars. See src/net/.
//
// The module-level tick callback always runs (added once below); it no-ops
// when `net` is null so the solo experience is completely unchanged.
let net = null;

// TURN/ICE config is fixed from URL params at startup (same as before). We
// don't expose a UI for it because it's an infrastructure detail; operators
// who need TURN pass it in the URL.
const _turn = urlParams.get('turn');
const _iceServers = _turn
  ? buildIceServers({ turn: _turn, turnUsername: urlParams.get('turnUser'), turnCredential: urlParams.get('turnCred') })
  : undefined;
const _serverUrl = urlParams.get('server') || undefined; // default: wss://<host>/ws/

// Random nick suffix and colour palette (used when none provided).
const _palette = ['#88aaff', '#ff8866', '#66dd99', '#ffd166', '#cc88ff', '#66ccee'];
const _defaultNick = `Player-${randomRoomSuffix()}`;
const _defaultColor = _palette[Math.floor(Math.random() * _palette.length)];

/**
 * Build and connect a new NetMgr for (room, nick, color). Tears down any
 * existing session first. Returns the new NetMgr (already connected).
 * All THREE/voice/video callbacks close over the module-level `net` variable
 * (indirectly via the arrow functions below), so they always refer to the
 * current instance after reassignment.
 */
function connectToRoom(room, nick, color) {
  // Tear down any existing session cleanly.
  if (net) {
    net.disconnect();
    net = null;
    window.__net = null;
  }

  const newNet = new NetMgr({
    scene,
    room,
    serverUrl: _serverUrl,
    nick,
    color,
    iceServers: _iceServers,
    // M0.5 room-object sync: reflect a remote peer's shared state into our scene.
    onObjectState: (key, value) => { if (key === 'tv') applyRemoteTv(value); },
    // M1.1 host-authoritative input: inject remote buttons only when we are host.
    onGameInput: (ev) => { if (net?.isHost()) gameInput?.setRemoteButton(ev); },
    // M1.2 host video: paint the host's frames on the TV; pause our core while
    // watching (it isn't authoritative). Resume + revert when the stream ends.
    videoCanvas: emuCanvas,
    onHostVideo: (videoEl) => { scene.setScreenVideo(videoEl); client.pause(); },
    onHostVideoEnded: () => { scene.setScreenSource(emuCanvas); client.resume(); },
  });
  net = newNet;
  net.connect();
  window.__net = net.debugApi();

  // Tag logger entries with this session for the /logs viewer.
  logger._sessionId = room;
  logger._nick = nick;

  return net;
}

/** Disconnect from the current room and reset all networked state. */
function disconnectFromRoom() {
  if (!net) return;
  // If we were watching a host video, revert the TV to our own canvas and
  // resume the local core (same as onHostVideoEnded but triggered by leave).
  scene.setScreenSource?.(emuCanvas);
  client.resume?.();
  net.disconnect();
  net = null;
  window.__net = null;
  logger._sessionId = null;
  logger._nick = null;
}

// Register the single persistent tick callback. Guards on `net` being non-null
// so there is zero cost when the user is in solo mode.
scene.addTickCallback((dt) => net?.tick(dt));

// --- Wire the in-app multiplayer header widget ----------------------------
//
// The widget provides Join / Leave and a running status line ("Room: X — N players").
// It is an alternative to passing ?session= in the URL; the URL param still works
// and auto-joins on page load exactly as before.

const mpWidget    = document.getElementById('mp-widget');
const mpRoomInput = document.getElementById('mp-room-input');
const mpNickInput = document.getElementById('mp-nick-input');
const mpColorInput = document.getElementById('mp-color-input');
const mpJoinBtn   = document.getElementById('mp-join-btn');
const mpLeaveBtn  = document.getElementById('mp-leave-btn');
const mpStatusEl  = document.getElementById('mp-status');

/** Update the header widget to reflect the current connection state. */
function updateMpWidget() {
  const connected = !!net && net._connected;
  // Class on the widget drives CSS visibility of join fields / leave button.
  mpWidget.classList.toggle('mp-connected', connected);
  mpWidget.classList.toggle('mp-disconnected', !connected);

  if (connected) {
    const peers = net.presence.peers();
    const n = peers.length; // other peers (self excluded)
    const total = n + 1;    // including self
    const names = peers.map((p) => p.nick).slice(0, 3).join(', ');
    const more = n > 3 ? ` +${n - 3}` : '';
    mpStatusEl.textContent = `${net.room} — ${total} player${total === 1 ? '' : 's'}${names ? ` (${names}${more})` : ''}`;
    mpStatusEl.className = 'online';
    mpStatusEl.title = `Connected to room "${net.room}"`;
  } else {
    mpStatusEl.textContent = 'Offline';
    mpStatusEl.className = 'offline';
    mpStatusEl.title = '';
  }
}

// Join button: sanitise, connect, then update the widget.
if (mpJoinBtn) {
  mpJoinBtn.addEventListener('click', () => {
    const rawRoom = mpRoomInput?.value?.trim() || '';
    const room = sanitiseRoom(rawRoom) || `room-${randomRoomSuffix()}`;
    const nick = mpNickInput?.value?.trim() || _defaultNick;
    const color = mpColorInput?.value || _defaultColor;
    connectToRoom(room, nick, color);
    // Show the voice button now that we're in a session.
    const voiceBtn = document.getElementById('voice-btn');
    if (voiceBtn) voiceBtn.hidden = false;
    _ensureMpTick();
    updateMpWidget();
    // Sync the in-VR menu button label if the menu has already been built.
    if (typeof _syncVrMpLabel === 'function') _syncVrMpLabel();
  });
}

// Leave button: disconnect and reset.
if (mpLeaveBtn) {
  mpLeaveBtn.addEventListener('click', () => {
    disconnectFromRoom();
    const voiceBtn = document.getElementById('voice-btn');
    if (voiceBtn) { voiceBtn.hidden = true; voiceBtn.textContent = '🎤 Voice'; }
    updateMpWidget();
    if (typeof _syncVrMpLabel === 'function') _syncVrMpLabel();
  });
}

// Stub — overwritten by buildMenuAndControlsPanel() once the VR menu exists.
let _syncVrMpLabel = null;
// Guard: register the updateMpWidget tick callback at most once.
let _mpTickRegistered = false;
function _ensureMpTick() {
  if (_mpTickRegistered) return;
  _mpTickRegistered = true;
  scene.addTickCallback(updateMpWidget);
}

// --- Auto-join from ?session= URL param (backwards-compatible) -------------
{
  const sessionRoom = urlParams.get('session');
  if (sessionRoom) {
    const nick = urlParams.get('nick') || _defaultNick;
    const color = urlParams.get('color') || _defaultColor;
    connectToRoom(sessionRoom, nick, color);

    // Pre-fill the widget inputs with the current session so the user can see
    // what room they're in and adjust nick/color before a manual rejoin.
    if (mpRoomInput)  mpRoomInput.value  = sessionRoom;
    if (mpNickInput)  mpNickInput.value  = nick;
    if (mpColorInput) mpColorInput.value = color;

    // Voice button (the join flow will also show it, but show it eagerly here
    // for the URL-param path so existing behaviour is unchanged). Mark as wired
    // so the join-flow block below doesn't add a second listener.
    const voiceBtn = document.getElementById('voice-btn');
    if (voiceBtn) {
      voiceBtn.hidden = false;
      voiceBtn.dataset.wired = '1';
      voiceBtn.addEventListener('click', async () => {
        if (!net?.voice) return;
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
    // Start updating the roster display. Even if the socket isn't open yet,
    // updateMpWidget will show "connecting" state; connected → peer count.
    _ensureMpTick();
    updateMpWidget();
  }
}

// Wire the voice button for the join-flow path too (re-wiring is safe because
// we add a new listener each join, but the user gesture guard in the callback
// means only one click ever enables the mic — duplicates are benign).
if (mpJoinBtn) {
  const voiceBtn = document.getElementById('voice-btn');
  if (voiceBtn && !voiceBtn.dataset.wired) {
    voiceBtn.dataset.wired = '1';
    voiceBtn.addEventListener('click', async () => {
      if (!net?.voice) return;
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
// C64/VIC-20 virtual keyboard — created in buildCartridgeWorld, shown/hidden
// when a Commodore game boots or via the "Keyboard" menu/header toggle.
let c64kbd = null;
// True when the keyboard is in "manual override" mode (user toggled it).
// Cleared on the next game boot so auto-show/hide resumes from there.
let _kbdManualOverride = false;
let cartridges = [];
let shelves = [];    // live shelf objects — used by addLocalRomToShelf()
let consoleObj = null;
let gamepadObj = null;
// Local-multiplayer patch graph: which gamepad is plugged into which console
// port → which player it drives ([[src/Patchbay.js]]). Each gamepad object gets
// a stable userData.cableId; the default one auto-plugs into port 0 (player 1).
// Today the rack has one console (CONSOLE_ID, N=1); Patchbay is keyed per
// console so the multi-console rack drops in without changing this wiring. The
// console is registered at full MAX_PORTS width — the per-game enabled-port
// count is applied as a clamp at seat time, never by pruning seated gamepads.
const CONSOLE_ID = 'console0';
const cable = new Patchbay();
cable.addConsole(CONSOLE_ID, { ports: MAX_PORTS });
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
    playerOf: (cableId) => cable.playerOf(cableId)?.player ?? 1,
  });
}
let debugHud = null;
let nowPlayingPanel = null; // world-space "Now Playing + Input" panel near the TV
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
//
// Goal A: a cross-core ROM swap reloads the page; just before the reload we
// bridge the live room into sessionStorage (stashRoomBridge). Here we consume
// that one-shot stash so the room survives the core-swap reload.
//
// Goal B: if the user previously exported/saved a room it sits in localStorage.
// We load it here in lieu of defaultRoom() so the app always boots into the
// last-known room.  Two escape hatches bypass this:
//   • ?room=default  — ignores both the bridge and localStorage, boots defaultRoom()
//     (useful when a corrupt/unwanted save would otherwise brick the app).
//   • ?room=<URL>    — explicit URL still wins (same as before).
async function resolveWorld() {
  const dropped = readDroppedWorld();
  if (dropped) return dropped;

  const roomUrl = urlParams.get('room');

  // Explicit ?room=default → ignore all saves; boot the hard-coded layout.
  if (roomUrl === 'default') {
    clearLastRoom();
    const collectionUrl = urlParams.get('collection') || 'roms/manifest.json';
    return { room: defaultRoom(collectionUrl), inline: [] };
  }

  // Explicit ?room=<URL> → fetch that room (unchanged original behaviour).
  if (roomUrl) {
    const obj = await fetchJson(roomUrl);
    return { room: parseRoom(obj || {}, { sourceLabel: roomUrl }), inline: [] };
  }

  // Goal A: cross-core reload bridge (sessionStorage, one-shot).
  const bridgeObj = consumeRoomBridge();
  if (bridgeObj && looksLikeRoom(bridgeObj)) {
    console.log('[main] restoring room from cross-core bridge');
    return { room: parseRoom(bridgeObj, { sourceLabel: 'bridge' }), inline: [] };
  }

  // Goal B: auto-load last saved room from localStorage.
  const savedObj = loadLastRoom();
  if (savedObj && looksLikeRoom(savedObj)) {
    console.log('[main] restoring room from localStorage (last saved)');
    return { room: parseRoom(savedObj, { sourceLabel: 'lastRoom' }), inline: [] };
  }

  // Default: the built-in two-shelf layout (original behaviour).
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
  shelves = built.shelves;          // track for addLocalRomToShelf()
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
  cable.plugController(gamepadObj.userData.cableId, CONSOLE_ID, 0);
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

  // "Now Playing + Input" panel: fixed world-space, sits just below the TV
  // bezel so it's visible both in VR and on the flat desktop screen.
  // TV is at (0, 1.5, -3.6); the panel hangs 0.86 m below that (below the
  // TV cabinet bottom edge at ~1.5 - 0.825 = 0.675, so y ≈ 0.58 is clear of
  // the stand which occupies y=0..0.7 at z=-3.6).
  nowPlayingPanel = createNowPlayingPanel();
  nowPlayingPanel.position.set(0, 0.58, -3.6);
  scene.addObject(nowPlayingPanel);

  // C64/VIC-20 virtual keyboard panel.
  // Positioned ~1 m in front of the user, angled up slightly for comfort.
  // Hidden by default; shown automatically when a Commodore game boots, or
  // manually via the "Keyboard" toggle in the menu / header button.
  c64kbd = new C64Keyboard({
    sendInput: (type, code, key, keyCode, location) =>
      client.sendInput(type, code, key, keyCode, location),
    position: new THREE.Vector3(0, 1.0, -1.8),
    rotationX: -Math.PI / 8,  // tilt toward user for comfortable reach
  });
  c64kbd.object3d.visible = false;
  scene.addObject(c64kbd.object3d);
  window.__c64kbd = c64kbd; // debug hook

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
    // Placement preview: supply live room bounds so the ghost can compute the
    // snapped drop location each frame. isPreviewEnabled() reads the editor's
    // surfaceSnap flag — the ghost is only shown when surface-snap is ON.
    getRoomBounds: () => scene.getRoomBounds(),
    isPreviewEnabled: () => !!(editor?.surfaceSnapEnabled() && editor?.isEditMode()),
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
  // Headless hook: exercise addLocalRomToShelf() with a synthetic meta entry.
  // Usage: await window.__addLocalRom({ file:'test.sfc', system:'snes', core:'snes9x', title:'Test' })
  window.__addLocalRom = (meta) => addLocalRomToShelf(meta);
  window.__add = {
    // Basic spawners (used by headless probes + the in-VR Add-mode buttons).
    shelf:    (col) => addProp('shelf',    col ? { collection: col } : {}),
    console:  ()    => addProp('console'),
    gamepad:  ()    => addProp('gamepad'),
    poster:   ()    => addProp('poster'),
    bookcase: (col) => addProp('bookcase', col ? { collection: col } : {}),
    cupboard: ()    => addProp('cupboard'),
    table:    ()    => addProp('table'),
    portal:   ()    => addPortal(),
    // Desktop/headless poster-image affordance. src = URL or data URL.
    // Usage: window.__add.setPosterImage('https://…') after selecting a poster.
    setPosterImage: (src) => {
      const rec = editor?.selectedProp?.();
      if (!rec) return 'no prop selected';
      if (rec.prop.type !== 'poster') return `selected is ${rec.prop.type}, not poster`;
      rec.prop.texture = src;
      reapplyPosterProp(rec);
      return src;
    },
    // Headless: cycle fit mode for selected poster. Returns new mode string.
    cycleFit: () => {
      const rec = editor?.selectedProp?.();
      if (!rec || rec.prop.type !== 'poster') return 'no poster selected';
      const v = cycleFitMode(rec.prop);
      reapplyPosterProp(rec);
      return v;
    },
    // Headless: step scale up/down for selected poster. Returns new scale.
    scaleUp:   () => { const rec = editor?.selectedProp?.(); if (!rec || rec.prop.type !== 'poster') return 'no poster selected'; const v = stepScale(rec.prop, 'up'); reapplyPosterProp(rec); return v; },
    scaleDown: () => { const rec = editor?.selectedProp?.(); if (!rec || rec.prop.type !== 'poster') return 'no poster selected'; const v = stepScale(rec.prop, 'down'); reapplyPosterProp(rec); return v; },
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
    // gamepad input is reaching the core. Also forward to the Now Playing
    // panel so the user can see the specific key code IN the headset.
    onKeyDown: (code) => {
      consoleObj.userData.pulse?.(0xffffff, 90);
      nowPlayingPanel?.userData.notifyInput(code);
      logger.event('input', { code });
    },
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
  // Diagnostic: while a game is loaded, log the input pipeline state whenever it
  // changes (gamepad held? how many controllers routed to a player? does any XR
  // controller expose a live gamepad? which system map?). Paired with the
  // per-key 'input' events above, this lets a "can't control the console"
  // report be diagnosed entirely from the remote logs (dionysus.dk/logs):
  //   held:false route:0          → the virtual gamepad isn't grabbed
  //   held:true  route:1 xr:0     → grabbed, but no live XR gamepad to read
  //   held:true  route:1 xr:2 + no 'input' events → reading but not dispatching
  let _lastInputSig = '';
  scene.addTickCallback(() => {
    if (!currentMeta) return;
    let xr = 0;
    for (const ctrl of scene.controllers) {
      if (ctrl.userData.inputSource?.gamepad?.buttons?.length) xr++;
    }
    const sig = `held:${grabMgr.isGamepadHeld()} route:${computeRouting().length} xr:${xr} sys:${gameInput.currentSystem()}`;
    if (sig !== _lastInputSig) {
      _lastInputSig = sig;
      logger.event('input-state', { sig });
    }
  });
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

// Example rooms a new portal can target (URL today; a local-id registry is a
// deferred item). addPortal aims at one that isn't the current room so
// walk-through navigation is verifiable out of the box.
const KNOWN_ROOMS = ['roms/bedroom.room.json', 'roms/arcade.room.json'];

// A spot ~1.4 m in front of the player on the floor plane, with a yaw that faces
// the new prop back toward them. Reads the camera's last-rendered world pose
// (controller events fire outside the XR rAF, so the pose is a frame stale —
// fine for an initial placement the user adjusts by grabbing).
//
// Surface-snap is applied here so NEWLY SPAWNED props always land on the
// correct surface inside the room (no floating, no clipping through walls):
//   • Floor props  → Y is set to RESTING_Y[type]; XZ clamped inside walls.
//   • Wall props   → snapped to the nearest wall plane; yaw faces into room.
// The returned `rot[1]` is the player-facing yaw for floor props (so the user
// can see the front face immediately), or the room-facing yaw for wall props.
function spawnTransform(type) {
  const camPos = new THREE.Vector3();
  const dir = new THREE.Vector3();
  scene.camera.getWorldPosition(camPos);
  scene.camera.getWorldDirection(dir); // points where the player looks (into the room)
  dir.y = 0;
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
  dir.normalize();
  const p = camPos.clone().addScaledVector(dir, 1.4);

  // Clamp the XZ to inside the room before surface-snap (keeps posters off the
  // wall corner seams and floor props away from the wall base).
  const bounds = scene.getRoomBounds();
  const raw = { x: p.x, y: p.y, z: p.z };
  const clamped = clampToRoom(raw, bounds, 0.25);

  // Surface-snap: floor props get correct Y; wall props snap to nearest wall.
  const { pos: snapped, yaw: wallYaw } = snapToSurface(clamped, bounds, type || 'shelf');

  // For floor props: face the prop's +Z back toward the player so the front
  // face is visible on spawn.  For wall props: use the snap-computed yaw so
  // the poster faces into the room.
  const isWall = SURFACE_KIND[type] === 'wall';
  const yawRad = isWall ? wallYaw : Math.atan2(-dir.x, -dir.z);
  const yawDeg = (yawRad * 180) / Math.PI;

  return { pos: [snapped.x, snapped.y, snapped.z], rot: [0, yawDeg, 0] };
}

// Force edit mode on (so the freshly added prop is immediately grabbable). A
// freshly added prop is grab-to-place, so enter Add mode (and sync the menu's
// sub-panels via applyMode) unless we're already in some edit mode.
function ensureEditMode() {
  if (!editor || editor.isEditMode()) return;
  applyMode('add');
}

// Add a new prop of `type` in front of the player. `opts.collection` pre-
// assigns a collection key to a shelf/bookcase prop so it holds the right
// ROMs immediately on spawn. Returns the descriptor (or null on failure).
function addProp(type, opts = {}) {
  if (!editor || !currentRoom) return null;
  const t = spawnTransform(type);
  const prop = createProp(currentRoom, type, t);
  if (!prop) { setStatus(`can't add ${type}`); return null; }

  // Pre-assign collection for shelf/bookcase if the caller requests a specific
  // one (e.g. from the per-collection "Add Shelf" buttons in the Add panel).
  if (opts.collection && (prop.type === 'shelf' || prop.type === 'bookcase')) {
    prop.collection = opts.collection;
  }

  const r = buildProp(prop, { scene, collections: currentCollections });
  if (!r) { setStatus(`add ${type} failed (nothing to build)`); return null; }

  appendProp(currentRoom, prop);
  editor.registerPlaced(prop, r.object);
  // Shelf + bookcase carts are play-mode grabbables (NOT editable props).
  if (r.kind === 'shelf') {
    shelves.push(r.object); // keep shelves[] in sync for addLocalRomToShelf()
    r.cartridges.forEach((c) => grabMgr.addGrabbable(c));
  }
  if (r.kind === 'bookcase' && r.cartridges?.length) {
    // Bookcase carts registered with grabMgr — each has a home already locked
    // by lockBookcaseHomes (called inside buildProp → bookcase case).
    r.cartridges.forEach((c) => grabMgr.addGrabbable(c));
  }

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
  const port = cable.firstFreePort(CONSOLE_ID, cu.activePorts);
  if (port == null) return null;
  const anchor = cu.portAnchors[port];
  const p = new THREE.Vector3(), q = new THREE.Quaternion();
  anchor.getWorldPosition(p);
  anchor.getWorldQuaternion(q);
  obj.position.copy(p);
  obj.quaternion.copy(q);
  cable.plugController(obj.userData.cableId, CONSOLE_ID, port);
  return port;
}

// Add a new portal aimed at an example room (one that isn't the current room),
// register it for proximity navigation, and make it editable-grabbable.
function addPortal() {
  if (!editor || !currentRoom) return null;
  const here = urlParams.get('room');
  const target = KNOWN_ROOMS.find((u) => u !== here) || KNOWN_ROOMS[0];
  const t = spawnTransform('portal');
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

// Rebuild a bookcase in place after its `collection` changed. Mirrors
// rebuildShelf but for bookcases: removes old carts, builds new carts, and
// re-locks homes. Returns true on success, false if the new collection is empty.
function rebuildBookcase(rec) {
  const { prop, object: bookcaseGroup } = rec;
  // Remove old cartridges from grabMgr and the group.
  for (const child of [...bookcaseGroup.children]) {
    if (child.userData?.kind === 'cartridge') {
      grabMgr.removeGrabbable(child);
      bookcaseGroup.remove(child);
    }
  }
  // Build new carts from the updated collection on the EXISTING bookcase object.
  // We don't replace the group (unlike rebuildShelf) since the bookcase geometry
  // doesn't change — only the carts on the shelves change.
  const { buildBookcaseCarts: buildCarts } = { buildBookcaseCarts: null }; // avoid circular ref
  // Call the helper through RoomBuilder via buildProp to get a temp new object,
  // then steal its cart children. Actually, we import lockBookcaseHomes above;
  // replicate the logic here directly (same as buildBookcaseCarts but inline):
  const games = (() => {
    const col = (prop.collection && currentCollections.byKey.get(prop.collection)) || currentCollections.list[0];
    return col ? col.games.slice() : [];
  })();
  if (!games.length) return false;

  // Reuse the exported function from RoomBuilder — but it's not exported as a
  // standalone. Rebuild via a throw-away buildProp call: build a temp descriptor
  // → steal carts → position them into the real bookcaseGroup.
  // Simpler: rebuild directly using the same geometry constants.
  const CART_W = 0.12, CART_H = 0.13;
  const BOOKCASE_W_CONST = 0.9, BOOKCASE_T_CONST = 0.03;
  const innerW = BOOKCASE_W_CONST - 2 * BOOKCASE_T_CONST;
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
      const cart = createCartridge(games[gameIdx++]);
      cart.position.set(startX + i * SLOT, shelfY + CART_H / 2, 0);
      cart.quaternion.identity();
      cart.rotation.x = BACK_LEAN;
      bookcaseGroup.add(cart);
      newCarts.push(cart);
    }
  }
  lockBookcaseHomes(bookcaseGroup);
  newCarts.forEach((c) => grabMgr.addGrabbable(c));
  return true;
}

// Advance the selected prop's primary property: poster→art, shelf/bookcase→
// collection (with a live rebuild). Furniture/console have nothing to cycle.
// Surfaced as a "Cycle Selected" menu button and the headless window.__change.
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
  } else if (prop.type === 'bookcase') {
    const keys = collectionKeys();
    if (keys.length < 2) { setStatus('only one collection loaded'); return; }
    const prev = prop.collection;
    const v = cycleShelfCollection(prop, keys);
    if (!rebuildBookcase(rec)) { prop.collection = prev; setStatus(`"${v}" has no games`); return; }
    setStatus(`Bookcase collection: ${v}`);
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
      { label: 'Keyboard: Off', onActivate: () => {} },  // C64/VIC-20 keyboard toggle (index 5)
      { label: '► Play',        onActivate: () => {} },  // mode selector
      { label: 'Move',          onActivate: () => {} },
      { label: 'Change',        onActivate: () => {} },
      { label: 'Add',           onActivate: () => {} },
      // M0 hardening: in-VR voice toggle (the 🎤 header button is desktop-only).
      // Appended LAST and only in a networked session, so it never shifts the
      // positional button indices the mode selector below relies on.
      ...(net ? [{ label: 'Voice: Off', onActivate: () => {} }] : []),
      // Multiplayer status + quick-join: always present so Quest users can join
      // a room without removing the headset to type in the URL bar. Index is
      // 10 (no session) or 11 (with session, after the Voice button). We read
      // it by .at(-1) so the index shift is invisible to the mode-selector code.
      { label: 'Multiplayer', onActivate: () => {} },
    ],
  });
  scene.addObject(menu);
  const [controlsBtn, debugBtn, , , snapBtn, kbdBtn, playBtn, moveBtn, changeBtn, addBtn] = menu.userData.buttons;
  const vrVoiceBtn = net ? menu.userData.buttons[10] : null;
  // Always the last button regardless of whether Voice is present.
  const vrMpBtn = menu.userData.buttons.at(-1);

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

  // Move panel: instructions + two snap toggles.
  // "Surface Snap" snaps floor props to the floor and wall props to the nearest
  // wall on release; it also shows the placement ghost while dragging.
  // "Grid Snap" is the existing 0.1 m / 15° quantiser — reachable here too for
  // convenience without going back to the main panel.
  const movePanel = sub('Move', [
    { label: 'Grip a prop to move', onActivate: () => setStatus('Move: grip a prop and drag it') },
    { label: 'Surface Snap: On',    onActivate: () => {} },  // wired below
    { label: 'Grid Snap: Off',      onActivate: () => {} },  // mirrors main snapBtn
  ]);
  const [, surfaceSnapBtn, gridSnapInMoveBtn] = movePanel.userData.buttons;
  // Surface snap is on by default (matches editor._surfaceSnap initial value).
  surfaceSnapBtn.onActivate = () => {
    const on = editor?.setSurfaceSnap(!editor?.surfaceSnapEnabled());
    surfaceSnapBtn.setLabel(on ? 'Surface Snap: On' : 'Surface Snap: Off');
  };
  // Grid snap mirror: keep this label in sync with the main snapBtn.
  gridSnapInMoveBtn.onActivate = () => {
    const on = editor?.setSnap(!editor?.snapEnabled());
    snapBtn.setLabel(on ? 'Snap: On' : 'Snap: Off');
    gridSnapInMoveBtn.setLabel(on ? 'Grid Snap: On' : 'Grid Snap: Off');
  };

  // Change mode: global look (wallpaper/floor/lighting/all posters) plus
  // per-prop edits on the grip-selected prop (poster art / shelf collection /
  // poster image (gallery) / fit mode / scale).
  const changePanel = sub('Change', [
    { label: 'Wallpaper',       onActivate: () => { const v = cycleSurface(currentRoom, 'wallpaper'); scene.applyEnvironment(currentRoom.environment); setStatus(`Wallpaper: ${short(v)}`); } },
    { label: 'Floor',           onActivate: () => { const v = cycleSurface(currentRoom, 'floor'); scene.applyEnvironment(currentRoom.environment); setStatus(`Floor: ${short(v)}`); } },
    { label: 'Lighting',        onActivate: () => { const v = cycleTimeOfDay(currentRoom); scene.applyEnvironment(currentRoom.environment); setStatus(`Lighting: ${v}`); } },
    { label: 'All Posters',     onActivate: () => cycleAllPosters() },
    { label: 'Cycle Selected',  onActivate: () => cycleSelected() },
    { label: 'Poster Images…',  onActivate: () => {} },  // wired below (open gallery)
    { label: 'Fit: contain',    onActivate: () => {} },  // wired below
    { label: 'Scale+',          onActivate: () => {} },  // wired below
    { label: 'Scale-',          onActivate: () => {} },  // wired below
    { label: 'Selected: none',  onActivate: () => {} },  // status line, updated on select
  ]);
  const [,,,,,posterGalleryBtn, fitModeBtn, scalePlusBtn, scaleMinusBtn, selectedLabelBtn] = changePanel.userData.buttons;
  editor.onSelect((rec) => {
    selectedLabelBtn.setLabel(rec ? `Sel: ${rec.prop.id}` : 'Selected: none');
    // Update fit/scale button labels to reflect the selected poster's current state.
    if (rec && rec.prop.type === 'poster') {
      fitModeBtn.setLabel(`Fit: ${rec.prop.fit || DEFAULT_FIT_MODE}`);
      scalePlusBtn.setLabel(`Scale+: ${(rec.prop.scale ?? 1).toFixed(2)}`);
      scaleMinusBtn.setLabel(`Scale-: ${(rec.prop.scale ?? 1).toFixed(2)}`);
    } else {
      fitModeBtn.setLabel('Fit: (no poster)');
      scalePlusBtn.setLabel('Scale+');
      scaleMinusBtn.setLabel('Scale-');
    }
  });

  // Fit mode button: cycle contain → cover → stretch for the selected poster.
  fitModeBtn.onActivate = () => {
    const rec = editor?.selectedProp?.();
    if (!rec || rec.prop.type !== 'poster') { setStatus('Select a poster in Change mode first'); return; }
    const v = cycleFitMode(rec.prop);
    reapplyPosterProp(rec);
    fitModeBtn.setLabel(`Fit: ${v}`);
    setStatus(`Poster fit: ${v}`);
  };

  // Scale+: zoom in (increase scale step).
  scalePlusBtn.onActivate = () => {
    const rec = editor?.selectedProp?.();
    if (!rec || rec.prop.type !== 'poster') { setStatus('Select a poster in Change mode first'); return; }
    const v = stepScale(rec.prop, 'up');
    reapplyPosterProp(rec);
    scalePlusBtn.setLabel(`Scale+: ${v.toFixed(2)}`);
    scaleMinusBtn.setLabel(`Scale-: ${v.toFixed(2)}`);
    setStatus(`Poster scale: ${v.toFixed(2)}`);
  };

  // Scale-: zoom out (decrease scale step).
  scaleMinusBtn.onActivate = () => {
    const rec = editor?.selectedProp?.();
    if (!rec || rec.prop.type !== 'poster') { setStatus('Select a poster in Change mode first'); return; }
    const v = stepScale(rec.prop, 'down');
    reapplyPosterProp(rec);
    scalePlusBtn.setLabel(`Scale+: ${v.toFixed(2)}`);
    scaleMinusBtn.setLabel(`Scale-: ${v.toFixed(2)}`);
    setStatus(`Poster scale: ${v.toFixed(2)}`);
  };

  // ─── In-VR Image Gallery ────────────────────────────────────────────────────
  // A world-space panel that lists images from the granted folder as a grid of
  // thumbnail buttons. Point a controller at a thumbnail and pull the trigger
  // to assign it to the currently-selected poster. Only visible when explicitly
  // opened via the "Poster Images…" Change-panel button; hidden when the
  // Change panel hides or the user taps anywhere outside it.
  //
  // The gallery reuses the MenuMgr raycast path so it integrates cleanly with
  // the existing controller interaction model. Thumbnail planes carry the same
  // `kind: 'menu-button'` userData shape as MenuPanel buttons, so MenuMgr's
  // hover/click logic works without modification.
  const IMAGE_COLS = 3;    // thumbnails per row
  const THUMB_W   = 0.18;  // metres
  const THUMB_H   = 0.14;  // metres
  const THUMB_GAP = 0.015;
  const GALLERY_ROWS = 3;  // rows of thumbnails (max 9 images shown at once)

  const galleryGroup = new THREE.Group();
  galleryGroup.name = 'image-gallery';
  // Position: same side as the change panel but slightly further forward + wider.
  galleryGroup.position.set(-2.99, 1.5, -0.25);
  galleryGroup.rotation.y = Math.PI / 2;
  galleryGroup.visible = false;
  scene.addObject(galleryGroup);

  // Background plate for the gallery.
  const galleryTotalW = IMAGE_COLS * THUMB_W + (IMAGE_COLS - 1) * THUMB_GAP + 0.05;
  const galleryTitleH = 0.055;
  const galleryTotalH = GALLERY_ROWS * THUMB_H + (GALLERY_ROWS - 1) * THUMB_GAP + galleryTitleH + 0.06;
  const galleryBack = new THREE.Mesh(
    new THREE.PlaneGeometry(galleryTotalW + 0.01, galleryTotalH + 0.01),
    new THREE.MeshBasicMaterial({ color: 0x000000 }),
  );
  galleryBack.position.z = -0.003;
  galleryGroup.add(galleryBack);
  const galleryBody = new THREE.Mesh(
    new THREE.PlaneGeometry(galleryTotalW, galleryTotalH),
    new THREE.MeshBasicMaterial({ color: 0x111120 }),
  );
  galleryBody.position.z = -0.001;
  galleryGroup.add(galleryBody);

  // Title bar for the gallery.
  const galTitleCanvas = document.createElement('canvas');
  galTitleCanvas.width = 512; galTitleCanvas.height = 80;
  const galTCtx = galTitleCanvas.getContext('2d');
  galTCtx.fillStyle = '#0a0a18'; galTCtx.fillRect(0, 0, 512, 80);
  galTCtx.fillStyle = '#ffcc66'; galTCtx.font = 'bold 36px monospace';
  galTCtx.textAlign = 'center'; galTCtx.textBaseline = 'middle';
  galTCtx.fillText('Images', 256, 40);
  const galTitleTex = new THREE.CanvasTexture(galTitleCanvas);
  const galTitleMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(galleryTotalW - 0.02, galleryTitleH),
    new THREE.MeshBasicMaterial({ map: galTitleTex }),
  );
  galTitleMesh.position.y = galleryTotalH / 2 - 0.03 - galleryTitleH / 2;
  galleryGroup.add(galTitleMesh);

  // Pool of thumbnail planes (created once, populated per folder load).
  // We keep a fixed-size pool matching IMAGE_COLS × GALLERY_ROWS so we never
  // create/destroy THREE objects per load (only textures swap).
  const MAX_THUMBS = IMAGE_COLS * GALLERY_ROWS;
  const _galleryThumbMeshes = []; // { mesh, tex, objUrl, setHover, setLabel }
  const _galleryObjectUrls = [];  // object URLs to revoke on reload

  function _makeGalleryThumb(col, row) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 192;
    const ctx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;

    let hovered = false;
    let label = '';

    const redraw = (img) => {
      ctx.clearRect(0, 0, 256, 192);
      ctx.fillStyle = hovered ? '#2a4a7a' : '#1a1a2c';
      ctx.fillRect(0, 0, 256, 192);
      if (img) {
        // Draw image centred/contained inside the canvas.
        const ar = img.width / img.height;
        let dw = 256, dh = 192;
        if (ar > 256 / 192) { dh = Math.round(256 / ar); }
        else { dw = Math.round(192 * ar); }
        ctx.drawImage(img, (256 - dw) / 2, (192 - dh) / 2, dw, dh);
      }
      ctx.strokeStyle = hovered ? '#ffcc66' : '#333';
      ctx.lineWidth = hovered ? 5 : 3;
      ctx.strokeRect(2, 2, 252, 188);
      if (label) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(0, 155, 256, 37);
        ctx.fillStyle = '#fff';
        ctx.font = '14px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const short = label.length > 20 ? label.slice(0, 19) + '…' : label;
        ctx.fillText(short, 128, 173);
      }
      tex.needsUpdate = true;
    };
    redraw(null);

    const startX = -(IMAGE_COLS - 1) * (THUMB_W + THUMB_GAP) / 2;
    const startY = galleryTotalH / 2 - 0.03 - galleryTitleH - THUMB_H / 2 - 0.01;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(THUMB_W, THUMB_H),
      new THREE.MeshBasicMaterial({ map: tex }),
    );
    mesh.position.set(
      startX + col * (THUMB_W + THUMB_GAP),
      startY - row * (THUMB_H + THUMB_GAP),
      0,
    );
    mesh.userData.kind = 'menu-button';
    mesh.userData.setHover = (h) => { if (h !== hovered) { hovered = h; redraw(mesh.userData._img || null); } };
    mesh.visible = false;
    galleryGroup.add(mesh);

    return { mesh, tex, redraw, setLabel: (s) => { label = s; redraw(mesh.userData._img || null); } };
  }

  for (let row = 0; row < GALLERY_ROWS; row++) {
    for (let col = 0; col < IMAGE_COLS; col++) {
      _galleryThumbMeshes.push(_makeGalleryThumb(col, row));
    }
  }

  // Register gallery thumb meshes with menuMgr so the raycast picks them up.
  // They are initially invisible so MenuMgr's effVisible check blocks them until
  // the gallery opens.
  for (const { mesh } of _galleryThumbMeshes) {
    menuMgr.addItem(mesh, () => _galleryThumbActivated(mesh));
  }

  let _galleryEntries = []; // current listing from listImages()
  let _galleryLoading = false;

  // Assign the chosen image to the currently-selected poster.
  function _galleryThumbActivated(mesh) {
    const idx = _galleryThumbMeshes.findIndex((t) => t.mesh === mesh);
    if (idx < 0 || idx >= _galleryEntries.length) return;
    const entry = _galleryEntries[idx];
    if (!entry._objUrl) return; // not yet loaded
    const rec = editor?.selectedProp?.();
    if (!rec || rec.prop.type !== 'poster') {
      setStatus('Gallery: select a poster in Change mode first');
      return;
    }
    rec.prop.texture = entry._objUrl;
    reapplyPosterProp(rec);
    setStatus(`Poster: ${entry.name}`);
  }

  // (Re-)populate the gallery from the current images folder.
  async function refreshGallery() {
    if (_galleryLoading) return;
    _galleryLoading = true;
    try {
      // Revoke old object URLs to avoid memory leaks.
      for (const url of _galleryObjectUrls) try { URL.revokeObjectURL(url); } catch {}
      _galleryObjectUrls.length = 0;

      // Hide all thumb meshes while loading.
      for (const { mesh } of _galleryThumbMeshes) { mesh.visible = false; mesh.userData._img = null; }

      const entries = await listImages();
      _galleryEntries = entries.slice(0, MAX_THUMBS);

      for (let i = 0; i < _galleryThumbMeshes.length; i++) {
        const thumb = _galleryThumbMeshes[i];
        const entry = _galleryEntries[i];
        if (!entry) { thumb.mesh.visible = false; continue; }

        thumb.mesh.visible = true;
        thumb.setLabel(entry.name);
        // Load image async: create object URL, decode, then redraw the canvas.
        entryObjectUrl(entry).then((url) => {
          entry._objUrl = url;
          _galleryObjectUrls.push(url);
          const img = new window.Image();
          img.onload = () => {
            thumb.mesh.userData._img = img;
            thumb.redraw(img);
          };
          img.src = url;
        }).catch(() => { thumb.setLabel(`${entry.name} (err)`); });
      }
    } catch (e) {
      setStatus(`Gallery load failed: ${e.message || e}`);
    } finally {
      _galleryLoading = false;
    }
  }

  // Toggle the gallery open/closed. Opens → refreshes from the folder.
  function toggleGallery() {
    galleryGroup.visible = !galleryGroup.visible;
    if (galleryGroup.visible) {
      refreshGallery();
      setStatus('Point at a thumbnail + trigger to assign it to the selected poster');
    } else {
      setStatus('Gallery closed');
    }
  }

  // "Poster Images…" Change-panel button wired here (after gallery is built above).
  posterGalleryBtn.onActivate = () => toggleGallery();

  // Also expose headlessly for testing.
  window.__gallery = { toggle: toggleGallery, refresh: refreshGallery, get entries() { return _galleryEntries; } };

  // Add mode: a furniture/prop catalogue. Each spawns in front of the player,
  // becomes editable-grabbable, and rides out through Export Room.
  //
  // Shelf + Bookcase collection selection:
  //   When only one collection is loaded the button just says "Add Shelf" /
  //   "Add Bookcase" and uses it. When multiple collections are loaded the
  //   button label shows the active collection and each press cycles to the
  //   next one, so the user can choose a collection by tapping until they see
  //   the name they want, then hold (long-press is not available in VR canvas
  //   menus — they double-tap). Pragmatic design: the collection shown in the
  //   label is the one that will be used on the NEXT press. After adding, the
  //   label advances so back-to-back taps add shelves from different collections.
  //   (In-VR file picking is unreliable on Quest; custom poster images are
  //    set from the desktop "Set Poster Image…" button in the page header.)
  const _shelfCollIdx = { shelf: 0, bookcase: 0 }; // per-type collection cursor
  const _shelfCollBtns = {};   // { shelf: btn, bookcase: btn } filled below
  const shelfBtnLabel = (kind) => {
    const keys = collectionKeys();
    if (!keys.length) return `Add ${kind[0].toUpperCase() + kind.slice(1)}`;
    const key = keys[_shelfCollIdx[kind] % keys.length];
    // Show a short name: last segment of URL / id, stripped of extension.
    const shortName = (key || '').replace(/.*[/\\]/, '').replace(/\.[^.]+$/, '');
    return keys.length > 1
      ? `Add ${kind[0].toUpperCase() + kind.slice(1)}: ${shortName}`
      : `Add ${kind[0].toUpperCase() + kind.slice(1)}`;
  };
  const addShelfOrBookcase = (kind) => {
    const keys = collectionKeys();
    const col = keys.length ? keys[_shelfCollIdx[kind] % keys.length] : undefined;
    addProp(kind, col ? { collection: col } : {});
    // Advance cursor so next tap uses the next collection.
    if (keys.length > 1) {
      _shelfCollIdx[kind] = (_shelfCollIdx[kind] + 1) % keys.length;
      _shelfCollBtns[kind]?.setLabel(shelfBtnLabel(kind));
    }
  };

  const addPanel = sub('Add', [
    { label: shelfBtnLabel('shelf'),    onActivate: () => addShelfOrBookcase('shelf') },
    { label: shelfBtnLabel('bookcase'), onActivate: () => addShelfOrBookcase('bookcase') },
    { label: 'Add Cupboard', onActivate: () => addProp('cupboard') },
    { label: 'Add Table',    onActivate: () => addProp('table') },
    { label: 'Add Console',  onActivate: () => addProp('console') },
    { label: 'Add Poster',   onActivate: () => addProp('poster') },
    { label: 'Add Portal',   onActivate: () => addPortal() },
  ]);
  // Stash button refs for label updates.
  _shelfCollBtns.shelf    = addPanel.userData.buttons[0];
  _shelfCollBtns.bookcase = addPanel.userData.buttons[1];

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

  // C64 keyboard toggle: manual override. Flips visibility for any system;
  // clears the auto-hide state so the user's choice persists until next boot.
  kbdBtn.onActivate = () => {
    if (!c64kbd) return;
    const nowVisible = !c64kbd.object3d.visible;
    if (!nowVisible) c64kbd.flushReleases(); // release any held keys before hiding
    c64kbd.object3d.visible = nowVisible;
    _kbdManualOverride = true;
    kbdBtn.setLabel(nowVisible ? 'Keyboard: On' : 'Keyboard: Off');
    // Sync the header button label if present.
    const headerKbdBtn = document.getElementById('kbd-toggle-btn');
    if (headerKbdBtn) headerKbdBtn.textContent = nowVisible ? 'Keyboard: On' : 'Keyboard: Off';
  };
  // Wire the header button the same way (visible for desktop users + flat-screen view).
  const headerKbdBtn = document.getElementById('kbd-toggle-btn');
  if (headerKbdBtn) {
    headerKbdBtn.addEventListener('click', () => kbdBtn.onActivate());
  }

  // Expose a label-sync hook on the keyboard's object3d so setKbdVisibility()
  // (called from loadCartridge) can update the menu button without a closure.
  if (c64kbd) {
    c64kbd.object3d.userData.syncLabel = (visible) => {
      kbdBtn.setLabel(visible ? 'Keyboard: On' : 'Keyboard: Off');
    };
  }

  // In-VR voice: first select grabs the mic + joins the WebRTC mesh (the
  // controller select is the user gesture getUserMedia needs); later selects
  // toggle mute. Mirrors the desktop 🎤 button via the same NetMgr path. Only
  // present in a session. (Whether the Quest browser grants the mic mid-XR is
  // the open item for the real-headset smoke test.)
  if (vrVoiceBtn) {
    vrVoiceBtn.onActivate = async () => {
      if (!net?.voice) return;
      if (!net.voice.enabled) {
        const ok = await net.enableVoice();
        vrVoiceBtn.setLabel(ok ? 'Voice: On' : 'Voice: (no mic)');
      } else {
        const muted = net.voice.toggleMute();
        vrVoiceBtn.setLabel(muted ? 'Voice: Muted' : 'Voice: On');
      }
    };
  }

  // In-VR Multiplayer panel: shows current room state + a one-tap quick-join.
  // Full text-entry in VR is impractical with the canvas-based menu; the primary
  // join UI is the header widget (desktop). The in-VR affordance covers the common
  // Quest case: joining a room without removing the headset.
  //
  // We build the panel, wire all callbacks FIRST, then register with menuMgr —
  // so MenuMgr's stored onActivate references are the real implementations, not
  // the placeholder () => {} stubs that sub() would have captured.
  const mpPanel = createMenuPanel({
    title: 'Multiplayer',
    items: [
      { label: 'Offline',        onActivate: () => {} },  // status — relabelled each tick
      { label: 'Join: lobby',    onActivate: () => {} },  // wired below
      { label: 'Leave room',     onActivate: () => {} },  // wired below
      { label: 'Copy room name', onActivate: () => {} },  // wired below
    ],
    position: new THREE.Vector3(-2.99, 1.5, -1.05),
  });
  mpPanel.visible = false;
  scene.addObject(mpPanel);
  const [mpStatusVrBtn, mpJoinLobbyBtn, mpLeaveVrBtn, mpCopyBtn] = mpPanel.userData.buttons;

  // Relabel the status line each tick so it reflects the live roster.
  scene.addTickCallback(() => {
    if (!mpPanel.visible) return;
    if (net && net._connected) {
      const n = net.presence.peers().length + 1;
      mpStatusVrBtn.setLabel(`${net.room} (${n}p)`);
    } else if (net) {
      mpStatusVrBtn.setLabel('Connecting…');
    } else {
      mpStatusVrBtn.setLabel('Offline');
    }
  });

  // Wire callbacks now, BEFORE registering with menuMgr, so the right function
  // is stored in menuMgr.items (not the placeholder () => {}).
  mpJoinLobbyBtn.onActivate = () => {
    const room = sanitiseRoom(mpRoomInput?.value?.trim() || '') || 'lobby';
    const nick = mpNickInput?.value?.trim() || _defaultNick;
    const color = mpColorInput?.value || _defaultColor;
    connectToRoom(room, nick, color);
    _ensureMpTick();
    updateMpWidget();
    mpJoinLobbyBtn.setLabel(`Join: ${room}`);
    const voiceBtn = document.getElementById('voice-btn');
    if (voiceBtn) voiceBtn.hidden = false;
  };
  mpLeaveVrBtn.onActivate = () => {
    disconnectFromRoom();
    const voiceBtn = document.getElementById('voice-btn');
    if (voiceBtn) { voiceBtn.hidden = true; voiceBtn.textContent = '🎤 Voice'; }
    updateMpWidget();
    mpPanel.visible = false;
  };
  mpCopyBtn.onActivate = () => {
    const room = net?.room || '(not connected)';
    setStatus(`Room: ${room}`);
    console.log('[mp] current room:', room);
    if (mpRoomInput && net?.room) mpRoomInput.value = net.room;
  };
  // Register sub-panel buttons with MenuMgr AFTER wiring so the right handlers fire.
  mpPanel.userData.buttons.forEach((b) => menuMgr.addItem(b.mesh, b.onActivate));

  // Main-panel "Multiplayer" button: toggle the sub-panel and preview join target.
  vrMpBtn.onActivate = () => {
    const preview = sanitiseRoom(mpRoomInput?.value?.trim() || '') || 'lobby';
    mpJoinLobbyBtn.setLabel(`Join: ${preview}`);
    mpPanel.visible = !mpPanel.visible;
  };

  // Expose a hook so header Join/Leave buttons keep the VR button label in sync.
  _syncVrMpLabel = () => {
    if (net && net._connected) {
      vrMpBtn.setLabel(`MP: ${net.room}`);
    } else {
      vrMpBtn.setLabel('Multiplayer');
    }
  };

  for (const b of menu.userData.buttons) menuMgr.addItem(b.mesh, b.onActivate);

  scene.addTickCallback(() => menuMgr.tick());

  // C64 keyboard: per-frame tick (ages tap flashes) + controller hover raycast.
  // Only raycasts when the keyboard is visible so there's zero cost during normal
  // gameplay. The raycaster is a separate instance from MenuMgr's — keyboard UVs
  // need uv hit data that MenuMgr's flow doesn't return.
  {
    const _kbdRay = new THREE.Raycaster();
    const _kbdOrigin = new THREE.Vector3();
    const _kbdDir = new THREE.Vector3();
    const _kbdQuat = new THREE.Quaternion();
    scene.addTickCallback(() => {
      if (!c64kbd) return;
      c64kbd.tick();
      if (!c64kbd.object3d.visible) {
        c64kbd.clearHover();
        return;
      }
      // Raycast each controller against the keyboard mesh to set hover state.
      // We check controllers that are NOT holding the gamepad (same policy
      // as MenuMgr), so in-game trigger presses don't accidentally tap keys.
      const gamepadHeld = grabMgr?.isGamepadHeld?.() ?? false;
      if (gamepadHeld) { c64kbd.clearHover(); return; }

      let nearestHit = null;
      let nearestDist = Infinity;
      for (const ctrl of scene.controllers) {
        ctrl.updateMatrixWorld();
        _kbdOrigin.setFromMatrixPosition(ctrl.matrixWorld);
        ctrl.getWorldQuaternion(_kbdQuat);
        _kbdDir.set(0, 0, -1).applyQuaternion(_kbdQuat).normalize();
        _kbdRay.set(_kbdOrigin, _kbdDir);
        _kbdRay.far = 8.0;
        const hits = _kbdRay.intersectObject(c64kbd.mesh, false);
        if (hits.length && hits[0].distance < nearestDist) {
          nearestDist = hits[0].distance;
          nearestHit = hits[0];
        }
      }
      if (nearestHit?.uv) {
        // Three.js UV.y is bottom-up; flip to top-down for keyAt().
        c64kbd.setHover(nearestHit.uv.x, 1 - nearestHit.uv.y);
      } else {
        c64kbd.clearHover();
      }
    });

    // Trigger (selectstart) on any controller: tap the hovered key.
    // Gated by keyboard visibility AND a hovered key so we don't interfere
    // with MenuMgr or GrabMgr when the keyboard is not in use. MenuMgr's own
    // selectstart listener fires independently but will find no keyboard mesh
    // in its items list, so there's no double-handling conflict.
    for (const ctrl of scene.controllers) {
      ctrl.addEventListener('selectstart', () => {
        if (!c64kbd) return;
        if (!c64kbd.object3d.visible) return;
        if (grabMgr?.isGamepadHeld?.()) return;
        if (!c64kbd.hoveredKey) return; // no key under the laser → don't consume
        c64kbd.tapHovered();
      });
    }
  }

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

/**
 * Show or hide the C64 virtual keyboard and keep the menu/header labels in sync.
 * Call after updating c64kbd.object3d.visible directly (toggle) OR to apply the
 * auto-state on game boot. Does NOT flush held keys — callers handle that when
 * hiding intentionally.
 *
 * @param {boolean} visible
 */
function setKbdVisibility(visible) {
  if (!c64kbd) return;
  if (!visible && c64kbd.object3d.visible) {
    // Flush any latched keys before hiding.
    c64kbd.flushReleases();
  }
  c64kbd.object3d.visible = visible;
  // Sync menu button label (the button ref lives inside buildMenuAndControlsPanel
  // scope; we reach it via a userData hook set on the object3d so we don't need
  // a closure capture here).
  c64kbd.object3d.userData.syncLabel?.(visible);
  // Sync header button.
  const headerKbdBtn = document.getElementById('kbd-toggle-btn');
  if (headerKbdBtn) headerKbdBtn.textContent = visible ? 'Keyboard: On' : 'Keyboard: Off';
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
    // Goal A: serialize the live room and bridge it across the reload so any
    // in-VR edits (moved shelves, added props, env changes) are not lost.
    if (editor) {
      try { stashRoomBridge(JSON.stringify(editor.serialize())); }
      catch (e) { console.warn('[main] room bridge stash failed:', e); }
    }
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
    // Auto show/hide the C64 keyboard based on system. Manual override is
    // cleared at every boot so the auto state takes effect again from here.
    _kbdManualOverride = false;
    setKbdVisibility(meta.system === 'c64' || meta.system === 'vic20');
    // Update the in-VR "Now Playing" panel so the user can see what's running.
    nowPlayingPanel?.userData.setNowPlaying({
      system:    meta.system,
      coreLabel: CORES[meta.core]?.label || meta.core,
      title:     meta.title,
    });
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
    const msg = String(e?.message || e);
    setStatus(`error: ${msg}`);
    logger?.event?.('boot-error', { file: meta.file, system: meta.system, core: meta.core, error: msg });
    // Surface the failure ON THE TV instead of silently leaving the idle screen,
    // so a missing/un-downloaded ROM (the resolver throws on a 404) reads as a
    // real error in VR rather than "nothing happened". Default room ships only
    // cartridges that boot, but a user-added collection can still point at a ROM
    // that isn't installed.
    const notInstalled = /404|→\s*\d|not found|could not resolve|no url for rom/i.test(msg);
    placeholder.setMessage(notInstalled
      ? `ROM not installed: ${meta.title || meta.file}`
      : `Couldn't load ${meta.title || meta.file}`);
    placeholder.start();
    scene.setScreenSource(placeholderCanvas);
    nowPlayingPanel?.userData.setNowPlaying?.({});
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

// --- Local ROM file-picker path -------------------------------------------
//
// NOTE: <input type=file> opened from INSIDE a WebXR session is unreliable on
// Quest browsers (the OS file picker may not appear). This path works best from
// the flat header before entering VR. After picking, the ROM boots normally and
// a grabbable cartridge is placed on the nearest shelf (or a new shelf if all
// shelves are full / there are none). The added cart is live-grabbable
// immediately; it is NOT persisted to the room descriptor (no collection ref for
// an ad-hoc local file), so it will not survive Export/auto-load.

// Max carts per shelf before we consider it "full" and create a new one.
// A shelf wider than ~12 carts would clip the walls of the default room.
const MAX_CARTS_PER_SHELF = 12;

/**
 * Mint a cartridge for a locally-picked file and place it on the best
 * available shelf. If every shelf has MAX_CARTS_PER_SHELF or more carts, or
 * there are no shelves yet, a new shelf is spawned in front of the player.
 * The cart is registered with grabMgr immediately and is grab-to-insert ready.
 *
 * PERSISTENCE NOTE: the cart is NOT added to currentRoom's descriptor because
 * local-file carts have no URL/collection reference — they live only in the
 * live scene. Export Room will not include them.
 */
async function addLocalRomToShelf(meta) {
  if (!grabMgr) return null; // world not yet built (shouldn't happen in practice)

  // Pick the shelf with the fewest carts (that still has room).
  const cartCount = (s) => s.children.filter((c) => c.userData?.kind === 'cartridge').length;
  const candidates = shelves.filter((s) => cartCount(s) < MAX_CARTS_PER_SHELF);
  candidates.sort((a, b) => cartCount(a) - cartCount(b));

  let targetShelf = candidates[0] || null;

  // No suitable shelf → create a fresh empty one in front of the player (same
  // as the "Add Shelf" in-VR menu but without requiring an existing collection).
  if (!targetShelf) {
    const t = spawnTransform('shelf');
    const pos = new THREE.Vector3(t.pos[0], t.pos[1], t.pos[2]);
    const rotY = (t.rot[1] * Math.PI) / 180;
    // createShelf([]) builds a bare plank; addCartridgeToShelf widens it as needed.
    targetShelf = createShelf([], { position: pos, rotationY: rotY });
    targetShelf.userData.kind = 'shelf';
    scene.addObject(targetShelf);
    shelves.push(targetShelf);
    // Register with the editor so Move mode can reposition the new shelf.
    if (editor && currentRoom) {
      const syntheticProp = {
        id: `local-shelf-${Date.now()}`,
        type: 'shelf',
        pos: t.pos,
        rot: t.rot,
        collection: null,
      };
      editor.registerPlaced(syntheticProp, targetShelf);
    }
  }

  // Mint the cartridge and append it to the shelf (handles plank resize + homes).
  const cart = createCartridge(meta);
  addCartridgeToShelf(targetShelf, cart);
  cartridges.push(cart);
  grabMgr.addGrabbable(cart);

  setStatus(`"${meta.title}" added to shelf — grab it to play`);
  return cart;
}

romInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  // Reset so the same file can be re-picked.
  romInput.value = '';

  const coreInfo = detectCore(file.name, coreOverride);
  if (!coreInfo) { setStatus(`no core known for "${file.name}" — check the extension`); return; }

  // Derive system and a display title from the filename.
  const system = systemForFile(file.name, coreOverride);
  const title = file.name.replace(/\.[^.]+$/, ''); // strip extension

  // Build a normalised meta object identical in shape to what handleCartridgeInserted expects.
  // rom.source='pick' with the ArrayBuffer already in hand is handled by the
  // inline buffer path below (we bypass RomResolver for the boot step since we
  // already have the bytes — the file object would be gone after the event).
  const meta = {
    file: file.name,
    core: coreInfo.name,
    system: system || 'unknown',
    title,
    rom: { source: 'pick' },
  };

  // If a different core is already loaded we must reload (libretro cores can't
  // unload). Local file bytes are lost on reload, so we can't bridge them —
  // tell the user to reload/refresh the page manually first, then pick again.
  if (currentCore && currentCore !== coreInfo.name) {
    setStatus(`"${title}" needs ${coreInfo.label} but ${CORES[currentCore]?.label || currentCore} is loaded. Reload the page, then pick the ROM again.`);
    return;
  }

  // Boot the ROM directly from the ArrayBuffer (no resolver round-trip needed
  // since we already have the bytes from the file-change event).
  setStatus(`loading "${title}" on ${coreInfo.label}…`);
  try {
    const buffer = await file.arrayBuffer();
    await client.start(emuCanvas, buffer, { coreUrl: coreInfo.url, coreName: coreInfo.name, moduleStyle: coreInfo.style });
    currentCore = coreInfo.name;
    currentMeta = { core: coreInfo.name, file: meta.file, title, system: meta.system };
    gameInput?.setSystem(meta.system);
    consoleObj?.userData.setPorts?.(portsForSystem(meta.system));
    setSystemLabel(coreInfo.name);
    updateControlsPanel();
    // Auto show/hide keyboard on local-file boot (same policy as loadCartridge).
    _kbdManualOverride = false;
    setKbdVisibility(meta.system === 'c64' || meta.system === 'vic20');
    nowPlayingPanel?.userData.setNowPlaying({
      system:    meta.system,
      coreLabel: coreInfo.label,
      title,
    });

    // Goal B: place a grabbable cartridge on a shelf so it exists in the room.
    // Run async; any failure is non-fatal (the game is already booted).
    addLocalRomToShelf(meta).catch((err) => {
      console.warn('[main] addLocalRomToShelf failed:', err);
    });
  } catch (err) {
    setStatus(`error loading "${title}": ${err.message || err}`);
  }
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

// Images folder (poster image source for Quest + desktop):
// Grant a folder once via File System Access API; the directory handle persists
// in IndexedDB across sessions (same pattern as the ROM library folder).
// On Quest: showDirectoryPicker works inside a WebXR session with a user gesture —
// the OS folder browser appears over the VR compositor. This is the only reliable
// in-headset way to grant access to many files without removing the headset.
// On desktop without FSA: the button is hidden; use "Set Poster Image…" instead.
// After granting, the in-VR "Poster Images…" gallery (Change panel) lists the
// folder's images as thumbnail buttons the user can point at + trigger to assign.
const imagesFolderBtn = $('#images-folder-btn');
if (imagesFolderBtn) {
  if (imgFolderSupported()) {
    imagesFolderBtn.hidden = false;
    imagesFolderBtn.addEventListener('click', async () => {
      try {
        await pickImagesDirectory();
        setStatus('Images folder granted — open Change mode → Poster Images… to browse');
        // If the gallery is already open, refresh it immediately.
        if (window.__gallery && typeof window.__gallery.refresh === 'function') {
          window.__gallery.refresh();
        }
      } catch (e) {
        if (e?.name !== 'AbortError') setStatus(`images folder grant failed: ${e.message || e}`);
      }
    });
    // Check whether we already have a persisted handle and label accordingly.
    hasImagesDirectory().then((has) => {
      if (has && imagesFolderBtn) imagesFolderBtn.title += ' (folder already granted)';
    }).catch(() => {});
  } else {
    // FSA unavailable — keep the button hidden (desktop users rely on "Set Poster Image…").
    imagesFolderBtn.hidden = true;
  }
}

// Export the current (possibly edited) room as *.room.json — desktop
// convenience mirroring the in-VR "Export Room" menu item (Phase E.1).
const exportRoomBtn = $('#export-room-btn');
if (exportRoomBtn) {
  exportRoomBtn.addEventListener('click', () => editor?.export());
}

// Goal C — Import Room: a file picker that reuses the exact same drop path
// (stash in sessionStorage + location.reload) so import and drag-drop go
// through a single code path. Supports .room.json and .collection.json.
const importRoomInput = $('#import-room-input');
if (importRoomInput) {
  importRoomInput.addEventListener('change', async () => {
    const file = importRoomInput.files?.[0];
    if (!file) return;
    importRoomInput.value = ''; // reset so the same file can be re-imported
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
      setStatus(`bad import: ${err.message || err}`);
    }
  });
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

// --- Set Poster Image (desktop/header affordance) ----------------------------
//
// Desktop users can set a custom image on the currently-selected poster prop
// via a file picker or a URL prompt. This is a desktop-only flow; in-VR file
// picking is unreliable on Quest — Quest users use Change mode → Cycle Selected
// to cycle through the built-in poster styles.
//
// Usage: enter Change mode (grip a poster prop to select it), then click
// "Set Poster Image…" in the header. A dialog prompts for a local image file
// or a URL. The chosen source is applied immediately via applyPosterTexture and
// written into the poster's `texture` descriptor field so Export Room + the
// auto-load localStorage path persist it across sessions.
//
// NOTE: the object selected in the editor might not be a poster (it could be a
// shelf or console). In that case the button surfaces a clear status message.
const setPosterBtn   = $('#set-poster-btn');
const posterImgInput = $('#poster-img-input');

/**
 * Re-apply a poster prop's current texture + fit + scale to its material.
 * Called after any of those three fields change (image, fit mode, scale step).
 * The plane dimensions come from prop.size (default 0.8×1.1 m).
 */
function reapplyPosterProp(rec) {
  if (!rec || rec.prop.type !== 'poster') return;
  const [planeW, planeH] = Array.isArray(rec.prop.size) ? rec.prop.size : [0.8, 1.1];
  applyPosterTexture(rec.object.material, rec.prop.texture, {
    fit:    rec.prop.fit,
    scale:  rec.prop.scale,
    planeW,
    planeH,
  });
}

function applyCustomPosterSource(src) {
  // Resolve the currently-selected poster prop.
  const rec = editor?.selectedProp?.();
  if (!rec) { setStatus('Set Poster: enter Change mode and select a poster first'); return; }
  if (rec.prop.type !== 'poster') { setStatus(`Set Poster: selected prop is a ${rec.prop.type}, not a poster`); return; }

  // Write the source into the descriptor so it survives Export + auto-load.
  rec.prop.texture = src;
  // Apply immediately to the live mesh material (same path as in-VR cycle),
  // honouring the prop's current fit mode and scale.
  reapplyPosterProp(rec);
  setStatus(`Poster image set: ${src.length > 60 ? src.slice(0, 57) + '…' : src}`);
}

if (setPosterBtn && posterImgInput) {
  setPosterBtn.addEventListener('click', () => {
    // Prefer file picker for local images; fall back to URL prompt if cancelled.
    posterImgInput.click();
    // If the file input fires 'change', applyCustomPosterSource handles it.
    // If the user closes the picker without choosing, offer a URL prompt.
    // We use a one-shot 'cancel' workaround: schedule the URL prompt as a
    // micro-task after the click event cycle; if the file input fires 'change'
    // first, we cancel the URL prompt flag.
    let fileChosen = false;
    const onFile = (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      fileChosen = true;
      posterImgInput.value = ''; // reset
      // Create an object URL so THREE.TextureLoader can load it by URL.
      const objUrl = URL.createObjectURL(file);
      applyCustomPosterSource(objUrl);
    };
    // One-shot listener — remove after use so repeated clicks don't stack.
    posterImgInput.addEventListener('change', onFile, { once: true });
    // After a short delay (enough for the file dialog to have opened and, if
    // the user cancels immediately, closed), offer a URL prompt as an
    // alternative. Only shown if no file was chosen.
    setTimeout(() => {
      if (fileChosen) return;
      const url = window.prompt(
        'Enter a poster image URL (HTTPS or data URL):\n\n' +
        '(Leave blank to cancel. In VR, use Change → Cycle Selected for built-in styles.)',
      );
      if (url && url.trim()) applyCustomPosterSource(url.trim());
    }, 500);
  });
}

installDragAndDrop();
setSystemLabel(null);
buildCartridgeWorld();
