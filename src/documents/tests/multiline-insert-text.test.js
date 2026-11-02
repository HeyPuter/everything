// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { paragraph } from '../src/engine/model.js';

let editor, host, errors;
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    measureText: text => ({ width: [...text].length * 8 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
  });
  host = document.createElement('div'); document.body.append(host);
  errors = vi.fn();
  editor = new CanvasEditor(host, { paragraphs: [paragraph('Start '), paragraph('End')], onError: errors });
  editor.focus(); editor.model.select(6); editor.syncInput();
});
afterEach(() => { editor?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });

const insertText = data => {
  const event = new InputEvent('beforeinput', { inputType: 'insertText', data, cancelable: true });
  editor.input.dispatchEvent(event);
  return event;
};

// Chrome inserts text with line breaks (dictation, a text replacement, an input method's commit) into the field one
// line at a time, an input event each. Each event set the document back to the partly inserted field and laid it out
// again, so inserting a few hundred lines this way took seconds. The document takes the text at once; the field follows.
it('text with line breaks goes into the document at once, and the field takes it without the browser inserting it', () => {
  const event = insertText('one\ntwo\nthree');
  expect(event.defaultPrevented).toBe(true);
  expect(editor.model.text).toBe('Start one\ntwo\nthree\nEnd');
  expect(editor.input.value).toBe('Start one\ntwo\nthree\nEnd');
  expect(editor.model.range).toEqual([19, 19]);
  editor.undo(); expect(editor.model.text).toBe('Start \nEnd');
  expect(errors).not.toHaveBeenCalled();
});

it('typed text without a line break is still left for the browser to insert', () => {
  const event = insertText('a');
  expect(event.defaultPrevented).toBe(false);
  expect(editor.awaitedInput).toBe('Start a\nEnd');
  expect(editor.model.text).toBe('Start a\nEnd');
});
