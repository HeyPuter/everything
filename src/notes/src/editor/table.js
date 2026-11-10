import { currentRange, editableRoot, placeCaret, selectRange } from './selection.js';

/** HTML for a new rows x cols table. */
export function tableHtml(rows, cols) {
  const row = `<tr>${'<td><br></td>'.repeat(cols)}</tr>`;
  return `<table><tbody>${row.repeat(rows)}</tbody></table><p><br></p>`;
}

export function cellAtCaret() {
  const range = currentRange();
  if (!range) return null;
  const root = editableRoot(range.startContainer);
  const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const cell = node?.closest('td, th');
  if (!cell || !root || !root.contains(cell)) return null;
  const table = cell.closest('table');
  return { cell, row: cell.parentElement, table, root };
}

function cellIndex(cell) {
  return [...cell.parentElement.children].indexOf(cell);
}

function rowsOf(table) {
  return [...table.querySelectorAll(':scope > tbody > tr, :scope > thead > tr, :scope > tr')];
}

function changed(root) {
  root.dispatchEvent(new Event('input', { bubbles: true }));
}

function emptyCell(tag = 'td') {
  const c = document.createElement(tag);
  c.append(document.createElement('br'));
  return c;
}

export function insertRow(where) {
  const at = cellAtCaret();
  if (!at) return;
  const tr = document.createElement('tr');
  for (const c of at.row.children) {
    const cell = emptyCell('td');
    if (c.colSpan > 1) cell.colSpan = c.colSpan;
    tr.append(cell);
  }
  if (where === 'above') at.row.before(tr);
  else at.row.after(tr);
  placeCaret(tr.children[Math.min(cellIndex(at.cell), tr.children.length - 1)], false);
  changed(at.root);
}

export function insertColumn(where) {
  const at = cellAtCaret();
  if (!at) return;
  const index = cellIndex(at.cell);
  for (const tr of rowsOf(at.table)) {
    const ref = tr.children[Math.min(index, tr.children.length - 1)];
    const cell = emptyCell(ref?.tagName === 'TH' ? 'th' : 'td');
    if (!ref) tr.append(cell);
    else if (where === 'left') ref.before(cell);
    else ref.after(cell);
  }
  changed(at.root);
}

export function deleteRow() {
  const at = cellAtCaret();
  if (!at) return;
  const rows = rowsOf(at.table);
  if (rows.length <= 1) return deleteTable();
  const i = rows.indexOf(at.row);
  const index = cellIndex(at.cell);
  at.row.remove();
  const next = rowsOf(at.table)[Math.min(i, rows.length - 2)];
  placeCaret(next.children[Math.min(index, next.children.length - 1)], false);
  changed(at.root);
}

export function deleteColumn() {
  const at = cellAtCaret();
  if (!at) return;
  const index = cellIndex(at.cell);
  if (at.row.children.length <= 1) return deleteTable();
  for (const tr of rowsOf(at.table)) tr.children[index]?.remove();
  const cell = at.row.children[Math.min(index, at.row.children.length - 1)];
  placeCaret(cell, false);
  changed(at.root);
}

export function deleteTable() {
  const at = cellAtCaret();
  if (!at) return;
  const p = document.createElement('p');
  p.append(document.createElement('br'));
  at.table.replaceWith(p);
  placeCaret(p, false);
  changed(at.root);
}

export function toggleBorders() {
  const at = cellAtCaret();
  if (!at) return;
  at.table.classList.toggle('nt-noborders');
  changed(at.root);
}

export function bordersHidden() {
  return Boolean(cellAtCaret()?.table.classList.contains('nt-noborders'));
}

export function shadeCells(color) {
  const at = cellAtCaret();
  if (!at) return;
  const cells = selectedCells(at);
  for (const c of cells) {
    if (color) c.style.backgroundColor = color;
    else c.style.removeProperty('background-color');
    if (!c.getAttribute('style')) c.removeAttribute('style');
  }
  changed(at.root);
}

export function alignCells(where) {
  const at = cellAtCaret();
  if (!at) return;
  for (const c of selectedCells(at)) c.style.textAlign = where;
  changed(at.root);
}

export function hasHeaderRow() {
  const at = cellAtCaret();
  return Boolean(at && rowsOf(at.table)[0]?.children[0]?.tagName === 'TH');
}

