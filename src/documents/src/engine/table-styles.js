// Table styles for Table Design → Table Styles: a library of original looks in
// three families (plain, grid and list) with accent colors, and the documents'
// own styles made with New Table Style. A style is a real table style
// (ECMA-376 §17.7.6): whole-table borders and margins plus conditional regions
// (§17.7.6.6) for the header and total rows, first and last columns and bands.
// Table Style Options choose which regions apply through w:tblLook (§17.4.55).
//
// A spec (below) describes a style. From it come the style definition the
// paragraph cascade reads, the conditional style the table cells read, and,
// at save time, the styles.xml declaration (docx-table-styles.js).
import { checkedCellBorder } from './cell-borders.js';
import { tableStyleLook } from './table-style-regions.js';
import { tableModelInternals as M } from './model.js';
import { tableCells, verticalMerges } from './tables.js';
import { selectionBlock } from './table-editing.js';
import { resolveCellBorders } from './cell-borders.js';
import { cellShadingFill } from './backgrounds.js';

export const STYLE_REGIONS = Object.freeze(['firstRow', 'lastRow', 'firstCol', 'lastCol', 'band1Horz', 'band1Vert']);
export const REGION_LABELS = Object.freeze({ whole: 'Whole table', firstRow: 'Header row', lastRow: 'Total row', firstCol: 'First column', lastCol: 'Last column', band1Horz: 'Banded rows', band1Vert: 'Banded columns' });
export const DEFAULT_LOOK = Object.freeze(tableStyleLook());

/** Accent palettes: [name, dark, light, medium]. */
export const ACCENTS = Object.freeze([
  ['Blue', '2E5E8C', 'DCE6F2', 'A7BED9'], ['Teal', '1F7A7A', 'D7EEEE', '9FD0D0'], ['Green', '4A7A35', 'E3EFDB', 'AFCF9C'],
  ['Orange', 'B85C1E', 'FBE6D6', 'F2B98F'], ['Red', 'A33A3A', 'F6DEDE', 'E0A3A3'], ['Purple', '66468C', 'E9E1F2', 'C1AED8'],
  ['Gray', '4D4D4D', 'EDEDED', 'BDBDBD'],
]);

const line = (color = 'auto', size = 4, style = 'single') => ({ style, size, color });
const NIL = 'nil';
const grid = border => ({ top: border, left: border, bottom: border, right: border, insideH: border, insideV: border });

