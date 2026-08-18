import { cpSync, existsSync, readdirSync, rmSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

import { BUNDLE_BUDGETS, DENY_RULES, checkDist, fmt, matchDeny } from './scripts/check-dist.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ── Content-Security-Policy ──────────────────────────────────────────────────
//
// ⚠ THIS LIST IS DUPLICATED IN `public/.htaccess`. Dev/preview get their headers
// from the middleware below; the DEPLOYED app gets them from that .htaccess, so
// the two are one contract in two places. `node scripts/test-csp.mjs` (run by
// the `npm test` chain, the pure-logic tier) imports this file, RUNS the
// middleware below against a recording `res`, and fails if the header it
// actually emits differs from the one .htaccess serves — checking the emitted
// value, not this literal, because a decoupled `const CSP` used to be able to
// revert the whole policy with that test still green. It also fails if
// .htaccess modifies the header again further down (`Header unset` there would
// mean the deployed app gets NO policy), if a value-pinned directive is widened
// to `*`, and if any shipped HTML grows an inline <script> again (CODEX_REVIEW
// SEC-6: headset-test.html had one, and our own script-src was silently killing
// it on the headset).
//
// FILE REFERENCES BELOW NAME SYMBOLS, NOT LINE NUMBERS, on purpose: every
// line-number anchor this comment once carried had gone stale (the round-5
// verifier caught one pointing at an unrelated JSDoc block).
//
// The old policy was `script-src` + `worker-src` only. Everything else fell
// through to "no policy at all". Adding the missing baseline directives is only
// safe if it matches what this app ACTUALLY loads, so here is the enumeration
// each directive below is derived from — extend the comment when you extend the
// list:
//
//   scripts   — the vite bundle + `/src/**` modules (same-origin), and
//               `EmulatorClient#_loadCore()` (src/EmulatorClient.js) which
//               appends a real <script src=…> for "classic" Emscripten cores,
//               plus the `import()` of "module"-style cores in the same method.
//               All resolved against document.baseURI → same-origin. NO inline
//               scripts anywhere (that is what test-csp.mjs guards).
//               'wasm-unsafe-eval' is required because the PSX Lightrec dynarec
//               and the Play! PS2 core COMPILE Wasm at runtime; plain
//               'unsafe-eval' is deliberately NOT granted.
//   workers   — `WorkerEmulatorClient#_createWorker()`
//               (src/runtime/WorkerEmulatorClient.js): `new Worker(new
//               URL('./EmulatorWorkerRuntime.js', import.meta.url))`,
//               same-origin — and Emscripten pthread workers, some builds of
//               which spawn from a blob: URL → 'self' blob:.
//   connect   — three different things, and two of them are user-supplied:
//                 • same-origin fetches of cores/ROMs/collection JSON;
//                 • the room server WebSocket. Default is `wss://<host>/ws/`
//                   (same-origin — `defaultServerUrl()` in src/net/NetMgr.js)
//                   but `?server=` overrides it with ANY origin — the LAN dev
//                   workflow is literally `?server=ws://192.168.x.x:8787`, so
//                   ws:/wss: must both be allowed, not just 'self';
//                 • the remote log server. `?log=<url>` is any origin
//                   (`_detectServerUrl()` in src/Logger.js) and is the ONLY way
//                   to read a Quest session's console → https:/http: allowed.
//               Also `https:` because a collection entry's rom.url may be a
//               signed/CDN URL rather than a path ending in the file name — see
//               the "signed URL, a CDN endpoint with a query string" comment in
//               `resolvePs2DiscCue()` (src/main.js), which resolves a CUE's
//               track against that URL for exactly that reason — and blob:/data:
//               for locally-sideloaded content.
//               NOTE: RTCPeerConnection/STUN/TURN (`?turn=`) is NOT governed by
//               connect-src in CSP3 — do not "fix" voice/video by widening it.
//   images    — `blob:` object URLs from `entryObjectUrl()`
//               (src/ImageLibrary.js) and from the `setPosterBtn` file-picker
//               handler that feeds `applyCustomPosterSource()` (src/main.js) —
//               local poster/label files, all of which end up in
//               THREE.TextureLoader — `data:` for generated textures, and
//               `https:` because `window.__add.setPosterImage('https://…')`
//               (src/main.js) and room JSON can name a remote poster, which
//               `applyPosterTexture()` (src/RoomBuilder.js) hands straight to
//               THREE.TextureLoader.
//   media     — game audio + the shared-screen <video>. WebRTC streams arrive
//               via `videoEl.srcObject` (`VideoMgr#_attach()`,
//               src/net/VideoMgr.js), which the CSP spec does not check, but
//               `mediastream:` is listed so a stricter UA can't surprise us;
//               blob:/data: cover recorded and generated media.
//   styles    — index.html / desktop.html / headset-test.html each carry a
//               <style> block and inline `style=` attributes, so
//               'unsafe-inline' is REQUIRED here. It does not leak into
//               script-src, which is set explicitly above it.
//   the rest  — this app has no <base>, no <form>, no <object>/<embed>, no
//               <iframe> and is never embedded, so base-uri, form-action,
//               object-src and frame-ancestors get locked to 'none'. Verified
//               by grep over src/, public/, index.html and desktop.html
//               (2026-08-15). test-csp.mjs pins all four to that exact value on
//               both copies, so widening one is a test failure, not a silent
//               edit — presence-only checks used to let `base-uri *` through.
//
// COOP/COEP are NOT part of this and must not be touched: crossOriginIsolated
// (and therefore SharedArrayBuffer, and therefore every threaded core) depends
// on them.
const CSP_DIRECTIVES = [
  "default-src 'self' blob: data:",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https:",
  "media-src 'self' blob: data: mediastream:",
  "connect-src 'self' blob: data: ws: wss: http: https:",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
];

export const CSP = CSP_DIRECTIVES.join('; ');

// Cross-origin isolation headers are required to enable SharedArrayBuffer,
// which threaded libretro cores and the PSX JIT need for shared Wasm memory.
const crossOriginIsolation = () => ({
  name: 'cross-origin-isolation',
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Content-Security-Policy', CSP);
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Content-Security-Policy', CSP);
      next();
    });
  },
});

