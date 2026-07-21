import { defineConfig } from 'vite';

// Cross-origin isolation headers are required to enable SharedArrayBuffer,
// which threaded libretro cores and the PSX JIT need for shared Wasm memory.
const crossOriginIsolation = () => ({
  name: 'cross-origin-isolation',
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      // Runtime Wasm compilation is the PSX dynarec's code-generation
      // mechanism. This permits Wasm compilation without permitting JS eval.
      res.setHeader('Content-Security-Policy', "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:");
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Content-Security-Policy', "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:");
      next();
    });
  },
});

export default defineConfig({
  // Relative base so the build can be served from any subpath
  // (e.g. https://dionysus.dk/webxr/libretrowebxr/) without rebuilding.
  base: './',
  plugins: [crossOriginIsolation()],
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
    entries: ['index.html', 'desktop.html'],
  },
  build: {
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