function plain() {
  return [
    { id: 'DocsTablePlain', name: 'Plain', family: 'plain', borders: grid(NIL), regions: { firstRow: { bold: true }, lastRow: { bold: true }, firstCol: { bold: true } } },
    { id: 'DocsTablePlainGrid', name: 'Plain Grid', family: 'plain', borders: grid(line('000000')), regions: {} },
    { id: 'DocsTablePlainLightGrid', name: 'Light Grid', family: 'plain', borders: grid(line('BFBFBF')),
      regions: { firstRow: { bold: true, borders: { bottom: line('7F7F7F', 12) } }, lastRow: { bold: true, borders: { top: line('7F7F7F', 8) } }, firstCol: { bold: true }, lastCol: { bold: true } } },
    { id: 'DocsTablePlainRules', name: 'Rules', family: 'plain', borders: { ...grid(NIL), top: line('000000', 12), bottom: line('000000', 12) },
      regions: { firstRow: { bold: true, borders: { bottom: line('000000', 6) } }, lastRow: { bold: true, borders: { top: line('000000', 6) } }, firstCol: { bold: true } } },
    { id: 'DocsTablePlainBands', name: 'Gray Bands', family: 'plain', borders: grid(NIL),
      regions: { firstRow: { bold: true, borders: { bottom: line('7F7F7F', 8) } }, lastRow: { bold: true, borders: { top: line('7F7F7F', 8) } }, firstCol: { bold: true }, band1Horz: { fill: 'F2F2F2' }, band1Vert: { fill: 'F2F2F2' } } },
  ];
}
function gridFamily([accent, dark, light, mid]) {
  return [
    { id: `DocsTableGridLight${accent}`, name: `Grid Light · ${accent}`, family: 'grid', accent, borders: grid(line(mid)),
      regions: { firstRow: { bold: true, borders: { bottom: line(dark, 12) } }, lastRow: { bold: true, borders: { top: line(dark, 8) } }, firstCol: { bold: true }, lastCol: { bold: true } } },
    { id: `DocsTableGridBanded${accent}`, name: `Grid Banded · ${accent}`, family: 'grid', accent, borders: grid(line(mid)),
      regions: { firstRow: { bold: true, color: 'FFFFFF', fill: dark, borders: { top: line(dark), left: line(dark), right: line(dark), insideV: line(dark) } }, lastRow: { bold: true, borders: { top: line(dark, 12) } }, firstCol: { bold: true }, lastCol: { bold: true }, band1Horz: { fill: light }, band1Vert: { fill: light } } },
    { id: `DocsTableGridBold${accent}`, name: `Grid Bold · ${accent}`, family: 'grid', accent, borders: { ...grid(line('FFFFFF')), top: line(dark), bottom: line(dark), left: line(dark), right: line(dark) },
      regions: { firstRow: { bold: true, color: 'FFFFFF', fill: dark }, lastRow: { bold: true, color: 'FFFFFF', fill: dark }, firstCol: { bold: true, color: 'FFFFFF', fill: dark }, lastCol: { bold: true, color: 'FFFFFF', fill: dark }, band1Horz: { fill: mid }, band1Vert: { fill: mid } },
      whole: { fill: light } },
  ];
}
function listFamily([accent, dark, light]) {
  return [
    { id: `DocsTableListLight${accent}`, name: `List Light · ${accent}`, family: 'list', accent, borders: { ...grid(NIL), top: line(dark, 8), bottom: line(dark, 8) },
      regions: { firstRow: { bold: true, borders: { bottom: line(dark, 8) } }, lastRow: { bold: true, borders: { top: line(dark, 8) } }, firstCol: { bold: true }, lastCol: { bold: true }, band1Horz: { fill: light }, band1Vert: { fill: light } } },
    { id: `DocsTableListHeader${accent}`, name: `List Header · ${accent}`, family: 'list', accent, borders: { ...grid(NIL), bottom: line(dark, 8), insideH: line(light, 4) },
      regions: { firstRow: { bold: true, color: 'FFFFFF', fill: dark }, lastRow: { bold: true, borders: { top: line(dark, 12) } }, firstCol: { bold: true }, lastCol: { bold: true }, band1Horz: { fill: light } } },
    { id: `DocsTableListAccent${accent}`, name: `List Accent · ${accent}`, family: 'list', accent, borders: grid(NIL),
      regions: { firstRow: { bold: true, color: dark, borders: { bottom: line(dark, 12) } }, lastRow: { bold: true, color: dark, borders: { top: line(dark, 8) } }, firstCol: { bold: true, color: dark }, lastCol: { bold: true, color: dark }, band1Horz: { borders: { top: line(light), bottom: line(light) } } } },
  ];
}

/** The built-in library, in gallery order: the plain family, then each grid and list look in every accent. */
export const TABLE_STYLE_LIBRARY = Object.freeze([
  ...plain(),
  ...gridFamily(ACCENTS[0]).flatMap((_, i) => ACCENTS.map(a => gridFamily(a)[i])),
  ...listFamily(ACCENTS[0]).flatMap((_, i) => ACCENTS.map(a => listFamily(a)[i])),
].map(spec => Object.freeze({ rowBands: 1, columnBands: 1, ...spec })));
export const TABLE_STYLE_FAMILIES = Object.freeze([['plain', 'Plain Tables'], ['grid', 'Grid Tables'], ['list', 'List Tables'], ['custom', 'Custom']]);

const border = value => checkedCellBorder(value === NIL || !value ? { style: 'nil' } : { style: value.style || 'single', size: value.size ?? 4, color: value.color || 'auto' });
function borders(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([side, v]) => [side, border(v)]));
}

