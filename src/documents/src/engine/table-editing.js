// Table structure commands of the Table Layout tab, the Table menu and the
// table pointer tools: insert and delete rows, columns and cells, merge and
// split, split a table, sizes, sort and text conversion. Each command edits the
// model (tables, grid and cell paragraphs) in one transaction; DOCX writing
// reads the change flags it leaves (`gridChanged`, `spanChanged`...), and
// layout and painting simply follow the model.
import { tableModelInternals as M, paragraph, paragraphText, locate } from './model.js';
import { tableCells, editableCells, verticalMerges, headerRowCount, tableId, fixedColumnWidths, rowGrid, spanWidth, cellContext, documentBlocks } from './tables.js';
import { cellBlockPlacements, normalizeCellBlock, blockBetween, ownerPlacements } from './table-selection.js';
import { resolveStyledParagraph } from './styles.js';
import { repairStructuralBookmarks, normalizeBlockBookmarkScopes } from './bookmarks.js';
import { mergeCellControls } from './block-controls.js';
import { MAX_DOCUMENT_CHARACTERS, DOCUMENT_CHARACTER_LIMIT_MESSAGE } from './text-limits.js';
import { checkedCellAlignment } from './cell-alignment.js';
import { checkedCellBorder, resolveCellBorders } from './cell-borders.js';
import { resolveCellMargins } from './cell-margins.js';

const copy = value => structuredClone(value);
const sum = values => values.reduce((a, b) => a + b, 0);
const MAX_WIDTH = 31680;
export const MIN_COLUMN_WIDTH = 144; // 0.1 in: room for the cell margins and a glyph.
export const TEXT_DIRECTIONS = Object.freeze(['lrTb', 'tbRl', 'btLr']);

/** Whole twips whose running total follows the fractional widths exactly. */
export function integerWidths(widths, total = sum(widths)) {
  const scale = sum(widths) ? total / sum(widths) : 1;
  let running = 0, previous = 0;
  return widths.map(w => { running += w * scale; const next = Math.round(running); const width = next - previous; previous = next; return width; });
}

/**
 * The rectangle of cells the selection covers: an explicit block (Select Column), otherwise the
 * cells holding the start and end of the text selection in their nearest shared table.
 */
export function selectionBlock(model) {
  const active = model.activeCellBlock;
  if (active) return active;
  const [start, end] = model.range;
  const at = offset => model.paragraphs[locate(model.paragraphs, offset).index].cellId || null;
  // A selection ending at the start of a paragraph does not reach into it.
  const last = end > start && locate(model.paragraphs, end).offset === 0 ? end - 1 : end;
  const a = at(start), b = at(last);
  if (!a && !b) return null;
  const chain = id => { const out = []; for (let cell = id; cell;) { const context = cellContext(model.tables, cell); out.push({ table: context.table, cell }); cell = context.table.parentCellId; } return out; };
  const from = chain(a || b), to = chain(b || a);
  for (const item of to) {
    const match = from.find(other => other.table === item.table);
    if (match) { const block = blockBetween(item.table, match.cell, item.cell); return block && { ...block, table: item.table }; }
  }
  return null;
}

function requireBlock(model) {
  const block = selectionBlock(model);
  if (!block) throw new Error('Put the cursor in a table first.');
  return block;
}

/** Resolved column widths in twips: measured widths from layout, the fixed grid, or the stored grid. */
function columnWidths(model, table, measured) {
  if (measured?.length === table.grid.length && measured.every(w => w > 0)) return [...measured];
  if (table.layout !== 'autofit' || table.grid.every(w => w > 0)) return fixedColumnWidths(table, model.sectionWritingWidth);
  const fallback = model.sectionWritingWidth / table.grid.length;
  return table.grid.map(w => w || fallback);
}

// The first paragraph a cell owns directly (a nested table's paragraphs belong to its own cells).
const directParagraph = (content, id, last = false) => (last ? content?.findLast(p => p.cellId === id) : content?.find(p => p.cellId === id)) || content?.[last ? content.length - 1 : 0];
const blankFor = (state, owner, cell) => M.blankCellParagraph(directParagraph(state.byCell.get(owner.id), owner.id), cell);
function newCell(source, extra = {}) {
  const cell = { ...copy(source), id: tableId('cell'), generated: true, ...extra };
  M.clearMerge(cell); delete cell.continuationControl;
  return cell;
}
function checkLength(model, added) {
  if (model.text.length + added > MAX_DOCUMENT_CHARACTERS) throw new Error(DOCUMENT_CHARACTER_LIMIT_MESSAGE);
}
function selectOwner(model, table, rowIndex, column = 0) {
  const placements = ownerPlacements(table);
  const hit = placements.find(p => p.rowIndex <= rowIndex && p.endRow >= rowIndex && p.column <= column && p.end > column)
    || placements.find(p => p.rowIndex <= rowIndex && p.endRow >= rowIndex) || placements.at(-1);
  if (hit) model.selectCell(hit.cell.id);
}
// Continuation cells whose merge has no first cell above them (imported documents can have these).
function orphans(table) {
  const owners = verticalMerges(table);
  return new Set(tableCells(table).filter(cell => cell.vMerge === 'continue' && owners.get(cell.id).cell === cell).map(cell => cell.id));
}
/** After a structural edit: the table must still read as rows of cells whose merges line up. */
function checkStructure(model, table, before, message = 'Cells merged across rows would no longer line up. Split them first.') {
  let after;
  try { after = orphans(table); documentBlocks(model.paragraphs, model.tables); } catch { throw new Error(message); }
  for (const id of after) if (!before.has(id)) throw new Error(message);
}
function validate(model) {
  try { documentBlocks(model.paragraphs, model.tables); } catch (error) { throw new Error(`The table cannot be changed that way: ${error.message}`); }
}
function setGrid(table, widths, { fixed = table.layout !== 'autofit' } = {}) {
  table.grid = widths; table.gridChanged = true;
  if (fixed) {
    M.setCellWidths(table, widths);
    if (table.width?.type !== 'pct') { table.width = { type: 'dxa', value: Math.min(MAX_WIDTH, sum(widths)) }; table.widthChanged = true; }
  }
}

/* ---- Rows and columns ---- */

/** Insert rows above or below the selected rows: as many as are selected unless `count` says. */
export function insertRows(model, { above = false, count = null } = {}) {
  const block = requireBlock(model), table = block.table;
  const n = count ?? block.bottom - block.top + 1;
  if (!Number.isInteger(n) || n < 1) throw new Error('Choose how many rows to insert.');
  if (table.rows.length + n > 1000) throw new Error('A table can have up to 1,000 rows.');
  const reference = above ? block.top : block.bottom, row = table.rows[reference], owners = verticalMerges(table);
  checkLength(model, row.cells.length * n);
  const headers = headerRowCount(table), state = M.tableContent(model, table);
  model.checkpoint();
  const created = Array.from({ length: n }, () => {
    const next = { ...copy(row), id: tableId('row'), header: above ? !!row.header && reference < headers : reference + 1 < headers, headerChanged: true, cells: [] };
    next.cells = row.cells.map(source => {
      const owner = owners.get(source.id), cell = newCell(source);
      // A new row inside a vertical merge continues it; elsewhere each cell gets an empty paragraph.
      if (above ? owner.rowIndex < reference : owner.endRow > reference) cell.vMerge = 'continue';
      else state.byCell.set(cell.id, [blankFor(state, owner.cell, cell)]);
      return cell;
    });
    return next;
  });
  if (!above) state.bookmarks.insertedRow = { tableId: table.id, after: row.id, id: created[0].id };
  table.rows.splice(above ? reference : reference + 1, 0, ...created);
  M.applyTableContent(model, table, state);
  validate(model);
  const first = created[0].cells.find(cell => state.byCell.has(cell.id));
  if (first) model.selectCell(first.id);
  model.didChange(); return true;
}

