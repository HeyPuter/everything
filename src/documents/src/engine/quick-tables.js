// Quick Tables: ready-made tables with sample content and a style, inserted at
// the caret in one step. The content is this project's own.
import { tableCells, rowGrid } from './tables.js';
import { paragraphText } from './model.js';
import { applyTableStyle, setTableLook } from './table-styles.js';
import { mergeBlock, setSelectedRowHeight } from './table-editing.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function calendar(date = new Date()) {
  const year = date.getFullYear(), month = date.getMonth(), first = new Date(year, month, 1).getDay(), days = new Date(year, month + 1, 0).getDate();
  const weeks = Math.ceil((first + days) / 7), rows = [[`${MONTHS[month]} ${year}`, '', '', '', '', '', ''], ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']];
  for (let w = 0; w < weeks; w++) rows.push(Array.from({ length: 7 }, (_, d) => { const n = w * 7 + d - first + 1; return n >= 1 && n <= days ? String(n) : ''; }));
  return { rows, style: 'DocsTableGridLightBlue', look: { firstColumn: false }, merge: [[0, 0, 0, 7]], center: true, bodyHeight: 600 };
}

export const QUICK_TABLES = Object.freeze([
  { id: 'calendar', name: 'Calendar', description: 'This month, a week to a row', build: calendar },
  { id: 'tabularList', name: 'Tabular List', description: 'Items and amounts', build: () => ({ style: 'DocsTableListLightGray', rows: [
    ['Item', 'Needed'], ['Notebooks', '12'], ['Pencils', '30'], ['Folders', '8'], ['Sticky notes', '5 packs'], ['Printer paper', '2 reams']] }) },
  { id: 'doubleTable', name: 'Double Table', description: 'Two short lists side by side', build: () => ({ style: 'DocsTablePlainRules', look: { firstColumn: false }, rows: [
    ['Route', 'Stops', '', 'Route', 'Stops'], ['Harbor Loop', '14', '', 'Hill Line', '9'], ['Market Express', '6', '', 'Riverside', '12'], ['Old Town', '11', '', 'Airport Link', '4']] }) },
  { id: 'matrix', name: 'Matrix', description: 'Values where rows and columns meet', build: () => ({ style: 'DocsTableGridLightTeal', rows: [
    ['', 'North', 'South', 'East', 'West'], ['North', '—', '42', '17', '28'], ['South', '42', '—', '31', '19'], ['East', '17', '31', '—', '36'], ['West', '28', '19', '36', '—']] }) },
  { id: 'withSubheads', name: 'With Subheads', description: 'Sections inside one table', build: () => ({ style: 'DocsTableListHeaderGreen', look: { firstColumn: false, noHBand: true }, rows: [
    ['Workshop', 'Hours'], ['Morning', ''], ['Sketching basics', '2'], ['Color studies', '1.5'], ['Afternoon', ''], ['Printmaking', '3'], ['Show and tell', '1']], subheads: [1, 4] }) },
]);

/** Insert a quick table at the caret. `insertTable(rows, columns)` makes the empty table (it knows the writing width). */
export function insertQuickTable(model, id, insertTable, { date } = {}) {
  const template = QUICK_TABLES.find(t => t.id === id);
  if (!template) throw new Error('Choose a quick table.');
  const spec = template.build(date);
  const rows = spec.rows.length, columns = spec.rows[0].length;
  if (!insertTable(rows, columns)) return false;
  const table = model.tableContext.table;
  const cells = tableCells(table);
  cells.forEach((cell, i) => {
    const text = spec.rows[Math.floor(i / columns)][i % columns];
    if (!text) return;
    model.selectCell(cell.id); model.replace(text, { checkpoint: false });
  });
  model.selectCell(cells[0].id);
  applyTableStyle(model, spec.style);
  if (spec.look) setTableLook(model, spec.look);
  if (spec.center) {
    for (const cell of cells) { model.selectCell(cell.id); model.setParagraphFormat({ alignment: 'center' }); }
  }
  for (const r of spec.subheads || []) {
    const row = table.rows[r];
    model.cellBlock = { tableId: table.id, top: r, bottom: r, left: 0, right: columns };
    mergeBlock(model);
    const p = model.paragraphs.find(x => x.cellId === row.cells[0].id);
    const start = model.paragraphOffset(model.paragraphs.indexOf(p));
    model.select(start, start + paragraphText(p).length); model.setRunFormat({ bold: true, italic: true });
  }
  for (const [top, left, bottom, right] of spec.merge || []) {
    model.cellBlock = { tableId: table.id, top, bottom, left, right };
    mergeBlock(model);
    const cell = rowGrid(table.rows[top])[0].cell;
    model.selectCell(cell.id); model.setParagraphFormat({ alignment: 'center' });
  }
  if (spec.bodyHeight) { model.cellBlock = { tableId: table.id, top: 2, bottom: rows - 1, left: 0, right: columns }; setSelectedRowHeight(model, spec.bodyHeight); }
  model.selectCell(tableCells(table)[0].id);
  return true;
}
