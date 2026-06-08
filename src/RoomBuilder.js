// RoomBuilder — imperative side of the room layer. Takes a parsed room
// descriptor ([[src/RoomLoader.js]]) plus the already-loaded collections and
// drives the EXISTING scene factories (createShelf/Console/Cartridge/Gamepad)
// declaratively, instead of main.js placing them by hand. Posters, models and
// portals are built inline (no dedicated factory yet). Environment surfaces +
// lighting are delegated to SceneMgr.applyEnvironment.
//
// It returns only the handles main.js needs to keep wiring grab/input/menus:
//   { consoleObj, gamepadObj, cartridges, portals, shelves }
// — everything else (managers, tick callbacks, save states) stays in main.js,
// so this is a thin declarative front-end, not a rewrite. See ROADMAP Phase R.

import * as THREE from 'three';
import { createCartridge } from './Cartridge.js';
import { createShelf, lockShelfHomes } from './Shelf.js';
import { createConsole } from './Console.js';
import { createGamepad } from './Gamepad.js';
import { createBookcase, createCupboard, createTable } from './Furniture.js';

const DEG = Math.PI / 180;
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const applyRot = (obj, rot) => obj.rotation.set(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG);

// Tiny built-in palette so a room can say `builtin:retro-blue` without
// shipping a texture. Extend freely; unknown names fall back to mid-grey.
const BUILTIN_COLORS = {
  'retro-blue':  '#26344f',
  'retro-green': '#2c4a32',
  'retro-pink':  '#4a2c3e',
  'crt-grey':    '#26262e',
  'poster-1':    '#3a2c4a',
  'poster-2':    '#2c3a4a',
};

/**
 * Resolve which games land on a shelf:
 *  - `prop.collection` selects a loaded collection by url or id (else the
 *    room's first collection);
 *  - `prop.filter` keeps games whose fields equal the given values
 *    (e.g. { system: 'nes' });
 *  - `prop.slice` then `[start, end]`-slices;
 *  - `prop.half: 'left'|'right'` splits what remains in two (default-room
 *    layout hint — reproduces the old two-shelf split for any game count).
 */
function gamesForShelf(prop, collections) {
  const col = (prop.collection && collections.byKey.get(prop.collection)) || collections.list[0];
  let games = col ? col.games.slice() : [];
  if (prop.filter && typeof prop.filter === 'object') {
    games = games.filter((g) => Object.entries(prop.filter).every(([k, val]) => g[k] === val));
  }
  if (Array.isArray(prop.slice)) games = games.slice(prop.slice[0] ?? 0, prop.slice[1] ?? undefined);
  if (prop.half) {
    const h = Math.ceil(games.length / 2);
    games = prop.half === 'right' ? games.slice(h) : games.slice(0, h);
  }
  return games;
}

function resolveColor(spec) {
  if (!spec) return null;
  const s = typeof spec === 'string' ? spec : (spec.texture || spec.color);
  if (typeof s !== 'string') return null;
  if (s.startsWith('builtin:')) return BUILTIN_COLORS[s.slice(8)] || '#444';
  if (s.startsWith('#')) return s;
  return null; // a URL — handled as a texture, not a flat colour
}

function textureUrlOf(spec) {
  const s = typeof spec === 'string' ? spec : spec?.texture;
  return typeof s === 'string' && /^(https?:|\/|\.\/|roms\/)/.test(s) ? s : null;
}

/**
 * Apply a poster `texture` (a `builtin:` colour or a texture URL) to a material.
 * Flat colour is set immediately; a URL loads async and overrides it on success
 * (the flat colour stays as the fallback). Shared by the initial build and the
 * in-VR env editor's live poster swap ([[src/EnvEditor.js]]), so both paths
 * resolve `builtin:`/URL the same way.
 */
export function applyPosterTexture(material, texture) {
  if (!material) return;
  const color = resolveColor(texture) || '#3a2c4a';
  material.map = null;
  material.color.set(new THREE.Color(color));
  material.needsUpdate = true;
  const url = textureUrlOf(texture);
  if (url) {
    new THREE.TextureLoader().load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      material.map = tex; material.color.set('#ffffff'); material.needsUpdate = true;
    }, undefined, () => { /* keep flat colour on failure */ });
  }
}

// A poster/picture on the wall: a thin lit plane. `texture` may be a URL or a
// `builtin:` colour; `size` is [w,h] metres (default 0.8×1.1 portrait).
function buildPoster(prop) {
  const [w, h] = Array.isArray(prop.size) ? prop.size : [0.8, 1.1];
  const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.name = `poster:${prop.id}`;
  mesh.position.copy(v3(prop.pos));
  applyRot(mesh, prop.rot);
  applyPosterTexture(mat, prop.texture);
  return mesh;
}

// A portal: a glowing doorway. main.js drives the actual room-change on enter
// (proximity check needs the player rig). We just build the visual + carry the
// target/radius on userData. Exported so the in-VR editor ([[src/RoomEditor.js]]
// via main.js `addPortal`) can build a brand-new portal through the same path.
export function buildPortal(portal) {
  const group = new THREE.Group();
  group.name = `portal:${portal.id}`;
  group.position.copy(v3(portal.pos));
  applyRot(group, portal.rot);

  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 2.0, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x2a2238, roughness: 0.6, emissive: 0x1a2240, emissiveIntensity: 0.6 }),
  );
  frame.position.y = 1.0;
  group.add(frame);

  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(0.8, 1.8),
    new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, toneMapped: false }),
  );
  fill.position.set(0, 1.0, 0.05);
  group.add(fill);

  const glow = new THREE.PointLight(0x66ccff, 1.2, 3, 1.6);
  glow.position.set(0, 1.2, 0.3);
  group.add(glow);

  group.userData = { kind: 'portal', target: portal.target, radius: portal.radius };
  return group;
}

