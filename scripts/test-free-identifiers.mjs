// Static "does every name this file uses actually exist?" check over src/.
//
// WHY THIS SUITE EXISTS. The §3.1 extraction pass moved five regions out of
// src/main.js, and each move rewrote an import block. One of those rewrites
// deleted `import { GhostGamepadMgr, GP_HOLD_PREFIX, makeGamepadHoldKey,
// cableIdFromHoldKey } from './GhostGamepadMgr.js'` and replaced it with the
// CabledPeripheral.js descriptor import — but only the GUN and MOUSE call sites
// were converted to the new `makeHoldKeyFor(desc, cableId)` helper. Four gamepad
// call sites were left calling `makeGamepadHoldKey`, a name that no longer
// existed anywhere in the file.
//
// Nothing caught it:
//   * `node --check` parses, it does not resolve — a free identifier is legal
//     syntax right up until it runs.
//   * `npm test` was 60/60 green, because src/main.js is the one file no suite
//     imports (it builds a SceneMgr and reads document at module scope).
//   * `npm run build` was green, because Rollup leaves an unresolved global
//     alone (it could be supplied by the host page).
//   * Single-player smoke runs never reached it: all four sites sit behind a
//     `net &&` guard, so the ReferenceError only fired in a ROOM — i.e. only on
//     a headset, mid-session, inside the XR frame callback, where it also ate
//     the following onObjectGrabbed/onObjectReleased and made every peer's pad
//     snap back.
//
// So the guard has to be static, and it has to cover the file no test imports.
// Two checks, both over the real source:
//
//   A. FREE IDENTIFIERS. Every identifier a module references must be declared
//      somewhere in that module or be a known global. Scope is deliberately
//      FLAT (a name declared anywhere in the file counts as declared): that
//      cannot flag a shadowing mistake, but it catches "this name is nowhere",
//      which is the whole bug class above, with zero false positives from
//      block scoping.
//
//   B. IMPORTS RESOLVE. Every named import from a RELATIVE path inside src/
//      must actually be exported by the file it names — the other half of the
//      same mistake, caught one line earlier.
//
// A NEGATIVE CONTROL re-introduces the shipped bug into main.js's source text
// and requires check A to fail on it. Without that, a check that currently
// passes proves only that it ran.
//
// Pure logic: reads files and parses them. No browser, no server, no ports.
// The parser is Rollup's, reached through vite (a direct devDependency), which
// is the same parse the production build already performs.
// Run: node scripts/test-free-identifiers.mjs   (also in `npm test`)

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import { parseAst } from 'vite';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(SCRIPTS, '..', 'src');

let passed = 0;
let failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } };
const section = (name, fn) => { console.log(`--- ${name} ---`); return fn(); };

// Browser + platform globals these modules legitimately reach for. This list is
// the price of a no-undef check without a full JS environment model: a genuinely
// new global has to be added here once. The failure message says so.
const GLOBALS = new Set([
  'undefined', 'globalThis', 'window', 'document', 'navigator', 'console', 'self', 'location', 'history',
  'screen', 'performance', 'crypto', 'localStorage', 'sessionStorage', 'indexedDB', 'IDBKeyRange',
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Function',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Proxy', 'Reflect', 'Intl',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'DOMException',
  'Infinity', 'NaN', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'structuredClone', 'atob', 'btoa',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'escape', 'unescape',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'getComputedStyle', 'matchMedia',
  'fetch', 'Request', 'Response', 'Headers', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal',
  'Blob', 'File', 'FileReader', 'FormData', 'TextEncoder', 'TextDecoder', 'ReadableStream', 'WritableStream',
  'Worker', 'SharedWorker', 'MessageChannel', 'MessagePort', 'BroadcastChannel', 'postMessage', 'importScripts',
  'WebSocket', 'RTCPeerConnection', 'RTCSessionDescription', 'RTCIceCandidate', 'MediaStream', 'MediaRecorder',
  'AudioContext', 'OfflineAudioContext', 'OffscreenCanvas', 'ImageData', 'ImageBitmap', 'createImageBitmap',
  'Image', 'Audio', 'Path2D', 'DOMMatrix', 'DOMPoint',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'WebAssembly',
  'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'Event', 'EventTarget', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'WheelEvent',
  'TouchEvent', 'GamepadEvent', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver',
  'Element', 'HTMLElement', 'HTMLCanvasElement', 'HTMLImageElement', 'HTMLVideoElement', 'HTMLInputElement',
  'XRRigidTransform', 'XRWebGLLayer', 'XRRay', 'XRWebGLBinding',
  'alert', 'confirm', 'prompt', 'open', 'close', 'process',
  'arguments',            // sloppy-mode `arguments` inside a non-arrow function
]);

