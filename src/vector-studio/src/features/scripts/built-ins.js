/**
 * Built-in scripts (File > Scripts). They use only the public `vs` API
 * (runner.js), so they double as examples: the Script Editor can open any
 * of them as a starting point.
 */

const EXPORT_ARTBOARDS = `
const boards = vs.doc.artboards;
if (!boards.length) return 'No artboards.';
for (let i = 0; i < boards.length; i++) {
  const svg = await vs.exportSVG({ artboard: i });
  const name = (boards[i].name || 'Artboard ' + (i + 1)).replace(/[\\\\/:*?"<>|]+/g, '-');
  await vs.download(name + '.svg', svg, 'image/svg+xml');
}
return 'Exported ' + boards.length + ' artboard' + (boards.length === 1 ? '' : 's') + '.';`;

const RANDOM_FILLS = `
const sel = (await vs.selection()).filter((n) => n.fill !== undefined && n.type !== 'group');
if (!sel.length) return 'Select objects to recolor.';
const hex = (v) => Math.round(v).toString(16).padStart(2, '0');
const changes = sel.map((n) => {
  const h = Math.random() * 360, s = 0.55 + Math.random() * 0.3, l = 0.45 + Math.random() * 0.2;
  const k = (m) => (m + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (m) => 255 * (l - a * Math.max(-1, Math.min(k(m) - 3, 9 - k(m), 1)));
  return { id: n.id, patch: { fill: { type: 'solid', color: '#' + hex(f(0)) + hex(f(8)) + hex(f(4)) } } };
});
await vs.updateMany(changes);
return 'Recolored ' + sel.length + ' object' + (sel.length === 1 ? '' : 's') + '.';`;

const NUMBER_OBJECTS = `
const sel = await vs.selection();
if (!sel.length) return 'Select objects to number.';
const answer = await vs.prompt('Start at', '1');
if (answer == null) return;
const start = Number(answer);
if (!Number.isFinite(start)) return;
const boxes = await vs.bounds(sel.map((n) => n.id));
await vs.createMany(boxes.map((b, i) => ({
  type: 'text',
  text: String(start + i),
  x: b ? b.x : 0,
  y: (b ? b.y : 0) - 4,
  char: { fontSize: 12 },
})));
return 'Numbered ' + sel.length + ' object' + (sel.length === 1 ? '' : 's') + '.';`;

const RENAME_OBJECTS = `
const sel = await vs.selection();
if (!sel.length) return 'Select objects to rename.';
const base = await vs.prompt('Name', 'Item');
if (base == null) return;
await vs.updateMany(sel.map((n, i) => ({ id: n.id, patch: { name: base + ' ' + (i + 1) } })));
return 'Renamed ' + sel.length + ' object' + (sel.length === 1 ? '' : 's') + '.';`;

/**
 * Color by Number: every closed filled shape becomes an outlined region
 * with the number of its fill color at its label point; regions too small
 * to color keep their fill. A legend goes next to the artboard, the result
 * on a new layer, and the original art stays, hidden.
 */
