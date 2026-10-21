import { describe, it, expect } from 'vitest';
import { Workbook, DEFAULT_ROWS, DEFAULT_COLS, DEFAULT_ROW_HEIGHT, MAX_COLS } from '../src/core/workbook.js';
import { parseCellRef, parseRange } from '../src/core/cell.js';
import { editText } from '../src/core/format.js';

function book(cells = {}) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const at = (a1) => parseCellRef(a1);
  const api = {
    wb, id,
    set: (a1, text) => { const { r, c } = at(a1); wb.setInput(id, r, c, text); },
    cell: (a1) => { const { r, c } = at(a1); return wb.getCell(id, r, c); },
    val: (a1) => { const { r, c } = at(a1); return wb.getValue(id, r, c); },
    show: (a1) => { const { r, c } = at(a1); return wb.getDisplay(id, r, c); },
    f: (a1) => api.cell(a1)?.f ?? null,
  };
  for (const [a1, text] of Object.entries(cells)) api.set(a1, text);
  return api;
}

describe('spilled arrays', () => {
  it('spills a range result into blank neighbours and reads it back', () => {
    const b = book({ A1: '3', A2: '1', A3: '2', C1: '=SORT(A1:A3)' });
    expect(b.val('C1')).toBe(1);
    expect(b.val('C2')).toBe(2);
    expect(b.val('C3')).toBe(3);
    expect(b.cell('C2')).toBeUndefined();
    expect(b.show('C3')).toBe('3');
    expect(b.wb.spillAt(b.id, 1, 2)).toMatchObject({ value: 2, anchor: { r: 0, c: 2 } });
    expect(b.wb.spillAt(b.id, 0, 2)).toBeNull();
    expect(b.wb.spillRangeAt(b.id, 0, 2)).toEqual({ r1: 0, c1: 2, r2: 2, c2: 2 });
    expect(b.wb.usedRange(b.id)).toEqual({ r1: 0, c1: 0, r2: 2, c2: 2 });
    expect(b.wb.spillEntries(b.id)).toEqual([{ r: 1, c: 2, value: 2 }, { r: 2, c: 2, value: 3 }]);
  });

  it('other formulas see spilled values, including through whole-column references', () => {
    const b = book({ A1: '=SEQUENCE(4,1,10,10)', C1: '=SUM(A:A)', C2: '=A3*2', C3: '=COUNTA(A1:A10)' });
    expect(b.val('C1')).toBe(100);
    expect(b.val('C2')).toBe(60);
    expect(b.val('C3')).toBe(4);
  });

  it('shows #SPILL! when something is in the way and recovers when it moves', () => {
    const b = book({ A1: '=SEQUENCE(3)', A3: 'x' });
    expect(b.val('A1')).toEqual({ error: '#SPILL!' });
    expect(b.val('A2')).toBeNull();
    b.set('A3', '');
    expect(b.val('A1')).toBe(1);
    expect(b.val('A3')).toBe(3);
    b.wb.undo();
    expect(b.val('A1')).toEqual({ error: '#SPILL!' });
    // Two arrays cannot share cells: the second one reading order finds blocked.
    b.set('A3', '');
    b.set('B1', '=SEQUENCE(1,2)'); // wants B1:C1
    b.set('C1', '=SEQUENCE(2)'); // C1 is occupied, so B1 is blocked
    expect(b.val('B1')).toEqual({ error: '#SPILL!' });
    expect(b.val('C2')).toBe(2);
  });

  it('spilled cells keep the anchor number format for display and take a spill chain in stride', () => {
    const b = book({ A1: '=SEQUENCE(2,1,0.5,0.25)', C1: '=A1:A2*2' });
    b.wb.applyStyle(b.id, parseRange('A1'), { fmt: 'percent', dec: 0 });
    expect(b.show('A2')).toBe('75%');
    expect(b.val('C2')).toBe(1.5);
    const back = new Workbook(JSON.parse(JSON.stringify(b.wb.toJSON())));
    expect(back.getValue(back.sheets[0].id, 1, 2)).toBe(1.5);
  });

  it('grows the sheet to hold a long spill', () => {
    const b = book({ A1: '=SEQUENCE(150)' });
    expect(b.val('A150')).toBe(150);
    expect(b.wb.sheets[0].rows).toBeGreaterThanOrEqual(150);
  });
});

describe('links', () => {
  it('recognizes HYPERLINK formulas and plain addresses', () => {
    const b = book({ A1: '=HYPERLINK("https://puter.com","Puter")', A2: 'www.example.com', A3: 'me@example.com', A4: 'not a link', A5: '=HYPERLINK("puter.com/docs")' });
    expect(b.wb.linkAt(b.id, 0, 0)).toEqual({ url: 'https://puter.com', label: 'Puter' });
    expect(b.wb.linkAt(b.id, 1, 0)).toEqual({ url: 'https://www.example.com', label: 'www.example.com' });
    expect(b.wb.linkAt(b.id, 2, 0)).toEqual({ url: 'mailto:me@example.com', label: 'me@example.com' });
    expect(b.wb.linkAt(b.id, 3, 0)).toBeNull();
    expect(b.wb.linkAt(b.id, 4, 0)).toEqual({ url: 'https://puter.com/docs', label: 'puter.com/docs' });
    expect(b.show('A1')).toBe('Puter');
  });

  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)'])('does not expose executable hyperlink URLs: %s', (url) => {
    const b = book();
    b.wb.setLink(b.id, 0, 0, url, 'Click me');
    expect(b.val('A1')).toBe('Click me');
    expect(b.wb.linkAt(b.id, 0, 0)).toBeNull();
  });

  it('sets and removes links, keeping the text', () => {
    const b = book({ B2: 'Docs' });
    b.wb.setLink(b.id, 1, 1, 'https://docs.puter.com', 'Docs');
    expect(b.cell('B2')).toMatchObject({ v: 'Docs', f: null, hyperlink: 'https://docs.puter.com' });
    expect(b.show('B2')).toBe('Docs');
    b.wb.setLink(b.id, 2, 1, 'https://puter.com', '');
    expect(b.cell('B3')).toMatchObject({ v: 'https://puter.com', f: null, hyperlink: 'https://puter.com' });
    expect(b.show('B3')).toBe('https://puter.com');
    b.wb.removeLink(b.id, 1, 1);
    expect(b.cell('B2')).toEqual({ v: 'Docs', f: null });
    b.wb.undo();
    expect(b.wb.linkAt(b.id, 1, 1)?.url).toBe('https://docs.puter.com');
  });
});

describe('paste special', () => {
  it('pastes transposed, shifting formulas by their new position', () => {
    const b = book({ A1: '1', B1: '2', C1: '3', A2: '=A1*10', B2: '=B1*10', C2: '=C1*10' });
    const cells = b.wb.copyRange(b.id, parseRange('A1:C2'));
    b.wb.pasteCells(b.id, cells, 4, 0, { r: 0, c: 0 }, null, { transpose: true });
    expect(b.val('A5')).toBe(1);
    expect(b.val('A6')).toBe(2);
    expect(b.val('A7')).toBe(3);
    // References into the copied block follow their cells to their transposed places.
    expect(b.f('B5')).toBe('A5*10');
    expect(b.f('B6')).toBe('A6*10');
    expect(b.f('B7')).toBe('A7*10');
    expect(b.val('B6')).toBe(20);
  });

  it('pastes formatting only, tiling over the target and keeping values', () => {
    const b = book({ A1: 'x', B1: 'y', D1: '5', D2: '6', D3: '7', D4: '8' });
    b.wb.applyStyle(b.id, parseRange('A1'), { bold: true, bg: '#ffff00' });
    b.wb.applyStyle(b.id, parseRange('B1'), { italic: true });
    const cells = b.wb.copyRange(b.id, parseRange('A1:B1'));
    b.wb.pasteStyles(b.id, cells, 0, 3, parseRange('D1:E4'));
    expect(b.cell('D1')).toEqual({ v: 5, f: null, s: { bold: true, bg: '#ffff00' } });
    expect(b.cell('E4')).toEqual({ v: null, f: null, s: { italic: true } });
    expect(b.val('D4')).toBe(8);
    b.wb.undo();
    expect(b.cell('D1')).toEqual({ v: 5, f: null });
  });
});

describe('fonts', () => {
  it('stores a font key as a style and clears it for the default', () => {
    const b = book({ A1: 'x' });
    b.wb.applyStyle(b.id, parseRange('A1:A2'), { font: 'georgia' });
    expect(b.cell('A1')).toEqual({ v: 'x', f: null, s: { font: 'georgia', scheme: 'none' } });
    expect(b.cell('A2')).toEqual({ v: null, f: null, s: { font: 'georgia', scheme: 'none' } });
    b.wb.applyStyle(b.id, parseRange('A1'), { font: null });
    expect(b.cell('A1')).toEqual({ v: 'x', f: null });
  });
});

describe('moving cells', () => {
  it('moves values, keeps formulas pointing where they pointed, and updates references into the block', () => {
    const b = book({ A1: '1', A2: '2', A3: '=A1+A2', C1: '=SUM(A1:A2)', C2: '=A3*2', C3: '=A1:A3' });
    b.wb.setNote(b.id, 0, 0, 'first');
    const dst = b.wb.moveRange(b.id, parseRange('A1:A3'), 0, 4); // → E1:E3
    expect(dst).toEqual({ r1: 0, c1: 4, r2: 2, c2: 4 });
    expect(b.cell('A1')).toBeUndefined();
    expect(b.val('E1')).toBe(1);
    expect(b.f('E3')).toBe('E1+E2'); // its own references moved with it
    expect(b.val('E3')).toBe(3);
    expect(b.f('C1')).toBe('SUM(E1:E2)');
    expect(b.f('C2')).toBe('E3*2');
    expect(b.f('C3')).toBe('E1:E3');
    expect(b.wb.getNote(b.id, 0, 4)).toBe('first');
    expect(b.wb.getNote(b.id, 0, 0)).toBeNull();
    expect(b.wb.undoLabel()).toBe('Move cells');
    b.wb.undo();
    expect(b.val('A3')).toBe(3);
    expect(b.f('C1')).toBe('SUM(A1:A2)');
    expect(b.wb.getNote(b.id, 0, 0)).toBe('first');
  });

  it('leaves references outside the block alone and handles overlap, merges, and other sheets', () => {
    const wb = new Workbook({ sheets: [{ name: 'Main' }, { name: 'Other' }] });
    const [main, other] = wb.sheets;
    wb.setInput(main.id, 0, 0, '10');
    wb.setInput(main.id, 1, 0, '=A1*2');
    wb.setInput(main.id, 2, 0, '=C1');
    wb.setInput(main.id, 0, 2, '5');
    wb.setInput(other.id, 0, 0, '=Main!A1+Main!A2');
    wb.mergeCells(main.id, parseRange('B2:B3'));
    wb.defineName('Top', 'Main!$A$1');
    wb.moveRange(main.id, parseRange('A1:B3'), 1, 0); // down one row, overlapping itself
    expect(wb.getValue(main.id, 1, 0)).toBe(10);
    expect(wb.getCell(main.id, 2, 0).f).toBe('A2*2');
    expect(wb.getCell(main.id, 3, 0).f).toBe('C1'); // C1 was outside the block
    expect(wb.getCell(other.id, 0, 0).f).toBe('Main!A2+Main!A3');
    expect(wb.names[0].ref).toBe('Main!$A$2');
    expect(main.merges).toEqual([{ r1: 2, c1: 1, r2: 3, c2: 1 }]);
    expect(wb.getCell(main.id, 0, 0)).toBeUndefined();
  });
});

describe('type-ahead suggestions', () => {
  it('offers distinct text values from the surrounding block of the column', () => {
    const b = book({ A1: 'Fruit', A2: 'Apple', A3: 'Apricot', A4: 'apple', A5: '12', A7: 'Avocado', B2: 'Apex' });
    expect(b.wb.suggestValues(b.id, 5, 0, 'ap')).toEqual(['apple', 'Apricot']); // nearest first; row 7 is past the gap at row 6
    expect(b.wb.suggestValues(b.id, 5, 0, 'apr')).toEqual(['Apricot']);
    expect(b.wb.suggestValues(b.id, 5, 0, 'Apple')).toEqual([]); // nothing longer than the prefix
    expect(b.wb.suggestValues(b.id, 5, 0, '')).toEqual([]);
    expect(b.wb.suggestValues(b.id, 5, 0, '1')).toEqual([]); // numbers are not suggested
    expect(b.wb.suggestValues(b.id, 0, 0, 'ap')).toEqual(['Apple', 'Apricot']); // looks down as well as up
  });
});

describe('hidden sheets', () => {
  it('hides and shows sheets, never the last visible one, and undoes', () => {
    const wb = new Workbook({ sheets: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] });
    const [a, b, c] = wb.sheets;
    wb.setInput(c.id, 0, 0, '=B!A1+1');
    wb.setInput(b.id, 0, 0, '41');
    wb.setActiveSheet(b.id);
    expect(wb.setSheetHidden(b.id, true)).toBe(true);
    expect(b.hidden).toBe(true);
    expect(wb.visibleSheets.map((s) => s.name)).toEqual(['A', 'C']);
    expect(wb.activeSheetId).toBe(c.id); // the next visible sheet takes over
    expect(wb.getValue(c.id, 0, 0)).toBe(42); // formulas still see it
    expect(wb.setSheetHidden(a.id, true)).toBe(true);
    expect(wb.setSheetHidden(c.id, true)).toBe(false); // last one standing
    wb.setActiveSheet(a.id); // activating a hidden sheet shows it
    expect(a.hidden).toBe(false);
    expect(wb.activeSheetId).toBe(a.id);
    wb.undo();
    expect(wb.sheet(a.id).hidden).toBe(true);
    wb.undo();
    wb.undo();
    expect(wb.sheet(b.id).hidden).toBe(false);
    const copy = new Workbook(JSON.parse(JSON.stringify(wb.toJSON())));
    expect(copy.sheets.map((s) => s.hidden)).toEqual([false, false, false]);
    wb.setSheetHidden(b.id, true);
    const again = new Workbook(JSON.parse(JSON.stringify(wb.toJSON())));
    expect(again.sheets[1].hidden).toBe(true);
    expect(again.deleteSheet(again.sheets[0].id)).toBe(true);
    expect(again.deleteSheet(again.sheets[1].id)).toBe(false); // C is the only visible sheet left
  });
});

describe('reordering rows and columns', () => {
  it('moves rows down and up with everything on them, renumbering references', () => {
    const b = book({ A1: 'a', A2: 'b', A3: 'c', A4: 'd', C1: '=A1&A3', C5: '=SUM(A1:A2)' });
    b.wb.setRowHeight(b.id, 0, 40);
    b.wb.setNote(b.id, 0, 0, 'first');
    b.wb.setHidden(b.id, 'row', [1], true);
    expect(b.wb.moveRows(b.id, 0, 2, 4)).toBe(2); // rows 1-2 go after row 4
    expect(['A1', 'A2', 'A3', 'A4'].map(b.val)).toEqual(['c', 'd', 'a', 'b']);
    expect(b.wb.rowHeight(b.id, 2)).toBe(40);
    expect(b.wb.rowHeight(b.id, 0)).toBe(DEFAULT_ROW_HEIGHT);
    expect(b.wb.getNote(b.id, 2, 0)).toBe('first');
    expect(b.wb.isHidden(b.id, 'row', 3)).toBe(true);
    expect(b.wb.isHidden(b.id, 'row', 1)).toBe(false);
    expect(b.f('C3')).toBe('A3&A1'); // the formula moved with row 1 and still reads a and c
    expect(b.val('C3')).toBe('ac');
    expect(b.f('C5')).toBe('SUM(A3:A4)');
    expect(b.val('C5')).toBe(0);
    expect(b.wb.undoLabel()).toBe('Move rows');
    b.wb.undo();
    expect(['A1', 'A2', 'A3', 'A4'].map(b.val)).toEqual(['a', 'b', 'c', 'd']);
    expect(b.f('C1')).toBe('A1&A3');
    expect(b.wb.moveRows(b.id, 2, 1, 0)).toBe(0); // row 3 to the top
    expect(['A1', 'A2', 'A3', 'A4'].map(b.val)).toEqual(['c', 'a', 'b', 'd']);
    expect(b.f('C2')).toBe('A2&A1');
    expect(b.wb.moveRows(b.id, 1, 2, 2)).toBeNull(); // dropping inside itself does nothing
  });

  it('moves columns with widths, merges, charts, and other-sheet references', () => {
    const wb = new Workbook({ sheets: [{ name: 'Main' }, { name: 'Other' }] });
    const [main, other] = wb.sheets;
    wb.setInput(main.id, 0, 0, 'x');
    wb.setInput(main.id, 0, 1, 'y');
    wb.setInput(main.id, 0, 2, 'z');
    wb.setInput(other.id, 0, 0, '=Main!B1');
    wb.setColWidth(main.id, 1, 200);
    wb.mergeCells(main.id, parseRange('B2:B3'));
    wb.mergeCells(main.id, parseRange('A5:C5')); // spans the whole move: unchanged
    // A merge the move would tear apart (B7:C7, say) refuses the move instead; see move-merges-refused.
    wb.defineName('Ys', 'Main!$B$1:$B$9');
    wb.addChart(main.id, { type: 'column', range: parseRange('B1:B3'), anchor: { r: 0, c: 2 }, w: 200, h: 100 });
    expect(wb.moveCols(main.id, 1, 1, 0)).toBe(0); // column B before A
    expect([0, 1, 2].map((c) => wb.getValue(main.id, 0, c))).toEqual(['y', 'x', 'z']);
    expect(wb.colWidth(main.id, 0)).toBe(200);
    expect(wb.getCell(other.id, 0, 0).f).toBe('Main!A1');
    expect(main.merges).toEqual([{ r1: 1, c1: 0, r2: 2, c2: 0 }, { r1: 4, c1: 0, r2: 4, c2: 2 }]);
    expect(wb.names[0].ref).toBe('Main!$A$1:$A$9');
    expect(main.charts[0].range).toEqual({ r1: 0, c1: 0, r2: 2, c2: 0 });
    expect(main.charts[0].anchor).toEqual({ r: 0, c: 2 });
  });
});