/** Check a spec from the Modify/New Table Style dialog, returning a clean copy. */
export function checkedTableStyleSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('Describe the table style.');
  const name = String(spec.name || '').trim();
  if (!name || name.length > 100) throw new Error('Name the table style (up to 100 characters).');
  if (!/^[A-Za-z][A-Za-z0-9]{0,99}$/.test(spec.id || '')) throw new Error('A table style needs a simple identifier.');
  const color = c => c == null || c === 'auto' ? c ?? null : /^[0-9A-Fa-f]{6}$/.test(c) ? c.toUpperCase() : (() => { throw new Error('Use six-digit RGB colors.'); })();
  const side = v => v === NIL || v == null ? v ?? undefined : (border(v), { style: v.style || 'single', size: v.size ?? 4, color: color(v.color) || 'auto' });
  const sides = value => value ? Object.fromEntries(Object.entries(value).filter(([key]) => ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].includes(key)).map(([key, v]) => [key, side(v)]).filter(([, v]) => v !== undefined)) : undefined;
  const region = value => {
    if (!value) return undefined;
    const out = {};
    if (value.fill) out.fill = color(value.fill);
    if (value.color) out.color = color(value.color);
    if (value.bold) out.bold = true;
    if (value.italic) out.italic = true;
    const b = sides(value.borders); if (b && Object.keys(b).length) out.borders = b;
    return Object.keys(out).length ? out : undefined;
  };
  const regions = Object.fromEntries(STYLE_REGIONS.map(name => [name, region(spec.regions?.[name])]).filter(([, v]) => v));
  return { id: spec.id, name, family: spec.family || 'custom', ...(spec.accent ? { accent: spec.accent } : {}), borders: sides(spec.borders) || {}, regions,
    ...(region(spec.whole) ? { whole: region(spec.whole) } : {}), rowBands: 1, columnBands: 1, ...(spec.basedOn ? { basedOn: spec.basedOn } : {}) };
}

/** The style definition the paragraph cascade reads (as styles.xml would give on reopening). */
export function styleDefinition(spec) {
  const run = value => ({ ...(value?.bold ? { bold: true, boldCs: true } : {}), ...(value?.italic ? { italic: true, italicCs: true } : {}), ...(value?.color ? { color: value.color } : {}) });
  return {
    id: spec.id, type: 'table', name: spec.name, basedOn: null, next: null,
    properties: { spacing: { after: '0', line: '240', lineRule: 'auto' } }, reference: {},
    run: run(spec.whole),
    conditionals: Object.fromEntries(Object.entries(spec.regions).filter(([, r]) => r.bold || r.italic || r.color).map(([name, r]) => [name, { run: run(r) }])),
    generated: true, tableSpec: structuredClone(spec),
  };
}

/** Whole-table borders (w:tblBorders of the style). */
export const specTableBorders = spec => borders(spec.borders);

/** The conditional style the table's cells read (as docx-tables.js would give on reopening). */
export function conditionalFromSpec(spec, look = DEFAULT_LOOK, compatibilityMode = 15) {
  const conditionals = {};
  for (const [name, region] of Object.entries(spec.regions)) {
    const cell = { margins: {}, borders: borders(region.borders), ...(region.fill ? { shading: region.fill } : {}) };
    conditionals[name] = { cell };
  }
  const whole = spec.whole?.fill ? { shading: spec.whole.fill } : {};
  return { chain: [{ conditionals }], cell: { ...whole }, row: { cantSplit: false, header: false, minHeight: 0 },
    settings: { look: { ...look }, rowBandSize: spec.rowBands ?? 1, columnBandSize: spec.columnBands ?? 1, definedRegions: Object.keys(conditionals), compatibilityMode } };
}

/** The look of a table: which regions of its style apply. */
export function tableLook(table) {
  return { ...(table.conditionalStyle?.settings.look || table.look || DEFAULT_LOOK) };
}

/** A spec by style id: the library's, or one this document defines with New Table Style. */
export function tableStyleSpec(styles, id) {
  return styles.definitions[id]?.tableSpec || TABLE_STYLE_LIBRARY.find(spec => spec.id === id) || null;
}
/** Every style the gallery offers: the library, then the document's own. */
export function availableTableStyles(styles) {
  const own = Object.values(styles.definitions).filter(s => s.type === 'table' && s.tableSpec && !TABLE_STYLE_LIBRARY.some(l => l.id === s.id)).map(s => s.tableSpec);
  return [...TABLE_STYLE_LIBRARY, ...own];
}

function styledTables(model, id) { return model.tables.filter(t => t.styleId === id); }

