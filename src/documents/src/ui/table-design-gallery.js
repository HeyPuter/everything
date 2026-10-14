import { el } from './dom.js';
import { closeMenu } from './menu.js';
import { refreshConditionalTable } from '../engine/conditional-table-formatting.js';
import { conditionalFromSpec, specTableBorders, DEFAULT_LOOK, TABLE_STYLE_FAMILIES } from '../engine/table-styles.js';

// Table Style Options, in the two-column order of the ribbon group.
export const LOOK_OPTIONS = Object.freeze([
  ['firstRow', 'Header Row', false], ['firstColumn', 'First Column', false], ['lastRow', 'Total Row', false],
  ['lastColumn', 'Last Column', false], ['noHBand', 'Banded Rows', true], ['noVBand', 'Banded Columns', true],
]);

/** How each cell of a small table looks in a style: the engine's own region and border resolution. */
export function sampleCells(spec, look = DEFAULT_LOOK, rows = 5, columns = 5) {
  const table = { id: 'sample', grid: Array(columns).fill(1440), margins: {}, borders: specTableBorders(spec),
    rows: Array.from({ length: rows }, (_, r) => ({ id: `r${r}`, cells: Array.from({ length: columns }, (_, c) => ({ id: `r${r}c${c}`, span: 1, directBorders: {}, directMargins: {} })) })) };
  table.conditionalStyle = conditionalFromSpec(spec, look);
  refreshConditionalTable(table);
  const order = ['band1Horz', 'band2Horz', 'band1Vert', 'band2Vert', 'firstCol', 'lastCol', 'firstRow', 'lastRow'];
  return table.rows.flatMap((row, r) => row.cells.map((cell, c) => {
    const run = { ...spec.whole };
    for (const name of order) if (cell.styleRegions.includes(name)) Object.assign(run, Object.fromEntries(Object.entries(spec.regions[name] || {}).filter(([k]) => ['bold', 'color'].includes(k))));
    const edge = side => cell.borders[side] ?? table.borders[{ top: r ? 'insideH' : 'top', bottom: r === rows - 1 ? 'bottom' : 'insideH', left: c ? 'insideV' : 'left', right: c === columns - 1 ? 'right' : 'insideV' }[side]];
    return { row: r, column: c, fill: cell.shading && cell.shading !== 'auto' ? cell.shading : null, bold: !!run.bold, color: run.color || null,
      borders: Object.fromEntries(['top', 'bottom', 'left', 'right'].map(side => [side, edge(side)])) };
  }));
}

/** A style drawn on a small five-by-five table, as the gallery shows it. */
export function drawTableStyleThumbnail(canvas, spec, look, { width = 62, height = 46, rows = 5, columns = 5 } = {}) {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  // A browser may refuse another 2D context (canvas memory limits); leave the thumbnail blank.
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
  const pad = 4, cw = (width - pad * 2) / columns, rh = (height - pad * 2) / rows;
  let cells;
  try { cells = sampleCells(spec, look, rows, columns); } catch { return; }
  for (const cell of cells) {
    const x = pad + cell.column * cw, y = pad + cell.row * rh;
    if (cell.fill) { ctx.fillStyle = `#${cell.fill}`; ctx.fillRect(x, y, cw, rh); }
    // A short text stroke in each cell shows the text color and weight.
    ctx.fillStyle = cell.color && cell.color !== 'auto' ? `#${cell.color}` : '#555';
    ctx.fillRect(x + 2, y + rh / 2 - (cell.bold ? 1 : 0.5), cw * 0.55, cell.bold ? 2 : 1);
  }
  for (const cell of cells) {
    const x = pad + cell.column * cw, y = pad + cell.row * rh;
    for (const [side, border] of Object.entries(cell.borders)) {
      if (!border || border.style === 'nil' || border.style === 'none' || !border.size) continue;
      ctx.fillStyle = border.color === 'auto' ? '#000' : `#${border.color}`;
      const t = Math.max(0.75, border.size / 8);
      if (side === 'top') ctx.fillRect(x, y, cw, t);
      else if (side === 'bottom') ctx.fillRect(x, y + rh - t, cw, t);
      else if (side === 'left') ctx.fillRect(x, y, t, rh);
      else ctx.fillRect(x + cw - t, y, t, rh);
    }
  }
}