// GLB prop. Loaded lazily so the scene never blocks on a model fetch; failure
// is non-fatal (logged).
async function buildModel(prop, scene) {
  if (!prop.asset) return;
  try {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().loadAsync(prop.asset);
    const obj = gltf.scene;
    obj.name = `model:${prop.id}`;
    obj.position.copy(v3(prop.pos));
    applyRot(obj, prop.rot);
    if (prop.scale) {
      const s = Array.isArray(prop.scale) ? prop.scale : [prop.scale, prop.scale, prop.scale];
      obj.scale.set(s[0], s[1], s[2]);
    }
    scene.addObject(obj);
  } catch (e) {
    console.warn(`[RoomBuilder] model "${prop.id}" failed to load:`, e?.message || e);
  }
}

/**
 * Build ONE prop into the scene through its scene factory and return a small
 * record the caller wires up. Shared by `buildRoom` (initial build) and the
 * in-VR editor's "add prop" path (Phase E.3 via main.js `addProp`), so a prop
 * created at runtime is built exactly like one loaded from a *.room.json.
 *
 * Returns `{ object, kind, cartridges? }`, or null for a prop with no movable
 * object (`tv` only toggles the CRT shader; `model` loads async and may fail).
 * The caller owns placement bookkeeping (editor-grabbable registration,
 * consoleObj/gamepadObj selection, cartridge grab-registration).
 */
export function buildProp(prop, { scene, collections }) {
  switch (prop.type) {
    case 'shelf': {
      const carts = gamesForShelf(prop, collections).map((m) => createCartridge(m));
      if (!carts.length) return null; // skip empty halves / empty collections
      const shelf = createShelf(carts, { position: v3(prop.pos), rotationY: prop.rot[1] * DEG });
      shelf.userData.kind = 'shelf'; // createShelf sets none; editor identifies by this
      scene.addObject(shelf);
      lockShelfHomes(shelf);
      return { object: shelf, kind: 'shelf', cartridges: carts };
    }
    case 'console': {
      const obj = createConsole({ position: v3(prop.pos) });
      applyRot(obj, prop.rot);
      scene.addObject(obj);
      return { object: obj, kind: 'console' };
    }
    case 'gamepad': {
      const obj = createGamepad({ position: v3(prop.pos) });
      applyRot(obj, prop.rot);
      scene.addObject(obj);
      return { object: obj, kind: 'gamepad' };
    }
    case 'poster': {
      const obj = buildPoster(prop);
      scene.addObject(obj);
      return { object: obj, kind: 'poster' };
    }
    case 'bookcase':
    case 'cupboard':
    case 'table': {
      // Decorative furniture (no cartridges). Origin is floor-contact, so a
      // `pos` of [x, 0, z] stands it on the floor. See [[src/Furniture.js]].
      const make = { bookcase: createBookcase, cupboard: createCupboard, table: createTable }[prop.type];
      const obj = make({ position: v3(prop.pos), rotationY: prop.rot[1] * DEG });
      applyRot(obj, prop.rot); // honour full XYZ rotation (rotationY already set; this re-applies all three)
      scene.addObject(obj);
      return { object: obj, kind: prop.type };
    }
    case 'tv':
      scene.applyTv?.(prop);
      return null;
    case 'model':
      buildModel(prop, scene); // async; serializes from the descriptor, not movable in E.1
      return null;
    default:
      console.warn(`[RoomBuilder] unknown prop type "${prop.type}" (${prop.id}) — skipped`);
      return null;
  }
}

/**
 * Build a room into the scene. `collections` is { byKey: Map<ref,col>,
 * list: col[] } (keyed by both url and id, de-duplicated list in declared
 * order). Returns the handles main.js needs to finish wiring, including
 * `placed: [{ prop, object }]` — the prop↔object link the in-VR editor
 * ([[src/RoomEditor.js]]) needs to harvest live transforms back into the
 * descriptor on export ([[src/RoomSerializer.js]]). Each movable object also
 * carries its source descriptor on `userData.roomProp`.
 */
export function buildRoom({ scene, room, collections }) {
  scene.applyEnvironment?.(room.environment);

  let consoleObj = null;
  let gamepadObj = null;
  const cartridges = [];
  const shelves = [];
  const placed = []; // { prop, object } for every movable, editor-grabbable prop

  // Tag an object with its source descriptor and add it to the editor's
  // movable set. `tv` is intentionally not placed (it has no object — it only
  // toggles the CRT shader — yet still round-trips via the descriptor).
  const place = (object, prop) => {
    object.userData.roomProp = prop;
    placed.push({ prop, object });
    return object;
  };

  for (const prop of room.props) {
    const r = buildProp(prop, { scene, collections });
    if (!r) continue; // tv/model/unknown: no movable object to place
    place(r.object, prop);
    if (r.kind === 'shelf') {
      shelves.push(r.object);
      cartridges.push(...r.cartridges);
    } else if (r.kind === 'console' && !consoleObj) {
      consoleObj = r.object; // first console is the active one
    } else if (r.kind === 'gamepad' && !gamepadObj) {
      gamepadObj = r.object;
    }
  }

  const portals = room.portals.map((p) => {
    const object = buildPortal(p);
    object.userData.roomProp = p;
    scene.addObject(object);
    placed.push({ prop: p, object });
    return { object, prop: p, target: p.target, radius: p.radius };
  });

  return { consoleObj, gamepadObj, cartridges, portals, shelves, placed };
}
