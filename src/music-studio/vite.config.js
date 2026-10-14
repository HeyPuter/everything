import { defineConfig } from 'vite';
import puterLocalhost from '../../dev/puter-localhost.mjs';

export default defineConfig({
  plugins: [puterLocalhost('music-studio')],
  base: './',
  build: {
    target: 'es2022',
    cssTarget: 'safari16',
    chunkSizeWarningLimit: 1000,
  },
  server: {
    host: '127.0.0.1',
    port: 5641,
    strictPort: true,
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup.js'],
    testTimeout: 30000,
  },
});
