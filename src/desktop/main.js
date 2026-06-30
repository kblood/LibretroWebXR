// Desktop (flat-screen) LibretroWebXR — bootstrap + glue.
//
// This is the entry for desktop.html: a plain 2D emulator page with optional
// 2-player-over-the-Internet netplay. It deliberately imports NONE of the VR /
// three.js stack — only the shared, three-free modules:
//   • EmulatorClient   — runs the libretro core on a <canvas>
//   • systems / Collection / RomResolver — what to load and from where
//   • DesktopInput     — keyboard + gamepad → logical RetroPad buttons
//   • DesktopNet       — host-authoritative netplay + host→client video
//
// Netplay roles (see [[src/desktop/DesktopNet.js]]):
//   host   — you loaded the game; you run the core and stream it to your peer,
//            who drives player 2.
//   client — someone else is hosting; you watch their video and your controls
//            are sent to them as player 2.
//   idle   — connected but nobody is hosting yet (load a game to host) — also
//            the offline single-player state.

import { EmulatorClient } from '../EmulatorClient.js';
import { loadCollection } from '../Collection.js';
import { romUrlFor } from '../RomResolver.js';
import { coreInfo, coreForFile, systemForFile, extOf, SYSTEMS } from '../systems.js';
import { DesktopInput, dispatchToCore } from './DesktopInput.js';
import { DesktopNet } from './DesktopNet.js';
import { sanitiseRoom, randomRoomSuffix } from '../net/SessionUtils.js';

// --- DOM ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const canvas = $('emu');
const screen = $('screen');
const gameSelect = $('game-select');
const fileInput = $('file-input');
const status = $('status');
const saveBtn = $('save-state');
const loadBtn = $('load-state');
// Multiplayer widgets
const nickInput = $('mp-nick');
const roomInput = $('mp-room');
const connectBtn = $('mp-connect');
const mpStatus = $('mp-status');

// Force preserveDrawingBuffer on the core's WebGL context. The host streams this
// canvas to its peer via canvas.captureStream(); a WebGL context created with the
// default preserveDrawingBuffer:false delivers a BLACK / frame-less capture
// (the drawing buffer is cleared before the capture step). Patching getContext to
// merge the flag in — before the core grabs the context — makes captureStream
// carry real frames. Desktop-only, so the VR build's GL perf is unaffected.
(function forcePreserveDrawingBuffer(c) {
  const orig = c.getContext.bind(c);
  c.getContext = (type, attrs) => {
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
      attrs = { ...(attrs || {}), preserveDrawingBuffer: true };
    }
    return orig(type, attrs);
  };
})(canvas);

const client = new EmulatorClient();
let net = null;
let games = [];               // normalized collection entries
let loadedMeta = null;        // the meta WE booted locally (host/solo)
let booted = false;           // our local core has a ROM running
let hostVideoEl = null;       // <video> showing host's stream (client only)
// Remote player input we (as host) are currently holding, so we can flush clean
// keyups if the remote peer vanishes mid-press. player -> Set<btn>.
const remoteHeld = new Map();
let prevPeerIds = [];

// --- status helpers ----------------------------------------------------------
function setStatus(msg) { if (status) status.textContent = msg; }

function role() {
  if (!net || !net.connected) return 'idle';
  const h = net.hostId();
  if (!h) return 'idle';
  return net.isHost() ? 'host' : 'client';
}

function refreshMpStatus() {
  if (!mpStatus) return;
  if (!net || !net.connected) {
    mpStatus.textContent = 'offline';
    mpStatus.className = 'offline';
    return;
  }
  const peers = net.peerCount();
  const r = role();
  let txt;
  if (r === 'host') txt = `Hosting · ${peers} watching`;
  else if (r === 'client') txt = 'Watching host';
  else txt = peers ? `Connected · ${peers} peer(s)` : 'Connected · waiting';
  mpStatus.textContent = `● ${txt}`;
  mpStatus.className = 'online';
}

// --- ROM loading -------------------------------------------------------------

// Boot a ROM buffer locally on our core. `meta` carries {file, system, core,
// title}. Returns true on success. Used by both the bundled-game picker and the
// file-upload path; both resolve the same core info from the registry.
async function bootLocal(meta, buffer) {
  const core = coreInfo(meta.core) || coreForFile(meta.file);
  if (!core) { setStatus(`No core for ${meta.file}`); return false; }
  setStatus(`Loading ${meta.title || meta.file}…`);
  try {
    await client.start(canvas, buffer, {
      coreUrl: core.url, coreName: core.name, moduleStyle: core.style,
      contentExt: extOf(meta.file), coreOptions: core.coreOptions, systemFiles: core.systemFiles,
    });
  } catch (e) {
    setStatus(`Failed to load: ${e?.message || e}`);
    return false;
  }
  booted = true;
  loadedMeta = meta;
  client.resume();
  showCanvas();
  setStatus(`Playing ${meta.title || meta.file}`);
  return true;
}

