// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { paragraph } from '../src/engine/model.js';
import { findText } from '../src/engine/search.js';
import { selectionRects } from '../src/engine/layout.js';

let editor, host;
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 8 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
  });
  host = document.createElement('div'); document.body.append(host);
});
afterEach(() => { editor?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });

it('tints the matches of an open search on the pages it paints, without finding every match\'s boxes in the document', () => {
  // A hundred pages, each with a few matches.
  editor = new CanvasEditor(host, { paragraphs: Array.from({ length: 100 }, (_, i) => paragraph(`${i ? '\f' : ''}needle ${i} and another needle, needle`)) });
  expect(editor.layout.pageCount).toBe(100);
  const matches = findText(editor.model.paragraphs, 'needle');
  expect(matches).toHaveLength(300);
  editor.setFindHighlights(matches);
  editor.paint({ pages: [41] });
  // Only the painted page's boxes were worked out.
  expect([...editor.findRects.pages.keys()]).not.toContain(7);
  const page = editor.findHighlightRects(41);
  const lines = editor.layout.lines.filter(line => line.page === 41);
  const expected = matches.filter(m => lines.some(line => m.start <= line.end && m.end > line.start))
    .flatMap(m => selectionRects({ ...editor.layout, lines }, m.start, m.end).map(rect => ({ ...rect, match: m })));
  expect(page).toHaveLength(3);
  expect(page).toEqual(expected);
});
