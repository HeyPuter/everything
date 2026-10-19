import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Dragging the fill handle from a cell with a dropdown, or pressing Ctrl+D under it, left the filled cells without
// the rule: they took anything typed. Excel's fill carries data validation, the usual way to extend a dropdown
// down a column, and a custom rule's relative references follow each filled cell.
const rule = (wb, id, r, c) => wb.validationAt(id, r, c);

it('takes an empty dropdown cell\'s rule down the column with the fill handle', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.addValidation(id, { range: { r1: 0, c1: 0, r2: 0, c2: 0 }, type: 'list', source: 'Yes,No', strict: true });
  wb.fill(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { r1: 0, c1: 0, r2: 3, c2: 0 });
  expect(rule(wb, id, 3, 0)?.type).toBe('list');
  expect(wb.validateInput(id, 3, 0, 'Maybe').ok).toBe(false);
  expect(wb.validateInput(id, 3, 0, 'No').ok).toBe(true);
  expect(rule(wb, id, 4, 0)).toBe(null);
  wb.undo();
  expect(rule(wb, id, 3, 0)).toBe(null);
  expect(rule(wb, id, 0, 0)?.type).toBe('list');
});

it('moves a custom rule\'s relative references with each filled cell, down and across', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.addValidation(id, { range: { r1: 0, c1: 2, r2: 0, c2: 2 }, type: 'formula', source: '=C1>B1', strict: true });
  wb.fill(id, { r1: 0, c1: 2, r2: 0, c2: 2 }, { r1: 0, c1: 2, r2: 3, c2: 2 });
  wb.setInput(id, 3, 1, '5');
  expect(wb.validateInput(id, 3, 2, '4').ok).toBe(false);
  expect(wb.validateInput(id, 3, 2, '6').ok).toBe(true);
  wb.fill(id, { r1: 0, c1: 2, r2: 0, c2: 2 }, { r1: 0, c1: 2, r2: 0, c2: 4 });
  wb.setInput(id, 0, 3, '9');
  expect(wb.validateInput(id, 0, 4, '8').ok).toBe(false);
});

it('carries the rule with Ctrl+D and replaces a filled cell\'s own rule with the source\'s (or none)', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.addValidation(id, { range: { r1: 0, c1: 0, r2: 0, c2: 0 }, type: 'list', source: 'Yes,No', strict: true });
  wb.addValidation(id, { range: { r1: 2, c1: 0, r2: 2, c2: 0 }, type: 'whole', min: 1, max: 3, strict: true });
  wb.fillDirection(id, { r1: 0, c1: 0, r2: 3, c2: 0 }, 'down');
  expect([1, 2, 3].map((r) => rule(wb, id, r, 0)?.type)).toEqual(['list', 'list', 'list']);
  wb.addValidation(id, { range: { r1: 0, c1: 5, r2: 0, c2: 5 }, type: 'list', source: 'a,b' });
  wb.fill(id, { r1: 0, c1: 6, r2: 0, c2: 6 }, { r1: 0, c1: 5, r2: 0, c2: 6 });
  expect(rule(wb, id, 0, 5)).toBe(null);
});

it('leaves the rules alone when the sheet is protected', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.addValidation(id, { range: { r1: 0, c1: 0, r2: 0, c2: 0 }, type: 'list', source: 'Yes,No' });
  wb.setSheetProtected(id, true);
  wb.fill(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { r1: 0, c1: 0, r2: 3, c2: 0 });
  expect(rule(wb, id, 3, 0)).toBe(null);
});