/** Insert columns left or right of the selected columns: as many as are selected unless `count` says. */
export function insertColumns(model, { left = false, count = null, widths: measured } = {}) {
  const block = requireBlock(model), table = block.table;
  if (table.rows.some(row => row.gridBefore || row.gridAfter)) throw new Error('Columns cannot be inserted in a table whose rows end unevenly yet.');
  const n = count ?? block.right - block.left;
  if (!Number.isInteger(n) || n < 1) throw new Error('Choose how many columns to insert.');
  if (table.grid.length + n > 32) throw new Error('A table can have up to 32 columns.');
  checkLength(model, table.rows.length * n);
  const position = left ? block.left : block.right, automatic = table.layout === 'autofit';
  let grid;
  if (automatic) { grid = [...table.grid]; grid.splice(position, 0, ...Array(n).fill(0)); }
  else {
    // New columns match the column beside them; the table keeps its width.
    const base = columnWidths(model, table, measured), total = Math.round(sum(base));
    const raw = [...base]; raw.splice(position, 0, ...Array(n).fill(base[left ? position : position - 1]));
    grid = integerWidths(raw, total);
    if (grid.some(w => w < 360)) throw new Error('The new columns would leave too little writing space. Widen the table or insert fewer columns.');
  }
  const state = M.tableContent(model, table), owners = verticalMerges(table);
  state.bookmarks.gridEdit = { tableId: table.id, position, removed: 0, inserted: n };
  model.checkpoint();
  let selected;
  table.rows.forEach((row, rowIndex) => {
    const entries = rowGrid(row), containing = entries.find(c => c.column < position && c.end > position);
    if (containing) { containing.cell.span = containing.span + n; containing.cell.spanChanged = true; return; }
    const source = (left ? entries.find(c => c.column === position) : entries.find(c => c.end === position)) || entries.find(c => c.end === position) || entries.find(c => c.column === position);
    const at = row.cells.indexOf(source.cell) + (source.column === position ? 0 : 1);
    const added = Array.from({ length: n }, () => {
      const cell = newCell(source.cell, { span: 1, spanChanged: true, width: { type: 'auto', value: 0 }, widthChanged: true });
      state.byCell.set(cell.id, [blankFor(state, owners.get(source.cell.id).cell, cell)]);
      return cell;
    });
    row.cells.splice(at, 0, ...added);
    if (rowIndex === block.top) selected = added[0].id;
  });
  setGrid(table, grid, { fixed: !automatic });
  M.applyTableContent(model, table, state);
  validate(model);
  if (selected) model.selectCell(selected);
  model.didChange(); return true;
}

function removeTable(model, table) {
  const state = M.tableContent(model, table);
  model.checkpoint();
  model.tables = model.tables.filter(t => t.id !== table.id);
  model.paragraphs.splice(state.start, state.count);
  M.removeOrphanedTables(model);
  if (!model.paragraphs.length) model.paragraphs.push(paragraph());
  repairStructuralBookmarks(model.paragraphs, state.bookmarks, model.tables, table.id);
  normalizeBlockBookmarkScopes(model.paragraphs, model.tables);
  model.select(model.paragraphOffset(Math.max(0, Math.min(state.start, model.paragraphs.length - 1))));
  model.didChange(); return true;
}

/** Delete the table holding the selection. */
export function deleteTable(model) { return removeTable(model, requireBlock(model).table); }

/** Delete the selected rows; deleting every row deletes the table. */
export function deleteRows(model) {
  const block = requireBlock(model), table = block.table;
  if (block.top === 0 && block.bottom === table.rows.length - 1) return removeTable(model, table);
  const state = M.tableContent(model, table);
  model.checkpoint();
  for (let rowIndex = block.bottom; rowIndex >= block.top; rowIndex--) {
    const owners = verticalMerges(table), row = table.rows[rowIndex];
    for (const cell of row.cells) {
      const owner = owners.get(cell.id);
      if (owner.cell !== cell || owner.cells.length === 1) continue;
      // The next row of a vertical merge takes over its content.
      const promoted = owner.cells[1], id = promoted.id;
      Object.assign(promoted, copy(cell), { id, generated: true, vMerge: owner.cells.length > 2 ? 'restart' : null, mergeChanged: true });
      delete promoted.continuation; delete promoted.continuationStyleId;
      const content = state.byCell.get(cell.id) || [];
      M.reparentCellContent(model, content, cell.id, id); state.byCell.set(id, content);
    }
    table.rows.splice(rowIndex, 1);
  }
  M.applyTableContent(model, table, state);
  validate(model);
  selectOwner(model, table, Math.min(block.top, table.rows.length - 1), block.left);
  model.didChange(); return true;
}

/** Delete the selected grid columns; deleting every column deletes the table. */
export function deleteColumns(model, { widths: measured } = {}) {
  const block = requireBlock(model), table = block.table;
  if (block.left === 0 && block.right === table.grid.length) return removeTable(model, table);
  if (table.rows.some(row => row.gridBefore || row.gridAfter)) throw new Error('Columns cannot be deleted from a table whose rows end unevenly yet.');
  const column = block.left, end = block.right, span = end - column;
  const entries = table.rows.flatMap(rowGrid), removed = new Set(entries.filter(c => c.column >= column && c.end <= end).map(c => c.cell.id));
  const automatic = table.layout === 'autofit', widths = automatic ? [...table.grid] : columnWidths(model, table, measured);
  const state = M.tableContent(model, table);
  state.bookmarks.gridEdit = { tableId: table.id, position: column, removed: span, inserted: 0 };
  model.checkpoint();
  widths.splice(column, span);
  for (const item of entries) {
    const overlap = Math.max(0, Math.min(item.end, end) - Math.max(item.column, column));
    if (overlap && !removed.has(item.cell.id)) { item.cell.span = item.span - overlap; item.cell.spanChanged = true; }
  }
  for (const row of table.rows) row.cells = row.cells.filter(cell => !removed.has(cell.id));
  setGrid(table, automatic ? widths : integerWidths(widths), { fixed: !automatic });
  M.applyTableContent(model, table, state);
  validate(model);
  selectOwner(model, table, block.top, Math.min(column, table.grid.length - 1));
  model.didChange(); return true;
}

function cellsInRow(row, left, right) {
  return rowGrid(row).filter(c => c.column >= left && c.end <= right);
}
function requireAligned(table, block) {
  for (let r = block.top; r <= block.bottom; r++) {
    const covered = sum(cellsInRow(table.rows[r], block.left, block.right).map(c => c.span));
    if (covered !== block.right - block.left) throw new Error('Select cells that line up across the selected rows.');
  }
}
// Content can move up or down a set of columns only when every row divides them into the same unmerged cells.
function requireUnmerged(table, rows, left, right, message) {
  const owners = verticalMerges(table);
  let shape = null;
  for (const r of rows) {
    const row = table.rows[r];
    if (!row) continue;
    const cells = cellsInRow(row, left, right), signature = cells.map(c => c.span).join();
    if (sum(cells.map(c => c.span)) !== right - left || cells.some(c => owners.get(c.cell.id).cells.length > 1) || shape !== null && signature !== shape) throw new Error(message);
    shape = signature;
  }
}

/** Delete Cells: shift the cells to the right of the selection left, or the cells below it up. */
export function deleteCells(model, { shift = 'left' } = {}) {
  const block = requireBlock(model), table = block.table;
  if (shift === 'row') return deleteRows(model);
  if (shift === 'column') return deleteColumns(model);
  if (!['left', 'up'].includes(shift)) throw new Error('Choose how the remaining cells move.');
  requireAligned(table, block);
  if (shift === 'left') {
    if (block.left === 0 && block.right === table.grid.length) return deleteRows(model);
    const removed = new Set(cellBlockPlacements(table, block).flatMap(p => verticalMerges(table).get(p.cell.id).cells.map(c => c.id)));
    const state = M.tableContent(model, table), before = orphans(table);
    model.checkpoint();
    for (let r = block.top; r <= block.bottom; r++) {
      const row = table.rows[r], gone = row.cells.filter(cell => removed.has(cell.id));
      row.cells = row.cells.filter(cell => !removed.has(cell.id));
      // The row ends early: the deleted span becomes omitted grid columns after its last cell.
      row.gridAfter = (row.gridAfter || 0) + sum(gone.map(cell => cell.span ?? 1));
      row.widthAfter = { type: 'auto', value: 0 }; row.widthAfterChanged = true; row.gridAfterChanged = true;
      if (!row.cells.length) throw new Error('Each row must keep at least one cell. Delete the row instead.');
    }
    M.applyTableContent(model, table, state);
    checkStructure(model, table, before);
    selectOwner(model, table, block.top, Math.max(0, block.left - 1));
    model.didChange(); return true;
  }
  // Shift up: the cells beneath move into the selection, and the bottom of those columns empties.
  const height = block.bottom - block.top + 1, rows = Array.from({ length: table.rows.length - block.top }, (_, i) => block.top + i);
  requireUnmerged(table, rows, block.left, block.right, 'Cells can shift up only through columns without merged cells.');
  const state = M.tableContent(model, table);
  model.checkpoint();
  const column = r => cellsInRow(table.rows[r], block.left, block.right).map(c => c.cell);
  for (const r of rows) {
    const target = column(r), from = r + height < table.rows.length ? column(r + height) : null;
    target.forEach((cell, i) => {
      const source = from?.[i];
      const content = source ? state.byCell.get(source.id) : [blankFor(state, cell, cell)];
      if (source) M.reparentCellContent(model, content, source.id, cell.id);
      state.byCell.set(cell.id, content);
    });
  }
  M.applyTableContent(model, table, state);
  validate(model);
  selectOwner(model, table, block.top, block.left);
  model.didChange(); return true;
}

