// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { paragraph } from '../src/engine/model.js';
import { createReview } from '../src/views/review.js';
import { revisionView } from '../src/engine/revisions.js';

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

it('keeps a new comment, a reply or an edit the document refuses, to post again', async () => {
  open(['First paragraph here.', 'Second paragraph here.']);
  const first = editor.model.addComment({ author: 'Ada', text: 'One', range: [0, 5] });
  review.refresh(true);
  // Protection that allows no comment changes.
  editor.session.guard = () => { throw new Error('This document is protected: comments cannot be changed.'); };
  editor.model.select(22, 28);
  review.commands.newComment();
  type(review.layer.querySelector('.ed-comment-draft textarea'), 'A long thought');
  review.layer.querySelector('.ed-comment-draft .wcc-post').click();
  expect(editor.model.comments).toHaveLength(1);
  expect(review.layer.querySelector('.ed-comment-draft textarea').value).toBe('A long thought');
  await Promise.resolve();
  expect(document.activeElement).toBe(review.layer.querySelector('.ed-comment-draft textarea'));
  review.layer.querySelector('.ed-comment-draft .wcc-cancel').click();
  review.commands.selectThreadById(first);
  type(card(first).querySelector('.wcc-reply textarea'), 'A reply');
  card(first).querySelector('.wcc-reply .wcc-post').click();
  expect(editor.model.comments).toHaveLength(1);
  expect(card(first).querySelector('.wcc-reply textarea').value).toBe('A reply');
  card(first).querySelector('.wcc-more').click();
  document.querySelector('[role="menuitem"]').click();
  type(card(first).querySelector('.wcc-entry.is-editing textarea'), 'One, edited');
  card(first).querySelector('.wcc-entry.is-editing .wcc-post').click();
  expect(editor.model.comments[0].text).toBe('One');
  expect(card(first).querySelector('.wcc-entry.is-editing textarea').value).toBe('One, edited');
  // Allowed again, they post.
  editor.session.guard = null;
  card(first).querySelector('.wcc-entry.is-editing .wcc-post').click();
  card(first).querySelector('.wcc-reply .wcc-post').click();
  expect(editor.model.comments.map(c => c.text)).toEqual(['One, edited', 'A reply']);
  expect(card(first).querySelector('.wcc-reply textarea').value).toBe('');
});

it('offers no new comment where the document\'s protection allows none', () => {
  editor = new CanvasEditor(host, { paragraphs: [paragraph('Protected text.')], comments: [] });
  let protection = { edit: 'readOnly', enforcement: true };
  const errors = [];
  review = createReview({ editor: () => editor, pkg: () => ({}), host: () => host, error: e => errors.push(e.message), author: () => 'Ada', hooks: { protection: () => protection } });
  editor.model.addComment({ author: 'Grace', text: 'Earlier', range: [10, 14] });
  review.refresh(true);
  editor.model.select(0, 9);
  expect(review.commands.canComment()).toBe(false);
  // The thread already there cannot be answered, resolved or changed either.
  expect(review.layer.querySelector('.wcc-reply')).toBeNull();
  expect(review.layer.querySelector('.wcc-more').disabled).toBe(true);
  review.commands.newComment();
  expect(review.layer.querySelector('.ed-comment-draft')).toBeNull();
  expect(errors).toEqual(['This document is protected: comments cannot be added.']);
  protection = { edit: 'forms', enforcement: true };
  expect(review.commands.canComment()).toBe(false);
  // Protected for comments only, or not at all, a comment can be started.
  for (protection of [{ edit: 'comments', enforcement: true }, null]) expect(review.commands.canComment()).toBe(true);
  review.commands.newComment();
  expect(review.layer.querySelector('.ed-comment-draft')).not.toBeNull();
});

it('tells assistive technology which person the arrow keys choose to mention', () => {
  editor = new CanvasEditor(host, { paragraphs: [paragraph('Some text to discuss.')], comments: [] });
  review = createReview({ editor: () => editor, pkg: () => ({}), host: () => host, error: e => { throw e; }, author: () => 'Ada', hooks: { people: () => ['Ada Lovelace', 'Alan Turing', 'Grace Hopper'] } });
  review.refresh(true);
  editor.model.select(0, 4);
  review.commands.newComment();
  const box = review.layer.querySelector('.ed-comment-draft textarea'), list = review.layer.querySelector('.wcc-mentions');
  box.focus();
  expect(box.getAttribute('aria-controls')).toBe(list.id);
  box.value = 'Ask @A'; box.setSelectionRange(6, 6); box.dispatchEvent(new Event('input'));
  expect(list.hidden).toBe(false);
  const options = [...list.querySelectorAll('[role="option"]')];
  expect(options.map(o => o.textContent)).toEqual(['ALAda Lovelace', 'ATAlan Turing']);
  expect(box.getAttribute('aria-activedescendant')).toBe(options[0].id);
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(box.getAttribute('aria-activedescendant')).toBe(options[1].id);
  expect(options[1].getAttribute('aria-selected')).toBe('true');
  expect(options.every(o => o.tabIndex === -1)).toBe(true);
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(list.hidden).toBe(true);
  expect(box.hasAttribute('aria-activedescendant')).toBe(false);
});

it('hides the comments in No Markup and Original, and going to a comment shows the markup again', () => {
  open(['First paragraph here.', 'Second paragraph here.']);
  const first = editor.model.addComment({ author: 'Ada', text: 'One', range: [0, 5] });
  review.refresh(true);
  expect(review.layer.hidden).toBe(false);
  try {
    for (const mode of ['none', 'original']) {
      review.commands.setMarkupView(mode); review.refresh();
      expect(review.layer.hidden, mode).toBe(true);
      expect(review.layer.querySelector('[data-thread]')).toBeNull();
      expect(review.commands.shown).toBe(false);
      review.commands.setMarkupView('simple'); review.refresh();
      expect(card(first)).not.toBeNull();
    }
    review.commands.setMarkupView('none'); review.refresh();
    review.commands.go(1); review.refresh();
    expect(revisionView.mode).toBe('all');
    expect(card(first).classList.contains('is-active')).toBe(true);
    review.commands.setMarkupView('original'); review.refresh();
    editor.model.select(30, 34);
    review.commands.newComment();
    expect(revisionView.mode).toBe('all');
    expect(review.layer.querySelector('.ed-comment-draft')).not.toBeNull();
  } finally { revisionView.mode = 'all'; }
});
