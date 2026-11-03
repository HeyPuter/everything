// Builds the map fixture once and previews it, so MapLibre runs from production chunks without dev-server reloads.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { E2E_PORTS } from '../../tools/e2e-ports.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const port = Number(process.argv[2] ?? E2E_PORTS.map);
const output = await mkdtemp(join(tmpdir(), 'trips-map-browser-'));
let server; let closing = false;
async function cleanup() {
  if (closing) return;
  closing = true;
  await new Promise(resolve => server?.httpServer ? server.httpServer.close(resolve) : resolve());
  await rm(output, { recursive: true, force: true });
}
try {
  await build({ root, configFile: false, publicDir: false, base: '/', logLevel: 'warn', build: { outDir: output, emptyOutDir: true, target: 'es2022', rollupOptions: { input: fileURLToPath(new URL('./fixture.html', import.meta.url)) } } });
  server = await preview({ root, configFile: false, publicDir: false, build: { outDir: output }, preview: { host: '127.0.0.1', port, strictPort: true } });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().then(() => process.exit()); });
} catch (error) { await cleanup(); throw error; }