/** Insert Cells: blank cells at the selection, shifting the selected cells right or down. */
export function insertCells(model, { shift = 'down', widths: measured } = {}) {
  if (shift === 'row') return insertRows(model, { above: true });
  if (shift === 'column') return insertColumns(model, { left: true, widths: measured });
  if (!['right', 'down'].includes(shift)) throw new Error('Choose how the selected cells move.');
  const block = requireBlock(model), table = block.table;
  requireAligned(table, block);
  const width = block.right - block.left, height = block.bottom - block.top + 1;
  if (shift === 'right') {
    const extra = Math.max(0, ...Array.from({ length: height }, (_, i) => width - (table.rows[block.top + i].gridAfter || 0)));
    if (table.grid.length + extra > 32) throw new Error('A table can have up to 32 columns.');
    checkLength(model, height * width);
    const base = columnWidths(model, table, measured), state = M.tableContent(model, table), owners = verticalMerges(table), before = orphans(table);
    model.checkpoint();
    if (extra) {
      // The longer rows run past the table's right edge into new grid columns.
      const added = Array(extra).fill(Math.round(spanWidth(base, block.left, width) / width));
      table.grid = [...integerWidths(base), ...added]; table.gridChanged = true;
      table.rows.forEach((row, r) => { if (r < block.top || r > block.bottom) { row.gridAfter = (row.gridAfter || 0) + extra; row.widthAfter = { type: 'auto', value: 0 }; row.widthAfterChanged = true; row.gridAfterChanged = true; } });
      if (table.width?.type === 'dxa') { table.width = { type: 'dxa', value: Math.min(MAX_WIDTH, sum(table.grid)) }; table.widthChanged = true; }
    }
    for (let r = block.top; r <= block.bottom; r++) {
      const row = table.rows[r], cells = cellsInRow(row, block.left, block.right), at = row.cells.indexOf(cells[0].cell);
      const fresh = cells.map(c => {
        const cell = newCell(c.cell, { width: { type: 'auto', value: 0 }, widthChanged: true });
        if (c.cell.vMerge === 'continue') cell.vMerge = 'continue';
        else state.byCell.set(cell.id, [blankFor(state, owners.get(c.cell.id).cell, cell)]);
        if (c.cell.vMerge === 'restart') { cell.vMerge = 'restart'; cell.mergeChanged = true; }
        return cell;
      });
      row.cells.splice(at, 0, ...fresh);
      const used = Math.min(row.gridAfter || 0, width);
      if (row.gridAfter) { row.gridAfter -= used; row.gridAfterChanged = true; row.widthAfter = { type: 'auto', value: 0 }; row.widthAfterChanged = true; }
      if (width - used > extra) throw new Error('These rows cannot grow by that many columns.');
      // Rows that needed fewer new grid columns than the widest keep the rest as omitted cells.
      if (extra && width - used < extra) { row.gridAfter = (row.gridAfter || 0) + extra - (width - used); row.gridAfterChanged = true; row.widthAfter = { type: 'auto', value: 0 }; row.widthAfterChanged = true; }
    }
    M.applyTableContent(model, table, state);
    checkStructure(model, table, before);
    selectOwner(model, table, block.top, block.left);
    model.didChange(); return true;
  }
  // Shift down: new rows at the bottom make room, and the columns' contents move down.
  if (table.rows.length + height > 1000) throw new Error('A table can have up to 1,000 rows.');
  const rows = Array.from({ length: table.rows.length - block.top }, (_, i) => block.top + i);
  requireUnmerged(table, rows, block.left, block.right, 'Cells can shift down only through columns without merged cells.');
  const last = table.rows.at(-1), owners = verticalMerges(table);
  if (last.cells.some(cell => owners.get(cell.id).cells.length > 1)) throw new Error('Split the merged cells in the last row before shifting cells down.');
  checkLength(model, height * last.cells.length);
  const state = M.tableContent(model, table);
  model.checkpoint();
  for (let i = 0; i < height; i++) {
    const row = { ...copy(last), id: tableId('row'), header: false, headerChanged: true, cells: last.cells.map(source => newCell(source)) };
    for (const cell of row.cells) state.byCell.set(cell.id, [blankFor(state, owners.get(last.cells[row.cells.indexOf(cell)].id).cell, cell)]);
    table.rows.push(row);
  }
  const column = r => cellsInRow(table.rows[r], block.left, block.right).map(c => c.cell);
  for (let r = table.rows.length - 1; r >= block.top; r--) {
    const target = column(r), from = r - height >= block.top ? column(r - height) : null;
    target.forEach((cell, i) => {
      const source = from?.[i];
      const content = source ? state.byCell.get(source.id) : [blankFor(state, cell, cell)];
      if (source) M.reparentCellContent(model, content, source.id, cell.id);
      state.byCell.set(cell.id, content);
    });
  }
  M.applyTableContent(model, table, state);
  validate(model);
  selectOwner(model, table, block.top, block.left);
  model.didChange(); return true;
}

/* ---- Merge and split ---- */

/** Merge the selected rectangle of cells into one, keeping each non-empty cell's paragraphs. */
export function mergeBlock(model) {
  const block = requireBlock(model), table = block.table, placements = cellBlockPlacements(table, block);
  if (placements.length < 2) throw new Error('Select two or more cells to merge.');
  requireAligned(table, block);
  const owner = placements[0].cell, span = block.right - block.left;
  const width = table.layout === 'fixed' ? { type: 'dxa', value: Math.round(spanWidth(fixedColumnWidths(table, model.sectionWritingWidth), block.left, span)) } : { type: 'auto', value: 0 };
  if (width.value > MAX_WIDTH) throw new Error('The merged cell would be wider than 22 inches.');
  const state = M.tableContent(model, table);
  model.checkpoint();
  const empty = content => content.length === 1 && content[0].cellId && !paragraphText(content[0]) && !content[0].bookmarks?.length;
  const filled = placements.filter(p => !empty(state.byCell.get(p.cell.id) || []));
  const merged = [];
  for (const p of filled.length ? filled : [placements[0]]) {
    const content = state.byCell.get(p.cell.id) || [];
    if (p.cell !== owner) M.reparentCellContent(model, content, p.cell.id, owner.id);
    merged.push(...content);
  }
  for (const p of placements) state.byCell.delete(p.cell.id);
  state.byCell.set(owner.id, merged);
  if (model.hasPersistentBlockControls) mergeCellControls(model.paragraphs, new Set(placements.map(p => p.cell.id)), owner.id);
  for (let r = block.top; r <= block.bottom; r++) {
    const row = table.rows[r], inside = cellsInRow(row, block.left, block.right).map(c => c.cell);
    const keep = r === block.top ? owner : inside[0];
    const index = row.cells.indexOf(inside[0]);
    M.clearMerge(keep); delete keep.continuationControl;
    Object.assign(keep, { span, spanChanged: true, width: copy(width), widthChanged: true });
    if (block.bottom > block.top) {
      keep.vMerge = r === block.top ? 'restart' : 'continue';
      if (r > block.top) keep.continuationStyleId = model.styles.defaultParagraph;
    }
    row.cells.splice(index, inside.length, keep);
  }
  M.applyTableContent(model, table, state);
  validate(model);
  model.selectCell(owner.id);
  model.didChange(); return true;
}

// Insert a grid line at `offset` twips inside grid column `index`. Every cell crossing it widens by one column.
function splitGridColumn(table, widths, index, offset) {
  const left = Math.round(offset), right = widths[index] - left;
  widths.splice(index, 1, left, right);
  for (const row of table.rows) {
    if ((row.gridBefore || 0) > index) { row.gridBefore++; row.gridBeforeChanged = true; continue; }
    const crossing = rowGrid(row).find(c => c.column <= index && c.end > index);
    if (crossing) { crossing.cell.span = crossing.span + 1; crossing.cell.spanChanged = true; }
    else if (row.gridAfter) { row.gridAfter++; row.gridAfterChanged = true; }
  }
}

/**
 * Split Cells: divide the selected cell into `rows` × `columns` cells. A selection of several
 * cells is merged first. Widths come from layout (`widths`, in twips) where the grid is automatic.
 */
