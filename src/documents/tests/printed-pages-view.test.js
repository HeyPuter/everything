// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { paragraph } from '../src/engine/model.js';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { setFormattingMarks } from '../src/engine/formatting-marks.js';
import { goToTargets } from '../src/views/go-to.js';

// File > Print, Word Count and the document's statistics count pages. In Web Layout and Draft they
// counted the screen's strips, so File > Print offered "All pages (2)" for a five-page document and
// printed only the first two pages; with hidden text shown they counted the pages it took on screen.
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

function editorWith(paragraphs) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 8 }),
  }, { get: (t, k) => k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined), set: (t, k, v) => { t[k] = v; return true; } }));
  const host = document.createElement('div'); document.body.append(host);
  return new CanvasEditor(host, { paragraphs });
}

it('counts the printed pages, and the caret page among them, from every view', () => {
  const editor = editorWith(Array.from({ length: 120 }, (_, i) => paragraph(`Paragraph ${i}, long enough to fill some of a line.`)));
  const printed = editor.layout.pageCount;
  expect(printed).toBeGreaterThan(2);
  editor.model.select(editor.model.text.indexOf('Paragraph 100'));
  const caretPage = editor.caretPageIndex + 1;
  expect(caretPage).toBeGreaterThan(1);
  expect(editor.printedPages()).toEqual({ count: printed, current: caretPage });
  for (const view of [{ kind: 'web', width: 1400 }, { kind: 'draft', width: 1400 }, { kind: 'read', width: 900, height: 600 }]) {
    editor.setView(view);
    expect(editor.layout.pageCount).not.toBe(printed);
    expect(editor.printedPages()).toEqual({ count: printed, current: caretPage });
    // And printing them all paints every printed page.
    expect(editor.printSheets(Array.from({ length: editor.printedPages().count }, (_, i) => i)).filter(Boolean)).toHaveLength(printed);
  }
  editor.destroy();
});

it('counts the printed pages while hidden text is shown', () => {
  const hidden = 'hidden words '.repeat(400);
  const editor = editorWith([paragraph('Shown'), paragraph(hidden, { runs: [{ text: hidden, vanish: true }] }), paragraph('Shown too')]);
  expect(editor.printedPages().count).toBe(1);
  setFormattingMarks(editor, true);
  expect(editor.layout.pageCount).toBeGreaterThan(1);
  expect(editor.printedPages()).toEqual({ count: 1, current: 1 });
  setFormattingMarks(editor, false);
  editor.destroy();
});

// Go To Page and Line went to the screen's strips in Web Layout and Draft: "page 3" was the third strip.
it('goes to printed pages and lines from Web Layout and Draft', () => {
  const editor = editorWith(Array.from({ length: 120 }, (_, i) => paragraph(`Paragraph ${i}, long enough to fill some of a line.`)));
  const pages = goToTargets(editor, 'page'), lines = goToTargets(editor, 'line');
  expect(pages.length).toBe(editor.layout.pageCount);
  for (const view of [{ kind: 'web', width: 1400 }, { kind: 'draft', width: 900 }]) {
    editor.setView(view);
    expect(goToTargets(editor, 'page')).toEqual(pages);
    expect(goToTargets(editor, 'line')).toEqual(lines);
  }
  editor.destroy();
});
