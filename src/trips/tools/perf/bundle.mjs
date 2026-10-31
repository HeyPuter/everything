// Production bundle sizes (architecture §18: the app shell loads first; MapLibre and heavy views load lazily).
// Builds the app into a temp dir with a manifest, then reports the initial load of index.html and, for every route,
// trip tab, settings section and heavy lazy module, what it adds on top. Sizes are raw and gzip.
// Run: node tools/perf/bundle.mjs [--json] [--modules[=<lazy entry, e.g. views/trip/plan/index.js>]]
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { args, kb, printTable } from './report.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const HEAVY = {
  'MapLibre (map runtime)': 'src/map/library-runtime.js',
  'Print view': 'src/views/print/index.js',
  'AI booking import': 'src/views/trip/bookings/import/index.js',
  'AI assistant': 'src/views/trip/assistant/panel.js',
  'Trip import/export': 'src/views/io/import.js',
  'Time zone lookup': 'node_modules/@photostructure/tz-lookup/tz.js',
};

const out = await mkdtemp(join(tmpdir(), 'trips-bundle-'));
try {
  await build({ root, configFile: join(root, 'vite.config.js'), logLevel: 'error', build: { outDir: out, emptyOutDir: true, manifest: true, sourcemap: 'hidden' } });
  const manifest = JSON.parse(await readFile(join(out, '.vite/manifest.json'), 'utf8'));
  const sizes = new Map();
  async function size(file) {
    if (!sizes.has(file)) { const bytes = await readFile(join(out, file)); sizes.set(file, { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length }); }
    return sizes.get(file);
  }
  /** Files a key loads (static imports, their CSS), optionally minus those already in `loaded`. */
  function closure(key, loaded = new Set()) {
    const files = new Set();
    const seen = new Set();
    const walk = (name) => {
      if (seen.has(name) || !manifest[name]) return;
      seen.add(name);
      const entry = manifest[name];
      for (const file of [entry.file, ...(entry.css ?? [])]) if (!loaded.has(file)) files.add(file);
      for (const next of entry.imports ?? []) walk(next);
    };
    walk(key);
    return files;
  }
  async function total(files) {
    let raw = 0; let gzip = 0; let js = 0;
    for (const file of files) { const item = await size(file); raw += item.raw; gzip += item.gzip; if (file.endsWith('.js')) js += item.gzip; }
    return { raw, gzip, js, count: files.size };
  }
  const describe = (sum) => `${kb(sum.gzip)} gzip (${kb(sum.js)} JS), ${kb(sum.raw)} raw, ${sum.count} files`;

  const initialFiles = closure('index.html');
  const initial = await total(initialFiles);
  // What a cold start parses before the dashboard shows, and what opening a trip adds (MapLibre follows when the map mounts).
  const dashboardFiles = new Set([...initialFiles, ...closure('src/views/dashboard/index.js')]);
  const dashboard = await total(dashboardFiles);
  const trip = await total(closure('src/views/trip/plan/index.js', dashboardFiles));
  const rows = [
    { area: 'Bundle', metric: 'Initial load (index.html)', budget: '—', value: describe(initial) },
    { area: 'Bundle', metric: 'Cold start to the dashboard (initial load + dashboard route)', budget: 'cold start < 1.5 s', value: describe(dashboard) },
    { area: 'Bundle', metric: 'Opening a trip adds (plan tab, without MapLibre)', budget: '—', value: describe(trip) },
  ];

  // Lazy entries: the dynamic imports the initial chunks make (routes, trip tabs, settings sections, background work).
  const initialKeys = Object.keys(manifest).filter((key) => initialFiles.has(manifest[key].file));
  const lazy = new Set(initialKeys.flatMap((key) => manifest[key].dynamicImports ?? []).filter((key) => !initialFiles.has(manifest[key]?.file)));
  const lazyRows = [];
  for (const key of [...lazy].sort()) {
    const sum = await total(closure(key, initialFiles));
    lazyRows.push({ area: 'Lazy', metric: key.replace(/^src\//, ''), budget: '—', value: describe(sum), gzip: sum.gzip });
  }
  lazyRows.sort((a, b) => b.gzip - a.gzip);
  rows.push(...lazyRows.map(({ gzip: _gzip, ...row }) => row));
  // Which chunk holds each heavy module, from the source maps.
  const holders = new Map();
  for (const file of new Set(Object.values(manifest).map((entry) => entry.file))) {
    if (!file.endsWith('.js')) continue;
    let map;
    try { map = JSON.parse(await readFile(join(out, `${file}.map`), 'utf8')); } catch { continue; }
    for (const source of map.sources) for (const key of Object.values(HEAVY)) if (source.endsWith(key)) holders.set(key, file);
  }
  for (const [label, key] of Object.entries(HEAVY)) {
    const file = holders.get(key);
    const inInitial = Boolean(file && initialFiles.has(file));
    rows.push({ area: 'Heavy', metric: `${label} stays out of the initial load`, budget: 'lazy', value: !file ? 'not found' : inInitial ? `in the initial load (${file})` : `lazy, in a ${kb((await size(file)).gzip)} gzip chunk`, ok: Boolean(file) && !inInitial });
  }
  printTable('Production bundle', rows);

  // `--modules` lists the largest sources in the initial load; `--modules=<lazy entry>` in what that entry adds.
  const listing = [...args].find((arg) => arg.startsWith('--modules'));
  if (listing) {
    const entry = listing.split('=')[1];
    const key = entry && Object.keys(manifest).find((name) => name.endsWith(entry));
    const files = key ? closure(key, initialFiles) : initialFiles;
    const modules = new Map();
    for (const file of files) {
      if (!file.endsWith('.js')) continue;
      let map;
      try { map = JSON.parse(await readFile(join(out, `${file}.map`), 'utf8')); } catch { continue; }
      map.sources.forEach((source, index) => {
        const name = source.includes('/src/trips/') ? source.slice(source.lastIndexOf('/src/trips/') + 11) : source.replace(/^(\.\.\/)+/, '');
        modules.set(name, (modules.get(name) ?? 0) + (map.sourcesContent?.[index]?.length ?? 0));
      });
    }
    console.log(`\nChunks of ${key ?? 'the initial load'} (gzip):`);
    for (const file of [...files].sort((a, b) => sizes.get(b).gzip - sizes.get(a).gzip).slice(0, 15)) console.log(`${kb(sizes.get(file).gzip).padStart(10)}  ${file}`);
    console.log('\nLargest sources (unminified bytes):');
    for (const [name, bytes] of [...modules].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`${kb(bytes).padStart(10)}  ${name}`);
  }
} finally {
  await rm(out, { recursive: true, force: true });
}
