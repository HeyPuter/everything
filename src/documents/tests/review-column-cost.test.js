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

/** A document with a commented sentence per paragraph; every third comment mentions someone, every second has a reply. */
function commentedDocument(count) {
  editor = new CanvasEditor(host, { paragraphs: Array.from({ length: count }, (_, i) => paragraph(`Sentence number ${i} of the review.`)) });
  const text = () => editor.model.text;
  for (let i = 0; i < count; i++) {
    const at = text().indexOf(`number ${i} `);
    const id = editor.model.addComment({ author: i % 2 ? 'Ada Lovelace' : 'Grace Hopper', text: i % 3 ? `Plain note ${i}` : `@Ada Lovelace see ${i}`, range: [at, at + 6] });
    if (i % 2) editor.model.replyToComment(id, { author: 'Grace Hopper', text: `Reply ${i} for @Grace Hopper` });
  }
  editor.relayout();
}
function open(people) {
  review = createReview({ editor: () => editor, pkg: () => ({}), host: () => host, error: e => { throw e; }, author: () => 'Grace Hopper', hooks: { people } });
  review.refresh(true);
}
const column = () => [...review.layer.querySelectorAll('.ed-comment-card')].map(card => card.innerHTML);

it('finds the review\'s people once when it rebuilds the comment column, and still shows each mention', () => {
  commentedDocument(30);
  const people = vi.fn(() => ['Ada Lovelace', 'Grace Hopper']);
  open(people);
  expect(review.layer.querySelectorAll('.ed-comment-card')).toHaveLength(30);
  // Mentions are marked in roots and replies; text without an @ needs nobody's name.
  expect(review.layer.querySelectorAll('.rv-mention')).toHaveLength(10 + 15);
  expect(review.layer.querySelector('[data-thread] .rv-mention').textContent).toBe('@Ada Lovelace');
  expect(people).toHaveBeenCalledTimes(1);
  // Every rebuild (Next Comment, Resolve, a new comment) asks once more, not once per comment.
  people.mockClear();
  const before = column();
  review.commands.go(1); review.refresh(true);
  expect(people.mock.calls.length).toBeLessThanOrEqual(2);
  expect(column().length).toBe(before.length);
});