export function splitCells(model, { rows = 1, columns = 2, widths: measured } = {}) {
  if (![rows, columns].every(n => Number.isInteger(n) && n >= 1 && n <= 32) || rows * columns < 2) throw new Error('Split into 1–32 rows and columns, at least two cells in all.');
  let block = requireBlock(model);
  const startPlacements = cellBlockPlacements(block.table, block);
  if (startPlacements.length > 1) { mergeBlock(model); block = requireBlock(model); }
  const table = block.table, target = cellBlockPlacements(table, block)[0];
  if (!target) throw new Error('Put the cursor in the cell to split.');
  const height = target.endRow - target.rowIndex + 1;
  if (rows > 1 && height > 1 && (rows > height || height % rows)) throw new Error(`This merged cell spans ${height} rows. Split it into a number of rows that divides ${height}.`);
  if (rows > 1 && height === 1 && table.rows.length + rows - 1 > 1000) throw new Error('A table can have up to 1,000 rows.');
  const widths = columnWidths(model, table, measured).map(w => Math.max(1, w));
  checkLength(model, rows * columns * 2);
  const state = M.tableContent(model, table), before = orphans(table);
  if (startPlacements.length <= 1) model.checkpoint();
  // Columns: cut the cell at equal widths, adding grid lines where none fall close enough.
  let pieces = [target.cell];
  if (columns > 1) {
    const total = spanWidth(widths, target.column, target.end - target.column);
    if (total / columns < MIN_COLUMN_WIDTH) throw new Error('The cell is too narrow to split into that many columns.');
    const cuts = Array.from({ length: columns - 1 }, (_, i) => total * (i + 1) / columns);
    let end = target.end;
    for (const cut of cuts) {
      let at = target.column, offset = 0;
      while (at < end && offset + widths[at] <= cut + 1e-6) { offset += widths[at]; at++; }
      const near = Math.min(Math.abs(cut - offset), at < end ? Math.abs(offset + widths[at] - cut) : Infinity);
      if (near > 20 && at < end) {
        if (widths.length >= 32) throw new Error('A table can have up to 32 columns.');
        splitGridColumn(table, widths, at, cut - offset); end++;
      }
    }
    // Grid lines inside the cell, nearest to each cut.
    const lines = [];
    let offset = 0;
    for (let at = target.column; at < end - 1; at++) { offset += widths[at]; lines.push({ at: at + 1, offset }); }
    const chosen = cuts.map(cut => lines.reduce((best, line) => Math.abs(line.offset - cut) < Math.abs(best.offset - cut) ? line : best).at);
    const bounds = [target.column, ...chosen, end];
    if (new Set(bounds).size !== bounds.length) throw new Error('The cell is too narrow to split into that many columns.');
    const merges = verticalMerges(table).get(target.cell.id).cells;
    for (const physical of merges) {
      const row = table.rows.find(r => r.cells.includes(physical)), index = row.cells.indexOf(physical);
      const parts = bounds.slice(0, -1).map((from, i) => {
        const cell = i === 0 && physical === target.cell ? physical : newCell(physical);
        if (i === 0) Object.assign(cell, { id: physical.id });
        cell.span = bounds[i + 1] - from; cell.spanChanged = true;
        cell.width = table.layout === 'fixed' ? { type: 'dxa', value: Math.round(spanWidth(widths, from, cell.span)) } : { type: 'auto', value: 0 }; cell.widthChanged = true;
        if (physical.vMerge && cell !== physical) { cell.vMerge = physical.vMerge; cell.mergeChanged = true; }
        if (physical === target.cell && i > 0) state.byCell.set(cell.id, [blankFor(state, target.cell, cell)]);
        return cell;
      });
      row.cells.splice(index, 1, ...parts);
      if (physical === target.cell) pieces = parts;
    }
    if (widths.length !== table.grid.length) { table.grid = integerWidths(widths); table.gridChanged = true; }
  }
  if (rows > 1) {
    const owners = verticalMerges(table), pieceIds = new Set(pieces.map(c => c.id));
    if (height === 1) {
      // New rows under the cell: its pieces get cells of their own, every other cell merges down.
      const rowIndex = target.rowIndex, row = table.rows[rowIndex];
      for (const cell of row.cells) {
        if (pieceIds.has(cell.id)) continue;
        const owner = owners.get(cell.id);
        if (owner.cell === cell && !cell.vMerge) { cell.vMerge = 'restart'; cell.mergeChanged = true; }
      }
      const created = Array.from({ length: rows - 1 }, () => ({ ...copy(row), id: tableId('row'), headerChanged: true,
        cells: row.cells.map(source => {
          const cell = newCell(source);
          if (pieceIds.has(source.id)) { cell.width = copy(source.width); cell.widthChanged = true; state.byCell.set(cell.id, [blankFor(state, target.cell, cell)]); }
          else { cell.vMerge = 'continue'; cell.mergeChanged = true; }
          return cell;
        }) }));
      table.rows.splice(rowIndex + 1, 0, ...created);
    } else {
      // A cell merged across rows divides its rows into equal groups.
      const group = height / rows;
      for (const piece of pieces) {
        const physical = owners.get(piece.id).cells;
        physical.forEach((cell, i) => {
          const start = i % group === 0;
          cell.vMerge = group > 1 ? (start ? 'restart' : 'continue') : null; cell.mergeChanged = true;
          if (start && i > 0) { delete cell.continuation; delete cell.continuationStyleId; state.byCell.set(cell.id, [blankFor(state, target.cell, cell)]); }
        });
      }
    }
  }
  M.applyTableContent(model, table, state);
  checkStructure(model, table, before, 'The split cells would not line up with the merged cells around them.');
  model.selectCell(target.cell.id);
  model.didChange(); return true;
}

/** Split Table: the selected row and those below it become a new table after an empty paragraph. */
export function splitTable(model) {
  const block = requireBlock(model), table = block.table, at = block.top;
  if (at === 0) return model.insertTableParagraph(false);
  const state = M.tableContent(model, table), owners = verticalMerges(table);
  model.checkpoint();
  // A merge crossing the cut ends above it; its next row starts a cell of its own.
  for (const owner of new Set(owners.values())) if (owner.rowIndex < at && owner.endRow >= at) {
    const promoted = owner.cells[at - owner.rowIndex];
    promoted.vMerge = owner.endRow > at ? 'restart' : null; promoted.mergeChanged = true;
    delete promoted.continuation; delete promoted.continuationStyleId;
    state.byCell.set(promoted.id, [blankFor(state, owner.cell, promoted)]);
    if (owner.rowIndex === at - 1) { owner.cell.vMerge = null; owner.cell.mergeChanged = true; }
  }
  const second = { ...copy({ ...table, rows: [] }), id: tableId('t'), rows: table.rows.splice(at) };
  delete second.design;
  for (const row of second.rows) if (row.header) { row.header = false; row.headerChanged = true; }
  const separator = resolveStyledParagraph(paragraph('', table.parentCellId ? (() => {
    const parent = cellContext(model.tables, table.parentCellId);
    return { cellId: parent.cell.id, tableStyleId: parent.table.styleId, ...(parent.cell.styleRegions ? { tableStyleRegions: parent.cell.styleRegions } : {}) };
  })() : {}), model.styles, model.numbering);
  const content = t => editableCells(t).flatMap(c => state.byCell.get(c.id) || []);
  model.paragraphs.splice(state.start, state.count, ...content(table), separator, ...content(second));
  model.tables.splice(model.tables.indexOf(table) + 1, 0, second);
  M.refreshTableStyles(model, table); M.refreshTableStyles(model, second);
  repairStructuralBookmarks(model.paragraphs, state.bookmarks, model.tables, table.id);
  normalizeBlockBookmarkScopes(model.paragraphs, model.tables);
  model.select(model.paragraphOffset(model.paragraphs.indexOf(separator)));
  model.didChange(); return true;
}

/* ---- Sizes ---- */

/** Set the grid of a table to these widths (twips). Cell preferences follow; `layout` may fix the table. */
export function setColumnWidths(model, table, widths, { layout } = {}) {
  if (widths.length !== table.grid.length || widths.some(w => !Number.isInteger(w) || w < 1 || w > MAX_WIDTH)) throw new Error('Enter a positive width for each column, up to 22 inches.');
  if (sum(widths) > MAX_WIDTH) throw new Error('The table would be wider than 22 inches.');
  model.checkpoint();
  if (layout && table.layout !== layout) { table.layout = layout; table.layoutChanged = true; }
  setGrid(table, [...widths], { fixed: true });
  model.didChange(); return true;
}

/** Width spinner: the selected columns (each selected cell of the top row) take this width. */
export function setSelectedColumnWidth(model, twips, { widths: measured } = {}) {
  if (!Number.isFinite(twips) || twips < MIN_COLUMN_WIDTH || twips > MAX_WIDTH) throw new Error('Enter a column width from 0.1 to 22 inches.');
  const block = requireBlock(model), table = block.table;
  const widths = columnWidths(model, table, measured);
  const next = [...widths];
  for (const c of cellsInRow(table.rows[block.top], block.left, block.right)) {
    const current = spanWidth(widths, c.column, c.span);
    for (let i = c.column; i < c.end; i++) next[i] = widths[i] * twips / current;
  }
  return setColumnWidths(model, table, integerWidths(next, Math.round(sum(next))), { layout: 'fixed' });
}

/** Height spinner and row-border dragging: the rows take this minimum height (twips). */
export function setRowsHeight(model, rows, twips, rule = 'atLeast') {
  if (!Number.isFinite(twips) || twips < 0 || twips > 31680) throw new Error('Enter a row height up to 22 inches.');
  if (!['atLeast', 'exact', 'auto'].includes(rule)) throw new Error('Choose at least, exactly or automatic.');
  const value = rule === 'auto' ? 0 : Math.round(twips);
  const changed = rows.filter(row => !row.heightExplicit || row.heightRule !== rule || row.minHeight !== value);
  if (!changed.length) return false;
  model.checkpoint();
  for (const row of changed) Object.assign(row, { heightRule: rule, minHeight: value, heightExplicit: true, heightChanged: true });
  model.didChange(); return true;
}
export function setSelectedRowHeight(model, twips, rule = 'atLeast') {
  const block = requireBlock(model);
  return setRowsHeight(model, block.table.rows.slice(block.top, block.bottom + 1), twips, rule);
}