// Restyle one table from its spec: style borders, conditional regions and the cell paragraphs' cascade.
function restyle(model, table, spec, look) {
  const compatibility = model.pageSettings.compatibilityMode ?? 15;
  table.borders = { ...specTableBorders(spec) };
  table.conditionalStyle = conditionalFromSpec(spec, look, compatibility);
  table.look = { ...look };
  if (!table.conditionalStyle.settings.definedRegions.length && !Object.keys(table.conditionalStyle.cell).length) {
    // A style without regions: cells inherit nothing beyond the table's borders.
    for (const cell of tableCells(table)) {
      cell.inheritedBorders = {}; cell.borders = resolveCellBorders({}, cell.directBorders); delete cell.styleWritingTopBorder;
      cell.inheritedShading = 'auto'; if (!cell.shadingExplicit || cell.shadingNil) { cell.shading = 'auto'; cell.fill = cellShadingFill('auto'); }
    }
  }
  const ids = new Set(tableCells(table).map(cell => cell.id));
  for (const p of model.paragraphs) if (ids.has(p.cellId)) p.tableStyleId = table.styleId;
  M.refreshTableStyles(model, table);
}

/** Apply a table style to the selected table. `keepFormatting` leaves direct cell borders and shading in place. */
export function applyTableStyle(model, id, { keepFormatting = false } = {}) {
  const spec = tableStyleSpec(model.styles, id);
  if (!spec) throw new Error('Choose a table style.');
  const block = selectionBlock(model);
  if (!block) throw new Error('Put the cursor in a table to apply a style.');
  const table = block.table;
  model.checkpoint();
  if (!model.styles.definitions[id]) {
    model.styles = structuredClone(model.styles);
    model.styles.definitions[id] = styleDefinition(spec);
  }
  model.stylesEnabled = true;
  const look = tableLook(table);
  if (table.styleId !== id) { table.styleId = id; table.styleChanged = true; }
  // A style replaces the table's own borders; cells keep theirs only when asked.
  table.bordersCleared = true;
  if (!keepFormatting) for (const cell of tableCells(table)) {
    if (Object.keys(cell.directBorders || {}).length) {
      cell.borderChanges = { ...cell.borderChanges, ...Object.fromEntries(Object.keys(cell.directBorders).map(side => [side, null])) };
      cell.directBorders = {};
    }
    if (cell.shadingExplicit) { cell.shadingExplicit = false; cell.shadingNil = false; cell.shadingChanged = true; }
  }
  if (!table.look || !sameLook(table.look, look)) table.lookChanged = true;
  restyle(model, table, spec, look);
  table.lookChanged = true;
  model.didChange(); return true;
}
const sameLook = (a, b) => Object.keys(DEFAULT_LOOK).every(key => !!a[key] === !!b[key]);

/** Table Style Options: turn style regions on or off (`firstRow`, `lastRow`, `firstColumn`, `lastColumn`, `noHBand`, `noVBand`). */
export function setTableLook(model, patch) {
  const block = selectionBlock(model);
  if (!block) throw new Error('Put the cursor in a table first.');
  const table = block.table, look = { ...tableLook(table) };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_LOOK) || typeof value !== 'boolean') throw new Error('Unknown table style option.');
    look[key] = value;
  }
  if (sameLook(look, tableLook(table))) return false;
  model.checkpoint();
  table.look = look; table.lookChanged = true;
  if (table.conditionalStyle) {
    table.conditionalStyle = { ...table.conditionalStyle, settings: { ...table.conditionalStyle.settings, look } };
    // Rows with their own tblLook exceptions follow the table's new choice.
    for (const row of table.rows) if (row.styleLook) { delete row.styleLook; row.styleLookCleared = true; }
    M.refreshTableStyles(model, table);
  }
  model.didChange(); return true;
}

/** Clear: the table loses its style, and with it the style's borders, fills and regional text formatting. */
export function clearTableStyle(model) {
  const block = selectionBlock(model);
  if (!block) throw new Error('Put the cursor in a table first.');
  const table = block.table;
  model.checkpoint();
  table.styleId = null; table.styleChanged = true; table.bordersCleared = true;
  table.borders = {};
  table.conditionalStyle = { chain: [], cell: {}, row: { cantSplit: false, header: false, minHeight: 0 }, settings: { look: tableLook(table), rowBandSize: 0, columnBandSize: 0, definedRegions: [], compatibilityMode: model.pageSettings.compatibilityMode ?? 15 } };
  for (const cell of tableCells(table)) {
    cell.inheritedBorders = {}; cell.borders = resolveCellBorders({}, cell.directBorders); delete cell.styleWritingTopBorder;
    cell.inheritedShading = 'auto'; if (!cell.shadingExplicit || cell.shadingNil) { cell.shading = 'auto'; cell.fill = null; }
  }
  const ids = new Set(tableCells(table).map(cell => cell.id));
  for (const p of model.paragraphs) if (ids.has(p.cellId)) { p.tableStyleId = null; p.tableStyleRegions = []; }
  M.refreshTableStyles(model, table);
  verticalMerges(table);
  model.didChange(); return true;
}

