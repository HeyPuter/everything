// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { copyFragment, fragmentHtml, htmlFragment, pasteFragment } from '../src/engine/clipboard-fragment.js';
import { commentAnchors } from '../src/engine/comments.js';

// A copy as the editor puts it on the clipboard and reads it back for a paste (canvas-editor clipboardData, pasteData).
const clip = (doc, token) => htmlFragment(fragmentHtml(copyFragment(doc, { objects: { token, story: null } })));
const anchors = doc => commentAnchors(doc.paragraphs).map(a => [a.id, doc.text.slice(a.start, a.end), a.start, a.end]);
function commented() {
  const doc = new TextDocument([paragraph('Alpha beta gamma'), paragraph('delta')]);
  doc.addComment({ author: 'A', text: 'note', range: [6, 10] });
  doc.addComment({ author: 'A', text: 'spans', range: [11, 22] });
  return doc;
}

it('a cut pasted back in the same document brings its comments with it', () => {
  const doc = commented();
  doc.select(0, 17); const copied = clip(doc, 'doc-1'); doc.replace('');
  // The comments stay, anchored to the point where the text was; one only partly cut keeps the rest of its text.
  expect(anchors(doc)).toEqual([['0', '', 0, 0], ['1', 'delta', 0, 5]]);
  doc.select(doc.text.length); doc.replace(' ');
  expect(pasteFragment(doc, copied, { token: 'doc-1', story: null })).toBe(true);
  expect(doc.text).toBe('delta Alpha beta gamma\n');
  expect(anchors(doc)).toEqual([['1', 'delta', 0, 5], ['0', 'beta', 12, 16]]);
  expect(doc.comments.map(c => c.id)).toEqual(['0', '1']);
});

it('a copy pasted again leaves its comments where they are, and another document never takes them', () => {
  const doc = commented(), before = anchors(doc);
  doc.select(0, 16); const copied = clip(doc, 'doc-1');
  doc.select(doc.text.length); pasteFragment(doc, copied, { token: 'doc-1', story: null });
  expect(doc.text).toBe('Alpha beta gamma\ndeltaAlpha beta gamma');
  expect(anchors(doc)).toEqual(before);
  // Cut, then pasted into a document opened elsewhere (another token): the comment stays where the text was cut.
  const cut = commented(); cut.select(0, 16); const away = clip(cut, 'doc-1'); cut.replace('');
  const other = new TextDocument([paragraph('Other')]); other.select(5);
  pasteFragment(other, away, { token: 'doc-2', story: null });
  expect(other.text).toBe('OtherAlpha beta gamma'); expect(commentAnchors(other.paragraphs)).toEqual([]);
  cut.select(cut.text.length); pasteFragment(cut, away, { token: 'doc-2', story: null });
  expect(anchors(cut).find(a => a[0] === '0')).toEqual(['0', '', 0, 0]);
});