/**
 * Keep UNINTENDED assets out of the build output.
 *
 * `.gitignore` is not the publishing boundary here: vite copies the whole of
 * `public/` into `dist/`, and `scripts/deploy.ps1` scp's every top-level item of
 * `dist/` to a public web server. Nothing checked what was in there, so editor
 * backups, the 8 pre-patch `*.wasm.bak` cores, a stray `.env` or a ROM this
 * project has no right to redistribute would all ship silently.
 *
 * So we turn vite's blanket `copyPublicDir` OFF and do the copy ourselves with a
 * filter; `closeBundle` then sweeps `dist/` for anything denied that arrived by
 * some other route, and runs the standalone guard.
 *
 * `public/roms/local/` IS NOT ON THAT LIST, DELIBERATELY. It is the user's
 * private sideload and it SHIPS — putting it on dionysus.dk (the user's own box)
 * is the only practical way to test light guns on a real Quest. A strip guard has
 * been added and reverted twice now (0df8aeb -> b192911, then again on
 * 2026-08-14); scripts/check-dist.mjs's header has the full story. The guard
 * REPORTS the private tree on every build and only refuses it under `--strict`.
 * Stripping it would also strip `roms/local/amiga/kick*.A500`, which
 * `src/systems.js` points PUAE's `systemFiles` at, silently breaking deployed
 * Amiga.
 *
 * The deny list lives in scripts/check-dist.mjs and is shared with the standalone
 * guard, so the build and the pre-upload gate can't disagree about what "not
 * ours to publish" means. The guard does NOT depend on this plugin: if this
 * plugin is deleted, `node scripts/check-dist.mjs` still fails the deploy.
 *
 * DEV IS UNAFFECTED either way: the dev server serves `publicDir` straight from
 * disk and never consults `build.copyPublicDir`.
 *
 * IT FOLLOWS THE REAL outDir. An earlier version hardcoded `<repo>/dist`, so
 * `vite build --outDir somewhere/else` produced an outDir containing only
 * assets/ + the .html entries — no cores/, no roms/ and (fatally) no `.htaccess`,
 * i.e. no COOP/COEP, so `crossOriginIsolated` was false and every threaded core
 * was dead — while silently rewriting the repo's own dist/ as a side effect. The
 * outDir and publicDir now come from the RESOLVED vite config, which accounts for
 * the CLI flag, the config file and any `root` override.
 *
 * IT ALSO ENFORCES, NOT JUST FILTERS. After copying it runs the standalone guard
 * (`checkDist`) against the resolved outDir and THROWS on a violation, failing the
 * build. The npm `postbuild` hook only ever inspects ./dist, so without this a
 * `--outDir` build was completely ungated. The standalone script and the
 * deploy.ps1 gate still exist and still run — this is a third trigger of the same
 * policy, not a replacement for either.
 */
