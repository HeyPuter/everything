// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { paragraph } from '../src/engine/model.js';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { setFormattingMarks } from '../src/engine/formatting-marks.js';

// Printing and PDF export lay the authored pages out privately when a screen view is showing, or
// hidden text is shown. Their line numbers (§17.6.8) were the screen's: none from Web Layout, Draft
// or Read Mode, and with hidden text shown, labels for lines the printed pages do not have.
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

function editorWith(paragraphs) {
  const drawn = [];
  const context = new Proxy({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 8 }),
    fillText: (text, x, y) => drawn.push({ text, y: Math.round(y) }),
  }, { get: (t, k) => k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined), set: (t, k, v) => { t[k] = v; return true; } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
  const host = document.createElement('div'); document.body.append(host);
  const editor = new CanvasEditor(host, { paragraphs, pageSettings: { lineNumbers: { countBy: 1, start: 0, distance: null, restart: 'continuous' } } });
  // The line number labels printed: short runs of digits at the left margin.
  const printed = () => { drawn.length = 0; editor.printSheets(); return drawn.filter(d => /^\d+$/.test(d.text)).map(d => `${d.text}@${d.y}`); };
  return { editor, printed };
}

it('prints the authored line numbers from a screen view', () => {
  const { editor, printed } = editorWith([paragraph('First line of text'), paragraph('Second line of text'), paragraph('Third line')]);
  const expected = printed();
  expect(expected.map(label => label.split('@')[0])).toEqual(['1', '2', '3']);
  for (const view of [{ kind: 'web', width: 700 }, { kind: 'draft', width: 700 }, { kind: 'read', width: 600, height: 700 }]) {
    editor.setView(view);
    expect(printed()).toEqual(expected);
  }
  editor.setView(null);
  expect(printed()).toEqual(expected);
  editor.destroy();
});

it('prints line numbers for the printed lines while hidden text is shown', () => {
  const words = 'hidden words '.repeat(20);
  const mixed = paragraph(`Shown text ${words}`, { runs: [{ text: 'Shown text ' }, { text: words, vanish: true }] });
  const { editor, printed } = editorWith([paragraph('Shown one'), mixed, paragraph('Shown two')]);
  const expected = printed();
  setFormattingMarks(editor, true);
  expect(expected.map(label => label.split('@')[0])).toEqual(['1', '2', '3']);
  // On screen the hidden words take lines of their own, with numbers.
  expect(editor.lineNumbers.length).toBeGreaterThan(3);
  expect(printed()).toEqual(expected);
  setFormattingMarks(editor, false);
  editor.destroy();
});
