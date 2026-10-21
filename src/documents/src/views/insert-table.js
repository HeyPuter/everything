import { el } from '../ui/dom.js';
import { openMenu, closeMenu } from '../ui/menu.js';

const COLUMNS = 10, ROWS = 8;

/**
 * Insert → Table: a grid to sweep out a size (the label follows the pointer or the arrow keys), a
 * quick rows-and-columns form, and the table commands below it (`items`: Insert Table…, Draw Table,
 * Convert Text to Table…, Quick Tables).
 */
export function openInsertTable(apply, { anchor = document.activeElement, focusFirst = true, items = [] } = {}) {
  let popup;
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const insert = (rows, columns) => {
    if (!popup?.menu?.isConnected) return;
    if (apply(rows, columns) !== false) closeMenu();
    else { error.textContent = 'The table could not fit. Try fewer columns.'; error.hidden = false; }
  };
  const dimensions = el('span', { 'aria-live': 'polite' }, 'Choose a table size');
  const grid = el('div.menu-custom-grid.table-size-grid', { role: 'group', 'aria-label': 'Table size', dataset: { columns: String(COLUMNS) } });
  const preview = (rows, columns) => {
    dimensions.textContent = `${columns} × ${rows} table`;
    [...grid.children].forEach((cell, i) => cell.classList.toggle('is-preview', Math.floor(i / COLUMNS) < rows && i % COLUMNS < columns));
  };
  for (let rows = 1; rows <= ROWS; rows++) for (let columns = 1; columns <= COLUMNS; columns++) grid.append(el('button.swatch.table-size-cell', {
    type: 'button', role: 'menuitem', tabindex: -1, 'aria-label': `${columns} ${columns === 1 ? 'column' : 'columns'}, ${rows} ${rows === 1 ? 'row' : 'rows'}`,
    onfocus: () => preview(rows, columns), onpointerenter: () => preview(rows, columns), onclick: () => insert(rows, columns),
  }));
  grid.addEventListener('pointerleave', () => { dimensions.textContent = 'Choose a table size'; for (const cell of grid.children) cell.classList.remove('is-preview'); });
  const rows = el('input.input', { type: 'number', min: 1, max: 500, value: 2, required: true, 'aria-label': 'Table rows' });
  const columns = el('input.input', { type: 'number', min: 1, max: 32, value: 2, required: true, 'aria-label': 'Table columns' });
  const custom = el('form.table-size-custom', { onsubmit: e => { e.preventDefault(); insert(Number(rows.value), Number(columns.value)); } },
    el('label', {}, 'Rows', rows), el('label', {}, 'Columns', columns), el('button.btn.btn-outline', { type: 'submit' }, 'Insert'));
  popup = openMenu({ anchor, label: 'Insert table', className: 'table-size-palette', focusFirst,
    items: [{ custom: el('div.palette-heading', {}, dimensions) }, { custom: grid }, { separator: true }, { custom }, { custom: error },
      ...(items.length ? [{ separator: true }, ...items] : [])] });
  return popup;
}
