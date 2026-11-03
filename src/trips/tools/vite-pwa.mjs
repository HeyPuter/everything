import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Public files the offline shell needs. config.json, worker/ and data/ are left out on purpose: the first two must
// always come from the network, and data/ is cached when first used.
const PUBLIC = ['manifest.webmanifest'];

export function precacheList(bundleFiles, publicFiles) {
  // Locale chunks are cached when first loaded, not up front.
  const assets = bundleFiles.filter((name) => !name.endsWith('.map') && name !== 'sw.js' && !name.startsWith('worker/') && !name.startsWith('assets/locale-')).map((name) => `./${name}`);
  return [...new Set(['./', ...assets, ...publicFiles.map((name) => `./${name}`)])];
}

/** Emits sw.js from src/sw.js with the precache list and a version hashed from every precached file. */
export default function pwa() {
  let root;
  return {
    name: 'trips-pwa',
    apply: 'build',
    // After Vite's HTML plugin, so the pages are in the bundle.
    enforce: 'post',
    configResolved(config) { root = config.root; },
    generateBundle(_options, bundle) {
      const publicDir = join(root, 'public');
      const icons = existsSync(join(publicDir, 'icons')) ? readdirSync(join(publicDir, 'icons')).filter((name) => name.endsWith('.png')).map((name) => `icons/${name}`) : [];
      const publicFiles = [...PUBLIC.filter((name) => existsSync(join(publicDir, name))), ...icons].sort();
      const hash = createHash('sha256');
      for (const [name, item] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update(item.type === 'chunk' ? item.code : item.source);
      for (const name of publicFiles) hash.update(name).update(readFileSync(join(publicDir, name)));
      const source = readFileSync(join(root, 'src/sw.js'), 'utf8');
      hash.update(source);
      const version = hash.digest('hex').slice(0, 12);
      const code = source
        .replaceAll('__SW_VERSION__', () => JSON.stringify(version))
        .replaceAll('__SW_ASSETS__', () => JSON.stringify(precacheList(Object.keys(bundle), publicFiles)));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: code });
    },
  };
}
