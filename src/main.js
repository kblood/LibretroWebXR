import * as THREE from 'three';
import { EmulatorClient } from './EmulatorClient.js';
import { InputMgr } from './InputMgr.js';
import { Placeholder } from './Placeholder.js';
import { SceneMgr } from './SceneMgr.js';
import { createCartridge } from './Cartridge.js';
import { createShelf, lockShelfHomes } from './Shelf.js';
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

// Available libretro cores keyed by short name. Each entry has:
//   url:    filename under public/cores/
//   exts:   ROM file extensions this core can load (used for auto-detect)
//   label:  shown in the UI
//   style:  'classic' = old-style auto-init against window.Module (legacy
//                       WebEmu cores). 'module' = MODULARIZE=1 ES-module
//                       factory from the libretro buildbot, loaded via
//                       dynamic import().
//
// When two cores map to the same extension, the first one declared wins
// auto-detection — pass ?core=<name> to force the other.
const CORES = {
  // Legacy WebEmu cores (classic-script auto-init)
  snes9x:           { url: 'cores/snes9x_libretro.js',           exts: ['smc','sfc','swc','fig','bs'], label: 'SNES (snes9x)',               style: 'classic' },
  nestopia:         { url: 'cores/nestopia_libretro.js',         exts: ['nes','fds','unf','unif'],     label: 'NES (nestopia)',              style: 'classic' },
  stella2014:       { url: 'cores/stella2014_libretro.js',       exts: ['a26','bin'],                  label: 'Atari 2600 (stella)',         style: 'classic' },
  genesis_plus_gx:  { url: 'cores/genesis_plus_gx_libretro.js',  exts: ['md','gen','smd'],             label: 'Genesis (genesis_plus_gx)',   style: 'classic' },
  mgba:             { url: 'cores/mgba_libretro.js',             exts: ['gba'],                        label: 'GBA (mGBA)',                  style: 'classic' },
  mednafen_vb:      { url: 'cores/mednafen_vb_libretro.js',      exts: ['vb','vboy'],                  label: 'Virtual Boy (mednafen)',      style: 'classic' },

  // Modern libretro buildbot cores (ES-module factory)
  picodrive:        { url: 'cores/picodrive_libretro.js',        exts: ['sms','gg','md','gen','smd','32x','cue','iso'], label: 'Sega multi (picodrive)', style: 'module' },
  gearsystem:       { url: 'cores/gearsystem_libretro.js',       exts: ['sms','gg','sg'],              label: 'SMS/GG (gearsystem)',         style: 'module' },
  fceumm:           { url: 'cores/fceumm_libretro.js',           exts: [],                             label: 'NES (fceumm)',                style: 'module' },
  gambatte:         { url: 'cores/gambatte_libretro.js',         exts: ['gb','gbc'],                   label: 'Game Boy/Color (gambatte)',   style: 'module' },
  mednafen_pce_fast:{ url: 'cores/mednafen_pce_fast_libretro.js',exts: ['pce'],                        label: 'PC Engine/TurboGrafx (mednafen_pce_fast)', style: 'module' },
  vice_x64:         { url: 'cores/vice_x64_libretro.js',         exts: ['d64','d71','d80','d81','d82','g64','x64','t64','tap','prg','p00','crt'], label: 'C64 (VICE)', style: 'module' },
  vice_xvic:        { url: 'cores/vice_xvic_libretro.js',        exts: ['20','40','60','a0','b0','rom'], label: 'VIC-20 (VICE)',             style: 'module' },
};

// .bin is ambiguous (Atari 2600 / Megadrive / etc.). When detection sees
// .bin we default to Atari 2600 because that's what we have ROMs of —
// any other usage should pass ?core=<name> in the URL to override.
function detectCore(filename, override) {
  if (override && CORES[override]) return { name: override, ...CORES[override] };
  const ext = filename.split('.').pop().toLowerCase();
  for (const [name, info] of Object.entries(CORES)) {
    if (info.exts.includes(ext)) return { name, ...info };
  }
  return null;
}

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