describe('filter by condition', () => {
  it('keeps the rows that meet a comparison', () => {
    const b = book({ A1: 'Item', B1: 'Qty', A2: 'Apple', B2: '5', A3: 'Banana', B3: '12', A4: 'Cherry', B4: '', A5: 'apricot', B5: '7' });
    b.wb.setFilterRange(b.id, parseRange('A1:B5'));
    const hidden = () => [...b.wb.sheet(b.id).filterHidden].sort();
    b.wb.setFilterCriteria(b.id, 1, { op: 'gt', value: 6 });
    expect(hidden()).toEqual([1, 3]);
    b.wb.setFilterCriteria(b.id, 1, { op: 'between', value: 5, value2: 7 });
    expect(hidden()).toEqual([2, 3]);
    b.wb.setFilterCriteria(b.id, 1, { op: 'empty' });
    expect(hidden()).toEqual([1, 2, 4]);
    b.wb.setFilterCriteria(b.id, 1, null);
    b.wb.setFilterCriteria(b.id, 0, { op: 'beginsWith', value: 'ap' });
    expect(hidden()).toEqual([2, 3]);
    b.wb.setFilterCriteria(b.id, 0, { op: 'notContains', value: 'an' });
    expect(hidden()).toEqual([2]);
    b.wb.undo();
    expect(hidden()).toEqual([2, 3]);
    const copy = new Workbook(JSON.parse(JSON.stringify(b.wb.toJSON())));
    expect([...copy.sheets[0].filterHidden].sort()).toEqual([2, 3]);
  });
});

describe('cells', () => {
  it('starts blank with a default grid', () => {
    const wb = new Workbook();
    expect(wb.sheets).toHaveLength(1);
    expect(wb.sheets[0].name).toBe('Sheet1');
    expect(wb.sheets[0].rows).toBe(DEFAULT_ROWS);
    expect(wb.sheets[0].cols).toBe(DEFAULT_COLS);
    expect(wb.dirty).toBe(false);
  });

  it('stores typed input with inferred types and formats', () => {
    const b = book({ A1: '12%', A2: 'hi', A3: '=1+1', A4: '2024-01-15' });
    expect(b.cell('A1')).toEqual({ v: 0.12, f: null, s: { fmt: 'percent', dec: 0 } });
    expect(b.cell('A2')).toEqual({ v: 'hi', f: null });
    expect(b.cell('A3')).toEqual({ v: null, f: '1+1' });
    expect(b.show('A3')).toBe('2');
    expect(b.show('A4')).toBe('2024-01-15');
    expect(b.wb.dirty).toBe(true);
  });

  it('keeps an existing format when retyping a number', () => {
    const b = book({ A1: '12%' });
    b.set('A1', '0.5');
    expect(b.show('A1')).toBe('50%');
  });

  it('clears a cell with empty input and drops empty cells from the map', () => {
    const b = book({ A1: '5' });
    b.set('A1', '');
    expect(b.cell('A1')).toBeUndefined();
    expect(b.wb.sheets[0].cells.size).toBe(0);
  });

  it('grows the grid when writing past the edge', () => {
    const b = book();
    b.wb.setCells(b.id, [{ r: 150, c: 30, cell: { v: 1 } }]);
    expect(b.wb.sheets[0].rows).toBe(151);
    expect(b.wb.sheets[0].cols).toBe(31);
  });

  it('reports the used range', () => {
    const b = book({ B2: '1', D5: '=1' });
    expect(b.wb.usedRange(b.id)).toEqual({ r1: 0, c1: 0, r2: 4, c2: 3 });
    expect(new Workbook().usedRange(new Workbook().sheets[0].id)).toBeNull();
  });
});

describe('styles', () => {
  it('applies, merges, and removes style fields over a range', () => {
    const b = book({ A1: '1' });
    b.wb.applyStyle(b.id, parseRange('A1:B2'), { bold: true, fmt: 'number', dec: 1 });
    expect(b.cell('A1').s).toEqual({ bold: true, fmt: 'number', dec: 1 });
    expect(b.cell('B2')).toEqual({ v: null, f: null, s: { bold: true, fmt: 'number', dec: 1 } });
    b.wb.applyStyle(b.id, parseRange('A1'), { bold: null, italic: true });
    expect(b.cell('A1').s).toEqual({ fmt: 'number', dec: 1, italic: true });
    expect(b.show('A1')).toBe('1.0');
  });

  it('toggles based on the active cell', () => {
    const b = book({ A1: '1', A2: '2' });
    b.wb.applyStyle(b.id, parseRange('A2'), { bold: true });
    b.wb.toggleStyle(b.id, parseRange('A1:A2'), 'bold', { r: 0, c: 0 });
    expect(b.cell('A1').s.bold).toBe(true);
    expect(b.cell('A2').s.bold).toBe(true);
    b.wb.toggleStyle(b.id, parseRange('A1:A2'), 'bold', { r: 0, c: 0 });
    expect(b.cell('A1').s).toBeUndefined();
    expect(b.cell('A2').s).toBeUndefined();
  });

  it('clears contents while keeping styles, and vice versa', () => {
    const b = book({ A1: '1' });
    b.wb.applyStyle(b.id, parseRange('A1'), { bold: true });
    b.wb.clearRange(b.id, parseRange('A1'), { contents: true });
    expect(b.cell('A1')).toEqual({ v: null, f: null, s: { bold: true } });
    b.set('A1', '3');
    b.wb.clearRange(b.id, parseRange('A1'), { contents: false, styles: true });
    expect(b.cell('A1')).toEqual({ v: 3, f: null });
  });
});

describe('undo / redo', () => {
  it('reverts and reapplies cell edits', () => {
    const b = book({ A1: '1' });
    b.set('A1', '2');
    expect(b.wb.canUndo()).toBe(true);
    b.wb.undo();
    expect(b.val('A1')).toBe(1);
    b.wb.undo();
    expect(b.cell('A1')).toBeUndefined();
    expect(b.wb.canUndo()).toBe(false);
    b.wb.redo();
    b.wb.redo();
    expect(b.val('A1')).toBe(2);
    expect(b.wb.canRedo()).toBe(false);
  });

  it('a new edit discards the redo stack', () => {
    const b = book({ A1: '1' });
    b.wb.undo();
    b.set('A1', '9');
    expect(b.wb.canRedo()).toBe(false);
  });

  it('treats a batch as one step and skips no-op edits', () => {
    const b = book();
    b.wb.setCells(b.id, [{ r: 0, c: 0, cell: { v: 1 } }, { r: 1, c: 0, cell: { v: 2 } }]);
    b.wb.setCells(b.id, [{ r: 0, c: 0, cell: { v: 1 } }]); // unchanged
    expect(b.wb._history).toHaveLength(1);
    b.wb.undo();
    expect(b.wb.sheets[0].cells.size).toBe(0);
  });

  it('reverts structural edits including formulas on other sheets', () => {
    const wb = new Workbook({ sheets: [{ name: 'A' }, { name: 'B' }] });
    const [a, bSheet] = wb.sheets;
    wb.setInput(a.id, 4, 0, '10');
    wb.setInput(bSheet.id, 0, 0, '=A!A5');
    wb.insertRows(a.id, 0, 2);
    expect(wb.getCell(bSheet.id, 0, 0).f).toBe('A!A7');
    expect(wb.getValue(bSheet.id, 0, 0)).toBe(10);
    wb.undo();
    expect(wb.getCell(bSheet.id, 0, 0).f).toBe('A!A5');
    expect(wb.getValue(bSheet.id, 0, 0)).toBe(10);
    wb.redo();
    expect(wb.getCell(bSheet.id, 0, 0).f).toBe('A!A7');
  });
});

describe('rows and columns', () => {
  it('inserts rows, shifting cells and formulas', () => {
    const b = book({ A1: '1', A2: '2', A3: '=SUM(A1:A2)', B5: '=A2*2' });
    b.wb.insertRows(b.id, 1, 1);
    expect(b.val('A1')).toBe(1);
    expect(b.cell('A2')).toBeUndefined();
    expect(b.val('A3')).toBe(2);
    expect(b.f('A4')).toBe('SUM(A1:A3)');
    expect(b.val('A4')).toBe(3);
    expect(b.f('B6')).toBe('A3*2');
    expect(b.wb.sheets[0].rows).toBe(DEFAULT_ROWS + 1);
  });

  it('deletes rows, dropping cells and marking dangling refs', () => {
    const b = book({ A1: '1', A2: '2', A3: '3', A4: '=SUM(A1:A3)', B1: '=A2' });
    b.wb.deleteRows(b.id, 1, 1);
    expect(b.val('A2')).toBe(3);
    expect(b.f('A3')).toBe('SUM(A1:A2)');
    expect(b.val('A3')).toBe(4);
    expect(b.f('B1')).toBe('#REF!');
    expect(b.val('B1')).toEqual({ error: '#REF!' });
  });

  it('inserts and deletes columns with widths following', () => {
    const b = book({ A1: '1', B1: '2', C1: '=A1+B1' });
    b.wb.setColWidth(b.id, 1, 200);
    b.wb.insertCols(b.id, 1, 2);
    expect(b.val('D1')).toBe(2);
    expect(b.f('E1')).toBe('A1+D1');
    expect(b.wb.colWidth(b.id, 3)).toBe(200);
    expect(b.wb.colWidth(b.id, 1)).toBe(100);
    b.wb.deleteCols(b.id, 0, 1);
    expect(b.f('D1')).toBe('#REF!+C1');
    expect(b.wb.colWidth(b.id, 2)).toBe(200);
  });

  it('leaves a blank sheet of the default size when every row is deleted', () => {
    const b = book({ A1: '1' });
    b.wb.deleteRows(b.id, 0, 10000);
    expect(b.wb.sheets[0].rows).toBe(100);
    expect(b.wb.getValue(b.id, 0, 0)).toBe(null);
  });

  it('records column and row size changes as undoable', () => {
    const b = book();
    b.wb.setColWidth(b.id, 0, 150);
    b.wb.setRowHeight(b.id, 0, 40);
    expect(b.wb.colWidth(b.id, 0)).toBe(150);
    expect(b.wb.rowHeight(b.id, 0)).toBe(40);
    b.wb.undo();
    b.wb.undo();
    expect(b.wb.colWidth(b.id, 0)).toBe(100);
    expect(b.wb.rowHeight(b.id, 0)).toBe(DEFAULT_ROW_HEIGHT);
  });

  it('clamps sizes to sane bounds', () => {
    const b = book();
    b.wb.setColWidth(b.id, 0, 2);
    expect(b.wb.colWidth(b.id, 0)).toBe(24);
    b.wb.setColWidth(b.id, 0, 5000);
    expect(b.wb.colWidth(b.id, 0)).toBe(800);
  });
});

describe('copy, paste, fill, sort', () => {
  it('pastes with relative refs shifted', () => {
    const b = book({ A1: '1', A2: '2', B1: '=A1*10', B2: '=A2*10' });
    const cells = b.wb.copyRange(b.id, parseRange('B1:B2'));
    b.wb.pasteCells(b.id, cells, 0, 3, { r: 0, c: 1 });
    expect(b.f('D1')).toBe('C1*10');
    expect(b.f('D2')).toBe('C2*10');
  });

  it('tiles a small clipboard over a larger selection', () => {
    const b = book({ A1: 'x' });
    const cells = b.wb.copyRange(b.id, parseRange('A1'));
    b.wb.pasteCells(b.id, cells, 0, 2, { r: 0, c: 0 }, parseRange('C1:C4'));
    expect(['C1', 'C2', 'C3', 'C4'].map(b.val)).toEqual(['x', 'x', 'x', 'x']);
  });

  it('pastes text with type inference', () => {
    const b = book();
    b.wb.pasteValues(b.id, [['1', 'a'], ['=1+1', '50%']], 0, 0);
    expect(b.val('A1')).toBe(1);
    expect(b.val('B1')).toBe('a');
    expect(b.val('A2')).toBe(2);
    expect(b.show('B2')).toBe('50%');
  });

  it('fills series, repeats values, and shifts formulas', () => {
    const b = book({ A1: '1', A2: '2', B1: 'Item 1', C1: '=A1*2', D1: 'x' });
    b.wb.fill(b.id, parseRange('A1:A2'), parseRange('A1:A5'));
    expect(['A3', 'A4', 'A5'].map(b.val)).toEqual([3, 4, 5]);
    b.wb.fill(b.id, parseRange('B1'), parseRange('B1:B3'));
    expect(['B2', 'B3'].map(b.val)).toEqual(['Item 2', 'Item 3']);
    b.wb.fill(b.id, parseRange('C1'), parseRange('C1:C3'));
    expect(b.f('C3')).toBe('A3*2');
    b.wb.fill(b.id, parseRange('D1'), parseRange('D1:D2'));
    expect(b.val('D2')).toBe('x');
    // Filling upward from a series continues it backwards.
    b.wb.fill(b.id, parseRange('A4:A5'), parseRange('A3:A5'));
    expect(b.val('A3')).toBe(3);
  });

  it('fills sideways too', () => {
    const b = book({ A1: '10', B1: '20' });
    b.wb.fill(b.id, parseRange('A1:B1'), parseRange('A1:D1'));
    expect(['C1', 'D1'].map(b.val)).toEqual([30, 40]);
  });

  it('sorts a range by a column, keeping rows intact and empties last', () => {
    const b = book({ A1: 'b', B1: '2', A2: 'c', B2: '3', A3: 'a', B3: '1', A4: '', B4: '' });
    b.wb.sortRange(b.id, parseRange('A1:B4'), 0, true);
    expect(['A1', 'A2', 'A3'].map(b.val)).toEqual(['a', 'b', 'c']);
    expect(['B1', 'B2', 'B3'].map(b.val)).toEqual([1, 2, 3]);
    b.wb.sortRange(b.id, parseRange('A1:B4'), 1, false);
    expect(['A1', 'A2', 'A3'].map(b.val)).toEqual(['c', 'b', 'a']);
  });
});

describe('sheets', () => {
  it('adds, renames, moves, duplicates, and deletes', () => {
    const wb = new Workbook();
    const s2 = wb.addSheet();
    expect(s2.name).toBe('Sheet2');
    expect(wb.activeSheetId).toBe(s2.id);
    expect(wb.renameSheet(s2.id, 'Data')).toBe(true);
    expect(wb.renameSheet(s2.id, 'Sheet1')).toBe(false);
    expect(wb.renameSheet(s2.id, 'bad:name')).toBe(false);
    expect(wb.validateSheetName('')).toMatch(/empty/);
    wb.setInput(wb.sheets[0].id, 0, 0, '=Data!A1');
    wb.setInput(s2.id, 0, 0, '7');
    expect(wb.getValue(wb.sheets[0].id, 0, 0)).toBe(7);
    wb.renameSheet(s2.id, 'Q1 Data');
    expect(wb.getCell(wb.sheets[0].id, 0, 0).f).toBe("'Q1 Data'!A1");
    wb.moveSheet(s2.id, 0);
    expect(wb.sheets[0].id).toBe(s2.id);
    const copy = wb.duplicateSheet(s2.id);
    expect(copy.name).toBe('Q1 Data (2)');
    expect(wb.getValue(copy.id, 0, 0)).toBe(7);
    expect(wb.deleteSheet(copy.id)).toBe(true);
    expect(wb.sheets).toHaveLength(2);
    wb.deleteSheet(s2.id);
    expect(wb.deleteSheet(wb.sheets[0].id)).toBe(false);
  });

  it('serializes to JSON and back', () => {
    const b = book({ A1: '1', B1: '=A1+1' });
    b.wb.applyStyle(b.id, parseRange('A1'), { bold: true });
    b.wb.setColWidth(b.id, 0, 140);
    const json = JSON.parse(JSON.stringify(b.wb.toJSON()));
    const copy = new Workbook(json);
    expect(copy.getValue(copy.sheets[0].id, 0, 1)).toBe(2);
    expect(copy.getCell(copy.sheets[0].id, 0, 0).s).toEqual({ bold: true });
    expect(copy.colWidth(copy.sheets[0].id, 0)).toBe(140);
    expect(copy.dirty).toBe(false);
  });
});

