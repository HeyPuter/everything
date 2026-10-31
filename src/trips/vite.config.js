import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import puterLocalhost from '../../dev/puter-localhost.mjs';
import textScale from './tools/vite-text-scale.mjs';
import pwaPlugin from './tools/vite-pwa.mjs';

const entry = (path) => fileURLToPath(new URL(path, import.meta.url));

// `--mode mock` adds the fake-runtime and UI kit pages in a separate output for browser tests.
export default defineConfig(({ mode }) => {
  const mock = mode === 'mock';
  return {
    base: './',
    plugins: [puterLocalhost('trips'), textScale(), pwaPlugin()],
    build: {
      target: 'es2022',
      cssTarget: 'safari15',
      outDir: mock ? 'dist-mock' : 'dist',
      rollupOptions: {
        // Locale chunks get a recognizable name so the service worker caches only the one a user loads.
        output: {
          chunkFileNames: (chunk) => {
            const tag = /\/lib\/i18n\/([\w-]+)\/index\.js$/.exec(chunk.facadeModuleId ?? '')?.[1];
            return tag ? `assets/locale-${tag}-[hash].js` : 'assets/[name]-[hash].js';
          },
        },
        input: mock
          ? { app: entry('./index.html'), mock: entry('./mock.html'), kit: entry('./dev/kit.html') }
          : { app: entry('./index.html') },
      },
    },
    server: { port: 5301, strictPort: true },
    // The mock preview has its own port so browser tests can run beside `npm run dev`.
    preview: { port: mock ? 5304 : 5301, strictPort: true },
    test: {
      environment: 'jsdom',
      include: ['tests/unit/**/*.test.js', 'tests/worker/**/*.test.js'],
      restoreMocks: true,
    },
  };
});
