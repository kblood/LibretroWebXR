import { defineConfig } from 'vite';

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
    entries: ['index.html'],
  },
});
