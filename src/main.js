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
import { Bindings } from './Bindings.js';
import { DesktopGamepad } from './DesktopGamepad.js';
import { BindingsUI } from './BindingsUI.js';
import { Placeholder } from './Placeholder.js';
import { SceneMgr } from './SceneMgr.js';
import { createConsole } from './Console.js';
import { createGamepad } from './Gamepad.js';
import { createLightGun } from './LightGun.js';
import { LightGunMgr } from './LightGunMgr.js';
import { createMouse } from './Mouse.js';
import { MouseMgr } from './MouseMgr.js';
import { Cord } from './Cord.js';
import { Plug } from './Plug.js';
import { nearestAnchor } from './Snap.js';
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
import { CORES, coreForFile, systemForFile, portsForSystem, MAX_PORTS, isKeyboardCapable, isLightgunCapable, lightgunForSystem, lightgunLoadConfig, isTwoGunCapable, libretroGunPortFor, twoGunPortsForSystem, isMouseCapable, mouseLoadConfig, isTwoMouseCapable, libretroMousePortFor, twoMousePortsForSystem, fourScoreLoadConfig, extOf } from './systems.js';
import { Patchbay } from './Patchbay.js';
import { RackMgr } from './RackMgr.js';
import { ConsoleRuntime } from './ConsoleRuntime.js';
import { computeRouting as routeControllers } from './Routing.js';
import { NetMgr } from './net/NetMgr.js';
import { buildIceServers } from './net/NetProtocol.js';
import { sanitiseRoom, randomRoomSuffix } from './net/SessionUtils.js';
import { GhostCartMgr } from './GhostCartMgr.js';
import { GhostGamepadMgr, makeGamepadHoldKey, isGamepadHoldKey, cableIdFromHoldKey } from './GhostGamepadMgr.js';
import { makeHoldKey, parseHolds } from './net/HoldState.js';
import {
  makeGamepadStateKey, isGamepadStateKey, cableIdFromStateKey,
  makePeerGamepadId, parseGamepadEntries, diffGamepadSync,
} from './net/GamepadSync.js';
import {
  makeGunStateKey, isGunStateKey, makePeerGunId, parseGunEntries,
} from './net/GunSync.js';
import {
  makeMouseStateKey, isMouseStateKey, makePeerMouseId, parseMouseEntries,
} from './net/MouseSync.js';
import {
  makePropStateKey, isPropStateKey, propIdFromStateKey,
  makePeerPropId, serializePropState, parsePropEntries, diffPropSync,
} from './net/PropSync.js';
import { loadCollection, parseCollection } from './Collection.js';
import { resolve as resolveRom, cacheRom, pickLibraryDirectory, fileSystemAccessSupported, resolutionPlan, opfsSupported, isLocalRomMeta } from './RomResolver.js';
import {
  pickImagesDirectory, hasImagesDirectory, listImages, entryObjectUrl,
  fileSystemAccessSupported as imgFolderSupported,
} from './ImageLibrary.js';
import { parseRoom, defaultRoom, roomCollectionRefs } from './RoomLoader.js';
import { serializeRoom } from './RoomSerializer.js';
import {
  saveLastRoom, loadLastRoom, clearLastRoom,
  stashRoomBridge, consumeRoomBridge, looksLikeRoom,
} from './RoomPersistence.js';
import { saveRack, loadRack, clearRack } from './RackPersistence.js';
import {
  addEntry as lrlAddEntry, removeEntry as lrlRemoveEntry,
  toCartMeta as lrlToCartMeta,
  loadLocalRoms, saveLocalRoms,
} from './LocalRomLibrary.js';
import { buildRoom, buildProp, buildPortal, applyPosterTexture, FIT_MODES, DEFAULT_FIT_MODE, lockBookcaseHomes } from './RoomBuilder.js';
import { createShelf, addCartridgeToShelf } from './Shelf.js';
import { createMedia } from './Media.js';
import { createCoverPlaque } from './CoverPlaque.js';
import { RoomEditor } from './RoomEditor.js';
import { cycleSurface, cycleTimeOfDay, cyclePosterTexture, cycleShelfCollection, cycleFitMode, stepScale } from './EnvEditor.js';
import {
  createProp, createPortal,
  addProp as appendProp, addPortal as appendPortal,
} from './PropCreator.js';
import {
  clampToRoom, snapToSurface, SURFACE_KIND, placeInRoom, fanSlot,
} from './Placement.js';
import { createKeyboardDevice } from './Keyboard.js';

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

// `client` is the PRIMARY console's EmulatorClient. It starts as the singleton
// adopted by primaryRuntime, but a live primary reboot (armLiveReboot — used to
// connect the light-gun device without a page reload) builds a FRESH runtime with
// its OWN client + canvas and retires the old one. So this binding is mutable and
// every consumer that captured it must be re-pointed via rebindPrimaryClient().
// Code that needs the CURRENT primary client/canvas at call-time should prefer
// rackMgr.get(CONSOLE_ID)?.client / primaryCanvas() over capturing these.
let client = new EmulatorClient();
// Desktop controller-binding model ([[src/Bindings.js]]): keyboard + PC-gamepad
// remapping for the emulated RetroPad. Managed for all four couch-co-op players
// so the historical P2-4 keyboard forwarding keeps working (defaults reproduce
// today's behaviour exactly); the bindings UI wires P1 only for now. Shared by
// InputMgr (keyboard), DesktopGamepad (PC pad), and BindingsUI (the panel).
const bindings = new Bindings({ players: [1, 2, 3, 4] });
const input = new InputMgr(client, { bindings });
// Tracks the core + file actually currently loaded (after `ready` fires).
// Used to decide between in-place ROM swap and page-reload-with-state for
// cross-system swaps, and to tag any save-state written from this session.
let currentCore = null;
let currentMeta = null;
// Full meta of the last game booted on the primary console, retained so a
// light-gun arm (grab the gun → connect the gun device, which only attaches at
// boot) can re-resolve and reload the SAME game. Unlike currentMeta this keeps
// the rom-resolution fields (rom.source / sha1). null until a game loads.
let _lastLoadedMeta = null;
let _lightgunArmedConsole = false;  // primary console booted with the gun device
let _mouseArmedConsole = false;     // primary console booted with the mouse device
// Two-gun (co-op) state: the ordered libretro gun PORTs the active two-gun config
// seats its guns on (e.g. SNES Justifier → [1, 2] = first gun on port 1, second on
// port 2). Set at boot when a two-gun game connects its peripheral; empty []
// for single-gun / no-gun boots. The Kth gun in CABLE-port order drives the Kth of
// these (libretroGunPortFor) → LightGunMgr.portForGun, feeding its OWN per-port aim
// slot in the patched multiport core (webgun_set). So which jack a gun's plug sits
// in decides its player. See [[src/systems.js]] lightgunLoadConfig({twoGun}) and
// docs/LIGHTGUN_SUPPORT.md.
let _twoGunPorts = [];
// Two-mouse (split-pointer) state: the ordered libretro mouse PORTs the active
// two-mouse config seats its mice on (Amiga → [0, 1]). Set at boot when a 2-mouse
// game connects its peripheral; [] otherwise. The Kth mouse in cable-port order
// drives the Kth of these (libretroMousePortFor) → MouseMgr.portForMouse. See
// [[src/systems.js]] mouseLoadConfig({twoMouse}). NOTE: two INDEPENDENT pointers
// need a multiport rwebinput patch on puae (the stock core reads both ports from
// mouse_index 0); without it both ports follow the same pointer — see docs/MOUSE_SUPPORT.md.
let _twoMousePorts = [];
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
const audioRouter = installSpatialAudio({ listener: scene.audioListener, defaultSource: scene.tv.group });
// Label the primary console's audio branch so focus-mute can address it; the
// primary core boots later (loadCartridge) and creates the matching context.
// Literal 'console0' (== CONSOLE_ID, declared below) to avoid the TDZ here.
audioRouter.expect('console0', scene.tv.group);
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
// Shared-gamepad ghost renderer (non-null only while in a session).
let ghostGpMgr = null;
// Gamepad existence reconciler: replaced by the real function once
// buildCartridgeWorld runs and the gamepad-building pieces are ready.
// Called whenever a `gamepad:*` STATE key arrives (including late-join snapshot).
let _reconcileGamepadState = () => {};
// Per-peer counter for generating globally-unique gamepad ids.
let _peerGamepadCounter = 0;
// Light-gun port-binding reconciler (gun:<cableId> STATE) — the gun analogue of
// _reconcileGamepadState, but port-only (the gun MESH rides prop:*). Replaced by
// the real function once buildCartridgeWorld wires the gun cable pieces. No-op
// until then. Per-peer counter for globally-unique gun cableIds.
let _reconcileGunState = () => {};
let _peerGunCounter = 0;
// Mouse port-binding reconciler (mouse:<cableId> STATE) — the mouse analogue of
// _reconcileGunState, port-only (the mouse MESH rides prop:*). No-op until
// buildCartridgeWorld wires it. Per-peer counter for globally-unique mouse cableIds.
let _reconcileMouseState = () => {};
let _peerMouseCounter = 0;

// Net-session wiring bridge. ALL multiplayer-sync subsystems (ghosts, gamepad/
// gun/prop reconcilers, the window.__ghost/__props hooks, etc.) are built inside
// buildCartridgeWorld and need the build-local closures (cartridges, editor,
// built.placed, ...). buildCartridgeWorld assigns the real wiring closure to
// _wireNetSession so BOTH entry points can trigger it: the ?session= URL
// auto-join (net exists at build → wired during build) AND the in-app Join
// widget (net created AFTER the world is built → connectToRoom calls this to
// wire post-build). No-op stub until buildCartridgeWorld runs.
// FOLLOW-UP (known limitation, intentionally not fixed here): the wired managers
// capture `net.avatars` etc. at first-wire, so a leave+widget-rejoin within one
// build reads a stale net. The _netSessionWired guard blocks re-wire within a
// build on purpose — first-join (the actual gap) is fixed; rejoin is no worse
// than before this change.
let _wireNetSession = () => {};
let _netSessionWired = false;

// Prop room-layout sync: reconciler installed once buildCartridgeWorld sets up
// the editor and built.placed. No-op stub until then.
// Called whenever a `prop:*` STATE key arrives (including late-join snapshot).
let _reconcilePropState = () => {};
// Live-drag reconciler (M2 transient 'drag' channel): moves our copy of a prop
// to a peer's in-flight transform each frame while they hold it. No-op stub until
// buildCartridgeWorld wires it to the prop registry.
let _applyLiveDrag = () => {};
// Headless test tap: the last few WIRE messages received per channel (gp/drag/
// reset), mirroring NetMgr.recvInputs() for the INPUT channel. Lets the
// smoke harness confirm transient relay actually reaches the other peer (the
// real effects — ghost-pad animation, live drag, console reset — are internal).
// Exposed as window.__wireRx in buildCartridgeWorld. Capped so it can't grow.
const _wireRxLog = { gp: [], drag: [], reset: [] };
function _recordWireRx(ch, data) {
  const buf = _wireRxLog[ch];
  if (!buf) return;
  buf.push(data);
  if (buf.length > 32) buf.shift();
}
// Per-peer counter for generating globally-unique prop ids.
let _peerPropCounter = 0;
// Known synced payloads: propId → last payload applied from the network.
// Used by diffPropSync to detect moves vs first-time-seen.
const _knownPropPayloads = new Map();
// Registry of all synced props (static room props + peer-spawned): propId → { prop, object }.
// Populated in buildCartridgeWorld and updated when local props are added/broadcast.
// Also used by window.__props debug hook.
const _syncedProps = new Map();

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

// Session-rejoin bridge ----------------------------------------------------
// A cross-core ROM swap and the light-gun arm both call location.reload() (the
// libretro core can't hot-unload). A widget-joined session carries no ?session
// in the URL, so without this the reload silently drops the user out of their
// room AND lobby. Just before each reload we stash a one-shot record of the live
// session; the auto-join block consumes it on the next boot so the session — and
// the host role — survives the reload. `wasHost` lets the reloading host re-claim
// authority instead of adopting a peer's (now staler) room snapshot.
const SESSION_REJOIN_KEY = 'libretrowebxr.rejoin';
// Set true at boot when we are resuming a session in which we were the host.
let _resumeAsHost = false;
function stashSessionRejoin() {
  try {
    if (!net) return;
    sessionStorage.setItem(SESSION_REJOIN_KEY, JSON.stringify({
      room: net.room, nick: net.nick, color: net.color, wasHost: !!net.isHost?.(),
    }));
  } catch (e) { console.warn('[main] session rejoin stash failed:', e); }
}
function consumeSessionRejoin() {
  try {
    const raw = sessionStorage.getItem(SESSION_REJOIN_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(SESSION_REJOIN_KEY);
    const obj = JSON.parse(raw);
    return (obj && typeof obj.room === 'string' && obj.room) ? obj : null;
  } catch (_) { return null; }
}

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
    onObjectState: (key, value) => {
      if (key === 'tv') applyRemoteTv(value);
      if (isGamepadStateKey(key)) _reconcileGamepadState();
      if (isGunStateKey(key)) _reconcileGunState();
      if (isMouseStateKey(key)) _reconcileMouseState();
      if (isPropStateKey(key)) _reconcilePropState(key, value);
      if (isPowerStateKey(key)) _applyRemotePower(key, value);
    },
    // M1.1 host-authoritative input: inject remote buttons only when we are host.
    onGameInput: (ev) => { if (net?.isHost()) gameInput?.setRemoteButton(ev); },
    // M2 transient relay: a peer's per-frame ephemera. 'gp' = a held pad's live
    // button state → animate that pad's ghost in the holder's hand. 'drag' = a
    // prop's live transform while held → move our copy in real time.
    onWire: (ch, data) => {
      _recordWireRx(ch, data);
      if (ch === 'gp' && data?.cableId) ghostGpMgr?.applyInput(data.cableId, data);
      else if (ch === 'drag' && data?.id) _applyLiveDrag(data);
      else if (ch === 'reset' && data?.consoleId) resetConsole(data.consoleId);
    },
    // M1.2 host video: paint the host's frames on the TV; pause our core while
    // watching (it isn't authoritative). Resume + revert when the stream ends.
    // primaryCanvas (a getter, resolved per-capture-frame in NetMgr) so the host
    // video stream follows a live primary reboot's NEW canvas, not the original
    // #canvas. client.pause/resume read the live `client` binding (let, rebound on
    // reboot); the revert paints whatever the primary console is now showing.
    videoCanvas: primaryCanvas,
    onHostVideo: (videoEl) => { scene.setScreenVideo(videoEl); client.pause(); },
    onHostVideoEnded: () => { scene.setScreenSource(primaryCanvas()); client.resume(); },
    // FIX 1: clear latched remote keys when a peer disconnects mid-keypress.
    // NOTE (FIX E): clearRemote() clears ALL remote input, not just the leaving
    // peer's buttons. In a 3+ peer session this is a ~1-tick blip for other
    // peers' held buttons: their keyups fire, then their keys re-latch on the
    // very next tick when their setRemoteButton messages resume. Per-peer
    // clearing would require threading `ev.from` (available in NetMgr's
    // _applyGameInput as msg.from) through setRemoteButton and _remoteDesired
    // entries, which is invasive across GameInputMgr, its tests, and the
    // network contract. The conservative all-clear is safe and correct for the
    // common 2-player case; the blip is benign in 3+ sessions.
    onPeerLeave: (_peerId) => { if (net?.isHost()) gameInput?.clearRemote(); },
  });
  net = newNet;
  net.connect();
  window.__net = net.debugApi();

  // Wire all multiplayer-sync subsystems for this session. On the ?session= URL
  // auto-join this runs during module eval while _wireNetSession is still the
  // no-op stub (buildCartridgeWorld wires once, later). On an in-app widget join
  // the world is already built, so _wireNetSession is the real closure → this is
  // what actually wires ghosts + the _reconcile* functions for a widget-joiner.
  _wireNetSession();

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
  scene.setScreenSource?.(primaryCanvas());
  client.resume?.();
  net.disconnect();
  net = null;
  window.__net = null;
  // Back to a findable solo bucket (not null → the shared 'default') so post-leave
  // solo play stays diagnosable. See Logger.soloSession().
  logger._sessionId = logger.soloSession();
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

// The PRIMARY console's CURRENT video canvas. Starts as the adopted #canvas
// (emuCanvas) but a live primary reboot (rebootPrimaryConsole) installs a fresh
// runtime with its own canvas, so anything that must paint the live primary
// picture (the host-video capture + the TV's idle-revert) reads this getter
// rather than the captured emuCanvas const. Falls back to emuCanvas if the
// runtime is missing. Declared HERE (not next to rackMgr/primaryRuntime below)
// because the top-level auto-join block can call connectToRoom() during module
// eval — which captures `primaryCanvas` as its videoCanvas — and a const
// referenced before its declaration is a TDZ ReferenceError. It's a closure over
// rackMgr/CONSOLE_ID/emuCanvas, so those resolve at call time, after full init.
const primaryCanvas = () => rackMgr.get(CONSOLE_ID)?.canvas ?? emuCanvas;

