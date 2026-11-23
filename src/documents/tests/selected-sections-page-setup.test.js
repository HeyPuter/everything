import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { createDocx } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';

// Page settings chosen from the ribbon (margins, orientation, paper size) go to every section the selection
// reaches, as Word's "Selected sections" (ECMA-376 Part 1 §17.6.17 sectPr, §17.6.13 pgSz, §17.6.11 pgMar);
// Orientation turns each section's own page.
let dom;
beforeAll(() => { dom = new JSDOM(); for (const name of ['Node', 'document', 'DOMParser', 'XMLSerializer']) globalThis[name] = dom.window[name]; });
afterAll(() => { dom.window.close(); for (const name of ['Node', 'document', 'DOMParser', 'XMLSerializer']) delete globalThis[name]; });

/** Three sections: Letter with one-inch margins, A4 with half-inch margins, and Letter again. */
function threeSections() {
  const pkg = createDocx(['One', 'Two', 'Three'].map(text => paragraph(text)));
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  doc.select(3); doc.insertSectionBreak('nextPage');
  doc.select(doc.text.indexOf('Three')); doc.insertSectionBreak('nextPage');
  doc.select(doc.text.indexOf('Two'));
  doc.setPageSettings({ width: 11906, height: 16838, top: 720, bottom: 720, left: 720, right: 720 });
  return doc;
}
const pages = doc => doc.sectionSettings.map(s => [s.orientation, s.width, s.height, s.top, s.left]);

it('applies margins to each section the selection reaches, and to the caret\'s section alone without one', () => {
  const doc = threeSections();
  expect(doc.sectionCount).toBe(3);
  doc.select(doc.text.indexOf('ne'), doc.text.indexOf('wo'));
  expect(doc.setPageSettings({ top: 2160, bottom: 2160, left: 2160, right: 2160 })).toBe(true);
  expect(doc.sectionSettings.map(s => s.top)).toEqual([2160, 2160, 1440]);
  doc.undo();
  expect(doc.sectionSettings.map(s => s.top)).toEqual([1440, 720, 1440]);
  doc.select(doc.text.indexOf('Three'));
  doc.setPageSettings({ top: 2160 });
  expect(doc.sectionSettings.map(s => s.top)).toEqual([1440, 720, 2160]);
  // A section named outright is the only one changed, whatever is selected.
  doc.select(0, doc.text.length);
  doc.setPageSettings({ top: 360 }, { scope: 'section', section: 1 });
  expect(doc.sectionSettings.map(s => s.top)).toEqual([1440, 360, 2160]);
});

it('turns each selected section\'s own page with a patch made from its settings', () => {
  const doc = threeSections();
  doc.select(0, doc.text.length);
  const turn = s => s.orientation === 'landscape' ? {} : { orientation: 'landscape', width: s.height, height: s.width, top: s.left, bottom: s.right, left: s.bottom, right: s.top };
  expect(doc.setPageSettings(turn)).toBe(true);
  expect(pages(doc)).toEqual([['landscape', 15840, 12240, 1440, 1440], ['landscape', 16838, 11906, 720, 720], ['landscape', 15840, 12240, 1440, 1440]]);
  // Already turned: nothing changes.
  expect(doc.setPageSettings(turn)).toBe(false);
  doc.undo();
  expect(pages(doc)).toEqual([['portrait', 12240, 15840, 1440, 1440], ['portrait', 11906, 16838, 720, 720], ['portrait', 12240, 15840, 1440, 1440]]);
});
