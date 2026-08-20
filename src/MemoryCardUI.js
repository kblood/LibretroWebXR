// Memory cards (save states): the wall-mounted rack, its four grabbable cards,
// and the whole save/load transaction behind inserting one into the console.
//
// Extracted from src/main.js (the P2 #12 / §3.1 extraction plan, step 1). It
// was picked to go first because it is the only candidate region that writes to
// nothing outside itself: `memoryCards` was a main.js module global referenced
// only from in here, so it moved out and stopped being a global at all.
//
// ⚠ THE MOVE IS NOT VERBATIM, AND THE TWO DIFFERENCES ARE DELIBERATE FIXES.
// This header used to claim "the same code, moved", which was wrong twice over
// and hid a user-visible behaviour change inside what read as a refactor. What
// actually changed, both in handleMemoryCardInserted below:
//
//   1. THE SAVE BRANCH captures `ownerClient`/`ownerMeta` BEFORE its
//      serializeState() await instead of reading main.js's live `client` /
//      `currentMeta` after it. Pre-move, a boot landing mid-save stamped Game
//      B's core/file/title onto Game A's bytes; post-move the record describes
//      the game the bytes actually came from. This is the ARC-2(c)
//      save-identity fix — a save written across that interleaving now has
//      DIFFERENT contents than HEAD wrote, on purpose.
//   2. THE LOAD BRANCH consults a boot epoch captured before its IndexedDB read
//      and REFUSES (with a status line) a state whose console rebooted while
//      the read was in flight. Pre-move it unserialised into whatever core
//      happened to be running by then. This too is the fix, not an accident:
//      the whole point is that a save state belongs to one boot of one game.
//
// Anyone diffing this file against `git show HEAD:src/main.js` will find those
// two, and only those two. Everything else is the same code, moved.
//
// WHY `getClient`/`getMeta` ARE GETTERS AND NOT VALUES: main.js's `client` and
// `currentMeta` are REASSIGNED by every boot path, so a value captured once at
// construction would be permanently stale, and a live shared reference is the
// save-identity race documented at length in handleMemoryCardInserted below.
// Getters are what let each transaction capture its own owner at the instant it
// starts — which is both the fix and the thing the test can drive.
//
// `getGrabMgr` IS A GETTER FOR THE SAME REASON, and it is the easy one to get
// wrong: main.js's `grabMgr` is a reassignable `let` that is still null when
// several neighbouring modules are constructed, and buildMemoryCards() runs
// long after construction. Passing the VALUE happened to work only because
// `grabMgr = new GrabMgr(...)` appears exactly once in main.js; the first world
// rebuild that constructs a second one would have left these four cards
// registered on the dead manager and silently ungrabbable, with no error. Same
// rule as ConsoleRegistry's getGrabMgr and PowerMgr's getMenuMgr.
//
// `captureBootEpoch`/`CONSOLE_ID` are injected for the same reason: the epoch
// counters live in main.js (they order boots across the whole rack), and the
// load branch has to consult them after its await.

import * as THREE from 'three';
import { createMemoryCard } from './MemoryCard.js';
import { saveState, loadState, listStates, checkSaveStateCompatibility } from './SaveState.js';