describe('events', () => {
  it('emits change events with a type', () => {
    const wb = new Workbook();
    const seen = [];
    wb.addEventListener('change', (e) => seen.push(e.detail.type));
    wb.setInput(wb.sheets[0].id, 0, 0, '1');
    wb.addSheet();
    wb.undo();
    expect(seen).toContain('cells');
    expect(seen).toContain('structure');
    expect(seen).toContain('history');
  });
});

describe('fill shortcuts and name series', () => {
  it('continues month, weekday, and quarter names with their casing', () => {
    const b = book({ A1: 'Jan', B1: 'MONDAY', C1: 'q3', D1: 'Nov', D2: 'Dec' });
    b.wb.fill(b.id, parseRange('A1'), parseRange('A1:A4'));
    expect(['A2', 'A3', 'A4'].map(b.val)).toEqual(['Feb', 'Mar', 'Apr']);
    b.wb.fill(b.id, parseRange('B1'), parseRange('B1:B3'));
    expect(['B2', 'B3'].map(b.val)).toEqual(['TUESDAY', 'WEDNESDAY']);
    b.wb.fill(b.id, parseRange('C1'), parseRange('C1:C3'));
    expect(['C2', 'C3'].map(b.val)).toEqual(['q4', 'q1']);
    b.wb.fill(b.id, parseRange('D1:D2'), parseRange('D1:D4'));
    expect(['D3', 'D4'].map(b.val)).toEqual(['Jan', 'Feb']);
  });

  it('steps by the gap between two names and fills upward', () => {
    const b = book({ A3: 'Mon', A4: 'Wed' });
    b.wb.fill(b.id, parseRange('A3:A4'), parseRange('A1:A6'));
    expect(['A1', 'A2', 'A5', 'A6'].map(b.val)).toEqual(['Thu', 'Sat', 'Fri', 'Sun']);
  });

  it('leaves ordinary words alone', () => {
    const b = book({ A1: 'Apple' });
    b.wb.fill(b.id, parseRange('A1'), parseRange('A1:A3'));
    expect(['A2', 'A3'].map(b.val)).toEqual(['Apple', 'Apple']);
  });

  it('fill down and right copy without incrementing, shifting formulas', () => {
    const b = book({ A1: 'Item 1', B1: '=A1&"!"', A2: '5', A3: '7' });
    b.wb.fillDirection(b.id, parseRange('A1:B3'), 'down');
    expect(['A2', 'A3'].map(b.val)).toEqual(['Item 1', 'Item 1']);
    expect(b.f('B3')).toBe('A3&"!"');
    b.wb.fillDirection(b.id, parseRange('B4'), 'down'); // single cell takes the one above
    expect(b.f('B4')).toBe('A4&"!"');
    b.wb.fillDirection(b.id, parseRange('A1:C1'), 'right');
    expect(b.val('C1')).toBe('Item 1');
    b.wb.fillDirection(b.id, parseRange('A1'), 'down'); // nothing above: no-op
    expect(b.val('A1')).toBe('Item 1');
  });

  it('fills one input into a whole selection with relative formulas', () => {
    const b = book({ A1: '1', A2: '2', A3: '3' });
    b.wb.fillInput(b.id, parseRange('B1:B3'), '=A1*10', { r: 0, c: 1 });
    expect(['B1', 'B2', 'B3'].map(b.val)).toEqual([10, 20, 30]);
    expect(b.f('B3')).toBe('A3*10');
    expect(b.wb._history).toHaveLength(4);
  });

  it('finds how far a double-click fill should go', () => {
    const b = book({ A1: 'x', A2: 'x', A3: 'x', A4: 'x', B1: '=A1' });
    expect(b.wb.autoFillTarget(b.id, parseRange('B1'))).toEqual({ r1: 0, c1: 1, r2: 3, c2: 1 });
    expect(b.wb.autoFillTarget(b.id, parseRange('B1:B4'))).toBeNull();
    expect(b.wb.autoFillTarget(b.id, parseRange('D1'))).toBeNull();
    // Column A looks to its right neighbour.
    b.set('B2', '1'); b.set('B3', '1');
    expect(b.wb.autoFillTarget(b.id, parseRange('A5'))).toBeNull();
    expect(b.wb.autoFillTarget(b.id, parseRange('A1'))).toEqual({ r1: 0, c1: 0, r2: 2, c2: 0 });
  });
});

describe('borders', () => {
  it('sets per-side flags for each kind', () => {
    const b = book({ B2: 'x' });
    const range = parseRange('B2:C3');
    b.wb.applyBorders(b.id, range, 'outer');
    expect(b.cell('B2').s).toEqual({ bt: true, bl: true });
    expect(b.cell('C3').s).toEqual({ bb: true, br: true });
    expect(b.cell('C2').s).toEqual({ bt: true, br: true });
    b.wb.applyBorders(b.id, range, 'all');
    expect(b.cell('C2').s).toEqual({ bt: true, bb: true, bl: true, br: true });
    b.wb.applyBorders(b.id, range, 'none');
    expect(b.cell('B2').s).toBeUndefined();
    expect(b.cell('C3')).toBeUndefined();
    b.wb.applyBorders(b.id, range, 'bottom');
    expect(b.cell('B3').s).toEqual({ bb: true });
    expect(b.cell('B2')).toEqual({ v: 'x', f: null });
    b.wb.applyBorders(b.id, parseRange('B2'), 'left');
    b.wb.applyBorders(b.id, parseRange('B2'), 'right');
    b.wb.applyBorders(b.id, parseRange('B2'), 'top');
    expect(b.cell('B2').s).toEqual({ bl: true, br: true, bt: true });
  });

  it('draws inner, horizontal, and vertical borders', () => {
    const b = book();
    const range = parseRange('B2:D4');
    b.wb.applyBorders(b.id, range, 'inner');
    expect(b.cell('B2').s).toEqual({ bb: true, br: true });
    expect(b.cell('C3').s).toEqual({ bt: true, bb: true, bl: true, br: true });
    expect(b.cell('D4').s).toEqual({ bt: true, bl: true });
    b.wb.applyBorders(b.id, range, 'none');
    b.wb.applyBorders(b.id, range, 'horizontal');
    expect(b.cell('C3').s).toEqual({ bt: true, bb: true });
    expect(b.cell('C2').s).toEqual({ bb: true });
    b.wb.applyBorders(b.id, range, 'none');
    b.wb.applyBorders(b.id, range, 'vertical');
    expect(b.cell('C3').s).toEqual({ bl: true, br: true });
    expect(b.cell('B3').s).toEqual({ br: true });
  });

  it('carries a color and style, restyles existing borders, and drops them with the sides', () => {
    const b = book({ B2: 'x' });
    const range = parseRange('B2:C3');
    b.wb.applyBorders(b.id, range, 'outer', { color: '#c22a2a', style: 'thick' });
    expect(b.cell('B2').s).toEqual({ bt: true, bl: true, bc: '#c22a2a', bs: 'thick' });
    // Thin is the default and is not stored; a default color clears bc.
    b.wb.applyBorders(b.id, range, 'restyle', { color: null, style: 'thin' });
    expect(b.cell('B2').s).toEqual({ bt: true, bl: true });
    b.wb.applyBorders(b.id, range, 'restyle', { color: '#0a63f0', style: 'dashed' });
    expect(b.cell('C3').s).toEqual({ bb: true, br: true, bc: '#0a63f0', bs: 'dashed' });
    // Restyling never adds a border to a cell without one.
    b.wb.applyBorders(b.id, parseRange('E5'), 'restyle', { color: '#0a63f0', style: 'dashed' });
    expect(b.cell('E5')).toBeUndefined();
    // Adding a side with undefined pen keeps the color; a pen repaints the whole cell.
    b.wb.applyBorders(b.id, parseRange('B2'), 'bottom');
    expect(b.cell('B2').s).toEqual({ bt: true, bl: true, bb: true, bc: '#0a63f0', bs: 'dashed' });
    b.wb.applyBorders(b.id, parseRange('B2'), 'right', { color: null, style: 'medium' });
    expect(b.cell('B2').s).toEqual({ bt: true, bl: true, bb: true, br: true, bs: 'medium' });
    b.wb.applyBorders(b.id, range, 'none');
    expect(b.cell('B2')).toEqual({ v: 'x', f: null });
    expect(b.cell('C3')).toBeUndefined();
    b.wb.undo();
    expect(b.cell('C3').s).toEqual({ bb: true, br: true, bc: '#0a63f0', bs: 'dashed' });
  });

  it('keeps other styling and is one undo step', () => {
    const b = book({ A1: '1' });
    b.wb.applyStyle(b.id, parseRange('A1'), { bold: true });
    b.wb.applyBorders(b.id, parseRange('A1:B2'), 'all');
    expect(b.cell('A1').s).toEqual({ bold: true, bt: true, bb: true, bl: true, br: true });
    b.wb.undo();
    expect(b.cell('A1').s).toEqual({ bold: true });
    expect(b.cell('B2')).toBeUndefined();
  });
});

describe('frozen panes', () => {
  it('stores, clamps, undoes, and serializes the frozen counts', () => {
    const b = book({ A1: 'h' });
    expect(b.wb.sheets[0].frozenRows).toBe(0);
    b.wb.setFrozen(b.id, 1, 2);
    expect(b.wb.sheets[0]).toMatchObject({ frozenRows: 1, frozenCols: 2 });
    b.wb.setFrozen(b.id, 999, -3);
    expect(b.wb.sheets[0]).toMatchObject({ frozenRows: 50, frozenCols: 0 });
    b.wb.undo();
    expect(b.wb.sheets[0]).toMatchObject({ frozenRows: 1, frozenCols: 2 });
    b.wb.setFrozen(b.id, 1, 2); // no-op adds no history
    const n = b.wb._history.length;
    b.wb.setFrozen(b.id, 1, 2);
    expect(b.wb._history).toHaveLength(n);
    const copy = new Workbook(JSON.parse(JSON.stringify(b.wb.toJSON())));
    expect(copy.sheets[0]).toMatchObject({ frozenRows: 1, frozenCols: 2 });
  });
});

describe('hidden rows and columns', () => {
  it('hides, shows, undoes, and reports sizes as zero', () => {
    const b = book({ B1: 'x' });
    b.wb.setHidden(b.id, 'col', [1, 2], true);
    expect(b.wb.colWidth(b.id, 1)).toBe(0);
    expect(b.wb.isHidden(b.id, 'col', 2)).toBe(true);
    expect(b.wb.hiddenWithin(b.id, 'col', 0, 5)).toEqual([1, 2]);
    expect(b.val('B1')).toBe('x'); // content stays
    b.wb.setHidden(b.id, 'row', [3], true);
    expect(b.wb.rowHeight(b.id, 3)).toBe(0);
    b.wb.undo();
    expect(b.wb.rowHeight(b.id, 3)).toBe(DEFAULT_ROW_HEIGHT);
    b.wb.setHidden(b.id, 'col', [1], false);
    expect(b.wb.colWidth(b.id, 1)).toBe(100);
    expect(b.wb.hiddenWithin(b.id, 'col', 0, 5)).toEqual([2]);
    const json = JSON.parse(JSON.stringify(b.wb.toJSON()));
    expect(json.sheets[0].hiddenCols).toEqual([2]);
    expect(new Workbook(json).isHidden(new Workbook(json).sheets[0].id, 'col', 2)).toBe(true);
  });

  it('refuses to hide everything and ignores no-ops', () => {
    const b = book();
    const all = Array.from({ length: MAX_COLS }, (_, i) => i); // every column of the grid
    b.wb.setHidden(b.id, 'col', all, true);
    expect(b.wb.sheets[0].hiddenCols.size).toBe(0);
    b.wb.setHidden(b.id, 'col', [0], false);
    expect(b.wb._history).toHaveLength(0);
  });

  it('keeps hidden lines attached to their content through inserts and deletes', () => {
    const b = book({ C1: 'c' });
    b.wb.setHidden(b.id, 'col', [2], true);
    b.wb.insertCols(b.id, 0, 1);
    expect(b.wb.isHidden(b.id, 'col', 3)).toBe(true);
    expect(b.wb.isHidden(b.id, 'col', 2)).toBe(false);
    b.wb.deleteCols(b.id, 0, 2);
    expect(b.wb.isHidden(b.id, 'col', 1)).toBe(true);
    b.wb.deleteCols(b.id, 1, 1);
    expect(b.wb.sheets[0].hiddenCols.size).toBe(0);
  });
});

describe('transactions', () => {
  it('groups several edits into one undo step', () => {
    const b = book();
    b.wb.transaction('Big change', () => {
      b.set('A1', '1');
      b.set('A2', '2');
      b.wb.setRowHeight(b.id, 0, 40);
      b.wb.transaction('nested', () => b.set('A3', '3'));
    });
    expect(b.wb._history).toHaveLength(1);
    expect(b.wb.undoLabel()).toBe('Big change');
    b.wb.undo();
    expect(b.cell('A1')).toBeUndefined();
    expect(b.cell('A3')).toBeUndefined();
    expect(b.wb.rowHeight(b.id, 0)).toBe(DEFAULT_ROW_HEIGHT);
    b.wb.redo();
    expect(b.val('A3')).toBe(3);
    expect(b.wb.rowHeight(b.id, 0)).toBe(40);
  });

  it('collapses a single-entry transaction and drops empty ones', () => {
    const b = book();
    b.wb.transaction('One', () => b.set('A1', '1'));
    expect(b.wb.undoLabel()).toBe('Edit cell');
    b.wb.transaction('Nothing', () => {});
    expect(b.wb._history).toHaveLength(1);
  });

  it('stores font size and vertical alignment as styles', () => {
    const b = book({ A1: 'x' });
    b.wb.applyStyle(b.id, parseRange('A1'), { size: 20, valign: 'top' });
    expect(b.cell('A1').s).toEqual({ size: 20, valign: 'top' });
  });
});

describe('merged cells', () => {
  it('merges keeping the top-left value, unmerges, and undoes as one step', () => {
    const b = book({ A1: 'Title', B1: 'gone', A2: 'also gone' });
    b.wb.applyStyle(b.id, parseRange('B1'), { bold: true });
    b.wb.mergeCells(b.id, parseRange('A1:B2'));
    expect(b.wb.sheets[0].merges).toEqual([{ r1: 0, c1: 0, r2: 1, c2: 1 }]);
    expect(b.val('A1')).toBe('Title');
    expect(b.cell('B1')).toEqual({ v: null, f: null, s: { bold: true } });
    expect(b.cell('A2')).toBeUndefined();
    expect(b.wb.mergeAt(b.id, 1, 1)).toEqual({ r1: 0, c1: 0, r2: 1, c2: 1 });
    expect(b.wb.mergeAt(b.id, 2, 2)).toBeNull();
    expect(b.wb.expandToMerges(b.id, parseRange('B2:C3'))).toEqual({ r1: 0, c1: 0, r2: 2, c2: 2 });
    const n = b.wb._history.length;
    b.wb.undo();
    expect(b.wb._history).toHaveLength(n - 1);
    expect(b.val('B1')).toBe('gone');
    expect(b.wb.sheets[0].merges).toEqual([]);
    b.wb.redo();
    b.wb.unmergeCells(b.id, parseRange('B2'));
    expect(b.wb.sheets[0].merges).toEqual([]);
    expect(b.val('A1')).toBe('Title');
  });

  it('replaces overlapping merges and ignores single cells', () => {
    const b = book();
    b.wb.mergeCells(b.id, parseRange('A1:B1'));
    b.wb.mergeCells(b.id, parseRange('B1:C2'));
    expect(b.wb.sheets[0].merges).toEqual([{ r1: 0, c1: 1, r2: 1, c2: 2 }]);
    b.wb.mergeCells(b.id, parseRange('E5'));
    expect(b.wb.sheets[0].merges).toHaveLength(1);
  });

  it('follows inserted and deleted rows and columns', () => {
    const b = book();
    b.wb.mergeCells(b.id, parseRange('B2:C3'));
    b.wb.insertRows(b.id, 0, 1);
    expect(b.wb.sheets[0].merges).toEqual([{ r1: 2, c1: 1, r2: 3, c2: 2 }]);
    b.wb.insertCols(b.id, 2, 1); // inside the merge: it widens
    expect(b.wb.sheets[0].merges).toEqual([{ r1: 2, c1: 1, r2: 3, c2: 3 }]);
    b.wb.deleteRows(b.id, 2, 1); // top row removed: shrinks
    expect(b.wb.sheets[0].merges).toEqual([{ r1: 2, c1: 1, r2: 2, c2: 3 }]);
    b.wb.deleteCols(b.id, 0, 5); // fully gone
    expect(b.wb.sheets[0].merges).toEqual([]);
  });

  it('serializes merges', () => {
    const b = book();
    b.wb.mergeCells(b.id, parseRange('A1:C1'));
    const copy = new Workbook(JSON.parse(JSON.stringify(b.wb.toJSON())));
    expect(copy.sheets[0].merges).toEqual([{ r1: 0, c1: 0, r2: 0, c2: 2 }]);
  });
});

