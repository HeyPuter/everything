import { el, scrollBehavior } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';

/**
 * Table Properties: one dialog with sections for the table, the selected rows, columns and cells,
 * and the table's alternative text. A section list jumps between them; everything stays on one page,
 * so nothing set in one section hides behind another. Apply sends only what changed, in one step.
 *
 * `context` (optional): { rows: { height, allowBreak, header, headerAvailable }, cells: { width, vertical, wrap },
 * wrap: 'none' | 'around', margins, altText: { title, description }, nested, onBorders }.
 */
export function openTableProperties(table, displayedWidths, selectedColumn, apply, context = {}) {
  // A rejected edit restores the model; retain the original baseline for a retry.
  table = structuredClone(table);
  const decimal = n => String(Number(n.toFixed(5)));
  const field = (label, input) => el('label.field', {}, el('span.field-label', {}, label), input);
  const select = (label, values, value) => el('select.input', { 'aria-label': label }, ...values.map(([id, text]) => el('option', { value: id, selected: id === value }, text)));
  const check = (label, checked, extra = {}) => { const input = el('input', { type: 'checkbox', checked: !!checked, ...extra }); input.indeterminate = checked === null; return { input, node: el('label.table-check', {}, input, label) }; };

  /* Table */
  const layout = select('Table layout', [['autofit', 'Automatically resize to fit contents'], ['fixed', 'Fixed widths']], table.layout);
  const originalType = ['dxa', 'pct'].includes(table.width?.type) ? table.width.type : 'auto';
  const type = select('Table width unit', [['auto', 'Automatic'], ['dxa', 'Inches'], ['pct', 'Percent']], originalType);
  const originalWidth = decimal(originalType === 'pct' ? table.width.value / 50 : originalType === 'dxa' ? table.width.value / 1440 : displayedWidths.reduce((a,b) => a+b, 0) / 1440);
  const width = el('input.input', { type: 'number', step: 'any', min: .01, required: true, 'aria-label': 'Preferred table width', value: originalWidth, disabled: originalType === 'auto' });
  type.addEventListener('change', () => { width.disabled = type.value === 'auto'; width.value = type.value === 'pct' ? '100' : decimal(displayedWidths.reduce((a,b) => a+b, 0) / 1440); });
  const rowAlignments = new Set(table.rows.map(row => row.alignment ?? table.alignment));
  const originalAlignment = rowAlignments.size === 1 ? [...rowAlignments][0] : 'mixed';
  const alignment = select('Table alignment', [...(originalAlignment === 'mixed' ? [['mixed', 'Mixed']] : []), ['left', 'Left'], ['center', 'Center'], ['right', 'Right']], originalAlignment);
  if (originalAlignment === 'mixed') alignment.querySelector('option[value="mixed"]').disabled = true;
  const originalIndent = decimal(table.indent / 1440), indent = el('input.input', { type: 'number', step: 'any', min: -22, max: 22, required: true, 'aria-label': 'Table indent (in)', value: originalIndent, disabled: originalAlignment !== 'left' });
  alignment.addEventListener('change', () => { indent.disabled = alignment.value !== 'left'; });
  const wrap = select('Text wrapping', [['none', 'None'], ['around', 'Around']], context.wrap || (table.floating ? 'around' : 'none'));
  if (table.parentCellId || context.wrap === undefined) wrap.disabled = true;
  wrap.addEventListener('change', () => syncPositioning());
  // Positioning, for a table that text wraps around.
  const floating = table.floating || { horzAnchor: 'text', vertAnchor: 'text', tblpX: 0, tblpY: 0, leftFromText: 180, rightFromText: 180, topFromText: 0, bottomFromText: 0 };
  const xChoice = select('Horizontal position', [['at', 'At offset'], ['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['inside', 'Inside'], ['outside', 'Outside']], floating.tblpXSpec || 'at');
  const xAt = el('input.input', { type: 'number', step: 'any', min: -22, max: 22, value: decimal((floating.tblpX || 0) / 1440), 'aria-label': 'Horizontal offset (in)' });
  const xRelative = select('Horizontal position relative to', [['margin', 'Margin'], ['page', 'Page'], ['text', 'Column']], floating.horzAnchor || 'margin');
  const yChoice = select('Vertical position', [['at', 'At offset'], ['top', 'Top'], ['center', 'Center'], ['bottom', 'Bottom'], ['inside', 'Inside'], ['outside', 'Outside']], floating.tblpYSpec && floating.tblpYSpec !== 'inline' ? floating.tblpYSpec : 'at');
  const yAt = el('input.input', { type: 'number', step: 'any', min: -22, max: 22, value: decimal((floating.tblpY || 0) / 1440), 'aria-label': 'Vertical offset (in)' });
  const yRelative = select('Vertical position relative to', [['text', 'Paragraph'], ['margin', 'Margin'], ['page', 'Page']], floating.vertAnchor || 'margin');
  const fromText = Object.fromEntries(['top', 'bottom', 'left', 'right'].map(side => [side, el('input.input', { type: 'number', step: 'any', min: 0, max: 22, value: decimal((floating[`${side}FromText`] || 0) / 1440), 'aria-label': `Distance from text, ${side} (in)` })]));
  const overlap = check('Allow overlap with other floating tables', table.overlap !== 'never');
  const positionFields = () => JSON.stringify([xChoice.value, xAt.value, xRelative.value, yChoice.value, yAt.value, yRelative.value, ...Object.values(fromText).map(i => i.value), overlap.input.checked]);
  const positionOriginal = positionFields();
  const positioning = el('div.table-positioning', {}, el('div.table-properties-subhead', {}, 'Positioning'),
    el('div.canvas-page-fields', {}, field('Horizontal', xChoice), field('Offset (in)', xAt), field('Relative to', xRelative), el('span'),
      field('Vertical', yChoice), field('Offset (in)', yAt), field('Relative to', yRelative), el('span')),
    el('div.table-properties-subhead', {}, 'Distance from text (in)'),
    el('div.canvas-page-fields.table-margin-fields', {}, ...Object.entries(fromText).map(([side, input]) => field(side[0].toUpperCase() + side.slice(1), input))), overlap.node);
  const syncPositioning = () => { positioning.hidden = wrap.value !== 'around'; xAt.disabled = xChoice.value !== 'at'; yAt.disabled = yChoice.value !== 'at'; };
  for (const control of [xChoice, yChoice]) control.addEventListener('change', syncPositioning);
  syncPositioning();
  const margins = context.margins || table.margins || {};
  const margin = side => el('input.input', { type: 'number', step: 'any', min: 0, max: 22, required: true, value: decimal((margins[side] || 0) / 1440), 'aria-label': `Default ${side} cell margin (in)` });
  const marginInputs = Object.fromEntries(['top', 'bottom', 'left', 'right'].map(side => [side, margin(side)]));
  const marginOriginal = JSON.stringify(Object.values(marginInputs).map(i => i.value));

  /* Column */
  const initialColumns = table.grid.map((w, i) => decimal((w || displayedWidths[i]) / 1440)), values = [...initialColumns];
  const column = select('Table column', table.grid.map((_, i) => [String(i), String(i + 1)]), String(selectedColumn));
  const columnWidth = el('input.input', { type: 'number', min: 0, max: 22, step: 'any', required: true, 'aria-label': 'Column width (in)', value: values[selectedColumn] });
  columnWidth.addEventListener('input', () => { values[Number(column.value)] = columnWidth.value; });
  column.addEventListener('change', () => { columnWidth.value = values[Number(column.value)]; });
  const step = delta => el('button.btn.btn-ghost.btn-sm', { type: 'button', 'aria-label': delta < 0 ? 'Previous column' : 'Next column', onclick: () => {
    const next = Math.max(0, Math.min(table.grid.length - 1, Number(column.value) + delta)); column.value = String(next); columnWidth.value = values[next];
  } }, delta < 0 ? '‹ Previous' : 'Next ›');

  /* Row */
  const rows = context.rows || {};
  const heightRule = select('Row height rule', [...(rows.height === null ? [['mixed', 'Mixed — keep']] : []), ['auto', 'Automatic'], ['atLeast', 'At least'], ['exact', 'Exactly']], rows.height === null ? 'mixed' : rows.height?.rule || 'auto');
  const heightValue = el('input.input', { type: 'number', min: 0, max: 1584, step: 0.05, value: rows.height?.value ? rows.height.value / 20 : '', placeholder: rows.height === null ? 'Mixed' : '', 'aria-label': 'Row height (pt)' });
  const syncHeight = () => { heightValue.disabled = !['atLeast', 'exact'].includes(heightRule.value); heightValue.required = !heightValue.disabled; };
  heightRule.addEventListener('change', syncHeight); syncHeight();
  const allowBreak = check('Allow row to break across pages', rows.allowBreak ?? true);
  const header = check('Repeat as header row at the top of each page', rows.header ?? false, { disabled: !rows.headerAvailable });

  /* Cell */
  const cells = context.cells || {};
  const cellType = select('Cell width unit', [...(cells.width === null ? [['mixed', 'Mixed — keep']] : []), ['auto', 'Automatic'], ['dxa', 'Inches'], ['pct', 'Percent']], cells.width === null ? 'mixed' : cells.width?.type || 'auto');
  const cellWidth = el('input.input', { type: 'number', min: 0.01, step: 'any', 'aria-label': 'Preferred cell width', value: cells.width?.type === 'dxa' ? decimal(cells.width.value / 1440) : cells.width?.type === 'pct' ? decimal(cells.width.value / 50) : '' });
  const syncCell = () => { cellWidth.disabled = !['dxa', 'pct'].includes(cellType.value); cellWidth.required = !cellWidth.disabled; };
  cellType.addEventListener('change', syncCell); syncCell();
  const vertical = select('Vertical alignment', [...(cells.vertical === null ? [['mixed', 'Mixed — keep']] : []), ['top', 'Top'], ['center', 'Center'], ['bottom', 'Bottom']], cells.vertical === null ? 'mixed' : cells.vertical || 'top');
  const cellWrap = check('Wrap text', cells.wrap ?? true);

  /* Alt text */
  const altTitle = el('input.input', { type: 'text', maxLength: 255, value: context.altText?.title || '', 'aria-label': 'Table title' });
  const altDescription = el('textarea.input', { rows: 3, maxLength: 4000, 'aria-label': 'Table description' });
  altDescription.value = context.altText?.description || '';

  const sections = [
    ['table', 'Table', [el('div.canvas-page-fields', {}, field('Width unit', type), field('Preferred width', width), field('Alignment', alignment), field('Indent (in)', indent), field('Layout', layout), field('Text wrapping', wrap)),
      positioning,
      el('div.table-properties-subhead', {}, 'Default cell margins (in)'),
      el('div.canvas-page-fields.table-margin-fields', {}, ...Object.entries(marginInputs).map(([side, input]) => field(side[0].toUpperCase() + side.slice(1), input))),
      context.onBorders && el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: () => context.onBorders() }, 'Borders and Shading…')]],
    ['row', 'Row', [el('div.canvas-page-fields', {}, field('Height', heightRule), field('Height (pt)', heightValue)), allowBreak.node, header.node]],
    ['column', 'Column', [el('div.canvas-page-fields', {}, field('Column', column), field('Column width (in)', columnWidth)), el('div.row', {}, step(-1), step(1))]],
    ['cell', 'Cell', [el('div.canvas-page-fields', {}, field('Width unit', cellType), field('Preferred width', cellWidth), field('Vertical alignment', vertical)), cellWrap.node]],
    ['alt', 'Alt Text', [field('Title', altTitle), field('Description', altDescription), el('p.field-hint', {}, 'Screen readers announce the title and description. Describe what the table shows.')]],
  ];
  const panels = sections.map(([id, label, body]) => el('section.table-properties-section', { id: `table-properties-${id}`, 'aria-label': label }, el('h3', {}, label), ...body));
  const scroller = el('div.table-properties-scroll', {}, ...panels);
  const nav = el('nav.table-properties-nav', { 'aria-label': 'Sections' }, ...sections.map(([id, label], i) => el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => {
    panels[i].scrollIntoView({ block: 'start', behavior: scrollBehavior() }); panels[i].querySelector('input, select, textarea')?.focus({ preventScroll: true });
  } }, label)));

  const error = el('p.field-error', { role: 'alert', hidden: true });
  const content = el('form.table-properties', { onsubmit: e => {
    e.preventDefault();
    const patch = {};
    if (layout.value !== table.layout) patch.layout = layout.value;
    if (alignment.value !== originalAlignment) patch.alignment = alignment.value;
    if (indent.value !== originalIndent) patch.indent = Math.round(Number(indent.value) * 1440);
    if (type.value !== originalType || type.value !== 'auto' && width.value !== originalWidth) patch.width = { type: type.value, value: type.value === 'auto' ? 0 : type.value === 'pct' ? Number(width.value) * 50 : Math.round(Number(width.value) * 1440) };
    if (values.some((v, i) => v !== initialColumns[i]) || patch.layout === 'fixed' && table.grid.some(w => !w)) {
      // Round measured fallback widths up so a single grapheme still fits after fixing the grid.
      patch.columns = values.map((v, i) => v === initialColumns[i] ? table.grid[i] || Math.ceil(displayedWidths[i]) : Math.round(Number(v) * 1440));
      patch.width ||= table.width || { type: 'auto', value: 0 };
    }
    const changes = { table: patch };
    if (!wrap.disabled && wrap.value !== (context.wrap || 'none')) changes.wrap = wrap.value;
    if (!wrap.disabled && wrap.value === 'around' && (positionFields() !== positionOriginal || changes.wrap)) {
      const twips = input => Math.round(Number(input.value) * 1440);
      changes.positioning = { x: xChoice.value === 'at' ? twips(xAt) : xChoice.value, horzAnchor: xRelative.value, y: yChoice.value === 'at' ? twips(yAt) : yChoice.value, vertAnchor: yRelative.value,
        ...Object.fromEntries(Object.entries(fromText).map(([side, input]) => [`${side}FromText`, twips(input)])), overlap: overlap.input.checked };
    }
    if (JSON.stringify(Object.values(marginInputs).map(i => i.value)) !== marginOriginal) changes.margins = Object.fromEntries(Object.entries(marginInputs).map(([side, input]) => [side, Math.round(Number(input.value) * 1440)]));
    if (context.rows) {
      const original = rows.height === null ? 'mixed' : rows.height?.rule || 'auto';
      const value = Math.round(Number(heightValue.value) * 20);
      if (heightRule.value !== 'mixed' && (heightRule.value !== original || ['atLeast', 'exact'].includes(heightRule.value) && value !== rows.height?.value)) changes.rowHeight = { rule: heightRule.value, value: heightRule.value === 'auto' ? 0 : value };
      if (!allowBreak.input.indeterminate && allowBreak.input.checked !== (rows.allowBreak ?? true)) changes.allowBreak = allowBreak.input.checked;
      if (!header.input.disabled && !header.input.indeterminate && header.input.checked !== (rows.header ?? false)) changes.header = header.input.checked;
    }
    if (context.cells) {
      const original = cells.width === null ? 'mixed' : cells.width?.type || 'auto';
      const value = cellType.value === 'pct' ? Number(cellWidth.value) * 50 : Math.round(Number(cellWidth.value) * 1440);
      if (cellType.value !== 'mixed' && (cellType.value !== original || cellType.value !== 'auto' && value !== cells.width?.value)) changes.cellWidth = { type: cellType.value, value: cellType.value === 'auto' ? 0 : value };
      if (vertical.value !== 'mixed' && vertical.value !== (cells.vertical || 'top')) changes.vertical = vertical.value;
      if (!cellWrap.input.indeterminate && cellWrap.input.checked !== (cells.wrap ?? true)) changes.cellWrap = cellWrap.input.checked;
    }
    if (altTitle.value !== (context.altText?.title || '') || altDescription.value !== (context.altText?.description || '')) changes.altText = { title: altTitle.value.trim(), description: altDescription.value.trim() };
    let ok;
    try { ok = apply(context.rows || context.cells || context.altText ? changes : patch); } catch (err) { error.textContent = err.message; error.hidden = false; return; }
    if (ok !== false) modal.close();
    else { error.textContent = 'These settings cannot fit the table. Adjust its width, columns or indentation.'; error.hidden = false; }
  } }, nav, scroller,
  el('p.field-hint', {}, 'Widths are preferences. AutoFit can adjust them to fit the cell text.' + (table.parentCellId ? ' Percent widths use the containing cell’s writing width. Nested tables do not repeat their own header rows; imported header flags are preserved until removed.' : '')), error,
  el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'Apply')));
  const modal = openModal({ title: 'Table properties', content, wide: true }); modal.panel.classList.add('table-properties-dialog'); return modal;
}
