// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { paragraph } from '../src/engine/model.js';
import { ParagraphMeasureCache } from '../src/engine/paragraph-measure-cache.js';
import { CanvasEditor } from '../src/engine/canvas-editor.js';

// Each view lays the paragraphs out on its own geometry, so its measurements have their own keys.
// The cache forgot whatever the last four layouts had not used, and every keystroke is a layout: a
// few characters typed in Web Layout forgot every Print Layout measurement, and going back to Print
// Layout measured the whole document again (1.3 s for a 96-page document). Each view now keeps its
// last layout's measurements while another view is shown.
const plain = layout => JSON.parse(JSON.stringify({ lines: layout.lines, pages: layout.pages, pageCount: layout.pageCount }));
const sentence = i => `Paragraph ${i} keeps its words, wrapping across the width of the page more than once in a while.`;

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

function editorWith(count) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 8 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {}, scale() {}, translate() {}, drawImage() {}, clearRect() {},
  });
  const host = document.createElement('div'); document.body.append(host);
  return new CanvasEditor(host, { paragraphs: Array.from({ length: count }, (_, i) => paragraph(sentence(i))) });
}
// The layout with nothing remembered.
function freshLayout(editor) {
  const remembered = editor.measure.paragraphCache, fresh = new ParagraphMeasureCache();
  editor.measure.paragraphCache = () => fresh;
  try { return editor.computeLayout().layout; } finally { editor.measure.paragraphCache = remembered; }
}
// The paragraphs measured again (cache misses) while `fn` runs.
function missesDuring(fn) {
  const original = ParagraphMeasureCache.prototype.measure, missed = [];
  const spy = vi.spyOn(ParagraphMeasureCache.prototype, 'measure').mockImplementation(function (key, ...rest) {
    if (!this.entries.has(key)) missed.push(key);
    return original.call(this, key, ...rest);
  });
  try { fn(); } finally { spy.mockRestore(); }
  return missed;
}

it('goes back to a view after typing in another, measuring only the edited paragraph again', () => {
  const editor = editorWith(200);
  for (const [kind, width, typed] of [['web', 500, 100], ['draft', 640, 150]]) {
    editor.setView({ kind, width });
    editor.focus(); editor.model.select(editor.model.text.indexOf(`Paragraph ${typed} `) + 9);
    for (let i = 0; i < 8; i++) editor.execute(() => editor.model.replace('x'));
    const missed = missesDuring(() => editor.setView(null));
    // Only the typed paragraph is new to Print Layout.
    expect(missed.length).toBeGreaterThan(0);
    expect(missed.every(key => key.includes('xxxxxxxx'))).toBe(true);
    expect(plain(editor.layout)).toEqual(plain(freshLayout(editor)));
  }
  // And Web Layout still has its own measurements after typing in Print Layout and visiting Draft.
  for (let i = 0; i < 8; i++) editor.execute(() => editor.model.replace('y'));
  editor.setView({ kind: 'draft', width: 640 });
  const missed = missesDuring(() => editor.setView({ kind: 'web', width: 500 }));
  expect(missed.length).toBeGreaterThan(0);
  expect(missed.every(key => key.includes('yyyyyyyy'))).toBe(true);
  expect(plain(editor.layout)).toEqual(plain(freshLayout(editor)));
  editor.destroy();
});

it('keeps no more measurements than its limit, however many views and edits there are', () => {
  const measured = value => ({ lines: [{ start: value, end: value + 1, stops: [{ offset: value, x: 0 }] }] });
  const cache = new ParagraphMeasureCache(300);
  const views = [null, 'web', 'draft', 'read'];
  let largest = 0;
  for (let round = 0; round < 40; round++) {
    const view = views[round % views.length];
    // Each layout of 100 paragraphs, three of them edited since the last.
    for (let step = 0; step < 3; step++) {
      cache.nextGeneration(view);
      for (let i = 0; i < 100; i++) {
        cache.measure(`${view}:${i}:${i < 3 ? `${round}.${step}` : ''}`, i, () => measured(i));
        largest = Math.max(largest, cache.entries.size);
      }
    }
  }
  expect(largest).toBe(300);
  // The views' other bookkeeping follows the views shown, not the layouts made.
  expect(cache.viewGenerations.size).toBeLessThanOrEqual(views.length);
});
