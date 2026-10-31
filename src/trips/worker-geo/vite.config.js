import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
export default defineConfig({
  publicDir: false,
  build: {
    target: 'es2022', outDir: 'worker-geo/dist', emptyOutDir: true, minify: false,
    lib: { entry: fileURLToPath(new URL('./index.js', import.meta.url)), formats: ['iife'], name: 'tripsGeo', fileName: () => 'trips-geo.js' },
  },
});
