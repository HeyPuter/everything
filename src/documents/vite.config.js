import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import puterLocalhost from '../../dev/puter-localhost.mjs';
import collabDevServer from './dev/collab-dev-server.mjs';

export default defineConfig({
  plugins: [puterLocalhost('documents'), collabDevServer()],
  base: './',
  build: {
    target: 'es2022',
    cssTarget: 'safari15',
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL('./index.html', import.meta.url)),
        playground: fileURLToPath(new URL('./playground.html', import.meta.url)),
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // Desktop editors and validation tools can lock generated exports on Windows. Test
    // output is not source and must not interrupt the shared preview watcher.
    watch: { ignored: ['**/~$*', '**/mso*.tmp', '**/test-results*', '**/test-results*/**'] },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Many tests open, edit and export whole packages in about a second; with a
    // worker per core on a 2-core CI runner they can exceed the 5 s default.
    testTimeout: 20000,
    // Node's native storage can shadow JSDOM's per-test browser storage.
    // Disable it in workers when supported, including Node 25 where it is on
    // by default without a usable localStorage unless a file is configured.
    execArgv: process.allowedNodeEnvironmentFlags.has('--no-experimental-webstorage')
      ? ['--no-experimental-webstorage'] : [],
  },
});
