/**
 * Built-in swatch libraries (original palettes) that the Swatches panel's
 * library menu opens, plus the user's saved libraries and library files.
 * Each entry: { id, name, swatches: [{ name, paint }] }.
 *
 * Library files are JSON ({ format: 'vector-studio-swatches', name,
 * swatches }) or plain-text palettes (a header line, an optional "Name:"
 * line, then "R G B name" rows), which also export solid colors.
 */
import { isHex, normalizeHex } from '../../lib/color.js';
import { colorName } from './swatch-model.js';
import { userLibraries, userLibraryMenu, saveLibraryDialog, exportLibraryFile, pickTextFile } from './user-libraries.js';
import { downloadBlob, safeFileName } from '../io/deliver.js';

export const SWATCH_FORMAT = 'vector-studio-swatches';
const solid = (name, color) => ({ name, paint: { type: 'solid', color } });
const lin = (name, angle, ...stops) => ({
  name,
  paint: { type: 'linear', angle, stops: stops.map(([offset, color]) => ({ offset, color, opacity: 1 })) },
});
const rad = (name, ...stops) => ({
  name,
  paint: { type: 'radial', angle: 0, stops: stops.map(([offset, color]) => ({ offset, color, opacity: 1 })) },
});

export const SWATCH_LIBRARIES = [
  {
    id: 'earth',
    name: 'Earth Tones',
    swatches: [
      solid('Clay', '#a0522d'), solid('Terracotta', '#c66b3d'), solid('Rust', '#8b3a1a'), solid('Ochre', '#c8962e'),
      solid('Sandstone', '#d8b98a'), solid('Umber', '#635147'), solid('Moss', '#6b7d3a'), solid('Olive Grove', '#55613a'),
      solid('Fern', '#4f7942'), solid('Bark', '#4a3728'), solid('Slate Rock', '#5f6b73'), solid('River Stone', '#8a8d84'),
    ],
  },
  {
    id: 'pastels',
    name: 'Pastels',
    swatches: [
      solid('Blush', '#f8c8d0'), solid('Peach Cream', '#ffd8b8'), solid('Butter', '#fff2b3'), solid('Mint', '#c7f0d8'),
      solid('Seafoam', '#b8ebe4'), solid('Baby Blue', '#bfdcf5'), solid('Periwinkle', '#c9c9f2'), solid('Lilac', '#dcc6f0'),
      solid('Rose Quartz', '#f2c6de'), solid('Pistachio', '#d9ecb8'),
    ],
  },
  {
    id: 'neutrals',
    name: 'Neutrals',
    swatches: [
      solid('Paper', '#faf8f3'), solid('Linen', '#efe9df'), solid('Oat', '#ddd3c2'), solid('Stone', '#c2b9ab'),
      solid('Greige', '#a39b8f'), solid('Taupe', '#857a6e'), solid('Charcoal', '#3f3d3a'), solid('Ink', '#1e1f22'),
      solid('Cool Gray', '#9aa1a9'), solid('Fog', '#d6dadf'),
    ],
  },
  {
    id: 'brights',
    name: 'Brights',
    swatches: [
      solid('Signal Red', '#ff2d3c'), solid('Tangerine', '#ff7a00'), solid('Sunflower', '#ffd400'), solid('Electric Lime', '#a6ff00'),
      solid('Vivid Green', '#00d26a'), solid('Aqua Pop', '#00e0d0'), solid('Bright Azure', '#0095ff'), solid('Ultramarine', '#3a3aff'),
      solid('Hot Violet', '#9b30ff'), solid('Fuchsia Pop', '#ff2ed1'),
    ],
  },
  {
    id: 'skin',
    name: 'Skin Tones',
    swatches: [
      solid('Tone 1', '#f6dcc8'), solid('Tone 2', '#efc8aa'), solid('Tone 3', '#e2b08c'), solid('Tone 4', '#d09a72'),
      solid('Tone 5', '#b97f58'), solid('Tone 6', '#9c6644'), solid('Tone 7', '#7d4f33'), solid('Tone 8', '#5e3a26'),
      solid('Tone 9', '#46291b'), solid('Tone 10', '#2f1c13'),
    ],
  },
  {
    id: 'metals',
    name: 'Metals',
    swatches: [
      lin('Gold Leaf', 0, [0, '#8a6623'], [0.3, '#f6e27a'], [0.55, '#c9a13b'], [0.8, '#f8eaa0'], [1, '#8a6623']),
      lin('Silver Sheen', 0, [0, '#8e9196'], [0.35, '#f2f3f5'], [0.6, '#a9adb3'], [1, '#e1e3e6']),
      lin('Copper Tone', 0, [0, '#7a3a1a'], [0.4, '#e0915c'], [0.7, '#b0592e'], [1, '#f0b48a']),
      lin('Bronze Cast', 0, [0, '#5b3d1e'], [0.45, '#c8975a'], [1, '#6e4a26']),
      lin('Brushed Steel', 90, [0, '#5d646c'], [0.5, '#c9ced4'], [1, '#6c737b']),
      rad('Chrome Ball', [0, '#ffffff'], [0.45, '#b9bec5'], [1, '#30343a']),
    ],
  },
];

