// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { listMarkers } from '../src/engine/numbering.js';
import { copyFragment, pasteFragment, fragmentHtml, htmlFragment } from '../src/engine/clipboard-fragment.js';

const setup = () => {
  const doc = new TextDocument(['before', 'one', 'two', 'three', 'plain', ''].map(text => paragraph(text)));
  const at = i => doc.paragraphOffset(i);
  doc.select(at(1), at(3) + 5); doc.toggleList('number');
  const labels = () => doc.paragraphs.map((p, i) => (listMarkers(doc.paragraphs, doc.numbering)[i]?.text ?? '') + p.runs.map(r => r.text).join(''));
  doc.select(at(1), at(3));
  // As the clipboard carries it: through its HTML.
  const copied = htmlFragment(fragmentHtml(copyFragment(doc, { objects: { token: 'doc-1', story: null } })));
  return { doc, at, labels, copied };
};

it('pastes list items copied in this document into their own list, numbering on with it', () => {
  const { doc, at, labels, copied } = setup();
  doc.select(at(5)); expect(pasteFragment(doc, copied, { token: 'doc-1', story: null })).toBe(true);
  expect(labels()).toEqual(['before', '1.one', '2.two', '3.three', 'plain', '4.one', '5.two', '']);
  doc.select(at(0)); pasteFragment(doc, copied, { token: 'doc-1', story: null });
  expect(labels().slice(0, 6)).toEqual(['1.one', '2.two', 'before', '3.one', '4.two', '5.three']);
});

it('starts a list of their own for items copied in another document', () => {
  const { doc, at, labels, copied } = setup();
  doc.select(at(5)); pasteFragment(doc, copied, { token: 'doc-2', story: null });
  expect(labels()).toEqual(['before', '1.one', '2.two', '3.three', 'plain', '1.one', '2.two', '']);
});