// --- the analyser -----------------------------------------------------------
// One pass over the AST collecting (a) every binding the file introduces and
// (b) every identifier it references in a VALUE position. Property keys,
// non-computed member properties, labels and export specifiers are not
// references and are skipped.
function analyse(src, label) {
  const ast = parseAst(src);
  const declared = new Set();
  const used = new Map();          // name -> 1-based line of the first reference
  const imports = [];              // { source, names: [{ imported, local }] }
  const exported = new Set();
  let starExports = false;

  const lineOf = (pos) => src.slice(0, pos).split('\n').length;

  function bind(p) {
    if (!p) return;
    switch (p.type) {
      case 'Identifier': declared.add(p.name); break;
      case 'ObjectPattern': for (const pr of p.properties) bind(pr.type === 'RestElement' ? pr.argument : pr.value); break;
      case 'ArrayPattern': for (const el of p.elements) bind(el); break;
      case 'AssignmentPattern': bind(p.left); break;
      case 'RestElement': bind(p.argument); break;
      default: break;
    }
  }

  function walk(node, parent) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'ImportDeclaration': {
        const names = [];
        for (const s of node.specifiers) {
          declared.add(s.local.name);
          if (s.type === 'ImportSpecifier') names.push({ imported: s.imported.name ?? s.imported.value, local: s.local.name });
          if (s.type === 'ImportDefaultSpecifier') names.push({ imported: 'default', local: s.local.name });
          if (s.type === 'ImportNamespaceSpecifier') names.push({ imported: '*', local: s.local.name });
        }
        imports.push({ source: node.source.value, names });
        return;                                   // nothing inside is a reference
      }
      case 'ExportNamedDeclaration':
        for (const s of node.specifiers || []) exported.add(s.exported.name ?? s.exported.value);
        // `export { a as b } from './x.js'` — the specifiers name exports of the
        // OTHER module, not local bindings, so recording them is the whole job.
        // Walking into them would read every `a` as a free identifier here.
        if (node.source) return;
        if (node.declaration) {
          const d = node.declaration;
          if (d.type === 'VariableDeclaration') {
            for (const v of d.declarations) { bind(v.id); if (v.id.type === 'Identifier') exported.add(v.id.name); }
          } else if (d.id) {
            exported.add(d.id.name);
          }
        }
        break;
      case 'ExportDefaultDeclaration': exported.add('default'); break;
      case 'ExportAllDeclaration': starExports = true; return;
      case 'MetaProperty': return;                // import.meta / new.target
      case 'VariableDeclarator': bind(node.id); break;
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
        if (node.id) declared.add(node.id.name);
        for (const p of node.params) bind(p);
        break;
      case 'ClassDeclaration': case 'ClassExpression': if (node.id) declared.add(node.id.name); break;
      case 'CatchClause': bind(node.param); break;
      case 'LabeledStatement': declared.add(node.label.name); break;
      case 'BreakStatement': case 'ContinueStatement': return;
      case 'Identifier': {
        if (parent) {
          if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
          if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
          if ((parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && parent.key === node && !parent.computed) return;
        }
        if (!used.has(node.name)) used.set(node.name, lineOf(node.start));
        return;
      }
      default: break;
    }
    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
      const v = node[key];
      if (Array.isArray(v)) { for (const c of v) walk(c, node); }
      else if (v && typeof v.type === 'string') walk(v, node);
    }
  }

  walk(ast, null);
  const free = [...used.entries()]
    .filter(([n]) => !declared.has(n) && !GLOBALS.has(n))
    .map(([name, line]) => ({ name, line, label }));
  return { free, imports, exported, starExports };
}

