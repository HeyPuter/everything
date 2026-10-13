import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { startRecorder, cellLines, formatLines } from '../src/core/script-recorder.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';
import { styleToNumFmt } from '../src/core/format.js';

/** Each sheet's cells (inputs and styles), merges, hidden lines, widths and tables: what a replay must reproduce. */
function picture(wb) {
  return wb.sheets.map((s) => ({
    name: s.name,
    hidden: !!s.hidden,
    cells: Object.fromEntries([...s.cells].filter(([, c]) => c.v != null || c.f != null || c.s).map(([k, c]) => [k, { v: c.v ?? null, f: c.f ?? null, s: c.s || null }])),
    merges: s.merges.map((m) => ({ ...m })),
    hiddenRows: [...s.hiddenRows].sort(),
    widths: [...s.colWidths].sort(),
    tables: s.tables.map((t) => ({ name: t.name, range: t.range })),
    frozen: [s.frozenRows, s.frozenCols],
  }));
}
function start() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Name', 'Qty'], ['pear', '3'], ['apple', '1'], ['fig', '2']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  wb.clearHistory();
  return wb;
}

describe('recorder', () => {
  it('records edits as a script that replays them exactly', async () => {
    const wb = start();
    const json = wb.toJSON();
    const id = wb.activeSheetId;
    const rec = startRecorder(wb, { name: 'Tidy up' });
    wb.setInput(id, 0, 2, 'Total');
    wb.setInput(id, 1, 2, '=B2*2');
    wb.setInput(id, 2, 2, '007', { literal: true });
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 2 }, { bold: true, bg: '#dbeafe' });
    wb.applyStyle(id, { r1: 1, c1: 1, r2: 3, c2: 1 }, { fmt: 'currency', dec: 2 });
    wb.applyBorders(id, { r1: 0, c1: 0, r2: 3, c2: 2 }, 'outer', { style: 'medium' });
    wb.sortRangeBy(id, { r1: 1, c1: 0, r2: 3, c2: 2 }, [{ col: 0, ascending: true }]);
    wb.insertRows(id, 1, 1);
    wb.setInput(id, 1, 0, 'inserted');
    wb.fill(id, { r1: 2, c1: 2, r2: 2, c2: 2 }, { r1: 2, c1: 2, r2: 4, c2: 2 });
    wb.mergeCells(id, { r1: 7, c1: 0, r2: 7, c2: 2 });
    for (const c of [3, 4, 5]) wb.setColWidth(id, c, 140);
    wb.setHidden(id, 'row', [9, 10], true);
    wb.setFrozen(id, 1, 0);
    // An entry written by a route the recorder knows only by its cells, with formatting.
    wb.setCells(id, [{ r: 12, c: 0, cell: { v: 5, f: null, s: { bold: true } } }, { r: 12, c: 1, cell: { v: 'x', f: null, s: { bold: true } } }], 'Paste');
    const other = wb.addSheet('Notes');
    wb.setInput(other.id, 0, 0, 'hello');
    wb.renameSheet(other.id, 'Memo');
    wb.setActiveSheet(id);
    wb.addTable(id, { r1: 0, c1: 0, r2: 4, c2: 2 }, { name: 'Fruit' });
    // Undone, then redone: it stays. Undone and replaced: it goes.
    wb.setInput(id, 20, 0, 'gone');
    wb.undo();
    wb.setInput(id, 21, 0, 'kept');
    wb.undo();
    wb.redo();
    const code = rec.stop();
    expect(code).toMatch(/^\/\*\*\n \* Tidy up: recorded/);
    expect(code).toContain('async function main(workbook) {');
    expect(code).not.toContain('gone');
    expect(code).toContain('sheet.getRange("D:F").getFormat().setColumnWidth(140);');
    expect(code).toContain('sheet.getRange("C3").setValue("007", { asText: true });');
    expect(code).toContain('workbook.getWorksheet("Notes").setName("Memo");');
    expect(code).not.toContain('Not recorded');

    const replay = new Workbook(json);
    const res = await runScript({ wb: replay, code, transport: nodeTransport() });
    expect(res.error).toBe(null);
    expect(picture(replay)).toEqual(picture(wb));
    // The recording is done with: the workbook's methods are its own again.
    expect(Object.hasOwn(wb, 'setInput')).toBe(false);
    expect(Object.hasOwn(wb, 'undo')).toBe(false);
  });

  it('records deleted rows and columns from the far end back', () => {
    const wb = start();
    const rec = startRecorder(wb);
    wb.deleteLines(wb.activeSheetId, 'row', [{ from: 1, to: 1 }, { from: 3, to: 3 }]);
    wb.deleteCols(wb.activeSheetId, 1, 1);
    const code = rec.stop();
    expect(code.indexOf('getRange("4:4").delete()')).toBeLessThan(code.indexOf('getRange("2:2").delete()'));
    expect(code).toContain('sheet.getRange("B:B").delete();');
  });

  it('notes what it cannot express instead of dropping it silently', () => {
    const wb = start();
    const rec = startRecorder(wb);
    wb.addChart(wb.activeSheetId, { type: 'image', src: 'data:image/png;base64,AAAA', anchor: { r: 0, c: 0 }, w: 50, h: 50 });
    expect(rec.count()).toBe(1);
    expect(rec.stop()).toContain('// Not recorded: inserted picture');
  });

  it('switches the sheet variable only when the sheet changes', () => {
    const wb = start();
    const a = wb.activeSheetId;
    const b = wb.addSheet('B').id;
    wb.setActiveSheet(a);
    const rec = startRecorder(wb);
    wb.setInput(a, 0, 0, '1');
    wb.setInput(a, 1, 0, '2');
    wb.setInput(b, 0, 0, '3');
    wb.setInput(a, 2, 0, '4');
    const code = rec.stop();
    expect(code.match(/^  sheet = workbook/gm)).toHaveLength(2);
    expect(code).toContain('let sheet = workbook.getActiveWorksheet();');
  });

  it('writes blocks of cells as one setValues and formats as format calls', () => {
    expect(cellLines([{ r: 0, c: 0, value: 1 }, { r: 0, c: 1, value: '=A1' }, { r: 1, c: 0, value: 'a' }, { r: 1, c: 1, value: null }]))
      .toEqual(['sheet.getRange("A1:B2").setValues([[1, "=A1"],\n    ["a", null]]);']);
    expect(formatLines({ r1: 0, c1: 0, r2: 0, c2: 0 }, { italic: true, size: 20, align: null, fmt: 'percent', dec: 1 }, { fmt: 'percent', dec: 1 })).toEqual([
      'sheet.getRange("A1").getFormat().getFont().setItalic(true);',
      'sheet.getRange("A1").getFormat().getFont().setSize(15);',
      'sheet.getRange("A1").getFormat().setHorizontalAlignment("general");',
      `sheet.getRange("A1").setNumberFormat(${JSON.stringify(styleToNumFmt({ fmt: 'percent', dec: 1 }))});`,
    ]);
  });
});
