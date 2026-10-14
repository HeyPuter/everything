// The table commands of the editor: the Insert → Table drop-down, the Table Design
// and Table Layout tabs, the Table menu and the table items of the document's
// context menu. Commands run the engine's table operations (table-editing.js,
// table-styles.js, table-formula.js) as one undoable transaction each.
import '../styles/tables.css';
import { el, MOD_KEY, isComposing } from '../ui/dom.js';
import { openMenu } from '../ui/menu.js';
import { openColorPalette } from '../ui/color-palette.js';
import { TEXT_COLORS } from './text-color.js';
import * as T from '../engine/table-editing.js';
import { blockFor, cellBlockPlacements, wholeRows, wholeColumns } from '../engine/table-selection.js';
import { applyTableStyle, setTableLook, clearTableStyle, saveTableStyle, tableLook, availableTableStyles, tableStyleSpec, newTableStyleId, DEFAULT_LOOK } from '../engine/table-styles.js';
import { insertFormula, evaluateFormula, suggestedFormula, FORMULA_FUNCTIONS, NUMBER_FORMATS, buildInstruction } from '../engine/table-formula.js';
import { QUICK_TABLES, insertQuickTable } from '../engine/quick-tables.js';
import { headerRowCount, rowGrid, verticalMerges } from '../engine/tables.js';
import { createTableStyleGallery } from '../ui/table-design-gallery.js';
import { openInsertTableDialog, openConvertTextDialog, openConvertTableDialog, openSplitCellsDialog, openCellsDialog, openSortDialog, openFormulaDialog } from './table-dialogs.js';
import { openTableStyleDialog } from './table-style-dialog.js';
import { openTableProperties } from './table-properties.js';
import { attachTablePointer } from './table-pointer.js';

export const LINE_STYLES = Object.freeze([['single', 'Single'], ['double', 'Double'], ['dotted', 'Dotted'], ['dashed', 'Dashed'], ['dashSmallGap', 'Short dashes'], ['dotDash', 'Dot dash'], ['triple', 'Triple'], ['thinThickSmallGap', 'Thin-thick'], ['thickThinSmallGap', 'Thick-thin']]);
export const LINE_WEIGHTS = Object.freeze([[2, '¼ pt'], [4, '½ pt'], [6, '¾ pt'], [8, '1 pt'], [12, '1½ pt'], [18, '2¼ pt'], [24, '3 pt'], [36, '4½ pt'], [48, '6 pt']]);
// Border Styles: ready pens, each a style, weight and color.
export const BORDER_STYLE_PRESETS = Object.freeze([
  ['Fine black', 'single', 4, '000000'], ['Black, 1 pt', 'single', 8, '000000'], ['Heavy black', 'single', 18, '000000'], ['Double black', 'double', 6, '000000'],
  ['Fine gray', 'single', 4, '808080'], ['Dotted gray', 'dotted', 6, '808080'], ['Dashed gray', 'dashed', 6, '808080'], ['Fine blue', 'single', 4, '2E5E8C'],
  ['Blue, 1½ pt', 'single', 12, '2E5E8C'], ['Double blue', 'double', 6, '2E5E8C'], ['Fine green', 'single', 4, '4A7A35'], ['Orange, 1½ pt', 'single', 12, 'B85C1E'],
].map(([name, style, size, color]) => ({ name, style, size, color })));
const BORDER_ITEMS = [
  ['bottom', 'Bottom Border', 'borderBottom'], ['top', 'Top Border', 'borderTop'], ['left', 'Left Border', 'borderLeft'], ['right', 'Right Border', 'borderRight'],
  null, ['none', 'No Border', 'borderNone'], ['all', 'All Borders', 'borderAll'], ['outside', 'Outside Borders', 'borderOuter'], ['inside', 'Inside Borders', 'borderInside'],
  null, ['insideH', 'Inside Horizontal Border', 'borderInsideH'], ['insideV', 'Inside Vertical Border', 'borderInsideV'],
  null, ['diagonalDown', 'Diagonal Down Border', 'borderDiagonalDown'], ['diagonalUp', 'Diagonal Up Border', 'borderDiagonalUp'],
];
const ALIGNMENTS = [['top', 'left'], ['top', 'center'], ['top', 'right'], ['center', 'left'], ['center', 'center'], ['center', 'right'], ['bottom', 'left'], ['bottom', 'center'], ['bottom', 'right']];
const ALIGN_NAMES = { 'top-left': 'Align Top Left', 'top-center': 'Align Top Center', 'top-right': 'Align Top Right', 'center-left': 'Align Center Left', 'center-center': 'Align Center', 'center-right': 'Align Center Right', 'bottom-left': 'Align Bottom Left', 'bottom-center': 'Align Bottom Center', 'bottom-right': 'Align Bottom Right' };
const DIRECTION_LABELS = { lrTb: 'Horizontal', tbRl: 'Rotate text 90°', btLr: 'Rotate text 270°' };
let viewGridlines = true;

