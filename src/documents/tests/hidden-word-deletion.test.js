// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { paragraph } from '../src/engine/model.js';
import { revisionView } from '../src/engine/revisions.js';

let editor, host, errors;
const mode = revisionView.mode;
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    measureText: text => ({ width: [...text].length * 8 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
  });
  host = document.createElement('div'); document.body.append(host);
  errors = vi.fn();
  // "one two three four", with "three " deleted by Track Changes.
  const p = paragraph('');
  const del = { type: 'del', author: 'Author', date: '2026-10-27T00:00:00Z' };
  p.runs = [{ ...p.runs[0], text: 'one two ' }, { ...p.runs[0], text: 'three ', revision: del }, { ...p.runs[0], text: 'four' }];
  editor = new CanvasEditor(host, { paragraphs: [p], trackChanges: true, onError: errors });
  editor.focus();
});
afterEach(() => { revisionView.mode = mode; editor?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });

const runs = () => editor.model.paragraphs[0].runs.map(r => [r.text, r.revision?.type || '']);
// The browser's own word deletion (Option or Ctrl+Backspace / Delete): it removes the word beside the field's caret
// as the field has it once beforeinput is handled, which `remove` stands in for.
function nativeWordDelete(backward, remove) {
  const input = editor.input, inputType = backward ? 'deleteWordBackward' : 'deleteWordForward';
  input.dispatchEvent(new InputEvent('beforeinput', { inputType, cancelable: true }));
  const at = input.selectionStart, [from, to] = remove(input.value, at);
  input.value = input.value.slice(0, from) + input.value.slice(to); input.setSelectionRange(from, from);
  input.dispatchEvent(new InputEvent('input', { inputType }));
  return at;
}

it.each(['simple', 'none'])('with deletions hidden (%s), a word deletion beside one deletes the word a reader sees', view => {
  revisionView.mode = view; editor.relayout();
  // After "four" was deleted the caret is before it, just after the hidden "three ".
  editor.model.select(14); editor.syncInput();
  const from = nativeWordDelete(true, (value, at) => [value.lastIndexOf(' ', at - 2) + 1, at]);
  expect(from).toBe(8);
  expect(runs()).toEqual([['one ', ''], ['two ', 'del'], ['three ', 'del'], ['four', '']]);
  // Forward from before the hidden text deletes the word after it.
  expect(editor.model.range).toEqual([4, 4]);
  expect(nativeWordDelete(false, (value, at) => [at, value.length])).toBe(14);
  expect(runs()).toEqual([['one ', ''], ['two ', 'del'], ['three ', 'del'], ['four', 'del']]);
  expect(errors).not.toHaveBeenCalled();
});

it('in All Markup the deleted text shows, and a word deletion starts at the caret', () => {
  editor.model.select(14); editor.syncInput();
  expect(nativeWordDelete(true, (value, at) => [8, at])).toBe(14);
});