const excludePrivateAssets = () => {
  let done = false;
  let resolved = null;
  return {
    name: 'exclude-private-assets',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      resolved = config;
    },
    buildStart() {
      done = false; // so `vite build --watch` re-copies on every rebuild
    },
    closeBundle() {
      if (done) return; // one output config, but be idempotent anyway
      done = true;

      // Resolved config wins over the ROOT guess: `--outDir`, a custom `root`,
      // and `publicDir: false` all have to be honoured or the guard protects a
      // directory nobody is publishing.
      const buildRoot = resolved?.root ?? ROOT;
      const outDir = path.resolve(buildRoot, resolved?.build?.outDir ?? 'dist');
      // `publicDir: false` resolves to '' — that means "there is no public dir",
      // not "use the default one", so don't fall back in that case.
      const publicDir = resolved ? (resolved.publicDir || null) : path.join(ROOT, 'public');
      const skipped = [];

      if (publicDir && existsSync(publicDir)) {
        cpSync(publicDir, outDir, {
          recursive: true,
          dereference: false,
          force: true,
          filter: (src) => {
            const rel = path.relative(publicDir, src).split(path.sep).join('/');
            if (!rel) return true;
            const denied = matchDeny(rel);
            if (denied) {
              skipped.push(`${rel} [${denied.id}]`);
              return false;
            }
            return true;
          },
        });
      }

      const removed = sweep(outDir, outDir);

      const n = skipped.length + removed.length;
      if (n) {
        const sample = [...skipped, ...removed.map((r) => `${r} (removed)`)].slice(0, 8);
        console.log(
          `\n  exclude-private-assets: kept ${n} unpublishable path(s) out of dist/ ` +
            `— ${sample.join(', ')}${n > sample.length ? `, +${n - sample.length} more` : ''}`,
        );
      }
      // Enforce on the directory that was actually produced. Throwing here fails
      // `vite build` with a nonzero exit, so a --outDir build can't quietly ship.
      const res = checkDist(outDir);
      if (!res.ok) {
        const lines = res.violations.slice(0, 12).map((v) => `    [${v.rule}] ${v.rel} (${fmt(v.size)}) — ${v.why}`);
        if (res.violations.length > lines.length) lines.push(`    ... and ${res.violations.length - lines.length} more`);
        throw new Error(
          `exclude-private-assets: ${res.violations.length} violation(s) in ${outDir} — this build MUST NOT be published.\n` +
            `${lines.join('\n')}\n` +
            '    (same policy as `node scripts/check-dist.mjs`; see that file for the fix.)',
        );
      }
      console.log(
        `  exclude-private-assets: ${outDir} passes check-dist ` +
          `(${res.entries.filter((e) => e.kind === 'file').length} files, ${fmt(res.totalBytes)}). ` +
          'deploy.ps1 re-runs the standalone guard before its first scp.',
      );
    },
  };
};