/** Distribute Rows: the selected rows (or every row) share their total height evenly. `heights` are the laid-out row heights in twips. */
export function distributeRows(model, { heights } = {}) {
  const block = requireBlock(model), table = block.table;
  const indices = block.bottom > block.top ? Array.from({ length: block.bottom - block.top + 1 }, (_, i) => block.top + i) : table.rows.map((_, i) => i);
  if (indices.length < 2) throw new Error('Select two or more rows to distribute.');
  const measured = indices.map(i => heights?.[i] ?? table.rows[i].minHeight ?? 0);
  const even = Math.round(sum(measured) / indices.length);
  return setRowsHeight(model, indices.map(i => table.rows[i]), even, 'atLeast');
}

/** Distribute Columns: the selected columns (or every column) share their total width evenly. */
export function distributeColumns(model, { widths: measured } = {}) {
  const block = requireBlock(model), table = block.table;
  const [left, right] = block.right - block.left > 1 ? [block.left, block.right] : [0, table.grid.length];
  if (right - left < 2) throw new Error('Select two or more columns to distribute.');
  const widths = columnWidths(model, table, measured), next = [...widths];
  const even = spanWidth(widths, left, right - left) / (right - left);
  for (let i = left; i < right; i++) next[i] = even;
  return setColumnWidths(model, table, integerWidths(next, Math.round(sum(widths))), { layout: 'fixed' });
}

/** AutoFit → Fixed Column Width: today's column widths become fixed preferences. */
export function fixColumnWidths(model, { widths: measured } = {}) {
  const table = requireBlock(model).table, widths = columnWidths(model, table, measured);
  return setColumnWidths(model, table, integerWidths(widths, Math.round(sum(widths))), { layout: 'fixed' });
}

/** AutoFit to contents or window, for the selected table (not only the caret's innermost one). */
export function autofitTable(model, mode) {
  const table = requireBlock(model).table;
  if (!['contents', 'window'].includes(mode)) throw new Error('Choose AutoFit to contents or window.');
  model.checkpoint();
  table.layout = 'autofit'; table.layoutChanged = true;
  table.width = mode === 'window' ? { type: 'pct', value: 5000 } : { type: 'auto', value: 0 }; table.widthChanged = true;
  for (const cell of tableCells(table)) if (cell.width?.type !== 'auto') { cell.width = { type: 'auto', value: 0 }; cell.widthChanged = true; }
  for (const row of table.rows) for (const side of ['Before', 'After']) if (row[`grid${side}`] && row[`width${side}`]?.type !== 'auto') { row[`width${side}`] = { type: 'auto', value: 0 }; row[`width${side}Changed`] = true; }
  model.didChange(); return true;
}

/* ---- Cell formatting ---- */

/** Run `fn` with the text selection over each cell's whole content, then restore the selection. */
export function eachSelectedCell(model, fn) {
  const block = model.cellBlock, selection = { ...model.selection }, cells = model.selectedTableCells;
  let changed = false;
  for (const cell of cells) {
    const first = model.paragraphs.findIndex(p => p.cellId === cell.id), last = model.paragraphs.findLastIndex(p => p.cellId === cell.id);
    if (first < 0) continue;
    model.select(model.paragraphOffset(first), model.paragraphOffset(last) + paragraphText(model.paragraphs[last]).length);
    if (fn(cell)) changed = true;
  }
  if (block) model.setCellBlock(block); else model.select(selection.anchor, selection.focus);
  return changed;
}

/** Alignment grid: the selected cells' text aligns horizontally and vertically at once. */
export function setCellAlignment(model, { horizontal, vertical } = {}) {
  if (vertical !== undefined && vertical !== null) checkedCellAlignment(vertical);
  if (horizontal !== undefined && !['left', 'center', 'right', 'both'].includes(horizontal)) throw new Error('Choose left, center or right alignment.');
  let changed = false;
  if (vertical !== undefined) changed = model.setCellVerticalAlignment(vertical) || changed;
  if (horizontal !== undefined) changed = eachSelectedCell(model, () => model.setParagraphFormat({ alignment: horizontal })) || changed;
  return changed;
}

/** Text Direction: the selected cells' text runs left to right, top to bottom, or bottom to top. */
export function setTextDirection(model, value) {
  if (!TEXT_DIRECTIONS.includes(value)) throw new Error('Choose a text direction.');
  const cells = model.selectedTableCells.filter(cell => (cell.textDirection || 'lrTb') !== value || !cell.textDirectionExplicit);
  if (!cells.length) return false;
  model.checkpoint();
  for (const cell of cells) Object.assign(cell, { textDirection: value, textDirectionExplicit: true, textDirectionChanged: true });
  model.didChange(); return true;
}
export function nextTextDirection(model) {
  const current = model.selectedTableCells[0]?.textDirection || 'lrTb';
  return TEXT_DIRECTIONS[(TEXT_DIRECTIONS.indexOf(current) + 1) % TEXT_DIRECTIONS.length];
}

/** Cell options: wrap text in the selected cells, or keep each line whole (w:noWrap). */
export function setCellWrap(model, wrap) {
  const cells = model.selectedTableCells.filter(cell => !!cell.noWrap === wrap || !cell.noWrapExplicit);
  if (!cells.length) return false;
  model.checkpoint();
  for (const cell of cells) Object.assign(cell, { noWrap: !wrap, noWrapExplicit: true, noWrapChanged: true });
  model.didChange(); return true;
}

/** Preferred width of the selected cells: { type: 'auto' | 'dxa' | 'pct', value }. */
export function setCellPreferredWidth(model, width) {
  if (!width || !['auto', 'dxa', 'pct'].includes(width.type) || !Number.isFinite(width.value) || width.value < 0 || width.value > MAX_WIDTH) throw new Error('Enter a valid cell width.');
  const block = requireBlock(model), placements = cellBlockPlacements(block.table, block);
  const owners = verticalMerges(block.table);
  model.checkpoint();
  for (const p of placements) for (const cell of owners.get(p.cell.id).cells) { cell.width = { type: width.type, value: width.type === 'auto' ? 0 : Math.round(width.value) }; cell.widthChanged = true; }
  model.didChange(); return true;
}

function setDirectBorder(cell, side, border) {
  cell.directBorders = { ...cell.directBorders, [side]: copy(border) };
  cell.borderChanges = { ...cell.borderChanges, [side]: copy(border) };
  cell.borders = resolveCellBorders(cell.inheritedBorders, cell.directBorders);
}

/** The cells sharing each edge of a block: [{ cell, side }]. Inside edges list both neighbours. */
function blockEdges(table, block, which) {
  const placements = cellBlockPlacements(table, block), edges = [];
  for (const p of placements) {
    const top = p.rowIndex === block.top, bottom = p.endRow === block.bottom, left = p.column === block.left, right = p.end === block.right;
    const want = side => ({ top: top ? 'outside' : 'insideH', bottom: bottom ? 'outside' : 'insideH', left: left ? 'outside' : 'insideV', right: right ? 'outside' : 'insideV' })[side];
    for (const side of ['top', 'bottom', 'left', 'right']) if (which(side, want(side))) edges.push({ cell: p.cell, side });
  }
  return edges;
}
// The neighbouring cells whose opposite side touches this edge, outside the block.
function neighbourEdges(table, placement, side) {
  const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[side];
  return ownerPlacements(table).filter(p => side === 'top' ? p.endRow === placement.rowIndex - 1 && p.column < placement.end && p.end > placement.column
    : side === 'bottom' ? p.rowIndex === placement.endRow + 1 && p.column < placement.end && p.end > placement.column
    : side === 'left' ? p.end === placement.column && p.rowIndex <= placement.endRow && p.endRow >= placement.rowIndex
    : p.column === placement.end && p.rowIndex <= placement.endRow && p.endRow >= placement.rowIndex).map(p => ({ cell: p.cell, side: opposite }));
}

export const BORDER_PRESETS = Object.freeze(['bottom', 'top', 'left', 'right', 'none', 'all', 'outside', 'inside', 'insideH', 'insideV', 'diagonalDown', 'diagonalUp']);
const sameBorder = (a, b) => !!a && !!b && a.style === b.style && (a.size ?? 0) === (b.size ?? 0) && (a.color ?? 'auto') === (b.color ?? 'auto');

/**
 * Borders drop-down: apply the pen (style, size in eighth-points, color) to edges of the selected cells.
 * Like a desktop word processor, choosing an edge that already has this pen removes it.
 */
