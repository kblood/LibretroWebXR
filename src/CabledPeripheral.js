// CabledPeripheral: ONE table describing the three PORT-BOUND peripherals —
// the gamepad, the light gun and the mouse (CLAUDE_REVIEW §3.3).
//
// Why this file exists. Those three devices were three hand-maintained copies
// of the same machinery: three near-identical ghost managers (a normalised diff
// of GhostLightGunMgr against GhostMouseMgr was 57 lines), five mirrored
// function PAIRS in [[src/systems.js]], and a mirrored arm/disarm/register/port
// path in main.js. Every copy is a place a fix can land on one device and miss
// the others, which is exactly how the arming-leak and gun-aim-align bugs each
// had to be hand-ported a second time. The descriptor below is the single seam:
// [[src/GhostPeripheralMgr.js]] is parameterised by it, main.js's
// arm/disarm/register/port helpers take one as their first argument, and
// [[src/GrabMgr.js]]'s NETWORK_LOCKABLE_KINDS is derived from it.
//
// What this file deliberately does NOT do:
//   • It does not MOVE the per-system registry logic. `capableFor`,
//     `deviceFor`, `loadConfigFor`, `twoPortsFor` and `libretroPortFor` are
//     REFERENCES to the functions that still live in [[src/systems.js]] — that
//     is where the hardware knowledge (SNES Justifier ports, VICE's
//     coreOptions-driven mouse, the `broken:` gates) is documented, and moving
//     it would have buried it.
//   • It does not fold in [[src/GhostCartMgr.js]]. A cartridge is not
//     port-bound and cannot be armed; it shares the ghost-mesh shape and
//     nothing else, so folding it in would be forcing a fit.
//   • It does not flatten a per-device difference into a shared default. Where
//     the three genuinely differ — the gamepad's per-player emissive ghost tint
//     and its live button mirroring, the gun's two-gun co-op ports, the fact
//     that a gamepad is never "armed" at all — the difference is a FIELD here,
//     visible in one place, rather than a divergence between three files.

import * as THREE from 'three';
import { createGamepad } from './Gamepad.js';
import { createLightGun } from './LightGun.js';
import { createMouse } from './Mouse.js';
import {
  isLightgunCapable, lightgunForSystem, lightgunLoadConfig,
  twoGunPortsForSystem, libretroGunPortFor,
  isMouseCapable, mouseForSystem, mouseLoadConfig,
  twoMousePortsForSystem, libretroMousePortFor,
} from './systems.js';

// ── Ghost mesh tints ────────────────────────────────────────────────────────
// Each of these is the `_tintGhost` body from the manager it came from, moved
// verbatim. They are descriptor fields (not one shared function) because the
// gamepad's tint is genuinely different: it encodes WHICH PLAYER the pad drives.

// Make a full gamepad mesh read as a "ghost": semi-transparent, with the body
// emissively tinted by which port/player the pad drives (matching the cord
// colours). createGamepad builds fresh per-instance materials, so mutating them
// here never touches the real local pad.
function tintGamepadGhost(group, cableId) {
  const PLAYER_COLORS = [0x33cc55, 0x3388ff, 0xffaa33, 0xcc55dd];
  const m = cableId.match(/^gp-(\d+)$/);          // cableId is 'gp-N', port = N-1
  const port = m ? (parseInt(m[1], 10) - 1) : 0;
  const tint = new THREE.Color(PLAYER_COLORS[port % PLAYER_COLORS.length]);
  group.traverse((o) => {
    const mat = o.material;
    if (!mat) return;
    for (const mm of Array.isArray(mat) ? mat : [mat]) {
      mm.transparent = true;
      mm.opacity = 0.7;
      mm.depthWrite = false;
      if (mm.emissive) { mm.emissive.copy(tint); mm.emissiveIntensity = Math.max(mm.emissiveIntensity ?? 0, 0.35); }
    }
  });
}

// Semi-transparent, so a ghost reads as "someone else's gun/mouse" even though
// it's built from the same create*() geometry as the real prop. Those factories
// build fresh per-instance materials, so mutating them here never touches any
// other prop (real or ghost).
function tintPlainGhost(group) {
  group.traverse((o) => {
    const mat = o.material;
    if (!mat) return;
    for (const mm of Array.isArray(mat) ? mat : [mat]) {
      mm.transparent = true;
      mm.opacity = 0.7;
      mm.depthWrite = false;
    }
  });
}