export function createTableTools({ editor, pkg, error = () => {}, onChange = () => {}, controls = {} }) {
  const ready = () => { const engine = editor(); return engine && !pkg()?.readOnly ? engine : null; };
  const model = () => ready()?.model || null;
  const block = () => { const m = model(); try { return m ? T.selectionBlock(m) : null; } catch { return null; } };
  const inTable = () => !!block();
  const pen = { style: 'single', size: 4, color: '000000' };
  let lastPreset = 'all', lastShading = null;
  let pointer = null;
  const modes = { draw: false, erase: false, paint: false };

  const widthsOf = (engine, table) => ((engine.selectionLayout?.tableWidths || engine.layout?.tableWidths)?.[table.id] || []).map(w => Math.round(w * 15));
  function rowHeightsOf(engine, table) {
    const heights = table.rows.map(() => 0), byRow = new Map(table.rows.map((row, i) => [row.id, i]));
    const perPage = new Map();
    const owners = verticalMerges(table);
    for (const cell of engine.selectionLayout?.cells || []) {
      if (cell.tableId !== table.id || (owners.get(cell.id)?.cells.length ?? 2) !== 1) continue;
      const key = `${cell.rowId}:${cell.page}`;
      perPage.set(key, Math.max(perPage.get(key) || 0, cell.height));
    }
    for (const [key, height] of perPage) { const index = byRow.get(key.split(':')[0]); if (index !== undefined) heights[index] += Math.round(height * 15); }
    return heights;
  }

  /** Run one table command as an undoable step; errors are shown, not thrown. */
  function run(action, { focus = true } = {}) {
    const engine = ready(); if (!engine) return false;
    engine.finishComposition();
    let failure = null;
    const ok = engine.execute(() => action(engine.model, engine), e => { failure = e; });
    if (focus) engine.focus();
    onChange();
    return ok && !failure;
  }
  const withTable = (fn, options) => run((m, engine) => { const b = T.selectionBlock(m); if (!b) throw new Error('Put the cursor in a table first.'); return fn(m, b, engine); }, options);
  const closeFocus = () => queueMicrotask(() => editor()?.focus());

  /* ---- Insert ---- */
  function insertTableOf({ rows, columns, autofit = 'fixed', width = null }) {
    return run((m, engine) => {
      const [start, end] = m.range;
      if (start !== end) m.select(end);
      const parent = m.tableContext;
      const box = parent && engine.selectionLayout.cells.find(cell => cell.id === parent.cell.id);
      const available = box ? box.width * 15 - parent.cell.margins.left - parent.cell.margins.right : undefined;
      m.insertTable(rows, columns, available);
      const table = m.tableContext.table;
      if (width) T.setColumnWidths(m, table, Array(columns).fill(Math.round(width * 1440)), { layout: 'fixed' });
      if (autofit !== 'fixed') T.autofitTable(m, autofit);
      return true;
    });
  }
  const insertTableDialog = () => openInsertTableDialog(choice => insertTableOf(choice), { onClose: closeFocus });
  function convertTextToTable() {
    const engine = ready(); if (!engine) return;
    engine.finishComposition();
    const m = engine.model;
    openConvertTextDialog({ shape: (separator, other) => T.textTableShape(m, { separator, other }), separator: m.text.slice(...m.range).includes('\t') ? 'tab' : m.text.slice(...m.range).includes(',') ? 'comma' : 'paragraph' },
      choice => { let failure; const ok = engine.execute(() => T.convertTextToTable(engine.model, choice), e => { failure = e; }, undefined, true); if (failure) throw failure; onChange(); return ok; }, { onClose: closeFocus });
  }
  const quickTableItems = () => QUICK_TABLES.map(t => ({ label: t.name, hint: t.description, icon: 'quickTable', disabled: !ready(), onSelect: () => run((m, engine) => insertQuickTable(m, t.id, (rows, columns) => {
    const [start, end] = m.range; if (start !== end) m.select(end);
    const parent = m.tableContext, box = parent && engine.selectionLayout.cells.find(cell => cell.id === parent.cell.id);
    return m.insertTable(rows, columns, box ? box.width * 15 - parent.cell.margins.left - parent.cell.margins.right : undefined);
  })) }));
  /** Items below the size grid of Insert → Table. */
  const insertMenuItems = () => [
    { label: 'Insert Table…', icon: 'table', disabled: !ready() || !!ready()?.model.selectedImage, onSelect: insertTableDialog },
    { label: modes.draw ? 'Stop Drawing' : 'Draw Table', icon: 'drawTable', disabled: !ready(), onSelect: () => setMode('draw', !modes.draw) },
    { label: 'Convert Text to Table…', icon: 'convertToTable', disabled: !ready() || !canConvertText(), onSelect: convertTextToTable },
    { label: 'Quick Tables', icon: 'quickTable', disabled: !ready(), items: quickTableItems() },
  ];
  const canConvertText = () => { const m = model(); return !!m && m.range[0] !== m.range[1] && !m.selectedParagraphs.some(p => p.cellId); };

  /* ---- Modes: Draw Table, Eraser, Border Painter ---- */
  function setMode(name, on) {
    for (const key of Object.keys(modes)) modes[key] = key === name ? on : false;
    pointer?.setMode(on ? name : null, pen);
    onChange();
    editor()?.focus();
  }

  /* ---- Select ---- */
  function selectKind(kind) {
    const engine = ready(); if (!engine) return;
    const b = block(); if (!b) return;
    engine.finishComposition();
    engine.model.setCellBlock(blockFor(b.table, b, kind));
    engine.syncInput(); engine.paint(); engine.onSelection(); engine.focus();
  }

  /* ---- Table Style gallery ---- */
  const gallery = createTableStyleGallery({
    styles: () => availableTableStyles(model()?.styles || { definitions: {} }),
    current: () => block()?.table.styleId || null,
    look: () => { const b = block(); return b ? tableLook(b.table) : { ...DEFAULT_LOOK }; },
    setLook: patch => withTable(m => setTableLook(m, patch)),
    apply: (id, options) => withTable(m => applyTableStyle(m, id, options)),
    enabled: inTable,
  });
  function styleDialog(mode) {
    const b = block(); if (!b) return;
    const styles = model().styles, current = tableStyleSpec(styles, b.table.styleId);
    const base = current || tableStyleSpec(styles, 'DocsTablePlainGrid');
    const spec = mode === 'new' ? { ...structuredClone(base), id: '', name: 'Table Style', family: 'custom', basedOn: base.id } : structuredClone(current);
    if (mode === 'modify' && !current) { error(new Error('This table’s style came with the document; New Table Style makes an editable copy of a library style.')); return; }
    openTableStyleDialog({ title: mode === 'new' ? 'New Table Style' : 'Modify Table Style', spec, look: tableLook(b.table),
      nameTaken: name => Object.values(model().styles.definitions).some(s => s.type === 'table' && s.name.toLowerCase() === name.toLowerCase() && s.id !== (mode === 'modify' ? spec.id : null)) },
    edited => {
      const engine = ready(); if (!engine) return false;
      const value = mode === 'new' ? { ...edited, id: newTableStyleId(engine.model.styles, edited.name), family: 'custom' } : edited;
      let failure; const ok = engine.execute(() => saveTableStyle(engine.model, value), e => { failure = e; }, undefined, true);
      if (failure) throw failure; onChange(); return ok;
    }, { onClose: closeFocus });
  }
  const styleMenuItems = () => [...gallery.panelItems(), { separator: true },
    { label: 'Modify Table Style…', icon: 'editStyle', disabled: !inTable() || !tableStyleSpec(model().styles, block()?.table.styleId), onSelect: () => styleDialog('modify') },
    { label: 'Clear', icon: 'clearFormat', disabled: !inTable(), onSelect: () => withTable(m => clearTableStyle(m)) },
    { label: 'New Table Style…', icon: 'newStyle', disabled: !inTable(), onSelect: () => styleDialog('new') }];

  /* ---- Shading and borders ---- */
  const shadingChoices = TEXT_COLORS;
  function shadingPalette(anchor, e) {
    const m = model();
    openColorPalette({ anchor, label: 'Shading', value: m?.cellShading ?? null, choices: shadingChoices, reset: { value: 'auto', label: 'No Color' }, custom: true, customLabel: 'shading color', pointer: !!e?.detail,
      onPick: color => { lastShading = color; withTable(model => model.setCellShading(color === 'auto' ? 'auto' : color)); } });
  }
  function penColorPalette(anchor) {
    openColorPalette({ anchor, label: 'Pen Color', value: pen.color, choices: TEXT_COLORS, reset: { value: 'auto', label: 'Automatic', indicator: 'A' }, custom: true, customLabel: 'pen color',
      onPick: color => { pen.color = color; pointer?.setMode(currentMode(), pen); onChange(); } });
  }
  const currentMode = () => Object.keys(modes).find(key => modes[key]) || null;
  const applyBorders = preset => { lastPreset = preset; return withTable(m => T.applyBorderPreset(m, preset, pen)); };
  const borderItems = () => [...BORDER_ITEMS.map(item => item ? { label: item[1], icon: item[2], disabled: !inTable(), onSelect: () => applyBorders(item[0]) } : { separator: true }),
    { separator: true }, { label: 'View Gridlines', icon: 'gridlines', checked: viewGridlines, onSelect: toggleGridlines },
    { label: 'Borders and Shading…', icon: 'cellBorders', disabled: !inTable() || controls.cellBorders?.disabled, onSelect: () => controls.cellBorders?.click() }];
  function toggleGridlines() {
    viewGridlines = !viewGridlines;
    const engine = editor(); if (engine) { engine.showTableGridlines = viewGridlines; engine.paint(); }
    onChange();
  }
  const penSwatch = (style, size, color) => {
    const svg = `<svg viewBox="0 0 60 10" width="60" height="10" aria-hidden="true"><line x1="2" x2="58" y1="5" y2="5" stroke="${color === 'auto' ? 'currentColor' : '#' + color}" stroke-width="${Math.max(0.75, size / 6)}" ${style === 'dotted' ? 'stroke-dasharray="1 2"' : style === 'dashed' || style === 'dashSmallGap' ? 'stroke-dasharray="5 3"' : style === 'dotDash' ? 'stroke-dasharray="6 2 1 2"' : ''}/>${style === 'double' || style === 'triple' ? `<line x1="2" x2="58" y1="8.5" y2="8.5" stroke="${color === 'auto' ? 'currentColor' : '#' + color}" stroke-width="1"/>` : ''}</svg>`;
    return el('span.table-pen-sample', { html: svg });
  };

  /* ---- Properties ---- */
  function openProperties() {
    const engine = ready(); if (!engine) return;
    const b = block(); if (!b) return;
    engine.finishComposition();
    const m = engine.model, table = b.table;
    const measured = widthsOf(engine, table), widths = measured.length === table.grid.length ? measured : table.grid;
    const rowsSelected = table.rows.slice(b.top, b.bottom + 1);
    const same = (list, fn) => list.length && list.every(item => JSON.stringify(fn(item)) === JSON.stringify(fn(list[0]))) ? fn(list[0]) : null;
    const cells = cellBlockPlacements(table, b).map(p => p.cell);
    const headerCount = headerRowCount(table);
    openTableProperties(table, widths.map(w => w), b.left, changes => {
      let failure;
      const ok = engine.execute(() => {
        const model = engine.model;
        if (changes.table && Object.keys(changes.table).length) model.setTableProperties(changes.table);
        if (changes.wrap) T.setTableWrapping(model, changes.wrap);
        if (changes.margins) T.setTableCellMargins(model, changes.margins);
        if (changes.altText) T.setTableAltText(model, changes.altText);
        if (changes.rowHeight) T.setSelectedRowHeight(model, changes.rowHeight.value, changes.rowHeight.rule);
        if (changes.allowBreak !== undefined || changes.header !== undefined) T.setRowOptions(model, { allowBreak: changes.allowBreak, header: changes.header });
        if (changes.cellWidth) T.setCellPreferredWidth(model, changes.cellWidth);
        if (changes.vertical) model.setCellVerticalAlignment(changes.vertical);
        if (changes.cellWrap !== undefined) T.setCellWrap(model, changes.cellWrap);
        return true;
      }, e => { failure = e; }, undefined, true);
      if (failure) throw failure;
      queueMicrotask(() => editor()?.focus()); onChange();
      return ok;
    }, {
      wrap: table.parentCellId ? undefined : table.floating ? 'around' : 'none', margins: table.margins,
      altText: { title: table.caption || '', description: table.description || '' },
      rows: { height: same(rowsSelected, row => row.heightExplicit ? { rule: row.heightRule || 'atLeast', value: row.minHeight || 0 } : { rule: 'auto', value: 0 }), allowBreak: same(rowsSelected, row => !row.cantSplit), header: same(rowsSelected, row => !!row.header), headerAvailable: !table.parentCellId && b.top <= headerCount },
      cells: { width: same(cells, cell => cell.width?.type === 'auto' || !cell.width ? { type: 'auto', value: 0 } : cell.width), vertical: same(cells, cell => cell.vertical || 'top'), wrap: same(cells, cell => !cell.noWrap) },
      onBorders: () => controls.cellBorders?.click(),
    });
  }

  /* ---- Sort, formula, conversion ---- */
  function sortDialog() {
    const engine = ready(); const b = block(); if (!engine || !b) return;
    engine.finishComposition();
    const table = b.table, firstRow = table.rows[0], text = cell => engine.model.paragraphs.filter(p => p.cellId === cell.id).map(p => p.runs.map(r => r.text).join('')).join(' ').trim();
    const columns = rowGrid(firstRow).map((entry, i) => ({ column: entry.column, label: `Column ${i + 1}`, header: text(entry.cell) || `Column ${i + 1}` }));
    openSortDialog({ columns, header: headerRowCount(table) > 0 || !!table.conditionalStyle?.settings.look.firstRow && !!table.styleId },
      choice => { let failure; engine.execute(() => T.sortTable(engine.model, choice), e => { failure = e; }, undefined, true); if (failure) throw failure; onChange(); return true; }, { onClose: closeFocus });
  }
  function formulaDialog() {
    const engine = ready(); if (!engine) return;
    engine.finishComposition();
    const m = engine.model, cellId = m.paragraphs.find((p, i) => m.paragraphOffset(i) <= m.range[0] && m.paragraphOffset(i) + p.runs.reduce((n, r) => n + r.text.length, 0) >= m.range[0])?.cellId || null;
    openFormulaDialog({ suggested: suggestedFormula(m), formats: NUMBER_FORMATS, functions: FORMULA_FUNCTIONS, preview: (formula, format) => evaluateFormula(engine.model, buildInstruction(formula, format || null), cellId) },
      (formula, format) => { let failure; engine.execute(() => insertFormula(engine.model, formula, format), e => { failure = e; }, undefined, true); if (failure) throw failure; onChange(); return true; }, { onClose: closeFocus });
  }
  const convertToText = () => { if (!inTable()) return; openConvertTableDialog(choice => { const engine = ready(); let failure; engine.execute(() => T.convertTableToText(engine.model, choice), e => { failure = e; }, undefined, true); if (failure) throw failure; onChange(); return true; }, { onClose: closeFocus }); };
  const splitCellsDialog = () => { const b = block(); if (!b) return; openSplitCellsDialog({ several: cellBlockPlacements(b.table, b).length > 1 }, choice => {
    const engine = ready(); let failure;
    engine.execute(() => { const m = engine.model, t = T.selectionBlock(m).table; if (!choice.merge) throw new Error('Splitting several cells separately is not available yet. Merge them first.'); return T.splitCells(m, { ...choice, widths: widthsOf(engine, t) }); }, e => { failure = e; }, undefined, true);
    if (failure) throw failure; onChange(); return true; }, { onClose: closeFocus }); };
  const cellsDialog = kind => openCellsDialog(kind, shift => {
    const engine = ready(); let failure;
    engine.execute(() => { const m = engine.model, t = T.selectionBlock(m).table, widths = widthsOf(engine, t); return kind === 'delete' ? T.deleteCells(m, { shift }) : T.insertCells(m, { shift, widths }); }, e => { failure = e; }, undefined, true);
    if (failure) throw failure; onChange(); return true;
  }, { onClose: closeFocus });

  /* ---- Commands shared by the ribbon, the Table menu and the context menu ---- */
  const cmd = {
    insertAbove: () => withTable(m => T.insertRows(m, { above: true })),
    insertBelow: () => withTable(m => T.insertRows(m, {})),
    insertLeft: () => withTable((m, b, engine) => T.insertColumns(m, { left: true, widths: widthsOf(engine, b.table) })),
    insertRight: () => withTable((m, b, engine) => T.insertColumns(m, { widths: widthsOf(engine, b.table) })),
    deleteRows: () => withTable(m => T.deleteRows(m)),
    deleteColumns: () => withTable((m, b, engine) => T.deleteColumns(m, { widths: widthsOf(engine, b.table) })),
    deleteTable: () => withTable(m => T.deleteTable(m)),
    deleteCells: () => cellsDialog('delete'),
    insertCells: () => cellsDialog('insert'),
    mergeCells: () => withTable(m => T.mergeBlock(m)),
    splitCells: splitCellsDialog,
    splitTable: () => withTable(m => T.splitTable(m)),
    autofit: mode => withTable((m, b, engine) => mode === 'fixed' ? T.fixColumnWidths(m, { widths: widthsOf(engine, b.table) }) : T.autofitTable(m, mode)),
    distributeRows: () => withTable((m, b, engine) => T.distributeRows(m, { heights: rowHeightsOf(engine, b.table) })),
    distributeColumns: () => withTable((m, b, engine) => T.distributeColumns(m, { widths: widthsOf(engine, b.table) })),
    align: (vertical, horizontal) => withTable(m => T.setCellAlignment(m, { vertical, horizontal })),
    textDirection: () => withTable(m => T.setTextDirection(m, T.nextTextDirection(m))),
    repeatHeader: () => withTable(m => { const b = T.selectionBlock(m); const on = headerRowCount(b.table) > b.bottom && b.table.rows[0].header; return m.setTableHeaderRows(on ? 0 : b.bottom + 1); }),
    sort: sortDialog, formula: formulaDialog, convertToText, convertTextToTable, insertTableDialog,
    select: selectKind, properties: openProperties,
  };
  const headerOn = () => { const b = block(); return !!b && !!b.table.rows[0]?.header && headerRowCount(b.table) > b.bottom; };
  const canMerge = () => { const b = block(); if (!b) return false; try { return cellBlockPlacements(b.table, b).length > 1; } catch { return false; } };

  /* ---- Ribbon ---- */
  function tableRibbon(kit) {
    const { command, menuButton, split, rows, divider, large, small, when, spin, commandIconEl, controls: c, inDocument, focusEditor } = kit;
    const noSteal = (...buttons) => { for (const b of buttons) b.addEventListener('mousedown', e => e.preventDefault()); return buttons[0]; };
    const enabled = control => when(control, inTable);
    const button = (label, icon, onclick, options = {}) => { const b = noSteal(command(label, icon, onclick, options)); enabled(b); return b; };

    /* Table Design */
    const more = command('More Table Styles', 'more', e => openMenu({ anchor: more, label: 'Table Styles', minWidth: 300, pointer: !!e?.detail, onClose: focusEditor, className: 'table-style-menu', items: inDocument(styleMenuItems()) }));
    more.classList.add('ribbon-gallery-more'); noSteal(more); enabled(more);
    large(c.cellShading, { label: 'Shading', icon: 'cellShading' });
    const shading = split(c.cellShading, { label: 'Shading colors', size: 'large', open: (anchor, e) => shadingPalette(anchor, e) });
    enabled(shading.arrow);
    const borderStyles = menuButton('Border Styles', 'borderStyles', () => BORDER_STYLE_PRESETS.map(p => ({ custom: el('button.menu-item.table-pen-item', { type: 'button', role: 'menuitemradio', 'aria-checked': String(pen.style === p.style && pen.size === p.size && pen.color === p.color), 'aria-label': p.name, onclick: () => { Object.assign(pen, { style: p.style, size: p.size, color: p.color }); setMode('paint', true); } }, penSwatch(p.style, p.size, p.color), el('span.menu-label', {}, p.name)) })), { text: 'Border Styles' });
    const lineStyle = menuButton('Line Style', 'lineStyle', () => LINE_STYLES.map(([style, name]) => ({ custom: el('button.menu-item.table-pen-item', { type: 'button', role: 'menuitemradio', 'aria-checked': String(pen.style === style), 'aria-label': name, onclick: () => { pen.style = style; pointer?.setMode(currentMode(), pen); onChange(); } }, penSwatch(style, Math.max(pen.size, 6), pen.color), el('span.menu-label', {}, name)) })), { size: 'small', text: 'Line Style' });
    const lineWeight = menuButton('Line Weight', 'lineWeight', () => LINE_WEIGHTS.map(([size, name]) => ({ label: name, radio: true, checked: pen.size === size, onSelect: () => { pen.size = size; pointer?.setMode(currentMode(), pen); onChange(); } })), { size: 'small', text: 'Line Weight' });
    const penColor = noSteal(command('Pen Color', 'penColor', () => penColorPalette(penColor), { caret: true, text: 'Pen Color', attrs: { 'aria-haspopup': 'menu' } }));
    const bordersMain = button('Borders', 'borderAll', () => applyBorders(lastPreset), { size: 'large' });
    const borders = split(bordersMain, { label: 'Border options', size: 'large', open: (anchor, e) => openMenu({ anchor, label: 'Borders', minWidth: 240, pointer: !!e?.detail, onClose: e?.detail ? focusEditor : null, items: inDocument(borderItems()) }) });
    enabled(borders.arrow);
    const painter = noSteal(command('Border Painter', 'borderPainter', () => setMode('paint', !modes.paint), { size: 'large', attrs: { 'aria-pressed': 'false' } }));
    when(painter, () => !!ready(), () => String(modes.paint));
    for (const control of [borderStyles, lineStyle, lineWeight, penColor]) when(control, () => !!ready());
    small(c.cellBorders, { icon: 'cellBorders' });
    const design = [
      { id: 'styleOptions', label: 'Table Style Options', icon: 'headerRow', priority: 5, items: [gallery.optionsGrid] },
      { id: 'tableStyles', label: 'Table Styles', icon: 'table', priority: 7, items: [el('div.ribbon-gallery-frame', {}, gallery.gallery, more)] },
      { id: 'shading', label: 'Shading', icon: 'cellShading', priority: 4, items: [shading] },
      { id: 'borders', label: 'Borders', icon: 'cellBorders', priority: 6, items: [borderStyles, rows([lineStyle], [lineWeight], [penColor]), borders, painter, el('div.ribbon-launcher', {}, c.cellBorders)] },
    ];

    /* Table Layout */
    const select = menuButton('Select', 'selectTable', () => [['cell', 'Select Cell', 'selectCell'], ['column', 'Select Column', 'selectColumn'], ['row', 'Select Row', 'selectRow'], ['table', 'Select Table', 'selectTable']].map(([kind, label, icon]) => ({ label, icon, disabled: !inTable(), onSelect: () => selectKind(kind) })), { size: 'small', text: 'Select' });
    enabled(select);
    const gridlines = noSteal(command('View Gridlines', 'gridlines', toggleGridlines, { text: 'View Gridlines', attrs: { 'aria-pressed': 'true' } }));
    when(gridlines, () => !!editor(), () => String(viewGridlines));
    small(c.tableProperties, { icon: 'tableProperties', label: 'Properties' });
    const draw = noSteal(command('Draw Table', 'drawTable', () => setMode('draw', !modes.draw), { text: 'Draw Table', attrs: { 'aria-pressed': 'false' } }));
    const eraser = noSteal(command('Eraser', 'tableEraser', () => setMode('erase', !modes.erase), { text: 'Eraser', attrs: { 'aria-pressed': 'false' } }));
    when(draw, () => !!ready(), () => String(modes.draw)); when(eraser, () => !!ready(), () => String(modes.erase));
    const deleteMenu = menuButton('Delete', 'deleteTable', () => [
      { label: 'Delete Cells…', icon: 'deleteCells', disabled: !inTable(), onSelect: cmd.deleteCells },
      { label: 'Delete Columns', icon: 'deleteColumn', disabled: !inTable(), onSelect: cmd.deleteColumns },
      { label: 'Delete Rows', icon: 'deleteRow', disabled: !inTable(), onSelect: cmd.deleteRows },
      { label: 'Delete Table', icon: 'deleteTable', disabled: !inTable(), onSelect: cmd.deleteTable }]);
    enabled(deleteMenu);
    const insertAbove = button('Insert Above', 'insertAbove', cmd.insertAbove, { size: 'large' });
    const insertBelow = button('Insert Below', 'insertBelow', cmd.insertBelow, { text: 'Insert Below' });
    const insertLeft = button('Insert Left', 'insertLeft', cmd.insertLeft, { text: 'Insert Left' });
    const insertRight = button('Insert Right', 'insertRight', cmd.insertRight, { text: 'Insert Right' });
    const insertCells = button('Insert Cells…', 'insertCells', cmd.insertCells);
    const tableAction = value => () => { c.tableActions.value = value; c.tableActions.dispatchEvent(new Event('change', { bubbles: true })); };
    const paragraphBefore = button('Paragraph Before', 'paragraphBefore', tableAction('before'));
    const paragraphAfter = button('Paragraph After', 'paragraphAfter', tableAction('after'));
    const merge = button('Merge Cells', 'mergeCells', cmd.mergeCells, { text: 'Merge Cells' }); when(merge, canMerge);
    const splitCells = button('Split Cells…', 'splitCells', cmd.splitCells, { text: 'Split Cells' });
    const splitTable = button('Split Table', 'splitTable', cmd.splitTable, { text: 'Split Table' });
    const autofit = menuButton('AutoFit', 'autofit', () => [
      { label: 'AutoFit Contents', icon: 'autofit', disabled: !inTable(), onSelect: () => cmd.autofit('contents') },
      { label: 'AutoFit Window', icon: 'fitWindow', disabled: !inTable(), onSelect: () => cmd.autofit('window') },
      { label: 'Fixed Column Width', icon: 'columnWidth', disabled: !inTable(), onSelect: () => cmd.autofit('fixed') }]);
    enabled(autofit);
    const sizeInput = (key, label) => {
      const input = el('input.canvas-spacing.ribbon-number', { type: 'number', step: 0.01, min: 0.1, max: 22, 'aria-label': `${label} (in)`, placeholder: '',
        onchange: () => {
          if (!input.checkValidity() || input.value === '') { input.reportValidity(); return; }
          const twips = Math.round(Number(input.value) * 1440);
          withTable((m, b, engine) => key === 'height' ? T.setSelectedRowHeight(m, twips, 'atLeast') : T.setSelectedColumnWidth(m, twips, { widths: widthsOf(engine, b.table) }));
        },
        onkeydown: e => { if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); input.dispatchEvent(new Event('change')); } } });
      when(input, inTable);
      sizeInputs.push({ input, key });
      return spin(label, key === 'height' ? 'rowHeight' : 'columnWidth', input, 'in');
    };
    const distributeRows = button('Distribute Rows', 'distributeRows', cmd.distributeRows);
    const distributeColumns = button('Distribute Columns', 'distributeColumns', cmd.distributeColumns);
    small(c.rowHeight, { icon: 'rowHeight' });
    small(c.keepRow, { icon: 'keepRow' });
    const alignGrid = el('div.table-align-grid', { role: 'group', 'aria-label': 'Cell alignment' }, ...ALIGNMENTS.map(([v, h]) => {
      const b = button(ALIGN_NAMES[`${v}-${h}`], `cellAlign${v[0].toUpperCase() + v.slice(1)}${h[0].toUpperCase() + h.slice(1)}`, () => cmd.align(v, h));
      when(b, inTable, () => String(alignmentState() === `${v}-${h}`));
      return b;
    }));
    const direction = button('Text Direction', 'textDirection', cmd.textDirection, { size: 'large' });
    large(c.cellMargins, { label: 'Cell Margins', icon: 'cellMargins' });
    small(c.cellAlignment, { icon: 'cellAlignment' });
    const sort = button('Sort', 'sortTable', cmd.sort, { size: 'large', text: 'Sort' });
    const repeatHeader = button('Repeat Header Rows', 'repeatHeader', cmd.repeatHeader, { text: 'Repeat Header Rows', attrs: { 'aria-pressed': 'false' } });
    when(repeatHeader, () => inTable() && !block()?.table.parentCellId, () => String(headerOn()));
    const toText = button('Convert to Text', 'convertToText', cmd.convertToText, { text: 'Convert to Text' });
    const formula = button('Formula', 'formula', cmd.formula, { text: 'Formula' });
    const layout = [
      { id: 'table', label: 'Table', icon: 'tableProperties', priority: 7, items: [rows([select], [gridlines], [c.tableProperties])] },
      { id: 'draw', label: 'Draw', icon: 'drawTable', priority: 2, items: [rows([draw], [eraser])] },
      { id: 'rowsColumns', label: 'Rows & Columns', icon: 'insertBelow', priority: 8, items: [deleteMenu, insertAbove, rows([insertBelow], [insertLeft], [insertRight]), rows([paragraphBefore], [paragraphAfter]), el('div.ribbon-launcher', {}, insertCells)] },
      { id: 'merge', label: 'Merge', icon: 'mergeCells', priority: 6, items: [rows([merge], [splitCells], [splitTable])] },
      { id: 'cellSize', label: 'Cell Size', icon: 'rowHeight', priority: 7, items: [autofit, el('div.ribbon-spin-group', {}, sizeInput('height', 'Height'), sizeInput('width', 'Width')), rows([distributeRows, c.keepRow], [distributeColumns, c.rowHeight])] },
      { id: 'alignment', label: 'Alignment', icon: 'cellAlignment', priority: 5, items: [alignGrid, direction, c.cellMargins, el('div.ribbon-launcher', {}, c.cellAlignment)] },
      { id: 'data', label: 'Data', icon: 'repeatHeader', priority: 3, items: [sort, rows([repeatHeader], [toText], [formula])] },
    ];
    return {
      design, layout,
      refresh() {
        gallery.refresh();
        const engine = editor(), b = block();
        for (const { input, key } of sizeInputs) {
          if (document.activeElement === input) continue;
          if (!b || !engine) { input.value = ''; continue; }
          const value = key === 'height' ? rowHeightsOf(engine, b.table).slice(b.top, b.bottom + 1) : (() => { const w = widthsOf(engine, b.table); return w.length ? [w.slice(b.left, b.right).reduce((x, y) => x + y, 0)] : []; })();
          const v = value.length && value.every(x => Math.abs(x - value[0]) < 8) ? String(Number((value[0] / 1440).toFixed(2))) : '';
          if (input.value !== v) input.value = v;
        }
        direction.title = `Text Direction: ${DIRECTION_LABELS[b && cellBlockPlacements(b.table, b)[0]?.cell.textDirection || 'lrTb']}`;
        penColor.querySelector('.ribbon-pen-indicator')?.remove();
        penColor.prepend(el('span.ribbon-pen-indicator', { style: { background: pen.color === 'auto' ? 'currentColor' : `#${pen.color}` }, 'aria-hidden': 'true' }));
      },
    };
  }
  const sizeInputs = [];
  function alignmentState() {
    const m = model(), b = block(); if (!m || !b) return null;
    const cells = cellBlockPlacements(b.table, b).map(p => p.cell);
    const vertical = cells.every(cell => (cell.vertical || 'top') === (cells[0].vertical || 'top')) ? cells[0].vertical || 'top' : null;
    const ids = new Set(cells.map(c => c.id)), aligns = new Set(m.paragraphs.filter(p => ids.has(p.cellId)).map(p => p.format?.alignment || 'left'));
    const horizontal = aligns.size === 1 ? [...aligns][0] : null;
    return vertical && horizontal ? `${vertical}-${horizontal === 'both' ? 'left' : horizontal}` : null;
  }

  /* ---- Menus ---- */
  function tableMenu() {
    const on = !!inTable(), editable = !!ready();
    return [
      { label: 'Draw Table', icon: 'drawTable', checked: modes.draw, disabled: !editable, onSelect: () => setMode('draw', !modes.draw) },
      { separator: true },
      { label: 'Insert', icon: 'insertBelow', items: [
        { label: 'Table…', icon: 'table', disabled: !editable, onSelect: insertTableDialog }, { separator: true },
        { label: 'Columns to the Left', icon: 'insertLeft', disabled: !on, onSelect: cmd.insertLeft }, { label: 'Columns to the Right', icon: 'insertRight', disabled: !on, onSelect: cmd.insertRight }, { separator: true },
        { label: 'Rows Above', icon: 'insertAbove', disabled: !on, onSelect: cmd.insertAbove }, { label: 'Rows Below', icon: 'insertBelow', disabled: !on, onSelect: cmd.insertBelow }, { separator: true },
        { label: 'Cells…', icon: 'insertCells', disabled: !on, onSelect: cmd.insertCells }] },
      { label: 'Delete', icon: 'deleteTable', items: [
        { label: 'Table', icon: 'deleteTable', disabled: !on, onSelect: cmd.deleteTable }, { label: 'Columns', icon: 'deleteColumn', disabled: !on, onSelect: cmd.deleteColumns },
        { label: 'Rows', icon: 'deleteRow', shortcut: MOD_KEY === 'Cmd' ? 'Cmd+Ctrl+X' : null, disabled: !on, onSelect: cmd.deleteRows }, { label: 'Cells…', icon: 'deleteCells', disabled: !on, onSelect: cmd.deleteCells }] },
      { label: 'Select', icon: 'selectTable', items: [['table', 'Table'], ['column', 'Column'], ['row', 'Row'], ['cell', 'Cell']].map(([kind, label]) => ({ label, disabled: !on, onSelect: () => selectKind(kind) })) },
      { label: 'Merge Cells', icon: 'mergeCells', disabled: !on || !canMerge(), onSelect: cmd.mergeCells },
      { label: 'Split Cells…', icon: 'splitCells', disabled: !on, onSelect: cmd.splitCells },
      { label: 'Split Table', icon: 'splitTable', disabled: !on, onSelect: cmd.splitTable },
      { separator: true },
      { label: 'AutoFit and Distribute', icon: 'autofit', items: [
        { label: 'AutoFit to Contents', disabled: !on, onSelect: () => cmd.autofit('contents') }, { label: 'AutoFit to Window', disabled: !on, onSelect: () => cmd.autofit('window') },
        { label: 'Fixed Column Width', disabled: !on, onSelect: () => cmd.autofit('fixed') }, { separator: true },
        { label: 'Distribute Rows Evenly', icon: 'distributeRows', disabled: !on, onSelect: cmd.distributeRows }, { label: 'Distribute Columns Evenly', icon: 'distributeColumns', disabled: !on, onSelect: cmd.distributeColumns }] },
      { label: 'Repeat Header Rows', icon: 'repeatHeader', checked: headerOn(), disabled: !on || !!block()?.table.parentCellId, onSelect: cmd.repeatHeader },
      { separator: true },
      { label: 'Convert', icon: 'convertToTable', items: [
        { label: 'Convert Text to Table…', icon: 'convertToTable', disabled: !editable || !canConvertText(), onSelect: convertTextToTable },
        { label: 'Convert Table to Text…', icon: 'convertToText', disabled: !on, onSelect: convertToText }] },
      { label: 'Sort…', icon: 'sortTable', disabled: !on, onSelect: sortDialog },
      { label: 'Formula…', icon: 'formula', disabled: !editable, onSelect: formulaDialog },
      { label: 'View Gridlines', icon: 'gridlines', checked: viewGridlines, onSelect: toggleGridlines },
      { separator: true },
      { label: 'Table Properties…', icon: 'tableProperties', disabled: !on, onSelect: openProperties },
    ];
  }
  function extendMenu(id) {
    if (id === 'table') return tableMenu();
    if (id === 'insert') return [{ label: 'Table…', icon: 'table', disabled: !ready(), onSelect: insertTableDialog }];
    return [];
  }
  function contextMenuItems(context) {
    if (context !== 'table' || !ready() || !inTable()) return [];
    return [
      { separator: true },
      { label: 'Insert', icon: 'insertBelow', items: [
        { label: 'Insert Columns to the Left', icon: 'insertLeft', onSelect: cmd.insertLeft }, { label: 'Insert Columns to the Right', icon: 'insertRight', onSelect: cmd.insertRight },
        { label: 'Insert Rows Above', icon: 'insertAbove', onSelect: cmd.insertAbove }, { label: 'Insert Rows Below', icon: 'insertBelow', onSelect: cmd.insertBelow },
        { label: 'Insert Cells…', icon: 'insertCells', onSelect: cmd.insertCells }] },
      { label: 'Delete', icon: 'deleteTable', items: [
        { label: 'Delete Cells…', icon: 'deleteCells', onSelect: cmd.deleteCells }, { label: 'Delete Columns', icon: 'deleteColumn', onSelect: cmd.deleteColumns },
        { label: 'Delete Rows', icon: 'deleteRow', onSelect: cmd.deleteRows }, { label: 'Delete Table', icon: 'deleteTable', onSelect: cmd.deleteTable }] },
      { label: 'Merge Cells', icon: 'mergeCells', disabled: !canMerge(), onSelect: cmd.mergeCells },
      { label: 'Split Cells…', icon: 'splitCells', onSelect: cmd.splitCells },
      { label: 'Borders', icon: 'cellBorders', items: borderItems() },
      { label: 'Cell Alignment', icon: 'cellAlignment', items: ALIGNMENTS.map(([v, h]) => ({ label: ALIGN_NAMES[`${v}-${h}`], icon: `cellAlign${v[0].toUpperCase() + v.slice(1)}${h[0].toUpperCase() + h.slice(1)}`, checked: alignmentState() === `${v}-${h}`, onSelect: () => cmd.align(v, h) })) },
      { label: 'AutoFit', icon: 'autofit', items: [{ label: 'AutoFit to Contents', onSelect: () => cmd.autofit('contents') }, { label: 'AutoFit to Window', onSelect: () => cmd.autofit('window') }, { label: 'Fixed Column Width', onSelect: () => cmd.autofit('fixed') }] },
      { label: 'Text Direction', icon: 'textDirection', items: Object.entries(DIRECTION_LABELS).map(([value, label]) => ({ label, radio: true, checked: (cellBlockPlacements(block().table, block())[0]?.cell.textDirection || 'lrTb') === value, onSelect: () => withTable(m => T.setTextDirection(m, value)) })) },
      { label: 'Table Properties…', icon: 'tableProperties', onSelect: openProperties },
    ];
  }

  /* ---- Engine attachment: pointer tools, gridlines and keys ---- */
  function attach(engine) {
    pointer?.detach();
    engine.showTableGridlines = viewGridlines;
    pointer = attachTablePointer(engine, {
      readOnly: () => !!pkg()?.readOnly, widths: table => widthsOf(engine, table), heights: table => rowHeightsOf(engine, table), error, onChange,
      onModeEnd: () => { for (const key of Object.keys(modes)) modes[key] = false; onChange(); },
      deleteCellsDialog: () => cellsDialog('delete'),
    });
    pointer.setMode(currentMode(), pen);
  }

  return {
    commands: {
      tableRibbon, tableInsertMenuItems: insertMenuItems, openTableProperties: openProperties, insertTableDialog, convertTextToTable, tableCommands: cmd,
    },
    extendMenu, contextMenuItems, attach,
    refresh() { pointer?.refresh(); },
    destroy() { pointer?.detach(); pointer = null; },
  };
}