const COLOR_BY_NUMBER = `
const LAYER = 'Color by Number';
const s = await vs.form('Color by Number', [
  { key: 'scope', label: 'Work on', type: 'select', value: 'auto', options: [
    { value: 'auto', label: 'Selection (whole document if none)' },
    { value: 'document', label: 'Whole document' },
  ] },
  { type: 'heading', label: 'Outlines' },
  { key: 'strokeWidth', label: 'Outline width', type: 'length', value: 0.5, min: 0.01, max: 50 },
  { key: 'strokeColor', label: 'Outline color', type: 'color', value: '#333333' },
  { key: 'minSize', label: 'Smallest region to color', type: 'length', value: 5, min: 0, max: 1000,
    help: 'Width of the largest circle that fits. Smaller regions keep their fill and get no number.' },
  { type: 'heading', label: 'Numbers' },
  { key: 'font', label: 'Font', type: 'text', value: 'Inter' },
  { key: 'minFont', label: 'Smallest size', type: 'length', value: 4, min: 0.5, max: 500 },
  { key: 'maxFont', label: 'Largest size', type: 'length', value: 14, min: 0.5, max: 500 },
  { key: 'numberColor', label: 'Number color', type: 'color', value: '#666666' },
  { key: 'legend', label: 'Add a legend beside the artboard', type: 'checkbox', value: true },
]);
if (!s) return;
const minFont = Math.min(s.minFont, s.maxFont);
const maxFont = Math.max(s.minFont, s.maxFont);
const fields = ['fill', 'closed', 'name'];
const want = { type: ['path', 'compound'], fill: true, visible: true, fields };

// What to work on: the selection, or every visible layer (not an earlier result).
const selection = await vs.selection();
const useSelection = s.scope === 'auto' && selection.length > 0;
let found = [];
let sourceLayers = [];
if (useSelection) {
  found = await vs.objects({ ...want, selected: true });
} else {
  sourceLayers = (await vs.layers()).filter((l) => !l.hidden && l.parent === 'root' && !l.name.startsWith(LAYER));
  for (const l of sourceLayers) found.push(...(await vs.objects({ ...want, within: l.id })));
}
const regions = found.filter((n) => n.type === 'compound' || n.closed);
if (!regions.length) return 'No closed filled shapes to number.';

// Colors in the order they first appear (back to front), numbered 1..N.
const keyOf = (fill) => fill.type === 'solid'
  ? String(fill.color).toLowerCase() + '/' + (fill.opacity == null ? 1 : fill.opacity)
  : JSON.stringify(fill);
const colors = new Map();
for (const r of regions) {
  const k = keyOf(r.fill);
  if (!colors.has(k)) colors.set(k, { number: colors.size + 1, fill: r.fill, count: 0 });
}

// Label points, a slice at a time so progress shows on big drawings.
const ids = regions.map((r) => r.id);
const spots = [];
const SLICE = 400;
for (let i = 0; i < ids.length; i += SLICE) {
  vs.progress(0.7 * i / ids.length, 'Measuring regions');
  spots.push(...(await vs.labelPoint(ids.slice(i, i + SLICE))));
}
vs.progress(0.7, 'Drawing outlines');

// The result layer holds the outlines, the numbers and the legend.
const layer = await vs.create({ type: 'layer', name: LAYER });
const [outlines, numbers] = await vs.createMany([
  { type: 'group', name: 'Regions' },
  { type: 'group', name: 'Numbers' },
], { parent: layer });
const copies = await vs.duplicate(ids, { parent: outlines });
const stroke = { type: 'solid', color: s.strokeColor };
const changes = [];
const labels = [];
let small = 0;
regions.forEach((r, i) => {
  const spot = spots[i];
  const color = colors.get(keyOf(r.fill));
  const tooSmall = !spot || spot.radius * 2 < s.minSize;
  changes.push({ id: copies[i], patch: {
    fill: tooSmall ? r.fill : null, stroke, strokeWidth: s.strokeWidth, strokeAlign: 'center', dash: [],
  } });
  if (tooSmall) {
    small++;
    return;
  }
  color.count++;
  const text = String(color.number);
  // The number's box (about 0.6 em per digit by 0.8 em) fits inside the circle.
  const fit = (0.9 * 2 * spot.radius) / Math.hypot(0.6 * text.length, 0.8);
  const size = Math.max(minFont, Math.min(maxFont, fit));
  labels.push({ spot, node: {
    type: 'text', text, x: spot.x, y: spot.y, name: text,
    char: { fontFamily: s.font || 'Inter', fontSize: size },
    para: { align: 'center' },
    fill: { type: 'solid', color: s.numberColor }, stroke: null,
  } });
});
await vs.updateMany(changes);
vs.progress(0.8, 'Placing numbers');

// Numbers: created at their spots, then centered there by their measured bounds.
const center = async (items, parent) => {
  const made = await vs.createMany(items.map((it) => it.node), { parent });
  const boxes = await vs.bounds(made);
  await vs.updateMany(made.map((id, i) => {
    const b = boxes[i];
    const it = items[i];
    const dx = b ? it.spot.x - (b.x + b.w / 2) : 0;
    const dy = b ? it.spot.y - (b.y + b.h / 2) : 0;
    return { id, patch: { x: it.node.x + dx, y: it.node.y + dy } };
  }));
  return made;
};
if (labels.length) await center(labels, numbers);

// Legend: a swatch and its number per color, in columns to the right of the artboard.
const used = [...colors.values()];
if (s.legend && used.length) {
  vs.progress(0.9, 'Adding the legend');
  const boards = vs.doc.artboards;
  const first = spots.find(Boolean);
  const board = (first && boards.find((a) => first.x >= a.x && first.x <= a.x + a.w && first.y >= a.y && first.y <= a.y + a.h)) || boards[0] || { x: 0, y: 0, w: 612, h: 792 };
  const sw = 18;
  const row = 26;
  const col = 64;
  const perCol = Math.max(1, Math.floor(board.h / row));
  const legend = await vs.create({ type: 'group', name: 'Legend' }, { parent: layer });
  const swatches = [];
  const legendLabels = [];
  used.forEach((c, i) => {
    const x = board.x + board.w + 24 + Math.floor(i / perCol) * col;
    const y = board.y + (i % perCol) * row;
    swatches.push({
      type: 'path', closed: true, name: 'Color ' + c.number,
      anchors: [{ x, y }, { x: x + sw, y }, { x: x + sw, y: y + sw }, { x, y: y + sw }],
      fill: c.fill, stroke, strokeWidth: s.strokeWidth,
    });
    legendLabels.push({ spot: { x: x + sw + 14, y: y + sw / 2 }, node: {
      type: 'text', text: String(c.number), x: x + sw + 14, y: y + sw / 2, name: String(c.number),
      char: { fontFamily: s.font || 'Inter', fontSize: 12 }, para: { align: 'center' },
      fill: { type: 'solid', color: '#000000' }, stroke: null,
    } });
  });
  await vs.createMany(swatches, { parent: legend });
  await center(legendLabels, legend);
}

// The original art stays in the document, hidden.
if (useSelection) await vs.updateMany(selection.map((n) => ({ id: n.id, patch: { hidden: true } })));
else await vs.updateMany(sourceLayers.map((l) => ({ id: l.id, patch: { hidden: true } })));
vs.progress(1, 'Done');
return 'Numbered ' + labels.length + ' region' + (labels.length === 1 ? '' : 's') + ' in ' + used.length +
  ' color' + (used.length === 1 ? '' : 's') + (small ? '; ' + small + ' too small to color kept their fill' : '') + '.';`;

