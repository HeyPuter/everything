import { createServer } from 'vite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const port = Number(process.argv[2] ?? 5302);
const server = await createServer({ cacheDir: join(tmpdir(), `trips-map-layers-vite-${port}`), server: { port, strictPort: true } });
await server.listen(); server.printUrls();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