// --- Auto-join from ?session= URL param (backwards-compatible) -------------
{
  let sessionRoom = urlParams.get('session');
  let nick = urlParams.get('nick') || _defaultNick;
  let color = urlParams.get('color') || _defaultColor;

  // No ?session in the URL but a rejoin record from our own cross-core reload?
  // Resume that session so the reload doesn't eject us from the room/lobby. An
  // explicit ?session always wins (the user navigated there deliberately).
  if (!sessionRoom) {
    const rejoin = consumeSessionRejoin();
    if (rejoin) {
      sessionRoom = rejoin.room;
      if (rejoin.nick)  nick  = rejoin.nick;
      if (rejoin.color) color = rejoin.color;
      _resumeAsHost = !!rejoin.wasHost;   // keep the host the host across its own reload
    }
  }

  if (sessionRoom) {
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
// In-world UI raycast manager (trigger / desktop left-click). Promoted to module
// scope (assigned in buildCartridgeWorld) so spawnConsole can register a freshly
// spawned console's power/reset switches with it.
let menuMgr = null;
// Per-console / per-TV power state for the in-world on/off switches. Absent or
// true = on; false = powered off (core paused + its TV blanked to the idle
// screen). routeVideo() is the single place that honours these.
const consolePowered = new Map();  // consoleId -> bool
const tvPowered = new Map();       // tvId -> bool
const isConsoleOn = (id) => consolePowered.get(id) !== false;
const isTvOn = (id) => tvPowered.get(id) !== false;
// Physical keyboard device — created in buildCartridgeWorld, shown/hidden
// when a keyboard-capable game boots or via the "Keyboard" menu/header toggle.
// `c64kbd` kept as the module-level handle so existing per-frame / toggle code
// touches the same variable with minimal churn.
let c64kbd = null;
// True when the keyboard is in "manual override" mode (user toggled it).
// Cleared on the next game boot so auto-show/hide resumes from there.
let _kbdManualOverride = false;
// Cable id used to track this keyboard in Patchbay's keyboard registry.
const KBD_ID = 'kbd-primary';
// Which console the primary keyboard is currently routing input to.
// Initialised to CONSOLE_ID in buildCartridgeWorld once CONSOLE_ID is in scope.
let _kbdTargetConsoleId = null;
let cartridges = [];
let shelves = [];    // live shelf objects — used by addLocalRomToShelf()
let consoleObj = null;
let gamepadObj = null;
let lightGunObj = null;   // grabbable light-gun prop ([[src/LightGun.js]])
let lightGunMgr = null;   // per-frame aim → console lightgun input ([[src/LightGunMgr.js]])
// All light-gun objects (the boot gun + any added via the Add menu). LightGunMgr
// already iterates a list, so two-player co-op just needs more than one gun here.
const _lightGunObjs = new Set();
// cableId -> gun Object3D. A gun is now a first-class cabled peripheral (like a
// gamepad): it has a stable userData.cableId, registers with the Patchbay, and
// gets a grabbable plug + cord that seats into a console port jack. This index
// lets the shared cord helpers (_cabledObjFor) and the gun port-sync find a gun
// by its cableId. The default boot gun is `gun-1` on every peer (deterministic,
// local-only — like the default gamepad gp-1).
const _lightGunObjsById = new Map();
let _gunCableCount = 0;
const DEFAULT_GUN_IDS = new Set(['gun-1']);
// Register a gun object so it aims (LightGunMgr) and is grabbable (GrabMgr arms
// gun-capable games on pickup via onObjectGrabbed's kind==='lightgun' check), and
// joins the cable system. Assigns a stable cableId if the caller didn't (the
// addProp / remote-create paths pre-assign a peer-scoped or prop-derived id so all
// peers agree). The gun's controller PORT now flows from the Patchbay
// (LightGunMgr.portForGun reads cable.portOf), not from registration order.
function _registerLightGun(obj) {
  if (!obj) return;
  if (obj.userData.cableId == null) obj.userData.cableId = `gun-${++_gunCableCount}`;
  _lightGunObjs.add(obj);
  _lightGunObjsById.set(obj.userData.cableId, obj);
  cable.addController(obj.userData.cableId);
  grabMgr?.addGrabbable(obj);
}

// --- In-world mouse: a first-class cabled peripheral (mirrors the light gun) --
let mouseObj = null;       // the default grabbable mouse prop ([[src/Mouse.js]])
let mouseMgr = null;       // per-frame motion → console mouse input ([[src/MouseMgr.js]])
// All mouse props (boot mouse + any added). MouseMgr iterates this; a second one
// gives split-pointer 2-player. cableId index lets the cord helpers + port-sync
// find a mouse by its cableId. The default boot mouse is `mouse-1` on every peer.
const _mouseObjs = new Set();
const _mouseObjsById = new Map();
let _mouseCableCount = 0;
const DEFAULT_MOUSE_IDS = new Set(['mouse-1']);
// Register a mouse object so it drives input (MouseMgr), is grabbable, and joins
// the cable system. Assigns a stable cableId if the caller didn't (addProp /
// remote-create pre-assign a peer-scoped id so all peers agree). Its libretro
// mouse PORT flows from the Patchbay (MouseMgr.portForMouse reads cable.portOf).
function _registerMouse(obj) {
  if (!obj) return;
  if (obj.userData.cableId == null) obj.userData.cableId = `mouse-${++_mouseCableCount}`;
  _mouseObjs.add(obj);
  _mouseObjsById.set(obj.userData.cableId, obj);
  cable.addController(obj.userData.cableId);
  grabMgr?.addGrabbable(obj);
}

// Which mouse-in-jack-order this mouse is among the MICE plugged into a console
// (0,1,…), or -1 if not plugged there. Mirrors _gunSlotIndex.
function _mouseSlotIndex(mouse, consoleId) {
  const myId = mouse?.userData?.cableId;
  if (myId == null || consoleId == null) return -1;
  const mice = cable.controllersOf(consoleId).filter((c) => _mouseObjsById.has(c.controllerId));
  return mice.findIndex((c) => c.controllerId === myId);
}

// The ordered libretro mouse PORTs the two-mouse device on `consoleId` seats its
// mice on (Amiga → [0,1]), or [] when single-mouse / no-mouse. Mirrors
// _twoGunPortsForConsole: PRIMARY returns the live per-boot _twoMousePorts; a
// SECONDARY derives from its console runtime's loaded system.
function _twoMousePortsForConsole(consoleId) {
  if (consoleId == null) return [];
  if (consoleId === CONSOLE_ID) return _twoMousePorts;
  const system = rackMgr.get(consoleId)?.system ?? _consoleSystems.get(consoleId) ?? null;
  return twoMousePortsForSystem(system);
}

// Decide whether a boot should connect the TWO-gun co-op peripheral: the game
// must declare twoGun, the system must actually have a two-gun device, and the
// gun must be enabled (game-flagged or armed this session). When false the boot
// uses the single-gun path (or none), 100% unchanged.
function _twoGunActiveFor(meta) {
  const armed = !!(meta?.lightgun || window.__lightgunArmed);
  return armed && !!meta?.twoGun && isTwoGunCapable(meta?.system);
}

// Emit rich light-gun boot telemetry so a HEADSET session is diagnosable from the
// remote log (dionysus.dk/logs) without seeing the screen. The thin rom-resolved
// booleans (lightgun:true/false) couldn't answer "WHY didn't the gun connect" or
// "on what device/port/options" — this records both the DECISION INPUTS
// (cart-flagged? session-armed? two-gun?) and the RESOLVED wiring (gun core,
// per-port devices, core-option keys, remap file). `where` tags the boot path so
// the load / pick / arm-reboot / resume routes are distinguishable.
function logLightgunBoot(where, meta, gun, extra = {}) {
  logger?.event?.('lightgun-boot', {
    where,
    file: meta?.file ?? null,
    system: meta?.system ?? null,
    cartCore: meta?.core ?? null,
    metaLightgun: !!meta?.lightgun,        // the cart/collection flag
    armed: !!window.__lightgunArmed,       // session-armed (gun was grabbed)
    metaTwoGun: !!meta?.twoGun,
    gunConnected: !!gun,                   // did this boot seat a gun device?
    gunCore: gun?.core ?? null,            // may differ from cartCore (SMS→genesis)
    inputDevices: gun?.inputDevices ?? null, // { player: deviceId }
    guns: gun?.guns ?? null,               // [{ device, port }]
    coreOptions: gun?.coreOptions ? Object.keys(gun.coreOptions) : null,
    remapName: gun?.remapName ?? null,
    ...extra,
  });
}

// The libretro gun PORT each gun drives is now derived live from the cable
// (which jack the gun's plug sits in) → see _gunSlotIndex + LightGunMgr.portForGun.
// `_twoGunPorts` (set per boot) lists the active two-gun device's libretro ports;
// the Kth gun in cable-port order drives the Kth of them (libretroGunPortFor).
// This replaced the old registration-order `_assignGunPorts` stamping so that
// physically swapping two guns' jacks swaps their players.
// Local-multiplayer patch graph: which gamepad is plugged into which console
// port → which player it drives ([[src/Patchbay.js]]). Each gamepad object gets
// a stable userData.cableId; the default one auto-plugs into port 0 (player 1).
// Today the rack has one console (CONSOLE_ID, N=1); Patchbay is keyed per
// console so the multi-console rack drops in without changing this wiring. The
// console is registered at full MAX_PORTS width — the per-game enabled-port
// count is applied as a clamp at seat time, never by pruning seated gamepads.
const CONSOLE_ID = 'console0';
const PRIMARY_TV_ID = 'tv0';
const cable = new Patchbay();
cable.addConsole(CONSOLE_ID, { ports: MAX_PORTS });
// Video side of the patch graph: the primary console feeds the primary TV
// (SceneMgr's _tvs[0], id 'tv0'). routeVideo() below reads these edges and
// points each scene TV at its source console's canvas, so repatching the graph
// (Phase 4 cords) reroutes video with no other change.
cable.addTV(PRIMARY_TV_ID);
cable.connectVideo(CONSOLE_ID, PRIMARY_TV_ID);

// GrabMgr was written against the old single-console CableMgr API (numeric
// portOf, plug(id, port), isPortFree(port), unplug(id)). Patchbay generalizes
// those per console, so we hand GrabMgr a thin adapter bound to CONSOLE_ID
// rather than rewrite GrabMgr now — keeping the single-console assumption
// isolated here until the multi-console rack (Phase 2) makes GrabMgr
// console-aware. Returns a numeric port (or null) exactly like CableMgr did.
const cableAdapter = {
  portOf: (id) => cable.portOf(id)?.port ?? null,
  unplug: (id) => cable.unplugController(id),
  isPortFree: (port) => cable.isPortFree(CONSOLE_ID, port),
  plug: (id, port) => cable.plugController(id, CONSOLE_ID, port),
};

// Multi-core runtime ([[src/RackMgr.js]]): owns each console's ConsoleRuntime
// and enforces the perf budget (RackBudget). The primary console ADOPTS the
// existing client/#canvas so today's single-console path is console0 of the
// rack with no behaviour change and no second WebGL context; spawned consoles
// add more (Phase 3 gives them their own TVs). applyBudget() is a no-op at N=1.
const rackMgr = new RackMgr({ logger });
const primaryRuntime = new ConsoleRuntime({ id: CONSOLE_ID, adopt: { client, canvas: emuCanvas } });
rackMgr.add(primaryRuntime);
rackMgr.setFocus(CONSOLE_ID);

// Consumers that captured the singleton primary `client` register a re-point
// callback here; a live primary reboot reassigns `client` to the new runtime's
// EmulatorClient and fires them so keyboard/desktop-pad/reset all drive the new
// core. (Input that already routes through rackMgr.get(CONSOLE_ID) — LightGunMgr,
// GameInputMgr.dispatch — needs no rebind; it's live-aware already.)
const _primaryClientListeners = [];
function onPrimaryClientChange(fn) { _primaryClientListeners.push(fn); fn(client); }
function rebindPrimaryClient(newClient) {
  client = newClient;
  window.__client = newClient;
  for (const fn of _primaryClientListeners) { try { fn(newClient); } catch (e) { console.warn('[main] primary-client rebind listener', e); } }
}
// The keyboard InputMgr forwards to its captured client; keep it on the live one.
onPrimaryClientChange((c) => { input.client = c; });

// "Auto-pause idle cores" setting (default ON). Off = every spawned core stays
// live regardless of gaze/budget — for machines that can run them all. Persisted
// so the choice survives reloads. The gaze pause only ever applies with >1 core.
const AUTO_PAUSE_KEY = 'libretrowebxr.rackAutoPause';
const loadAutoPause = () => { try { return localStorage.getItem(AUTO_PAUSE_KEY) !== 'off'; } catch (_) { return true; } };
const saveAutoPause = (on) => { try { localStorage.setItem(AUTO_PAUSE_KEY, on ? 'on' : 'off'); } catch (_) {} };
rackMgr.setBudgetEnabled(loadAutoPause());

// Apply the patch graph's video edges to the scene: each TV samples the canvas
// of the console patched to it (cable.sourceOf). Idempotent — TV.setSource
// dedupes — so it's safe to call after any repatch / console spawn. At N=1 this
// just keeps tv0 ↔ console0 in sync with whatever the primary client booted.
let _lastRouteSig = '';
const routeVideo = () => {
  const diag = [];
  for (const tv of scene._tvs) {
    // A powered-off TV shows the idle screen regardless of what's patched to it.
    if (!isTvOn(tv.id)) { tv.setSource(placeholderCanvas); diag.push(`${tv.id}=off`); continue; }
    const src = cable.sourceOf(tv.id);             // consoleId | null
    // A powered-off console feeds nothing — its TV falls back to the idle screen.
    const canvas = (src && isConsoleOn(src)) ? rackMgr.get(src)?.canvas : null;
    // A TV with no patched console shows the idle screen (a pulled video cord
    // leaves the TV blank rather than frozen on the last frame).
    tv.setSource(canvas || placeholderCanvas);
    diag.push(`${tv.id}<-${src || 'none'}#${canvas?.id || 'idle'}`);
  }
  // Diagnostic for the "game on both screens" report: logs which canvas each TV
  // samples whenever the routing changes. If two TVs show the same #canvas id,
  // they're patched to the same console — the smoking gun in the headset logs.
  const sig = diag.join(' ');
  if (sig !== _lastRouteSig && scene._tvs.length > 1) {
    _lastRouteSig = sig;
    logger?.event?.('video-route', { map: sig });
  }
};

// ── Focus (gaze) → live-budget + audio mute ─────────────────────────────────
// The console whose TV the user is looking at is the "focused" one: the rack
// budget keeps it live ([[src/RackMgr.js]]) and the audio router makes only it
// audible ([[src/SpatialAudio.js]]) so N live cores don't blast over each other.
function refreshAudioFocus() { audioRouter?.setFocus?.(rackMgr.focusedId()); }

const _camPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _toTv = new THREE.Vector3();
function updateFocus() {
  if (scene._tvs.length < 2) return;        // nothing to switch between
  const cam = scene.camera;
  cam.getWorldPosition(_camPos);
  cam.getWorldDirection(_camDir);
  let best = null, bestDot = 0.55;          // ~57° cone; ignore glances away
  for (const tv of scene._tvs) {
    tv.group.getWorldPosition(_toTv);
    _toTv.sub(_camPos).normalize();
    const dot = _toTv.dot(_camDir);
    if (dot > bestDot) { bestDot = dot; best = tv; }
  }
  if (!best) return;
  const consoleId = cable.sourceOf(best.id);
  if (!consoleId || consoleId === rackMgr.focusedId()) return;
  rackMgr.setFocus(consoleId);
  rackMgr.applyBudget();
  refreshAudioFocus();
}

// ── Video patch cords (console → TV) ────────────────────────────────────────
// Each console has ONE physical video-out cable whose grabbable plug
// ([[src/Plug.js]]) seats into a TV's video-in jack. Seating rewires the patch
// graph (cable.connectVideo) and re-routes the texture; pulling the plug out and
// dropping it in mid-air clears the console's video edge (EmuVR repatch). The
// pure snap decision is [[src/Snap.js]]; the graph is [[src/Patchbay.js]].
const PLUG_SNAP_RADIUS = 0.26;                     // m — jack acceptance radius
const consoleObjs = new Map();                     // consoleId -> physical Console Object3D
const videoPlugs = new Map();                      // consoleId -> { plug:Plug, cord:Cord }
const _vp = new THREE.Vector3();
const _vq = new THREE.Quaternion();

// Snap a console's video plug onto a TV's video-in jack (world transform), so it
// visually sits in the socket. tvId null leaves the plug where it is (dangling).
function seatVideoPlug(consoleId, tvId) {
  const rec = videoPlugs.get(consoleId);
  const tv = tvId ? scene.getTV(tvId) : null;
  if (!rec || !tv?.videoIn) return;
  tv.videoIn.getWorldPosition(_vp);
  tv.videoIn.getWorldQuaternion(_vq);
  rec.plug.group.position.copy(_vp);
  rec.plug.group.quaternion.copy(_vq);
}

// Build the video-out plug + cord for a console and seat it at its starting TV.
function addVideoPlug(consoleId, tvId) {
  if (videoPlugs.has(consoleId)) return;
  const plug = new Plug({ id: `vplug-${consoleId}`, plugKind: 'video', sourceId: consoleId });
  scene.addObject(plug.group);
  grabMgr?.addGrabbable(plug.group);
  const cord = new Cord({ color: 0xccaa22 });
  scene.addObject(cord.mesh);
  videoPlugs.set(consoleId, { plug, cord });
  seatVideoPlug(consoleId, tvId);
}

// GrabMgr release handler: snap the plug to the nearest TV jack and repatch, or
// pull the console's video if dropped away from every jack.
const _plugWorld = new THREE.Vector3();
function handlePlugReleased(plugObj) {
  const ud = plugObj.userData || {};
  if (ud.plugKind === 'controller') { handleControllerPlugReleased(plugObj); return; }
  if (ud.plugKind === 'keyboard')   { handleKeyboardPlugReleased(plugObj);   return; }
  if (ud.plugKind !== 'video') return;
  const consoleId = ud.sourceId;
  plugObj.getWorldPosition(_plugWorld);
  const anchors = scene._tvs.map((tv) => {
    const p = new THREE.Vector3();
    tv.videoIn.getWorldPosition(p);
    return { id: tv.id, x: p.x, y: p.y, z: p.z };
  });
  const hit = nearestAnchor({ x: _plugWorld.x, y: _plugWorld.y, z: _plugWorld.z }, anchors, PLUG_SNAP_RADIUS);
  // One physical cable = one output: drop the console's prior TV edge(s) first.
  for (const tvId of cable.displaysOf(consoleId)) cable.disconnectVideo(tvId);
  if (hit) {
    cable.connectVideo(consoleId, hit.id);
    seatVideoPlug(consoleId, hit.id);
  }
  routeVideo();
  persistRack();
  logger?.event?.('video-repatch', { consoleId, tv: hit?.id || null });
}

// Per-frame: reshape each console's video cord from its console's video-out
// anchor to its plug (seated in a jack or held in hand).
const _cFrom = new THREE.Vector3();
const _cTo = new THREE.Vector3();
function syncVideoCords() {
  for (const [consoleId, rec] of videoPlugs) {
    const conObj = consoleObjs.get(consoleId);
    const out = conObj?.userData?.videoOutAnchor;
    if (!out) { rec.cord.setVisible(false); continue; }
    // Re-snap the plug to its TV's video-in jack every frame (unless it's in
    // hand) so the cord follows when the console OR the TV is repositioned in
    // Edit mode. seatVideoPlug(_, undefined) no-ops for a dangling plug, so a
    // disconnected cable just stays where it was dropped.
    if (!grabMgr?.isHeld(rec.plug.group)) seatVideoPlug(consoleId, cable.displaysOf(consoleId)[0]);
    out.getWorldPosition(_cFrom);
    (rec.plug.cordAnchor || rec.plug.group).getWorldPosition(_cTo);
    rec.cord.update(_cFrom, _cTo);
    rec.cord.setVisible(true);
  }
}

// Broadcast the current position + descriptor of a placed prop to all peers in
// the session. Called from GrabMgr's onEditRelease (after the editor has snapped
// the final position) and from addProp (to announce a newly created prop).
// No-ops outside a session (net === null) or if the object has no prop descriptor
// or no id.  The key is `prop:<propId>`; the value is the serialized payload
// (type, pos, rot, and any type-specific fields like poster texture).
// _knownPropPayloads is updated immediately so subsequent local moves that
// produce the same transform are deduplicated by setObjectState's JSON equality
// check.
function _broadcastPropMove(obj) {
  if (!net || !obj) return;
  const prop = obj.userData?.roomProp;
  if (!prop || !prop.id) return;
  const payload = serializePropState(prop, obj);
  const changed = net.setObjectState(makePropStateKey(prop.id), payload);
  // Sync _knownPropPayloads so diffPropSync doesn't re-process our own echo.
  if (changed) _knownPropPayloads.set(prop.id, payload);
  // Register newly-added local props in _syncedProps (if not already there)
  // so window.__props and reconciler can find them by propId.
  if (!_syncedProps.has(prop.id)) _syncedProps.set(prop.id, { prop, object: obj });
}

// Item 6 — make a rack prop (TV cabinet / console) repositionable: register it
// as an editable grabbable so it is inert during play but movable in the editor's
// Move mode (released props keep their dropped pose, grid-snapped if grid is on).
function registerMovableProp(obj, kind) {
  if (!obj || !grabMgr) return;
  if (!obj.userData.kind) obj.userData.kind = kind;
  obj.userData.editable = true;
  grabMgr.addGrabbable(obj);
}

// ── In-world power / reset switches ─────────────────────────────────────────
// Physical on/off switches on each console + TV and a reset button on each
// console. They are MenuMgr items, so the SAME raycast that drives the menu
// activates them — VR trigger, or desktop LEFT-CLICK (DesktopControls maps the
// left mouse button to 'selectstart'). A tinted label mesh facing forward; hover
// brightens it. Toggling power pauses/blanks via routeVideo()'s power check.
const _ctrlBtnTextures = [];                       // for disposal completeness (none today)
function makeControlButton(label, { w = 0.07, h = 0.032, color = '#2a6e2a' } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  let hovered = false;
  let face = color;
  let text = label;
  const redraw = () => {
    ctx.clearRect(0, 0, 256, 128);
    ctx.fillStyle = hovered ? '#d8e8ff' : face;
    ctx.fillRect(0, 0, 256, 128);
    ctx.strokeStyle = hovered ? '#ffffff' : '#111';
    ctx.lineWidth = 10; ctx.strokeRect(5, 5, 246, 118);
    ctx.fillStyle = hovered ? '#10243f' : '#ffffff';
    ctx.font = 'bold 56px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 68);
    tex.needsUpdate = true;
  };
  redraw();
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
  );
  mesh.userData.kind = 'menu-button';   // hover convention shared with MenuPanel
  mesh.userData.setHover = (hv) => { if (hv !== hovered) { hovered = hv; redraw(); } };
  mesh.userData.setLabel = (s) => { if (s !== text) { text = s; redraw(); } };
  mesh.userData.setColor = (c) => { if (c !== face) { face = c; redraw(); } };
  _ctrlBtnTextures.push(tex);
  return mesh;
}

// Power a console on/off: pause/resume its core and re-route video so its TV
// shows the idle screen while off. Updates the switch tint.
function _tintPowerBtn(btn, on) {
  btn?.userData.setColor?.(on ? '#2a6e2a' : '#7a2222');
  btn?.userData.setLabel?.(on ? 'ON' : 'OFF');
}

function setConsolePower(consoleId, on, btn) {
  consolePowered.set(consoleId, on);
  const rt = rackMgr.get(consoleId);
  if (on) rt?.resume?.(); else rt?.pause?.();
  _tintPowerBtn(btn, on);
  routeVideo();
  persistRack();
  logger?.event?.('console-power', { consoleId, on });
}

function setTvPower(tvId, on, btn) {
  tvPowered.set(tvId, on);
  _tintPowerBtn(btn, on);
  routeVideo();
  persistRack();
  logger?.event?.('tv-power', { tvId, on });
}

// ── Power / reset network sync (Phase 3) ────────────────────────────────────
// Power rides the persisted STATE channel (last-writer-wins, replayed to late
// joiners) so an on/off toggle by ANY peer reflects everywhere and a late joiner
// sees the current state. Because the host's authoritative core obeys the same
// toggle, its video stream shows the result to clients. Reset is a one-shot event
// (not a state), so it rides the transient WIRE channel — relayed, never stored,
// so a late joiner doesn't replay a stale reset onto a freshly-booted core.
function powerStateKey(kind, id) { return `power:${kind}:${id}`; }
function isPowerStateKey(k) { return typeof k === 'string' && k.startsWith('power:'); }

function _broadcastPower(kind, id, on) { net?.setObjectState(powerStateKey(kind, id), { on: !!on }); }
function _broadcastReset(consoleId) { net?.sendWire('reset', { consoleId }); }

// Locally reset a console's core + flash its RESET button. Used by the in-world
// button and the remote-apply ('reset' wire) path.
function resetConsole(consoleId) {
  rackMgr.get(consoleId)?.client?.reset?.();
  const rst = consoleObjs.get(consoleId)?.userData?.resetBtn;
  rst?.userData.setColor?.('#5a7fb0');
  setTimeout(() => rst?.userData.setColor?.('#33506e'), 180);
  logger?.event?.('console-reset', { consoleId });
}

// Apply a peer's power STATE (no re-broadcast — only the toggling peer broadcasts).
function _applyRemotePower(key, value) {
  if (value == null) return;
  const rest = key.slice('power:'.length);   // 'console:<id>' | 'tv:<id>'
  const sep = rest.indexOf(':');
  if (sep < 0) return;
  const kind = rest.slice(0, sep), id = rest.slice(sep + 1);
  if (kind === 'console') {
    if (isConsoleOn(id) !== !!value.on) setConsolePower(id, !!value.on, consoleObjs.get(id)?.userData?.powerBtn);
  } else if (kind === 'tv') {
    if (isTvOn(id) !== !!value.on) setTvPower(id, !!value.on, scene.getTV(id)?.group?.userData?.powerBtn);
  }
}

// Mount a power switch + reset button on a console's top-back surface and wire
// them through MenuMgr. Console box is CON_W 0.52 × CON_H 0.08 × CON_D 0.30
// (origin-centred), so the top is y≈+0.041 and the back half is z<0 (free of the
// cart/card slots at z≈0). Buttons face up-and-forward so a player looking at the
// console can click them.
function addConsoleControls(consoleId, conObj) {
  if (!conObj || !menuMgr || conObj.userData._hasControls) return;
  conObj.userData._hasControls = true;
  const topY = 0.041, backZ = -0.085;
  const on = isConsoleOn(consoleId);
  const pwr = makeControlButton(on ? 'ON' : 'OFF', { w: 0.08, color: on ? '#2a6e2a' : '#7a2222' });
  pwr.position.set(-0.11, topY, backZ);
  pwr.rotation.x = -Math.PI / 2.4;                 // tilt face up toward the viewer
  conObj.add(pwr);
  conObj.userData.powerBtn = pwr;                  // so a load can keep the tint in sync
  const rst = makeControlButton('RESET', { w: 0.11, color: '#33506e' });
  rst.position.set(0.09, topY, backZ);
  rst.rotation.x = -Math.PI / 2.4;
  conObj.add(rst);
  conObj.userData.resetBtn = rst;                  // so the 'reset' wire can flash it
  menuMgr.addItem(pwr, () => {
    const on = !isConsoleOn(consoleId);
    setConsolePower(consoleId, on, pwr);
    _broadcastPower('console', consoleId, on);     // sync to the room
  });
  menuMgr.addItem(rst, () => {
    resetConsole(consoleId);
    _broadcastReset(consoleId);                    // sync to the room (host re-runs its core)
  });
}

// Mount a power switch on a TV's lower-right front face and wire it through
// MenuMgr. TV cabinet is 2.2×1.65; the video-in jack sits lower-LEFT, so the
// switch goes lower-right to avoid it.
function addTvControls(tvId, tv) {
  if (!tv?.group || !menuMgr || tv.group.userData._hasControls) return;
  tv.group.userData._hasControls = true;
  const on = isTvOn(tvId);
  const pwr = makeControlButton(on ? 'ON' : 'OFF', { w: 0.16, h: 0.07, color: on ? '#2a6e2a' : '#7a2222' });
  pwr.position.set(2.2 / 2 - 0.2, -1.65 / 2 + 0.14, 0.03);
  tv.group.add(pwr);
  tv.group.userData.powerBtn = pwr;
  menuMgr.addItem(pwr, () => {
    const on = !isTvOn(tvId);
    setTvPower(tvId, on, pwr);
    _broadcastPower('tv', tvId, on);               // sync to the room
  });
}

// Phase 3 — spawn a SECOND (third, …) console end-to-end: its own
// ConsoleRuntime (own canvas + EmulatorClient) booting a game for `system`,
// its own TV in the scene, wired through the patch graph (console→TV video),
// then routed + budgeted. This is the multi-TV path the Phase 0 spike proved;
// the Phase 5 spawn menu and Phase 4 cords will drive it from in-VR. Exposed on
// window.__rack for headless verification. Returns the new console's id.
let _spawnSeq = 0;
async function spawnConsole(system, opts = {}) {
  const { game } = opts;
  const games = window.__games || [];
  const meta = game || games.find((g) => g.system === system) || games[0];
  if (!meta) throw new Error(`spawnConsole: no game available for ${system}`);
  const core = CORES[meta.core];
  if (!core) throw new Error(`spawnConsole: unknown core ${meta.core}`);

  const n = ++_spawnSeq;
  const consoleId = `console${n}`;
  const tvId = `tv${n}`;

  // Own-mode runtime: fresh isolated core in its own canvas (Phase 0 proved N
  // module cores coexist). Boot the resolved ROM into it.
  const runtime = new ConsoleRuntime({ id: consoleId });
  const buf = await resolveRom(meta);
  // Build this console's TV first so the audio branch can anchor on it, then
  // label the NEXT core's audio branch before booting it (the core's
  // `new AudioContext()` during load() lands in this branch).
  // Item 4 — room-aware placement: lay the console out in a row that STAYS
  // INSIDE the room (fanSlot, [[src/Placement.js]]) instead of the old fixed
  // fan-out that walked the 2nd+ console straight through the side wall. The TV
  // sits above its console; clamp its (wider) cabinet so it can't clip the wall.
  const bounds = scene.getRoomBounds();
  const slot = fanSlot(n - 1, bounds, 'console', { z: -2.4 });
  const TV_HALF_W = 1.2;                              // TV cabinet half-width + margin
  const tvX = Math.max(bounds.minX + TV_HALF_W, Math.min(bounds.maxX - TV_HALF_W, slot.x));
  const tv = scene.addTV({ id: tvId, position: [tvX, 1.5, -3.6] });
  audioRouter.expect(consoleId, tv.group);
  // CORES entries are keyed by name and carry no `name` field; ConsoleRuntime
  // wants { name, url, style }, so graft the key on.
  await runtime.load(buf, { ...core, name: meta.core }, { system: meta.system, title: meta.title });
  rackMgr.add(runtime);
  // FIX B: record this console's system so connectKeyboardTo() can pick the
  // correct layout (c64/standard) when the keyboard is plugged into a secondary
  // console. Without this, _consoleSystems has no entry for consoleN and the
  // keyboard stays on the generic 'standard' layout even for C64 spawns.
  _consoleSystems.set(consoleId, meta.system);

  // Patch the graph: this console feeds its new TV.
  cable.addConsole(consoleId, { ports: portsForSystem(meta.system) });
  cable.addTV(tvId);
  cable.connectVideo(consoleId, tvId);
  tv.setSource(runtime.canvas);

  // A physical console under its TV, plus its grabbable video-out plug seated in
  // the new TV's jack — so this console is repatchable like the primary.
  const conObj = createConsole({ position: new THREE.Vector3(slot.x, slot.y, slot.z) });
  scene.addObject(conObj);
  conObj.userData.setPorts?.(portsForSystem(meta.system));
  consoleObjs.set(consoleId, conObj);
  addVideoPlug(consoleId, tvId);
  // Item 6 — the spawned console + its TV are repositionable in Move mode too.
  registerMovableProp(conObj, 'console');
  registerMovableProp(tv.group, 'tv');
  // On/off + reset switches on the new console; on/off on its TV.
  addConsoleControls(consoleId, conObj);
  addTvControls(tvId, tv);
  routeVideo();

  // Admit under the perf budget (may pause an over-budget core; focus stays live).
  rackMgr.applyBudget();
  refreshAudioFocus();
  // Remember what was spawned (for persistence) unless this spawn is itself a
  // restore replay (which passes _restore to avoid re-saving mid-restore).
  if (!opts._restore) {
    spawnedMetas.push({ system: meta.system, file: meta.file, core: meta.core, title: meta.title });
    persistRack();
  }
  logger?.event?.('console-spawned', { consoleId, tvId, system: meta.system, core: meta.core, title: meta.title });
  return consoleId;
}

// Spawned (non-primary) console metas, in spawn order, for RackPersistence.
const spawnedMetas = [];

// Snapshot the physical layout (position + rotation) and power state of every
// rack object — primary AND spawned consoles + their TVs — keyed by id. Restored
// after the cross-core reload so a rearranged rack doesn't snap back to defaults.
function buildRackLayout() {
  const transforms = {};
  const power = {};
  const cap = (id, obj3d) => {
    if (!obj3d) return;
    const p = obj3d.position, r = obj3d.rotation;
    transforms[id] = { pos: [p.x, p.y, p.z], rot: [r.x, r.y, r.z] };
  };
  for (const [id, obj] of consoleObjs) { cap(id, obj); power[id] = isConsoleOn(id); }
  for (const tv of scene._tvs) { cap(tv.id, tv.group); power[tv.id] = isTvOn(tv.id); }
  return { transforms, power };
}

function persistRack() {
  try {
    saveRack(
      spawnedMetas,
      cable.tvs().map((tv) => ({ tv, console: cable.sourceOf(tv) })),
      buildRackLayout(),
    );
  } catch (e) { console.warn('[main] persistRack failed:', e); }
}

// Re-apply a saved layout entry (pos + rot) to a rack Object3D.
function _applyRackTransform(obj3d, t) {
  if (!obj3d || !t || !Array.isArray(t.pos)) return;
  obj3d.position.set(t.pos[0], t.pos[1], t.pos[2]);
  if (Array.isArray(t.rot)) obj3d.rotation.set(t.rot[0], t.rot[1], t.rot[2]);
  obj3d.updateMatrixWorld(true);
}

// Restore positions/rotations + power for every rack object from a saved layout.
// Called from restoreRack after consoles are (re)spawned and ids exist.
function applyRackLayout(layout) {
  if (!layout) return;
  const { transforms = {}, power = {} } = layout;
  for (const [id, obj] of consoleObjs) _applyRackTransform(obj, transforms[id]);
  for (const tv of scene._tvs) _applyRackTransform(tv.group, transforms[tv.id]);
  // Power: only flip the ones explicitly stored OFF (default is on).
  for (const [id] of consoleObjs) {
    if (power[id] === false) setConsolePower(id, false, consoleObjs.get(id)?.userData?.powerBtn);
  }
  for (const tv of scene._tvs) {
    if (power[tv.id] === false) setTvPower(tv.id, false, tv.group.userData?.powerBtn);
  }
}

// Re-create the saved rack: re-spawn each persisted console (re-booting its core
// from the matching library game) and replay the video patch edges. Best-effort
// — a saved game no longer in the library is skipped. Runs after the room build,
// once window.__games is populated.
async function restoreRack() {
  const saved = loadRack();
  if (!saved || !saved.consoles.length) return;
  const games = window.__games || [];
  setStatus(`Restoring ${saved.consoles.length} console(s)…`);
  for (const c of saved.consoles) {
    const game = games.find((g) => g.file === c.file) || games.find((g) => g.system === c.system);
    if (!game) { logger?.event?.('rack-restore-skip', { file: c.file, system: c.system }); continue; }
    try { await spawnConsole(game.system, { game, _restore: true }); }
    catch (e) { logger?.event?.('rack-restore-error', { file: c.file, error: String(e?.message || e) }); }
    // Mirror the live tracking so a later spawn/repatch re-saves the full set.
    spawnedMetas.push({ system: c.system, file: c.file, core: c.core, title: c.title });
  }
  // Replay the saved video mapping over the (deterministically re-created) ids.
  for (const e of saved.video) {
    if (!e.console) continue;
    if (cable.consoles().includes(e.console) && cable.tvs().includes(e.tv)) {
      cable.connectVideo(e.console, e.tv);
      seatVideoPlug(e.console, e.tv);
    }
  }
  // Restore each console/TV to where the user left it (and its power state) so
  // the cross-core reload preserves a rearranged rack instead of resetting it.
  // Plugs/cords re-seat to the moved jacks automatically (per-frame sync*Cords).
  applyRackLayout(saved.layout);
  routeVideo();
  refreshAudioFocus();
  persistRack();
  setStatus('Rack restored');
}

// Re-mint shelf cartridges for every locally-picked ROM the user has ever
// loaded. Runs after buildCartridgeWorld (shelves must exist). Best-effort,
// fire-and-forget per entry — one bad entry must not block the others.
// If OPFS no longer holds the bytes (evicted), the entry is pruned so the
// shelf doesn't show a dead cart.
async function restoreLocalRoms() {
  const list = loadLocalRoms();
  if (!list.length) return;
  const pruned = [];
  let anyPruned = false;
  for (const entry of list) {
    // Verify the OPFS bytes still exist before re-minting the cart.
    let hasBytes = false;
    try {
      if (typeof navigator !== 'undefined' && navigator.storage?.getDirectory) {
        const root = await navigator.storage.getDirectory();
        const key = `sha1-${entry.sha1}`;
        await root.getFileHandle(key); // throws if missing
        hasBytes = true;
      }
    } catch {
      hasBytes = false;
    }
    if (!hasBytes) {
      logger?.event?.('local-rom-restore-evicted', { file: entry.file, sha1: entry.sha1 });
      anyPruned = true;
      continue; // skip — bytes gone, don't show a dead cart
    }
    pruned.push(entry);
    try {
      await addLocalRomToShelf(lrlToCartMeta(entry));
    } catch (e) {
      logger?.event?.('local-rom-restore-error', { file: entry.file, error: String(e?.message || e) });
    }
  }
  if (anyPruned) {
    // Persist the pruned list (entries whose OPFS bytes were evicted removed).
    saveLocalRoms(pruned);
  }
}

// Append/update a local-ROM entry in localStorage. Called after a successful
// cacheRom so only OPFS-backed (sha1) entries are persisted.
function persistLocalRom(meta) {
  try {
    const list = loadLocalRoms();
    const next = lrlAddEntry(list, { ...meta, sha1: meta.rom?.sha1 });
    saveLocalRoms(next);
  } catch (e) {
    console.warn('[main] persistLocalRom failed:', e);
  }
}

// Request durable OPFS storage the first time a local ROM is cached.
// Best-effort: the browser may decline (e.g. no user engagement yet on Quest),
// and the pick fallback ensures the ROM can always be re-acquired anyway.
let _persistRequested = false;
function requestPersistentStorage() {
  if (_persistRequested) return;
  _persistRequested = true;
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
  navigator.storage.persist().then((granted) => {
    logger?.event?.('storage-persist', { granted });
  }).catch(() => {});
}

// Phase 5 spawn menu: spawn a live console for the next system not already
// running (so repeated taps cycle through the library's systems). Wired to the
// Add panel's "Spawn Console" button and window.__rack.spawnNext.
async function spawnNextConsole() {
  const games = window.__games || [];
  if (!games.length) { setStatus('No games available to spawn'); return null; }
  const running = new Set(rackMgr.runtimes().map((r) => r.system).filter(Boolean));
  const meta = games.find((g) => !running.has(g.system)) || games[0];
  setStatus(`Spawning ${meta.title}…`);
  try {
    const id = await spawnConsole(meta.system, { game: meta });
    setStatus(`Spawned ${meta.title} on ${id}`);
    return id;
  } catch (e) {
    setStatus(`Spawn failed: ${e.message || e}`);
    logger?.event?.('console-spawn-error', { system: meta.system, error: String(e?.message || e) });
    return null;
  }
}
let gamepadCount = 0;
const registerGamepad = (obj) => {
  if (obj && obj.userData.cableId == null) obj.userData.cableId = `gp-${++gamepadCount}`;
  if (obj?.userData.cableId) _gamepadObjs.set(obj.userData.cableId, obj);
  return obj;
};

// Per-player cord colour so you can tell P1/P2/P3/P4 controller cords apart.
const PLAYER_CORD_COLORS = [0x33cc55, 0x3388ff, 0xffaa33, 0xcc55dd]; // P1..P4
const _gamepadObjs = new Map(); // cableId -> gamepad Object3D (for cord endpoints)

// Resolve the live Object3D for a cableId across BOTH cabled peripheral kinds —
// gamepads and light guns. The controller-plug/cord helpers below are otherwise
// device-agnostic (they iterate every console's portJacks and read .cordAnchor),
// so this single lookup is the only seam that makes them serve guns too.
function _cabledObjFor(cableId) {
  return _gamepadObjs.get(cableId) || _lightGunObjsById.get(cableId) || _mouseObjsById.get(cableId) || null;
}

// Which gun-in-jack-order this gun is among the GUNS plugged into a console (0,1,…),
// or -1 if it isn't plugged there. cable.controllersOf returns occupants sorted by
// port, so filtering to guns gives a stable jack-order index → libretroGunPortFor
// maps it to the device's libretro gun port. This is what makes the LOWER jack gun
// drive port 1 and the next drive port 2 (and swapping jacks swap players).
function _gunSlotIndex(gun, consoleId) {
  const myId = gun?.userData?.cableId;
  if (myId == null || consoleId == null) return -1;
  const guns = cable.controllersOf(consoleId)
    .filter((c) => _lightGunObjsById.has(c.controllerId));
  return guns.findIndex((c) => c.controllerId === myId);
}

// The ordered libretro gun PORTs the two-gun device on `consoleId` seats its guns
// on (e.g. SNES Justifier → [1, 2]), or [] when that console's core is single-gun /
// no-gun. This is what makes a gun plugged into ANY console drive that console's
// OWN game, not just the primary's. For the PRIMARY console we return the live
// per-boot `_twoGunPorts` verbatim, so the shipped primary behaviour is byte-for-
// byte unchanged (its value already encodes the per-game twoGun/armed decision via
// _twoGunActiveFor at boot/reboot). For a SECONDARY console we derive the ports from
// that console runtime's loaded system: a two-gun-capable core yields its lightgun2
// ports, anything else yields [] → libretroGunPortFor returns null → the proven
// single-gun DOM-mouse path (so a non-gun secondary simply doesn't route aim).
function _twoGunPortsForConsole(consoleId) {
  if (consoleId == null) return [];
  if (consoleId === CONSOLE_ID) return _twoGunPorts;
  const system = rackMgr.get(consoleId)?.system ?? _consoleSystems.get(consoleId) ?? null;
  return twoGunPortsForSystem(system);
}

function cordColorForPlayer(player) {
  return PLAYER_CORD_COLORS[(player - 1) % PLAYER_CORD_COLORS.length];
}

// ── Controller patch cords (gamepad → console port) ─────────────────────────
// Each gamepad has a grabbable plug ([[src/Plug.js]], plugKind 'controller') on
// the end of its cord — the EmuVR repatch handle, the controller analogue of the
// video plugs. Seating the plug in a console's port jack plugs that controller
// into that console+port ([[src/Patchbay.js]] plugController); dropping it in
// mid-air unplugs it. The cord ([[src/Cord.js]]) runs gamepad → plug each frame.
// Works across ALL consoles in the rack (the snap searches every console's
// jacks), which is what makes a second console actually controllable.
const controllerPlugs = new Map(); // cableId -> { plug:Plug, cord:Cord }
const _cordFrom = new THREE.Vector3();
const _cordTo = new THREE.Vector3();
const _cpPos = new THREE.Vector3();
const _cpQuat = new THREE.Quaternion();

// Build the grabbable plug + cord for a gamepad and seat it at its current port.
function addControllerPlug(gpObj) {
  const cableId = gpObj?.userData?.cableId;
  if (!cableId || controllerPlugs.has(cableId)) return;
  const seat = cable.portOf(cableId);                // { consoleId, port } | null
  const color = cordColorForPlayer((seat?.port ?? 0) + 1);
  const plug = new Plug({ id: `cplug-${cableId}`, plugKind: 'controller', sourceId: cableId, color });
  scene.addObject(plug.group);
  grabMgr?.addGrabbable(plug.group);
  const cord = new Cord({ color });
  scene.addObject(cord.mesh);
  controllerPlugs.set(cableId, { plug, cord });
  seatControllerPlug(cableId);
}

// Snap a controller plug onto the jack of the port it's plugged into; if it's
// unplugged, park it just above its gamepad so the loose cord reads clearly.
function seatControllerPlug(cableId) {
  const rec = controllerPlugs.get(cableId);
  if (!rec) return;
  const seat = cable.portOf(cableId);
  const conObj = seat ? consoleObjs.get(seat.consoleId) : null;
  const jack = conObj?.userData?.portJacks?.[seat?.port];
  if (jack) {
    jack.getWorldPosition(_cpPos);
    jack.getWorldQuaternion(_cpQuat);
    rec.plug.group.position.copy(_cpPos);
    rec.plug.group.quaternion.copy(_cpQuat);
  } else {
    const gp = _cabledObjFor(cableId);
    if (gp) {
      (gp.userData.cordAnchor || gp).getWorldPosition(_cpPos);
      rec.plug.group.position.copy(_cpPos);
      rec.plug.group.position.y += 0.08;
    }
  }
}

// Re-broadcast a cabled peripheral's current port so every peer agrees on its
// port→player mapping after it (or its patch-cord plug) is dragged to a different
// jack. Picks the channel by which kind owns the cableId: a light gun rides the
// gun:<cableId> STATE (port-only; its mesh rides prop:*), a gamepad rides
// gamepad:<cableId>. Both carry { port } (-1 = unplugged); RoomObjects dedups, so
// an unchanged port is a no-op, as is a call outside a session. Call at discrete
// re-plug events only — NOT from seatControllerPlug (that runs every frame).
function _broadcastCablePort(cableId) {
  if (!net || !cableId) return;
  const port = cable.portOf(cableId)?.port ?? -1;
  const key = _lightGunObjsById.has(cableId)
    ? makeGunStateKey(cableId)
    : _mouseObjsById.has(cableId)
      ? makeMouseStateKey(cableId)
      : makeGamepadStateKey(cableId);
  net.setObjectState(key, { port });
}

// GrabMgr release handler for a controller plug: snap to the nearest free port
// jack across EVERY console and re-plug, or unplug if dropped in mid-air.
const _ctrlPlugWorld = new THREE.Vector3();
function handleControllerPlugReleased(plugObj) {
  const cableId = plugObj.userData?.sourceId;
  if (!cableId) return;
  plugObj.getWorldPosition(_ctrlPlugWorld);
  const cur = cable.portOf(cableId);
  const anchors = [];
  const _j = new THREE.Vector3();
  for (const [consoleId, conObj] of consoleObjs) {
    const jacks = conObj.userData?.portJacks || [];
    const active = conObj.userData?.activePorts ?? jacks.length;
    for (let port = 0; port < jacks.length && port < active; port++) {
      const free = cable.isPortFree(consoleId, port);
      const mine = cur && cur.consoleId === consoleId && cur.port === port;
      if (!free && !mine) continue;          // taken by another pad → skip
      jacks[port].getWorldPosition(_j);
      anchors.push({ id: `${consoleId}#${port}`, consoleId, port, x: _j.x, y: _j.y, z: _j.z });
    }
  }
  const hit = nearestAnchor(
    { x: _ctrlPlugWorld.x, y: _ctrlPlugWorld.y, z: _ctrlPlugWorld.z },
    anchors, PLUG_SNAP_RADIUS,
  );
  if (hit) cable.plugController(cableId, hit.anchor.consoleId, hit.anchor.port);
  else cable.unplugController(cableId);
  seatControllerPlug(cableId);
  _broadcastCablePort(cableId);             // peers must agree on the new port→player
  gameInput?.flushReleases();               // drop keys held under the old seat
  logger?.event?.('controller-repatch', { cableId, seat: hit ? hit.id : null });
}

// Reshape each controller cord from its peripheral (gamepad OR light gun) to its
// plug every frame.
function syncControllerCords() {
  for (const [cableId, rec] of controllerPlugs) {
    const gp = _cabledObjFor(cableId);
    if (!gp) { rec.cord.setVisible(false); continue; }
    // Re-snap the plug to its port jack every frame (unless it's in hand) so the
    // cord follows when the console it's plugged into is moved in Edit mode.
    if (!grabMgr?.isHeld(rec.plug.group)) seatControllerPlug(cableId);
    (gp.userData.cordAnchor || gp).getWorldPosition(_cordFrom);
    (rec.plug.cordAnchor || rec.plug.group).getWorldPosition(_cordTo);
    rec.cord.update(_cordFrom, _cordTo);
    rec.cord.setVisible(true);
  }
}

// ── Keyboard patch cord (keyboard → console DIN jack) ───────────────────────
// Mirrors the controller cord pattern: a Plug (plugKind 'keyboard') on the
// end of a Cord from the keyboard's cordAnchor.  Seating it in a console's
// keyboardJack calls connectKeyboardTo(consoleId); mid-air drop disconnects.
const keyboardPlugs = new Map(); // kbdId -> { plug:Plug, cord:Cord }
const _kbdFrom = new THREE.Vector3();
const _kbdTo = new THREE.Vector3();
const _kbdPlugPos = new THREE.Vector3();
const _kbdPlugQuat = new THREE.Quaternion();

// Build the grabbbable plug + cord for the keyboard device and seat it at the
// connected console's keyboardJack (or dangling if not yet connected).
function addKeyboardPlug(kbdObj) {
  if (!kbdObj || keyboardPlugs.has(KBD_ID)) return;
  const plug = new Plug({ id: `kplug-${KBD_ID}`, plugKind: 'keyboard', sourceId: KBD_ID });
  scene.addObject(plug.group);
  grabMgr?.addGrabbable(plug.group);
  const cord = new Cord({ color: 0xddcc88 }); // cream/off-white, matches the plug tint
  scene.addObject(cord.mesh);
  keyboardPlugs.set(KBD_ID, { plug, cord });
  seatKeyboardPlug();
}

// Snap the keyboard plug onto the keyboardJack of the connected console; if
// disconnected, park it just behind the keyboard body so the loose cord reads clearly.
function seatKeyboardPlug() {
  const rec = keyboardPlugs.get(KBD_ID);
  if (!rec) return;
  const conObj = _kbdTargetConsoleId ? consoleObjs.get(_kbdTargetConsoleId) : null;
  const jack = conObj?.userData?.keyboardJack;
  if (jack) {
    jack.getWorldPosition(_kbdPlugPos);
    jack.getWorldQuaternion(_kbdPlugQuat);
    rec.plug.group.position.copy(_kbdPlugPos);
    rec.plug.group.quaternion.copy(_kbdPlugQuat);
  } else if (c64kbd) {
    (c64kbd.cordAnchor || c64kbd.object3d).getWorldPosition(_kbdPlugPos);
    rec.plug.group.position.copy(_kbdPlugPos);
    rec.plug.group.position.y += 0.08;
  }
}

// GrabMgr release handler for a keyboard plug: snap to nearest keyboardJack
// across all consoles (within keyboardJackRadius) and connect, else disconnect.
const _kbdPlugWorld = new THREE.Vector3();
function handleKeyboardPlugReleased(plugObj) {
  if (plugObj.userData?.sourceId !== KBD_ID) return;
  plugObj.getWorldPosition(_kbdPlugWorld);
  const anchors = [];
  const _j = new THREE.Vector3();
  for (const [consoleId, conObj] of consoleObjs) {
    const jack = conObj.userData?.keyboardJack;
    const radius = conObj.userData?.keyboardJackRadius ?? 0.19;
    if (!jack) continue;
    jack.getWorldPosition(_j);
    anchors.push({ id: consoleId, consoleId, radius, x: _j.x, y: _j.y, z: _j.z });
  }
  // Use the per-console keyboardJackRadius for the snap.
  let hit = null;
  let hitDist = Infinity;
  for (const a of anchors) {
    const dx = _kbdPlugWorld.x - a.x, dy = _kbdPlugWorld.y - a.y, dz = _kbdPlugWorld.z - a.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < a.radius && dist < hitDist) { hitDist = dist; hit = a; }
  }
  if (hit) {
    connectKeyboardTo(hit.consoleId);
  } else {
    disconnectKeyboard();
  }
  seatKeyboardPlug();
  logger?.event?.('keyboard-repatch', { seat: hit?.consoleId || null });
}