/** Delete anything denied that made it into dist/ by another route. */
function sweep(dir, base, removed = []) {
  if (!existsSync(dir)) return removed;
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (matchDeny(rel)) {
      rmSync(abs, { recursive: true, force: true });
      removed.push(rel);
      continue;
    }
    const st = lstatSync(abs);
    if (st.isDirectory()) sweep(abs, base, removed);
  }
  return removed;
}

// --- dev/preview network exposure -------------------------------------------
// LAN exposure is OPT-IN. Binding the dev server to 0.0.0.0 on Windows is the
// exact precondition of the vite dev-server advisories (GHSA-fx2h-pf6j-xcff
// `server.fs.deny` bypass via Windows alternate paths, and the esbuild
// arbitrary-file-read); `server.fs.strict: true` does not mitigate them. So the
// default is loopback, and anyone on the LAN — or on the coffee-shop Wi-Fi —
// gets nothing.
//
//   TESTING ON A REAL QUEST / HEADSET OVER LAN?  Set LAN=1:
//     PowerShell :  $env:LAN=1; npm run dev        (and: Remove-Item Env:LAN)
//     bash/zsh   :  LAN=1 npm run dev
//     one-off    :  npm run dev -- --host          (vite's own flag still works)
//   Same variable works for `npm run preview`.
const LAN = /^(1|true|yes|on)$/i.test(process.env.LAN ?? '');
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
if (LAN) {
  console.log('  [vite.config] LAN=1 — dev/preview server exposed on 0.0.0.0 (headset testing mode).');
}

export default defineConfig({
  // Relative base so the build can be served from any subpath
  // (e.g. https://dionysus.dk/webxr/libretrowebxr/) without rebuilding.
  base: './',
  plugins: [crossOriginIsolation(), excludePrivateAssets()],
  server: {
    host: HOST,
    port: 5173,
    fs: {
      // Don't let dev-server browse outside the project root.
      strict: true,
    },
  },
  preview: {
    host: HOST,
    port: 4173,
  },
  // Vite's dep pre-scan otherwise picks up every .html under source-projects/
  // and chokes on webretro's massive webxr.js. We only want our own index.html.
  optimizeDeps: {
    entries: ['index.html', 'desktop.html'],
  },
  build: {
    // OFF on purpose — excludePrivateAssets() does the copy with a deny filter,
    // so backups/credentials/scratch never reach dist/. Flipping this back to
    // true would restore the unfiltered copy.
    copyPublicDir: false,
    // Rollup's chunk-size advisory has ONE global threshold, so it cannot express
    // "three may be 600 kB but desktop may not be 60". The real per-chunk policy
    // is BUNDLE_BUDGETS in scripts/check-dist.mjs, which this build already runs
    // (and throws on) in excludePrivateAssets() below. Pin the advisory to the
    // largest budget there: any lower and it warns about `three` on every single
    // build, and a warning that fires on a known-good chunk is one people learn
    // to scroll past. Derived, not copied, so the two can't drift.
    chunkSizeWarningLimit: Math.round(
      Math.max(...Object.values(BUNDLE_BUDGETS).map((b) => b.bytes)) / 1000,
    ),
    rollupOptions: {
      // Two entry points: the VR app (index.html) and the flat-screen desktop
      // build (desktop.html). They share src/ modules; the desktop entry never
      // imports three, so its chunk stays three-free automatically.
      input: {
        main: 'index.html',
        desktop: 'desktop.html',
      },
      output: {
        // Split the bulky, rarely-changing three.js out of the app chunk
        // (Phase C polish). The prod bundle was one ~702 kB chunk; three is the
        // bulk of it. A separate vendor chunk downloads in parallel and stays
        // cached across our frequent app-only deploys — helps Quest load time.
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
        },
      },
    },
  },
});

// Re-exported so tooling can assert the build and the guard share one policy.
export { DENY_RULES };
