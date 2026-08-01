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

import { RuntimeEmulatorClient } from '../RuntimeEmulatorClient.js';
import { loadCollection } from '../Collection.js';
import { romUrlFor } from '../RomResolver.js';
import { coreInfo, coreForFile, systemForFile, extOf, SYSTEMS, isMouseCapable, mouseLoadConfig } from '../systems.js';
import { DesktopInput, dispatchToCore } from './DesktopInput.js';
import { DesktopNet } from './DesktopNet.js';
import { sanitiseRoom, randomRoomSuffix } from '../net/SessionUtils.js';

// --- DOM ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const canvas = $('emu');
const screen = $('screen');
const gameSelect = $('game-select');
const systemSelect = $('system-select');
const fileInput = $('file-input');
const status = $('status');
const captureHint = $('capture-hint');
const controlsHint = $('controls-hint');
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

// RuntimeEmulatorClient, not EmulatorClient directly: it picks the execution
// topology per core, so this page can host worker/threaded cores (dosbox_pure,
// mednafen_psx_hw, mupen64plus_next) as well as the classic page-bound ones.
// Threaded cores additionally need the page to be crossOriginIsolated — that
// comes from the COOP/COEP headers in public/.htaccess, which deploy.ps1 ships
// explicitly. One caveat is structural, not a bug: a <canvas> can only ever
// have one context type, so switching between a main-thread and a worker core
// without a reload raises RuntimeModeSwitchError (see bootLocal).
const client = new RuntimeEmulatorClient();
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
  if (core.requiresThreads && !globalThis.crossOriginIsolated) {
    setStatus(`${core.label} needs SharedArrayBuffer — this page is not cross-origin isolated (COOP/COEP headers missing)`);
    return false;
  }
  setStatus(`Loading ${meta.title || meta.file}…`);
  try {
    // Worker cores take a ContentBundle, not a bare buffer. Single-file content
    // is all this page ever produces (one pick, one drop, one fetched entry), so
    // this is the single-source case of main.js's wrapWorkerContent — the
    // multi-file CUE/M3U companion-fetch branches there have no equivalent here.
    let content = buffer;
    if (core.execution === 'worker') {
      const { ContentBundle } = await import('../ContentBundle.js');
      content = await ContentBundle.fromNamedSources(
        [{ path: meta.file, source: buffer }],
        { entryExtensions: core.exts },
      );
    }
    // Mouse-capable systems (DOS, Amiga, C64) get the libretro MOUSE device
    // seated at boot — mouseLoadConfig is the same registry lookup the VR build
    // uses, so both entry points wire a mouse identically. Unlike the VR room
    // there is no mouse PROP to grab here: the computer's own pointer is the
    // mouse, so it is armed unconditionally for any system that has one rather
    // than waiting for a grab gesture that can't happen on a flat page.
    const mouse = isMouseCapable(meta.system) ? mouseLoadConfig(meta.system) : null;
    await client.start(canvas, content, {
      coreUrl: core.url, coreName: core.name, moduleStyle: core.style,
      contentExt: extOf(meta.file), systemFiles: core.systemFiles,
      coreOptions: { ...(core.coreOptions || {}), ...(mouse?.coreOptions || {}) },
      inputDevices: mouse?.inputDevices,
      remapName: mouse?.remapName || core.remapName,
      execution: core.execution, requiresThreads: core.requiresThreads,
      coreBuildHash: core.buildHash,
      // Worker cores take their requested video size from opts.width/height,
      // falling back to the canvas's CURRENT size (WorkerEmulatorClient.js).
      // #emu carries width=320 height=240 as a placeholder, which would pin the
      // core to 320x240 and downscale its real output into an illegible mush —
      // DOSBox Pure's 640x400 text mode is unreadable that way. Main-thread
      // cores are unaffected: Emscripten sizes the canvas itself, and
      // FrameBridge still resizes to whatever each frame actually is.
      ...(core.execution === 'worker' ? { width: 640, height: 480 } : {}),
    });
  } catch (e) {
    // A mode switch can't be serviced in place (the canvas already has the
    // other context type), so say what actually fixes it rather than leaving a
    // bare error that looks like the core failed to load.
    if (e?.code === 'MODE_SWITCH_REQUIRED') {
      setStatus('Reload the page to switch between this core and the previous one');
      return false;
    }
    setStatus(`Failed to load: ${e?.message || e}`);
    return false;
  }
  booted = true;
  loadedMeta = meta;
  client.resume();
  showCanvas();
  applyInputScheme(meta.system);
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

