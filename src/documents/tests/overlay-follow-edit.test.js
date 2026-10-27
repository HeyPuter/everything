// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { paragraph } from '../src/engine/model.js';
import { commentAnchors } from '../src/engine/comments.js';
import { textEdit, mapPosition, followEdit } from '../src/engine/text-edit.js';

let editor, host;
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 8 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
  });
  host = document.createElement('div'); document.body.append(host);
});
afterEach(() => { editor?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });

it('finds the one span an edit changed', () => {
  expect(textEdit('abc', 'abc')).toBe(null);
  expect(textEdit('abcd', 'abXcd')).toEqual({ start: 2, end: 2, length: 1 });
  expect(textEdit('abcd', 'ad')).toEqual({ start: 1, end: 3, length: 0 });
  expect(textEdit('abcd', 'aXYd')).toEqual({ start: 1, end: 3, length: 2 });
  expect(textEdit('', 'xy')).toEqual({ start: 0, end: 0, length: 2 });
  expect(textEdit('aaa', 'aaaa')).toEqual({ start: 3, end: 3, length: 1 });
  // Each answer rebuilds the new text from the old one.
  const random = n => Array.from({ length: n }, () => 'ab\n'[Math.floor(Math.random() * 3)]).join('');
  for (let i = 0; i < 300; i++) {
    const before = random(Math.floor(Math.random() * 30)), at = Math.floor(Math.random() * (before.length + 1));
    const cut = Math.floor(Math.random() * (before.length - at + 1)), after = before.slice(0, at) + random(Math.floor(Math.random() * 4)) + before.slice(at + cut);
    const edit = textEdit(before, after);
    if (before === after) { expect(edit).toBe(null); continue; }
    expect(before.slice(0, edit.start) + after.slice(edit.start, edit.start + edit.length) + before.slice(edit.end)).toBe(after);
  }
});

it('carries ranges across an edit: inserted text at an end joins only when asked', () => {
  const typed = { start: 10, end: 10, length: 1 };
  expect([4, 10, 12].map(at => mapPosition(at, typed))).toEqual([4, 10, 13]);
  expect(mapPosition(10, typed, true)).toBe(11);
  expect(followEdit([{ start: 4, end: 10, fill: 'a' }, { start: 10, end: 14, fill: 'b' }], typed)).toEqual([{ start: 4, end: 10, fill: 'a' }, { start: 11, end: 15, fill: 'b' }]);
  expect(followEdit([{ start: 4, end: 10 }], typed, { endAfter: true })).toEqual([{ start: 4, end: 11 }]);
  // A deletion moves later ranges back, shortens the ranges it reaches into and drops those it removes.
  const cut = { start: 5, end: 9, length: 0 };
  expect(followEdit([{ start: 1, end: 6 }, { start: 6, end: 8 }, { start: 8, end: 12 }, { start: 12, end: 12 }], cut)).toEqual([{ start: 1, end: 5 }, { start: 5, end: 8 }, { start: 8, end: 8 }]);
});

/** What the Review pane gives the editor after each change: comment tints and the tracked changes' bars. */
function reviewOverlays() {
  editor.setRangeTints(commentAnchors(editor.model.paragraphs).map(a => ({ start: a.start, end: a.end, fill: 'rgba(255,200,0,.3)' })), 'comments');
  editor.setMarginBars(editor.session.body.revisions, '#C4314B');
}
function typeAt(at, text) {
  editor.model.select(at); editor.syncInput();
  const value = editor.input.value, offset = editor.input.selectionStart;
  editor.input.value = value.slice(0, offset) + text + value.slice(offset); editor.input.setSelectionRange(offset + text.length, offset + text.length);
  editor.input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
}