/**
 * Table Design → Table Style Options and the Table Styles gallery. Options change the selected table's
 * look at once (w:tblLook). The ribbon strip shows the first styles and the current one; More opens every
 * style by family, with Modify, Clear and New Table Style.
 */
export function createTableStyleGallery({ styles, current, look, setLook, apply, enabled }) {
  const boxes = LOOK_OPTIONS.map(([key, label, inverted]) => {
    const input = el('input', { type: 'checkbox', onchange: () => setLook({ [key]: inverted ? !input.checked : input.checked }) });
    return { key, inverted, input, node: el('label.ribbon-check', {}, input, label) };
  });
  const optionsGrid = el('div.ribbon-check-grid', {}, ...boxes.map(b => b.node));
  const gallery = el('div.ribbon-gallery.table-design-gallery', { role: 'listbox', 'aria-label': 'Table Styles', 'aria-orientation': 'horizontal', dataset: { shrinkMin: '2', shrinkMax: '520' } });
  const thumbnails = new Map();
  const item = (spec, { menu = false } = {}) => {
    const canvas = el('canvas', { 'aria-hidden': 'true' });
    const button = el(menu ? 'button.swatch.table-style-swatch' : 'button.ribbon-table-design', { type: 'button', role: menu ? 'menuitemradio' : 'option', title: spec.name, 'aria-label': spec.name, onclick: e => { if (menu) closeMenu(); apply(spec.id, { keepFormatting: !!e.altKey }); } }, canvas);
    button.addEventListener('mousedown', e => e.preventDefault());
    return { spec, button, canvas, drawn: '' };
  };
  let strip = [], signature = '';
  function rebuildStrip() {
    const all = styles(), id = current(), first = all.slice(0, 7);
    const shown = id && !first.some(s => s.id === id) && all.find(s => s.id === id) ? [...first.slice(0, 6), all.find(s => s.id === id)] : first;
    const key = shown.map(s => s.id + s.name).join();
    if (key === signature) return;
    signature = key;
    strip = shown.map(spec => thumbnails.get(spec.id) && thumbnails.get(spec.id).spec === spec ? thumbnails.get(spec.id) : (() => { const made = item(spec); thumbnails.set(spec.id, made); return made; })());
    gallery.replaceChildren(...strip.map(i => i.button));
  }
  function refresh() {
    const on = enabled(), view = look(), id = current(), lookKey = JSON.stringify(view);
    for (const { input, key, inverted } of boxes) { input.disabled = !on; input.checked = inverted ? !view[key] : !!view[key]; }
    rebuildStrip();
    for (const entry of strip) {
      entry.button.disabled = !on;
      entry.button.setAttribute('aria-selected', String(id === entry.spec.id));
      if (entry.drawn !== lookKey) { drawTableStyleThumbnail(entry.canvas, entry.spec, view); entry.drawn = lookKey; }
    }
  }
  /** The More panel: every style, grouped by family, as a grid of thumbnails. */
  function panelItems() {
    const all = styles(), view = look(), id = current(), on = enabled();
    const items = [];
    for (const [family, label] of TABLE_STYLE_FAMILIES) {
      const members = all.filter(s => (s.family || 'custom') === family);
      if (!members.length) continue;
      const grid = el('div.menu-custom-grid.table-style-grid', { dataset: { columns: '7' } }, ...members.map(spec => {
        const entry = item(spec, { menu: true });
        entry.button.disabled = !on; entry.button.tabIndex = -1;
        entry.button.setAttribute('aria-checked', String(spec.id === id));
        drawTableStyleThumbnail(entry.canvas, spec, view, { width: 58, height: 42 });
        return entry.button;
      }));
      items.push({ header: label }, { custom: grid });
    }
    return items;
  }
  return { optionsGrid, gallery, refresh, panelItems };
}
