// Pure local-multiplayer routing policy: which console+player each held
// gamepad's controller drives this frame, and with which half (holding/free) of
// the system map. Extracted from main.js so `npm test` can exercise the REAL
// routing logic without THREE / a WebXR runtime (a real headset is only needed
// for the live XR gamepads, not for this decision).
//
// Consumers: [[src/GameInputMgr.js]] reads the returned routing to dispatch each
// player's RetroPad keys; main.js wires it to live grab + [[src/Patchbay.js]]
// state via the injected accessors below.
//
// Policy:
//   - no held gamepad        → []                 (nothing forwards input)
//   - exactly one held       → resolve its seat via playerOf(cableId):
//       • null (unplugged)   → [] (drives NOTHING — no silent player-1 fallback)
//       • non-null           → holding hand + every free controller all drive
//                              {seat.consoleId, seat.player}, preserving the
//                              two-hands-one-player feel for >4-button systems
//   - two or more held       → each holding hand drives only its own gamepad's
//                              seat; held gamepads whose seat is null (unplugged)
//                              are silently skipped (couch co-op)

/**
 * @param {object} deps
 * @param {Iterable}            deps.controllers      live controllers (scene.controllers)
 * @param {(ctrl)=>object|null} deps.heldObject       grabbed object for a controller
 * @param {(ctrl)=>boolean}     deps.isControllerFree controller holds nothing
 * @param {(cableId)=>{consoleId:string, player:number}|null} deps.playerOf
 *   Resolves a gamepad cable-id to the console+player it is plugged into, or
 *   null if the gamepad is not plugged into any console port.
 * @returns {Array<{ctrl:object, consoleId:string, player:number, hand:'holding'|'free'}>}
 */
export function computeRouting({ controllers, heldObject, isControllerFree, playerOf }) {
  const held = [];
  for (const ctrl of controllers) {
    const obj = heldObject(ctrl);
    if (obj?.userData?.kind === 'gamepad') held.push({ ctrl, obj });
  }
  if (held.length === 0) return [];

  if (held.length === 1) {
    const { ctrl: holdCtrl, obj } = held[0];
    const seat = playerOf(obj.userData.cableId);
    if (seat == null) return [];   // unplugged — drives nothing (bug fix)
    const { consoleId, player } = seat;
    const routing = [{ ctrl: holdCtrl, consoleId, player, hand: 'holding' }];
    for (const ctrl of controllers) {
      if (ctrl !== holdCtrl && isControllerFree(ctrl)) {
        routing.push({ ctrl, consoleId, player, hand: 'free' });
      }
    }
    return routing;
  }

  // Two or more held: each drives its own seat; skip unplugged ones.
  const routing = [];
  for (const { ctrl, obj } of held) {
    const seat = playerOf(obj.userData.cableId);
    if (seat == null) continue;    // unplugged controller contributes nothing
    routing.push({ ctrl, consoleId: seat.consoleId, player: seat.player, hand: 'holding' });
  }
  return routing;
}