// Raw physical key → the core, verbatim. Only fires on computer-class systems
// (SYSTEMS[sys].keyboard), where the RetroPad translation is useless: a DOS
// prompt needs `D`, `I`, `R`, Enter — not "Y button, then Start".
//
// Deliberately NOT forwarded to a netplay peer. The wire protocol carries logical
// RetroPad buttons (forwardGameInput takes {player, btn}), and there is no
// keyboard channel; a joined client on a DOS host keeps the mapped pad path, which
// is the honest behaviour rather than dropping keys silently at the host.
function onLocalRawKey(e, down) {
  if (!booted || role() === 'client') return;
  client.sendInput(down ? 'keydown' : 'keyup', e.code, e.key, e.keyCode, e.location);
}

const input = new DesktopInput({ onButton: onLocalButton, onRawKey: onLocalRawKey });

// --- mouse capture (pointer lock) --------------------------------------------
// A deliberate ~30-line reimplementation of MouseMgr.attachDesktop rather than an
// import of it: MouseMgr pulls in three.js for its in-VR positional path, and this
// page's entire premise is being three-free (importing it would add ~600 kB to a
// bundle that currently has none of it). The semantics below are the same ones
// attachDesktop uses and that PUAE was de-risk-verified against — relative
// movementX/Y, buttons as a 1=left/2=right bitmask, events only while locked.
let mouseWired = false;    // does the CURRENT boot have a libretro mouse device?
let mouseButtons = 0;

function sendMouse(dx, dy) {
  if (document.pointerLockElement !== canvas) return;
  if (!booted || role() === 'client') return;
  client.sendMouse(dx, dy, mouseButtons, null);
}

function requestCapture() {
  if (!mouseWired) return;
  try { canvas.requestPointerLock?.(); } catch (_) {}
}

document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  sendMouse(e.movementX || 0, e.movementY || 0);
});
document.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement !== canvas) return;
  const bit = e.button === 0 ? 1 : e.button === 2 ? 2 : 0;
  mouseButtons |= bit; sendMouse(0, 0);
});
document.addEventListener('mouseup', (e) => {
  if (document.pointerLockElement !== canvas) return;
  const bit = e.button === 0 ? 1 : e.button === 2 ? 2 : 0;
  mouseButtons &= ~bit; sendMouse(0, 0);
});
// A right-click inside a captured game belongs to the game, not to the browser.
canvas.addEventListener('contextmenu', (e) => { if (document.pointerLockElement === canvas) e.preventDefault(); });
canvas.addEventListener('click', requestCapture);
captureHint?.addEventListener('click', requestCapture);
// Esc drops the lock (the browser does this itself); re-show the hint so it's
// obvious how to get back in, and release any button held at that moment so it
// can't latch down inside the core forever.
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (!locked && mouseButtons) { mouseButtons = 0; client.sendMouse?.(0, 0, 0, null); }
  if (captureHint) captureHint.hidden = locked || !mouseWired;
});