describe('named ranges', () => {
  it('validates names', () => {
    const wb = new Workbook();
    expect(wb.validateName('Sales')).toBeNull();
    expect(wb.validateName('_total.2026')).toBeNull();
    expect(wb.validateName('')).toMatch(/Enter/);
    expect(wb.validateName('A1')).toMatch(/reference/);
    expect(wb.validateName('$B$2')).toMatch(/reference/);
    expect(wb.validateName('R1C1')).toMatch(/reference/);
    expect(wb.validateName('my name')).toMatch(/letters/);
    expect(wb.validateName('TRUE')).toMatch(/reserved/);
    expect(wb.defineName('Sales', 'Sheet1!$B$2:$B$4')).toBeNull();
    expect(wb.validateName('sales')).toMatch(/already/);
    expect(wb.defineName('Bad', 'nonsense')).toMatch(/reference/);
    expect(wb.defineName('NoSheet', '$A$1:$B$2')).toMatch(/reference/);
  });

  it('defines, resolves, redefines, deletes, and undoes names', () => {
    const b = book({ B2: '1', B3: '2', B4: '3' });
    expect(b.wb.defineName('Sales', 'Sheet1!$B$2:$B$4')).toBeNull();
    expect(b.wb.namedRef('sales')).toMatchObject({ sheet: 'Sheet1', r1: 1, c1: 1, r2: 3, c2: 1 });
    expect(b.wb.nameForRange(b.id, parseRange('B2:B4'))).toBe('Sales');
    expect(b.wb.nameForRange(b.id, parseRange('B2:B3'))).toBeNull();
    expect(b.wb.refTextFor(b.id, parseRange('A1'))).toBe('Sheet1!$A$1');
    b.set('D1', '=SUM(Sales)');
    b.set('D2', '=sales');
    b.set('D3', '=Nope+1');
    expect(b.val('D1')).toBe(6);
    expect(b.val('D2')).toEqual({ error: '#SPILL!' }); // a 3-cell range blocked by D3
    expect(b.val('D3')).toEqual({ error: '#NAME?' });
    expect(b.wb.defineName('SALES', 'Sheet1!$B$2:$B$3')).toBeNull(); // redefining takes the spelling as typed
    expect(b.wb.names.map((n) => n.name)).toEqual(['SALES']);
    expect(b.val('D1')).toBe(3);
    b.wb.undo();
    expect(b.val('D1')).toBe(6);
    b.wb.deleteName('Sales');
    expect(b.val('D1')).toEqual({ error: '#NAME?' });
    b.wb.undo();
    expect(b.val('D1')).toBe(6);
    const copy = new Workbook(JSON.parse(JSON.stringify(b.wb.toJSON())));
    expect(copy.names).toEqual([{ name: 'Sales', ref: 'Sheet1!$B$2:$B$4' }]);
  });

  it('follows structural edits and sheet renames, and drops names of deleted sheets', () => {
    const wb = new Workbook({ sheets: [{ name: 'Data' }, { name: 'Other' }] });
    const [data, other] = wb.sheets;
    wb.setInput(data.id, 1, 1, '5');
    wb.defineName('Total', 'Data!$B$2');
    wb.defineName('Elsewhere', 'Other!$A$1');
    wb.setInput(other.id, 0, 0, '=Total*2');
    expect(wb.getValue(other.id, 0, 0)).toBe(10);
    wb.insertRows(data.id, 0, 2);
    expect(wb.names.find((n) => n.name === 'Total').ref).toBe('Data!$B$4');
    expect(wb.getValue(other.id, 0, 0)).toBe(10);
    wb.renameSheet(data.id, 'Q1 Data');
    expect(wb.names.find((n) => n.name === 'Total').ref).toBe("'Q1 Data'!$B$4");
    expect(wb.getValue(other.id, 0, 0)).toBe(10);
    wb.deleteRows(data.id, 3, 1);
    expect(wb.names.find((n) => n.name === 'Total').ref).toBe('#REF!');
    expect(wb.getValue(other.id, 0, 0)).toEqual({ error: '#REF!' }); // the name still exists but points at deleted cells
    wb.deleteSheet(other.id);
    expect(wb.names.map((n) => [n.name, n.ref])).toEqual([['Elsewhere', '#REF!'], ['Total', '#REF!']]); // the name stays, pointing at the deleted sheet
  });
});

describe('notes', () => {
  it('adds, edits, deletes, undoes, and serializes notes', () => {
    const b = book({ A1: '1' });
    const note = '  Check this  ';
    b.wb.setNote(b.id, 0, 0, note);
    expect(b.wb.getNote(b.id, 0, 0)).toBe(note);
    b.wb.setNote(b.id, 5, 5, 'Empty cell can carry a note');
    expect(b.wb.getNote(b.id, 5, 5)).toBe('Empty cell can carry a note');
    b.wb.setNote(b.id, 0, 0, 'Edited');
    b.wb.undo();
    expect(b.wb.getNote(b.id, 0, 0)).toBe(note);
    b.wb.setNote(b.id, 0, 0, '');
    expect(b.wb.getNote(b.id, 0, 0)).toBeNull();
    b.wb.undo();
    expect(b.wb.getNote(b.id, 0, 0)).toBe(note);
    const n = b.wb._history.length;
    b.wb.setNote(b.id, 0, 0, note); // unchanged
    expect(b.wb._history).toHaveLength(n);
    const copy = new Workbook(JSON.parse(JSON.stringify(b.wb.toJSON())));
    expect(copy.getNote(copy.activeSheetId, 0, 0)).toBe(note);
    expect(copy.getNote(copy.sheets[0].id, 5, 5)).toBe('Empty cell can carry a note');
  });

  it('moves notes with inserted and deleted rows and columns', () => {
    const b = book();
    b.wb.setNote(b.id, 2, 2, 'n');
    b.wb.insertRows(b.id, 0, 1);
    expect(b.wb.getNote(b.id, 3, 2)).toBe('n');
    b.wb.insertCols(b.id, 5, 1); // after: unchanged
    expect(b.wb.getNote(b.id, 3, 2)).toBe('n');
    b.wb.deleteCols(b.id, 0, 1);
    expect(b.wb.getNote(b.id, 3, 1)).toBe('n');
    b.wb.deleteRows(b.id, 3, 1);
    expect(b.wb.sheets[0].notes.size).toBe(0);
  });
});

describe('data validation', () => {
  it('adds, resolves, checks, and undoes rules', () => {
    const b = book({ A1: 'Yes', A2: 'No', B1: 'Yes', B2: 'Maybe', C1: '5', D1: 'TRUE' });
    const id = b.wb.addValidation(b.id, { range: parseRange('B1:B5'), type: 'list', source: 'A1:A2', strict: true });
    expect(b.wb.validationAt(b.id, 0, 1)).toMatchObject({ id, type: 'list' });
    expect(b.wb.validationAt(b.id, 0, 0)).toBeNull();
    expect(b.wb.listOptionsFor(b.id, b.wb.validationAt(b.id, 0, 1))).toEqual(['Yes', 'No']);
    expect(b.wb.validateCell(b.id, 0, 1).ok).toBe(true);
    expect(b.wb.validateCell(b.id, 1, 1).ok).toBe(false);
    expect(b.wb.validateInput(b.id, 2, 1, 'no').ok).toBe(true);
    expect(b.wb.validateInput(b.id, 2, 1, 'Later').ok).toBe(false);
    expect(b.wb.validateInput(b.id, 2, 1, '=A1').ok).toBe(true);
    expect(b.wb.validateInput(b.id, 9, 9, 'anything').ok).toBe(true);
    b.wb.addValidation(b.id, { range: parseRange('C1'), type: 'number', min: 0, max: 3 });
    expect(b.wb.validateCell(b.id, 0, 2)).toMatchObject({ ok: false });
    b.wb.addValidation(b.id, { range: parseRange('D1'), type: 'checkbox' });
    expect(b.wb.validateCell(b.id, 0, 3).ok).toBe(true);
    // Same range again replaces the earlier rule; a covering rule added later wins.
    b.wb.addValidation(b.id, { range: parseRange('B1:B5'), type: 'list', source: 'Maybe' });
    expect(b.wb.sheets[0].validations.filter((v) => v.range.c1 === 1)).toHaveLength(1);
    expect(b.wb.validateCell(b.id, 1, 1).ok).toBe(true);
    b.wb.updateValidation(b.id, b.wb.validationAt(b.id, 1, 1).id, { source: 'Yes' });
    expect(b.wb.validateCell(b.id, 1, 1).ok).toBe(false);
    b.wb.undo();
    expect(b.wb.validateCell(b.id, 1, 1).ok).toBe(true);
    b.wb.deleteValidation(b.id, b.wb.validationAt(b.id, 1, 1).id);
    expect(b.wb.validationAt(b.id, 1, 1)).toBeNull();
  });

  it('follows structure and serializes', () => {
    const b = book();
    b.wb.addValidation(b.id, { range: parseRange('B2:B4'), type: 'checkbox' });
    b.wb.insertRows(b.id, 0, 1);
    expect(b.wb.sheets[0].validations[0].range).toEqual({ r1: 2, c1: 1, r2: 4, c2: 1 });
    b.wb.deleteCols(b.id, 1, 1);
    expect(b.wb.sheets[0].validations).toHaveLength(0);
    b.wb.undo();
    const copy = new Workbook(JSON.parse(JSON.stringify(b.wb.toJSON())));
    expect(copy.sheets[0].validations[0]).toMatchObject({ type: 'checkbox', range: { r1: 2, c1: 1, r2: 4, c2: 1 } });
  });
});

describe('multi-key sort', () => {
  it('sorts by several columns with per-key direction', () => {
    const b = book({
      A1: 'b', B1: '2', C1: 'x',
      A2: 'a', B2: '9', C2: 'y',
      A3: 'b', B3: '1', C3: 'z',
      A4: 'a', B4: '5', C4: 'w',
    });
    b.wb.sortRangeBy(b.id, parseRange('A1:C4'), [{ col: 0, ascending: true }, { col: 1, ascending: false }]);
    expect(['C1', 'C2', 'C3', 'C4'].map(b.val)).toEqual(['y', 'w', 'x', 'z']);
    b.wb.undo();
    expect(['C1', 'C2', 'C3', 'C4'].map(b.val)).toEqual(['x', 'y', 'z', 'w']);
    b.wb.sortRangeBy(b.id, parseRange('A1:C4'), [{ col: 1 }]);
    expect(['B1', 'B2', 'B3', 'B4'].map(b.val)).toEqual([1, 2, 5, 9]);
  });
});

describe('removeDuplicates', () => {
  it('drops repeated rows, keeps the first, compacts, and undoes', () => {
    const b = book({
      A1: 'Name', B1: 'Qty',
      A2: 'apple', B2: '1',
      A3: 'Pear', B3: '2',
      A4: 'APPLE', B4: '1',
      A5: 'pear', B5: '3',
      A6: 'apple', B6: '1',
      A7: '=B6*2',
    });
    const removed = b.wb.removeDuplicates(b.id, parseRange('A1:B7'), { header: true });
    expect(removed).toBe(2);
    expect(['A1', 'A2', 'A3', 'A4', 'A5'].map(b.val)).toEqual(['Name', 'apple', 'Pear', 'pear', 6]);
    expect(b.val('B4')).toBe(3);
    expect(b.f('A5')).toBe('B4*2'); // formula row moved up, refs shifted
    expect(b.cell('A6')).toBeUndefined();
    expect(b.wb.removeDuplicates(b.id, parseRange('A1:B7'), { header: true })).toBe(0);
    b.wb.undo();
    expect(b.val('A6')).toBe('apple');
  });

  it('ignores blank rows and respects the header flag', () => {
    const b = book({ A1: 'x', A3: 'x', A4: 'x' });
    expect(b.wb.removeDuplicates(b.id, parseRange('A1:A5'))).toBe(2);
    expect(b.val('A1')).toBe('x');
    expect(b.cell('A3')).toBeUndefined();
  });
});

describe('splitTextToColumns', () => {
  it('detects the delimiter and spreads parts to the right with type inference', () => {
    const b = book({ A1: 'Ann, 30, NY', A2: 'Bob, 41, LA', A3: '=1+1', A4: 'solo' });
    b.wb.applyStyle(b.id, parseRange('A1'), { bold: true });
    const result = b.wb.splitTextToColumns(b.id, parseRange('A1:A4'));
    expect(result).toEqual({ rows: 3, cols: 3 });
    expect(['A1', 'B1', 'C1'].map(b.val)).toEqual(['Ann', 30, 'NY']);
    expect(b.cell('A1').s).toEqual({ bold: true });
    expect(b.val('B2')).toBe(41);
    expect(b.f('A3')).toBe('1+1'); // formulas untouched
    expect(b.val('A4')).toBe('solo');
    b.wb.undo();
    expect(b.val('A1')).toBe('Ann, 30, NY');
    expect(b.cell('B1')).toBeUndefined();
  });

  it('splits on spaces and honours an explicit delimiter', () => {
    const b = book({ A1: 'one  two three', A2: 'a|b' });
    expect(b.wb.splitTextToColumns(b.id, parseRange('A1'))).toEqual({ rows: 1, cols: 3 });
    expect(['A1', 'B1', 'C1'].map(b.val)).toEqual(['one', 'two', 'three']);
    expect(b.wb.splitTextToColumns(b.id, parseRange('A2'), '|')).toEqual({ rows: 1, cols: 2 });
    expect(b.wb.splitTextToColumns(b.id, parseRange('D1:D3'))).toEqual({ rows: 0, cols: 0 });
  });
});

describe('transformText', () => {
  it('trims and changes case of text cells only', () => {
    const b = book({ A1: '  hello   WORLD ', A2: '42', A3: '=A1', B1: 'mIxEd case here' });
    expect(b.wb.transformText(b.id, parseRange('A1:B3'), 'trim')).toBe(1);
    expect(b.val('A1')).toBe('hello WORLD');
    expect(b.wb.transformText(b.id, parseRange('A1:B3'), 'proper')).toBe(2);
    expect(b.val('A1')).toBe('Hello World');
    expect(b.val('B1')).toBe('Mixed Case Here');
    expect(b.wb.transformText(b.id, parseRange('A1:B3'), 'upper')).toBe(2);
    expect(b.val('A3')).toBe('HELLO WORLD');
    expect(b.f('A3')).toBe('A1');
    expect(b.wb.transformText(b.id, parseRange('A1:B3'), 'lower')).toBe(2);
    expect(b.wb.transformText(b.id, parseRange('A1:B3'), 'lower')).toBe(0);
    expect(b.wb.transformText(b.id, parseRange('A1:B3'), 'nope')).toBe(0);
    b.wb.undo();
    expect(b.val('A1')).toBe('HELLO WORLD');
  });
});

describe('sheet colors', () => {
  it('sets, validates, undoes, and serializes tab colors', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    wb.setSheetColor(id, '#0a63f0');
    expect(wb.sheets[0].color).toBe('#0a63f0');
    wb.setSheetColor(id, 'red'); // rejected
    expect(wb.sheets[0].color).toBe('#0a63f0');
    wb.undo();
    expect(wb.sheets[0].color).toBeNull();
    wb.redo();
    const copy = new Workbook(JSON.parse(JSON.stringify(wb.toJSON())));
    expect(copy.sheets[0].color).toBe('#0a63f0');
    wb.setSheetColor(id, null);
    expect(wb.sheets[0].color).toBeNull();
  });
});

describe('filter', () => {
  const DATA = {
    A1: 'Fruit', B1: 'Qty',
    A2: 'Apple', B2: '3',
    A3: 'Pear', B3: '5',
    A4: 'apple', B4: '7',
    A5: '', B5: '1',
    A6: 'Kiwi', B6: '5',
  };

  it('creates, filters by values and text, reapplies, and clears', () => {
    const b = book(DATA);
    b.wb.setFilterRange(b.id, parseRange('A1:B6'));
    expect(b.wb.sheets[0].filter).toEqual({ range: { r1: 0, c1: 0, r2: 5, c2: 1 }, criteria: {} });
    expect(b.wb.filterValues(b.id, 0).map((v) => v.value)).toEqual(['Apple', 'apple', 'Kiwi', 'Pear', '']);
    expect(b.wb.filterValues(b.id, 1)).toEqual([{ value: '1', count: 1 }, { value: '3', count: 1 }, { value: '5', count: 2 }, { value: '7', count: 1 }]);
    b.wb.setFilterCriteria(b.id, 1, { values: ['5'] });
    expect([...b.wb.sheets[0].filterHidden].sort()).toEqual([1, 3, 4]);
    expect(b.wb.rowHeight(b.id, 1)).toBe(0);
    expect(b.wb.isRowHidden(b.id, 2)).toBe(false);
    b.wb.setFilterCriteria(b.id, 0, { text: 'pe' });
    expect([...b.wb.sheets[0].filterHidden].sort()).toEqual([1, 3, 4, 5]);
    b.wb.setFilterCriteria(b.id, 0, null);
    expect([...b.wb.sheets[0].filterHidden].sort()).toEqual([1, 3, 4]);
    // Data changes are picked up on reapply.
    b.set('B2', '5');
    b.wb.reapplyFilter(b.id);
    expect([...b.wb.sheets[0].filterHidden].sort()).toEqual([3, 4]);
    b.wb.undo(); b.wb.undo(); // edit, then the criteria change
    b.wb.clearFilter(b.id);
    expect(b.wb.sheets[0].filter).toBeNull();
    expect(b.wb.sheets[0].filterHidden.size).toBe(0);
    b.wb.undo();
    expect(b.wb.sheets[0].filter).not.toBeNull();
    expect(b.wb.sheets[0].filterHidden.size).toBeGreaterThan(0);
  });

  it('follows structural edits and serializes with criteria', () => {
    const b = book(DATA);
    b.wb.setFilterRange(b.id, parseRange('A1:B6'));
    b.wb.setFilterCriteria(b.id, 1, { values: ['5'] });
    b.wb.insertCols(b.id, 0, 1);
    expect(b.wb.sheets[0].filter.range).toEqual({ r1: 0, c1: 1, r2: 5, c2: 2 });
    expect(b.wb.sheets[0].filter.criteria).toEqual({ 2: { values: ['5'], keys: ['5'] } });
    expect([...b.wb.sheets[0].filterHidden].sort()).toEqual([1, 3, 4]);
    b.wb.insertRows(b.id, 2, 1);
    expect(b.wb.sheets[0].filter.range.r2).toBe(6);
    const copy = new Workbook(JSON.parse(JSON.stringify(b.wb.toJSON())));
    expect(copy.sheets[0].filter.criteria).toEqual({ 2: { values: ['5'], keys: ['5'] } });
    expect(copy.sheets[0].filterHidden.size).toBeGreaterThan(0);
    b.wb.deleteCols(b.id, 2, 1);
    expect(b.wb.sheets[0].filter.criteria).toEqual({});
    b.wb.deleteRows(b.id, 0, 10);
    expect(b.wb.sheets[0].filter).toBeNull();
  });
});