/** Select Smallest Object: the closed filled object with the least area in the document. */
const SELECT_SMALLEST = `
const found = await vs.objects({ type: ['path', 'compound'], fill: true, closed: true, visible: true, fields: ['name'] });
if (!found.length) return 'No closed filled objects.';
const ids = found.map((n) => n.id);
const areas = [];
const SLICE = 1000;
for (let i = 0; i < ids.length; i += SLICE) {
  vs.progress(i / ids.length, 'Measuring');
  areas.push(...(await vs.area(ids.slice(i, i + SLICE))));
}
let best = -1;
areas.forEach((a, i) => {
  if (a != null && (best < 0 || a < areas[best])) best = i;
});
if (best < 0) return 'No closed filled objects.';
await vs.select([ids[best]]);
try {
  await vs.command('view.fitSelection');
} catch (err) {
  // Not in view: the selection still shows it.
}
const unit = vs.doc.units;
const area = areas[best] / (vs.doc.pointsPerUnit * vs.doc.pointsPerUnit);
const digits = area >= 100 ? 1 : area >= 1 ? 3 : 5;
const label = found[best].name || (found[best].type === 'compound' ? 'compound path' : 'path');
return 'Smallest of ' + ids.length + ': ' + label + ', ' + area.toFixed(digits) + ' sq ' + unit + '.';`;

export const BUILT_IN_SCRIPTS = [
  {
    id: 'color-by-number',
    name: 'Color by Number',
    label: 'Color by Number...',
    source: COLOR_BY_NUMBER,
  },
  { id: 'select-smallest', name: 'Select Smallest Object', source: SELECT_SMALLEST },
  { id: 'export-artboards-svg', name: 'Export Artboards as SVG', source: EXPORT_ARTBOARDS },
  { id: 'random-fills', name: 'Randomize Fill Colors', source: RANDOM_FILLS },
  { id: 'number-objects', name: 'Number Selected Objects', source: NUMBER_OBJECTS },
  { id: 'rename-by-order', name: 'Rename Selected Objects', source: RENAME_OBJECTS },
];
