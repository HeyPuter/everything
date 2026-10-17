/**
 * Simple tables: a grid of plain-text cells with an optional header row.
 * Each cell saves on its own (see data/table.js), shortly after typing, so
 * people editing different cells never overwrite each other.
 */
import { h, debounce, fill } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import * as T from '../data/table.js';
import { openMenu } from '../ui/menu.js';

const shapeOf = (data) => `${data.rowIds.join(',')}|${data.colIds.join(',')}|${data.header ? 'h' : ''}`;

function caretAtEnd(el) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function renderTable(editor, main, b) {
  const ro = editor.readOnly;
  const data = b.table || T.readTable(null);
  // Same rows and columns as what is shown: update cell text in place, so
  // the cell being typed in keeps its caret.
  const existing = main.querySelector('table.wiki-table');
  if (existing && existing.dataset.shape === shapeOf(data) && existing.dataset.ro === String(ro)) {
    data.rows.forEach((row, r) =>
      row.forEach((text, c) => {
        const cell = existing.rows[r]?.cells[c];
        // Cells typed in here and not saved yet keep what was typed; the
        // focused cell otherwise shows changes too (undo, someone else).
        if (!cell || main._typed?.has(cell) || cell.textContent === text) return;
        cell.textContent = text;
        if (cell === document.activeElement) caretAtEnd(cell);
      }),
    );
    return;
  }
  // Typing not saved yet is saved before the table is rebuilt.
  main._save?.flush();
  const typed = new Set();
  main._typed = typed;
  const save = debounce(() => {
    if (!typed.size || !editor.blocks.has(b.id)) return typed.clear();
    const changes = [...typed].map((cell) => ({ row: cell.dataset.row, col: cell.dataset.col, text: cell.textContent }));
    typed.clear();
    T.setCells(editor.doc, b.id, changes);
  }, 400);
  main._save = save;
  const cellFocused = main.contains(document.activeElement) ? [document.activeElement.dataset.row, document.activeElement.dataset.col] : null;
  const table = h('table.wiki-table', { role: 'grid', 'aria-label': 'Table', 'data-shape': shapeOf(data), 'data-ro': String(ro) });
  data.rows.forEach((row, r) => {
    const tr = h('tr');
    row.forEach((text, c) => {
      const header = data.header && r === 0;
      const cell = h(header ? 'th' : 'td', {
        contenteditable: ro ? 'false' : 'true',
        'data-r': r,
        'data-c': c,
        'data-row': data.rowIds[r],
        'data-col': data.colIds[c],
        role: header ? 'columnheader' : 'gridcell',
        tabindex: ro ? '-1' : null,
        spellcheck: 'true',
      });
      cell.textContent = text;
      cell.addEventListener('input', () => {
        typed.add(cell);
        // The cells no longer match what was last rendered (an undo can bring
        // back exactly that), so the next render compares them again.
        editor.rendered.delete(b.id);
        save();
      });
      cell.addEventListener('keydown', (e) => key(e, r, c));
      cell.addEventListener('contextmenu', (e) => {
        if (ro) return;
        e.preventDefault();
        menu(cell, r, c);
      });
      tr.append(cell);
    });
    table.append(tr);
  });
  const rows = data.rowIds.length;
  const cols = data.colIds.length;
  const focusCell = (row, col) => queueMicrotask(() => main.querySelector(`[data-row="${row}"][data-col="${col}"]`)?.focus());
  const change = (fn) => {
    save.flush();
    fn();
  };
  const addRow = (at) =>
    change(() => {
      const id = T.insertRow(editor.doc, b.id, at < rows ? { before: data.rowIds[at] } : {});
      if (id) focusCell(id, data.colIds[0]);
    });
  const addCol = (at) =>
    change(() => {
      const id = T.insertCol(editor.doc, b.id, at < cols ? { before: data.colIds[at] } : {});
      if (id) focusCell(data.rowIds[0], id);
    });
  const key = (e, r, c) => {
    const go = (rr, cc) => main.querySelector(`[data-r="${rr}"][data-c="${cc}"]`)?.focus();
    if (e.key === 'Tab') {
      e.preventDefault();
      const i = r * cols + c + (e.shiftKey ? -1 : 1);
      if (i >= rows * cols && !e.shiftKey) return addRow(rows);
      if (i >= 0) go(Math.floor(i / cols), i % cols);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (r + 1 < rows) go(r + 1, c);
      else addRow(rows);
    } else if (e.key === 'ArrowDown' && r + 1 < rows) {
      e.preventDefault();
      go(r + 1, c);
    } else if (e.key === 'ArrowUp' && r > 0) {
      e.preventDefault();
      go(r - 1, c);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      save.flush();
      editor.selectBlocks([b.id]);
    }
  };
  const menu = (anchor, r, c) => {
    openMenu(anchor, [
      { label: 'Insert row above', icon: 'arrowUp', disabled: rows >= T.MAX_ROWS, run: () => addRow(r) },
      { label: 'Insert row below', icon: 'arrowDown', disabled: rows >= T.MAX_ROWS, run: () => addRow(r + 1) },
      { label: 'Insert column left', icon: 'arrowLeft', disabled: cols >= T.MAX_COLS, run: () => addCol(c) },
      { label: 'Insert column right', icon: 'arrowRight', disabled: cols >= T.MAX_COLS, run: () => addCol(c + 1) },
      { type: 'sep' },
      { label: 'Header row', checked: data.header, run: () => change(() => T.setHeader(editor.doc, b.id, !data.header)) },
      { type: 'sep' },
      { label: 'Delete row', icon: 'trash', danger: true, disabled: rows <= 1, run: () => change(() => {
          T.deleteRow(editor.doc, b.id, data.rowIds[r]);
          const near = data.rowIds[r + 1] || data.rowIds[r - 1];
          if (near) focusCell(near, data.colIds[c]);
        }) },
      { label: 'Delete column', icon: 'trash', danger: true, disabled: cols <= 1, run: () => change(() => {
          T.deleteCol(editor.doc, b.id, data.colIds[c]);
          const near = data.colIds[c + 1] || data.colIds[c - 1];
          if (near) focusCell(data.rowIds[r], near);
        }) },
    ], { label: 'Table cell' });
  };
  const controls = ro
    ? null
    : h(
        'div.table-controls',
        h('button.btn.small.ghost', { type: 'button', disabled: rows >= T.MAX_ROWS, onclick: () => addRow(rows) }, icon('plus', 14), 'Row'),
        h('button.btn.small.ghost', { type: 'button', disabled: cols >= T.MAX_COLS, onclick: () => addCol(cols) }, icon('plus', 14), 'Column'),
        h('button.btn.small.ghost', { type: 'button', 'aria-label': 'Table options', onclick: (e) => {
            const cell = main.querySelector('td:focus, th:focus');
            menu(e.currentTarget, Number(cell?.dataset.r ?? 0), Number(cell?.dataset.c ?? 0));
          } }, icon('more', 14)),
      );
  fill(main, h('div.table-scroll', table), controls);
  if (cellFocused) main.querySelector(`[data-row="${cellFocused[0]}"][data-col="${cellFocused[1]}"]`)?.focus();
}
