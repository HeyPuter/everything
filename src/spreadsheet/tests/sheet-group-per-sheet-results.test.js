import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Change case and Paste Special's Add, Subtract, Multiply and Divide were carried to grouped sheets the way typing is:
// the active sheet's results were written over the same cells of the others. UPPERCASE on Jan, grouped with Feb, put
// Jan's "ALPHA" in place of Feb's "beta", and Paste Special ▸ Add 5 left Feb's 20 as Jan's 15. Each sheet now works
// out its own result from its own cells, as an inserted row or a format does.
function book() {
  const wb = new Workbook({ sheets: [{ name: 'Jan' }, { name: 'Feb' }] });
  const [a, b] = wb.sheets.map((s) => s.id);
  wb.setInput(a, 0, 0, 'alpha'); wb.setInput(b, 0, 0, 'beta');
  wb.setInput(a, 1, 0, '10'); wb.setInput(b, 1, 0, '20');
  wb.groupSheets([b]);
  wb.clearHistory();
  return { wb, a, b };
}

describe('grouped sheets', () => {
  it('change the case of each sheet’s own text, as one undo step', () => {
    const { wb, a, b } = book();
    wb.transformText(a, { r1: 0, c1: 0, r2: 0, c2: 0 }, 'upper');
    expect([wb.getValue(a, 0, 0), wb.getValue(b, 0, 0)]).toEqual(['ALPHA', 'BETA']);
    expect(wb.undoLabels()).toHaveLength(1);
    wb.undo();
    expect([wb.getValue(a, 0, 0), wb.getValue(b, 0, 0)]).toEqual(['alpha', 'beta']);
  });

  it('add a pasted number to each sheet’s own numbers', () => {
    const { wb, a, b } = book();
    wb.pasteOperation(a, [[5]], 1, 0, 'add');
    expect([wb.getValue(a, 1, 0), wb.getValue(b, 1, 0)]).toEqual([15, 25]);
    wb.undo();
    expect([wb.getValue(a, 1, 0), wb.getValue(b, 1, 0)]).toEqual([10, 20]);
  });
});