export function applyBorderPreset(model, preset, pen, { toggle = true } = {}) {
  if (!BORDER_PRESETS.includes(preset)) throw new Error('Choose which borders to change.');
  const block = requireBlock(model), table = block.table;
  const border = checkedCellBorder(pen), none = checkedCellBorder({ style: 'nil' });
  if (preset === 'diagonalDown' || preset === 'diagonalUp') {
    const side = preset === 'diagonalDown' ? 'tl2br' : 'tr2bl', cells = cellBlockPlacements(table, block).map(p => p.cell);
    const on = cells.every(cell => sameBorder(cell.borders?.[side], border));
    model.checkpoint();
    for (const cell of cells) setDirectBorder(cell, side, toggle && on ? none : border);
    model.didChange(); return true;
  }
  const pick = {
    bottom: (side, kind) => side === 'bottom' && kind === 'outside', top: (side, kind) => side === 'top' && kind === 'outside',
    left: (side, kind) => side === 'left' && kind === 'outside', right: (side, kind) => side === 'right' && kind === 'outside',
    none: () => true, all: () => true, outside: (side, kind) => kind === 'outside', inside: (side, kind) => kind !== 'outside',
    insideH: (side, kind) => kind === 'insideH', insideV: (side, kind) => kind === 'insideV',
  }[preset];
  const edges = blockEdges(table, block, pick);
  if (!edges.length) return false;
  const placements = new Map(ownerPlacements(table).map(p => [p.cell.id, p]));
  const outside = edges.flatMap(edge => {
    const kind = (({ top: placements.get(edge.cell.id).rowIndex === block.top, bottom: placements.get(edge.cell.id).endRow === block.bottom, left: placements.get(edge.cell.id).column === block.left, right: placements.get(edge.cell.id).end === block.right })[edge.side]);
    return kind ? neighbourEdges(table, placements.get(edge.cell.id), edge.side) : [];
  });
  const on = edges.every(({ cell, side }) => sameBorder(cell.borders?.[side], border));
  const value = preset === 'none' || toggle && on ? none : border;
  model.checkpoint();
  for (const { cell, side } of [...edges, ...outside]) setDirectBorder(cell, side, value);
  model.didChange(); return true;
}

/** Border Painter and the eraser: set one edge of one cell (and the cell across it) to `pen`, or remove it. */
export function paintCellEdge(model, { tableId: id, cellId, side, pen }) {
  const table = model.tables.find(t => t.id === id), placement = table && ownerPlacements(table).find(p => p.cell.id === cellId);
  if (!placement || !['top', 'bottom', 'left', 'right'].includes(side)) throw new Error('Choose a cell edge.');
  const border = checkedCellBorder(pen || { style: 'nil' });
  const edges = [{ cell: placement.cell, side }, ...neighbourEdges(table, placement, side)];
  if (edges.every(edge => sameBorder(edge.cell.directBorders?.[edge.side], border))) return false;
  model.checkpoint();
  for (const edge of edges) setDirectBorder(edge.cell, edge.side, border);
  model.didChange(); return true;
}

/* ---- Table properties beyond the existing dialog ---- */

/** Alt Text: the table's title and description (w:tblCaption, w:tblDescription). */
export function setTableAltText(model, { title = '', description = '' } = {}) {
  const table = requireBlock(model).table;
  if (typeof title !== 'string' || typeof description !== 'string' || title.length > 255 || description.length > 4000) throw new Error('Keep the title under 256 and the description under 4,000 characters.');
  if ((table.caption || '') === title && (table.description || '') === description) return false;
  model.checkpoint();
  table.caption = title; table.description = description; table.altTextChanged = true;
  model.didChange(); return true;
}

/** Text wrapping around the table: 'none' keeps it in the text flow; 'around' floats it beside the text. */
export function setTableWrapping(model, wrap, { distance = 180 } = {}) {
  const table = requireBlock(model).table;
  if (!['none', 'around'].includes(wrap)) throw new Error('Choose None or Around.');
  if (table.parentCellId) throw new Error('Text wrapping applies to tables outside other tables.');
  if ((wrap === 'around') === !!table.floating) return false;
  model.checkpoint();
  if (wrap === 'none') { delete table.floating; table.floatingRemoved = true; }
  else {
    const spec = table.alignment === 'center' || table.alignment === 'right' ? { tblpXSpec: table.alignment } : {};
    table.floating = { horzAnchor: 'text', vertAnchor: 'text', tblpX: spec.tblpXSpec ? 0 : table.indent || 0, tblpY: 0, leftFromText: distance, rightFromText: distance, topFromText: 0, bottomFromText: 0, ...spec };
    table.floatingCreated = true;
  }
  table.floatingChanged = true;
  model.didChange(); return true;
}

/** Table Options: default cell margins (w:tblCellMar), in twips. */
export function setTableCellMargins(model, margins) {
  const table = requireBlock(model).table;
  const next = { ...table.margins };
  for (const side of ['top', 'right', 'bottom', 'left']) if (side in margins) {
    const value = margins[side];
    if (!Number.isInteger(value) || value < 0 || value > 31680) throw new Error('Enter cell margins up to 22 inches.');
    next[side] = value;
  }
  if (['top', 'right', 'bottom', 'left'].every(side => next[side] === table.margins[side])) return false;
  model.checkpoint();
  const before = table.margins;
  table.margins = next; table.marginsChanged = true;
  if (table.conditionalStyle) M.refreshTableStyles(model, table);
  else for (const row of table.rows) for (const cell of row.cells) {
    // Sides that came from the table follow it; style and direct margins stay.
    const defaults = cell.marginDefaults || before, inherited = { ...cell.inheritedMargins };
    for (const side of ['top', 'right', 'bottom', 'left']) if ((inherited[side] ?? before[side]) === (defaults[side] ?? before[side])) inherited[side] = next[side];
    cell.marginDefaults = resolveCellMargins(next, row.styleMargins);
    cell.inheritedMargins = inherited;
    cell.margins = resolveCellMargins(cell.inheritedMargins, cell.directMargins, cell.marginDefaults);
  }
  model.didChange(); return true;
}

/** Row options for the selected rows: may the row break across pages, and does it repeat as a header. */
export function setRowOptions(model, { allowBreak, header } = {}) {
  const block = requireBlock(model), table = block.table, rows = table.rows.slice(block.top, block.bottom + 1);
  let changed = false;
  if (allowBreak !== undefined && rows.some(row => !!row.cantSplit === !!allowBreak)) { model.setTableRowKeep(!allowBreak); changed = true; }
  if (header !== undefined) {
    const count = header ? block.bottom + 1 : block.top;
    if (count !== headerRowCount(table) || !header && rows.some(r => r.header)) changed = model.setTableHeaderRows(count) || changed;
  }
  return changed;
}

/* ---- Sort ---- */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** A cell's leading number: currency, thousands separators, percent and accounting negatives allowed. */
export function sortNumber(text) {
  const match = /^([-+−]?)\s*\(?\s*[$€£¥]?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)\s*\)?/.exec(text.trim());
  if (!match) return null;
  const value = Number(match[2].replace(/,/g, ''));
  const negative = match[1] === '-' || match[1] === '−' || /^\s*[-+−]?\s*\(/.test(text) && /\)/.test(text);
  return negative ? -value : value;
}
/** A cell's date as a day count: ISO, month/day/year, and day-month-name-year forms. */
export function sortDate(text) {
  const value = text.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/.exec(value);
  if (m) { const year = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return Date.UTC(year, +m[1] - 1, +m[2]); }
  m = /^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?,?\s+(\d{4})/.exec(value);
  if (m && MONTHS.includes(m[2].toLowerCase())) return Date.UTC(+m[3], MONTHS.indexOf(m[2].toLowerCase()), +m[1]);
  m = /^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(value);
  if (m && MONTHS.includes(m[1].toLowerCase())) return Date.UTC(+m[3], MONTHS.indexOf(m[1].toLowerCase()), +m[2]);
  return null;
}

/**
 * Sort the selected rows (or the table's rows) by up to three keys: [{ column (grid column), type:
 * 'text' | 'number' | 'date', descending }]. `header` keeps the first row in place. Values a key
 * cannot read sort after the others, in either order.
 */
export function sortTable(model, { keys, header = false, caseSensitive = false } = {}) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 3) throw new Error('Choose one to three sort keys.');
  const block = requireBlock(model), table = block.table;
  let [first, last] = block.bottom > block.top ? [block.top, block.bottom] : [0, table.rows.length - 1];
  if (header && first === 0) first = Math.max(first, headerRowCount(table) || 1);
  if (last - first < 1) throw new Error('There are not enough rows to sort.');
  const owners = verticalMerges(table);
  for (let r = first; r <= last; r++) if (table.rows[r].cells.some(cell => owners.get(cell.id).cells.length > 1)) throw new Error('Rows with cells merged across rows cannot be sorted. Split those cells first.');
  for (const key of keys) if (!Number.isInteger(key.column) || key.column < 0 || key.column >= table.grid.length || !['text', 'number', 'date'].includes(key.type)) throw new Error('Choose a column and type for each sort key.');
  const textOf = (row, column) => {
    const cell = rowGrid(row).find(c => c.column <= column && c.end > column)?.cell;
    return cell ? model.paragraphs.filter(p => p.cellId === cell.id).map(paragraphText).join(' ').replace(/￼/g, '').trim() : '';
  };
  const collator = new Intl.Collator(undefined, { sensitivity: caseSensitive ? 'case' : 'base', numeric: false });
  const rows = table.rows.slice(first, last + 1).map((row, index) => ({ row, index, values: keys.map(key => {
    const text = textOf(row, key.column);
    return key.type === 'number' ? sortNumber(text) : key.type === 'date' ? sortDate(text) : text || null;
  }) }));
  const sorted = [...rows].sort((a, b) => {
    for (const [i, key] of keys.entries()) {
      const x = a.values[i], y = b.values[i];
      if (x === null || y === null) { if (x !== y) return x === null ? 1 : -1; continue; }
      const order = key.type === 'text' ? collator.compare(x, y) : x - y;
      if (order) return key.descending ? -order : order;
    }
    return a.index - b.index;
  });
  if (sorted.every((item, i) => item.index === i)) return false;
  const state = M.tableContent(model, table);
  model.checkpoint();
  table.rows.splice(first, sorted.length, ...sorted.map(item => item.row));
  M.applyTableContent(model, table, state);
  validate(model);
  model.didChange(); return true;
}