export function toggleHeaderRow() {
  const at = cellAtCaret();
  if (!at) return;
  const first = rowsOf(at.table)[0];
  const toHeader = first.children[0]?.tagName !== 'TH';
  // Moving a cell's contents drops a caret inside the row, which would
  // hide the Table tab; remember it and put it back in the new cell.
  const range = currentRange();
  const saved = range && [range.startContainer, range.startOffset, range.endContainer, range.endOffset];
  const swapped = new Map();
  for (const cell of [...first.children]) {
    const next = document.createElement(toHeader ? 'th' : 'td');
    for (const a of cell.attributes) next.setAttribute(a.name, a.value);
    while (cell.firstChild) next.append(cell.firstChild);
    cell.replaceWith(next);
    swapped.set(cell, next);
  }
  if (saved) {
    const r = document.createRange();
    r.setStart(swapped.get(saved[0]) || saved[0], saved[1]);
    r.setEnd(swapped.get(saved[2]) || saved[2], saved[3]);
    selectRange(r);
  }
  changed(at.root);
}

/** Cells covered by the selection, or the caret's cell. */
function selectedCells(at) {
  const range = currentRange();
  const cells = [...at.table.querySelectorAll('td, th')].filter((c) => range && range.intersectsNode(c));
  return cells.length ? cells : [at.cell];
}

export function selectTablePart(part) {
  const at = cellAtCaret();
  if (!at) return;
  const range = document.createRange();
  if (part === 'table') range.selectNode(at.table);
  else if (part === 'row') {
    range.setStartBefore(at.row.firstElementChild);
    range.setEndAfter(at.row.lastElementChild);
  } else if (part === 'column') {
    const index = cellIndex(at.cell);
    const rows = rowsOf(at.table);
    range.setStart(rows[0].children[index], 0);
    const last = rows[rows.length - 1].children[index];
    range.setEnd(last, last.childNodes.length);
  } else range.selectNodeContents(at.cell);
  selectRange(range);
}

/** Tab / Shift+Tab inside a table. Adds a row when tabbing out of the last cell. */
export function moveCell(direction) {
  const at = cellAtCaret();
  if (!at) return false;
  const cells = [...at.table.querySelectorAll('td, th')];
  const i = cells.indexOf(at.cell);
  let target = cells[i + direction];
  if (!target && direction > 0) {
    insertRowAtEnd(at);
    target = rowsOf(at.table).at(-1).firstElementChild;
  }
  if (!target) return true;
  const range = document.createRange();
  range.selectNodeContents(target);
  selectRange(range);
  return true;
}

function insertRowAtEnd(at) {
  const last = rowsOf(at.table).at(-1);
  const tr = document.createElement('tr');
  for (let k = 0; k < last.children.length; k++) tr.append(emptyCell());
  last.after(tr);
  changed(at.root);
}

/** Converts the table at the caret into tab-separated paragraphs. */
export function tableToText() {
  const at = cellAtCaret();
  if (!at) return;
  const frag = document.createDocumentFragment();
  for (const tr of rowsOf(at.table)) {
    const p = document.createElement('p');
    [...tr.children].forEach((cell, i) => {
      if (i) p.append('\t');
      // Pictures, attachments, equations, links and formatting stay; only a
      // cell that holds paragraphs or lists of its own is reduced to its text.
      if (cell.querySelector('p, div, ul, ol, table, h1, h2, h3, h4, h5, h6, blockquote, pre')) {
        p.append(cell.textContent.trim());
        return;
      }
      const nodes = [...cell.childNodes];
      while (nodes.at(-1)?.nodeName === 'BR') nodes.pop();
      p.append(...nodes);
    });
    if (!p.firstChild) p.append(document.createElement('br'));
    frag.append(p);
  }
  const first = frag.firstChild;
  at.table.replaceWith(frag);
  if (first) placeCaret(first, false);
  changed(at.root);
}

/** Sorts the table rows by the caret's column. */
export function sortTable(descending = false) {
  const at = cellAtCaret();
  if (!at) return;
  const index = cellIndex(at.cell);
  const rows = rowsOf(at.table);
  const header = rows[0]?.children[0]?.tagName === 'TH' ? rows.shift() : null;
  const key = (tr) => tr.children[index]?.textContent.trim() || '';
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  rows.sort((a, b) => collator.compare(key(a), key(b)) * (descending ? -1 : 1));
  // The body rows' own section: a header row may sit in a <thead> (tables
  // pasted from the web), and appending there would turn every row into a header.
  const body = rows[0]?.parentElement;
  for (const r of rows) body.append(r);
  changed(at.root);
}