const fromUser = (l) => ({ id: l.id, name: l.name, swatches: l.items, user: true });

/**
 * Menu spec for opening a library: built-in libraries, those other modules
 * add (app.extraSwatchLibraries), the user's saved ones, and a library file.
 */
export function swatchLibraryMenu(app, open) {
  return [
    ...[...SWATCH_LIBRARIES, ...(app.extraSwatchLibraries?.() || [])].map((lib) => ({ label: lib.name, run: () => open(lib) })),
    '-',
    { label: 'User Defined', submenu: userLibraryMenu(app, 'swatches', (l) => open(fromUser(l))) },
    { label: 'Other Library...', run: () => importSwatchLibrary(app).then((lib) => lib && open(lib)) },
  ];
}

export function userSwatchLibraries(app) {
  return userLibraries(app, 'swatches').map(fromUser);
}

export function saveSwatchLibrary(app, swatches) {
  return saveLibraryDialog(app, 'swatches', { title: 'Save Swatch Library', items: swatches, defaultName: app.editor?.title ? `${app.editor.title} Swatches` : 'My Swatches' });
}

/** Download swatches as a JSON library, or the solid colors as a text palette. */
export async function exportSwatchLibrary(app, swatches) {
  const res = await app.dialogs.form({
    title: 'Export Swatch Library',
    fields: [
      { key: 'name', label: 'Library Name', type: 'text', value: 'Swatches' },
      { key: 'format', label: 'Format', type: 'radio', value: 'json', options: [{ value: 'json', label: 'Swatch library (.json): colors, gradients and patterns' }, { value: 'gpl', label: 'Text palette (.gpl): colors only' }] },
    ],
  });
  if (!res) return;
  const name = res.name.trim() || 'Swatches';
  if (res.format === 'gpl') {
    const text = paletteText(name, swatches);
    downloadBlob(new Blob([text], { type: 'text/plain' }), `${safeFileName(name, 'Swatches')}.gpl`);
  } else exportLibraryFile(SWATCH_FORMAT, name, swatches, 'swatches');
}

export function paletteText(name, swatches) {
  const rows = swatches
    .filter((s) => s.paint?.type === 'solid')
    .map((s) => {
      const n = parseInt(s.paint.color.slice(1), 16);
      return `${String((n >> 16) & 255).padStart(3)} ${String((n >> 8) & 255).padStart(3)} ${String(n & 255).padStart(3)}\t${s.name}`;
    });
  return ['GIMP Palette', `Name: ${name}`, '#', ...rows, ''].join('\n');
}

/** Parse a library file's text into { name, swatches } or null. */
export function parseSwatchLibrary(text, fileName = 'Library') {
  const base = fileName.replace(/\.[^.]+$/, '');
  const t = String(text || '').trim();
  if (t.startsWith('{')) {
    try {
      const data = JSON.parse(t);
      const list = Array.isArray(data.swatches) ? data.swatches : Array.isArray(data.items) ? data.items : null;
      if (!list) return null;
      const swatches = list.filter((s) => s && s.paint && typeof s.paint.type === 'string').map((s) => ({ name: String(s.name || 'Swatch'), paint: s.paint, ...(s.global ? { global: true } : {}), ...(s.spot ? { spot: true } : {}) }));
      return swatches.length ? { name: String(data.name || base), swatches } : null;
    } catch {
      return null;
    }
  }
  let name = base;
  const swatches = [];
  for (const line of t.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || (l.startsWith('#') && !isHex(l.split(/\s+/)[0])) || /^GIMP Palette/i.test(l) || /^Columns:/i.test(l)) continue;
    const nm = /^Name:\s*(.+)$/i.exec(l);
    if (nm) {
      name = nm[1].trim();
      continue;
    }
    const m = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*(.*)$/.exec(l);
    const hex = m ? `#${[m[1], m[2], m[3]].map((v) => Math.min(255, Number(v)).toString(16).padStart(2, '0')).join('')}` : isHex(l.split(/\s+/)[0]) ? normalizeHex(l.split(/\s+/)[0]) : null;
    if (!hex) continue;
    const label = m ? m[4].trim() : l.split(/\s+/).slice(1).join(' ');
    swatches.push({ name: label && label !== 'Untitled' ? label : colorName(hex), paint: { type: 'solid', color: hex } });
  }
  return swatches.length ? { name, swatches } : null;
}

/** Pick a library file; resolves to a library { id, name, swatches } or null. */
export async function importSwatchLibrary(app) {
  const file = await pickTextFile('.json,.gpl,.txt,application/json,text/plain');
  if (!file) return null;
  const lib = parseSwatchLibrary(file.text, file.name);
  if (!lib) {
    app.notify('That file has no swatches this app can read.');
    return null;
  }
  return { id: `file-${lib.name}`, ...lib };
}
