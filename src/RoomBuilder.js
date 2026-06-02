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

// A poster/picture on the wall: a thin lit plane. `texture` may be a URL or a
// `builtin:` colour; `size` is [w,h] metres (default 0.8×1.1 portrait).
function buildPoster(prop) {
  const [w, h] = Array.isArray(prop.size) ? prop.size : [0.8, 1.1];
  const color = resolveColor(prop.texture) || '#3a2c4a';
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color), toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.name = `poster:${prop.id}`;
  mesh.position.copy(v3(prop.pos));
  applyRot(mesh, prop.rot);
  const url = textureUrlOf(prop.texture);
  if (url) {
    new THREE.TextureLoader().load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      mat.map = tex; mat.color.set('#ffffff'); mat.needsUpdate = true;
    }, undefined, () => { /* keep flat colour on failure */ });
  }
  return mesh;
}

// A portal: a glowing doorway. main.js drives the actual room-change on enter
// (proximity check needs the player rig). We just build the visual + carry the
// target/radius on userData.
function buildPortal(portal) {
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
 * Build a room into the scene. `collections` is { byKey: Map<ref,col>,
 * list: col[] } (keyed by both url and id, de-duplicated list in declared
 * order). Returns the handles main.js needs to finish wiring.
 */
export function buildRoom({ scene, room, collections }) {
  scene.applyEnvironment?.(room.environment);

  let consoleObj = null;
  let gamepadObj = null;
  const cartridges = [];
  const shelves = [];

  for (const prop of room.props) {
    switch (prop.type) {
      case 'shelf': {
        const carts = gamesForShelf(prop, collections).map((m) => createCartridge(m));
        if (!carts.length) break; // skip empty halves (matches old behavior)
        const shelf = createShelf(carts, { position: v3(prop.pos), rotationY: prop.rot[1] * DEG });
        scene.addObject(shelf);
        lockShelfHomes(shelf);
        shelves.push(shelf);
        cartridges.push(...carts);
        break;
      }
      case 'console': {
        const obj = createConsole({ position: v3(prop.pos) });
        applyRot(obj, prop.rot);
        scene.addObject(obj);
        if (!consoleObj) consoleObj = obj; // first console is the active one
        break;
      }
      case 'gamepad': {
        const obj = createGamepad({ position: v3(prop.pos) });
        applyRot(obj, prop.rot);
        scene.addObject(obj);
        if (!gamepadObj) gamepadObj = obj;
        break;
      }
      case 'tv':
        scene.applyTv?.(prop);
        break;
      case 'poster':
        scene.addObject(buildPoster(prop));
        break;
      case 'model':
        buildModel(prop, scene); // async, non-blocking
        break;
      default:
        console.warn(`[RoomBuilder] unknown prop type "${prop.type}" (${prop.id}) — skipped`);
    }
  }

  const portals = room.portals.map((p) => {
    const object = buildPortal(p);
    scene.addObject(object);
    return { object, target: p.target, radius: p.radius };
  });

  return { consoleObj, gamepadObj, cartridges, portals, shelves };
}