export function createMemoryCardUI({ scene, getGrabMgr, setStatus, getClient, getMeta, captureBootEpoch, CONSOLE_ID }) {
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
      getGrabMgr().addGrabbable(card);
      memoryCards.push(card);
    }
  }

  function handleMemoryCardInserted(card) {
    const meta = card.userData.savedMeta;
    // Empty card → save current game state.
    if (!meta) {
      if (!getMeta()) {
        setStatus('insert a cartridge first');
        card.userData.pulse(0xcc2222);
        return false;
      }
      // ARC-1 / §3.1 — THE SAVE-IDENTITY RACE. Capture WHO this transaction
      // belongs to here, BEFORE the await, and read the capture (never the module
      // globals) everywhere below.
      //
      // `client` and `currentMeta` are reassigned by every boot path
      // (bootOnPrimary, rebootPrimaryConsole, loadCartridgeIntoConsole), and
      // serializeState() on a worker-execution core crosses the worker boundary —
      // a PSX/PS2 round-trip is hundreds of milliseconds. Insert a card while Game
      // A is running, drop Game B's cartridge in during that window, and the .then
      // used to write Game A's state BYTES stamped with Game B's core/file/title.
      // Nothing downstream can catch that: the identity guard below and
      // checkSaveStateCompatibility both PASS, because the record claims to be B —
      // so A's state is fed to B's core on the next load.
      //
      // Same class, and the same rule, as COR-6 in [[src/SaveRamGuard.js]]: saved
      // bytes belong to the runtime that MADE them, not to whatever is running
      // when the write lands.
      const ownerClient = getClient();
      const ownerMeta = getMeta();
      if (!ownerClient.canSerialize?.()) {
        setStatus(`${ownerMeta.core} core has no save-state support`);
        card.userData.pulse(0xcc2222);
        return false;
      }
      setStatus(`saving ${ownerMeta.title} to slot ${card.userData.slot}…`);
      // Deliberately NOT guarded by the boot epoch: these bytes are real and now
      // correctly attributed, so a boot landing mid-save is no reason to throw the
      // save away — the user asked for it and the card is this transaction's own
      // state, not shared state. Capturing the identity is the whole fix here.
      ownerClient.serializeState().then((data) => {
        const payload = {
          data,
          core: ownerMeta.core,
          file: ownerMeta.file,
          title: ownerMeta.title,
          system: ownerMeta.system,
          ts: Date.now(),
        };
        return saveState(`slot-${card.userData.slot}`, payload).then(() => {
          card.userData.setSaved({ ...ownerMeta, ts: payload.ts });
          card.userData.pulse(0xffffff);
          setStatus(`saved ${ownerMeta.title} to slot ${card.userData.slot}`);
        });
      }).catch((e) => {
        console.warn('[main] save failed:', e);
        setStatus(`save failed: ${e.message || e}`);
        card.userData.pulse(0xcc2222);
      });
      return true;
    }

    // The same capture as the save branch, for the same reason (ARC-1): every read
    // after the IndexedDB await must describe the game this insert was made
    // against, not whatever booted in the meantime.
    const ownerClient = getClient();
    const ownerMeta = getMeta();
    // …plus a boot-epoch guard, which the save branch does not need. Unserializing
    // is a WRITE into a live core, so it is exactly the kind of continuation
    // ARC-2(c) says must be abandoned when its boot is gone. Capturing alone is not
    // enough in this direction: a live reboot replaces `client` with a fresh
    // object, so the captured one is a RETIRED core; and when the new game happens
    // to run the same core, checkSaveStateCompatibility still says yes, so the
    // stale state would be pushed into the wrong running game.
    const supersededByNewerBoot = captureBootEpoch(CONSOLE_ID);
    // Filled card → only loads if the current game matches what was saved.
    // Loading a save from a different ROM would corrupt state; the cleanest
    // refusal here is a red pulse + bounce.
    if (!ownerMeta || ownerMeta.file !== meta.file || ownerMeta.core !== meta.core) {
      setStatus(`slot ${card.userData.slot} holds ${meta.title}; load that cart first`);
      card.userData.pulse(0xcc2222);
      return false;
    }
    if (!ownerClient.canSerialize?.()) {
      setStatus(`${ownerMeta.core} core has no save-state support`);
      card.userData.pulse(0xcc2222);
      return false;
    }
    setStatus(`loading slot ${card.userData.slot}…`);
    loadState(`slot-${card.userData.slot}`).then((row) => {
      if (supersededByNewerBoot()) {
        setStatus(`slot ${card.userData.slot} not loaded — the console rebooted`);
        card.userData.pulse(0xcc2222);
        return;
      }
      if (!row?.data) {
        setStatus(`slot ${card.userData.slot} empty`);
        card.userData.pulse(0xcc2222);
        return;
      }
      // Filename+core already narrowed the obvious mismatch above; this catches
      // the subtler case a PSX-JIT core rebuild introduces — a state saved
      // against one build_hash isn't guaranteed binary-compatible with another.
      const compat = checkSaveStateCompatibility(row, { coreId: ownerMeta.core, coreBuildHash: ownerClient.buildHash });
      if (!compat.compatible) {
        setStatus(`slot ${card.userData.slot} incompatible with the loaded core build (${compat.reason})`);
        card.userData.pulse(0xcc2222);
        return;
      }
      return ownerClient.unserializeState(row.data).then(() => {
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

  return { build: buildMemoryCards, handleInsert: handleMemoryCardInserted };
}