// Apply the input scheme a freshly-booted system needs: raw keyboard for
// computer-class machines, mouse capture where a mouse device exists, and a
// footer hint describing whichever scheme is actually live.
function applyInputScheme(system) {
  const sys = SYSTEMS[system];
  const wantsKeyboard = !!sys?.keyboard;
  mouseWired = isMouseCapable(system);
  input.setRawKeyboard(wantsKeyboard);

  if (!mouseWired && document.pointerLockElement === canvas) {
    // Previous boot captured the cursor and this one has no use for it. Leaving
    // it captured reads as the page having hung.
    try { document.exitPointerLock?.(); } catch (_) {}
  }
  if (captureHint) captureHint.hidden = !mouseWired || document.pointerLockElement === canvas;

  if (controlsHint) {
    const parts = [];
    parts.push(wantsKeyboard
      ? '<b>Keyboard:</b> full passthrough — type as if at the real machine (Esc, F5/F6/F11/F12 and Ctrl/Alt combos stay with the browser)'
      : '<b>Keyboard:</b> Arrows = D-pad · Z/X = B/A · A/S = Y/X · Q/W = L/R · Enter = Start · Shift = Select');
    if (mouseWired) parts.push('<b>Mouse:</b> click the screen to capture · Esc releases');
    controlsHint.innerHTML = parts.join(' &nbsp;·&nbsp; ');
  }
}

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
    // Drop any pointer capture too: our core is paused, so a captured cursor
    // would be feeding a machine that isn't running.
    if (document.pointerLockElement === canvas) { try { document.exitPointerLock?.(); } catch (_) {} }
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
// Option values are indices into `games`, NOT positions in the <select>. That
// matters once the system filter can hide entries: keying off the option's own
// position would boot whatever game happened to sit at that slot in the
// filtered list.
gameSelect?.addEventListener('change', () => {
  const idx = Number(gameSelect.value);
  if (Number.isInteger(idx) && games[idx]) loadBundled(games[idx]);
});
systemSelect?.addEventListener('change', () => {
  renderGameList();
  // Reflect the choice in the URL so the page can be linked/reloaded on the
  // same machine. replaceState, not a navigation — reloading would drop a live
  // core and any netplay session.
  const url = new URL(location.href);
  if (systemSelect.value) url.searchParams.set('system', systemSelect.value);
  else url.searchParams.delete('system');
  history.replaceState(null, '', url);
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
  // Same `?experimental=1` gate index.html uses (Collection.js drops entries
  // whose system is flagged experimental). Without passing it, this page could
  // never show those systems at all, even deliberately.
  const col = await loadCollection(collectionUrl, { experimental: params.get('experimental') === '1' });
  games = col.games || [];

  // System list is derived from the games actually present, not from the whole
  // SYSTEMS registry — offering "Nintendo 64" when the collection has no N64
  // cartridge just produces an empty game list and a dead end.
  if (systemSelect) {
    const present = [...new Set(games.map((g) => g.system).filter(Boolean))]
      .sort((a, b) => (SYSTEMS[a]?.label || a).localeCompare(SYSTEMS[b]?.label || b));
    systemSelect.innerHTML = '<option value="">All systems</option>';
    for (const sys of present) {
      const opt = document.createElement('option');
      opt.value = sys;
      const n = games.filter((g) => g.system === sys).length;
      opt.textContent = `${SYSTEMS[sys]?.label || sys} (${n})`;
      systemSelect.appendChild(opt);
    }
    const wanted = params.get('system');
    if (wanted && present.includes(wanted)) systemSelect.value = wanted;
  }

  renderGameList();
  setStatus(games.length ? 'Pick a system, then a game — or drop a ROM file' : 'No bundled games found — drop a ROM file');
}

// (Re)fill the game <select> honouring the current system filter.
function renderGameList() {
  if (!gameSelect) return;
  const filter = systemSelect?.value || '';
  gameSelect.innerHTML = '<option value="">— pick a game —</option>';
  games.forEach((g, i) => {
    if (filter && g.system !== filter) return;
    const sysLabel = SYSTEMS[g.system]?.label || g.system || '';
    const opt = document.createElement('option');
    opt.value = String(i);
    // With a system filter active the label is redundant — every row is that
    // system — so drop it and let the titles use the width instead.
    opt.textContent = filter ? (g.title || g.file) : `${g.title || g.file} (${sysLabel})`;
    gameSelect.appendChild(opt);
  });
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
  // Input-scheme surface for probes: "is raw keyboard live / is a mouse device
  // wired / is the pointer actually captured" are the three things that decide
  // whether a DOS or Amiga boot is controllable at all, and none of them are
  // visible from the DOM.
  input: () => ({
    rawKeyboard: input.rawKeyboard,
    mouseWired,
    pointerLocked: document.pointerLockElement === canvas,
    system: loadedMeta?.system ?? null,
  }),
  // Test hooks: pointer lock needs a real user gesture, which a headless probe
  // cannot produce, so these let one exercise the transport directly.
  __sendMouse: (dx, dy, buttons = 0) => client.sendMouse(dx, dy, buttons, null),
  __sendRawKey: (code, key, down) => client.sendInput(down ? 'keydown' : 'keyup', code, key, 0, 0),
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