// Fetch a bundled game's ROM and boot it. If we're connected, claim the host
// role (broadcast the tv state) and start streaming our canvas.
async function loadBundled(meta) {
  const url = romUrlFor(meta);
  setStatus(`Fetching ${meta.title || meta.file}…`);
  let buffer;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    buffer = await r.arrayBuffer();
  } catch (e) {
    setStatus(`ROM fetch failed: ${e?.message || e}`);
    return;
  }
  const ok = await bootLocal(meta, buffer);
  if (ok) becomeHost(meta);
}

// Load a user-supplied ROM file (drag/drop or picker). System + core are
// auto-detected from the extension via the registry.
async function loadFile(file) {
  const core = coreForFile(file.name);
  const system = systemForFile(file.name);
  if (!core) { setStatus(`Unrecognised ROM type: ${file.name}`); return; }
  const meta = {
    file: file.name, system, core: core.name,
    title: file.name.replace(/\.[^.]+$/, ''),
  };
  const buffer = await file.arrayBuffer();
  const ok = await bootLocal(meta, buffer);
  if (ok) becomeHost(meta);
}

// Claim/refresh the host role for a freshly-booted game.
function becomeHost(meta) {
  if (!net || !net.connected) return;
  net.setObjectState('tv', {
    file: meta.file, system: meta.system, core: meta.core, title: meta.title || meta.file,
  });
  net.startVideoBroadcast();
  refreshMpStatus();
}

// --- screen (canvas vs host-video) ------------------------------------------
function showCanvas() {
  if (hostVideoEl) { hostVideoEl.remove(); hostVideoEl = null; }
  canvas.style.display = '';
}
function showHostVideo(videoEl) {
  if (hostVideoEl && hostVideoEl !== videoEl) hostVideoEl.remove();
  hostVideoEl = videoEl;
  videoEl.className = 'host-video';
  canvas.style.display = 'none';
  screen.appendChild(videoEl);
}

// --- input routing -----------------------------------------------------------
// One local player. As host/solo you ARE player 1 (drive the local core). As a
// client your buttons go to the host as player 2.
function onLocalButton(btn, down) {
  if (role() === 'client') {
    net.forwardGameInput({ player: 2, btn, down });
  } else if (booted) {
    dispatchToCore(client, 1, btn, down);
  }
}

const input = new DesktopInput({ onButton: onLocalButton });

// Host side: inject a remote player's button into our core, tracking held
// buttons so a mid-press disconnect can be flushed cleanly.
function onRemoteGameInput({ player, btn, down }) {
  if (!booted) return;
  let held = remoteHeld.get(player);
  if (!held) { held = new Set(); remoteHeld.set(player, held); }
  if (down) held.add(btn); else held.delete(btn);
  dispatchToCore(client, player, btn, down);
}

function flushRemotePlayer(player) {
  const held = remoteHeld.get(player);
  if (!held) return;
  for (const btn of held) dispatchToCore(client, player, btn, false);
  held.clear();
}

// --- multiplayer connect/disconnect -----------------------------------------
function connect() {
  const room = sanitiseRoom(roomInput.value) || `room-${randomRoomSuffix()}`;
  roomInput.value = room;
  const nick = (nickInput.value || '').trim() || 'Player';
  // ?server=ws://host:port overrides the default wss://<host>/ws/ (used in dev,
  // where the room-server runs on its own port without an Apache reverse proxy).
  const serverUrl = new URLSearchParams(location.search).get('server') || undefined;
  net = new DesktopNet({
    room, nick, serverUrl,
    getCaptureCanvas: () => canvas,
    onConnect: () => { refreshMpStatus(); },
    onDisconnect: () => { refreshMpStatus(); },
    onRoster: (peers) => {
      // If we're the host and a peer that was here is now gone, flush their
      // (player-2) held keys so nothing latches.
      const ids = peers.map((p) => p.id);
      if (role() === 'host') {
        const left = prevPeerIds.filter((id) => !ids.includes(id));
        if (left.length) flushRemotePlayer(2);
      }
      prevPeerIds = ids;
      refreshMpStatus();
    },
    onTvState: (value, ownerId) => {
      // The room's loaded game changed. If someone else is now hosting, switch
      // to client mode: pause our core, await their video. If it cleared (host
      // left) revert to idle.
      onRoleMaybeChanged(value, ownerId);
    },
    onGameInput: onRemoteGameInput,
    onHostVideo: (videoEl) => { showHostVideo(videoEl); setStatus('Watching host'); },
    onHostVideoEnded: () => { showCanvas(); if (role() !== 'host') setStatus('Host stream ended'); },
  });
  net.connect();
  connectBtn.textContent = 'Leave';
  document.body.classList.add('mp-connected');
  setStatus(`Joining "${room}"…`);
}

