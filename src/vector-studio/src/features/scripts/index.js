/**
 * File > Scripts: built-in automation scripts and Other Script... to run a
 * .js file from the device (recently run scripts are listed too). Scripts
 * use the API documented in runner.js.
 */
import { runScript } from './runner.js';

export const BUILT_IN_SCRIPTS = [
  {
    id: 'export-artboards-svg',
    name: 'Export Artboards as SVG',
    source: `
const boards = vs.doc.artboards;
if (!boards.length) return 'No artboards.';
for (let i = 0; i < boards.length; i++) {
  const svg = await vs.exportSVG({ artboard: i });
  const name = (boards[i].name || 'Artboard ' + (i + 1)).replace(/[\\\\/:*?"<>|]+/g, '-');
  await vs.download(name + '.svg', svg, 'image/svg+xml');
}
return 'Exported ' + boards.length + ' artboard' + (boards.length === 1 ? '' : 's') + '.';`,
  },
  {
    id: 'random-fills',
    name: 'Randomize Fill Colors',
    source: `
const sel = (await vs.selection()).filter((n) => n.fill !== undefined && n.type !== 'group');
if (!sel.length) return 'Select objects to recolor.';
const hex = (v) => Math.round(v).toString(16).padStart(2, '0');
for (const n of sel) {
  const h = Math.random() * 360, s = 0.55 + Math.random() * 0.3, l = 0.45 + Math.random() * 0.2;
  const k = (m) => (m + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (m) => 255 * (l - a * Math.max(-1, Math.min(k(m) - 3, 9 - k(m), 1)));
  await vs.update(n.id, { fill: { type: 'solid', color: '#' + hex(f(0)) + hex(f(8)) + hex(f(4)) } });
}
return 'Recolored ' + sel.length + ' object' + (sel.length === 1 ? '' : 's') + '.';`,
  },
  {
    id: 'number-objects',
    name: 'Number Selected Objects',
    source: `
const sel = await vs.selection();
if (!sel.length) return 'Select objects to number.';
const answer = await vs.prompt('Start at', '1');
if (answer == null) return;
const start = Number(answer);
if (!Number.isFinite(start)) return;
let i = start;
for (const n of sel) {
  const pts = (n.anchors || []).length ? n.anchors : null;
  const x = pts ? Math.min(...pts.map((p) => p.x)) : (n.transform ? n.transform[4] : 0);
  const y = pts ? Math.min(...pts.map((p) => p.y)) : (n.transform ? n.transform[5] : 0);
  await vs.create({ type: 'text', text: String(i++), x, y: y - 4, char: { fontSize: 12 } });
}
return 'Numbered ' + sel.length + ' object' + (sel.length === 1 ? '' : 's') + '.';`,
  },
  {
    id: 'rename-by-order',
    name: 'Rename Selected Objects',
    source: `
const sel = await vs.selection();
if (!sel.length) return 'Select objects to rename.';
const base = await vs.prompt('Name', 'Item');
if (base == null) return;
let i = 1;
for (const n of sel) await vs.update(n.id, { name: base + ' ' + i++ });
return 'Renamed ' + sel.length + ' object' + (sel.length === 1 ? '' : 's') + '.';`,
  },
];

const RECENT_KEY = 'recentScripts';

async function run(app, name, source) {
  const r = await runScript(app, source, { name });
  if (r.ok) {
    if (r.value) app.notify(`${name}: ${r.value}`, { polite: true });
    else if (!r.changes) app.notify(`${name} finished.`, { polite: true });
  } else app.notify(`${name}: ${r.error}`, { error: true });
  return r;
}

/** Ask for a .js file and run it; remember it in the recent list (source kept locally). */
function runOtherScript(app) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.js,.mjs,text/javascript,application/javascript';
  input.hidden = true;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    const source = await file.text();
    const recent = (app.prefs.get(RECENT_KEY) || []).filter((r) => r.name !== file.name);
    // Small scripts are remembered so they can be run again from the menu.
    if (source.length < 64 * 1024) app.prefs.set(RECENT_KEY, [{ name: file.name, source }, ...recent].slice(0, 5));
    run(app, file.name.replace(/\.m?js$/i, ''), source);
  });
  document.body.append(input);
  input.click();
}

export function install(app) {
  app.commands.register([
    { id: 'file.otherScript', label: 'Other Script...', shortcut: 'Mod+F12', enabled: (a) => Boolean(a.editor), run: (a) => runOtherScript(a) },
    ...BUILT_IN_SCRIPTS.map((s) => ({ id: `script.${s.id}`, label: s.name, enabled: (a) => Boolean(a.editor), run: (a) => run(a, s.name, s.source) })),
  ]);
  app.menuSources.set('scripts', (a) => {
    const recent = a.prefs.get(RECENT_KEY) || [];
    return [
      ...BUILT_IN_SCRIPTS.map((s) => `script.${s.id}`),
      ...(recent.length ? ['-', ...recent.map((r) => ({ label: r.name, enabled: Boolean(a.editor), run: (x) => run(x, r.name.replace(/\.m?js$/i, ''), r.source) }))] : []),
      '-',
      'file.otherScript',
    ];
  });
}