// Reshape the keyboard cord from the keyboard body to its plug every frame.
function syncKeyboardCord() {
  const rec = keyboardPlugs.get(KBD_ID);
  if (!rec) return;
  // The plug + cord only exist while the keyboard is shown — hide both (and the
  // grabbable plug, so it can't be caught) when there's no keyboard on screen.
  const kbShown = !!c64kbd && c64kbd.object3d.visible;
  rec.plug.group.visible = kbShown;
  rec.cord.setVisible(kbShown);
  if (!kbShown) return;
  // Re-snap the plug to the connected console's keyboard jack every frame
  // (unless it's in hand) so the cord follows when that console is moved.
  if (!grabMgr?.isHeld(rec.plug.group)) seatKeyboardPlug();
  (c64kbd.cordAnchor || c64kbd.object3d).getWorldPosition(_kbdFrom);
  (rec.plug.cordAnchor || rec.plug.group).getWorldPosition(_kbdTo);
  rec.cord.update(_kbdFrom, _kbdTo);
}

// Route keyboard input to the given console's emulator core, updating the
// Patchbay, sendInput closure, and the layout to match the booted system.
// `currentConsoleSystems` tracks what each console is running (set by loadCartridge).
const _consoleSystems = new Map(); // consoleId -> system string (set on each boot)