/* ---- Converting between text and tables ---- */

const SEPARATORS = { tab: '\t', comma: ',', paragraph: null };
function separatorChar(separator, other) {
  if (separator === 'other') { if (typeof other !== 'string' || [...other].length !== 1 || /[\n\v\f]/.test(other)) throw new Error('Type one separator character.'); return other; }
  if (!(separator in SEPARATORS)) throw new Error('Choose how the text is separated.');
  return SEPARATORS[separator];
}
/** Split a paragraph's runs at each separator character, keeping run formatting. */
function splitRuns(runs, char) {
  const fields = [[]];
  for (const run of runs) {
    if (run.image || run.field || run.math || run.noteMark || !run.text.includes(char)) { fields.at(-1).push(copy(run)); continue; }
    const parts = run.text.split(char);
    parts.forEach((text, i) => { if (i) fields.push([]); if (text) fields.at(-1).push({ ...copy(run), text }); });
  }
  return fields;
}
/** How many columns a conversion would make: the most fields in any selected paragraph. */
export function textTableShape(model, { separator = 'tab', other } = {}) {
  const char = separatorChar(separator, other), paragraphs = model.selectedParagraphs;
  if (char === null) return { rows: paragraphs.length, columns: 1 };
  return { rows: paragraphs.length, columns: Math.max(1, ...paragraphs.map(p => splitRuns(p.runs, char).length)) };
}
function convertible(p) {
  if (p.sectionEnd) return 'Section breaks cannot become table cells.';
  if (p.fieldMarkers?.length || p.bookmarks?.length) return 'Text with fields, bookmarks or comments cannot be converted yet.';
  if (p.blockControls?.length || p.runs.some(r => r.contentControl || r.revision)) return 'Text in content controls or tracked changes cannot be converted yet.';
  return null;
}

/** Build an empty table definition the way Insert Table does: single borders, equal fixed columns. */
export function newTable(model, rows, columns, width) {
  const grid = integerWidths(Array(columns).fill(width / columns), Math.round(width));
  if (grid.some(w => w < 360)) throw new Error('These columns are too narrow for the available space. Use fewer columns.');
  const borderSize = 4;
  let styleId = 'CanvasTable1', styleIndex = 1;
  while (Object.hasOwn(model.styles.definitions, styleId)) styleId = `CanvasTable${++styleIndex}`;
  const styles = copy(model.styles);
  styles.definitions[styleId] = { id: styleId, type: 'table', name: 'Canvas table', basedOn: null, properties: {}, reference: {}, run: {}, generated: true };
  const table = { id: tableId('t'), grid, width: { type: 'dxa', value: Math.round(width) }, layout: 'fixed', alignment: 'left', indent: 0, margins: { top: 72, right: 108, bottom: 72, left: 108 },
    borders: Object.fromEntries(['top', 'right', 'bottom', 'left', 'insideH', 'insideV'].map(s => [s, { style: 'single', size: borderSize, color: '000000' }])), styleId, rows: [] };
  for (let r = 0; r < rows; r++) table.rows.push({ id: tableId('row'), cantSplit: true, minHeight: 0, cells: grid.map(w => ({ id: tableId('cell'), width: { type: 'dxa', value: w }, margins: { ...table.margins }, inheritedMargins: { ...table.margins }, directMargins: {}, vertical: 'top' })) });
  return { table, styles };
}
function writingWidth(model) {
  const page = model.sectionPageSettings;
  return model.sectionWritingWidth - (page.gutterAtTop ? 0 : page.gutter || 0) - (page.compatibilityMode >= 15 ? 10 : 0);
}
function applyAutofit(table, autofit) {
  if (autofit === 'fixed' || !autofit) return;
  table.layout = 'autofit';
  table.width = autofit === 'window' ? { type: 'pct', value: 5000 } : { type: 'auto', value: 0 };
  for (const cell of tableCells(table)) cell.width = { type: 'auto', value: 0 };
}

/** Convert Text to Table: the selected paragraphs become rows (or, separated by paragraphs, cells). */
export function convertTextToTable(model, { separator = 'tab', other, columns = null, autofit = 'fixed' } = {}) {
  const char = separatorChar(separator, other), sources = model.selectedParagraphs;
  if (!sources.length || sources.every(p => !paragraphText(p)) && sources.length === 1) throw new Error('Select the text to convert.');
  if (sources.some(p => p.cellId)) throw new Error('Select text outside tables to convert it.');
  for (const p of sources) { const reason = convertible(p); if (reason) throw new Error(reason); }
  const fieldsOf = sources.map(p => char === null ? [p.runs.map(run => copy(run))] : splitRuns(p.runs, char));
  const count = char === null ? Math.max(1, columns ?? 1) : Math.max(columns ?? 1, ...fieldsOf.map(f => f.length));
  if (count > 32) throw new Error('A table can have up to 32 columns.');
  const cells = char === null ? sources.map((p, i) => ({ source: p, runs: fieldsOf[i][0] })) : null;
  const rows = char === null ? Math.ceil(sources.length / count) : sources.length;
  if (rows > 1000) throw new Error('A table can have up to 1,000 rows.');
  const { table, styles } = newTable(model, rows, count, writingWidth(model));
  applyAutofit(table, autofit);
  const first = model.paragraphs.indexOf(sources[0]), last = model.paragraphs.indexOf(sources.at(-1));
  const make = (source, runs, cell) => {
    const p = { ...copy(source), id: paragraph().id, cellId: cell.id, tableStyleId: table.styleId, runs };
    for (const key of ['bookmarks', 'fieldMarkers', 'styleChanged', 'mark']) delete p[key];
    return resolveStyledParagraph(p, styles, model.numbering);
  };
  const content = [];
  table.rows.forEach((row, r) => row.cells.forEach((cell, c) => {
    if (cells) { const item = cells[r * count + c]; content.push(make(item?.source || sources.at(-1), item?.runs || [], cell)); }
    else content.push(make(sources[r], fieldsOf[r][c] || [], cell));
  }));
  model.checkpoint();
  model.styles = styles; model.stylesEnabled = true;
  // A table needs a paragraph after it; the last converted paragraph's formatting supplies one if none follows.
  const after = model.paragraphs[last + 1];
  const tail = after && !after.cellId ? [] : [(() => { const p = { ...copy(sources.at(-1)), id: paragraph().id, runs: [] }; delete p.list; return resolveStyledParagraph(p, styles, model.numbering); })()];
  model.paragraphs.splice(first, last - first + 1, ...content, ...tail);
  model.tables.push(table);
  model.selectCell(table.rows[0].cells[0].id);
  model.didChange(); return true;
}

