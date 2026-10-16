import { defineConfig } from 'vite';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import puterLocalhost from '../../dev/puter-localhost.mjs';

function serviceWorker() {
  let outDir = '';
  return {
    name: 'downloader-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const files = readdirSync(outDir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => path.relative(outDir, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join('/'))
        .filter((rel) => rel !== 'sw.js' && !rel.split('/').some((p) => p.startsWith('.')))
        .sort();

      const hash = createHash('sha256');
      for (const rel of files) {
        hash.update(rel);
        hash.update(readFileSync(path.join(outDir, rel)));
      }
      const version = hash.digest('hex').slice(0, 12);
      const assets = ['./', ...files.filter((f) => f !== 'index.html').map((f) => `./${f}`)];
      const template = readFileSync(fileURLToPath(new URL('./sw.template.js', import.meta.url)), 'utf8');
      writeFileSync(
        path.join(outDir, 'sw.js'),
        template.replaceAll('__VERSION__', version).replaceAll('__ASSETS__', JSON.stringify(assets))
      );
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [puterLocalhost('downloader'), serviceWorker()],
  build: {
    target: 'es2022',
    cssTarget: 'safari15',
  },
  server: {
    host: '127.0.0.1',
    port: 3000,
  },
});
