import { defineConfig } from 'vite';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

// Safety guard: public/roms/local/ is a GITIGNORED folder holding the user's own
// COMMERCIAL ROMs (e.g. light-gun games) for local sideload testing only. Vite
// copies the whole publicDir into dist/ VERBATIM — it ignores .gitignore — so
// without this a routine `npm run build`/deploy would publish those copyrighted
// ROMs to the public server. Strip the folder from the build output (build only;
// dev serving from public/ is unaffected) so it can never ship by accident.
const stripLocalRoms = () => {
  let root = process.cwd();
  let outDir = 'dist';
  return {
    name: 'strip-local-roms',
    apply: 'build',
    configResolved(c) { root = c.root; outDir = c.build.outDir; },
    closeBundle() {
      const dir = resolve(root, outDir, 'roms', 'local');
      rmSync(dir, { recursive: true, force: true });
      console.log(`[strip-local-roms] ensured ${dir} is NOT in the build (local-only ROMs never ship)`);
    },
  };
};

// Cross-origin isolation headers are required to enable SharedArrayBuffer,
// which the worker-built libretro cores need for their pthread pool.
// Without these, the SNES9X worker core falls back to a single thread
// and the whole point of the architecture is gone.
const crossOriginIsolation = () => ({
  name: 'cross-origin-isolation',
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      next();
    });
  },
});

export default defineConfig({
  // Relative base so the build can be served from any subpath
  // (e.g. https://dionysus.dk/webxr/libretrowebxr/) without rebuilding.
  base: './',
  plugins: [crossOriginIsolation(), stripLocalRoms()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    fs: {
      // Don't let dev-server browse outside the project root.
      strict: true,
    },
  },
  // Vite's dep pre-scan otherwise picks up every .html under source-projects/
  // and chokes on webretro's massive webxr.js. We only want our own index.html.
  optimizeDeps: {
    entries: ['index.html'],
  },
  build: {
    rollupOptions: {
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
