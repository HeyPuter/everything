import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { PROTOCOL } from './src/shared/protocol.js';

const entry = fileURLToPath(new URL('./worker/index.js', import.meta.url));

// `build` is an id of 6–64 lowercase alphanumerics (Unix seconds unless TRIPS_BUILD is set); `builtAt` orders builds.
export default defineConfig(() => {
  const builtAt = Number(process.env.TRIPS_BUILT_AT) || Date.now();
  const build = process.env.TRIPS_BUILD || String(Math.floor(builtAt / 1000));
  if (!/^[0-9a-z]{6,64}$/.test(build) || !Number.isSafeInteger(builtAt)) throw new Error('TRIPS_BUILD must be 6–64 lowercase alphanumerics');
  return {
    publicDir: false,
    define: {
      __TRIPS_BUILD__: JSON.stringify(build),
      __TRIPS_BUILT_AT__: JSON.stringify(builtAt),
    },
    build: {
      target: 'es2022',
      outDir: 'public/worker',
      emptyOutDir: true,
      minify: false,
      lib: {
        entry,
        formats: ['iife'],
        name: 'tripsWorker',
        fileName: () => 'trips-worker.js',
      },
      rollupOptions: {
        output: { banner: `/*! trips-worker build=${build} at=${builtAt} protocol=${PROTOCOL} */` },
      },
    },
  };
});