const consoleObj = createConsole({ position: new THREE.Vector3(0, 0.74, -2.4) });
scene.addObject(consoleObj);

const gamepadObj = createGamepad({ position: new THREE.Vector3(0.55, 0.78, -2.15) });
scene.addObject(gamepadObj);

// Live gamepad debug readout floats above the controller mesh. Parented
// to the gamepad so it follows whether the gamepad is sitting at rest or
// being held — the user can glance at it to see exactly which button
// indices are firing on Quest.
const debugHud = createDebugHud();
debugHud.position.set(0, 0.30, 0);
debugHud.rotation.x = -Math.PI / 6;
gamepadObj.add(debugHud);

let grabMgr = null;
let gameInput = null;
let cartridges = [];
async function buildCartridgeWorld() {
  let manifest;
  try {
    const r = await fetch('roms/manifest.json');
    if (!r.ok) throw new Error(`manifest ${r.status}`);
    manifest = await r.json();
  } catch (e) {
    console.warn('[main] no roms/manifest.json — running without bundled cartridges:', e.message);
    manifest = { cartridges: [] };
  }

  cartridges = (manifest.cartridges || []).map((m) => {
    const c = createCartridge(m);
    return c;
  });

  if (cartridges.length) {
    // Split cartridges across two wall-mounted shelves so the user has
    // something on either side. Room is 6m × 8m, walls at ±3m on X.
    const half = Math.ceil(cartridges.length / 2);
    const left = cartridges.slice(0, half);
    const right = cartridges.slice(half);

    const leftShelf = createShelf(left, {
      position: new THREE.Vector3(-2.85, 1.25, -1.5),
      rotationY: Math.PI / 2, // face into room (+X)
    });
    scene.addObject(leftShelf);
    lockShelfHomes(leftShelf);

    if (right.length) {
      const rightShelf = createShelf(right, {
        position: new THREE.Vector3(2.85, 1.25, -1.5),
        rotationY: -Math.PI / 2, // face into room (-X)
      });
      scene.addObject(rightShelf);
      lockShelfHomes(rightShelf);
    }
  }

  grabMgr = new GrabMgr({
    scene: scene.scene,
    controllers: scene.controllers,
    console: consoleObj,
    onCartridgeInserted: handleCartridgeInserted,
    onGamepadHeldChanged: (held) => {
      // When the gamepad is released, flush any still-pressed keys so the
      // emulator doesn't latch a held button on the controller's last
      // pre-drop state.
      if (!held) gameInput.flushReleases();
    },
    onMemoryCardInserted: handleMemoryCardInserted,
  });
  cartridges.forEach((c) => grabMgr.addGrabbable(c));
  grabMgr.addGrabbable(gamepadObj);

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

  buildMenuAndControlsPanel();

  window.__grab = grabMgr;
  window.__locomotion = locomotion;
  window.__gameInput = gameInput;

  // After everything's built, see if we're resuming a cross-system swap.
  await resumePendingLoad();
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
    ],
  });
  scene.addObject(menu);

  // Wire each button's onActivate now that the panel exists (the toggle
  // closures need to mutate the same button to relabel between Show/Hide).
  const [controlsBtn, debugBtn] = menu.userData.buttons;
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

  for (const b of menu.userData.buttons) {
    menuMgr.addItem(b.mesh, b.onActivate);
  }

  scene.addTickCallback(() => menuMgr.tick());
  window.__menu = menuMgr;
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
    const buf = await fetch('roms/' + meta.file).then((r) => {
      if (!r.ok) throw new Error(`roms/${meta.file} → ${r.status}`);
      return r.arrayBuffer();
    });
    const core = CORES[meta.core];
    await client.start(emuCanvas, buf, { coreUrl: core.url, coreName: meta.core, moduleStyle: core.style });
    currentCore = meta.core;
    currentMeta = { core: meta.core, file: meta.file, title: meta.title, system: meta.system };
    gameInput?.setSystem(meta.system);
    setSystemLabel(meta.core);
    updateControlsPanel();
  } catch (e) {
    setStatus(`error: ${e.message || e}`);
  }
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

setSystemLabel(null);
buildCartridgeWorld();
