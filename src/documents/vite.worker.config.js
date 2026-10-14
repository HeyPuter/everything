// Bundles the room worker (src/collab/server) that owners deploy to their
// Puter account for shared documents: npm run build:worker writes
// public/worker/documents-worker.js. The build identifier is a hash of the
// bundle itself, so any change to the worker triggers an update on the next share.
import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';

const PLACEHOLDER = '__DOCUMENTS_WORKER_BUILD__';
export default defineConfig({
  publicDir: false,
  logLevel: 'warn',
  plugins: [{
    name: 'documents-worker-metadata',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) if (output.type === 'chunk' && output.isEntry) {
        const build = createHash('sha256').update(output.code).digest('hex').slice(0, 16);
        output.code = `/* documents-worker build=${build} */\n${output.code.replaceAll(PLACEHOLDER, build)}`;
      }
    },
  }],
  define: { __WORKER_BUILD__: JSON.stringify(PLACEHOLDER) },
  build: {
    target: 'es2022',
    outDir: 'public/worker',
    emptyOutDir: true,
    lib: { entry: 'src/collab/server/index.js', name: 'DocumentsWorker', formats: ['iife'], fileName: () => 'documents-worker.js' },
  },
});
