import { expect, it } from 'vitest';
import { cellStyle } from '../src/core/cellstyles.js';
import { Doc } from '../src/lib/doc.js';

// Cell styles store sizes in pixels. Title, Heading and Subheading were 20, 15 and 13 pixels, sized against a
// 13-pixel body, so in a new spreadsheet, whose text is 11-point Calibri (14.67 pixels), Heading read 11.25 points,
// hardly larger than the text, and Subheading 9.75, smaller than it. They are Excel's Title, Heading 1 and
// Heading 2 sizes now: 18, 15 and 13 points.
it('sizes the heading styles above the text of a new spreadsheet', () => {
  const points = (key) => Math.round(cellStyle(key).patch.size * 75) / 100;
  expect(['title', 'heading', 'subheading'].map(points)).toEqual([18, 15, 13]);
  const wb = Doc.blank({ excel: true }).wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Text');
  const body = wb.styleAt(id, 0, 0).size;
  expect(body).toBeCloseTo(14.67, 1);
  for (const key of ['title', 'heading', 'subheading']) expect(cellStyle(key).patch.size, key).toBeGreaterThan(body);
});
