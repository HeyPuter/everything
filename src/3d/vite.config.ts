import { defineConfig } from 'vite';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puterLocalhost from '../../dev/puter-localhost.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const pyodidePackage = resolve(root, 'node_modules/pyodide');
const pyodideAssets = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];

function localPyodide() {
  return {
    name: 'local-pyodide-assets',
    configureServer(server) {
      server.middlewares.use('/pyodide', (req, res, next) => {
        if (req.method !== 'GET') return next();
        const asset = basename(new URL(req.url || '/', 'http://localhost').pathname);
        if (!pyodideAssets.includes(asset)) return next();
        const types = { '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.zip': 'application/zip', '.json': 'application/json' };
        res.setHeader('Content-Type', types[resolve(asset).slice(resolve(asset).lastIndexOf('.'))] || 'application/octet-stream');
        createReadStream(resolve(pyodidePackage, asset)).on('error', next).pipe(res);
      });
    },
    async closeBundle() {
      const output = resolve(root, 'dist/pyodide');
      await mkdir(output, { recursive: true });
      await Promise.all(pyodideAssets.map((asset) => copyFile(resolve(pyodidePackage, asset), resolve(output, asset))));
    },
  };
}

export default defineConfig({
  plugins: [puterLocalhost('3d'), localPyodide()],
});
