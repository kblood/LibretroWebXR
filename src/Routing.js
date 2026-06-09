// Pure local-multiplayer routing policy: which player each held gamepad's
// controller drives this frame, and with which half (holding/free) of the
// system map. Extracted from main.js so `npm test` can exercise the REAL
// routing logic without THREE / a WebXR runtime (a real headset is only needed
// for the live XR gamepads, not for this decision).
//
// Consumers: [[src/GameInputMgr.js]] reads the returned routing to dispatch each
// player's RetroPad keys; main.js wires it to live grab + [[src/CableMgr.js]]
// state via the injected accessors below.
//
// Policy (unchanged from the original inline computeRouting):
//   - no held gamepad        → []                 (nothing forwards input)
//   - exactly one held       → that gamepad's player drives BOTH hands
//                              (holding hand + any free controller), preserving
//                              the two-hands-one-player feel for >4-button systems
//   - two or more held       → each holding hand drives only its own gamepad's
//                              player (couch co-op)

/**
 * @param {object} deps
 * @param {Iterable} deps.controllers        live controllers (scene.controllers)
 * @param {(ctrl)=>object|null} deps.heldObject       grabbed object for a controller
 * @param {(ctrl)=>boolean}     deps.isControllerFree  controller holds nothing
 * @param {(cableId)=>number}   deps.playerOf          port→player for a gamepad id
 * @returns {Array<{ctrl:object, player:number, hand:'holding'|'free'}>}
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
    const player = playerOf(obj.userData.cableId);
    const routing = [{ ctrl: holdCtrl, player, hand: 'holding' }];
    for (const ctrl of controllers) {
      if (ctrl !== holdCtrl && isControllerFree(ctrl)) {
        routing.push({ ctrl, player, hand: 'free' });
      }
    }
    return routing;
  }

  return held.map(({ ctrl, obj }) => ({
    ctrl, player: playerOf(obj.userData.cableId), hand: 'holding',
  }));
}
