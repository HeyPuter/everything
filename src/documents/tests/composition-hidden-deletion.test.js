// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { paragraph } from '../src/engine/model.js';
import { createReview } from '../src/views/review.js';
import { revisionView } from '../src/engine/revisions.js';
import { setFormattingMarks } from '../src/engine/formatting-marks.js';

// A caret inside struck-out text that Simple Markup or No Markup then hides: text typed there already goes where it
// shows (typeText), and so must text an input method composes, which never passes through typeText.
let editor, host, review, errors;
const mode = revisionView.mode, showHidden = revisionView.showHidden;
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 8 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
  });
  host = document.createElement('div'); document.body.append(host);
  errors = vi.fn();
  // "one two three four", with "three " deleted by Track Changes.
  const p = paragraph('');
  const del = { type: 'del', author: 'Author', date: '2026-10-27T00:00:00Z' };
  p.runs = [{ ...p.runs[0], text: 'one two ' }, { ...p.runs[0], text: 'three ', revision: del }, { ...p.runs[0], text: 'four' }];
  editor = new CanvasEditor(host, { paragraphs: [p], trackChanges: true, comments: [], onError: errors });
  review = createReview({ editor: () => editor, pkg: () => ({}), host: () => host, error: e => { throw e; }, author: () => 'Ada' });
  editor.focus();
});
afterEach(() => { revisionView.mode = mode; revisionView.showHidden = showHidden; review?.destroy(); editor?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });

function compose(text) {
  const input = editor.input;
  input.dispatchEvent(new CompositionEvent('compositionstart'));
  const start = input.selectionStart, end = input.selectionEnd, base = input.value;
  input.dispatchEvent(new CompositionEvent('compositionupdate', { data: text }));
  input.value = base.slice(0, start) + text + base.slice(end); input.setSelectionRange(start + text.length, start + text.length);
  input.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: text, isComposing: true }));
  input.dispatchEvent(new CompositionEvent('compositionend', { data: text }));
}
const runs = () => editor.model.paragraphs[0].runs.map(r => [r.text, r.revision?.type || '']);

it.each(['simple', 'none'])('switching to %s markup moves a caret out of the deletion it hides, so composed text shows', view => {
  // In All Markup the caret is placed inside the struck-out "three ".
  editor.model.select(11); editor.syncInput();
  review.commands.setMarkupView(view);
  expect(editor.model.range).toEqual([14, 14]);
  expect(editor.input.selectionStart).toBe(14);
  compose('日本');
  expect(runs()).toEqual([['one two ', ''], ['three ', 'del'], ['日本', 'ins'], ['four', '']]);
  expect(errors).not.toHaveBeenCalled();
});

it('All Markup and Original leave the caret where it was', () => {
  editor.model.select(11); editor.syncInput();
  review.commands.setMarkupView('original');
  expect(editor.model.range).toEqual([11, 11]);
  review.commands.setMarkupView('all');
  expect(editor.model.range).toEqual([11, 11]);
});

it('hiding hidden text moves a caret out of it too', () => {
  const p = editor.model.paragraphs[0];
  editor.destroy();
  const runs = [{ ...p.runs[0], text: 'one ' }, { ...p.runs[0], text: 'secret ', vanish: true }, { ...p.runs[0], text: 'two' }];
  editor = new CanvasEditor(host, { paragraphs: [{ ...p, runs }], onError: errors });
  setFormattingMarks(editor, true);
  editor.model.select(7); editor.syncInput();
  setFormattingMarks(editor, false);
  expect(editor.model.range).toEqual([11, 11]);
});