it('typing with comments and tracked changes paints once a keystroke, and the tints and bars end up where the review puts them', () => {
  editor = new CanvasEditor(host, { paragraphs: [paragraph('Alpha beta gamma delta.'), paragraph('Second paragraph here.'), paragraph('Third one.')] });
  editor.model.addComment({ author: 'A', text: 'note', range: [6, 10] });
  editor.model.addComment({ author: 'A', text: 'later', range: [30, 40] });
  editor.model.trackChanges = true; editor.relayout();
  typeAt(17, 'Q'); reviewOverlays();
  expect(editor.marginBars.ranges.map(r => [r.start, r.end])).toEqual([[17, 18]]);
  const paint = vi.spyOn(editor, 'paint');
  // Typing on in a tracked insertion, and before, within and after comments. A keystroke that starts a
  // new insertion adds a bar the review alone knows about, and that is painted when the review sets it.
  const cases = [[18, 'Q', 1], [19, 'Q', 1], [2, 'Z', 2], [3, 'Z', 1], [9, 'w', 2], [10, 'w', 1], [44, 'e', 2], [45, 'e', 1]];
  for (const [at, text, paints] of cases) {
    paint.mockClear();
    typeAt(at, text);
    const shown = { tints: editor.rangeTints.map(t => [t.start, t.end, t.fill]), bars: editor.marginBarKey };
    reviewOverlays();
    expect(paint, `typing at ${at}`).toHaveBeenCalledTimes(paints);
    // When the review's ranges match the ones carried across the keystroke, the keystroke's paint was the only one.
    if (paints === 1) expect({ tints: editor.rangeTints.map(t => [t.start, t.end, t.fill]), bars: editor.marginBarKey }).toEqual(shown);
  }
  expect(editor.model.text.slice(0, 34)).toBe('AlZZpha bwweta gamma QQQdelta.\nSec');
  expect(editor.rangeTints.map(t => [t.start, t.end])).toEqual([[8, 14], [37, 49]]);
  expect(editor.marginBars.ranges.map(r => [r.start, r.end])).toEqual([[2, 4], [9, 11], [21, 24], [44, 46]]);
});

it('ranges the edit does not explain are still repainted as the review sets them', () => {
  editor = new CanvasEditor(host, { paragraphs: [paragraph('Alpha beta gamma delta.')] });
  editor.model.addComment({ author: 'A', text: 'note', range: [6, 10] }); editor.relayout();
  reviewOverlays();
  const paint = vi.spyOn(editor, 'paint');
  // Typing at a comment's end leaves it out of the comment, as the model does.
  typeAt(10, 'X'); reviewOverlays();
  expect(paint).toHaveBeenCalledTimes(1);
  expect(editor.rangeTints.map(t => [t.start, t.end])).toEqual([[6, 10]]);
  // A range that changed on its own is painted when it is set.
  paint.mockClear();
  editor.setRangeTints([{ start: 0, end: 5, fill: 'red' }], 'comments');
  expect(paint).toHaveBeenCalledTimes(1);
  expect(editor.rangeTints).toEqual([{ start: 0, end: 5, fill: 'red' }]);
  // Once nothing is tinted or barred, edits are not compared at all.
  editor.setRangeTints([], 'comments');
  expect(editor.overlayText).toBe(undefined);
});

it('typing with a search open paints once a keystroke, and the matches end up where the search puts them', async () => {
  const { findText } = await import('../src/engine/search.js');
  editor = new CanvasEditor(host, { paragraphs: [paragraph('A plan, a plan and a canal.'), paragraph('Another plan here.')] });
  const search = () => editor.setFindHighlights(findText(editor.model.paragraphs, 'plan'));
  search();
  const paint = vi.spyOn(editor, 'paint');
  // Before the matches, between them, and after them.
  for (const at of [0, 9, 46]) {
    paint.mockClear();
    typeAt(at, 'x');
    const shown = editor.findHighlights.map(m => [m.start, m.end]);
    search();
    expect(paint, `typing at ${at}`).toHaveBeenCalledTimes(1);
    expect(editor.findHighlights.map(m => [m.start, m.end])).toEqual(shown);
  }
  // Typing into a match ends it: the search's answer is painted.
  paint.mockClear();
  typeAt(4, 'y'); search();
  expect(paint).toHaveBeenCalledTimes(2);
  expect(editor.findHighlights.map(m => m.start)).toEqual([13, 39]);
});
