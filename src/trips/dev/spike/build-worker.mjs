import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// This command writes a local bundle. Upload/deployment is always a separate manual step.
await build({
  configFile: false,
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: fileURLToPath(new URL('./dist/', import.meta.url)),
    emptyOutDir: true,
    minify: false,
    lib: { entry: fileURLToPath(new URL('./worker-entry.js', import.meta.url)), formats: ['iife'], name: 'TripsF0Spike', fileName: () => 'trips-f0-worker.js' },
  },
});
