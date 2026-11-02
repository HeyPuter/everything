// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { paragraph } from '../src/engine/model.js';
import { CanvasEditor } from '../src/engine/canvas-editor.js';

// A screen view is laid out to the window's width. A document it cannot be laid out to (here, an
// indent wider than the window) failed to switch, but the editor kept the new view with the old
// layout: every later layout failed the same way, so the next keystroke threw and nothing was typed.
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

it('stays in the view it had when a screen view cannot lay the document out, and keeps editing', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 8 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {}, scale() {}, translate() {}, drawImage() {}, clearRect() {},
  });
  const host = document.createElement('div'); document.body.append(host);
  const errors = [];
  // A 4.9-inch indent fits the Letter page (6.5 inches of text) but not a 400-pixel window.
  const editor = new CanvasEditor(host, { paragraphs: [paragraph('Plain text'), paragraph('Indented quote', { format: { indentLeft: 7000 } })], onError: e => errors.push(e.message) });
  const printed = JSON.stringify(editor.layout.lines);
  expect(() => editor.setView({ kind: 'web', width: 400 })).toThrow(/no writing space/);
  expect(editor.view).toBeNull();
  expect(JSON.stringify(editor.layout.lines)).toBe(printed);
  editor.model.select(5);
  expect(editor.execute(() => editor.model.replace('typed '))).toBe(true);
  expect(errors).toEqual([]);
  expect(editor.model.text).toBe('Plaintyped  text\nIndented quote');
  // A window wide enough shows the view.
  expect(editor.setView({ kind: 'web', width: 900 })).toBe(true);
  expect(editor.view.kind).toBe('web');
  // And a narrower one later keeps the last width that fits.
  expect(() => editor.setView({ kind: 'web', width: 400 })).toThrow(/no writing space/);
  expect(editor.view).toEqual({ kind: 'web', width: 900 });
  expect(editor.execute(() => editor.model.replace('again '))).toBe(true);
  expect(editor.model.text).toContain('again');
  editor.destroy();
});