/**
 * The gamepad. The only one of the three that is never "armed": a pad needs no
 * core reboot to attach (it is the core's default device), so `sessionKey`,
 * `armKey` and `wireDevice` are null and main.js's armPeripheral/disarmPeripheral
 * are never called with this descriptor. It is also the only one whose live
 * INPUT is mirrored to remote peers (the 'gp' wire channel → applyInput).
 */
export const GAMEPAD = Object.freeze({
  id: 'gamepad',
  kind: 'gamepad',            // userData.kind on the in-world prop
  label: 'gamepad',           // how a status line names it in full
  shortLabel: 'gamepad',      // …and in the terser status lines
  metaFlag: null,             // the ROM meta / pending-boot flag that declares it
  // Prefix used for gamepad hold keys (lives in the `hold:` namespace so the Hub
  // auto-clears these when the owner disconnects, freeing the gamepad for others).
  holdKeyPrefix: 'gp:',
  cableIdPrefix: 'gp-',       // default ids are gp-1, gp-2, … (deterministic per peer)

  // No systems.js registry pair: every system takes gamepads, and the port
  // comes from the Patchbay rather than a per-system descriptor.
  capableFor: null,
  deviceFor: null,
  loadConfigFor: null,
  twoPortsFor: null,
  libretroPortFor: null,

  ghostFactory: createGamepad,
  ghostHandOffset: new THREE.Vector3(0, 0, -0.06),      // just past the hand cone
  ghostHeadOffset: new THREE.Vector3(0.2, -0.1, -0.18), // desktop fallback
  tintGhost: tintGamepadGhost,
  // A real gamepad mesh (not a bare box) so a remote peer's button presses
  // animate on the ghost — driven by applyInput() from the 'gp' wire channel.
  mirrorsInput: true,

  sessionKey: null,
  armKey: null,
  wireDevice: null,
});

/**
 * The light gun — the project's flagship peripheral (NES Zapper, SNES Super
 * Scope / Justifier, SMS Light Phaser, MD Menacer, Amiga Phazer, PS2 GunCon2),
 * every one of them validated by hand on a headset against a real core.
 *
 * Two hardware facts the registry functions referenced here encode, and that
 * nothing in this file may smooth away:
 *   • Two-gun co-op (SNES Justifier) seats its guns on the libretro ports listed
 *     in the system's `lightgun2.ports` — NOT on cable ports — and the hardware
 *     multiplexes the two guns off a single PPU latch at 30Hz per gun. That is
 *     `twoPortsFor` + `libretroPortFor`, and it is why a gun's JACK decides its
 *     player. See docs/LIGHTGUN_SUPPORT.md.
 *   • The Amiga Phazer's trigger is the MOUSE button, not the LIGHTGUN trigger
 *     id, and UAE only arms the beam on RELATIVE motion. That lives in the
 *     system's own descriptor + [[src/LightGunMgr.js]]; the arm path here just
 *     boots the core with whatever `loadConfigFor` returns.
 *
 * `loadConfigFor` is lightgunLoadConfig, which takes `{ twoGun, allowBroken }` —
 * see the caller in main.js for why allowBroken must be threaded symmetrically.
 */
export const LIGHTGUN = Object.freeze({
  id: 'lightgun',
  kind: 'lightgun',
  // Two labels because the shipped status lines use two: "no light gun
  // connected" but "gun disarmed". Kept apart so collapsing the arm/disarm
  // pair did not silently reword either of them.
  label: 'light gun',
  shortLabel: 'gun',
  metaFlag: 'lightgun',       // meta.lightgun — a curated gun title keeps its gun
  // Prefix used for gun hold keys (lives in the `hold:` namespace so the Hub
  // auto-clears these when the owner disconnects, freeing the gun for others).
  // Distinct from [[src/net/GunSync.js]]'s bare `gun:<cableId>` port-binding
  // channel — that one has no `hold:` prefix, so the two never collide.
  holdKeyPrefix: 'gun:',
  cableIdPrefix: 'gun-',      // the default boot gun is `gun-1` on every peer

  capableFor: isLightgunCapable,
  deviceFor: lightgunForSystem,
  loadConfigFor: lightgunLoadConfig,
  twoPortsFor: twoGunPortsForSystem,
  libretroPortFor: libretroGunPortFor,

  ghostFactory: createLightGun,
  ghostHandOffset: new THREE.Vector3(0, 0, -0.05),     // just past the hand cone
  ghostHeadOffset: new THREE.Vector3(0.2, -0.1, -0.2), // desktop fallback
  tintGhost: tintPlainGhost,
  // One deliberate scope limit: unlike a gamepad's button state (mirrored via
  // the 'gp' wire channel), a remote gun's trigger-pull / muzzle-flash is NOT
  // mirrored — the ghost covers presence and aim direction only, not live fire.
  mirrorsInput: false,

  // sessionStorage: the sticky "armed" flag. THIS DESCRIPTOR IS THE ONLY PLACE
  // THE KEY IS SPELLED — main.js writes it, removes it AND reads it back at
  // startup through `desc.sessionKey`. It used to keep a second literal copy for
  // the startup read, which would have silently dropped the armed device (or
  // resurrected a stale one) the first time this string was renamed here.
  sessionKey: 'libretrowebxr.lightgun',
  armKey: '__lightgunArmed',             // the window flag that same state sets
  wireDevice: 'gun',                     // 'peripheral' wire device name (host apply)
});

