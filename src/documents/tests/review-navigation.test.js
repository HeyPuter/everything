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
const selected = () => { const [a, b] = editor.model.range; return editor.model.text.slice(a, b); };

it('Next and Previous Change visit the changes inside a reformatted paragraph and the paragraph\'s own change', () => {
  open(['First line.', 'Second line here.', 'Third line.']);
  review.commands.toggleTracking(true);
  editor.execute(() => { editor.model.select(19, 19); editor.model.replace('new '); });
  editor.execute(() => { editor.model.select(14, 14); editor.model.setParagraphFormat({ alignment: 'center' }); });
  expect(editor.model.revisions.map(r => r.type)).toEqual(['format', 'ins']);
  editor.model.select(0, 0);
  const forward = [];
  for (let i = 0; i < 3; i++) { review.commands.goChange(1); forward.push(selected()); }
  expect(forward).toEqual(['Second new line here.\n', 'new ', 'Second new line here.\n']);
  const back = [];
  for (let i = 0; i < 3; i++) { review.commands.goChange(-1); back.push(selected()); }
  expect(back).toEqual(['new ', 'Second new line here.\n', 'new ']);
});

it('Next and Previous pass over the changes and comments of reviewers hidden in Show Markup', () => {
  open(['First line.', 'Second line.', 'Third line.']);
  editor.model.trackChanges = true;
  for (const [author, at, text] of [['Ada', 0, 'A '], ['Grace', 14, 'G '], ['Ada', 28, 'B ']]) {
    editor.model.revisionAuthor = author;
    editor.execute(() => { editor.model.select(at); editor.model.replace(text); });
  }
  editor.model.trackChanges = false;
  for (const [author, at] of [['Ada', 2], ['Grace', 16], ['Ada', 30]]) editor.model.addComment({ author, text: author, range: [at, at + 4] });
  revisionView.options.hiddenAuthors = ['Grace'];
  try {
    review.refresh(true);
    editor.model.select(0, 0);
    const changes = [];
    for (let i = 0; i < 3; i++) { review.commands.goChange(1); changes.push(selected()); }
    expect(changes).toEqual(['A ', 'B ', 'A ']);
    review.commands.goChange(-1);
    expect(selected()).toBe('B ');
    editor.model.select(0, 0);
    const comments = [];
    for (let i = 0; i < 3; i++) { review.commands.go(1); comments.push(review.commands.activeThread().root.author); }
    expect(comments).toEqual(['Ada', 'Ada', 'Ada']);
    expect(review.commands.activeThread().start).toBe(2);
  } finally { revisionView.options.hiddenAuthors = []; }
});

it('leaves Track Changes as the document has it while protection allows only comments, forms or no changes', () => {
  editor = new CanvasEditor(host, { paragraphs: [paragraph('Protected text.')], comments: [] });
  let protection = { edit: 'comments', enforcement: true };
  const errors = [];
  review = createReview({ editor: () => editor, pkg: () => ({}), host: () => host, error: e => errors.push(e.message), author: () => 'Ada', hooks: { protection: () => protection } });
  review.refresh(true);
  const revision = editor.session.revision;
  expect(review.commands.canTrack()).toBe(false);
  review.commands.toggleTracking();
  review.commands.setTrackingMode('mine');
  expect(review.commands.tracking).toBe(false);
  expect(editor.session.revision).toBe(revision);
  expect(errors).toEqual(['This document is protected: Track Changes cannot be turned on or off.', 'This document is protected: Track Changes cannot be turned on or off.']);
  protection = null;
  expect(review.commands.canTrack()).toBe(true);
  review.commands.toggleTracking();
  expect(review.commands.tracking).toBe(true);
});