function connectKeyboardTo(consoleId) {
  if (!c64kbd) return;
  // Flush any held keys on the old target before switching.
  c64kbd.flushReleases();
  _kbdTargetConsoleId = consoleId || CONSOLE_ID;
  cable.plugKeyboard(KBD_ID, _kbdTargetConsoleId);
  // Re-wire sendInput to target the new console.
  c64kbd.setSendInput((type, code, key, keyCode, location) =>
    rackMgr.get(_kbdTargetConsoleId)?.sendInput(type, code, key, keyCode, location));
  // Switch layout: c64 layout for keyboard-capable Commodore systems, standard otherwise.
  const sys = _consoleSystems.get(_kbdTargetConsoleId);
  c64kbd.setLayout(isKeyboardCapable(sys) ? 'c64' : 'standard');
  seatKeyboardPlug();
}

function disconnectKeyboard() {
  if (!c64kbd) return;
  c64kbd.flushReleases();
  cable.unplugKeyboard(KBD_ID);
  // FIX C: a mid-air drop is a TRUE disconnect — null target + no-op sendInput
  // so no console receives keystrokes until the keyboard is re-plugged. The
  // startup path (buildCartridgeWorld) still calls connectKeyboardTo(CONSOLE_ID)
  // so out-of-the-box the keyboard is wired; only an explicit unplug disconnects.
  // seatKeyboardPlug() reads _kbdTargetConsoleId===null and parks the plug behind
  // the keyboard body (safe: consoleObjs.get(null) returns undefined → no jack).
  _kbdTargetConsoleId = null;
  c64kbd.setSendInput(() => {});
}

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
    // Patchbay returns { consoleId, player } | null. null (an unplugged pad)
    // now drives NOTHING — no silent fall-back to player 1, which is what made
    // grabbing controller 2 still control gamepad 1. Console-aware: each entry
    // carries consoleId so GameInputMgr dispatches to the right core.
    playerOf: (cableId) => cable.playerOf(cableId),
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
  const room = defaultRoom(collectionUrl);
  // Optional local overlay: if a GITIGNORED roms/local/local.collection.json is
  // present on THIS server, add a shelf for it so the bare base URL surfaces the
  // user's own sideloaded games (no long ?collection= to type on a headset).
  // Absent on a clean git clone → loadCollection returns {games:[]} → skipped,
  // so default behaviour is unchanged. Skipped when ?collection= is given (that's
  // an explicit override of what to show).
  if (!urlParams.get('collection')) {
    try {
      const localRef = 'roms/local/local.collection.json';
      const localCol = await loadCollection(localRef);
      if (localCol?.games?.length) {
        room.collections.push(localRef);
        // A freestanding bookcase (3 rows × 5 = up to 15 carts) on the open floor
        // front-left, angled toward the player — compact + clearly in the initial
        // eyeline (a wide wall shelf of 10 carts was too big / out of view).
        room.props.push({ type: 'bookcase', id: 'bookcase-local', collection: localRef,
          pos: [-1.5, 0, -1.4], rot: [0, 32, 0] });
        console.log(`[main] local overlay: +${localCol.games.length} games on a bookcase (${localRef})`);
      }
    } catch (e) { /* no local overlay → default room unchanged */ }
  }
  return { room, inline: [] };
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

// M-room: the shared STATE key the host publishes its serialized room under and
// late joiners adopt (see _awaitHostRoom + buildCartridgeWorld).
const ROOM_STATE_KEY = 'room';

// Wait briefly for the room handoff to resolve when joining a session. Returns
// the host's published room snapshot if one exists, else null when we appear to
// be the first peer (the host) — or on timeout / no connection, so solo and
// offline still build their local room. The server replays all shared STATE in
// one burst right after HELLO, so once our selfId is assigned a short grace
// window is enough to see a 'room' key (or conclude there isn't one yet).
function _awaitHostRoom({ timeoutMs = 2000, graceMs = 500 } = {}) {
  return new Promise((resolve) => {
    const start = performance.now();
    let settledAt = 0;
    const poll = () => {
      if (!net) return resolve(null);
      const hostRoom = net.getObjectState(ROOM_STATE_KEY);
      if (hostRoom) return resolve(hostRoom);          // a host already published → adopt
      const now = performance.now();
      if (net.selfId) {                                // HELLO seen → STATE replay delivered
        if (!settledAt) settledAt = now;
        if (now - settledAt >= graceMs) return resolve(null); // no host room → we are the host
      }
      if (now - start >= timeoutMs) return resolve(null);
      setTimeout(poll, 40);
    };
    poll();
  });
}

