import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { insertCaption, referenceTargets, insertCrossReference } from '../src/engine/captions.js';
import { updateSequenceFields } from '../src/engine/field-update.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

async function captionedDocument() {
  const blank = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const pkg = await DocxPackage.open(new Uint8Array(await blank.export().arrayBuffer()));
  const d = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  d.replace('Chart here\nSee the reference: \nFinal paragraph with more words');
  d.select(3); insertCaption(d, { label: 'Figure', text: 'Sales' });
  d.select(d.text.indexOf('reference: ') + 11); insertCrossReference(d, referenceTargets(d).captions[0], { show: 'entire' });
  // The caption's text changes after the cross-reference was made: its result is out of date.
  d.select(d.text.indexOf('Sales') + 2); d.replace(' data');
  return d;
}

it('keeps the caret where it was when fields update (F9)', async () => {
  const d = await captionedDocument();
  const end = d.text.length;
  d.select(end);
  expect(updateSequenceFields(d)).toBe(1);
  expect(d.text).toContain('See the reference: Figure 1: Sa datales\n');
  // The result before the caret grew by five characters; the caret stays at the end of the document.
  expect(d.range).toEqual([d.text.length, d.text.length]);
});

it('keeps a selection before and after updated fields in place', async () => {
  const d = await captionedDocument();
  const start = d.text.indexOf('Chart'), end = d.text.indexOf('Final') + 5;
  d.select(start, end);
  updateSequenceFields(d);
  expect(d.text.slice(...d.range)).toBe(d.text.slice(d.text.indexOf('Chart'), d.text.indexOf('Final') + 5));
  d.select(1);
  updateSequenceFields(d);
  expect(d.range).toEqual([1, 1]);
});
