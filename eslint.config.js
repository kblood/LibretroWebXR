// The static undefined-identifier tripwire. Deliberately tiny.
//
// WHY IT EXISTS
// -------------
// The §3.1 extraction pass rewrote src/main.js's import block and deleted
// `import { makeGamepadHoldKey } from './GhostGamepadMgr.js'` while leaving four
// call sites behind. `makeGamepadHoldKey` was then a name that existed nowhere in
// the file, and EVERY multiplayer gamepad grab and release threw a ReferenceError
// inside the XR frame callback. Four separate gates were green over that bug:
//
//   * `node --check src/main.js` — parses, does not resolve. A free identifier is
//     valid syntax right up until the line runs.
//   * `npm test` (52 suites) — src/main.js is the one module no suite imports; it
//     builds a SceneMgr and touches `document` at module scope.
//   * `npm run build` — Rollup leaves an unresolved global alone, because the host
//     page is allowed to supply it.
//   * a headless boot of the real app — all four sites sit behind a `net &&`
//     guard, so the throw only happens in a ROOM, i.e. on a headset.
//
// So the missing gate is a static scope analysis, and that is all this config
// turns on. src/main.js is ~8,000 lines and is being actively carved into modules;
// every one of those moves rewrites an import block, which is exactly the edit
// that produces this bug class.
//
// WHY IT IS THIS SMALL
// --------------------
// A flat config with no `extends` enables NOTHING by default — every rule below is
// opt-in, and nothing stylistic is or should be added. This is a correctness
// tripwire, not a style regime: a config that prints hundreds of opinions gets
// switched off within a week, and the tripwire goes with it. If you want
// formatting opinions, that is a separate, separately-argued change.
//
// The five rules, all of them "this code cannot be doing what it says":
//   no-undef        — the bug above. A name with no binding and no known global.
//   no-unreachable  — code after return/throw/break. Always an editing accident.
//   no-dupe-keys    — a later duplicate key silently wins; the earlier one, which
//                     is usually the one you just wrote, is dead.
//   no-const-assign — a guaranteed TypeError the moment the line executes.
// All five are free: no type information, no project config, no style component.
//
// THE GLOBALS ARE THE WHOLE CREDIBILITY OF THIS FILE
// --------------------------------------------------
// A no-undef that cries wolf about `XRRigidTransform` or the probe scripts'
// `page.evaluate(() => document…)` closures is a rule nobody reads, and an unread
// rule is worse than no rule. So:
//   * src/ gets browser + worker. `globals.browser` already carries the WebXR
//     surface this app is built on (XRRigidTransform, XRWebGLLayer, XRWebGLBinding,
//     XRRay) and the WebGL one (WebGL2RenderingContext, …) — all four were checked
//     against the installed `globals` package, not assumed. `globals.worker` is for
//     src/runtime/'s off-thread modules. SharedArrayBuffer/Atomics come from
//     `ecmaVersion` as ES built-ins, not from either set.
//   * scripts/ gets node AND browser: the probe/smoke scripts hand browser closures
//     to `page.evaluate()`, so `document` and `window` appear as bare identifiers in
//     files that run under Node. Widening the allowlist there is the honest trade —
//     the alternative is a wall of false positives across ~140 files, which is how
//     a check gets deleted.
//   * this project ships a `window.__*` debug surface ON PURPOSE (src/TestApi.js:
//     `window.__testApi`, `window.__disarmGun`, …) that the probe scripts depend
//     on. Those are PROPERTY writes and reads on `window`, so no-undef never sees
//     them and no allowlist entry is needed — verified: with these globals the tree
//     reports zero errors, and not one of them was a `__*` name.
//
// That the globals are doing real work, and are not just hiding everything: linting
// the same tree with an EMPTY globals set reports 4,023 no-undef errors across 232
// of the 288 files. The rule runs everywhere; the globals are what turn the output
// from unreadable into trustworthy. And they are not over-wide by accident — with
// node-only globals, scripts/ reports exactly 1,188 hits and every one of them is a
// browser name inside a `page.evaluate()` closure (window 1075, document 88,
// Image 16, KeyboardEvent 2, self, location, indexedDB, DataTransfer,
// CanvasRenderingContext2D). Nothing was allowlisted that did not have to be.
//
// NEVER silence a real hit with `// eslint-disable-line no-undef`. A real hit is a
// latent ReferenceError; the fix is the import, or — if the host page really does
// supply the name — a global declared HERE, in one readable place, with a reason.
// scripts/test-lint.mjs enforces that: it asks ESLint for `suppressedMessages` and
// fails the run if a comment ever suppressed a hit from one of the five rules
// below. (It asks the linter rather than grepping for the word, so prose about
// the directive — this paragraph, for instance — does not trip it.)
//
// UNUSED-DIRECTIVE REPORTING IS OFF, on purpose. Two files carry
// `// eslint-disable-next-line no-new-func` (scripts/test-boot-transaction.mjs:148,
// scripts/test-peripheral-arm-join.mjs:92) for a rule this config does not enable,
// so ESLint would flag both as "unused directive" on every run. They are correct
// notes about real `new Function(...)` calls and should survive; reporting them is
// precisely the crying-wolf this file exists not to do. The test-lint.mjs check
// above is the targeted version: it cares only about the rules we actually gate on.
//
// HOW IT RUNS: `scripts/test-lint.mjs` drives it through ESLint's programmatic API,
// so `npm test` DISCOVERS it like any other suite (see run-tests.mjs) and it lands
// in CI with nothing to append and nothing to forget. Read the head of that file
// for why it is a suite rather than a separate CI step.
//
// Standalone: `npx eslint src scripts test` (or just run scripts/test-lint.mjs).