async function buildCartridgeWorld() {
  const resolved = await resolveWorld();
  let room = resolved.room;
  const inline = resolved.inline;

  // M-room handoff: in a session, the first peer is the host and publishes its
  // room (below); later joiners adopt that snapshot here instead of building
  // their own (divergent) local default — the root cause of "the host's room
  // setup isn't shared". Decided BEFORE collections load (so we fetch the
  // adopted room's collections) and BEFORE buildRoom (so we build exactly once:
  // no teardown/rebuild, and no page reload that would drop a VR user out of
  // immersive). Ongoing edits still ride the existing prop:* deltas on top.
  let _publishHostRoom = false;
  if (net) {
    if (_resumeAsHost) {
      // We were the host before our OWN cross-core / gun-arm reload. Don't adopt a
      // peer's snapshot — our bridged room (consumeRoomBridge, resolved above) is
      // the authoritative layout. Republish it so the persisted 'room' STATE tracks
      // our reload and we re-claim host, instead of being overwritten by the staler
      // copy a peer may have echoed while we were briefly disconnected.
      _publishHostRoom = true;
      logger?.event?.('mp-room-resume-host', { props: room?.props?.length ?? 0 });
    } else {
      const hostRoom = await _awaitHostRoom();
      if (hostRoom) {
        room = parseRoom(hostRoom, { sourceLabel: 'mp-host' });
        logger?.event?.('mp-room-adopt', { props: room?.props?.length ?? 0 });
      } else {
        _publishHostRoom = true;
      }
    }
  }

  currentRoom = room;
  const collections = await loadRoomCollections(room, inline);
  currentCollections = collections; // Phase E.3: build a new shelf against these
  const allGames = collections.list.flatMap((c) => c.games);
  window.__games = allGames; // debug hook: harness boots via these metas
  setStatus(allGames.length ? `${allGames.length} games` : 'no games');

  // Phase-0 de-risk spike (throwaway, behind ?rack=N): expose window.__rackSpike
  // so scripts/debug.js --rack=N (and the headset) can boot N live module cores
  // into N canvases and probe multi-instance safety / input isolation / perf.
  // Each booted core's canvas is textured onto a TV-style quad in front of the
  // user so the result is visible in VR; perf telemetry ships via logger.event.
  if (urlParams.has('rack')) {
    const want = parseInt(urlParams.get('rack') || '2', 10) || 2;
    // Memoized so auto-boot + an explicit harness call share ONE rack (no
    // double-boot). The first call wins the core count.
    let _rackHandle = null;
    window.__rackSpike = (n) => {
      if (_rackHandle) return _rackHandle;
      _rackHandle = (async () => {
        const { runRackSpike } = await import('./RackSpike.js');
        return runRackSpike({
          n: n || want, games: allGames, CORES, resolveRom, EmulatorClient, logger,
          onCanvas: (i, canvas, meta) => {
            try { scene.addRackScreen?.(i, canvas, meta); } catch (e) { console.warn('[rack] addRackScreen', e); }
          },
        });
      })();
      return _rackHandle;
    };
    logger?.event?.('rack-spike-ready', { requested: want });

    // Ship periodic frame-rate telemetry so the Quest perf gate can be read from
    // dionysus.dk/logs?session=<room> without a dev console: every ~3s, log the
    // mean/min/max XR frame interval + fps, tagged with how many live cores are
    // mounted and whether we're presenting in XR (the only measurement that
    // counts — desktop fps is vsync-capped and not the gate).
    let _f = 0, _sum = 0, _min = Infinity, _max = 0, _since = 0;
    scene.addTickCallback?.((dtMs) => {
      if (!Number.isFinite(dtMs) || dtMs <= 0) return;
      _f++; _sum += dtMs; _since += dtMs;
      if (dtMs < _min) _min = dtMs;
      if (dtMs > _max) _max = dtMs;
      if (_since >= 3000 && _f > 0) {
        const mean = _sum / _f;
        logger?.event?.('rack-perf', {
          cores: scene._rackScreens?.length || 0,
          xr: !!scene.renderer?.xr?.isPresenting,
          fps: +(1000 / mean).toFixed(1),
          meanMs: +mean.toFixed(2), minMs: +_min.toFixed(2), maxMs: +_max.toFixed(2),
          frames: _f,
        });
        _f = 0; _sum = 0; _min = Infinity; _max = 0; _since = 0;
      }
    });

    // Auto-boot the rack on load so the user only has to open the ?rack=N URL
    // (and enter VR) — no console call needed. Errors are logged, not thrown.
    window.__rackSpike(want).catch((e) => {
      console.warn('[rack] auto-boot failed', e);
      logger?.event?.('rack-autoboot-error', { error: String(e?.message || e) });
    });
  }

  const built = buildRoom({ scene, room, collections });
  cartridges = built.cartridges;
  shelves = built.shelves;          // track for addLocalRomToShelf()
  consoleObj = built.consoleObj;
  gamepadObj = built.gamepadObj;
  roomPosters = built.placed.filter((e) => e.prop.type === 'poster');

  // M-room handoff: if we resolved as the host (first peer in the session),
  // publish our just-built room so later joiners adopt this exact layout.
  // serializeRoom(currentRoom) with no live-transform map is an identity
  // round-trip of the descriptor → the room@1 wire shape parseRoom() expects.
  if (_publishHostRoom && net) {
    net.setObjectState(ROOM_STATE_KEY, serializeRoom(currentRoom));
    logger?.event?.('mp-room-publish', { props: currentRoom?.props?.length ?? 0 });
  }

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
  // Light-gun prop: a grabbable pistol you point at the TV to play gun games
  // (Duck Hunt-style). Rests on the desk left of the console; wired into the
  // grab system + LightGunMgr below (see grabMgr.addGrabbable / new LightGunMgr).
  if (!lightGunObj) {
    lightGunObj = createLightGun({ position: new THREE.Vector3(-0.62, 0.78, -2.15) });
    scene.addObject(lightGunObj);
  }
  // In-world mouse prop: a grabbable mouse you move to drive a console's libretro
  // MOUSE device (Amiga point-and-click, The Settlers). Rests on the desk; wired
  // into the grab system + MouseMgr below (see _registerMouse / new MouseMgr).
  if (!mouseObj) {
    mouseObj = createMouse({ position: new THREE.Vector3(-0.30, 0.745, -2.05) });
    scene.addObject(mouseObj);
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

  // Physical keyboard device: a placeable, cabled keyboard that routes keystrokes
  // to whichever console it is plugged into. Starts hidden; auto-shows when a
  // keyboard-capable game (C64/VIC-20) boots. Placed on the desk slightly to the
  // left of the primary console at the standard floor-prop resting height.
  _kbdTargetConsoleId = CONSOLE_ID; // now in scope
  cable.addKeyboard(KBD_ID);
  c64kbd = createKeyboardDevice({
    position: new THREE.Vector3(-0.35, 0.72, -2.15),
    rotationY: 0,
    layout: 'standard',
  });
  c64kbd.setSendInput((type, code, key, keyCode, location) =>
    rackMgr.get(_kbdTargetConsoleId)?.sendInput(type, code, key, keyCode, location));
  c64kbd.object3d.visible = false;
  scene.addObject(c64kbd.object3d);
  window.__c64kbd = c64kbd; // legacy debug hook
  window.__kbd     = c64kbd; // canonical debug hook

  grabMgr = new GrabMgr({
    scene: scene.scene,
    controllers: scene.controllers,
    console: consoleObj,
    // Every physical console in the rack (primary + spawned), so a cartridge can
    // be dropped into any one of them. consoleObjs is a Map<consoleId, Object3D>,
    // already iterable as [consoleId, obj] pairs.
    getConsoles: () => consoleObjs,
    cable: cableAdapter,
    onCartridgeInserted: handleCartridgeInserted,
    onGamepadHeldChanged: (held) => {
      // When the gamepad is released, flush any still-pressed keys so the
      // emulator doesn't latch a held button on the controller's last
      // pre-drop state.
      if (!held) gameInput.flushReleases();
    },
    // Plugging/unplugging a gamepad changes which player it drives; flush so a
    // key held under the old assignment doesn't latch on the core. Also re-seat
    // its patch-cord plug so the cord follows the body-seated pad to its port.
    onGamepadPlugged: (gp) => { gameInput?.flushReleases(); seatControllerPlug(gp?.userData?.cableId); _broadcastCablePort(gp?.userData?.cableId); },
    // Patch-cord plug released → snap to nearest TV jack + repatch video.
    onPlugReleased: (plug) => handlePlugReleased(plug),
    onMemoryCardInserted: handleMemoryCardInserted,
    // Phase E: deferred arrows — `editor` is assigned just below and these are
    // only called at tick/release time, never during GrabMgr construction.
    isEditMode: () => editor?.isEditMode() || false,
    onEditRelease: (obj) => {
      editor?.onEditRelease(obj);
      // Prop room-layout sync (M-prop): after the editor has snapped the prop to
      // its final resting position, broadcast the new transform to all peers.
      // Only fires in a multiplayer session (net non-null). The prop descriptor
      // lives on userData.roomProp (set by buildRoom/editor.registerPlaced).
      // No echo guard needed: RoomObjects.apply deduplicates state that we set
      // ourselves (changed===false path in _applyState), so the server echo of
      // our own broadcast never triggers _reconcilePropState.
      if (net) _broadcastPropMove(obj);
      // A moved console/TV is rack state, not an editor prop — persist its new
      // transform so it survives the cross-core reload.
      if (obj?.userData?.kind === 'console' || obj?.userData?.kind === 'tv') persistRack();
    },
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
    // Shared-gamepad sync: announce/clear which gamepad we're holding so remote
    // peers see it locked and show a ghost in our avatar's hand.
    onGamepadGrabbed: (gp, hand) => {
      const id = net?.presence?.selfId;
      const cableId = gp.userData?.cableId;
      if (net && id && cableId) net.setObjectState(makeGamepadHoldKey(cableId), { holder: id, hand });
    },
    onGamepadReleased: (gp) => {
      const cableId = gp.userData?.cableId;
      if (net && cableId) net.setObjectState(makeGamepadHoldKey(cableId), null);
    },
    // Picking up the light gun arms it: connect the gun device on the current
    // (and future) gun-capable game. See armLightGunAndReload for the reload.
    onObjectGrabbed: (obj, hand) => {
      if (obj?.userData?.kind === 'lightgun') {
        logger?.event?.('lightgun-grab', { hand, system: currentMeta?.system || null, consoleId: CONSOLE_ID, alreadyArmed: _lightgunArmedConsole });
        armLightGunAndReload();
      } else if (obj?.userData?.kind === 'mouse') {
        logger?.event?.('mouse-grab', { hand, system: currentMeta?.system || null, consoleId: CONSOLE_ID, alreadyArmed: _mouseArmedConsole });
        armMouseAndReload();
      }
    },
    // Remote-hold lock: refuse grab of a gamepad currently held by a remote peer.
    // ghostGpMgr is set up just after GrabMgr in this function, so the reference
    // is captured as a closure — at grab-time it is non-null whenever net is active.
    isRemotelyHeld: (cableId) => ghostGpMgr?.isRemotelyHeld(cableId) || false,
    // Placement preview: supply live room bounds so the ghost can compute the
    // snapped drop location each frame. isPreviewEnabled() reads the editor's
    // surfaceSnap flag — the ghost is only shown when surface-snap is ON.
    getRoomBounds: () => scene.getRoomBounds(),
    isPreviewEnabled: () => !!(editor?.surfaceSnapEnabled() && editor?.isEditMode()),
  });
  cartridges.forEach((c) => grabMgr.addGrabbable(c));
  grabMgr.addGrabbable(gamepadObj);
  _registerLightGun(lightGunObj);
  _registerMouse(mouseObj);

  // Light-gun aiming: every frame, for each controller currently holding the gun,
  // raycast its barrel ray against the rack TV screens and drive the source
  // console's EmulatorClient.sendLightgun() with the hit's canvas u,v + trigger
  // (off-screen = a reload shot). The gun's console + port now come from the CABLE
  // (which console jack the gun's plug sits in), just like a gamepad.
  lightGunMgr = new LightGunMgr({
    getActiveGuns: () => scene.controllers
      .filter((ctrl) => _lightGunObjs.has(grabMgr.heldObject(ctrl)))
      .map((ctrl) => ({ gun: grabMgr.heldObject(ctrl), controller: ctrl })),
    getScreenTargets: () => scene._tvs.map((tv) => ({ tvId: tv.id, mesh: tv.mesh })),
    consoleIdForTV: (tvId) => cable.sourceOf(tvId),
    // The console the gun is plugged into (Patchbay), or null if unplugged.
    consoleIdForGun: (gun) => cable.portOf(gun?.userData?.cableId)?.consoleId ?? null,
    clientForGun: (gun) => {
      const cid = cable.portOf(gun?.userData?.cableId)?.consoleId;
      return cid ? (rackMgr.get(cid)?.client || null) : null;
    },
    // Libretro gun PORT this gun drives, for TWO-GUN co-op only. Derived live from
    // the cable: the Kth gun (in cable-port / jack order) on the console drives the
    // Kth of the active two-gun device's libretro ports (libretroGunPortFor). This
    // routes each gun to its OWN per-port aim slot in the patched multiport core
    // (webgun_set), and lets swapping the two guns' jacks swap their players.
    // Routes to the gun's seated console's OWN two-gun device: the Kth gun on
    // WHATEVER console it's plugged into drives the Kth of THAT console's two-gun
    // ports (_twoGunPortsForConsole). For the primary this equals the live
    // _twoGunPorts (unchanged); for a secondary it derives from that console
    // runtime's loaded system. Returns null for every single-gun game ([] ports),
    // an unplugged gun, or a non-gun secondary console — all of which leave
    // sendLightgun on the proven DOM-mouse path UNCHANGED, so the shipped Zapper /
    // Super Scope behaviour is untouched.
    portForGun: (gun) => {
      const seat = cable.portOf(gun?.userData?.cableId);
      if (!seat) return null;
      return libretroGunPortFor(_gunSlotIndex(gun, seat.consoleId), _twoGunPortsForConsole(seat.consoleId));
    },
    // Telemetry so a headset session is diagnosable from the logs without seeing
    // the screen (docs/HEADSET_LIGHTGUN_VALIDATION.md). Throttled aim + edge fire.
    log: (name, fields) => logger?.event?.(name, fields),
  });

  // In-world mouse driving: every frame, for each controller holding a mouse prop,
  // track the prop's world-position delta → relative libretro mouse motion + the
  // controller's trigger/squeeze → L/R buttons, and feed the plugged console's
  // EmulatorClient.sendMouse(dx,dy,buttons,port). Console + port come from the
  // CABLE (which jack the mouse's plug sits in), like a gamepad. portForMouse routes
  // each mouse to its OWN libretro port for split-pointer 2-player (two-mouse cores).
  mouseMgr = new MouseMgr({
    getActiveMice: () => scene.controllers
      .filter((ctrl) => _mouseObjs.has(grabMgr.heldObject(ctrl)))
      .map((ctrl) => ({ mouse: grabMgr.heldObject(ctrl), controller: ctrl })),
    clientForMouse: (mouse) => {
      const cid = cable.portOf(mouse?.userData?.cableId)?.consoleId;
      return cid ? (rackMgr.get(cid)?.client || null) : null;
    },
    // Libretro mouse PORT for split-pointer 2-player: the Kth mouse (cable-jack
    // order) on its seated console drives the Kth of that console's two-mouse ports.
    // Returns null for single-mouse / unplugged / non-mouse console → the shared
    // DOM-mouse path (one pointer), which is the proven, working single-mouse case.
    portForMouse: (mouse) => {
      const seat = cable.portOf(mouse?.userData?.cableId);
      if (!seat) return null;
      return libretroMousePortFor(_mouseSlotIndex(mouse, seat.consoleId), _twoMousePortsForConsole(seat.consoleId));
    },
    log: (name, fields) => logger?.event?.(name, fields),
  });
  // Desktop fallback: when NOT in VR, the computer mouse drives the primary mouse
  // via Pointer Lock (relative movementX/Y). Bind it to the app canvas; it only
  // fires while pointer-locked, so it never interferes with the VR positional path.
  mouseMgr.attachDesktop({
    getEl: () => scene.renderer?.domElement || document.querySelector('canvas'),
    getClient: () => {
      const seat = cable.portOf(mouseObj?.userData?.cableId);
      const cid = seat?.consoleId ?? CONSOLE_ID;
      return rackMgr.get(cid)?.client || null;
    },
    getPort: () => {
      const seat = cable.portOf(mouseObj?.userData?.cableId);
      if (!seat) return null;
      return libretroMousePortFor(_mouseSlotIndex(mouseObj, seat.consoleId), _twoMousePortsForConsole(seat.consoleId));
    },
  });

  // Phase 4: the primary console's physical object + its grabbable video-out
  // plug, seated in the primary TV's jack. consoleObjs maps each consoleId to
  // its physical Console so the video cord can anchor at its video-out.
  consoleObjs.set(CONSOLE_ID, consoleObj);
  addVideoPlug(CONSOLE_ID, PRIMARY_TV_ID);
  // The default gamepad (player 1) gets its grabbable controller patch-cord plug,
  // seated in console0's port-0 jack. New gamepads get theirs in addProp.
  addControllerPlug(gamepadObj);
  // The default boot gun is a cabled peripheral too: seat it in the next free port
  // (port 1, since the pad took port 0) and give it a grabbable plug + cord that
  // runs gun → port jack. Its libretro aim port is derived live from this jack.
  seatGunInFreePort(lightGunObj);
  addControllerPlug(lightGunObj);
  // The default mouse is a cabled peripheral too: seat it in the next free port and
  // give it a grabbable plug + cord that runs mouse → port jack. Its libretro mouse
  // port is derived live from this jack. grabMgr.addGrabbable was done by _registerMouse.
  seatMouseInFreePort(mouseObj);
  addControllerPlug(mouseObj);
  // The primary keyboard gets its grabbable plug and auto-connects to the primary
  // console (like the default gamepad auto-plugs into port 0).
  addKeyboardPlug(c64kbd?.object3d);
  // The keyboard body is grabbable in play mode (move it like a controller);
  // _isCandidate gates this on its visibility so it's inert while hidden.
  if (c64kbd) grabMgr.addGrabbable(c64kbd.object3d);
  connectKeyboardTo(CONSOLE_ID);
  // Item 6 — the primary console + every TV become repositionable in Move mode.
  registerMovableProp(consoleObj, 'console');
  for (const tv of scene._tvs) registerMovableProp(tv.group, 'tv');

  // Phase 5 persistence: re-create any consoles the user spawned in a previous
  // session (survives the cross-core reload too). Best-effort, fire-and-forget.
  restoreRack().catch((e) => console.warn('[main] restoreRack failed:', e));

  // Local-ROM library: re-mint shelf cartridges for every file the user ever
  // loaded via the in-app picker, so they reappear automatically after a reload.
  // Best-effort, fire-and-forget.
  restoreLocalRoms().catch((e) => console.warn('[main] restoreLocalRoms failed:', e));

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
  window.__rackMgr = rackMgr; // debug: inspect/spawn consoles + budget headlessly
  // Light-gun debug hooks: inspect the prop + manager and exercise the full
  // aim→raycast→sendLightgun chain headlessly without an XR controller. __aimGun
  // poses the gun toward a TV-relative point and forces it "held" for one tick.
  window.__lightGun = () => lightGunObj;
  window.__lightGunMgr = () => lightGunMgr;
  window.__gunTargets = () => scene._tvs.map((tv) => {
    const p = tv.mesh ? tv.mesh.getWorldPosition(new THREE.Vector3()) : null;
    return { tvId: tv.id, hasMesh: !!tv.mesh, source: cable.sourceOf(tv.id), pos: p ? { x: p.x, y: p.y, z: p.z } : null };
  });
  // Force a single manager tick with the gun held by a synthetic controller whose
  // trigger state = `trigger`. Poses the gun at `pos` aiming at `look` (world).
  // Arm-on-grab debug hooks: __armGun runs the real arm+reload path;
  // __gunArmedState reports whether the gun device is connected this boot.
  window.__armGun = () => armLightGunAndReload();
  window.__gunArmedState = () => ({ armed: !!window.__lightgunArmed, consoleArmed: _lightgunArmedConsole, system: currentMeta?.system || null, core: currentMeta?.core || null });
  // --- Mouse debug hooks (mirror the gun hooks) ---
  window.__mouse = () => mouseObj;
  window.__mouseMgr = () => mouseMgr;
  window.__armMouse = () => armMouseAndReload();
  window.__mouseArmedState = () => ({ armed: !!window.__mouseArmed, consoleArmed: _mouseArmedConsole, twoMousePorts: _twoMousePorts.slice(), system: currentMeta?.system || null });
  // Resolve the libretro mouse PORT a cabled mouse currently drives (the value
  // MouseMgr.portForMouse feeds to sendMouse). Returns null for single-mouse.
  window.__mouseLibretroPort = (cableId) => {
    const obj = _mouseObjsById.get(cableId);
    if (!obj || !mouseMgr?._portForMouse) return null;
    return mouseMgr._portForMouse(obj);
  };
  // Drive the in-world mouse one synthetic frame: feed relative motion + buttons
  // to whatever console the (default) mouse is plugged into, without an XR
  // controller. Used by the headless verifier. dx/dy in libretro pixels.
  window.__moveMouse = (dx, dy, buttons = 0) => {
    const seat = cable.portOf(mouseObj?.userData?.cableId);
    const cid = seat?.consoleId ?? CONSOLE_ID;
    const client = rackMgr.get(cid)?.client;
    if (!client) return 'no-client';
    const port = seat ? libretroMousePortFor(_mouseSlotIndex(mouseObj, cid), _twoMousePortsForConsole(cid)) : null;
    client.sendMouse(dx, dy, buttons, port);
    mouseObj?.userData?.setButtons?.(buttons & 0x3);
    return 'moved';
  };
  // Resolve the LIBRETRO gun port a cabled gun currently drives (the value the
  // LightGunMgr feeds to sendLightgun), derived live from the gun's cable jack
  // order via libretroGunPortFor(_gunSlotIndex(...), _twoGunPorts). Returns null
  // for a single-gun config, an unplugged gun, or a gun on a non-primary console.
  // Headless hook for the two-gun cable-routing verifier.
  window.__gunLibretroPort = (cableId) => {
    const obj = _lightGunObjsById.get(cableId);
    if (!obj || !lightGunMgr?._portForGun) return null;
    return lightGunMgr._portForGun(obj);
  };
  window.__gunFire = (pos, look, trigger) => {
    if (!lightGunObj || !lightGunMgr) return 'no-gun';
    lightGunObj.position.set(pos.x, pos.y, pos.z);
    // Barrel is local -Z; Object3D.lookAt points +Z at the target for non-cameras,
    // so look at the mirrored point to aim the muzzle at `look`.
    lightGunObj.lookAt(new THREE.Vector3(2 * pos.x - look.x, 2 * pos.y - look.y, 2 * pos.z - look.z));
    lightGunObj.updateMatrixWorld(true);
    const fakeCtrl = { userData: { inputSource: { gamepad: { buttons: [{ pressed: !!trigger }] } } } };
    const saved = lightGunMgr._getActiveGuns;
    lightGunMgr._getActiveGuns = () => [{ gun: lightGunObj, controller: fakeCtrl }];
    try { lightGunMgr.tick(0.016); } finally { lightGunMgr._getActiveGuns = saved; }
    return 'ticked';
  };
  // Keyboard debug hooks — exposed here (before buildMemoryCards await) so
  // headless probes can reach them even when the later stall is slow.
  window.__kbd        = c64kbd;
  window.__kbdConnect = (consoleId) => connectKeyboardTo(consoleId);
  window.__kbdTarget  = () => _kbdTargetConsoleId;
  // Phase 3 multi-TV hook: spawn a second console+TV and route video headlessly.
  // Usage: await window.__rack.spawn('nes'); window.__rack.tvs() → [{id,source}]
  window.__rack = {
    spawn: (system, opts) => spawnConsole(system, opts),
    spawnNext: () => spawnNextConsole(),
    route: () => routeVideo(),
    focus: (id) => { rackMgr.setFocus(id); rackMgr.applyBudget(); refreshAudioFocus(); return rackMgr.focusedId(); },
    focused: () => rackMgr.focusedId(),
    audio: () => audioRouter.branches.map((b) => ({ console: b.consoleId, gain: b.sink.gain.value })),
    clearSaved: () => { clearRack(); spawnedMetas.length = 0; return 'cleared'; },
    saved: () => loadRack(),
    autoPause: (on) => { if (on !== undefined) { rackMgr.setBudgetEnabled(on); saveAutoPause(on); rackMgr.applyBudget(); refreshAudioFocus(); } return rackMgr.isBudgetEnabled(); },
    live: () => rackMgr.runtimes().map((r) => ({ id: r.id, core: r.coreName, live: r.isLive() })),
    tvs: () => scene._tvs.map((t) => ({ id: t.id, source: t.sourceCanvas?.id || null, active: t.isActive() })),
    video: () => scene._tvs.map((t) => ({ tv: t.id, console: cable.sourceOf(t.id) })),
    // Phase 4: drive the video patch cord headlessly. repatch moves a console's
    // plug onto a TV's jack and releases it (exercising the real snap + rewire);
    // unpatch drops it in mid-air (pull-out). Returns the resulting routing.
    repatch: (consoleId, tvId) => {
      const rec = videoPlugs.get(consoleId); const tv = scene.getTV(tvId);
      if (!rec || !tv?.videoIn) return null;
      const p = new THREE.Vector3(); tv.videoIn.getWorldPosition(p);
      rec.plug.group.position.copy(p);
      handlePlugReleased(rec.plug.group);
      return window.__rack.video();
    },
    unpatch: (consoleId) => {
      const rec = videoPlugs.get(consoleId);
      if (!rec) return null;
      rec.plug.group.position.set(0, 0.2, 0);   // mid-air, far from any jack
      handlePlugReleased(rec.plug.group);
      return window.__rack.video();
    },
    // Item 7 — toggle the room walls headlessly.
    walls: (on) => (on === undefined ? scene.wallsVisible() : scene.setWallsVisible(on)),
    // Phase 3 power/reset — drive the REAL broadcast path headlessly (what the
    // in-world power switch / RESET button do) so smokes can confirm a peer's
    // toggle reaches the room. isOn observes the local power state.
    powerConsole: (id, on) => { setConsolePower(id, on, consoleObjs.get(id)?.userData?.powerBtn); _broadcastPower('console', id, on); return isConsoleOn(id); },
    isOn: (id) => isConsoleOn(id),
    resetConsole: (id) => { resetConsole(id); _broadcastReset(id); return true; },
    // Items 2/3 — inspect + drive the CONTROLLER patch cords. seats() reports
    // which console+port each gamepad drives (null = unplugged → drives nothing).
    seats: () => [...controllerPlugs.keys()].map((cableId) => ({ cableId, seat: cable.portOf(cableId) })),
    routing: () => computeRouting().map((r) => ({ consoleId: r.consoleId, player: r.player, hand: r.hand })),
    // Shared-gamepad debug: list all shared gamepads with their port, player,
    // and who holds them. heldBy is null when free, peerId when held remotely,
    // 'self' when held locally.
    gamepads: () => [..._gamepadObjs.entries()].map(([cableId, obj]) => {
      const seat = cable.portOf(cableId);
      const remoteHolder = ghostGpMgr?.heldBy(cableId) || null;
      let heldBy = null;
      if (remoteHolder) {
        heldBy = remoteHolder;
      } else {
        // Check if WE are holding it locally.
        for (const held of (grabMgr?.held?.values() || [])) {
          if (held === obj) { heldBy = 'self'; break; }
        }
      }
      return {
        cableId,
        port: seat?.port ?? null,
        player: seat ? (seat.port + 1) : null,
        heldBy,
      };
    }),
    // Headless: programmatically grab a gamepad by cableId (as if a VR
    // controller's squeeze fired). Simulates the net broadcast + lock.
    // Returns true if grabbed, false if already held or not found.
    grabGamepad: (cableId) => {
      const gpObj = _gamepadObjs.get(cableId);
      if (!gpObj) return false;
      if (ghostGpMgr?.isRemotelyHeld(cableId)) return false; // locked
      // Simulate the broadcast directly (no real XR controller here).
      const id = net?.presence?.selfId;
      if (net && id) net.setObjectState(makeGamepadHoldKey(cableId), { holder: id, hand: 'right' });
      return true;
    },
    // Headless: release a locally-held gamepad (clear the hold state).
    releaseGamepad: (cableId) => {
      if (net && cableId) net.setObjectState(makeGamepadHoldKey(cableId), null);
      return true;
    },
    // Headless: spawn a new shared gamepad (same as the Add-menu button).
    // In a session, broadcasts its existence to peers. Returns the cableId.
    spawnGamepad: () => {
      const prop = addProp('gamepad');
      if (!prop) return null;
      // addProp → registerGamepad assigns the cableId; find it from _gamepadObjs.
      // The last registered entry is the newly spawned one.
      const entries = [..._gamepadObjs.entries()];
      return entries[entries.length - 1]?.[0] || null;
    },
    // plugCtrl moves a gamepad's controller plug onto a console's port jack and
    // releases it (exercising the real snap + rewire). console-less call (null
    // console) drops it in mid-air → unplug. Returns the resulting seats.
    plugCtrl: (cableId, consoleId, port = 0) => {
      const rec = controllerPlugs.get(cableId);
      if (!rec) return null;
      if (consoleId) {
        const jack = consoleObjs.get(consoleId)?.userData?.portJacks?.[port];
        if (!jack) return null;
        const p = new THREE.Vector3(); jack.getWorldPosition(p);
        rec.plug.group.position.copy(p);
      } else {
        rec.plug.group.position.set(0, 0.2, 0);  // mid-air → unplug
      }
      handlePlugReleased(rec.plug.group);
      return window.__rack.seats();
    },
  };
  // Headless hook: exercise addLocalRomToShelf() with a synthetic meta entry.
  // Usage: await window.__addLocalRom({ file:'test.sfc', system:'snes', core:'snes9x', title:'Test' })
  window.__addLocalRom = (meta) => addLocalRomToShelf(meta);
  // Headless hook: exercise the ROM resolver (OPFS cache round-trip etc.).
  window.__rom = { resolve: resolveRom, cacheRom };
  // Headless hook: inspect the persisted local-ROM library.
  // Returns the current list as parsed from localStorage.
  window.__localRoms = () => loadLocalRoms();
  /**
   * Headless hook: simulate a local ROM file-pick WITHOUT the OS file-picker
   * dialog (which can't open in headless/WebXR contexts). Mirrors the logic
   * of the romInput change-handler exactly: boots the ROM, caches it in OPFS
   * (sha1), mints a shelf cartridge carrying the sha1 provenance, and returns
   * the minted cart's userData so tests can assert the round-trip.
   *
   * Usage:
   *   const bytes = new Uint8Array(1024).fill(0); // fake ROM
   *   const result = await window.__pickLocalRom('test.sfc', bytes.buffer);
   *   // result: { cart: {file, rom:{sha1,sources}}, sha1, sources }
   *
   * @param {string} name     ROM filename (used for core detection + title)
   * @param {ArrayBuffer|Uint8Array} data  ROM bytes
   * @param {object} [opts]    optional meta hints (e.g. { twoGun:true } to seat
   *                           the two-gun Justifier when armed — used by the
   *                           two-Justifier verify harness, since a picked file
   *                           has no manifest twoGun flag).
   */
  window.__pickLocalRom = async (name, data, opts = {}) => {
    const buf = data instanceof ArrayBuffer ? data : data.buffer;
    const coreInfo = detectCore(name, coreOverride);
    if (!coreInfo) throw new Error(`no core for "${name}"`);
    const system = systemForFile(name, coreOverride);
    const title = name.replace(/\.[^.]+$/, '');
    const meta = {
      file: name,
      core: coreInfo.name,
      system: system || 'unknown',
      title,
      rom: { source: 'pick' },
      ...(opts.twoGun ? { twoGun: true } : {}),
    };
    // Boot the ROM (same as romInput handler — uses the in-hand buffer).
    // inputDevices: per-port libretro device overrides (e.g. light gun on p2).
    // window.__forceInputDevices is a de-risk/test hook; coreInfo.inputDevices is
    // the per-system default once wired into systems.js.
    // Light-gun wiring (same as loadCartridge): when armed/flagged, boot the
    // gun's core with the peripheral on its port. __force* are de-risk/test hooks
    // that override the registry-derived config.
    const twoGun = _twoGunActiveFor(meta);
    const gun = (meta.lightgun || window.__lightgunArmed) ? lightgunLoadConfig(meta.system, { twoGun }) : null;
    // The gun core can differ from the cart's detected core (e.g. SMS detects as
    // picodrive but its Light Phaser is provided by genesis_plus_gx) — boot the
    // gun core in that case, mirroring loadCartridge. Falls back to coreInfo.
    const bootCore = (gun && CORES[gun.core]) ? { ...CORES[gun.core], name: gun.core } : coreInfo;
    // NES Four Score: un-gunned NES/fceumm boots connect players 3+4 as gamepads
    // so fceumm enables the multitap (P3/P4 over the serial protocol). No-op for
    // nestopia, non-NES, and gun boots. __force* test hooks still win.
    const fourScore = gun ? null : fourScoreLoadConfig(meta.system, bootCore.name);
    const inputDevices = window.__forceInputDevices || gun?.inputDevices || fourScore?.inputDevices || coreInfo.inputDevices;
    const coreOptions = window.__forceCoreOptions
      ? { ...(coreInfo.coreOptions || {}), ...window.__forceCoreOptions }
      : (gun ? { ...(coreInfo.coreOptions || {}), ...gun.coreOptions } : coreInfo.coreOptions);
    // remapName: the RA library name for the per-core remap file that connects an
    // inputDevices port override at boot.
    const remapName = window.__forceRemapName || gun?.remapName || fourScore?.remapName || coreInfo.remapName;
    logLightgunBoot('pickLocalRom', meta, gun, { forcedInputDevices: !!window.__forceInputDevices });
    await client.start(primaryCanvas(), buf, { coreUrl: bootCore.url, coreName: bootCore.name, moduleStyle: bootCore.style, contentExt: extOf(name), coreOptions, inputDevices, remapName, systemFiles: bootCore.systemFiles });
    rackMgr.get(CONSOLE_ID)?.noteLoaded(bootCore.name, { system: meta.system, title });
    currentCore = bootCore.name;
    currentMeta = { core: bootCore.name, file: meta.file, title, system: meta.system };
    gameInput?.setSystem(meta.system);
    // Cache content-addressed in OPFS so the shelf cart can re-resolve later.
    const sha1 = await cacheRom(buf);
    meta.rom = sha1 ? { sha1, sources: ['opfs', 'pick'] } : { source: 'pick' };
    _lastLoadedMeta = { ...meta };     // full meta (now OPFS-resolvable) for gun-reload
    _lightgunArmedConsole = !!gun;     // did this boot connect the gun device?
    // Two-gun co-op: record the active device's seated libretro ports (mirrors
    // loadCartridge). Per-gun routing is derived live from the cable (portForGun).
    _twoGunPorts = (gun && gun.guns?.length > 1) ? gun.guns.map((x) => x.port) : [];
    // Persist to local-ROM library (sha1 entries only, mirrors romInput handler).
    if (sha1) {
      persistLocalRom(meta);
      requestPersistentStorage();
    }
    // Mint the shelf cart (same as romInput handler).
    const cart = await addLocalRomToShelf(meta);
    return {
      cart: cart ? { file: cart.userData.file, rom: cart.userData.rom } : null,
      sha1,
      sources: meta.rom.sources || [meta.rom.source],
    };
  };
  window.__add = {
    // Basic spawners (used by headless probes + the in-VR Add-mode buttons).
    shelf:    (col) => addProp('shelf',    col ? { collection: col } : {}),
    console:  ()    => addProp('console'),
    gamepad:  ()    => addProp('gamepad'),
    keyboard: ()    => addProp('keyboard'),
    poster:   ()    => addProp('poster'),
    bookcase: (col) => addProp('bookcase', col ? { collection: col } : {}),
    cupboard: ()    => addProp('cupboard'),
    table:    ()    => addProp('table'),
    lightgun: ()    => addProp('lightgun'),
    mouse:    ()    => addProp('mouse'),
    tv:       ()    => addTvProp(),
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
  //
  // The whole block body is wrapped in _wireNetSession (a module-level closure)
  // so it can be triggered EITHER at build (?session= auto-join, net already
  // exists) OR after the world is built (in-app Join widget — connectToRoom calls
  // _wireNetSession post-build). The body captures build-local vars (cartridges,
  // editor, built.placed, ...) so it must be defined inline here. The
  // _netSessionWired guard prevents double-registering scene tick callbacks /
  // re-running within a single build.
  _netSessionWired = false; // fresh build → allow (re)wiring this session
  _wireNetSession = () => {
    if (_netSessionWired) return; // already wired this build (no double ticks)
    _netSessionWired = true;
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

    // Shared-gamepad sync: show a ghost gamepad in the remote holder's hand and
    // lock the local gamepad from being grabbed while it's held remotely.
    // Uses the `hold:gp:<cableId>` STATE namespace (same Hub auto-clear as cart holds).
    ghostGpMgr = new GhostGamepadMgr({ avatars: net.avatars, gamepadObjs: _gamepadObjs });
    scene.addTickCallback(() => {
      const presentIds = new Set(net.presence.peers().map((p) => p.id));
      // Filter entries to only gamepad holds (hold:gp:*) and parse them.
      const gpEntries = net.objects.entries().filter(([k]) => isGamepadHoldKey(k));
      // Remap objId from 'gp:<cableId>' to just '<cableId>' for GhostGamepadMgr.
      const gpHolds = parseHolds(gpEntries, { selfId: net.presence.selfId, presentIds })
        .map((h) => ({ ...h, objId: cableIdFromHoldKey(`hold:${h.objId}`) || h.objId }));
      ghostGpMgr.sync(gpHolds);
    });
    window.__ghostGp = {
      count: () => ghostGpMgr.ghostCount,
      hidden: () => ghostGpMgr.hiddenCount,
      has: (cableId) => ghostGpMgr.hasGhost(cableId),
      isHidden: (cableId) => ghostGpMgr.isHidden(cableId),
      heldBy: (cableId) => ghostGpMgr.heldBy(cableId),
      isRemotelyHeld: (cableId) => ghostGpMgr.isRemotelyHeld(cableId),
    };
    // Headless test tap for the transient WIRE channel: returns a copy of the
    // last received messages on a channel (gp/drag/reset). See _wireRxLog.
    window.__wireRx = (ch) => (_wireRxLog[ch] ? _wireRxLog[ch].slice() : []);

    // GAP 1 — Gamepad existence sync: when any peer spawns a gamepad via the
    // Add menu it broadcasts `gamepad:<id>` → { port }. Every peer (including
    // late joiners who receive the state snapshot from the server) reconciles:
    // create any gamepad it doesn't know about yet, and remove ones cleared
    // (e.g. when the spawner disconnects — Hub clears `gamepad:` keys).
    // The DEFAULT gamepad (gp-1) is ALWAYS local and never in the broadcast set.
    const DEFAULT_GAMEPAD_IDS = new Set(['gp-1']);

    // Create a peer-spawned gamepad locally from a state entry (called by the
    // reconciler when we see an id we don't have yet). `port` is the port the
    // spawner chose — we honour it so all peers agree on the player number.
    function _createRemoteGamepad(cableId, port) {
      if (_gamepadObjs.has(cableId)) return; // already exists
      // Build at port position if possible, else a default spot.
      const cu = consoleObj?.userData;
      let pos = new THREE.Vector3(0.55, 0.78, -2.0);
      const anchor = (cu?.portAnchors && port >= 0) ? cu.portAnchors[port] : null;
      if (anchor) {
        anchor.getWorldPosition(pos);
        pos.y += 0.01; // sit just above the port
      }
      const gpObj = createGamepad({ position: pos });
      gpObj.userData.cableId = cableId;
      scene.addObject(gpObj);
      registerGamepad(gpObj);
      grabMgr?.addGrabbable(gpObj);
      // Plug into the stated port — honour the spawner's assignment.
      if (port >= 0) cable.plugController(cableId, CONSOLE_ID, port);
      addControllerPlug(gpObj);
    }

    // Remove a peer-spawned gamepad (state cleared, e.g. spawner disconnected).
    function _removeRemoteGamepad(cableId) {
      const gpObj = _gamepadObjs.get(cableId);
      if (!gpObj) return;
      // Release grab if anyone is holding it.
      if (grabMgr) {
        for (const [ctrl, obj] of [...grabMgr.held]) {
          if (obj === gpObj) {
            grabMgr.held.delete(ctrl);
            scene.scene.attach(gpObj);
          }
        }
      }
      grabMgr?.removeGrabbable(gpObj);
      cable.unplugController(cableId);
      controllerPlugs.get(cableId)?.plug?.group && scene.scene.remove(controllerPlugs.get(cableId).plug.group);
      controllerPlugs.get(cableId)?.cord?.mesh && scene.scene.remove(controllerPlugs.get(cableId).cord.mesh);
      controllerPlugs.delete(cableId);
      scene.removeObject(gpObj);
      _gamepadObjs.delete(cableId);
    }

    // Apply a remote cabled peripheral's current port to the LOCAL patchbay so its
    // cord seats on the right console jack on this peer. The existence sync only
    // diffs add/remove; a peripheral that merely moved ports (a re-plug) is in
    // neither set, so without this its cord would stay drawn to the old jack.
    // Reseats the plug and recolours the cord for the new player number. Device-
    // agnostic — serves both gamepads (gamepad: sync) and light guns (gun: sync).
    function _applyRemoteCablePort(cableId, port) {
      const curPort = cable.portOf(cableId)?.port ?? -1;
      if (curPort === port) return;                  // no change
      if (port >= 0) cable.plugController(cableId, CONSOLE_ID, port);
      else cable.unplugController(cableId);
      const rec = controllerPlugs.get(cableId);
      if (rec) rec.cord.setColor?.(cordColorForPlayer((port >= 0 ? port : 0) + 1));
      seatControllerPlug(cableId);
    }

    // Install the real reconciler (replaces the no-op set at module level).
    _reconcileGamepadState = () => {
      const desired = parseGamepadEntries(net.objects.entries());
      const { toAdd, toRemove } = diffGamepadSync({
        desired,
        localIds: [..._gamepadObjs.keys()],
        defaultIds: DEFAULT_GAMEPAD_IDS,
      });
      for (const { cableId, port } of toAdd) _createRemoteGamepad(cableId, port);
      for (const cableId of toRemove) _removeRemoteGamepad(cableId);
      // Re-plug sync: reconcile port changes for pads we already have.
      for (const { cableId, port } of desired) {
        if (DEFAULT_GAMEPAD_IDS.has(cableId)) continue; // our own default pad — local only
        if (!_gamepadObjs.has(cableId)) continue;        // creation handled by toAdd
        _applyRemoteCablePort(cableId, port);
      }
    };

    // Run once immediately: catch any `gamepad:*` state that arrived before
    // buildCartridgeWorld finished (e.g. late-join snapshot).
    _reconcileGamepadState();

    // Light-gun port-binding reconciler. Port-ONLY: the gun MESH is created/removed
    // by the prop sync (a gun is a placeable prop), so here we only apply the cable
    // port from each `gun:*` entry to a gun that already exists locally. A binding
    // that arrives before its prop is skipped (the guard) and re-applied when the
    // prop lands (see _createRemoteProp's lightgun branch). The default boot gun is
    // local-only on every peer (like the default pad), so it's never remote-applied.
    _reconcileGunState = () => {
      for (const { cableId, port } of parseGunEntries(net.objects.entries())) {
        if (DEFAULT_GUN_IDS.has(cableId)) continue;     // our own default gun — local only
        if (!_lightGunObjsById.has(cableId)) continue;  // mesh created by prop sync first
        _applyRemoteCablePort(cableId, port);
      }
    };
    // Run once for any `gun:*` state already in the late-join snapshot.
    _reconcileGunState();

    // Mouse port-binding reconciler — the mouse analogue. The mouse MESH rides
    // prop:*; this seats each remote mouse at the port its mouse:<cableId> STATE
    // names (so every peer agrees which mouse drives which Amiga port/player —
    // essential for split-pointer 2-player). The default boot mouse is local-only.
    _reconcileMouseState = () => {
      for (const { cableId, port } of parseMouseEntries(net.objects.entries())) {
        if (DEFAULT_MOUSE_IDS.has(cableId)) continue;     // our own default mouse — local only
        if (!_mouseObjsById.has(cableId)) continue;       // mesh created by prop sync first
        _applyRemoteCablePort(cableId, port);
      }
    };
    _reconcileMouseState();

    // ── Prop room-layout sync (M-prop) ─────────────────────────────────────
    // When a remote peer adds a poster/console, moves a prop (onEditRelease),
    // or removes one, we receive a `prop:<id>` STATE update. The reconciler
    // below creates/moves/removes the corresponding THREE objects on this peer
    // by reusing buildProp (construct) and direct object transform (move).
    //
    // Static props (those that exist in every peer's room.json from startup)
    // get transform-only updates (toUpdate); they are NEVER created or removed
    // by this sync (they already exist on all peers). Peer-spawned props
    // (prop-<selfId>-<n>) can be created, updated, or removed.
    //
    // Disconnect policy: prop: keys are NOT auto-cleared by the Hub. Room
    // layout persists after the setter leaves (unlike hold:/gamepad: which
    // are owner-scoped). See Hub.js for the auto-clear rules.

    // Build the set of "static" prop ids — the ones every peer has from the
    // room.json — so diffPropSync never tries to remove or create them from
    // scratch (we only update their transforms). Include all placed props
    // (posters, consoles, TVs, portals, …) and the scene TVs.
    const _staticPropIds = new Set();
    for (const { prop } of built.placed) _staticPropIds.add(prop.id);
    for (const tv of scene._tvs) _staticPropIds.add(tv.id);

    // Seed the module-level _syncedProps with all static placed props.
    // (_syncedProps is declared at module level so _broadcastPropMove and
    // window.__props can access it after buildCartridgeWorld completes.)
    // Seed with all static placed props.
    for (const { prop, object } of built.placed) {
      _syncedProps.set(prop.id, { prop, object });
    }
    // Seed with built-in TV groups (TVs can be moved in the editor).
    for (const tv of scene._tvs) {
      // Create a minimal "prop descriptor" for the TV so serializePropState can
      // work with it. The id comes from SceneMgr's tv.id (e.g. 'tv0').
      const tvDesc = { type: 'tv', id: tv.id };
      _syncedProps.set(tv.id, { prop: tvDesc, object: tv.group });
    }

    // Apply a remote prop payload to a live object (move-only, no snap — the
    // sender already snapped before broadcasting).
    function _applyRemotePropTransform(object, payload) {
      if (!object || !payload) return;
      const DEG = Math.PI / 180;
      if (Array.isArray(payload.pos)) {
        object.position.set(
          payload.pos[0] ?? 0,
          payload.pos[1] ?? 0,
          payload.pos[2] ?? 0,
        );
      }
      if (Array.isArray(payload.rot)) {
        object.rotation.set(
          (payload.rot[0] ?? 0) * DEG,
          (payload.rot[1] ?? 0) * DEG,
          (payload.rot[2] ?? 0) * DEG,
        );
      }
    }

    // Create a remote-spawned prop locally from a STATE entry. Reuses the same
    // buildProp path as the local addProp, so the mesh is identical. The prop
    // descriptor is reconstructed directly from the payload (no dynamic import
    // needed — buildProp accepts any object with type/pos/rot).
    function _createRemoteProp(propId, payload) {
      if (_syncedProps.has(propId)) return; // already exists
      // Build descriptor from payload (pos/rot/type + any extras).
      const prop = {
        ...payload,
        id: propId,
        pos: Array.isArray(payload.pos) ? payload.pos : [0, 0, 0],
        rot: Array.isArray(payload.rot) ? payload.rot : [0, 0, 0],
      };
      const r = buildProp(prop, { scene, collections: currentCollections });
      if (!r) {
        console.warn(`[PropSync] buildProp failed for remote prop ${propId} (type: ${payload.type})`);
        return;
      }
      appendProp(currentRoom, prop);
      editor.registerPlaced(prop, r.object);
      _syncedProps.set(propId, { prop, object: r.object });
      _knownPropPayloads.set(propId, payload);
      // Track cartridges for shelf/bookcase so they're grabbable.
      if (r.kind === 'shelf') r.cartridges?.forEach((c) => grabMgr?.addGrabbable(c));
      if (r.kind === 'bookcase') r.cartridges?.forEach((c) => grabMgr?.addGrabbable(c));
      // A peer added a light gun → register it locally so it aims + is grabbable.
      // Adopt the peer's cableId (from the prop payload) BEFORE registering so this
      // gun lands under the SAME id its port binding (gun:<cableId> STATE) is keyed
      // by; then give it a cord plug and let _reconcileGunState seat it at the port
      // the STATE names (do NOT seat into a local free port — the port is authored
      // by the spawning peer, not chosen here).
      if (r.kind === 'lightgun') {
        if (payload.cableId != null) r.object.userData.cableId = payload.cableId;
        _registerLightGun(r.object);
        addControllerPlug(r.object);
        _reconcileGunState();
      }
      // A peer added an in-world mouse — mirror the gun path (mesh under the SAME
      // id its mouse:<cableId> port binding is keyed by; _reconcileMouseState seats it).
      if (r.kind === 'mouse') {
        if (payload.cableId != null) r.object.userData.cableId = payload.cableId;
        _registerMouse(r.object);
        addControllerPlug(r.object);
        _reconcileMouseState();
      }
      // A peer added a standalone TV → wire its patch-graph node + power switch.
      if (r.kind === 'tvset') _wireTvProp(propId, r.tv);
    }

    // Remove a remote-spawned prop (state cleared, e.g. remote peer deleted it).
    function _removeRemoteProp(propId) {
      const rec = _syncedProps.get(propId);
      if (!rec) return;
      editor.removePlaced(rec.object);
      scene.removeObject(rec.object);
      grabMgr?.removeGrabbable(rec.object);
      // Remove from room descriptor so Export Room stays clean.
      if (currentRoom?.props) {
        const i = currentRoom.props.findIndex((p) => p.id === propId);
        if (i >= 0) currentRoom.props.splice(i, 1);
      }
      _syncedProps.delete(propId);
      _knownPropPayloads.delete(propId);
    }

    // The real prop reconciler (replaces the module-level no-op stub).
    _reconcilePropState = (key, value) => {
      // Called per-key by the onObjectState path (not full-scan).
      // We also support a full re-scan (no args) for late-join snapshot.
      if (key !== undefined) {
        const propId = propIdFromStateKey(key);
        if (!propId) return;
        if (value === null) {
          // Key cleared: remove a peer-spawned prop (static props never removed).
          if (!_staticPropIds.has(propId)) _removeRemoteProp(propId);
        } else {
          const prev = _knownPropPayloads.get(propId);
          if (JSON.stringify(prev) === JSON.stringify(value)) return; // no change
          const rec = _syncedProps.get(propId);
          if (rec) {
            // Existing prop — update its transform.
            _applyRemotePropTransform(rec.object, value);
            // If poster texture changed, re-apply it.
            if (value.type === 'poster' && value.texture !== undefined && rec.prop.texture !== value.texture) {
              rec.prop.texture = value.texture;
              if (value.imageFile !== undefined) rec.prop.imageFile = value.imageFile; // FIX 3c receive
              reapplyPosterProp(rec);
            }
            _knownPropPayloads.set(propId, value);
          } else if (!_staticPropIds.has(propId)) {
            // Peer-spawned prop we don't have yet — create it.
            _createRemoteProp(propId, value);
          } else {
            // Static prop first seen in network state — update transform.
            // (The object exists from buildRoom; just not in _knownPropPayloads yet.)
            const staticRec = _syncedProps.get(propId);
            if (staticRec) {
              _applyRemotePropTransform(staticRec.object, value);
              _knownPropPayloads.set(propId, value);
            }
          }
        }
        return;
      }

      // Full re-scan (called at late-join or reconnect).
      const desired = parsePropEntries(net.objects.entries());
      const { toCreate, toUpdate, toRemove } = diffPropSync({
        desired,
        localProps: _knownPropPayloads,
        staticIds: _staticPropIds,
      });
      for (const { propId: pid, payload } of toCreate) _createRemoteProp(pid, payload);
      for (const { propId: pid, payload } of toUpdate) {
        const rec = _syncedProps.get(pid);
        if (rec) {
          _applyRemotePropTransform(rec.object, payload);
          if (payload.type === 'poster' && payload.texture !== undefined && rec.prop.texture !== payload.texture) {
            rec.prop.texture = payload.texture;
            if (payload.imageFile !== undefined) rec.prop.imageFile = payload.imageFile; // FIX 3c receive
            reapplyPosterProp(rec);
          }
          _knownPropPayloads.set(pid, payload);
        }
      }
      for (const pid of toRemove) _removeRemoteProp(pid);
    };

    // Live-drag (M2 'drag' wire): smoothly move our copy of a prop a peer is
    // actively dragging, in the gaps between the authoritative prop:* STATE
    // snapshots they send on release. Reuses the STATE transform applier with the
    // identical serializePropState payload. Skips if WE are holding the object
    // (don't fight the local hand) or if it's an id we don't have yet (the
    // release STATE will create it).
    _applyLiveDrag = (data) => {
      const rec = _syncedProps.get(data?.id);
      if (!rec?.object || !data?.payload) return;
      if (grabMgr?.isHeld?.(rec.object)) return;
      _applyRemotePropTransform(rec.object, data.payload);
    };

    // Run once immediately to reconcile any state that arrived before we built
    // the world (late-join snapshot or race between connect + buildCartridgeWorld).
    _reconcilePropState();

    // Expose props debug hook for headless smoke tests.
    window.__props = {
      // List all synced props: { propId, type, pos, rot, synced }
      list: () => [..._syncedProps.entries()].map(([id, rec]) => ({
        propId: id,
        type: rec.prop.type,
        pos: [rec.object.position.x, rec.object.position.y, rec.object.position.z],
        rot: [rec.object.rotation.x, rec.object.rotation.y, rec.object.rotation.z],
        static: _staticPropIds.has(id),
        synced: _knownPropPayloads.has(id),
        cableId: rec.object.userData?.cableId ?? null, // gun: links mesh ↔ port sync
      })),
      // Broadcast the current transform of a placed prop by its descriptor id.
      // Used headlessly to simulate a move without a VR grab/release.
      broadcastMove: (propId) => {
        const rec = _syncedProps.get(propId);
        if (!rec || !net) return false;
        net.setObjectState(makePropStateKey(propId), serializePropState(rec.prop, rec.object));
        _knownPropPayloads.set(propId, net.getObjectState(makePropStateKey(propId)));
        return true;
      },
      // Add a poster at a specific position and broadcast it (headless test helper).
      addPoster: (opts = {}) => {
        const prop = addProp('poster');
        if (!prop) return null;
        const rec = [..._syncedProps.values()].find((r) => r.prop === prop);
        if (!rec) return prop.id;
        // Move to requested position if supplied.
        if (opts.pos) rec.object.position.set(opts.pos[0] ?? 0, opts.pos[1] ?? 1.5, opts.pos[2] ?? -3.9);
        if (opts.texture) rec.prop.texture = opts.texture;
        if (net) net.setObjectState(makePropStateKey(prop.id), serializePropState(rec.prop, rec.object));
        _knownPropPayloads.set(prop.id, net?.getObjectState(makePropStateKey(prop.id)));
        return prop.id;
      },
      // Broadcast removal of a peer-spawned prop.
      removeProp: (propId) => {
        if (!net || _staticPropIds.has(propId)) return false;
        net.setObjectState(makePropStateKey(propId), null);
        _removeRemoteProp(propId);
        return true;
      },
    };
  };
  // ?session= URL auto-join path: net already exists at build → wire now, exactly
  // as before this refactor. The widget-join path wires later via connectToRoom.
  if (net) _wireNetSession();

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

  // Desktop PC-gamepad reader ([[src/DesktopGamepad.js]]) + the controller-binding
  // overlay ([[src/BindingsUI.js]]). Both share the module-level `bindings` with
  // InputMgr so a rebind takes effect on the next physical input. The gamepad
  // poller is gated on !xr.isPresenting (kept separate from the VR GameInputMgr,
  // which reads XR controllers' inputSource.gamepad). The UI releases pointer
  // lock when it opens so the cursor is usable and gameplay listeners go quiet.
  const desktopGamepad = new DesktopGamepad({ renderer: scene.renderer, client, bindings });
  onPrimaryClientChange((c) => { desktopGamepad.client = c; });
  scene.addTickCallback(() => desktopGamepad.tick());
  const bindingsUI = new BindingsUI({
    bindings,
    renderer: scene.renderer,
    exitPointerLock: () => { try { document.exitPointerLock?.(); } catch (_) {} },
    player: 1,
  });
  window.__bindings = {
    model: bindings,
    ui: bindingsUI.debugApi(),
    gamepad: desktopGamepad.debugApi(),
    // The keyboard InputMgr attaches on core `ready` in production (see the
    // client 'ready' handler). Expose attach() so the headless harness can drive
    // the keyboard path without booting a real core.
    attachKeyboard: () => input.attach(window),
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
    // Console-aware dispatch: a controller plugged into console N drives console
    // N's own core (canvas-targeted via its ConsoleRuntime). defaultConsoleId is
    // the primary so the single-console path is unchanged. The N=1 client path
    // remains the fallback inside GameInputMgr when no dispatch is supplied; here
    // we always supply one so spawned consoles are playable too.
    dispatch: (consoleId, type, code, key, keyCode, location) =>
      rackMgr.get(consoleId)?.sendInput(type, code, key, keyCode, location),
    defaultConsoleId: CONSOLE_ID,
    // LED pulse for every emulator keydown — visible in-VR feedback that
    // gamepad input is reaching the core. Pulses the console that actually
    // received the input. Also forward to the Now Playing panel.
    onKeyDown: (code, consoleId) => {
      (consoleObjs.get(consoleId) || consoleObj)?.userData?.pulse?.(0xffffff, 90);
      nowPlayingPanel?.userData.notifyInput(code);
      logger.event('input', { code, console: consoleId });
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
  scene.addTickCallback((dt) => lightGunMgr.tick(dt));
  scene.addTickCallback((dt) => mouseMgr.tick(dt));
  scene.addTickCallback(() => syncControllerCords());
  scene.addTickCallback(() => syncVideoCords());
  scene.addTickCallback(() => syncKeyboardCord());
  scene.addTickCallback(() => updateFocus());
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
  // hand wins, else free hand. Drives whichever pad is ACTUALLY held (not just
  // the default one) so interactions show on the right pad, and broadcasts that
  // pad's live button state over the 'gp' wire channel so peers animate its ghost.
  let _lastGpWireSig = '';
  scene.addTickCallback(() => {
    const s = gameInput.getDebugState();
    if (!s) {
      // Nothing held → clear every local pad's visual (also cleans up the pad
      // just released so its buttons don't stay lit).
      for (const o of _gamepadObjs.values()) o.userData.setInput?.({});
      gamepadObj.userData.setInput?.({});
      _lastGpWireSig = '';
      return;
    }
    const h = s.holding, f = s.free;
    const or = (i) => !!(h?.buttons[i]?.pressed) || !!(f?.buttons[i]?.pressed);
    const axRaw = (i) => (h?.axes[i] ?? 0) || (f?.axes[i] ?? 0);
    // Bucket axes to -1/0/1 at the same threshold the pad visual uses, so analog
    // jitter doesn't spam the wire — we only send on a meaningful change.
    const bucket = (v) => (v <= -0.4 ? -1 : v >= 0.4 ? 1 : 0);
    const input = {
      a:      or(0),  // trigger
      b:      or(4),  // face A/X
      start:  or(5),  // face B/Y
      select: or(3),  // stick click
      axisX:  bucket(axRaw(2)),
      axisY:  bucket(axRaw(3)),
    };
    // Which local pad is actually in a hand? Drive THAT one (the long-standing
    // "interactions show on the same pad" bug was driving only the default).
    let heldPad = null;
    for (const ctrl of scene.controllers) {
      const o = grabMgr.heldObject?.(ctrl);
      if (o?.userData?.kind === 'gamepad') { heldPad = o; break; }
    }
    (heldPad || gamepadObj).userData.setInput?.(input);
    // Broadcast the held pad's button state to the room (on change only).
    const cableId = heldPad?.userData?.cableId;
    if (net && cableId) {
      const sig = cableId + JSON.stringify(input);
      if (sig !== _lastGpWireSig) { _lastGpWireSig = sig; net.sendWire('gp', { cableId, ...input }); }
    } else if (_lastGpWireSig) {
      _lastGpWireSig = '';
    }
  });

  // Live-drag broadcast (M2 'drag' wire): while a prop is held locally, stream its
  // in-flight transform ~20 Hz so peers see it glide rather than teleport on
  // release. The authoritative final pose still rides the prop:* STATE snapshot
  // that _broadcastPropMove sends on release. On-change only (a still hand sends
  // nothing). Uses the SAME serializePropState payload the STATE channel uses, so
  // the receiver reuses _applyRemotePropTransform.
  {
    let _dragAcc = 0;
    const _lastDragSig = new Map(); // propId -> last sent payload signature
    scene.addTickCallback((dtMs) => {
      if (!net) return;
      _dragAcc += (Number.isFinite(dtMs) ? dtMs : 16);
      if (_dragAcc < 50) return;     // ~20 Hz cap
      _dragAcc = 0;
      const seen = new Set();
      for (const ctrl of scene.controllers) {
        const o = grabMgr?.heldObject?.(ctrl);
        const prop = o?.userData?.roomProp;
        if (!prop?.id || seen.has(prop.id)) continue;
        seen.add(prop.id);
        const payload = serializePropState(prop, o);
        const sig = JSON.stringify(payload);
        if (_lastDragSig.get(prop.id) === sig) continue;  // not moving → don't spam
        _lastDragSig.set(prop.id, sig);
        net.sendWire('drag', { id: prop.id, payload });
      }
      // Drop signatures for props no longer held so a re-grab re-sends fresh.
      if (seen.size === 0 && _lastDragSig.size) _lastDragSig.clear();
    });
  }

  activePortals = built.portals; // Phase E.3: addPortal() appends to this live list
  buildMenuAndControlsPanel();
  installPortals();

  window.__locomotion = locomotion;
  // gameInput dispatches per-console via rackMgr (live-aware); its `client` is
  // only an N=1 fallback, but keep it on the live primary client for consistency.
  onPrimaryClientChange((c) => { gameInput.client = c; });
  window.__gameInput = gameInput;
  window.__room = room;

  // FIX 3d: Fire-and-forget load-time re-resolution of imageFile poster props.
  // Blob: URLs die on reload; if a poster has imageFile set, re-resolve it from
  // the granted images folder (if any). Silently skip if the folder isn't granted
  // or the file isn't found — the poster keeps its saved flat colour.
  (async () => {
    const posterRecs = [..._syncedProps.values()].filter(
      (r) => r.prop.type === 'poster' && r.prop.imageFile &&
             (!r.prop.texture || r.prop.texture.startsWith('blob:')),
    );
    if (!posterRecs.length) return;
    let images;
    try { images = await listImages(); } catch { return; }
    if (!images.length) return;
    for (const rec of posterRecs) {
      const entry = images.find((e) => e.name === rec.prop.imageFile);
      if (!entry) continue;
      try {
        const url = await entryObjectUrl(entry);
        rec.prop.texture = url;
        reapplyPosterProp(rec);
      } catch { /* silently skip */ }
    }
  })();

  // Restore the light-gun arm across a page reload (gun stays "out" for the
  // session) BEFORE the resume so the bridged game boots with the gun device.
  try { if (sessionStorage.getItem(LIGHTGUN_ARM_KEY)) window.__lightgunArmed = true; }
  catch (_) { /* sessionStorage unavailable */ }
  // Same for the mouse arm: the in-world mouse stays "out" across a reload.
  try { if (sessionStorage.getItem(MOUSE_ARM_KEY)) window.__mouseArmed = true; }
  catch (_) { /* sessionStorage unavailable */ }

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

  // Item 5 — placeInRoom ([[src/Placement.js]]) does the snap+clamp in the
  // CORRECT order: a wall prop (poster) is snapped to the actual wall plane FIRST
  // and only its tangential axis clamped, so it can never land inside/behind the
  // wall (the old clamp-then-snap order pushed posters off the wall by the
  // margin). Floor props get their resting Y and are kept inside the walls.
  const bounds = scene.getRoomBounds();
  const { pos: snapped, yaw: wallYaw } = placeInRoom({ x: p.x, y: p.y, z: p.z }, bounds, type || 'shelf');

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
    // In a session, assign a globally-unique cableId BEFORE registerGamepad
    // so all peers agree on the id (and therefore the player number).
    if (net) {
      const selfId = net.presence.selfId || 'local';
      r.object.userData.cableId = makePeerGamepadId(selfId, ++_peerGamepadCounter);
    }
    registerGamepad(r.object);
    grabMgr.addGrabbable(r.object);
    const port = seatGamepadInFreePort(r.object);
    // Give the new pad its grabbable controller patch-cord plug (seated at the
    // port it just took, or dangling if none was free — repatch via the plug).
    addControllerPlug(r.object);
    // In a session, broadcast this gamepad's existence so all peers create it
    // too (with the same id and the same port→player mapping).
    if (net && r.object.userData.cableId) {
      net.setObjectState(
        makeGamepadStateKey(r.object.userData.cableId),
        { port: port ?? -1 },
      );
    }
    setStatus(port == null ? 'added gamepad (no free port — drag its plug to a port)' : `added gamepad → player ${port + 1}`);
    return prop;
  }

  // A new keyboard prop: wire sendInput to the primary console (or nearest if
  // a consoleId is given in opts), make it editable-grabbable in edit mode.
  if (r.kind === 'keyboard') {
    const targetId = opts.consoleId || _kbdTargetConsoleId || CONSOLE_ID;
    if (r.keyboard) {
      r.keyboard.setSendInput((type, code, key, keyCode, location) =>
        rackMgr.get(targetId)?.sendInput(type, code, key, keyCode, location));
    }
    // Fall through to the normal ensureEditMode / broadcast path below.
  }

  // A new light gun: give it a cable identity, register it (aims + arms gun games
  // on pickup, becomes the 2nd gun for co-op), seat it in the next free port, and
  // give it a grabbable patch-cord plug — mirroring the gamepad lifecycle. Unlike
  // the gamepad path it does NOT early-return: it falls through to the prop:*
  // broadcast so peers still create the gun MESH (the gun: channel carries only the
  // port binding). The cableId is stamped on the descriptor so it rides prop sync.
  if (r.kind === 'lightgun') {
    // In a session, assign a globally-unique cableId BEFORE registering so all
    // peers agree on the id (and therefore which gun drives which player).
    if (net) {
      const selfId = net.presence.selfId || 'local';
      r.object.userData.cableId = makePeerGunId(selfId, ++_peerGunCounter);
    }
    _registerLightGun(r.object);
    const gunPort = seatGunInFreePort(r.object);
    addControllerPlug(r.object);
    // Carry the cableId on the descriptor so serializePropState ships it to peers.
    prop.cableId = r.object.userData.cableId;
    // Broadcast the port binding on the dedicated gun: channel (mesh rides prop:*).
    if (net && r.object.userData.cableId) {
      net.setObjectState(
        makeGunStateKey(r.object.userData.cableId),
        { port: gunPort ?? -1 },
      );
    }
  }

  // A new in-world mouse — mirrors the light-gun lifecycle. A 2nd mouse gives
  // split-pointer 2-player. Falls through to the prop:* broadcast (mesh rides
  // prop:*; the mouse: channel carries only the port binding).
  if (r.kind === 'mouse') {
    if (net) {
      const selfId = net.presence.selfId || 'local';
      r.object.userData.cableId = makePeerMouseId(selfId, ++_peerMouseCounter);
    }
    _registerMouse(r.object);
    const mousePort = seatMouseInFreePort(r.object);
    addControllerPlug(r.object);
    prop.cableId = r.object.userData.cableId;
    if (net && r.object.userData.cableId) {
      net.setObjectState(makeMouseStateKey(r.object.userData.cableId), { port: mousePort ?? -1 });
    }
  }

  ensureEditMode();
  setStatus(`added ${type} — grab to place`);

  // Prop room-layout sync (M-prop): broadcast the new prop's existence so
  // remote peers can create it on their side. We use the prop's descriptor id
  // which is unique (PropCreator.uniqueId). In a session, assign a peer-scoped
  // id BEFORE broadcasting so all peers agree on the id. (This overrides the
  // sequential id PropCreator minted — that's fine since the room descriptor on
  // this peer uses the updated id too.)
  if (net) {
    const selfId = net.presence.selfId || 'local';
    const peerPropId = makePeerPropId(selfId, ++_peerPropCounter);
    // Update the descriptor and the room entry (PropCreator already appended it
    // above with the sequential id; we rename it to the peer-scoped id).
    const oldId = prop.id;
    prop.id = peerPropId;
    // Fix up the room.props entry (appendProp already pushed prop by reference,
    // so mutating prop.id is sufficient for the in-place entry).
    // Update the placed record's userData too (editor.registerPlaced was called
    // with prop by reference — it stored prop directly, so the id is live).
    if (r.object.userData.roomProp && r.object.userData.roomProp.id === oldId) {
      r.object.userData.roomProp.id = peerPropId;
    }
    _broadcastPropMove(r.object);
  }

  return prop;
}

// Wire a freshly-built standalone TV (the 'tvset' prop) into the patch graph +
// controls so it behaves like a built-in TV: a Patchbay sink you can patch a
// console's video-out into, a power switch, and movable in Move mode. Shared by
// the local add and the remote-create paths.
function _wireTvProp(tvId, tv) {
  if (!tv) return;
  cable.addTV(tvId);                         // patch-graph sink (idle until wired)
  addTvControls(tvId, tv);                   // power switch
  registerMovableProp(tv.group, 'tv');       // grabbable in Move mode
  routeVideo();                              // render it (idle) immediately
}

// Add a standalone TV in front of the player. Bypasses the generic addProp so the
// peer-scoped id is assigned BEFORE buildProp (the scene TV node is keyed by the
// prop id, so all peers must agree on it before the TV is created). Syncs creation
// + transform via the prop:* STATE channel like other added props.
function addTvProp() {
  if (!editor || !currentRoom) return null;
  const t = spawnTransform('tvset');
  const prop = createProp(currentRoom, 'tvset', t);
  if (!prop) { setStatus("can't add TV"); return null; }
  // Peer-scoped id up front (see above) so the TV node id matches across peers.
  if (net) { const selfId = net.presence.selfId || 'local'; prop.id = makePeerPropId(selfId, ++_peerPropCounter); }
  const r = buildProp(prop, { scene, collections: currentCollections });
  if (!r || r.kind !== 'tvset') { setStatus('add TV failed'); return null; }
  appendProp(currentRoom, prop);
  editor.registerPlaced(prop, r.object);
  _syncedProps.set(prop.id, { prop, object: r.object });
  _wireTvProp(prop.id, r.tv);
  ensureEditMode();
  setStatus('added TV — grab to place; patch a console into it to show a game');
  if (net) {
    _knownPropPayloads.set(prop.id, serializePropState(prop, r.object));
    _broadcastPropMove(r.object);
  }
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

// Plug a light gun into the lowest free, enabled console port. Unlike a gamepad,
// the gun's MESH is NOT moved onto the port seat (you hold the gun; only its plug
// seats in the jack — the cord runs gun.cordAnchor → plug). Returns the port index,
// or null if all ports are taken (then its plug dangles until repatched by hand).
function seatGunInFreePort(obj) {
  const cu = consoleObj?.userData;
  const port = cable.firstFreePort(CONSOLE_ID, cu?.activePorts);
  if (port == null) return null;
  cable.plugController(obj.userData.cableId, CONSOLE_ID, port);
  return port;
}

// Plug a mouse into the lowest free, enabled console port (like seatGunInFreePort).
// The mouse is held; only its plug seats in the jack, with the cord running
// mouse.cordAnchor → plug. Returns the port index, or null if all ports are taken.
function seatMouseInFreePort(obj) {
  const cu = consoleObj?.userData;
  const port = cable.firstFreePort(CONSOLE_ID, cu?.activePorts);
  if (port == null) return null;
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
  const col = (prop.collection && currentCollections.byKey.get(prop.collection)) || currentCollections.list[0];
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
      const cart = createMedia(games[gameIdx++]);
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

  menuMgr = new MenuMgr({
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
      // Index 10: rack auto-pause toggle. Added unconditionally right after the
      // mode buttons so indices 0-9 (destructured below) are unaffected.
      { label: 'Auto-pause: On', onActivate: () => {} },
      // Index 11: hide/show the room walls (open up the space for a big rack).
      { label: 'Walls: On', onActivate: () => {} },
      // M0 hardening: in-VR voice toggle (the 🎤 header button is desktop-only).
      // Appended after the rack toggles and only in a networked session (idx 12).
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
  const rackPauseBtn = menu.userData.buttons[10];
  const wallsBtn = menu.userData.buttons[11];
  const vrVoiceBtn = net ? menu.userData.buttons[12] : null;
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
    rec.prop.imageFile = entry.name; // FIX 3a: persist source filename for reload re-resolution
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
    { label: 'Spawn Console', onActivate: () => spawnNextConsole() },
    { label: 'Add Gamepad',  onActivate: () => addProp('gamepad') },
    { label: 'Add Poster',   onActivate: () => addProp('poster') },
    { label: 'Add TV',       onActivate: () => addTvProp() },
    { label: 'Add Light Gun', onActivate: () => addProp('lightgun') },
    { label: 'Add Mouse',    onActivate: () => addProp('mouse') },
    { label: 'Add Portal',   onActivate: () => addPortal() },
    // Persist the current layout as the default that auto-loads next session
    // (same localStorage slot resolveWorld() reads), without the file download
    // that 'Export Room' triggers. 'Reset to Built-in' clears it again.
    { label: 'Save as Default Room', onActivate: () => {
      try { saveLastRoom(JSON.stringify(editor.serialize())); setStatus('saved current room as the default layout'); }
      catch (e) { setStatus('save-as-default failed'); console.warn('[room] save-as-default', e); }
    } },
    { label: 'Reset to Built-in', onActivate: () => {
      clearLastRoom(); setStatus('default cleared — built-in room loads next session');
    } },
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

  // Rack auto-pause toggle: ON = gaze/budget pauses unfocused cores (with >1
  // console) to protect the framerate; OFF = keep every core live (powerful PC).
  const syncRackPauseLabel = () => rackPauseBtn.setLabel(rackMgr.isBudgetEnabled() ? 'Auto-pause: On' : 'Auto-pause: Off');
  rackPauseBtn.onActivate = () => {
    const on = rackMgr.setBudgetEnabled(!rackMgr.isBudgetEnabled());
    saveAutoPause(on);
    rackMgr.applyBudget();          // resume everything (off) or re-apply (on)
    refreshAudioFocus();
    syncRackPauseLabel();
    setStatus(on ? 'Idle cores auto-pause to save performance' : 'All cores stay live');
  };
  syncRackPauseLabel();             // reflect the persisted setting on the button

  // Walls toggle: hide the room shell so a multi-console rack isn't boxed in (and
  // so any prop that lands near a wall stays visible). Floor stays put.
  wallsBtn.onActivate = () => {
    const on = scene.setWallsVisible(!scene.wallsVisible());
    wallsBtn.setLabel(on ? 'Walls: On' : 'Walls: Off');
    setStatus(on ? 'Walls shown' : 'Walls hidden');
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

  // Power/reset switches on the primary console + TV (now that menuMgr exists).
  // Spawned consoles get theirs in spawnConsole().
  addConsoleControls(CONSOLE_ID, consoleObjs.get(CONSOLE_ID));
  addTvControls(PRIMARY_TV_ID, scene.getTV(PRIMARY_TV_ID));

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

  // Gamepad button click-to-test: point a controller at any virtual gamepad's
  // buttons and pull the trigger to drive that pad's port — so you can test two
  // different controllers/ports without physically grabbing each one. Mirrors the
  // keyboard raycast above (separate Raycaster; gated on no pad being held so an
  // in-game trigger press doesn't also click buttons).
  {
    const _gpRay = new THREE.Raycaster();
    const _gpOrigin = new THREE.Vector3();
    const _gpQuat = new THREE.Quaternion();
    const _gpDir = new THREE.Vector3();
    // Logical gamepad-button id → RetroPad button name for setRemoteButton.
    const GP_BTN = { a: 'A', b: 'B', start: 'Start', select: 'Select', up: 'Up', down: 'Down', left: 'Left', right: 'Right' };
    const _gpHover = new Map(); // ctrl → { gpObj, id }   (button currently under the laser)
    const _gpHeld  = new Map(); // ctrl → { gpObj, id, player, btn, consoleId } (button being clicked)

    // Walk up from a hit cap mesh to its gamepad root (the object registered in
    // _gamepadObjs under its cableId).
    const gpObjForMesh = (mesh) => {
      let o = mesh;
      while (o) {
        const cid = o.userData?.cableId;
        if (cid && _gamepadObjs.get(cid) === o) return o;
        o = o.parent;
      }
      return null;
    };
    const clearHover = (ctrl) => {
      const h = _gpHover.get(ctrl);
      if (h) { h.gpObj.userData.hoverButton?.(h.id, false); _gpHover.delete(ctrl); }
    };

    scene.addTickCallback(() => {
      if (_gamepadObjs.size === 0) return;
      // A held pad means its trigger is driving the game — don't also click.
      if (grabMgr?.isGamepadHeld?.()) { for (const c of scene.controllers) clearHover(c); return; }
      const meshes = [];
      for (const obj of _gamepadObjs.values()) {
        if (!obj.visible) continue;
        const cm = obj.userData.clickMeshes;
        if (cm) for (const m of cm) meshes.push(m);
      }
      if (meshes.length === 0) { for (const c of scene.controllers) clearHover(c); return; }
      for (const ctrl of scene.controllers) {
        ctrl.updateMatrixWorld();
        _gpOrigin.setFromMatrixPosition(ctrl.matrixWorld);
        ctrl.getWorldQuaternion(_gpQuat);
        _gpDir.set(0, 0, -1).applyQuaternion(_gpQuat).normalize();
        _gpRay.set(_gpOrigin, _gpDir);
        _gpRay.far = 8.0;
        const hits = _gpRay.intersectObjects(meshes, false);
        const hit = hits.length ? hits[0] : null;
        const id = hit?.object?.userData?.gpButton || null;
        const gpObj = hit ? gpObjForMesh(hit.object) : null;
        const prev = _gpHover.get(ctrl);
        if (!id || !gpObj) { clearHover(ctrl); continue; }
        if (!prev || prev.gpObj !== gpObj || prev.id !== id) {
          if (prev) prev.gpObj.userData.hoverButton?.(prev.id, false);
          gpObj.userData.hoverButton?.(id, true);
          _gpHover.set(ctrl, { gpObj, id });
        }
      }
    });

    for (const ctrl of scene.controllers) {
      ctrl.addEventListener('selectstart', () => {
        if (grabMgr?.isGamepadHeld?.()) return;
        const h = _gpHover.get(ctrl);
        if (!h) return;                          // not pointing at a button → don't consume
        const btn = GP_BTN[h.id];
        if (!btn) return;
        const seat = cable.portOf(h.gpObj.userData.cableId); // { consoleId, port } | null
        const player = (seat?.port ?? 0) + 1;
        const consoleId = seat?.consoleId || CONSOLE_ID;
        h.gpObj.userData.pressButton?.(h.id, true);
        gameInput?.setRemoteButton?.({ player, btn, down: true, consoleId });
        _gpHeld.set(ctrl, { gpObj: h.gpObj, id: h.id, player, btn, consoleId });
      });
      ctrl.addEventListener('selectend', () => {
        const held = _gpHeld.get(ctrl);
        if (!held) return;
        _gpHeld.delete(ctrl);
        held.gpObj.userData.pressButton?.(held.id, false);
        gameInput?.setRemoteButton?.({ player: held.player, btn: held.btn, down: false, consoleId: held.consoleId });
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
// Set once the light gun has been picked up; survives the arm page-reload and
// keeps later gun-capable boots armed for the rest of the session.
const LIGHTGUN_ARM_KEY = 'libretrowebxr.lightgun';
const MOUSE_ARM_KEY = 'libretrowebxr.mouse';

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
  // Multi-console rack: a cartridge dropped into a SECONDARY console boots into
  // that console's own runtime (own canvas + core) and shows on its own TV via
  // the patch graph. Pre-fix every load hit the primary client/emuCanvas, so the
  // 2nd console could never be targeted and a load hijacked the main TV. The
  // primary console (CONSOLE_ID) keeps the established path below (same-core
  // hot-swap / different-core page reload, room broadcast, resume bridge).
  if (meta.consoleId && meta.consoleId !== CONSOLE_ID) {
    loadCartridgeIntoConsole(meta.consoleId, meta);
    return;
  }
  // Same-core swap: keep the page, just feed the new ROM. Different core:
  // full page reload (libretro cores can't cleanly unload — they pin globals
  // on the window and own a WebGL context that survives even after callMain
  // returns). sessionStorage preserves the chosen ROM across the reload.
  if (currentCore && currentCore !== meta.core) {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({
      file: meta.file, core: meta.core, system: meta.system, title: meta.title,
      // Preserve ROM provenance across the reload so a picked/local cart
      // re-resolves from its OPFS cache (sha1) rather than a 404ing url fetch.
      rom: meta.rom,
      // Preserve the light-gun flags too. A cross-core swap into a gun game
      // (e.g. NES/nestopia → SNES/snes9x) reloads the page, and loadCartridge
      // only connects the gun device when meta.lightgun (or a session-armed gun)
      // is set. Dropping them here booted the gun game with NO gun device — the
      // game saw only the regular controller. twoGun keeps the Justifier co-op
      // boot (Lethal Enforcers) across the same reload.
      lightgun: meta.lightgun, twoGun: meta.twoGun, gunDevice: meta.gunDevice,
    }));
    // Goal A: serialize the live room and bridge it across the reload so any
    // in-VR edits (moved shelves, added props, env changes) are not lost.
    if (editor) {
      try { stashRoomBridge(JSON.stringify(editor.serialize())); }
      catch (e) { console.warn('[main] room bridge stash failed:', e); }
    }
    // Keep the session (and host role) alive across the reload — a widget-joined
    // room has no ?session in the URL to auto-rejoin from.
    stashSessionRejoin();
    // Telemetry: the cross-core reload is otherwise invisible in the remote log
    // (the page restarts), yet it's exactly the path that used to drop the gun
    // flags. Record it (and that they're now preserved) so a gun game booted via
    // a core swap is diagnosable. Flushed keepalive across the reload.
    logger?.event?.('boot-reload', { file: meta.file, fromCore: currentCore, toCore: meta.core, lightgun: !!meta.lightgun, twoGun: !!meta.twoGun });
    setStatus(`switching to ${meta.title}…`);
    location.reload();
    return;
  }
  loadCartridge(meta, { echo });
}

// Light-gun arming: picking up the gun connects the gun device. A libretro
// peripheral attaches ONLY at a fresh core boot. Historically the primary console
// owned the singleton #canvas and couldn't re-boot in place, so this did a full
// location.reload() — jarring, and it ENDED any immersive XR session and dropped
// the net session. Now we re-boot the SAME game LIVE: rebootPrimaryConsole stands
// up a fresh runtime (own canvas + client) for CONSOLE_ID with the gun device on,
// retires the old one, and re-points every singleton consumer — no page navigation,
// so the XR session and the room/host role survive untouched. A persisted session
// flag keeps every LATER boot armed (the gun is out). Picking up the gun with no
// gun-capable game running just sets the flag so the next gun-capable game boots
// armed. Falls back to the old reload bridge if the live reboot throws, so arming
// never hard-fails.
async function armLightGunAndReload() {
  try { sessionStorage.setItem(LIGHTGUN_ARM_KEY, '1'); } catch (_) {}
  window.__lightgunArmed = true;                 // arm future gun-capable boots
  if (_lightgunArmedConsole) return;             // current game already has the gun
  const sys = currentMeta?.system;
  if (!sys || !isLightgunCapable(sys) || !_lastLoadedMeta) return;
  const lg = lightgunForSystem(sys);
  // A light gun occupies a controller port (player = port + 1). When that port
  // already drives a gamepad — e.g. the SMS Light Phaser on port 0 / player 1 —
  // the gun supersedes the pad on that port while armed, matching real hardware
  // (the gun plugs into a controller socket). Say so plainly. Other ports keep
  // their pads (NES Zapper / SNES Super Scope / MD Menacer all sit on port 1).
  const player = (lg?.port ?? 0) + 1;
  const padSuperseded = !!cable.occupantOf?.(CONSOLE_ID, lg?.port ?? -1);
  setStatus(padSuperseded
    ? `connecting ${lg?.label || 'light gun'} on player ${player} (replaces that gamepad)…`
    : `connecting ${lg?.label || 'light gun'} on player ${player}…`);
  const m = _lastLoadedMeta;
  // Build the SAME gun boot config the load path uses, so the fresh boot seats the
  // device on the right port(s). twoGun seats two guns on two-gun-capable games.
  const twoGun = _twoGunActiveFor(m);
  const gun = lightgunLoadConfig(m.system, { twoGun });
  logger?.event?.('lightgun-arm-reboot', { system: sys, gun: lg?.label || null, file: m.file, core: m.core, title: m.title, twoGun: !!(gun && gun.guns?.length > 1) });
  try {
    // LIVE reboot: re-boot the same ROM with the gun device attached, no reload.
    await rebootPrimaryConsole(m, gun);
    // Snap the matching cart back into the slot (the runtime swap doesn't touch
    // the visual cart state, but keep parity with the reload path's resume).
    const cart = cartridges.find((c) => c.userData.file === m.file);
    if (cart && grabMgr) grabMgr.setInsertedCart(cart);
    setStatus(`${lg?.label || 'light gun'} connected`);
  } catch (e) {
    // Fallback: the old reload bridge so arming never hard-fails. Bridges the SAME
    // game across a page reload with the gun flagged on (preserving ROM provenance
    // + in-VR room edits + the net session/host role).
    console.warn('[lightgun] live arm failed, falling back to reload:', e);
    logger?.event?.('lightgun-arm-reboot-fallback', { error: String(e?.message || e) });
    try {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({
        file: m.file, core: m.core, system: m.system, title: m.title, rom: m.rom, lightgun: true,
      }));
      if (editor) {
        try { stashRoomBridge(JSON.stringify(editor.serialize())); }
        catch (e2) { console.warn('[main] room bridge stash failed:', e2); }
      }
      stashSessionRejoin();
      location.reload();
    } catch (e2) {
      console.warn('[lightgun] arm reload fallback failed:', e2);
      setStatus('could not connect the light gun');
    }
  }
}

// Mouse arming: picking up the in-world mouse connects the libretro MOUSE device.
// Mirrors armLightGunAndReload — a libretro peripheral attaches only at a fresh
// boot, so we LIVE-reboot the same game with the mouse device on (XR + net session
// survive). A persisted session flag keeps later mouse-capable boots armed. Picking
// up the mouse with no mouse-capable game running just sets the flag for next time.
async function armMouseAndReload() {
  try { sessionStorage.setItem(MOUSE_ARM_KEY, '1'); } catch (_) {}
  window.__mouseArmed = true;                  // arm future mouse-capable boots
  if (_mouseArmedConsole) return;              // current game already has the mouse
  const sys = currentMeta?.system;
  if (!sys || !isMouseCapable(sys) || !_lastLoadedMeta) return;
  const m = _lastLoadedMeta;
  // Build the SAME mouse boot config the load path uses. A twoMouse game on a
  // two-mouse-capable system (Amiga) seats a mouse on both ports (split-pointer).
  const twoMouse = !!m.twoMouse && isTwoMouseCapable(m.system);
  const mouse = mouseLoadConfig(m.system, { twoMouse });
  if (!mouse) return;
  // Seat the default mouse on its libretro port (Amiga mouse = port 0 / player 1),
  // superseding whatever sat there, so the cable jack order matches the device's
  // port and (for the patched two-mouse path) the 2nd mouse can take port 1. The
  // single-mouse DOM path drives the console regardless of seat, but seating keeps
  // the in-world cord + port-sync coherent. Best-effort.
  try {
    const port0 = mouse.mice?.[0]?.port ?? 0;
    cable.plugController(mouseObj.userData.cableId, CONSOLE_ID, port0);
    seatControllerPlug(mouseObj.userData.cableId);
    _broadcastCablePort(mouseObj.userData.cableId);
  } catch (_) {}
  setStatus(`connecting mouse${twoMouse ? ' (2-player)' : ''}…`);
  logger?.event?.('mouse-arm-reboot', { system: sys, file: m.file, core: m.core, title: m.title, twoMouse: !!(mouse && mouse.mice?.length > 1) });
  try {
    await rebootPrimaryConsole(m, null, mouse);
    const cart = cartridges.find((c) => c.userData.file === m.file);
    if (cart && grabMgr) grabMgr.setInsertedCart(cart);
    setStatus('mouse connected');
  } catch (e) {
    console.warn('[mouse] live arm failed, falling back to reload:', e);
    logger?.event?.('mouse-arm-reboot-fallback', { error: String(e?.message || e) });
    try {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({
        file: m.file, core: m.core, system: m.system, title: m.title, rom: m.rom, mouse: true, twoMouse: m.twoMouse || false,
      }));
      if (editor) { try { stashRoomBridge(JSON.stringify(editor.serialize())); } catch (_) {} }
      stashSessionRejoin();
      location.reload();
    } catch (e2) {
      console.warn('[mouse] arm reload fallback failed:', e2);
      setStatus('could not connect the mouse');
    }
  }
}

async function loadCartridge(meta, { echo = true } = {}) {
  setStatus(`loading ${meta.title}…`);
  // Boot telemetry (diagnoses headset boot failures): how the ROM resolves +
  // whether the OPFS cache is even available on this device, logged BEFORE the
  // attempt so a crash/hang still leaves a breadcrumb. See [[src/RomResolver.js]].
  logger?.event?.('boot-attempt', {
    file: meta.file, system: meta.system, core: meta.core,
    plan: resolutionPlan(meta), opfs: opfsSupported(),
  });
  try {
    // RomResolver (Phase R.2) turns the entry into bytes from url / local
    // folder / picker / OPFS cache, per its rom.source (default: url).
    const buf = await resolveRom(meta);
    // Light-gun wiring: when this load is gun-enabled (the game is flagged, or a
    // gun has been armed for this session), boot the gun's (patched) core with the
    // peripheral assigned to its port — the device only connects at boot, so it
    // must be present in this client.start(). lightgunLoadConfig picks the gun
    // core, which may differ from meta.core (e.g. SMS → genesis_plus_gx).
    // Two-gun co-op: a twoGun-flagged game on a two-gun-capable system seats TWO
    // gun devices (Justifier 516/772 on ports 1+2) so each VR gun drives its own
    // per-port aim slot; otherwise a single gun on one port (proven path).
    const twoGun = _twoGunActiveFor(meta);
    const gun = (meta.lightgun || window.__lightgunArmed) ? lightgunLoadConfig(meta.system, { twoGun }) : null;
    const coreName = gun?.core || meta.core;
    const core = CORES[coreName];
    if (!core) throw new Error(`no core registered as "${coreName}"`);
    const coreOptions = gun ? { ...(core.coreOptions || {}), ...gun.coreOptions } : core.coreOptions;
    // NES Four Score: when this is an (un-gunned) NES/fceumm boot, connect
    // players 3+4 as gamepads so fceumm enables its Four Score multitap and the
    // ROM can read P3/P4 over the serial protocol. No-op (null) for nestopia,
    // non-NES systems, and gun boots — those keep their exact prior wiring.
    const fourScore = gun ? null : fourScoreLoadConfig(meta.system, coreName);
    // Mouse wiring: when this load is mouse-enabled (game flagged, or a mouse was
    // armed this session by grabbing the prop) on a mouse-capable system, connect
    // the libretro MOUSE device on its port(s). A twoMouse-flagged game on a
    // two-mouse-capable system (Amiga) seats a mouse on BOTH ports (split-pointer
    // 2-player); otherwise one mouse on port 0. Mutually exclusive with the gun
    // (Amiga has no light gun), so this only applies on non-gun boots.
    const wantMouse = !gun && isMouseCapable(meta.system) && (meta.mouse || window.__mouseArmed);
    const twoMouse = wantMouse && !!meta.twoMouse && isTwoMouseCapable(meta.system);
    const mouse = wantMouse ? mouseLoadConfig(meta.system, { twoMouse }) : null;
    const inputDevices = gun?.inputDevices ?? mouse?.inputDevices ?? fourScore?.inputDevices;
    const remapName = gun?.remapName ?? mouse?.remapName ?? fourScore?.remapName ?? core.remapName;
    logger?.event?.('rom-resolved', { file: meta.file, bytes: buf?.byteLength ?? 0, coreUrl: core.url, lightgun: !!gun, twoGun: !!(gun && gun.guns?.length > 1), mouse: !!mouse, twoMouse: !!(mouse && mouse.mice?.length > 1), fourScore: !!fourScore });
    logLightgunBoot('loadCartridge', meta, gun);
    if (mouse) logger?.event?.('mouse-boot', { where: 'loadCartridge', system: meta.system, inputDevices: mouse.inputDevices, mice: mouse.mice, remapName: mouse.remapName });
    await client.start(primaryCanvas(), buf, {
      coreUrl: core.url, coreName, moduleStyle: core.style, contentExt: extOf(meta.file),
      coreOptions, inputDevices, remapName, systemFiles: core.systemFiles,
    });
    rackMgr.get(CONSOLE_ID)?.noteLoaded(coreName, { system: meta.system, title: meta.title });
    currentCore = coreName;
    currentMeta = { core: meta.core, file: meta.file, title: meta.title, system: meta.system };
    _lastLoadedMeta = meta;            // full meta (keeps rom.source) for gun-reload
    _lightgunArmedConsole = !!gun;     // did this boot connect the gun device?
    // Two-gun co-op: record the active device's seated libretro ports (e.g. [1,2]).
    // LightGunMgr.portForGun derives each held gun's port live from its cable jack
    // (gun in the lower jack → port 1, next → port 2). Empty [] for single-gun /
    // no-gun boots → DOM-mouse path unchanged.
    _twoGunPorts = (gun && gun.guns?.length > 1) ? gun.guns.map((x) => x.port) : [];
    _mouseArmedConsole = !!mouse;      // did this boot connect the mouse device?
    // Two-mouse split-pointer: record the active device's seated libretro ports
    // (Amiga → [0,1]); MouseMgr.portForMouse derives each held mouse's port live
    // from its cable jack. Empty [] for single-mouse → shared DOM-mouse path.
    _twoMousePorts = (mouse && mouse.mice?.length > 1) ? mouse.mice.map((x) => x.port) : [];
    gameInput?.setSystem(meta.system);
    // Loading implies the primary console is on — sync power state + switch tint.
    setConsolePower(CONSOLE_ID, true, consoleObjs.get(CONSOLE_ID)?.userData?.powerBtn);
    // Enable exactly the controller ports this system's hardware accepts.
    consoleObj?.userData.setPorts?.(portsForSystem(meta.system));
    setSystemLabel(meta.core);
    updateControlsPanel();
    // Auto show/hide the keyboard and connect it to the booting console.
    // Manual override is cleared at every boot so auto-state takes effect again.
    _consoleSystems.set(CONSOLE_ID, meta.system);
    _kbdManualOverride = false;
    if (isKeyboardCapable(meta.system)) {
      connectKeyboardTo(CONSOLE_ID);
      setKbdVisibility(true);
    } else {
      setKbdVisibility(false);
    }
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
    logger?.event?.('boot-error', {
      file: meta.file, system: meta.system, core: meta.core, error: msg,
      plan: resolutionPlan(meta), opfs: opfsSupported(),
    });
    // Surface the failure ON THE TV instead of silently leaving the idle screen,
    // so a missing/un-downloaded ROM (the resolver throws on a 404) reads as a
    // real error in VR rather than "nothing happened". Default room ships only
    // cartridges that boot, but a user-added collection can still point at a ROM
    // that isn't installed.
    //
    // Local ROMs (opfs/pick only) get a special message: the user needs to pick
    // the file again (the OPFS cache may have been cleared), NOT to "install" a
    // server ROM. Avoids the confusing "ROM not installed" on the headset.
    const isLocal = isLocalRomMeta(meta);
    const notInstalled = /404|→\s*\d|not found|could not resolve|no url for rom/i.test(msg);
    placeholder.setMessage(isLocal
      ? `Local ROM not in cache — pick the file again: ${meta.title || meta.file}`
      : notInstalled
        ? `ROM not installed: ${meta.title || meta.file}`
        : `Couldn't load ${meta.title || meta.file}`);
    placeholder.start();
    scene.setScreenSource(placeholderCanvas);
    nowPlayingPanel?.userData.setNowPlaying?.({});
  }
}
window.__loadCartridge = loadCartridge; // debug hook: boot a game via RomResolver

// Boot a cartridge into a SECONDARY console's own runtime (its own EmulatorClient
// + canvas), routed to its own TV through the patch graph. This is the per-console
// load path the rack always had for the *spawn* moment but never exposed to plain
// cartridge insertion — so before this, a cart could only ever load on console0.
//
// Cross-core swaps on an already-booted secondary runtime are refused: libretro
// cores pin window globals and can't cleanly unload, and only the primary console
// can fall back to a whole-page reload (which would tear down the rest of the
// rack). Same-core ROM swaps just re-feed the running core and are safe.
async function loadCartridgeIntoConsole(consoleId, meta) {
  const runtime = rackMgr.get(consoleId);
  if (!runtime) { setStatus(`no such console ${consoleId}`); return; }
  setStatus(`loading ${meta.title} on ${consoleId}…`);
  logger?.event?.('boot-attempt', {
    consoleId, file: meta.file, system: meta.system, core: meta.core,
    plan: resolutionPlan(meta), opfs: opfsSupported(),
  });
  if (runtime.coreName && runtime.coreName !== meta.core) {
    // Option B — a secondary console CAN change cores: the old core can't unload,
    // so swapConsoleCore() builds a fresh runtime for the new core in its own
    // canvas and retires the old one, leaving every OTHER console's game running
    // (no whole-page reload). The primary console still reloads (it owns #canvas).
    try {
      const from = runtime.coreName;
      await swapConsoleCore(consoleId, meta);
      logger?.event?.('console-coreswap', { consoleId, from, to: meta.core, title: meta.title });
      setStatus(`${meta.title} → ${consoleId}`);
    } catch (e) {
      const msg = String(e?.message || e);
      setStatus(`error: ${msg}`);
      logger?.event?.('boot-error', { consoleId, core: meta.core, error: msg });
    }
    return;
  }
  try {
    const buf = await resolveRom(meta);
    const core = CORES[meta.core];
    if (!core) throw new Error(`no core registered as "${meta.core}"`);
    logger?.event?.('rom-resolved', { consoleId, file: meta.file, bytes: buf?.byteLength ?? 0, coreUrl: core.url });
    // CORES entries carry no `name`; ConsoleRuntime.load wants { name, url, style }.
    await runtime.load(buf, { ...core, name: meta.core }, { system: meta.system, title: meta.title });
    // Repaint via the patch graph (idempotent) so this console's TV samples its
    // canvas and no other TV is touched — the fix for "game showed on both screens".
    // Loading into a console implies it's on — keep power state + switch in sync.
    setConsolePower(consoleId, true, consoleObjs.get(consoleId)?.userData?.powerBtn);
    consoleObjs.get(consoleId)?.userData.setPorts?.(portsForSystem(meta.system));
    _consoleSystems.set(consoleId, meta.system);
    // Auto-connect the keyboard to THIS console when it boots a keyboard system.
    if (isKeyboardCapable(meta.system)) {
      connectKeyboardTo(consoleId);
      setKbdVisibility(true);
    }
    rackMgr.applyBudget();
    refreshAudioFocus();
    // Persist the swap so a reload restores the new game on this console.
    _updateSpawnedMeta(consoleId, meta);
    persistRack();
    logger?.event?.('console-loaded', { consoleId, system: meta.system, core: meta.core, title: meta.title });
    setStatus(`${meta.title} → ${consoleId}`);
  } catch (e) {
    const msg = String(e?.message || e);
    setStatus(`error: ${msg}`);
    logger?.event?.('boot-error', { consoleId, file: meta.file, system: meta.system, core: meta.core, error: msg });
  }
}

// The first TV the patch graph has this console feeding (a console usually drives
// exactly one TV). Used to label the new core's audio branch on a core swap.
function tvForConsole(consoleId) {
  for (const tvId of cable.tvs()) if (cable.sourceOf(tvId) === consoleId) return tvId;
  return null;
}

// Option B — change the core running on a SECONDARY console WITHOUT a page reload.
// A libretro core can't cleanly unload (it pins a WebGL context that survives
// callMain), so we can't re-point the existing runtime at a different core. Instead
// we build a FRESH ConsoleRuntime (its own canvas + core) for the new game, retire
// the old runtime (dispose = pause + detach; the orphaned context lingers, same as
// every rack teardown — RackBudget.maxLive bounds the LIVE ones), and install the
// new runtime under the SAME console id. routeVideo() reads rackMgr.get(id).canvas
// per TV, so the TV re-samples the new canvas automatically. Crucially, no other
// console is touched — their cores keep running. The PRIMARY console (CONSOLE_ID)
// never reaches here: it owns #canvas + the room/net host role and keeps the
// whole-page reload path in handleCartridgeInserted.
async function swapConsoleCore(consoleId, meta) {
  const core = CORES[meta.core];
  if (!core) throw new Error(`no core registered as "${meta.core}"`);
  const buf = await resolveRom(meta);
  // NES Four Score on a secondary console: same fceumm-only P3/P4 gamepad wiring
  // as the primary path. null (no-op) for nestopia / non-NES boots.
  const fourScore = fourScoreLoadConfig(meta.system, meta.core);
  await bootFreshRuntime(consoleId, meta, {
    core: { ...core, name: meta.core }, romBuffer: buf,
    inputDevices: fourScore?.inputDevices,
    remapName: fourScore?.remapName ?? core.remapName,
  });
  // Persist so a later reload restores the game now on this console.
  _updateSpawnedMeta(consoleId, meta);
  persistRack();
}

// Build a FRESH ConsoleRuntime (own canvas + core) for `consoleId`, boot it with
// `bootOpts`, then atomically retire the old runtime and install the new one under
// the SAME id — the reboot primitive both the secondary core-swap and the PRIMARY
// live light-gun reboot share. A libretro core can't cleanly unload (it pins a
// WebGL context past callMain), so re-attaching a boot-time peripheral / changing
// the core means a fresh boot; the orphaned old context just lingers (bounded by
// RackBudget.maxLive, like every rack teardown). routeVideo() re-points the TV to
// the new canvas. bootOpts: { core:{name,url,style,coreOptions?}, romBuffer,
// inputDevices?, coreOptions?, remapName? }. Returns the new runtime.
async function bootFreshRuntime(consoleId, meta, bootOpts) {
  const { core, romBuffer } = bootOpts;
  // Label the audio branch BEFORE boot so the new core's AudioContext (created
  // during load) lands on this console's TV, mirroring spawnConsole's ordering.
  const tvId = tvForConsole(consoleId);
  const tvGroup = tvId ? scene.getTV(tvId)?.group : null;

  // Boot the new core first (TV keeps showing the old canvas until it's ready),
  // then atomically retire the old runtime and install the new one under this id.
  const next = new ConsoleRuntime({ id: consoleId });
  if (tvGroup) audioRouter.expect(consoleId, tvGroup);
  await next.load(romBuffer, core, {
    system: meta.system, title: meta.title, contentExt: extOf(meta.file),
    coreOptions: bootOpts.coreOptions, inputDevices: bootOpts.inputDevices, remapName: bootOpts.remapName,
    systemFiles: bootOpts.systemFiles,
  });
  rackMgr.remove(consoleId);   // dispose old (pause + detach its canvas)
  rackMgr.add(next);

  // Re-point video + controller ports for the new system. Re-adding the console to
  // the patch graph only updates its port count (it keeps the existing TV edge),
  // and routeVideo() makes the TV sample the new core's canvas.
  cable.addConsole(consoleId, { ports: portsForSystem(meta.system) });
  consoleObjs.get(consoleId)?.userData.setPorts?.(portsForSystem(meta.system));
  routeVideo();

  // Keep this console powered, remember its system (keyboard layout + restore),
  // and auto-connect the keyboard if the new system is keyboard-capable.
  setConsolePower(consoleId, true, consoleObjs.get(consoleId)?.userData?.powerBtn);
  _consoleSystems.set(consoleId, meta.system);
  if (isKeyboardCapable(meta.system)) {
    connectKeyboardTo(consoleId);
    setKbdVisibility(true);
  }

  rackMgr.applyBudget();
  refreshAudioFocus();
  return next;
}

// Live reboot of the PRIMARY console (CONSOLE_ID) — re-boot the SAME ROM with new
// boot params WITHOUT a page reload. The light-gun device (and any boot-time
// device/core-option change) attaches only at a fresh core boot, and the primary
// historically owned the singleton #canvas, forcing a location.reload(). Instead
// we reuse bootFreshRuntime to stand up a fresh runtime (own canvas + client) for
// CONSOLE_ID, then re-point every consumer that captured the old singleton client
// (rebindPrimaryClient) + wire its ready/error events. Because the page is KEPT,
// the net/room session and host role survive untouched. The TV follows the new
// canvas via routeVideo() (rackMgr.get(CONSOLE_ID).canvas) and the host-video
// capture follows it via the primaryCanvas() getter. Returns the new runtime.
async function rebootPrimaryConsole(meta, gun, mouse = null) {
  // `gun` and `mouse` are mutually-exclusive device configs of the same shape
  // ({ core, inputDevices, coreOptions, remapName }). Either (or neither) seats a
  // peripheral on a fresh boot — the gun path is unchanged; the mouse path reuses it.
  const dev = gun || mouse;
  const coreName = dev?.core || meta.core;
  const core = CORES[coreName];
  if (!core) throw new Error(`no core registered as "${coreName}"`);
  const buf = await resolveRom(meta);
  const coreOptions = dev ? { ...(core.coreOptions || {}), ...dev.coreOptions } : core.coreOptions;
  logLightgunBoot('arm-reboot', meta, gun, { live: true });
  if (mouse) logger?.event?.('mouse-boot', { where: 'arm-reboot', system: meta.system, inputDevices: mouse.inputDevices, mice: mouse.mice, remapName: mouse.remapName, live: true });
  const next = await bootFreshRuntime(CONSOLE_ID, meta, {
    core: { name: coreName, url: core.url, style: core.style },
    romBuffer: buf,
    coreOptions,
    inputDevices: dev?.inputDevices,
    remapName: dev?.remapName ?? core.remapName,
    systemFiles: core.systemFiles,
  });
  // Re-point the singleton-bound consumers (keyboard / desktop pad / reset / save
  // states / host-video pause-resume) at the new runtime's client, and wire its
  // ready/error handlers (the old client's listeners don't carry over).
  rebindPrimaryClient(next.client);
  wireClientEvents(next.client);
  next.client.resume?.();   // make sure the fresh core is actually running

  // Mirror loadCartridge's post-boot bookkeeping so the rest of the app agrees on
  // what's now running on the primary (and that the gun device is connected).
  currentCore = coreName;
  currentMeta = { core: meta.core, file: meta.file, title: meta.title, system: meta.system };
  _lastLoadedMeta = meta;
  _lightgunArmedConsole = !!gun;
  _twoGunPorts = (gun && gun.guns?.length > 1) ? gun.guns.map((x) => x.port) : [];
  _mouseArmedConsole = !!mouse;
  _twoMousePorts = (mouse && mouse.mice?.length > 1) ? mouse.mice.map((x) => x.port) : [];
  gameInput?.setSystem(meta.system);
  consoleObj?.userData.setPorts?.(portsForSystem(meta.system));
  setSystemLabel(coreName);
  updateControlsPanel();
  nowPlayingPanel?.userData.setNowPlaying({
    system: meta.system,
    coreLabel: CORES[meta.core]?.label || meta.core,
    title: meta.title,
  });
  // We are (still) the host of whatever was playing — keep the TV broadcast on the
  // new canvas alive for any peers watching our stream.
  if (net?.isHost?.()) net?.startVideoBroadcast?.();
  return next;
}

// Rewrite the persisted meta for a spawned console after an in-place game swap so
// restoreRack re-boots the game that's actually on it. consoleId is `console<n>`
// (n = spawn order), and spawnedMetas is in that same order — console1 ↔ [0].
function _updateSpawnedMeta(consoleId, meta) {
  const n = parseInt(String(consoleId).replace('console', ''), 10);
  if (!Number.isFinite(n) || n < 1) return;
  const idx = n - 1;
  if (idx >= 0 && idx < spawnedMetas.length) {
    spawnedMetas[idx] = { system: meta.system, file: meta.file, core: meta.core, title: meta.title };
  }
}

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
  // FIX 2: Race against a timeout so a stalled IndexedDB open (headless Chrome)
  // can't wedge init and leave __locomotion/__gameInput undefined.
  const MEMORY_CARD_TIMEOUT_MS = 2000;
  try {
    saved = await Promise.race([
      listStates(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('listStates timeout')), MEMORY_CARD_TIMEOUT_MS)),
    ]);
  } catch (e) { console.warn('[main] listStates failed:', e); }
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
//
// Extracted so a live primary reboot (rebootPrimaryConsole) can wire the SAME ready/error
// behaviour onto the fresh client it boots. ready paints the client's OWN canvas
// (c.emuCanvas) so a rebooted primary shows on the TV regardless of bind ordering.
function wireClientEvents(c) {
  c.addEventListener('ready', () => {
    setStatus('running');
    resetBtn.disabled = false;
    input.attach(window);
    placeholder.stop();
    scene.setScreenSource(c.emuCanvas ?? primaryCanvas());
  });
  c.addEventListener('error', (e) => {
    setStatus('error: ' + e.detail);
    resetBtn.disabled = true;
  });
}
wireClientEvents(client);

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
  const cart = createMedia(meta);
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
  // The first boot uses the ArrayBuffer in hand (the File is gone after this
  // event); meta.rom is finalised below once we've cached the bytes so the
  // shelf cartridge can be RE-booted later from the OPFS cache (sha1) instead
  // of a dead `roms/<file>` url fetch (the cause of the "ROM not installed"
  // report when re-inserting a picked cart).
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
    logger?.event?.('rom-picked', { file: meta.file, bytes: buffer?.byteLength ?? 0, core: coreInfo.name, coreUrl: coreInfo.url, opfs: opfsSupported() });
    await client.start(primaryCanvas(), buffer, { coreUrl: coreInfo.url, coreName: coreInfo.name, moduleStyle: coreInfo.style, contentExt: extOf(meta.file), coreOptions: coreInfo.coreOptions, systemFiles: coreInfo.systemFiles });
    rackMgr.get(CONSOLE_ID)?.noteLoaded(coreInfo.name, { system: meta.system, title });
    currentCore = coreInfo.name;
    currentMeta = { core: coreInfo.name, file: meta.file, title, system: meta.system };
    gameInput?.setSystem(meta.system);
    consoleObj?.userData.setPorts?.(portsForSystem(meta.system));
    setSystemLabel(coreInfo.name);
    updateControlsPanel();
    // Auto show/hide keyboard on local-file boot (same policy as loadCartridge).
    _consoleSystems.set(CONSOLE_ID, meta.system);
    _kbdManualOverride = false;
    if (isKeyboardCapable(meta.system)) {
      connectKeyboardTo(CONSOLE_ID);
      setKbdVisibility(true);
    } else {
      setKbdVisibility(false);
    }
    nowPlayingPanel?.userData.setNowPlaying({
      system:    meta.system,
      coreLabel: coreInfo.label,
      title,
    });

    // Cache the bytes (content-addressed) so the shelf cartridge can re-boot
    // without the original File. On success the cart resolves via OPFS (sha1);
    // pick stays as a last-resort fallback if OPFS is unavailable.
    try {
      const sha1 = await cacheRom(buffer);
      meta.rom = sha1 ? { sha1, sources: ['opfs', 'pick'] } : { source: 'pick' };
      // Persist to local-ROM library (sha1 entries only — pick-only can't
      // be re-resolved after reload so there's nothing to remember).
      if (sha1) {
        persistLocalRom(meta);
        // Request durable OPFS storage so the Quest browser doesn't evict it.
        requestPersistentStorage();
      }
    } catch (e) {
      console.warn('[main] cacheRom failed:', e);
    }

    // Goal B: place a grabbable cartridge on a shelf so it exists in the room.
    // Run async; any failure is non-fatal (the game is already booted).
    addLocalRomToShelf(meta).catch((err) => {
      console.warn('[main] addLocalRomToShelf failed:', err);
    });
  } catch (err) {
    const emsg = String(err?.message || err);
    setStatus(`error loading "${title}": ${emsg}`);
    logger?.event?.('boot-error', { file: meta.file, system: meta.system, core: coreInfo.name, error: emsg, source: 'pick', opfs: opfsSupported() });
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

function applyCustomPosterSource(src, fileName) {
  // Resolve the currently-selected poster prop.
  const rec = editor?.selectedProp?.();
  if (!rec) { setStatus('Set Poster: enter Change mode and select a poster first'); return; }
  if (rec.prop.type !== 'poster') { setStatus(`Set Poster: selected prop is a ${rec.prop.type}, not a poster`); return; }

  // Write the source into the descriptor so it survives Export + auto-load.
  rec.prop.texture = src;
  // FIX 3b: store the source filename for blob: URLs so load-time re-resolution
  // can recover a fresh object URL after reload. Only set for blob sources that
  // die on reload; http/data URLs survive natively and need no filename.
  if (fileName && src.startsWith('blob:')) {
    rec.prop.imageFile = fileName;
  } else if (!fileName) {
    delete rec.prop.imageFile; // URL entered manually — clear stale imageFile
  }
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
      applyCustomPosterSource(objUrl, file.name); // FIX 3b: thread filename for re-resolution
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