/** A free style id for a new style named `name`. */
export function newTableStyleId(styles, name) {
  const base = 'Table' + (String(name).replace(/[^A-Za-z0-9]/g, '') || 'Style');
  let id = base.slice(0, 90), n = 1;
  while (Object.hasOwn(styles.definitions, id) || TABLE_STYLE_LIBRARY.some(s => s.id === id)) id = `${base.slice(0, 90)}${++n}`;
  return id;
}

/** New Table Style (and apply it), or Modify Table Style: every table using the style follows. */
export function saveTableStyle(model, input, { apply = true } = {}) {
  const spec = checkedTableStyleSpec(input);
  const existing = model.styles.definitions[spec.id];
  if (existing && existing.type !== 'table') throw new Error('That name belongs to another kind of style.');
  if (Object.values(model.styles.definitions).some(s => s.id !== spec.id && s.type === 'table' && s.name.toLowerCase() === spec.name.toLowerCase())) throw new Error('Another table style already has that name.');
  model.checkpoint();
  model.styles = structuredClone(model.styles);
  const definition = styleDefinition(spec);
  if (existing && !existing.generated) definition.generated = false;
  model.styles.definitions[spec.id] = { ...definition, changes: { ...(existing?.changes || {}), table: true }, generated: true };
  model.stylesEnabled = true;
  for (const table of styledTables(model, spec.id)) restyle(model, table, spec, tableLook(table));
  if (apply && selectionBlock(model)) {
    const table = selectionBlock(model).table;
    if (table.styleId !== spec.id) { table.styleId = spec.id; table.styleChanged = true; table.bordersCleared = true; table.lookChanged = true; restyle(model, table, spec, tableLook(table)); }
  }
  model.didChange(); return true;
}

/**
 * A spec that approximates a table's current style (for New Table Style based on a style that came
 * with the document): its borders, the regional fills and borders it resolves, and regional text.
 */
export function specFromTable(styles, table) {
  const own = tableStyleSpec(styles, table.styleId);
  if (own) return structuredClone(own);
  const definition = styles.definitions[table.styleId] || {};
  const regions = {};
  const plain = value => value && { style: value.style, size: value.size ?? 4, color: value.color || 'auto' };
  for (const name of STYLE_REGIONS) {
    const merged = Object.assign({}, ...(table.conditionalStyle?.chain || []).map(style => style.conditionals?.[name]?.cell || {}));
    const run = definition.conditionals?.[name]?.run || {};
    const region = {};
    if (merged.shading && merged.shading !== 'auto' && merged.shading !== 'foreground') region.fill = merged.shading;
    const borders = Object.fromEntries(Object.entries(merged.borders || {}).filter(([side]) => ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].includes(side)).map(([side, b]) => [side, ['nil', 'none'].includes(b.style) ? 'nil' : plain(b)]));
    if (Object.keys(borders).length) region.borders = borders;
    if (run.bold) region.bold = true;
    if (run.italic) region.italic = true;
    if (run.color && run.color !== 'auto') region.color = run.color;
    if (Object.keys(region).length || table.conditionalStyle?.settings.definedRegions.includes(name)) regions[name] = region;
  }
  const borders = Object.fromEntries(Object.entries(table.borders || {}).filter(([side]) => ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].includes(side)).map(([side, b]) => [side, ['nil', 'none'].includes(b.style) ? 'nil' : plain(b)]));
  const whole = table.conditionalStyle?.cell?.shading && table.conditionalStyle.cell.shading !== 'auto' ? { fill: table.conditionalStyle.cell.shading } : undefined;
  return { id: '', name: definition.name || 'Table Style', family: 'custom', borders, regions, ...(whole ? { whole } : {}), rowBands: 1, columnBands: 1 };
}
