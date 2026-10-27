// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { paragraph, TextDocument } from '../src/engine/model.js';
import { commentAnchors, commentThread } from '../src/engine/comments.js';
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

/** The comment list as it was first written: each comment's thread and entry found by searching every comment. */
function listedBySearching(model) {
  const comments = model.comments || [], anchors = new Map(commentAnchors(model.paragraphs).map(a => [a.id, a]));
  const roots = comments.filter(c => !c.parentId || !comments.some(p => p.id === c.parentId));
  const position = c => anchors.get(c.id)?.start ?? Infinity;
  roots.sort((a, b) => position(a) - position(b) || Number(a.id) - Number(b.id));
  const list = [];
  for (const root of roots) for (const id of commentThread(comments, root.id)) {
    const c = comments.find(item => item.id === id);
    list.push({ ...c, start: anchors.get(id)?.start ?? anchors.get(root.id)?.start ?? null, end: anchors.get(id)?.end ?? anchors.get(root.id)?.end ?? null, rootId: root.id });
  }
  return list;
}

it('lists comments, threads and replies in the same order however their parents are tangled', () => {
  let seed = 7;
  const random = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let round = 0; round < 60; round++) {
    const model = new TextDocument(Array.from({ length: 6 }, (_, i) => paragraph(`Paragraph ${i} with words.`)));
    const count = 1 + random(14);
    for (let i = 0; i < count; i++) { const at = random(model.text.length - 3); model.addComment({ author: 'A', text: `c${i}`, range: [at, at + random(4)] }); }
    // Replies to replies, to missing comments, to themselves and in cycles; repeated ids; comments without anchors.
    for (const c of model.comments) {
      const pick = random(6);
      c.parentId = pick === 0 ? null : pick === 1 ? 'missing' : pick === 2 ? c.id : model.comments[random(model.comments.length)].id;
    }
    if (random(3) === 0) model.comments.push({ ...model.comments[random(model.comments.length)], text: 'repeated id' });
    if (random(3) === 0) model.comments.push({ id: '99', author: 'B', text: 'unanchored', parentId: null });
    expect(model.commentList, `round ${round}`).toEqual(listedBySearching(model));
  }
});

it('lists the comments of a document with thousands of them quickly', () => {
  const model = new TextDocument([paragraph('Text.')]);
  model.comments = Array.from({ length: 20000 }, (_, i) => ({ id: String(i), author: 'A', text: 'c', parentId: i % 2 ? String(i - 1) : null }));
  const start = performance.now(), list = model.commentList;
  expect(list).toHaveLength(20000);
  expect(list.slice(0, 4).map(c => [c.id, c.rootId])).toEqual([['0', '0'], ['1', '0'], ['2', '2'], ['3', '2']]);
  // Searching every comment for each one took seconds here.
  expect(performance.now() - start).toBeLessThan(1000);
});

it('reads the comments once for each change to the document as it brings the column up to date', () => {
  commentedDocument(20);
  open(() => []);
  const proto = Object.getPrototypeOf(editor.model), getter = Object.getOwnPropertyDescriptor(proto, 'commentList').get;
  const reads = vi.spyOn(proto, 'commentList', 'get').mockImplementation(function () { return getter.call(this); });
  const place = () => [...review.layer.querySelectorAll('.ed-comment-card')].map(card => [card.dataset.thread, card.style.top, card.style.display, card.className]);
  // Typing before the comments moves every card.
  editor.model.select(0); editor.syncInput();
  editor.execute(() => editor.model.replace('Typed '));
  expect(editor.model.text.startsWith('Typed Sentence')).toBe(true);
  reads.mockClear();
  review.refresh();
  expect(reads).toHaveBeenCalledTimes(1);
  // The ribbon and menus ask about the threads again without the document changing.
  expect(review.commands.hasComments()).toBe(true);
  review.commands.activeThread();
  review.refresh();
  expect(reads).toHaveBeenCalledTimes(1);
  // The column and the threads are what they would be read afresh.
  const shown = place();
  expect(new Set(shown.map(([, top]) => top)).size).toBe(20);
  reads.mockRestore();
  review.destroy(); review = null;
  open(() => []);
  expect(place()).toEqual(shown);
  expect(review.commands.activeThread()).toBe(null);
  // A change to the comments is read at once.
  editor.execute(() => editor.model.setCommentDone(editor.model.comments[0].id, true));
  review.refresh();
  expect(review.layer.querySelector('.ed-comment-card').classList.contains('is-resolved')).toBe(true);
});
