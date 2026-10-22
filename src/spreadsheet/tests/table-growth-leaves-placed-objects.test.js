import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';

// A table growing over a new row takes the charts that plot its data down with it. A text box, shape or equation
// sitting on the table's last row was taken for such a chart: its range, which is only the cell it sits on, grew a
// row, so the box no longer read back as it was written (a reload, or a co-author applying the change, put it back
// on its one cell) and a shared workbook's copies stopped agreeing. Only charts that plot a range grow now.
function book() {
  const wb = new Workbook({ sheets: [{ name: 'S' }] });
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Item');
  wb.setInput(id, 0, 1, 'Qty');
  for (let r = 1; r <= 3; r++) { wb.setInput(id, r, 0, `i${r}`); wb.setInput(id, r, 1, String(r)); }
  wb.addTable(id, { r1: 0, c1: 0, r2: 3, c2: 1 });
  return { wb, id };
}

describe('a table growing under a text box', () => {
  it('leaves the box on its cell, as the workbook reads it back', () => {
    const { wb, id } = book();
    wb.addChart(id, { type: 'text', text: 'Note', anchor: { r: 3, c: 1 }, w: 120, h: 40 });
    wb.setInput(id, 4, 0, 'i4');
    expect(wb.sheet(id).tables[0].range.r2).toBe(4);
    const box = wb.sheet(id).charts[0];
    expect(box.range).toEqual({ r1: 3, c1: 1, r2: 3, c2: 1 });
    expect(new Workbook(wb.toJSON()).sheets[0].charts[0].range).toEqual(box.range);
  });

  it('keeps two copies of a shared workbook alike', async () => {
    const initial = book().wb.toJSON();
    const [a, b] = [0, 1].map(() => { const wb = new Workbook(JSON.parse(JSON.stringify(initial))); return { wb, rep: new Replica(wb) }; });
    const id = a.wb.activeSheetId;
    a.wb.addChart(id, { type: 'text', text: 'Note', anchor: { r: 3, c: 1 }, w: 120, h: 40 });
    a.wb.setInput(id, 4, 0, 'i4');
    await null;
    b.rep.receive([{ rev: 1, user: 'a', username: 'a', changes: JSON.parse(JSON.stringify(a.rep.outgoing())) }]);
    expect(b.wb.sheets[0].charts.map((c) => c.range)).toEqual(a.wb.sheets[0].charts.map((c) => c.range));
  });
});
