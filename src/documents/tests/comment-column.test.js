// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { paragraph } from '../src/engine/model.js';
import { createReview } from '../src/views/review.js';

let editor, host, review;
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 8 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
  });
  host = document.createElement('div'); document.body.append(host);
});
afterEach(() => { review?.destroy(); editor?.destroy(); review = editor = null; document.body.replaceChildren(); vi.restoreAllMocks(); });

function open(texts) {
  editor = new CanvasEditor(host, { paragraphs: texts.map(text => paragraph(text)), comments: [] });
  review = createReview({ editor: () => editor, pkg: () => ({}), host: () => host, error: e => { throw e; }, author: () => 'Ada' });
  review.refresh(true);
  return editor;
}
const card = id => review.layer.querySelector(`[data-thread="${id}"]`);
const type = (textarea, text) => { textarea.value = text; textarea.dispatchEvent(new Event('input')); };

it('keeps a reply and an edit being written when the column is rebuilt around them', () => {
  open(['First paragraph here.', 'Second paragraph here.']);
  const first = editor.model.addComment({ author: 'Ada', text: 'One', range: [0, 5] });
  const second = editor.model.addComment({ author: 'Grace', text: 'Two', range: [22, 28] });
  review.refresh(true);
  type(card(first).querySelector('.wcc-reply textarea'), 'Half a reply');
  // The caret goes into the other thread (a click in the document): the column is rebuilt.
  editor.model.select(24, 24); review.refresh();
  expect(card(second).classList.contains('is-active')).toBe(true);
  expect(card(first).querySelector('.wcc-reply textarea').value).toBe('Half a reply');
  expect(card(first).querySelector('.wcc-reply .wcc-post').disabled).toBe(false);
  // Sending it posts the words and leaves the box empty.
  card(first).querySelector('.wcc-reply .wcc-post').click();
  expect(editor.model.comments.at(-1)).toMatchObject({ text: 'Half a reply', parentId: first });
  expect(card(first).querySelector('.wcc-reply textarea').value).toBe('');
  // An edit in progress survives the same way, and Cancel forgets it.
  review.commands.selectThreadById(second);
  card(second).querySelector('.wcc-more').click();
  document.querySelector('[role="menuitem"]').click();
  type(card(second).querySelector('.wcc-entry.is-editing textarea'), 'Two, edited');
  editor.model.select(2, 2); review.refresh(); review.refresh(true);
  expect(card(second).querySelector('.wcc-entry.is-editing textarea').value).toBe('Two, edited');
  card(second).querySelector('.wcc-entry.is-editing .wcc-cancel').click();
  expect(editor.model.comments.find(c => c.id === second).text).toBe('Two');
});

it('stacks the cards above the active one down from the top instead of piling them up there', () => {
  open(['One two three four five six seven.', 'Second paragraph.']);
  const ids = [[0, 3], [4, 7], [8, 13], [14, 18], [19, 23]].map(([a, b], i) => editor.model.addComment({ author: 'Ada', text: `c${i}`, range: [a, b] }));
  editor.relayout();
  review.commands.selectThreadById(ids[4]);
  review.refresh(true);
  const tops = ids.map(id => parseFloat(card(id).style.top));
  expect(card(ids[4]).classList.contains('is-active')).toBe(true);
  // Each card starts below the one before it (a card is 80 pixels high where nothing is laid out).
  for (let i = 1; i < tops.length; i++) expect(tops[i], `card ${i}`).toBeGreaterThanOrEqual(tops[i - 1] + 88);
  expect(tops[0]).toBeGreaterThanOrEqual(8);
});