function disconnect() {
  flushRemotePlayer(2);
  input.releaseAll();
  net?.disconnect();
  net = null;
  prevPeerIds = [];
  connectBtn.textContent = 'Join / Host';
  document.body.classList.remove('mp-connected');
  showCanvas();
  if (booted) client.resume();
  refreshMpStatus();
  setStatus(booted ? `Playing ${loadedMeta?.title || ''}` : 'Disconnected');
}

// React to a tv-state change: am I host, client, or idle now?
function onRoleMaybeChanged(tvValue, ownerId) {
  const self = net?.selfId;
  const r = role();
  input.releaseAll();
  flushRemotePlayer(2);
  if (r === 'client') {
    // Someone else hosts — stop our core, show their game info, await video.
    if (booted) client.pause();
    setStatus(`Watching ${tvValue?.title || "host's game"}`);
  } else if (r === 'host') {
    if (booted) client.resume();
    showCanvas();
  } else {
    // idle — host left / nobody hosting.
    if (booted) client.resume();
    showCanvas();
    setStatus(booted ? `Playing ${loadedMeta?.title || ''}` : 'Connected · load a game to host');
  }
  refreshMpStatus();
}

connectBtn?.addEventListener('click', () => {
  if (net && net.connected) disconnect(); else connect();
});

// --- save / load state -------------------------------------------------------
saveBtn?.addEventListener('click', async () => {
  if (!client.canSerialize()) { setStatus('This core has no save-state support'); return; }
  try {
    const data = await client.serializeState();
    const blob = new Blob([data], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${loadedMeta?.title || 'state'}.state`;
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus('Saved state to download');
  } catch (e) { setStatus(`Save failed: ${e?.message || e}`); }
});
loadBtn?.addEventListener('click', () => {
  const picker = document.createElement('input');
  picker.type = 'file'; picker.accept = '.state';
  picker.onchange = async () => {
    const f = picker.files?.[0];
    if (!f) return;
    try { await client.unserializeState(new Uint8Array(await f.arrayBuffer())); setStatus('Loaded state'); }
    catch (e) { setStatus(`Load failed: ${e?.message || e}`); }
  };
  picker.click();
});

// --- game picker + file upload ----------------------------------------------
gameSelect?.addEventListener('change', () => {
  const idx = Number(gameSelect.value);
  if (Number.isInteger(idx) && games[idx]) loadBundled(games[idx]);
});
fileInput?.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) loadFile(f);
});
// Drag & drop a ROM anywhere on the screen area.
['dragover', 'drop'].forEach((ev) => screen?.addEventListener(ev, (e) => e.preventDefault()));
screen?.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

// --- populate game list ------------------------------------------------------
async function loadGameList() {
  const params = new URLSearchParams(location.search);
  const collectionUrl = params.get('collection') || 'roms/manifest.json';
  const col = await loadCollection(collectionUrl);
  games = col.games || [];
  if (gameSelect) {
    gameSelect.innerHTML = '<option value="">— pick a game —</option>';
    games.forEach((g, i) => {
      const sysLabel = SYSTEMS[g.system]?.label || g.system || '';
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${g.title || g.file} (${sysLabel})`;
      gameSelect.appendChild(opt);
    });
  }
  setStatus(games.length ? 'Pick a game or drop a ROM file' : 'No bundled games found — drop a ROM file');
}

// --- boot --------------------------------------------------------------------
client.addEventListener('error', (e) => setStatus(`Emulator error: ${e.detail}`));

// Headless/debug surface (mirrors the VR build's window.__net). Not used in
// normal play; lets a Puppeteer probe observe roles, the input relay, and video.
window.__desktop = {
  client,
  get net() { return net; },
  role,
  booted: () => booted,
  ticks: () => ticks,
  net_debug: () => net?.debugApi?.() ?? null,
};

// Auto-fill room from ?session= so a shared link drops you straight in.
(() => {
  const params = new URLSearchParams(location.search);
  const session = params.get('session') || params.get('room');
  if (session && roomInput) roomInput.value = session;
})();

// Net housekeeping + gamepad poll on a fixed timer. We deliberately use
// setInterval, NOT requestAnimationFrame: once a libretro core boots it drives
// its own emscripten rAF loop, and a background tab (or a watching client whose
// core is paused) throttles rAF to ~1 Hz — which would stall the presence
// heartbeat and host-video reconciliation. A timer keeps netplay liveness
// independent of the render loop.
let last = performance.now();
let ticks = 0;
function tick() {
  const t = performance.now();
  const dt = t - last; last = t;
  ticks++;
  input.pollGamepads();
  net?.tick(dt);
}
setInterval(tick, 50); // 20 Hz — ample for the 2 s heartbeat + video reconcile

loadGameList();

// Auto-join if a session was provided in the URL.
(() => {
  const params = new URLSearchParams(location.search);
  if (params.get('session') || params.get('room')) connect();
})();