describe('volatile refresh', () => {
  it('detects volatile formulas and drops cached values without dirtying the document', () => {
    const b = book({ A1: '=1+1' });
    expect(b.wb.hasVolatileFormulas()).toBe(false);
    expect(b.wb.refreshVolatile()).toBe(false);
    b.set('A2', '=RAND()');
    b.wb.markClean();
    const first = b.val('A2');
    expect(b.val('A2')).toBe(first); // cached
    expect(b.wb.hasVolatileFormulas()).toBe(true);
    const seen = [];
    b.wb.addEventListener('change', (e) => seen.push(e.detail.type));
    expect(b.wb.refreshVolatile()).toBe(true);
    expect(seen).toEqual(['recalc']);
    expect(b.wb.dirty).toBe(false);
    let changed = false;
    for (let i = 0; i < 5 && !changed; i++) { b.wb.refreshVolatile(); changed = b.val('A2') !== first; }
    expect(changed).toBe(true);
  });
});

describe('links inside the workbook', () => {
  it('resolves #Sheet!A1, quoted names, ranges, and named ranges', () => {
    const b = book({ A1: 'x' });
    const q1 = b.wb.addSheet('Q1 Data');
    b.wb.defineName('Totals', "'Q1 Data'!$B$2:$B$9");
    expect(b.wb.resolveLink('#Sheet1!B3')).toEqual({ sheetId: b.id, range: { r1: 2, c1: 1, r2: 2, c2: 1 } });
    expect(b.wb.resolveLink("#'Q1 Data'!A1:C3")).toEqual({ sheetId: q1.id, range: { r1: 0, c1: 0, r2: 2, c2: 2 } });
    expect(b.wb.resolveLink('#Totals')).toEqual({ sheetId: q1.id, range: { r1: 1, c1: 1, r2: 8, c2: 1 } });
    expect(b.wb.resolveLink('#B2', b.id)).toEqual({ sheetId: b.id, range: { r1: 1, c1: 1, r2: 1, c2: 1 } });
    expect(b.wb.resolveLink('#Nowhere!A1')).toBeNull();
    expect(b.wb.resolveLink('https://puter.com')).toBeNull();
    expect(b.wb.resolveLink('#')).toBeNull();
    expect(b.wb.internalLinkFor(q1.id, parseRange('A1:C3'))).toBe("#'Q1 Data'!A1:C3");
    expect(b.wb.internalLinkFor(b.id, parseRange('B3'))).toBe('#Sheet1!B3');
    // A link cell built from the address keeps working as a HYPERLINK formula.
    b.wb.setLink(b.id, 4, 0, b.wb.internalLinkFor(q1.id, parseRange('A1')), 'Go to Q1');
    expect(b.wb.linkAt(b.id, 4, 0)).toEqual({ url: "#'Q1 Data'!A1", label: 'Go to Q1' });
    // Renaming the sheet does not rewrite link text, but the name still resolves after the rename by name.
    b.wb.renameSheet(q1.id, 'Q1');
    expect(b.wb.resolveLink('#Q1!A1')).toEqual({ sheetId: q1.id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } });
  });
});

