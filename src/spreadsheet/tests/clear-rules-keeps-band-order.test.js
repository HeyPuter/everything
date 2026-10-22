import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { clearRules } from '../src/ui/condformat-quick.js';

// Clearing the rules from part of an alternating-colours rule (Clear Rules from Selected Cells, Clear Formats)
// left a piece below the cleared cells that started over with a header row and swapped its two colours.
// What is left keeps counting from the rule's first row.
const bands = (wb, id) => Array.from({ length: 10 }, (_, r) => wb.conditionalStyle(id, r, 2, wb.getValue(id, r, 2))?.bg ?? null);

it.each(['C5:C6', 'C1', 'B3:D3'])('keeps the bands of what is left in place after clearing %s', (cut) => {
  const wb = new Workbook(), id = wb.activeSheetId;
  for (let i = 0; i < 10; i++) wb.setInput(id, i, 2, String(i));
  wb.addRule(id, { range: parseRange('C1:C10'), type: 'bands', color1: '#111111', color2: '#222222', headerColor: '#999999', header: true, style: {} });
  const before = bands(wb, id);
  clearRules(wb, id, [parseRange(cut)]);
  const g = parseRange(cut);
  expect(bands(wb, id)).toEqual(before.map((bg, r) => (r >= g.r1 && r <= g.r2 ? null : bg)));
});
