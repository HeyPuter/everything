import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Change Text (UPPERCASE, lowercase, Proper Case, Trim spaces) and Convert to numbers rewrote each cell with its
// new text and its format alone, so a cell's link was lost along the way: "docs" linking to a page became a
// plain "DOCS".
it('keeps the links of the cells it rewrites', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'docs');
  wb.setLink(id, 0, 0, 'https://example.com/docs', 'docs');
  wb.setInput(id, 1, 0, "'  2024 report ");
  wb.setLink(id, 1, 0, 'https://example.com/report', '  2024 report ');
  wb.setInput(id, 2, 0, "'123");
  wb.setLink(id, 2, 0, 'https://example.com/123', '123');
  for (const kind of ['upper', 'proper', 'lower', 'trim']) wb.transformText(id, { r1: 0, c1: 0, r2: 1, c2: 0 }, kind);
  expect(wb.getValue(id, 0, 0)).toBe('docs');
  expect(wb.linkAt(id, 0, 0)?.url).toBe('https://example.com/docs');
  expect(wb.getValue(id, 1, 0)).toBe('2024 report');
  expect(wb.linkAt(id, 1, 0)?.url).toBe('https://example.com/report');
  wb.transformText(id, { r1: 2, c1: 0, r2: 2, c2: 0 }, 'number');
  expect(wb.getValue(id, 2, 0)).toBe(123);
  expect(wb.linkAt(id, 2, 0)?.url).toBe('https://example.com/123');
  wb.undo();
  expect(wb.getValue(id, 2, 0)).toBe('123');
  expect(wb.linkAt(id, 2, 0)?.url).toBe('https://example.com/123');
});