describe('importing sheets from another workbook', () => {
  it('appends sheets, renames clashes and their references, and carries names', () => {
    const b = book({ A1: 'mine' });
    const other = new Workbook({ sheets: [
      { name: 'Sheet1', cells: { '0,0': { v: 'theirs', f: null }, '1,0': { v: null, f: 'Sheet1!A1&Data!A1' } } },
      { name: 'Data', cells: { '0,0': { v: 7, f: null } }, color: '#c22a2a' },
    ], names: [{ name: 'Seven', ref: 'Data!$A$1' }, { name: 'Dup', ref: 'Sheet1!$A$1' }] });
    b.wb.defineName('Dup', 'Sheet1!$B$1');
    const added = b.wb.importSheets(other);
    expect(added.map((s) => s.name)).toEqual(['Sheet1 (2)', 'Data']);
    expect(b.wb.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Sheet1 (2)', 'Data']);
    expect(b.wb.activeSheetId).toBe(added[0].id);
    // The imported formula now points at the renamed copy, not at the host's Sheet1.
    expect(b.wb.getCell(added[0].id, 1, 0).f).toBe("'Sheet1 (2)'!A1&Data!A1");
    expect(b.wb.getValue(added[0].id, 1, 0)).toBe('theirs7');
    expect(b.wb.getValue(b.id, 0, 0)).toBe('mine');
    expect(b.wb.sheet(added[1].id).color).toBe('#c22a2a');
    expect(b.wb.namedRef('Seven')).toMatchObject({ sheet: 'Data', r1: 0, c1: 0 });
    expect(b.wb.names.find((n) => n.name === 'Dup').ref).toBe('Sheet1!$B$1');
    b.wb.undo();
    expect(b.wb.sheets.map((s) => s.name)).toEqual(['Sheet1']);
    expect(b.wb.names.map((n) => n.name)).toEqual(['Dup']);
  });
});

describe('convert text to numbers', () => {
  it('turns numeric-looking text into numbers, dates, percents, and currency', () => {
    const b = book();
    b.set('A1', "'1,234.5");
    b.set('A2', "'12%");
    b.set('A3', "'$40");
    b.set('A4', "'2026-08-27");
    b.set('A5', 'hello');
    b.set('A6', '5');
    b.set('A7', "'TRUE");
    expect(b.cell('A1').v).toBe('1,234.5');
    const n = b.wb.transformText(b.id, parseRange('A1:A7'), 'number');
    expect(n).toBe(5);
    expect(b.cell('A1')).toEqual({ v: 1234.5, f: null, s: { fmt: 'number', dec: 2 } }); // the typed separator asks for the grouped format
    expect(b.cell('A2')).toEqual({ v: 0.12, f: null, s: { fmt: 'percent', dec: 0 } });
    expect(b.cell('A3')).toMatchObject({ v: 40, f: null, s: { fmt: 'currency' } }); // the currency the text names rides along
    expect(b.show('A4')).toBe('2026-08-27');
    expect(b.cell('A4').s.fmt).toBe('date');
    expect(b.cell('A5')).toEqual({ v: 'hello', f: null });
    expect(b.cell('A6')).toEqual({ v: 5, f: null });
    expect(b.cell('A7').v).toBe(true);
    expect(b.wb.undoLabel()).toBe('Convert to numbers');
  });
});

describe('sheet protection', () => {
  it('refuses edits, structure, formatting, and objects while protected, and announces it', () => {
    const b = book({ A1: '1', B1: '2' });
    const events = [];
    b.wb.addEventListener('change', (e) => { if (e.detail.type === 'protected') events.push(e.detail.sheetId); });
    b.wb.setSheetProtected(b.id, true);
    expect(b.wb.isProtected(b.id)).toBe(true);
    const version = b.wb.version;
    b.set('A1', '99');
    expect(b.val('A1')).toBe(1);
    b.wb.applyStyle(b.id, parseRange('A1'), { bold: true });
    expect(b.cell('A1').s).toBeUndefined();
    b.wb.insertRows(b.id, 0, 2);
    expect(b.val('A1')).toBe(1);
    b.wb.deleteCols(b.id, 0, 1);
    expect(b.val('B1')).toBe(2);
    b.wb.setNote(b.id, 0, 0, 'hi');
    expect(b.wb.getNote(b.id, 0, 0)).toBeNull();
    b.wb.mergeCells(b.id, parseRange('A1:B2'));
    expect(b.wb.mergesIn(b.id, parseRange('A1:B2')).length).toBe(0);
    b.wb.setColWidth(b.id, 0, 200);
    expect(b.wb.colWidth(b.id, 0)).not.toBe(200);
    expect(b.wb.addChart(b.id, { type: 'column', range: parseRange('A1:B1'), anchor: { r: 0, c: 0 } })).toBeNull();
    expect(b.wb.transformText(b.id, parseRange('A1:B1'), 'upper')).toBe(0);
    expect(b.wb.moveRange(b.id, parseRange('A1'), 5, 5)).toBeNull();
    expect(events.length).toBeGreaterThanOrEqual(10);
    expect(events.every((id) => id === b.id)).toBe(true);
    expect(b.wb.version).toBe(version); // nothing happened
    // Other sheets are untouched, and the flag survives a JSON round trip.
    const other = b.wb.addSheet('Free');
    b.wb.setInput(other.id, 0, 0, 'ok');
    expect(b.wb.getValue(other.id, 0, 0)).toBe('ok');
    const copy = new Workbook(b.wb.toJSON());
    expect(copy.sheets[0].protected).toBe(true);
    expect(copy.sheets[1].protected).toBe(false);
    b.wb.setSheetProtected(b.id, false);
    b.set('A1', '99');
    expect(b.val('A1')).toBe(99);
  });
});

describe('split text with a chosen separator', () => {
  it('splits on the given delimiter instead of detecting one', () => {
    const b = book({ A1: 'a-b, c', A2: 'x-y' });
    expect(b.wb.splitTextToColumns(b.id, parseRange('A1:A2'), '-')).toEqual({ rows: 2, cols: 2 });
    expect(b.val('A1')).toBe('a');
    expect(b.val('B1')).toBe('b, c');
    expect(b.val('B2')).toBe('y');
    b.wb.undo();
    expect(b.wb.splitTextToColumns(b.id, parseRange('A1:A2'), ',')).toEqual({ rows: 2, cols: 2 });
    expect(b.val('A1')).toBe('a-b');
    expect(b.val('B1')).toBe('c');
    expect(b.val('A2')).toBe('x-y');
  });
});

describe('row and column groups', () => {
  it('groups, nests, collapses, expands, and ungroups', () => {
    const b = book();
    expect(b.wb.groupLines(b.id, 'row', 2, 6)).toBe(true);
    expect(b.wb.groupLines(b.id, 'row', 2, 6)).toBe(true); // grouped again: one level deeper, as in Excel
    expect(b.wb.ungroupLines(b.id, 'row', 2, 6)).toBe(1); // and ungrouped: that level comes off
    expect(b.wb.groupLines(b.id, 'row', 5, 9)).toBe(false); // partial overlap
    expect(b.wb.groupLines(b.id, 'row', 3, 4)).toBe(true);  // nested
    expect(b.wb.outlineDepth(b.id, 'row')).toBe(2);
    expect(b.wb.outlineGroups(b.id, 'row')).toEqual([{ from: 2, to: 6, collapsed: false, level: 1 }, { from: 3, to: 4, collapsed: false, level: 2 }]);
    b.wb.toggleGroup(b.id, 'row', 3, 4);
    expect([...b.wb.sheet(b.id).hiddenRows].sort()).toEqual([3, 4]);
    b.wb.toggleGroup(b.id, 'row', 2, 6);
    expect([...b.wb.sheet(b.id).hiddenRows].sort()).toEqual([2, 3, 4, 5, 6]);
    // Expanding the outer group keeps the inner collapsed group hidden.
    b.wb.toggleGroup(b.id, 'row', 2, 6);
    expect([...b.wb.sheet(b.id).hiddenRows].sort()).toEqual([3, 4]);
    expect(b.wb.undoLabel()).toBe('Expand rows');
    b.wb.undo();
    expect([...b.wb.sheet(b.id).hiddenRows].sort()).toEqual([2, 3, 4, 5, 6]);
    b.wb.redo();
    // Ungrouping the inner group brings its rows back.
    expect(b.wb.ungroupLines(b.id, 'row', 3, 4)).toBe(1);
    expect(b.wb.sheet(b.id).hiddenRows.size).toBe(0);
    // With nothing inside the selection, the innermost group around it goes.
    expect(b.wb.ungroupLines(b.id, 'row', 4, 4)).toBe(1);
    expect(b.wb.outlineGroups(b.id, 'row')).toEqual([]);
    expect(b.wb.ungroupLines(b.id, 'row', 4, 4)).toBe(0);
    expect(b.wb.groupLines(b.id, 'col', 1, 3)).toBe(true);
    b.wb.toggleGroup(b.id, 'col', 1, 3);
    expect([...b.wb.sheet(b.id).hiddenCols].sort()).toEqual([1, 2, 3]);
  });

  it('follows inserted, deleted, and moved lines and survives JSON', () => {
    const b = book();
    b.wb.groupLines(b.id, 'row', 5, 8);
    b.wb.insertRows(b.id, 0, 2);
    expect(b.wb.outlineGroups(b.id, 'row')[0]).toMatchObject({ from: 7, to: 10 });
    b.wb.insertRows(b.id, 8, 1); // inside the group: it grows
    expect(b.wb.outlineGroups(b.id, 'row')[0]).toMatchObject({ from: 7, to: 11 });
    b.wb.deleteRows(b.id, 0, 3);
    expect(b.wb.outlineGroups(b.id, 'row')[0]).toMatchObject({ from: 4, to: 8 });
    b.wb.deleteRows(b.id, 5, 2); // shrink from inside
    expect(b.wb.outlineGroups(b.id, 'row')[0]).toMatchObject({ from: 4, to: 6 });
    b.wb.moveRows(b.id, 4, 3, 12); // move the whole group down
    expect(b.wb.outlineGroups(b.id, 'row')[0]).toMatchObject({ from: 9, to: 11 });
    b.wb.moveRows(b.id, 10, 1, 0); // tear a line out of the group: the group loses it, and moves down a line
    expect(b.wb.outlineGroups(b.id, 'row')).toEqual([{ from: 10, to: 11, collapsed: false, level: 1 }]);
    b.wb.groupLines(b.id, 'col', 2, 4);
    b.wb.toggleGroup(b.id, 'col', 2, 4);
    const copy = new Workbook(b.wb.toJSON());
    expect(copy.outlineGroups(copy.sheets[0].id, 'col')).toEqual([{ from: 2, to: 4, collapsed: true, level: 1 }]);
    expect(copy.sheets[0].hiddenCols.has(3)).toBe(true);
    b.wb.deleteCols(b.id, 2, 3); // delete the whole group
    expect(b.wb.outlineGroups(b.id, 'col')).toEqual([]);
  });
});

describe('gridlines', () => {
  it('is a per-sheet setting that round-trips and defaults to on', () => {
    const b = book();
    expect(b.wb.sheet(b.id).gridlines).toBe(true);
    b.wb.setGridlines(b.id, false);
    expect(b.wb.sheet(b.id).gridlines).toBe(false);
    const copy = new Workbook(b.wb.toJSON());
    expect(copy.sheets[0].gridlines).toBe(false);
    expect(new Workbook({ sheets: [{ name: 'S' }] }).sheets[0].gridlines).toBe(true);
  });
});

describe('fill series', () => {
  it('fills linear, growth, and date series with steps and stop values', () => {
    const b = book({ A1: '1', C1: '2', E1: '2026-01-31' });
    expect(b.wb.fillSeries(b.id, parseRange('A1:A5'), { type: 'linear', step: 3 })).toBe(4);
    expect([2, 3, 4, 5].map((r) => b.val(`A${r}`))).toEqual([4, 7, 10, 13]);
    expect(b.wb.fillSeries(b.id, parseRange('C1:C4'), { type: 'growth', step: 2 })).toBe(3);
    expect([2, 3, 4].map((r) => b.val(`C${r}`))).toEqual([4, 8, 16]);
    // Month steps clamp to the month's last day and keep the date format.
    expect(b.wb.fillSeries(b.id, parseRange('E1:E4'), { type: 'date', step: 1, unit: 'month' })).toBe(3);
    expect([2, 3, 4].map((r) => b.show(`E${r}`))).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
    // Weekdays skip weekends: 2026-01-30 is a Friday.
    b.set('G1', '2026-01-30');
    b.wb.fillSeries(b.id, parseRange('G1:G3'), { type: 'date', step: 1, unit: 'weekday' });
    expect([b.show('G2'), b.show('G3')]).toEqual(['2026-02-02', '2026-02-03']);
    // A single cell with a stop value fills until the stop; across with direction 'right'.
    b.set('A10', '10');
    expect(b.wb.fillSeries(b.id, parseRange('A10'), { type: 'linear', step: 10, stop: 45, direction: 'right' })).toBe(3);
    expect([b.val('B10'), b.val('C10'), b.val('D10'), b.wb.getCell(b.id, 9, 4)]).toEqual([20, 30, 40, undefined]);
    expect(b.wb.fillSeries(b.id, parseRange('A10'), { type: 'linear', step: 10 })).toBe(0); // no stop, single cell
    b.set('H1', 'text');
    expect(b.wb.fillSeries(b.id, parseRange('H1:H3'), {})).toBe(0);
    expect(b.wb.undoLabel()).toBe('Edit cell'); // nothing was filled, so the last step is still the typed text
  });
});

describe('named formulas and named functions', () => {
  it('defines constants, expressions, and LAMBDA functions by name', () => {
    const b = book({ A1: '10', A2: '20', A3: '30' });
    expect(b.wb.defineName('TaxRate', '=0.2')).toBeNull();
    expect(b.wb.defineName('Total', 'SUM(Sheet1!$A$1:$A$3)')).toBeNull();
    expect(b.wb.defineName('Double', '=LAMBDA(x, x*2)')).toBeNull();
    expect(b.wb.defineName('Bad', '=SUM(')).toBeTruthy();
    expect(b.wb.isNamedFormula('TaxRate')).toBe(true);
    expect(b.wb.isNamedFormula('Nope')).toBe(false);
    b.set('C1', '=A1*TaxRate');
    expect(b.val('C1')).toBe(2);
    b.set('C2', '=Total');
    expect(b.val('C2')).toBe(60);
    b.set('C3', '=Double(21)');
    expect(b.val('C3')).toBe(42);
    b.set('C4', '=Double');
    expect(b.val('C4')).toEqual({ error: '#CALC!' });
    b.set('C5', '=TaxRate(1)');
    expect(b.val('C5')).toEqual({ error: '#VALUE!' });
    b.set('C6', '=Missing(1)');
    expect(b.val('C6')).toEqual({ error: '#NAME?' });
    // Names can build on names; a self-referencing name stops as a cycle.
    b.wb.defineName('Quad', '=LAMBDA(x, Double(Double(x)))');
    b.set('C7', '=Quad(3)');
    expect(b.val('C7')).toBe(12);
    b.wb.defineName('Loop', '=Loop+1');
    b.set('C8', '=Loop');
    expect(b.val('C8')).toEqual({ error: '#CYCLE!' });
    // A named range still goes to a place; a formula name is not a place.
    b.wb.defineName('Data', 'Sheet1!$A$1:$A$3');
    expect(b.wb.namedRef('Data')).toMatchObject({ r1: 0, r2: 2 });
    expect(b.wb.namedRef('Total')).toBeNull();
    // Editing a cell the name depends on recalculates through it.
    b.set('A1', '100');
    expect(b.val('C2')).toBe(150);
    expect(b.val('C1')).toBe(20);
    const copy = new Workbook(b.wb.toJSON());
    copy.setInput(copy.sheets[0].id, 9, 0, '=Double(5)');
    expect(copy.getValue(copy.sheets[0].id, 9, 0)).toBe(10);
  });
});

describe('collapse and expand all groups', () => {
  it('folds every group on an axis and unfolds them again', () => {
    const b = book();
    b.wb.groupLines(b.id, 'row', 1, 3);
    b.wb.groupLines(b.id, 'row', 6, 8);
    b.wb.setAllGroups(b.id, 'row', true);
    expect([...b.wb.sheet(b.id).hiddenRows].sort((a, c) => a - c)).toEqual([1, 2, 3, 6, 7, 8]);
    expect(b.wb.outlineGroups(b.id, 'row').every((g) => g.collapsed)).toBe(true);
    expect(b.wb.undoLabel()).toBe('Collapse all rows');
    b.wb.setAllGroups(b.id, 'row', false);
    expect(b.wb.sheet(b.id).hiddenRows.size).toBe(0);
    b.wb.setAllGroups(b.id, 'col', true); // no column groups: nothing happens
    expect(b.wb.undoLabel()).toBe('Expand all rows');
  });
});

describe('remove empty rows', () => {
  it('deletes blank rows inside the range in one undo step and keeps formulas pointing right', () => {
    const b = book({ A1: 'a', A3: 'b', A6: 'c', B7: '=A6&"!"' });
    expect(b.wb.removeEmptyRows(b.id, parseRange('A1:B7'))).toBe(3); // rows 2, 4, 5
    expect([1, 2, 3].map((r) => b.val(`A${r}`))).toEqual(['a', 'b', 'c']);
    expect(b.val('B4')).toBe('c!');
    expect(b.wb.undoLabel()).toBe('Remove empty rows');
    b.wb.undo();
    expect(b.val('A6')).toBe('c');
    expect(b.wb.removeEmptyRows(b.id, parseRange('A1:A1'))).toBe(0);
  });
});

describe('insert and delete cells with shift', () => {
  it('shifts the cells below down and grows spanning ranges, leaving other columns alone', () => {
    const b = book({ A1: '1', A2: '2', A3: '3', B1: '10', B2: '20', C1: '=SUM(A1:A3)', C2: '=A2', C3: '=B2', D1: '=A1:A3*2' });
    expect(b.wb.insertCells(b.id, parseRange('A2:A2'), 'down')).toBe(true);
    expect(b.val('A2')).toBeNull();
    expect(b.val('A3')).toBe(2);
    expect(b.val('A4')).toBe(3);
    expect(b.val('B2')).toBe(20);
    expect(b.f('C1')).toBe('SUM(A1:A4)');
    expect(b.f('C2')).toBe('A3');
    expect(b.f('C3')).toBe('B2');
    expect(b.f('D1')).toBe('A1:A4*2');
    b.wb.undo();
    expect(b.val('A2')).toBe(2);
    expect(b.f('C1')).toBe('SUM(A1:A3)');
  });

  it('shifts right, moving notes and merges inside the band', () => {
    const b = book({ A1: 'a', B1: 'b', D1: 'd', A2: 'x' });
    b.wb.setNote(b.id, 0, 1, 'note on B1');
    b.wb.mergeCells(b.id, parseRange('B1:C1'));
    b.wb.insertCells(b.id, parseRange('A1:A1'), 'right');
    expect(b.val('A1')).toBeNull();
    expect(b.val('B1')).toBe('a');
    expect(b.val('C1')).toBe('b');
    expect(b.val('E1')).toBe('d');
    expect(b.val('A2')).toBe('x');
    expect(b.wb.getNote(b.id, 0, 2)).toBe('note on B1');
    expect(b.wb.mergeAt(b.id, 0, 2)).toMatchObject({ r1: 0, c1: 2, r2: 0, c2: 3 });
  });

  it('deletes cells and pulls the ones below up, #REF!-ing formulas that pointed at them', () => {
    const b = book({ A1: '1', A2: '2', A3: '3', A4: '4', B2: 'keep', C1: '=A2', C2: '=A4', C3: '=SUM(A1:A4)' });
    b.wb.deleteCells(b.id, parseRange('A2:A2'), 'up');
    expect(b.val('A1')).toBe(1);
    expect(b.val('A2')).toBe(3);
    expect(b.val('A3')).toBe(4);
    expect(b.val('A4')).toBeNull();
    expect(b.val('B2')).toBe('keep');
    expect(b.f('C1')).toBe('#REF!');
    expect(b.f('C2')).toBe('A3');
    expect(b.f('C3')).toBe('SUM(A1:A3)');
    b.wb.undo();
    expect(b.val('A2')).toBe(2);
    expect(b.f('C1')).toBe('A2');
  });

  it('deletes cells shifting left', () => {
    const b = book({ A1: 'a', B1: 'b', C1: 'c', A2: 'x', B2: 'y' });
    b.wb.deleteCells(b.id, parseRange('A1:A1'), 'left');
    expect(b.val('A1')).toBe('b');
    expect(b.val('B1')).toBe('c');
    expect(b.val('C1')).toBeNull();
    expect(b.val('A2')).toBe('x');
    expect(b.val('B2')).toBe('y');
  });

  it('refuses on a protected sheet', () => {
    const b = book({ A1: '1', A2: '2' });
    b.wb.setSheetProtected(b.id, true);
    expect(b.wb.insertCells(b.id, parseRange('A1:A1'), 'down')).toBe(false);
    expect(b.val('A1')).toBe(1);
  });
});

describe('precedents and dependents', () => {
  it('lists the cells a formula reads, expanding ranges, names, and other sheets', () => {
    const b = book({ A1: '1', A2: '2', A3: '3', B1: '=SUM(A1:A3)+C5', C1: '=B1*2', D1: '=Total' });
    b.wb.defineName('Total', 'Sheet1!$B$1');
    const s2 = b.wb.addSheet('Other');
    b.wb.setInput(s2.id, 0, 0, '=Sheet1!B1+Sheet1!A2');
    const p = b.wb.precedents(b.id, 0, 1);
    expect(p.map((x) => `${x.r},${x.c}`)).toEqual(['0,0', '1,0', '2,0', '4,2']);
    expect(b.wb.precedents(b.id, 0, 3)).toEqual([{ sheetId: b.id, r: 0, c: 1 }]);
    expect(b.wb.precedents(s2.id, 0, 0)).toEqual([{ sheetId: b.id, r: 0, c: 1 }, { sheetId: b.id, r: 1, c: 0 }]);
    expect(b.wb.precedents(b.id, 0, 0)).toEqual([]);
    // Dependents: B1 is read by C1 directly, by D1 through the name, and by the other sheet.
    const d = b.wb.dependents(b.id, 0, 1);
    expect(d).toEqual([{ sheetId: b.id, r: 0, c: 2 }, { sheetId: b.id, r: 0, c: 3 }, { sheetId: s2.id, r: 0, c: 0 }]);
    // A2 sits inside SUM(A1:A3) and is read from the other sheet.
    expect(b.wb.dependents(b.id, 1, 0)).toEqual([{ sheetId: b.id, r: 0, c: 1 }, { sheetId: s2.id, r: 0, c: 0 }]);
    expect(b.wb.dependents(b.id, 9, 9)).toEqual([]);
  });

  it('clips whole-column references to the used range', () => {
    const b = book({ A1: '1', A2: '2', B1: '=SUM(A:A)' });
    expect(b.wb.precedents(b.id, 0, 1)).toEqual([{ sheetId: b.id, r: 0, c: 0 }, { sheetId: b.id, r: 1, c: 0 }]);
  });
});

describe('goal seek', () => {
  it('rejects a protected input before trying values, while allowing a protected result', () => {
    const b = book({ A1: '2', B1: '=A1*2' });
    const protection = b.wb.protectRange(b.id, parseRange('A1'), 'Fixed input');
    const version = b.wb.version;
    const res = b.wb.goalSeek(b.id, { r: 0, c: 1 }, 20, { r: 0, c: 0 });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/protected/i);
    expect(b.val('A1')).toBe(2);
    expect(b.val('B1')).toBe(4);
    expect(b.wb.version).toBe(version);
    b.wb.unprotectRange(b.id, protection);
    b.wb.protectRange(b.id, parseRange('B1'), 'Keep formula');
    expect(b.wb.goalSeek(b.id, { r: 0, c: 1 }, 20, { r: 0, c: 0 }).ok).toBe(true);
    expect(b.val('B1')).toBe(20);
    b.wb.undo();
    expect(b.val('A1')).toBe(2);
  });

  it('finds the input that makes a formula hit a target, in one undo step', () => {
    const b = book({ A1: '2', B1: '=A1*3+1' });
    const res = b.wb.goalSeek(b.id, { r: 0, c: 1 }, 16, { r: 0, c: 0 });
    expect(res.ok).toBe(true);
    expect(b.val('A1')).toBeCloseTo(5, 9);
    expect(b.val('B1')).toBeCloseTo(16, 9);
    b.wb.undo();
    expect(b.val('A1')).toBe(2);
    expect(b.wb.canRedo()).toBe(true);
  });

  it('handles nonlinear formulas, blank inputs, and dependent chains', () => {
    const b = book({ B1: '=A1^2-A1', C1: '=B1*2' });
    expect(b.wb.goalSeek(b.id, { r: 0, c: 1 }, 6, { r: 0, c: 0 }).ok).toBe(true);
    expect(b.val('B1')).toBeCloseTo(6, 6);
    expect(b.wb.goalSeek(b.id, { r: 0, c: 2 }, 24, { r: 0, c: 0 }).ok).toBe(true);
    expect(b.val('C1')).toBeCloseTo(24, 6);
    // PMT-style: what loan gives a 500 payment?
    const m = book({ A1: '10000', B1: '=-PMT(0.05/12,36,A1)' });
    expect(m.wb.goalSeek(m.id, { r: 0, c: 1 }, 500, { r: 0, c: 0 }).ok).toBe(true);
    expect(m.val('B1')).toBeCloseTo(500, 6);
  });

  it('refuses when the target is not a formula or the variable is', () => {
    const b = book({ A1: '1', B1: '=A1', C1: '5' });
    expect(b.wb.goalSeek(b.id, { r: 0, c: 2 }, 6, { r: 0, c: 0 }).ok).toBe(false);
    expect(b.wb.goalSeek(b.id, { r: 0, c: 1 }, 6, { r: 0, c: 1 }).ok).toBe(false);
    expect(b.val('A1')).toBe(1);
  });

  it('reports when no value reaches the goal and leaves the input untouched', () => {
    const b = book({ A1: '1', B1: '=A1^2' });
    const res = b.wb.goalSeek(b.id, { r: 0, c: 1 }, -4, { r: 0, c: 0 });
    expect(res.ok).toBe(false);
    expect(b.val('A1')).toBe(1);
    expect(b.wb.undoLabel()).not.toBe('Goal seek');
  });
});