/** Convert Table to Text: each row becomes a paragraph (cells separated), or each cell its paragraphs. */
export function convertTableToText(model, { separator = 'tab', other } = {}) {
  const char = separatorChar(separator, other), table = requireBlock(model).table;
  const ids = new Set(tableCells(table).map(cell => cell.id));
  if (model.tables.some(t => ids.has(t.parentCellId))) throw new Error('Convert the tables inside this table first.');
  const state = M.tableContent(model, table), owners = verticalMerges(table);
  for (const p of model.paragraphs.slice(state.start, state.start + state.count)) {
    if (p.blockControls?.length) throw new Error('Tables with content controls around cells cannot be converted yet.');
    if (p.bookmarks?.some(m => m.tableBoundary || m.columnRange || m.blockScope)) throw new Error('Tables with bookmarks around rows or columns cannot be converted yet.');
  }
  const parent = table.parentCellId ? cellContext(model.tables, table.parentCellId) : null;
  const scope = p => {
    const next = { ...copy(p), id: paragraph().id };
    delete next.cellId; delete next.tableStyleId; delete next.tableStyleRegions;
    if (parent) Object.assign(next, { cellId: parent.cell.id, tableStyleId: parent.table.styleId, ...(parent.cell.styleRegions ? { tableStyleRegions: parent.cell.styleRegions } : {}) });
    return next;
  };
  const output = [];
  for (const row of table.rows) {
    const cells = row.cells.filter(cell => owners.get(cell.id).cell === cell).map(cell => state.byCell.get(cell.id) || []);
    if (char === null) { for (const content of cells) output.push(...content.map(scope)); continue; }
    const p = scope(cells[0]?.[0] || paragraph());
    p.runs = []; delete p.fieldMarkers; delete p.bookmarks;
    let at = 0;
    const append = (source, text) => {
      for (const marker of source?.fieldMarkers || []) (p.fieldMarkers ||= []).push({ ...marker, offset: marker.offset + at });
      for (const marker of source?.bookmarks || []) { const m = { ...marker, offset: marker.offset + at }; delete m.blockBoundary; delete m.blockScope; (p.bookmarks ||= []).push(m); }
      if (source) for (const run of source.runs) { p.runs.push(copy(run)); at += run.text.length; }
      if (text) { const style = p.runs.at(-1) || { ...(cells[0]?.[0]?.runs[0] || {}), properties: '', overrides: {} }; p.runs.push({ ...copy(style), text }); delete p.runs.at(-1).image; delete p.runs.at(-1).field; at += text.length; }
    };
    cells.forEach((content, i) => {
      if (i) append(null, char);
      content.forEach((source, j) => append(source, j < content.length - 1 ? '\v' : ''));
    });
    p.runs = p.runs.filter(run => run.text);
    output.push(p);
  }
  for (const p of output) resolveStyledParagraph(p, model.styles, model.numbering);
  model.checkpoint();
  model.tables = model.tables.filter(t => t !== table);
  model.paragraphs.splice(state.start, state.count, ...output);
  repairStructuralBookmarks(model.paragraphs, state.bookmarks, model.tables, table.id);
  normalizeBlockBookmarkScopes(model.paragraphs, model.tables);
  model.select(model.paragraphOffset(state.start), model.paragraphOffset(state.start + output.length - 1) + paragraphText(output.at(-1)).length);
  model.didChange(); return true;
}

/* ---- Drawing ---- */

/** Draw Table inside a table: a line through cells splits them, across the row (one new row) or down the cells (one new grid line). */
export function drawLine(model, { tableId: id, orientation, cellIds, offset, widths: measured }) {
  const table = model.tables.find(t => t.id === id);
  if (!table || !cellIds?.length) throw new Error('Draw the line across a table cell.');
  const placements = ownerPlacements(table).filter(p => cellIds.includes(p.cell.id));
  if (orientation === 'horizontal') {
    // One cell merged across rows divides at the nearest row line instead.
    const single = placements.length === 1 && placements[0].endRow > placements[0].rowIndex;
    if (single) {
      const p = placements[0];
      model.cellBlock = null; model.selectCell(p.cell.id);
      return splitCells(model, { rows: p.endRow - p.rowIndex + 1, columns: 1, widths: measured });
    }
    const rowIndex = Math.min(...placements.map(p => p.endRow));
    if (placements.some(p => p.endRow !== rowIndex || p.rowIndex !== rowIndex)) throw new Error('Draw across cells in one row.');
    const state = M.tableContent(model, table), owners = verticalMerges(table), ids = new Set(cellIds), row = table.rows[rowIndex], before = orphans(table);
    model.checkpoint();
    for (const cell of row.cells) if (!ids.has(cell.id) && owners.get(cell.id).cell === cell && !cell.vMerge) { cell.vMerge = 'restart'; cell.mergeChanged = true; }
    const next = { ...copy(row), id: tableId('row'), headerChanged: true, cells: row.cells.map(source => {
      const cell = newCell(source);
      if (ids.has(source.id)) state.byCell.set(cell.id, [blankFor(state, source, cell)]);
      else { cell.vMerge = 'continue'; cell.mergeChanged = true; }
      return cell;
    }) };
    table.rows.splice(rowIndex + 1, 0, next);
    M.applyTableContent(model, table, state);
    checkStructure(model, table, before, 'The new line would not line up with the merged cells around it.');
    model.selectCell(next.cells.find(c => state.byCell.has(c.id))?.id);
    model.didChange(); return true;
  }
  if (orientation !== 'vertical' || !Number.isFinite(offset)) throw new Error('Draw a horizontal or vertical line.');
  // A vertical line at `offset` twips from the table's left edge.
  const widths = columnWidths(model, table, measured).map(w => Math.max(1, w));
  let at = 0, left = 0;
  while (at < widths.length - 1 && left + widths[at] <= offset) { left += widths[at]; at++; }
  const existing = Math.abs(offset - left) <= 30 ? at : Math.abs(offset - left - widths[at]) <= 30 ? at + 1 : null;
  if (existing === null && (offset - left < MIN_COLUMN_WIDTH || left + widths[at] - offset < MIN_COLUMN_WIDTH)) throw new Error('Draw the line farther from the cell edge.');
  if (existing === null && widths.length >= 32) throw new Error('A table can have up to 32 columns.');
  const state = M.tableContent(model, table), before = orphans(table);
  model.checkpoint();
  let line = existing;
  if (line === null) { splitGridColumn(table, widths, at, offset - left); line = at + 1; table.grid = integerWidths(widths); table.gridChanged = true; }
  const ids = new Set(cellIds), owners = verticalMerges(table);
  for (const row of table.rows) {
    const entry = rowGrid(row).find(c => c.column < line && c.end > line);
    if (!entry || !ids.has(owners.get(entry.cell.id).cell.id)) continue;
    const index = row.cells.indexOf(entry.cell), right = newCell(entry.cell);
    right.span = entry.end - line; right.spanChanged = true;
    entry.cell.span = line - entry.column; entry.cell.spanChanged = true;
    for (const [cell, from] of [[entry.cell, entry.column], [right, line]]) { cell.width = table.layout === 'fixed' ? { type: 'dxa', value: Math.round(spanWidth(widths, from, cell.span)) } : { type: 'auto', value: 0 }; cell.widthChanged = true; }
    if (entry.cell.vMerge) { right.vMerge = entry.cell.vMerge; right.mergeChanged = true; }
    if (entry.cell.vMerge !== 'continue') state.byCell.set(right.id, [blankFor(state, entry.cell, right)]);
    row.cells.splice(index + 1, 0, right);
  }
  M.applyTableContent(model, table, state);
  checkStructure(model, table, before, 'The new line would not line up with the merged cells around it.');
  model.didChange(); return true;
}

/** Eraser: remove the line between two cells, merging them when they line up. */
export function eraseLine(model, { tableId: id, cellIds }) {
  const table = model.tables.find(t => t.id === id);
  if (!table || cellIds?.length !== 2) throw new Error('Erase a line between two cells.');
  const block = blockBetween(table, cellIds[0], cellIds[1]);
  const placements = block && cellBlockPlacements(table, block);
  if (!placements || placements.length !== 2) throw new Error('Only a line between two cells that line up can be erased.');
  model.cellBlock = { tableId: table.id, top: block.top, bottom: block.bottom, left: block.left, right: block.right };
  return mergeBlock(model);
}

/** Delete key on selected cells: each keeps one empty paragraph (with its first paragraph's formatting). */
export function clearCells(model) {
  const block = requireBlock(model), table = block.table, placements = cellBlockPlacements(table, block);
  const state = M.tableContent(model, table);
  const empty = placements.every(({ cell }) => { const content = state.byCell.get(cell.id) || []; return content.length === 1 && !paragraphText(content[0]); });
  if (empty) return false;
  model.checkpoint();
  for (const { cell } of placements) state.byCell.set(cell.id, [blankFor(state, cell, cell)]);
  M.applyTableContent(model, table, state);
  validate(model);
  model.setCellBlock({ tableId: table.id, top: block.top, bottom: block.bottom, left: block.left, right: block.right });
  model.didChange(); return true;
}

/** Move a table (outside other tables) so it stands before the paragraph `beforeId`. */
export function moveTable(model, tableId, beforeId) {
  const table = model.tables.find(t => t.id === tableId);
  if (!table) throw new Error('Choose a table to move.');
  if (table.parentCellId) throw new Error('Tables inside other tables move with their cell.');
  const state = M.tableContent(model, table), target = model.paragraphs.findIndex(p => p.id === beforeId);
  if (target < 0) throw new Error('Drop the table before a paragraph.');
  if (target >= state.start && target <= state.start + state.count) return false;
  if (model.paragraphs[target].cellId) throw new Error('Drop the table between paragraphs outside tables.');
  if (table.floating) throw new Error('Floating tables keep their position. Set Text wrapping to None to move one in the text.');
  model.checkpoint();
  const moved = model.paragraphs.splice(state.start, state.count);
  model.paragraphs.splice(model.paragraphs.findIndex(p => p.id === beforeId), 0, ...moved);
  repairStructuralBookmarks(model.paragraphs, state.bookmarks, model.tables, table.id);
  normalizeBlockBookmarkScopes(model.paragraphs, model.tables);
  model.selectCell(editableCells(table)[0].id);
  model.didChange(); return true;
}
