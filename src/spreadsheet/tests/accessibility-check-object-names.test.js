import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { checkAccessibility } from '../src/core/accessibility-check.js';
import { objectNames } from '../src/core/arrange.js';

// Check Accessibility named an object missing its alt text by its place among all the sheet's objects, or by its
// title: a picture after a chart was "Picture 2", a shape was a "Picture", a text box "TextBox 1", and a name given
// in the Selection Pane was not used. The Selection Pane, where the object is found and renamed, called the same
// objects "Picture 1", "Text Box 1" or the name given: the result named an object the user could not find. It now
// names each object as the Selection Pane does.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

it('names objects missing alt text as the Selection Pane names them', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Region'); wb.setInput(id, 1, 0, 'North'); wb.setInput(id, 0, 1, 'Units'); wb.setInput(id, 1, 1, '4');
  wb.addChart(id, { type: 'column', range: { r1: 0, c1: 0, r2: 1, c2: 1 }, title: 'Units by region', anchor: { r: 3, c: 3 }, w: 300, h: 200, description: 'Units by region' });
  const picture = wb.addChart(id, { type: 'image', src: PNG, anchor: { r: 3, c: 9 }, w: 40, h: 40 });
  const box = wb.addChart(id, { type: 'text', text: 'Callout', anchor: { r: 8, c: 9 }, w: 120, h: 40 });
  const named = wb.addChart(id, { type: 'text', text: 'Other', anchor: { r: 12, c: 9 }, w: 120, h: 40 });
  wb.renameObject(id, named, 'Footnote');
  const names = objectNames(wb.sheet(id).charts);
  expect([picture, box, named].map((x) => names.get(x))).toEqual(['Picture 1', 'Text Box 1', 'Footnote']);
  const labels = checkAccessibility(wb).filter((f) => f.rule === 'altText').map((f) => f.label);
  expect(labels).toEqual(['Picture 1 (Sheet1)', 'Text Box 1 (Sheet1)', 'Footnote (Sheet1)']);
});
