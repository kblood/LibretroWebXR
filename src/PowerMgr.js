// In-world power / reset switches for every console and TV in the rack, plus
// the network sync that makes a toggle by ANY peer land everywhere.
//
// Extracted VERBATIM from src/main.js (the P2 #12 / §3.1 extraction plan, step
// 2, following [[src/ConsoleRegistry.js]]'s prerequisite hoist). The code below
// is the same code, moved: same order, same comments, same behaviour. It was
// picked as the second region because — like MemoryCardUI before it — it writes
// to nothing outside itself: `consolePowered`/`tvPowered` are now owned by the
// registry, and `_ctrlBtnTextures`, `makeControlButton`, `_tintPowerBtn` and
// `powerStateKey` had no callers outside this block at all, so they became
// module-private here and stopped being main.js globals.
//
// THE ONLY EDITS MADE WHILE MOVING (seven, all mechanical, all forced by the
// move itself): `net?.` → `getNet()?.` twice, `!menuMgr` → `!getMenuMgr()`
// twice, and `menuMgr.addItem` → `getMenuMgr().addItem` three times. Both are
// reassigned `let`s in main.js — `net` by every connect/disconnect, `menuMgr`
// once when buildCartridgeWorld runs — so a value captured at construction would
// be a permanently-stale null and every switch would be dead. Same reason
// MemoryCardUI takes `getClient`/`getMeta` as getters. Everything else that is
// injected (`scene`, `audioRouter`, `rackMgr`, `routeVideo`, `persistRack`,
// `logger`) is a const in main.js and is passed by value.
//
// BE CAREFUL HERE — two of the nine exports are load-bearing beyond this file:
// `isPowerStateKey` is the predicate that classifies the `power:` STATE keys
// (host-authoritative, part of the do-not-break key ACL), and `_applyRemotePower`
// is a REMOTE-INPUT path — it parses a key that arrived off the wire. Neither the
// key format (`power:<kind>:<id>`) nor the parsing may drift.

import * as THREE from 'three';

export function createPowerMgr({
  registry, scene, getNet, getMenuMgr, audioRouter, rackMgr, routeVideo, persistRack, logger,
}) {
  const { consolePowered, tvPowered, isConsoleOn, isTvOn, consoleObjs } = registry;

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
    const wasOn = isConsoleOn(consoleId);
    consolePowered.set(consoleId, on);
    const rt = rackMgr.get(consoleId);
    if (on) {
      // A power switch isn't a pause button: a real console has no battery
      // backing its running state, so flipping OFF then ON again is a cold
      // boot, not a resume-from-suspend. Only reset on an actual off->on
      // transition — this also fires right after a fresh ROM load (which marks
      // the console "on"), and re-resetting a console that never went off
      // would be a surprise flicker. RESET stays the separate in-game action.
      if (!wasOn) rt?.client?.reset?.();
      rt?.resume?.();
    } else {
      rt?.pause?.();
    }
    // Force silence regardless of whether this core's build honours
    // pauseMainLoop — a solo console never gets muted by audio focus (see
    // [[src/SpatialAudio.js]]), so without this "off" could still be audible.
    audioRouter?.setPower?.(consoleId, on);
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

  function _broadcastPower(kind, id, on) { getNet()?.setObjectState(powerStateKey(kind, id), { on: !!on }); }
  function _broadcastReset(consoleId) { getNet()?.sendWire('reset', { consoleId }); }

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
    if (!conObj || !getMenuMgr() || conObj.userData._hasControls) return;
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
    getMenuMgr().addItem(pwr, () => {
      const on = !isConsoleOn(consoleId);
      setConsolePower(consoleId, on, pwr);
      _broadcastPower('console', consoleId, on);     // sync to the room
    });
    getMenuMgr().addItem(rst, () => {
      resetConsole(consoleId);
      _broadcastReset(consoleId);                    // sync to the room (host re-runs its core)
    });
  }

  // Mount a power switch on a TV's lower-right front face and wire it through
  // MenuMgr. TV cabinet is 2.2×1.65; the video-in jack sits lower-LEFT, so the
  // switch goes lower-right to avoid it.
  function addTvControls(tvId, tv) {
    if (!tv?.group || !getMenuMgr() || tv.group.userData._hasControls) return;
    tv.group.userData._hasControls = true;
    const on = isTvOn(tvId);
    const pwr = makeControlButton(on ? 'ON' : 'OFF', { w: 0.16, h: 0.07, color: on ? '#2a6e2a' : '#7a2222' });
    pwr.position.set(2.2 / 2 - 0.2, -1.65 / 2 + 0.14, 0.03);
    tv.group.add(pwr);
    tv.group.userData.powerBtn = pwr;
    getMenuMgr().addItem(pwr, () => {
      const on = !isTvOn(tvId);
      setTvPower(tvId, on, pwr);
      _broadcastPower('tv', tvId, on);               // sync to the room
    });
  }

  return {
    setConsolePower, setTvPower, isPowerStateKey, _broadcastPower, _broadcastReset,
    resetConsole, _applyRemotePower, addConsoleControls, addTvControls,
  };
}
