// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { paragraph, paragraphFormat } from '../src/engine/model.js';

let editor, host, errors;
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    measureText: text => ({ width: [...text].length * 8 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
  });
  host = document.createElement('div'); document.body.append(host);
  errors = vi.fn();
  editor = new CanvasEditor(host, { paragraphs: [paragraph('Alpha'), paragraph('Beta'), paragraph('Gamma')], onError: errors });
  editor.focus();
});
afterEach(() => { editor?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });

const tab = (shiftKey = false) => { const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true }); editor.input.dispatchEvent(e); return e.defaultPrevented; };
const indents = () => editor.model.paragraphs.map(p => paragraphFormat(p, editor.model.numbering).indentLeft);

it('Tab over several paragraphs indents them, and Shift+Tab takes the indent back, instead of replacing them with a tab', () => {
  editor.model.select(2, 8); editor.syncInput();
  expect(tab()).toBe(true);
  expect(editor.model.text).toBe('Alpha\nBeta\nGamma');
  expect(indents()).toEqual([720, 720, 0]);
  expect(editor.model.range).toEqual([2, 8]);
  expect(tab()).toBe(true);
  expect(indents()).toEqual([1440, 1440, 0]);
  expect(tab(true)).toBe(true); expect(tab(true)).toBe(true);
  expect(indents()).toEqual([0, 0, 0]);
  // At the margin Shift+Tab moves on from the document, as from any field.
  expect(tab(true)).toBe(false);
  expect(editor.model.text).toBe('Alpha\nBeta\nGamma');
  editor.undo(); expect(indents()).toEqual([720, 720, 0]);
  expect(errors).not.toHaveBeenCalled();
});

it('a paragraph selected with its mark (Shift+Down from its start) is indented, not replaced', () => {
  editor.model.select(6, 11); editor.syncInput();
  expect(tab()).toBe(true);
  expect(editor.model.text).toBe('Alpha\nBeta\nGamma');
  expect(indents()).toEqual([0, 720, 0]);
});

it('Tab over list items from the middle of one changes their level', () => {
  editor.model.select(0, 10); editor.toggleList('bullet');
  editor.model.select(2, 8); editor.syncInput();
  expect(tab()).toBe(true);
  expect(editor.model.text).toBe('Alpha\nBeta\nGamma');
  expect(editor.model.paragraphs.map(p => p.list?.level ?? null)).toEqual([1, 1, null]);
});

it('Tab over a selection within one paragraph still types a tab over it', () => {
  editor.model.select(1, 3); editor.syncInput();
  expect(tab()).toBe(true);
  expect(editor.model.text).toBe('A\tha\nBeta\nGamma');
});
