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
  editor = new CanvasEditor(host, { paragraphs: [paragraph('')], onError: errors });
  editor.focus();
});
afterEach(() => { editor?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });

// An input method composing `steps` at the caret, then committing the last of them (as Chrome reports it).
function compose(...steps) {
  const input = editor.input, start = input.selectionStart, end = input.selectionEnd, base = input.value;
  input.dispatchEvent(new CompositionEvent('compositionstart'));
  for (const text of steps) {
    input.dispatchEvent(new CompositionEvent('compositionupdate', { data: text }));
    input.value = base.slice(0, start) + text + base.slice(end); input.setSelectionRange(start + text.length, start + text.length);
    input.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: text, isComposing: true }));
  }
  input.dispatchEvent(new CompositionEvent('compositionend', { data: steps.at(-1) }));
}
function type(text) {
  for (const data of text) {
    const event = new InputEvent('beforeinput', { inputType: 'insertText', data, cancelable: true });
    editor.input.dispatchEvent(event);
    if (!event.defaultPrevented) {
      editor.input.value = editor.awaitedInput; editor.input.setSelectionRange(editor.model.range[0], editor.model.range[0]);
      editor.input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data }));
    }
  }
}

it('a word composed a syllable at a time (Korean) is one undo step, as a typed word is', () => {
  compose('ㅇ', '아', '안'); compose('ㄴ', '녀', '녕'); compose('ㅎ', '하');
  type(' '); compose('ㅅ', '세'); compose('ㅇ', '요');
  expect(editor.model.text).toBe('안녕하 세요');
  editor.undo(); expect(editor.model.text).toBe('안녕하 ');
  editor.undo(); expect(editor.model.text).toBe('');
  editor.redo(); expect(editor.model.text).toBe('안녕하 ');
  editor.redo(); expect(editor.model.text).toBe('안녕하 세요');
  expect(errors).not.toHaveBeenCalled();
});

it('composed text continues the typing before it, and typing continues composed text', () => {
  type('caf'); compose('´', 'é'); type('s');
  expect(editor.model.text).toBe('cafés');
  editor.undo(); expect(editor.model.text).toBe('');
});

it('composition after the caret moved, or over a selection, starts its own undo step', () => {
  type('ab');
  editor.model.select(1); editor.syncInput(); compose('か');
  expect(editor.model.text).toBe('aかb');
  editor.undo(); expect(editor.model.text).toBe('ab');
  editor.model.select(0, 2); editor.syncInput(); compose('日');
  expect(editor.model.text).toBe('日');
  editor.undo(); expect(editor.model.text).toBe('ab');
  editor.undo(); expect(editor.model.text).toBe('');
});

it('composition the field put away from where the typing ended starts its own undo step', () => {
  type('ab');
  // The field's text changes at its start while the model's caret is still after the typing (a moved caret the
  // model had not yet followed): the composed text is not a continuation of that typing.
  const input = editor.input;
  input.dispatchEvent(new CompositionEvent('compositionstart'));
  input.setRangeText('한', 0, 0, 'end');
  input.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: '한', isComposing: true }));
  input.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
  expect(editor.model.text).toBe('한ab');
  editor.undo(); expect(editor.model.text).toBe('ab');
  editor.undo(); expect(editor.model.text).toBe('');
});

it('commits a composition without serializing the whole document to see whether it changed', () => {
  editor.destroy();
  editor = new CanvasEditor(host, { paragraphs: Array.from({ length: 40 }, (_, i) => paragraph(`Paragraph ${i}`)), onError: errors });
  editor.focus(); editor.model.select(editor.model.text.length); editor.syncInput();
  // Each syllable of Korean is a composition of its own: two copies of a long document serialized for each one held typing up.
  const whole = vi.spyOn(JSON, 'stringify');
  const documents = () => whole.mock.calls.filter(([value]) => Array.isArray(value) && value.length === 40 && value.every(p => Array.isArray(p?.runs))).length;
  compose('ㅎ', '하'); compose('ㄴ', '나');
  expect(editor.model.text.endsWith('Paragraph 39하나')).toBe(true);
  expect(documents()).toBe(0);
  // A composition that ends with nothing typed records nothing; one that changes only formatting still records.
  const steps = editor.session.history.length;
  compose('ㄱ', ''); expect(editor.session.history).toHaveLength(steps);
  whole.mockRestore();
  editor.undo(); expect(editor.model.text.endsWith('Paragraph 39')).toBe(true);
  expect(errors).not.toHaveBeenCalled();
});
