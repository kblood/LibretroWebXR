// Node smoke-test guarding against RuntimeEmulatorClient (the facade that
// replaced EmulatorClient app-wide when worker-execution cores were added)
// silently drifting out of parity with EmulatorClient's real public API.
//
// This is a regression guard for a real shipped bug (2026-07-24 review,
// P0-1): RuntimeEmulatorClient forwarded only 12 hand-picked methods and
// missed sendLightgun/sendMouse entirely, so every light-gun and mouse call
// site threw a TypeError the instant a gun/mouse was used. Nothing caught it
// because every gun/mouse test stubs the client instead of driving a real
// one (see scripts/probe-lightgun-regression.mjs for that gap).
//
// Pure logic — no THREE, no DOM, no browser, no core files needed (both
// classes are inert until start() is called).
// Run: node scripts/test-runtime-facade.mjs   Exit 0 = pass, 1 = any failure.

import { EmulatorClient } from '../src/EmulatorClient.js';
import { RuntimeEmulatorClient } from '../src/RuntimeEmulatorClient.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

// Every public (non-underscore, non-constructor) method EmulatorClient
// exposes on its prototype. EventTarget's own inherited methods
// (addEventListener/removeEventListener/dispatchEvent) are excluded — the
// facade already gets those for free by extending EventTarget itself, and
// asserting them here would just be testing the platform.
const EVENT_TARGET_METHODS = new Set(Object.getOwnPropertyNames(EventTarget.prototype));

const publicMethodNames = (Cls) =>
  Object.getOwnPropertyNames(Cls.prototype).filter((name) =>
    name !== 'constructor' &&
    !name.startsWith('_') &&
    !EVENT_TARGET_METHODS.has(name) &&
    typeof Cls.prototype[name] === 'function');

const emulatorClientMethods = publicMethodNames(EmulatorClient);
ok('EmulatorClient exposes at least one public method', emulatorClientMethods.length > 0,
   `found: ${JSON.stringify(emulatorClientMethods)}`);

for (const name of emulatorClientMethods) {
  ok(`RuntimeEmulatorClient forwards ${name}()`,
     typeof RuntimeEmulatorClient.prototype[name] === 'function',
     'method missing from the facade — a real gun/mouse/input/save-state call would throw');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
