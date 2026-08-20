// A room descriptor's peripheral cableId must survive the rebuild.
//
// THE BUG THIS PINS. A peer that adopts the host's room layout RELOADS and
// rebuilds every prop through RoomBuilder.buildProp. The descriptor carries the
// cableId each port binding is keyed by (`gun:<cableId>` / `mouse:<cableId>` /
// `gamepad:<cableId>` STATE), but buildProp used to drop it — so main.js's
// _registerPeripheral minted a FRESH local id, the peer-scoped key in the
// snapshot matched nothing, and _reconcileGunState skipped that gun for ever.
// A late joiner saw the gun mesh and never its port. Peers already in the room
// were unaffected (their copy comes from _createRemoteProp, which has always
// adopted payload.cableId), which is why only the late-join arm of
// scripts/smoke-mp-sync.mjs ever caught it — and that suite is opt-in.
//
// The other half of the fix lives in main.js (registering descriptor-authored
// peripherals after buildRoom) and is covered by that smoke; this suite pins the
// half that is pure logic.
//
// TIER: pure logic. Imports three + RoomBuilder, binds nothing, needs no browser.
import { buildProp } from '../src/RoomBuilder.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  FAIL: ${msg}`); } };

// buildProp only needs somewhere to put the object.
const fakeScene = () => { const added = []; return { added, addObject: (o) => added.push(o) }; };
const build = (prop) => {
  const scene = fakeScene();
  const r = buildProp({ pos: [0, 0.78, -2], rot: [0, 0, 0], ...prop }, { scene, collections: { list: [] } });
  return { r, scene };
};

// 'gamepad' is the third port-bound kind and takes the same adoptCableId path,
// but createGamepad() paints its button labels on a DOM canvas, so it cannot be
// built in this tier at all. It is covered by scripts/smoke-mp-sync.mjs instead —
// noted here so the gap is visible rather than looking like an oversight.
const PORT_BOUND = ['lightgun', 'mouse'];

console.log('--- a descriptor cableId is adopted onto the built object ---');
for (const type of PORT_BOUND) {
  const cableId = `${type}-peer-abc-1`;
  const { r } = build({ type, cableId });
  ok(r?.object != null, `${type}: buildProp returned an object`);
  ok(r?.object?.userData?.cableId === cableId,
    `${type}: descriptor cableId is carried onto the object (got ${JSON.stringify(r?.object?.userData?.cableId)})`);
}

console.log('--- a descriptor WITHOUT one is left for _registerPeripheral to mint ---');
// The other half of the contract, and the half a careless "just always set it"
// fix would break: every room.json on disk omits cableId, and main.js's
// _registerPeripheral only mints an id when userData.cableId is null. If buildProp
// ever wrote a placeholder here, the default gun/mouse would stop being gun-1 /
// mouse-1 and every local room would renumber its peripherals.
for (const type of PORT_BOUND) {
  const { r } = build({ type });
  ok(r?.object?.userData?.cableId == null,
    `${type}: no descriptor cableId → object carries none (got ${JSON.stringify(r?.object?.userData?.cableId)})`);
}

console.log('--- a non-peripheral prop is unaffected ---');
{
  // 'table', not 'console': createConsole paints DOM-canvas labels too.
  const { r } = build({ type: 'table', cableId: 'should-be-ignored' });
  ok(r?.kind === 'table', 'table prop still builds');
  ok(r?.object?.userData?.cableId !== 'should-be-ignored',
    'a cableId on a non-port-bound prop is not adopted');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