/**
 * The mouse (Amiga, DOS, SNES, C64/VIC-20). Feeds RELATIVE motion (dx,dy) + L/R
 * buttons into RETRO_DEVICE_MOUSE on a port instead of an absolute aim. A
 * two-mouse variant seats a mouse on each of two ports for split-pointer
 * 2-player (Amiga) — the mouse analogue of the two-gun ports above.
 */
export const MOUSE = Object.freeze({
  id: 'mouse',
  kind: 'mouse',
  label: 'mouse',
  shortLabel: 'mouse',
  metaFlag: 'mouse',          // meta.mouse — a curated mouse title keeps its mouse
  // Prefix used for mouse hold keys (lives in the `hold:` namespace so the Hub
  // auto-clears these when the owner disconnects, freeing the mouse for others).
  // Distinct from the bare `mouse:<cableId>` port-binding channel — that one has
  // no `hold:` prefix, so the two never collide.
  holdKeyPrefix: 'mouse:',
  cableIdPrefix: 'mouse-',    // the default boot mouse is `mouse-1` on every peer

  capableFor: isMouseCapable,
  deviceFor: mouseForSystem,
  loadConfigFor: mouseLoadConfig,
  twoPortsFor: twoMousePortsForSystem,
  libretroPortFor: libretroMousePortFor,

  ghostFactory: createMouse,
  ghostHandOffset: new THREE.Vector3(0, 0, -0.05),     // just past the hand cone
  ghostHeadOffset: new THREE.Vector3(0.2, -0.1, -0.2), // desktop fallback
  tintGhost: tintPlainGhost,
  // Same deliberate scope limit as the gun: a remote peer's live cursor motion /
  // button state is NOT mirrored — presence and hand-pose only.
  mirrorsInput: false,

  sessionKey: 'libretrowebxr.mouse',
  armKey: '__mouseArmed',
  wireDevice: 'mouse',
});

/**
 * Every port-bound peripheral, in the order the ghost-sync slices and the
 * ghost managers are wired in main.js. Derive lists from THIS — a fourth
 * port-bound device should cost one entry here, not a fourth copy of anything.
 */
export const CABLED_PERIPHERALS = Object.freeze([GAMEPAD, LIGHTGUN, MOUSE]);

/** The armable subset (everything with a session flag): gun + mouse. */
export const ARMABLE_PERIPHERALS = Object.freeze(
  CABLED_PERIPHERALS.filter((d) => d.sessionKey != null),
);

/** Descriptor for an in-world prop's `userData.kind`, or null. */
export function peripheralForKind(kind) {
  return CABLED_PERIPHERALS.find((d) => d.kind === kind) || null;
}

// ── Hold-key helpers ────────────────────────────────────────────────────────
// One implementation of what used to be three identical make/is/cableIdFrom
// triples. The per-device wrappers the rest of the app already imports
// (makeGunHoldKey and friends) are thin aliases in the Ghost*Mgr shims.

/** STATE key for holding the peripheral with the given cableId. */
export function makeHoldKeyFor(desc, cableId) {
  return `hold:${desc.holdKeyPrefix}${cableId}`;
}

/** True if a STATE key refers to a held peripheral of this kind. */
export function isHoldKeyFor(desc, key) {
  return typeof key === 'string' && key.startsWith(`hold:${desc.holdKeyPrefix}`);
}

/** Extract the cableId from such a hold key, or null. */
export function cableIdFromHoldKeyFor(desc, key) {
  if (!isHoldKeyFor(desc, key)) return null;
  return key.slice(`hold:${desc.holdKeyPrefix}`.length);
}