describe('randomize range', () => {
  it('permutes the rows of the range, keeping rows together and shifting their formulas', () => {
    const b = book({ A1: 'a', B1: '=ROW()', A2: 'b', B2: '=ROW()', A3: 'c', B3: '=ROW()', A4: 'd', B4: '=A4&"!"', C1: 'stay' });
    // A fixed sequence reverses the four rows.
    const seq = [0, 0, 0];
    let i = 0;
    const moved = b.wb.shuffleRows(b.id, parseRange('A1:B4'), { random: () => seq[i++] ?? 0 });
    expect(moved).toBeGreaterThan(0);
    const col = ['A1', 'A2', 'A3', 'A4'].map((a) => b.val(a));
    expect([...col].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(col).not.toEqual(['a', 'b', 'c', 'd']);
    // The row with "d" still concatenates its own A cell wherever it landed.
    const dRow = col.indexOf('d') + 1;
    expect(b.val(`B${dRow}`)).toBe('d!');
    expect(b.val('C1')).toBe('stay');
    b.wb.undo();
    expect(['A1', 'A2', 'A3', 'A4'].map((a) => b.val(a))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does nothing for a single row or a protected sheet', () => {
    const b = book({ A1: '1', A2: '2' });
    expect(b.wb.shuffleRows(b.id, parseRange('A1:A1'))).toBe(0);
    b.wb.setSheetProtected(b.id, true);
    expect(b.wb.shuffleRows(b.id, parseRange('A1:A2'))).toBe(0);
  });
});

describe('spill references (A1#)', () => {
  it('reads the whole spill of an array formula and follows it as it grows', () => {
    const b = book({ A1: '3', A2: '1', A3: '2', C1: '=SORT(A1:A3)', E1: '=SUM(C1#)', E2: '=ROWS(C1#)', F1: '=C1#*10' });
    expect(b.val('E1')).toBe(6);
    expect(b.val('E2')).toBe(3);
    expect(b.val('F1')).toBe(10);
    expect(b.val('F3')).toBe(30);
    b.set('C1', '=SORT(A1:A5)');
    b.set('A4', '9');
    b.set('A5', '4');
    expect(b.val('E1')).toBe(19);
    expect(b.val('E2')).toBe(5);
    expect(b.val('F5')).toBe(90);
  });

  it('is #REF! on a cell that does not spill and survives copy and insert', () => {
    const b = book({ A1: '5', B1: '=SUM(A1#)', C1: '=SEQUENCE(2)', D1: '=SUM(C1#)' });
    expect(b.val('B1')).toEqual(expect.objectContaining({ error: '#REF!' }));
    expect(b.val('D1')).toBe(3);
    // Copy D1 to E2: the relative anchor shifts and keeps its #.
    b.wb.pasteCells(b.id, b.wb.copyRange(b.id, parseRange('D1:D1')), 1, 4, { r: 0, c: 3 });
    expect(b.f('E2')).toBe('SUM(D2#)');
    b.wb.insertRows(b.id, 0, 1);
    expect(b.f('D2')).toBe('SUM(C2#)');
    expect(b.val('D2')).toBe(3);
  });
});

describe('removeDuplicates by chosen columns', () => {
  it('compares only the chosen columns and keeps the first of each match', () => {
    const b = book({ A1: 'ann', B1: '1', A2: 'Ann', B2: '2', A3: 'bob', B3: '1', A4: 'bob', B4: '1' });
    // Column A alone: "ann"/"Ann" match (case-insensitive), the two bobs match.
    const removed = b.wb.removeDuplicates(b.id, parseRange('A1:B4'), { columns: [0] });
    expect(removed).toBe(2);
    expect(['A1', 'A2', 'A3'].map((a) => b.val(a))).toEqual(['ann', 'bob', null]);
    expect(b.val('B1')).toBe(1);
    b.wb.undo();
    // All columns: only the identical bob rows match.
    expect(b.wb.removeDuplicates(b.id, parseRange('A1:B4'))).toBe(1);
    expect(b.val('A2')).toBe('Ann');
  });
});

describe('paste special', () => {
  it('pastes formulas only, keeping the target formatting, and skips blanks', () => {
    const b = book({ A1: '=1+1', A2: '', A3: 'x', C1: 'old', C2: 'keep', C3: 'z' });
    b.wb.applyStyle(b.id, parseRange('A1:A3'), { bold: true });
    b.wb.applyStyle(b.id, parseRange('C1:C3'), { color: '#ff0000' });
    const cells = b.wb.copyRange(b.id, parseRange('A1:A3'));
    b.wb.pasteCells(b.id, cells, 0, 2, { r: 0, c: 0 }, null, { keepStyles: true, skipBlanks: true });
    expect(b.f('C1')).toBe('1+1');
    expect(b.cell('C1').s).toEqual({ color: '#ff0000' });
    expect(b.val('C2')).toBe('keep');
    expect(b.val('C3')).toBe('x');
    expect(b.cell('C3').s.bold).toBeUndefined();
  });

  it('adds, subtracts, multiplies, and divides into plain numbers only', () => {
    const b = book({ A1: '10', A2: '20', A3: '=A1', A4: 'text', A5: '' });
    expect(b.wb.pasteOperation(b.id, [[5], [5], [5], [5], [5]], 0, 0, 'add')).toBe(3);
    expect(['A1', 'A2', 'A3', 'A4', 'A5'].map((a) => b.val(a))).toEqual([15, 25, 15, 'text', 5]);
    b.wb.pasteOperation(b.id, [[3]], 0, 0, 'mul');
    expect(b.val('A1')).toBe(45);
    b.wb.pasteOperation(b.id, [[0], [5]], 0, 0, 'div');
    expect(b.val('A1')).toEqual({ error: '#DIV/0!' }); // dividing by zero reads as the formula would
    expect(b.val('A2')).toBe(5);
    b.wb.pasteOperation(b.id, [[null, 1]], 0, 0, 'sub');
    expect(b.val('A1')).toEqual({ error: '#DIV/0!' }); // an error is not a plain number to operate on
    expect(b.val('B1')).toBe(-1);
  });
});

describe('protected ranges', () => {
  it('refuses edits inside the range, allows them outside, and undoes', () => {
    const b = book({ A1: '1', B1: '2', C1: '3' });
    const events = [];
    b.wb.addEventListener('change', (e) => { if (e.detail.type === 'protected') events.push(e.detail); });
    const id = b.wb.protectRange(b.id, parseRange('A1:B2'), 'Totals');
    b.set('A1', '99');
    expect(b.val('A1')).toBe(1);
    expect(events[0]).toMatchObject({ range: { r1: 0, c1: 0, r2: 1, c2: 1 }, description: 'Totals' });
    b.set('C1', '30');
    expect(b.val('C1')).toBe(30);
    // A paste that touches one protected cell does not half-land.
    b.wb.pasteValues(b.id, [['x', 'y', 'z']], 0, 1);
    expect(b.val('C1')).toBe(30);
    expect(b.wb.protectedRangeAt(b.id, 1, 1)).toMatchObject({ id, description: 'Totals' });
    expect(b.wb.protectedRangeAt(b.id, 2, 2)).toBeNull();
    b.wb.unprotectRange(b.id, id);
    b.set('A1', '99');
    expect(b.val('A1')).toBe(99);
    b.wb.undo(); // the edit
    b.wb.undo(); // the unprotect
    expect(b.wb.protectedRangeAt(b.id, 0, 0)).not.toBeNull();
  });

  it('follows inserted and deleted rows and survives a JSON round trip', () => {
    const b = book({ A5: 'x' });
    b.wb.protectRange(b.id, parseRange('A5:B6'), 'keep');
    b.wb.insertRows(b.id, 0, 2);
    expect(b.wb.sheet(b.id).protectedRanges[0].range).toEqual({ r1: 6, c1: 0, r2: 7, c2: 1 });
    b.wb.deleteRows(b.id, 0, 3);
    expect(b.wb.sheet(b.id).protectedRanges[0].range).toEqual({ r1: 3, c1: 0, r2: 4, c2: 1 });
    const copy = new Workbook(JSON.parse(JSON.stringify(b.wb.toJSON())));
    expect(copy.sheets[0].protectedRanges).toEqual([expect.objectContaining({ range: { r1: 3, c1: 0, r2: 4, c2: 1 }, description: 'keep' })]);
  });
});

describe('sort options', () => {
  it('sorts case-sensitively when asked, lowercase first', () => {
    const b = book({ A1: 'Apple', A2: 'apple', A3: 'banana', A4: 'Banana' });
    b.wb.sortRangeBy(b.id, parseRange('A1:A4'), [{ col: 0, ascending: true }], { caseSensitive: true });
    expect(['A1', 'A2', 'A3', 'A4'].map((a) => b.val(a))).toEqual(['apple', 'Apple', 'banana', 'Banana']);
    b.wb.sortRangeBy(b.id, parseRange('A1:A4'), [{ col: 0, ascending: false }], { caseSensitive: true });
    expect(['A1', 'A2', 'A3', 'A4'].map((a) => b.val(a))).toEqual(['Banana', 'banana', 'Apple', 'apple']);
    // Without the option, equal-ignoring-case values keep their order.
    const c = book({ A1: 'b', A2: 'B', A3: 'a' });
    c.wb.sortRangeBy(c.id, parseRange('A1:A3'), [{ col: 0, ascending: true }]);
    expect(['A1', 'A2', 'A3'].map((a) => c.val(a))).toEqual(['a', 'b', 'B']);
  });

  it('sorts columns left to right by a row, moving whole columns and shifting formulas', () => {
    const b = book({ A1: 'c', B1: 'a', C1: 'b', A2: '3', B2: '1', C2: '2', A3: '=A2*10', B3: '=B2*10', C3: '=C2*10' });
    b.wb.sortColumnsBy(b.id, parseRange('A1:C3'), [{ row: 0, ascending: true }]);
    expect(['A1', 'B1', 'C1'].map((a) => b.val(a))).toEqual(['a', 'b', 'c']);
    expect(['A2', 'B2', 'C2'].map((a) => b.val(a))).toEqual([1, 2, 3]);
    expect(['A3', 'B3', 'C3'].map((a) => b.val(a))).toEqual([10, 20, 30]);
    expect(b.f('A3')).toBe('A2*10');
    b.wb.undo();
    expect(b.val('A1')).toBe('c');
  });
});

describe('specialCells', () => {
  it('finds blanks, formulas, constants, errors, and notes as column runs', () => {
    const b = book({ A1: '1', A2: '', A3: '3', B1: '=A1', B2: '=1/0', B3: 'x', C1: '=SEQUENCE(3)' });
    b.wb.setNote(b.id, 2, 1, 'hi');
    const all = parseRange('A1:C3');
    expect(b.wb.specialCells(b.id, all, 'blanks')).toEqual([{ r1: 1, c1: 0, r2: 1, c2: 0 }]);
    expect(b.wb.specialCells(b.id, all, 'formulas')).toEqual([{ r1: 0, c1: 1, r2: 1, c2: 1 }, { r1: 0, c1: 2, r2: 0, c2: 2 }]);
    expect(b.wb.specialCells(b.id, all, 'constants')).toEqual([{ r1: 0, c1: 0, r2: 0, c2: 0 }, { r1: 2, c1: 0, r2: 2, c2: 0 }, { r1: 2, c1: 1, r2: 2, c2: 1 }]);
    expect(b.wb.specialCells(b.id, all, 'numbers')).toHaveLength(2);
    expect(b.wb.specialCells(b.id, all, 'text')).toEqual([{ r1: 2, c1: 1, r2: 2, c2: 1 }]);
    expect(b.wb.specialCells(b.id, all, 'errors')).toEqual([{ r1: 1, c1: 1, r2: 1, c2: 1 }]);
    expect(b.wb.specialCells(b.id, all, 'notes')).toEqual([{ r1: 2, c1: 1, r2: 2, c2: 1 }]);
    // Blanks stay inside the used area even when the range is larger.
    expect(b.wb.specialCells(b.id, parseRange('A1:Z50'), 'blanks')).toEqual([{ r1: 1, c1: 0, r2: 1, c2: 0 }]);
  });
});

describe('fill with Ctrl (invert)', () => {
  it('counts a single number up and repeats a run instead of continuing it', () => {
    const b = book({ A1: '5', C1: '1', C2: '2', E1: 'Jan' });
    b.wb.fill(b.id, parseRange('A1:A1'), parseRange('A1:A3'), { invert: true });
    expect(['A1', 'A2', 'A3'].map((a) => b.val(a))).toEqual([5, 6, 7]);
    b.wb.fill(b.id, parseRange('C1:C2'), parseRange('C1:C4'), { invert: true });
    expect(['C1', 'C2', 'C3', 'C4'].map((a) => b.val(a))).toEqual([1, 2, 1, 2]);
    b.wb.fill(b.id, parseRange('E1:E1'), parseRange('E1:E2'), { invert: true });
    expect(b.val('E2')).toBe('Jan');
    // The plain fill still does what it did.
    const c = book({ A1: '5', C1: '1', C2: '2' });
    c.wb.fill(c.id, parseRange('A1:A1'), parseRange('A1:A2'));
    expect(c.val('A2')).toBe(5);
    c.wb.fill(c.id, parseRange('C1:C2'), parseRange('C1:C3'));
    expect(c.val('C3')).toBe(3);
  });
});

describe('AI() and async providers', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  it('shows #BUSY! until the provider answers, then caches the answer per prompt', async () => {
    const b = book({ A1: 'apples', B1: '=AI("Translate to French", A1)' });
    const calls = [];
    b.wb.setAsyncProvider('AI', async (text) => { calls.push(text); return text.includes('apples') ? ' pommes ' : '42'; });
    expect(b.val('B1')).toEqual({ error: '#BUSY!' });
    await tick();
    expect(b.val('B1')).toBe('pommes');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('Translate to French\n\nData:\napples');
    b.set('C1', '=AI("Translate to French", A1)');
    expect(b.val('C1')).toBe('pommes');
    expect(calls).toHaveLength(1);
    b.set('D1', '=AI("How many?")&""');
    expect(b.val('D1')).toEqual({ error: '#BUSY!' });
    await tick();
    expect(b.val('D1')).toBe('42');
    b.set('E1', '=AI("How many?")');
    expect(b.val('E1')).toBe(42);
    // F9 forgets the answers and asks again.
    expect(b.wb.clearAsyncCache()).toBe(true);
    expect(b.val('E1')).toEqual({ error: '#BUSY!' });
    await tick();
    expect(calls).toHaveLength(3);
  });

  it('TRANSLATE and DETECTLANGUAGE ask the AI once per text and take its tidy answer', async () => {
    const b = book({ A1: 'Good morning', B1: '=TRANSLATE(A1, "en", "fr")', C1: '=TRANSLATE(A1, , "German")', D1: '=DETECTLANGUAGE(A1)', E1: '=GOOGLETRANSLATE("")' });
    const asked = [];
    b.wb.setAsyncProvider('TRANSLATE', async (text) => { asked.push(text); return text.includes('to fr') ? 'Bonjour' : 'Guten Morgen'; });
    b.wb.setAsyncProvider('DETECTLANGUAGE', async (text) => { asked.push(text); return 'en'; });
    expect(b.val('B1')).toEqual({ error: '#BUSY!' });
    expect(b.val('C1')).toEqual({ error: '#BUSY!' });
    expect(b.val('D1')).toEqual({ error: '#BUSY!' });
    expect(b.val('E1')).toBe('');
    await tick();
    expect(b.val('B1')).toBe('Bonjour');
    expect(b.val('C1')).toBe('Guten Morgen');
    expect(b.val('D1')).toBe('en');
    expect(asked.some((t) => t.startsWith('Translate the text between the markers from en to fr.') && t.includes('Good morning'))).toBe(true);
    expect(asked.some((t) => t.includes('from the language it is written in to German'))).toBe(true);
    expect(asked.some((t) => t.includes('ISO 639-1'))).toBe(true);
    b.set('F1', '=TRANSLATE(A1, "en", "fr")');
    expect(b.val('F1')).toBe('Bonjour'); // cached
    expect(asked).toHaveLength(3);
    const without = book({ A1: '=TRANSLATE("hi", "en", "fr")' });
    expect(without.val('A1')).toEqual({ error: '#N/A' });
  });

  it('is #N/A without a provider or when the provider fails', async () => {
    const b = book({ A1: '=AI("x")' });
    expect(b.val('A1')).toEqual({ error: '#N/A' });
    b.wb.setAsyncProvider('AI', async () => { throw new Error('offline'); });
    expect(b.val('A1')).toEqual({ error: '#BUSY!' });
    await tick();
    expect(b.val('A1')).toEqual({ error: '#N/A' });
  });
});

describe('filter by fill color', () => {
  it('lists the fills in a column and hides rows whose fill differs', () => {
    const b = book({ A1: 'Name', A2: 'a', A3: 'b', A4: 'c', A5: 'd' });
    b.wb.applyStyle(b.id, parseRange('A2:A2'), { bg: '#FFEEAA' });
    b.wb.applyStyle(b.id, parseRange('A3:A3'), { bg: '#ffeeaa' });
    b.wb.addRule(b.id, { range: parseRange('A4:A4'), type: 'eq', value: 'c', style: { bg: '#ff0000' } });
    b.wb.setFilterRange(b.id, parseRange('A1:A5'));
    expect(b.wb.filterColors(b.id, 0)).toEqual([{ color: '#ffeeaa', count: 2 }, { color: '#ff0000', count: 1 }, { color: '', count: 1 }]);
    b.wb.setFilterCriteria(b.id, 0, { color: '#ffeeaa' });
    expect([...b.wb.sheet(b.id).filterHidden].sort()).toEqual([3, 4]);
    b.wb.setFilterCriteria(b.id, 0, { color: '' });
    expect([...b.wb.sheet(b.id).filterHidden].sort()).toEqual([1, 2, 3]);
    b.wb.setFilterCriteria(b.id, 0, null);
    expect(b.wb.sheet(b.id).filterHidden.size).toBe(0);
  });
});

describe('sort by fill color', () => {
  it('brings rows with the chosen fill to the top or bottom, then sorts by value', () => {
    const b = book({ A1: 'c', A2: 'a', A3: 'd', A4: 'b' });
    b.wb.applyStyle(b.id, parseRange('A2:A2'), { bg: '#FFEEAA' });
    b.wb.applyStyle(b.id, parseRange('A3:A3'), { bg: '#ffeeaa' });
    expect(b.wb.columnFills(b.id, parseRange('A1:A4'), 0)).toEqual([{ color: '#ffeeaa', count: 2 }]);
    b.wb.sortRangeBy(b.id, parseRange('A1:A4'), [{ col: 0, ascending: true, color: '#FFEEAA' }, { col: 0, ascending: true }]);
    expect(['A1', 'A2', 'A3', 'A4'].map(b.val)).toEqual(['a', 'd', 'b', 'c']);
    b.wb.sortRangeBy(b.id, parseRange('A1:A4'), [{ col: 0, ascending: false, color: '#ffeeaa' }, { col: 0, ascending: true }]);
    expect(['A1', 'A2', 'A3', 'A4'].map(b.val)).toEqual(['b', 'c', 'a', 'd']);
  });
});

describe('undo history', () => {
  it('lists recent steps newest first and undoes or redoes several at once', () => {
    const b = book();
    b.set('A1', '1'); b.set('A2', '2'); b.set('A3', '3');
    expect(b.wb.undoLabels(2)).toEqual(['Edit cell', 'Edit cell']);
    expect(b.wb.undoSteps(2)).toBe(2);
    expect(b.val('A3')).toBeNull();
    expect(b.val('A2')).toBeNull();
    expect(b.val('A1')).toBe(1);
    expect(b.wb.redoLabels()).toHaveLength(2);
    expect(b.wb.redoSteps(5)).toBe(2);
    expect(b.val('A3')).toBe(3);
    expect(b.wb.redoLabels()).toEqual([]);
  });
});

describe('copying skips hidden rows and columns', () => {
  it('lists only the visible indices and copies just those cells', () => {
    const { wb, id, set } = book();
    for (let r = 0; r < 6; r++) { set(`A${r + 1}`, String(r + 1)); set(`B${r + 1}`, `b${r + 1}`); set(`C${r + 1}`, `c${r + 1}`); }
    wb.setHidden(id, 'row', [1, 2], true); // rows 2 and 3
    wb.setHidden(id, 'col', [1], true); // column B
    const all = parseRange('A1:C6');
    const { rows, cols, all: nothingHidden } = wb.visibleIndices(id, all);
    expect(rows).toEqual([0, 3, 4, 5]);
    expect(cols).toEqual([0, 2]);
    expect(nothingHidden).toBe(false);
    const cells = wb.copyCells(id, rows, cols);
    expect(cells.length).toBe(4);
    expect(cells.map((row) => row.map((c) => c?.v))).toEqual([[1, 'c1'], [4, 'c4'], [5, 'c5'], [6, 'c6']]);
    // Pasting the compact block lands the visible rows one under another.
    wb.pasteCells(id, cells, 10, 0, { r: 0, c: 0 });
    expect(wb.getValue(id, 10, 0)).toBe(1);
    expect(wb.getValue(id, 11, 0)).toBe(4);
    expect(wb.getValue(id, 11, 1)).toBe('c4');
    expect(wb.visibleIndices(id, parseRange('E5:E6')).all).toBe(true);
  });
});

describe('paste links', () => {
  it('writes formulas pointing at the copied cells, with the sheet name when it differs', () => {
    const { wb, id, set } = book({});
    set('A1', '10'); set('A2', '20'); set('B1', 'x'); set('B2', 'y');
    const other = wb.addSheet("Q1 'plan' v2"); // apostrophes inside the name; a sheet name may not start or end with one
    const n = wb.pasteLinks(other.id, 0, 0, id, [0, 1], [0, 1]);
    expect(n).toBe(4);
    expect(wb.getCell(other.id, 0, 0).f).toBe('Sheet1!A1');
    expect(wb.getCell(other.id, 1, 1).f).toBe('Sheet1!B2');
    expect(wb.getValue(other.id, 1, 0)).toBe(20);
    // Back the other way the awkward sheet name is quoted; on the same sheet no prefix at all.
    wb.pasteLinks(id, 5, 0, other.id, [0], [0]);
    expect(wb.getCell(id, 5, 0).f).toBe("'Q1 ''plan'' v2'!A1");
    expect(wb.getValue(id, 5, 0)).toBe(10);
    wb.pasteLinks(id, 7, 0, id, [0, 1], [0]);
    expect(wb.getCell(id, 8, 0).f).toBe('A2');
    set('A2', '25');
    expect(wb.getValue(id, 8, 0)).toBe(25);
    expect(wb.getValue(other.id, 1, 0)).toBe(25);
    // Hidden rows were skipped when copying: the links follow the visible rows only.
    wb.pasteLinks(id, 10, 0, id, [0, 1], [1]);
    expect(wb.getCell(id, 11, 0).f).toBe('B2');
    wb.undo();
    expect(wb.getCell(id, 11, 0)).toBeFalsy();
  });
});

describe('formulas to values', () => {
  it('replaces formulas and spilled results with plain values, keeping styles and skipping errors', () => {
    const { wb, id, set, cell } = book({});
    set('A1', '2'); set('A2', '3');
    set('B1', '=A1+A2'); wb.applyStyle(id, parseRange('B1:B1'), { fmt: 'currency', bold: true });
    set('C1', '=SEQUENCE(3)');
    set('D1', '=1/0');
    expect(wb.getValue(id, 2, 2)).toBe(3);
    const n = wb.formulasToValues(id, parseRange('A1:D3'));
    expect(n).toBe(2);
    expect(cell('B1')).toMatchObject({ v: 5, f: null, s: { fmt: 'currency', bold: true } });
    expect(cell('C1')).toMatchObject({ v: 1, f: null });
    expect(cell('C3')).toMatchObject({ v: 3, f: null });
    expect(cell('D1').f).toBe('1/0');
    set('A1', '100');
    expect(wb.getValue(id, 0, 1)).toBe(5);
    wb.undo(); wb.undo();
    expect(cell('B1').f).toBe('A1+A2');
    expect(wb.getValue(id, 2, 2)).toBe(3);
    expect(wb.formulasToValues(id, parseRange('A1:A2'))).toBe(0);
  });
});

describe('insert copied cells', () => {
  it('makes room and pastes, moving what was there down', () => {
    const { wb, id, set } = book({});
    set('A1', 'x1'); set('A2', 'x2'); set('A3', 'x3');
    set('C1', 'p1'); set('C2', 'p2');
    const cells = wb.copyRange(id, parseRange('C1:C2'));
    wb.transaction('Insert copied cells', () => {
      expect(wb.insertCells(id, parseRange('A2:A3'), 'down')).toBe(true);
      wb.pasteCells(id, cells, 1, 0, { r: 0, c: 2 }, null);
    });
    expect([0, 1, 2, 3, 4].map((r) => wb.getValue(id, r, 0))).toEqual(['x1', 'p1', 'p2', 'x2', 'x3']);
    wb.undo();
    expect([0, 1, 2, 3].map((r) => wb.getValue(id, r, 0))).toEqual(['x1', 'x2', 'x3', null]);
  });
});

describe('Plain text cells', () => {
  it('keep typed input exactly as typed, and show it back without an apostrophe', () => {
    const b = book();
    b.wb.applyStyle(b.id, parseRange('A1:A4'), { fmt: 'text' });
    b.set('A1', '00123');
    expect(b.cell('A1').v).toBe('00123');
    expect(b.cell('A1').s.fmt).toBe('text');
    expect(editText(b.cell('A1'))).toBe('00123');
    b.set('A2', '1/2');
    expect(b.cell('A2').v).toBe('1/2');
    b.set('A3', '=1+1');
    expect(b.cell('A3').f).toBe('1+1');
    expect(b.wb.getValue(b.id, 2, 0)).toBe(2);
    b.set('A4', "'quoted");
    expect(b.cell('A4').v).toBe('quoted');
    // Text that starts like a formula round-trips through the editor.
    b.set('A4', "'=not a formula");
    expect(b.cell('A4').v).toBe('=not a formula');
    expect(editText(b.cell('A4'))).toBe("'=not a formula");
    b.set('A4', editText(b.cell('A4')));
    expect(b.cell('A4').v).toBe('=not a formula');
    // Clearing keeps the format for the next entry.
    b.set('A1', '');
    expect(b.cell('A1')?.v ?? null).toBe(null);
    b.set('A1', '007');
    expect(b.cell('A1').v).toBe('007');
    // Ctrl+Enter fills honour it too, while a general cell still reads a number.
    b.wb.fillInput(b.id, parseRange('A2:B2'), '0042', { r: 1, c: 0 });
    expect(b.cell('A2').v).toBe('0042');
    expect(b.cell('B2').v).toBe(42);
  });
});

describe('copying a sheet to another workbook', () => {
  it('extracts one sheet with its names, tables, and styles into a new workbook', () => {
    const wb = new Workbook({ sheets: [{ name: 'Data' }, { name: 'Summary' }] });
    const [data, summary] = wb.sheets;
    const put = (sheet, a1, t) => { const { r, c } = parseCellRef(a1); wb.setInput(sheet.id, r, c, t); };
    put(data, 'A1', 'Item'); put(data, 'B1', 'Qty'); put(data, 'A2', 'Pen'); put(data, 'B2', '3'); put(data, 'A3', 'Ink'); put(data, 'B3', '4');
    wb.addTable(data.id, parseRange('A1:B3'), { name: 'Stock' });
    wb.applyStyle(data.id, parseRange('A1:B1'), { bold: true });
    wb.defineName('Total', 'Data!$B$2:$B$3');
    wb.defineName('Note', 'Summary!$A$1');
    put(summary, 'A1', '=SUM(Stock[Qty])');
    put(summary, 'B1', "=Data!B2*2");
    const one = wb.sheetToWorkbook(data.id);
    expect(one.sheets.map((s) => s.name)).toEqual(['Data']);
    expect(one.names.map((n) => n.name)).toEqual(['Total']);
    expect(one.sheets[0].tables[0].name).toBe('Stock');
    expect(one.getCell(one.sheets[0].id, 0, 0).s.bold).toBe(true);
    expect(one.getValue(one.sheets[0].id, 2, 1)).toBe(4);
    // The original is untouched, and the copy is independent.
    one.setInput(one.sheets[0].id, 1, 1, '30');
    expect(wb.getValue(data.id, 1, 1)).toBe(3);
    expect(wb.sheets).toHaveLength(2);
    // A sheet that reads another one retains a link and supporting source cells.
    const alone = wb.sheetToWorkbook(summary.id, { sourceWorkbook: '../Source.xlsx' });
    expect(alone.getCell(alone.sheets[0].id, 0, 1).f).toBe("'[1]Data'!B2*2");
    expect(alone.getValue(alone.sheets[0].id, 0, 1)).toBe(6);
    expect(alone.getValue(alone.sheets[0].id, 0, 0)).toBe(7);
    expect(wb.sheetToWorkbook('nope')).toBeNull();
  });

  it('lands in another workbook after its sheets, with a unique name and table name', () => {
    const src = new Workbook({ sheets: [{ name: 'Sheet1' }] });
    src.setInput(src.sheets[0].id, 0, 0, 'Region'); src.setInput(src.sheets[0].id, 1, 0, 'East');
    src.addTable(src.sheets[0].id, parseRange('A1:A2'), { name: 'Sales' });
    const dst = new Workbook({ sheets: [{ name: 'Sheet1' }] });
    dst.setInput(dst.sheets[0].id, 0, 0, 'Other'); dst.setInput(dst.sheets[0].id, 1, 0, 'x');
    dst.addTable(dst.sheets[0].id, parseRange('A1:A2'), { name: 'Sales' });
    const added = dst.importSheets(src.sheetToWorkbook(src.sheets[0].id));
    expect(added).toHaveLength(1);
    expect(dst.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Sheet1 (2)']);
    expect(added[0].tables[0].name).toBe('Sales2');
    expect(dst.getValue(added[0].id, 1, 0)).toBe('East');
    expect(dst.canUndo()).toBe(true);
    dst.undo();
    expect(dst.sheets).toHaveLength(1);
  });
});

describe('placing an imported workbook', () => {
  function pair() {
    const wb = new Workbook({ sheets: [{ name: 'Main' }, { name: 'Other' }] });
    const main = wb.sheets[0];
    wb.setInput(main.id, 0, 0, 'Existing'); wb.setInput(main.id, 1, 0, '1'); wb.setInput(main.id, 2, 0, '2');
    const other = new Workbook({ sheets: [{ name: 'Data' }] });
    const d = other.sheets[0];
    other.setInput(d.id, 1, 1, 'Item'); other.setInput(d.id, 1, 2, 'Qty');
    other.setInput(d.id, 2, 1, 'Pen'); other.setInput(d.id, 2, 2, '3');
    other.setInput(d.id, 3, 1, 'Total'); other.setInput(d.id, 3, 2, '=SUM(C3:C3)');
    other.applyStyle(d.id, parseRange('B2:C2'), { bold: true });
    other.addTable(d.id, parseRange('B2:C3'), { name: 'Stock' });
    return { wb, main, other, d };
  }

  it('appends below the used rows and places at a cell, shifting relative references', () => {
    const { wb, main, other, d } = pair();
    const range = wb.placeSheetAt(main.id, other, d.id, 3, 0);
    expect(range).toEqual({ r1: 3, c1: 0, r2: 5, c2: 1 });
    expect(wb.getValue(main.id, 3, 0)).toBe('Item');
    expect(wb.getCell(main.id, 3, 0).s.bold).toBe(true);
    expect(wb.getCell(main.id, 5, 1).f).toBe('SUM(B5:B5)');
    expect(wb.getValue(main.id, 5, 1)).toBe(3);
    expect(wb.getValue(main.id, 0, 0)).toBe('Existing');
    wb.undo();
    expect(wb.getCell(main.id, 3, 0)).toBeUndefined();
    expect(wb.getValue(main.id, 2, 0)).toBe(2);
    const at = wb.placeSheetAt(main.id, other, d.id, 0, 3);
    expect(at).toEqual({ r1: 0, c1: 3, r2: 2, c2: 4 });
    expect(wb.getValue(main.id, 0, 3)).toBe('Item');
    expect(wb.getCell(main.id, 2, 4).f).toBe('SUM(E2:E2)');
    expect(wb.placeSheetAt(main.id, other, d.id, 1048575, 0)).toBeNull();
    expect(wb.placeSheetAt(main.id, other, 'nope', 0, 0)).toBeNull();
  });

  it('replaces the current sheet keeping its name and position, and can be undone', () => {
    const { wb, main, other, d } = pair();
    wb.setSheetColor(main.id, '#c22a2a');
    const sheet = wb.replaceSheetWith(main.id, other, d.id);
    expect(sheet.id).toBe(main.id);
    expect(wb.sheets.map((s) => s.name)).toEqual(['Main', 'Other']);
    expect(wb.sheet(main.id).color).toBe('#c22a2a');
    expect(wb.getCell(main.id, 0, 0)).toBeUndefined();
    expect(wb.getValue(main.id, 1, 1)).toBe('Item');
    expect(wb.getValue(main.id, 3, 2)).toBe(3);
    expect(wb.sheet(main.id).tables[0].name).toBe('Stock');
    wb.undo();
    expect(wb.getValue(main.id, 0, 0)).toBe('Existing');
    expect(wb.sheet(main.id).tables).toHaveLength(0);
    expect(wb.replaceSheetWith('nope', other, d.id)).toBeNull();
  });
});

describe('filter by custom formula', () => {
  it('keeps the rows where a formula written for the first data row is TRUE', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    const rows = [['Item', 'Qty', 'Price'], ['Pen', '3', '1.5'], ['Ink', '12', '8'], ['Pad', '7', '2'], ['Cap', '20', '0.5']];
    rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
    wb.setFilterRange(id, parseRange('A1:C5'));
    wb.setFilterCriteria(id, 1, { formula: '=B2*C2>10' });
    expect([...wb.sheets[0].filterHidden].sort()).toEqual([1, 4]); // Pen (4.5) and Cap (10) go; Ink (96) and Pad (14) stay
    wb.setInput(id, 1, 1, '30'); // Pen now 45: the filter follows the data
    wb.reapplyFilter(id);
    expect([...wb.sheets[0].filterHidden]).toEqual([4]);
    const copy = new Workbook(wb.toJSON());
    expect(copy.sheets[0].filter.criteria[1]).toEqual({ formula: '=B2*C2>10' });
    expect([...copy.sheets[0].filterHidden]).toEqual([4]);
    // A formula on another column shifts its relative rows only.
    wb.setFilterCriteria(id, 1, null);
    wb.setFilterCriteria(id, 2, { formula: '=$A2="Ink"' });
    expect([...wb.sheets[0].filterHidden].sort()).toEqual([1, 3, 4]);
  });
});

describe('rearranging rows under a filter', () => {
  const setup = () => {
    const b = book({ A1: 'Qty', A2: '3', A3: '1', A4: '2', A5: '1' });
    b.wb.setFilterRange(b.id, parseRange('A1:A5'));
    b.wb.setFilterCriteria(b.id, 0, { op: 'gt', value: 1 });
    const hidden = () => [...b.wb.sheet(b.id).filterHidden].sort();
    expect(hidden()).toEqual([2, 4]);
    return { ...b, hidden };
  };
  const column = (b) => [1, 2, 3, 4].map((r) => b.wb.getValue(b.id, r, 0));

  it('hides the rows the criteria exclude after a sort, and again after undo and redo as one step', () => {
    const b = setup();
    const layouts = [];
    b.wb.addEventListener('change', (e) => { if (e.detail.type === 'layout') layouts.push(e.detail.type); });
    const history = b.wb._history.length;
    b.wb.sortRange(b.id, parseRange('A2:A5'), 0, true);
    expect(column(b)).toEqual([1, 1, 2, 3]);
    expect(b.hidden()).toEqual([1, 2]);
    expect(b.wb._history.length).toBe(history + 1);
    expect(layouts.length).toBeGreaterThan(0);
    b.wb.undo();
    expect(column(b)).toEqual([3, 1, 2, 1]);
    expect(b.hidden()).toEqual([2, 4]);
    b.wb.redo();
    expect(column(b)).toEqual([1, 1, 2, 3]);
    expect(b.hidden()).toEqual([1, 2]);
  });

  it('refilters after a shuffle and after removing duplicates', () => {
    const b = setup();
    b.wb.shuffleRows(b.id, parseRange('A2:A5'), { random: () => 0 });
    const rows = column(b);
    expect(b.hidden()).toEqual(rows.map((v, i) => (v <= 1 ? i + 1 : null)).filter((r) => r != null));
    const c = setup();
    expect(c.wb.removeDuplicates(c.id, parseRange('A2:A5'))).toBe(1);
    expect(column(c)).toEqual([3, 1, 2, null]);
    expect(c.hidden()).toEqual([2, 4]);
  });

  it('leaves the filter alone when the sorted rows lie outside it', () => {
    const b = setup();
    b.wb.setInput(b.id, 7, 0, '9');
    b.wb.setInput(b.id, 8, 0, '8');
    const history = b.wb._history.length;
    b.wb.sortRange(b.id, parseRange('A8:A9'), 0, true);
    expect(b.hidden()).toEqual([2, 4]);
    expect(b.wb._history.length).toBe(history + 1);
  });
});