import globals from 'globals';

// Shared by every linted tree. Nothing here is stylistic; see the header.
// scripts/test-lint.mjs imports this list to know which rules may never be
// suppressed by an inline comment, so keep it exported and keep it the one list.
export const CORRECTNESS_RULES = {
  'no-undef': 'error',
  'no-unreachable': 'error',
  'no-dupe-keys': 'error',
  'no-const-assign': 'error',
  // Added after the same extraction pass that motivated no-undef: pulling a
  // region out of main.js leaves its imports behind, and a dead import is the
  // half of that mistake no-undef CANNOT see (the other half — a call site left
  // behind without its import — is the makeGamepadHoldKey ReferenceError). It
  // measured at 16 hits across all of src/ when switched on, so it is a real
  // tripwire and not a style regime. `_`-prefixed names are exempt: this repo
  // uses that prefix for deliberately-parked state (`_kbdManualOverride` has
  // been write-only since long before this pass) and churning those is noise.
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
};

// package.json is "type": "module"; every .js/.mjs in these trees is ESM.
const LANGUAGE_OPTIONS = { ecmaVersion: 2024, sourceType: 'module' };

// See the header. Off because this config gates five rules, not a rule set, so
// pre-existing directives for OTHER rules would all read as "unused".
const LINTER_OPTIONS = { reportUnusedDisableDirectives: 'off' };

export default [
  {
    // Nothing generated, vendored or fetched. public/cores/ and public/roms/ are
    // gitignored binary drops; dist/ is build output; games/ carries third-party
    // toolchain sources that are not ours to lint.
    ignores: [
      'dist/**',
      'node_modules/**',
      'public/**',
      'games/**',
      'tmp/**',
      'cores/**',
      // server/ has its own package tree, its own lockfile and its own job in
      // ci.yml, and eslint is not installed there. Extending this config over it
      // is a reasonable follow-up; it is not this change.
      'server/**',
    ],
  },

  {
    // ---- src/: the browser app (three.js + WebXR + WebGL + workers) ----------
    files: ['src/**/*.js'],
    linterOptions: LINTER_OPTIONS,
    languageOptions: {
      ...LANGUAGE_OPTIONS,
      globals: { ...globals.browser, ...globals.worker },
    },
    rules: CORRECTNESS_RULES,
  },

  {
    // ---- scripts/: Node tooling, tests, probes and smoke runs ---------------
    // node + browser; see the header for why the browser half belongs here.
    files: ['scripts/**/*.{js,mjs}'],
    linterOptions: LINTER_OPTIONS,
    languageOptions: {
      ...LANGUAGE_OPTIONS,
      globals: { ...globals.node, ...globals.browser },
    },
    rules: CORRECTNESS_RULES,
  },

  {
    // ---- test/: the node:test files run by the same CI gate -----------------
    // node + browser for the same reason scripts/ is: test/*-e2e/harness.js are
    // page-side harnesses (they read `document` and `crossOriginIsolated`) that
    // live next to the node:test files that serve them.
    files: ['test/**/*.js'],
    linterOptions: LINTER_OPTIONS,
    languageOptions: {
      ...LANGUAGE_OPTIONS,
      globals: { ...globals.node, ...globals.browser },
    },
    rules: CORRECTNESS_RULES,
  },

  {
    // ---- the repo's own root config files (vite.config.js, this file) -------
    files: ['*.js', '*.mjs'],
    linterOptions: LINTER_OPTIONS,
    languageOptions: { ...LANGUAGE_OPTIONS, globals: { ...globals.node } },
    rules: CORRECTNESS_RULES,
  },
];