// --- the files --------------------------------------------------------------
function listJs(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out.sort();
}

const FILES = listJs(SRC);
const ANALYSED = new Map();
for (const f of FILES) {
  const rel = relative(SRC, f).replace(/\\/g, '/');
  ANALYSED.set(rel, analyse(readFileSync(f, 'utf8').replace(/\r\n/g, '\n'), `src/${rel}`));
}

section('every src/ module is parsed (a silently empty run would assert nothing)', () => {
  ok(FILES.length > 50, `found ${FILES.length} modules under src/`);
  ok(ANALYSED.has('main.js'), 'src/main.js is among them — it is the file no other suite imports');
});

section('A. no module references a name that does not exist', () => {
  const all = [];
  for (const { free } of ANALYSED.values()) all.push(...free);
  for (const f of all) console.error(`  free identifier: ${f.label}:${f.line}  ${f.name}`);
  ok(all.length === 0,
    `${all.length} free identifier(s) — either the name was never imported (the makeGamepadHoldKey `
    + 'class of bug this suite exists for) or it is a platform global missing from GLOBALS in this file');
});

section('B. every relative named import resolves to a real export', () => {
  let checked = 0;
  const bad = [];
  for (const [rel, { imports }] of ANALYSED) {
    for (const imp of imports) {
      if (!imp.source.startsWith('.')) continue;
      const target = relative(SRC, resolve(dirname(join(SRC, rel)), imp.source)).replace(/\\/g, '/');
      const mod = ANALYSED.get(target);
      if (!mod) {
        if (existsSync(join(SRC, target))) bad.push(`src/${rel}: '${imp.source}' resolved to a file that was not analysed`);
        continue;                                  // non-.js asset imports (?url, ?worker)
      }
      if (mod.starExports) continue;               // re-exports this suite does not follow
      for (const { imported } of imp.names) {
        if (imported === '*') continue;
        checked++;
        if (!mod.exported.has(imported)) bad.push(`src/${rel} imports { ${imported} } from '${imp.source}', which does not export it`);
      }
    }
  }
  for (const b of bad) console.error(`  ${b}`);
  ok(checked > 200, `checked ${checked} named imports across src/`);
  ok(bad.length === 0, `${bad.length} import(s) name something their target does not export`);
});

section('the four gamepad hold-key call sites go through the descriptor helper', () => {
  const MAIN = readFileSync(join(SRC, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const sites = MAIN.match(/makeHoldKeyFor\(GAMEPAD, cableId\)/g) || [];
  ok(sites.length === 4,
    `all four gamepad grab/release sites call makeHoldKeyFor(GAMEPAD, …) (found ${sites.length}) — `
    + 'two in the GrabMgr callbacks, two in the __testApi grab/releaseGamepad hooks');
  ok(!/\bmakeGamepadHoldKey\b/.test(MAIN),
    'and the deleted GhostGamepadMgr-era name is gone from main.js entirely');
  const { imports } = ANALYSED.get('main.js');
  const cabled = imports.find((i) => i.source === './CabledPeripheral.js');
  ok(!!cabled, 'main.js imports the descriptor module');
  for (const n of ['GAMEPAD', 'makeHoldKeyFor']) {
    ok(!!cabled?.names.some((x) => x.imported === n), `…and takes ${n} from it`);
  }
});

section('NEGATIVE CONTROL: put the shipped bug back and check A must catch it', () => {
  const MAIN = readFileSync(join(SRC, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  // Exactly the pre-fix text: the call sites the extraction failed to convert,
  // with the import block that used to supply the name still absent.
  const broken = MAIN.replace(/makeHoldKeyFor\(GAMEPAD, cableId\)/g, 'makeGamepadHoldKey(cableId)');
  ok(broken !== MAIN, 'the control really did rewrite the call sites');
  const { free } = analyse(broken, 'src/main.js (negative control)');
  ok(free.some((f) => f.name === 'makeGamepadHoldKey'),
    'check A reports makeGamepadHoldKey as free — this is the assertion that would have failed '
    + 'the extraction commit instead of a headset session');
  ok(free.length === 1, `and reports nothing else (got ${free.length})`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
