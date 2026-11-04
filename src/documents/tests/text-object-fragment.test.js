import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { TextDocument, paragraph, paragraphText } from '../src/engine/model.js';
import { copyFragment, pasteFragment, OBJECT_STAND_IN } from '../src/engine/clipboard-fragment.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const MATH = '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>x</m:t></m:r></m:oMath>';
function document() {
  const doc = new TextDocument([paragraph('Sum '), paragraph('After')]);
  doc.select(4); doc.insertMathRun({ xml: MATH, text: 'x' }); doc.replace(' done');
  return doc;
}
const shape = doc => doc.paragraphs.map(p => p.runs.map(r => r.math ? '[math]' : r.text).join(''));

it('carries an equation in copied text to a paste in the same document and story, and only the text elsewhere', () => {
  const doc = document();
  doc.select(0, paragraphText(doc.paragraphs[0]).length);
  const fragment = copyFragment(doc, { objects: { token: 'one', story: null } });
  expect(fragment.objects).toEqual({ token: 'one', story: null });
  expect(fragment.paragraphs[0].text).toBe(`Sum ${OBJECT_STAND_IN} done`);
  // Without the option a copy holding an object is not a fragment, as before.
  expect(copyFragment(doc)).toBe(null);
  doc.select(doc.text.length);
  pasteFragment(doc, JSON.parse(JSON.stringify(fragment)), { token: 'one', story: null });
  expect(shape(doc)).toEqual(['Sum [math] done', 'AfterSum [math] done']);
  // Another document or story: the text alone, with no stand-in character left behind.
  for (const [token, story] of [['two', null], ['one', 'word/header1.xml']]) {
    doc.select(doc.text.length);
    pasteFragment(doc, JSON.parse(JSON.stringify(fragment)), { token, story });
    expect(shape(doc).at(-1).endsWith('Sum  done')).toBe(true);
  }
  expect(doc.text).not.toContain(OBJECT_STAND_IN);
});
