// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { ParagraphMeasureCache } from '../src/engine/paragraph-measure-cache.js';
import { CanvasEditor } from '../src/engine/canvas-editor.js';

const metrics = (text, style) => ({ width: [...text].length * (style.fontSize ?? 12) * (style.bold ? .6 : .5), ascent: style.fontSize ?? 12, descent: (style.fontSize ?? 12) / 3 });
// A measurer that remembers measured paragraphs, as the canvas editor's does, and counts its calls.
function cachedMeasure() {
  const calls = [], cache = new ParagraphMeasureCache();
  const measure = (text, style) => { calls.push(text); return metrics(text, style); };
  measure.paragraphCache = () => cache;
  return { measure, calls, cache };
}
const lay = (doc, measure) => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
// Everything a painter, hit test or caret reads, without functions.
const plain = layout => JSON.parse(JSON.stringify({ lines: layout.lines, pages: layout.pages, pageCount: layout.pageCount, cells: layout.cells, borders: layout.paragraphBorders }));
const sentence = i => `Paragraph ${i} keeps its words, wrapping across the width of the page more than once in a while.`;

it('re-measures only edited paragraphs, shifting later offsets, with the same layout as a fresh measurement', () => {
  // Underlines and strikes carry an `offset` below the baseline, which is not a document offset.
  const decorated = i => i % 3 ? { underline: true, underlineStyle: 'single' } : i % 5 ? { strikethrough: 'single' } : {};
  // Reordered right-to-left text keeps caret stops on its fragments as well as on its line.
  const doc = new TextDocument(Array.from({ length: 300 }, (_, i) => {
    const p = paragraph(`${i % 4 ? '' : '\t'}${sentence(i)}`); Object.assign(p.runs[0], decorated(i));
    if (i % 7 === 3) p.runs.push({ ...p.runs[0], underline: false, underlineStyle: 'none', strikethrough: 'none', text: ' שלום עולם', rtl: true }, { ...p.runs[0], text: ' end.' });
    return p;
  }));
  const { measure, calls } = cachedMeasure();
  lay(doc, measure);
  const tail = sentence(299);
  expect(lay(doc, metrics).lines.some(line => line.underlines.length && line.strikes.length === 0)).toBe(true);
  expect(lay(doc, metrics).lines.some(line => line.fragments.some(f => f.caretStops?.length))).toBe(true);
  // Typing near the start moves every following paragraph without changing it.
  doc.select(5); doc.replace('typed ');
  calls.length = 0;
  const edited = lay(doc, measure);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.some(text => text.includes('Paragraph 299'))).toBe(false);
  expect(calls.every(text => !text.includes('Paragraph 1 ') && !text.includes(tail.slice(0, 15)))).toBe(true);
  expect(plain(edited)).toEqual(plain(lay(doc, metrics)));
  const last = edited.lines.at(-1);
  expect(last.end).toBe(doc.text.length);
  expect(last.stops.at(-1).offset).toBe(doc.text.length);
  // Undo restores the original offsets from the same entries.
  doc.undo();
  expect(plain(lay(doc, measure))).toEqual(plain(lay(doc, metrics)));
});

it('measures again when a paragraph, its list label or its page changes in place', () => {
  const doc = new TextDocument([paragraph('First item'), paragraph('Second item'), paragraph('Body text that stays the same')]);
  const { measure } = cachedMeasure();
  lay(doc, measure);
  const check = () => expect(plain(lay(doc, measure))).toEqual(plain(lay(doc, metrics)));
  doc.select(0, 3); doc.toggleBold(); check();
  doc.select(0, 30); doc.toggleList('bullet'); check();
  doc.toggleList('number'); check();
  doc.select(15); doc.setParagraphFormat({ alignment: 'center', indentLeft: 720 }); check();
  doc.setPageSettings({ left: 2880 }); check();
  doc.setPageSettings({ autoHyphenation: true }); check();
  doc.undo(); check(); doc.undo(); check(); doc.redo(); check();
});

it('keeps each use separate, so later layout stages cannot change a remembered measurement', () => {
  const doc = new TextDocument([paragraph('Alpha beta gamma'), paragraph('Delta')]);
  const { measure } = cachedMeasure();
  const first = lay(doc, measure);
  first.lines[0].fragments[0].x += 100; first.lines[0].stops[0].offset = 99;
  expect(plain(lay(doc, measure))).toEqual(plain(lay(doc, metrics)));
});

it('bounds its memory: replaced paragraphs are forgotten, and the least recently used go first', () => {
  const measured = value => ({ lines: [{ start: value, end: value + 1, stops: [{ offset: value, x: 0 }] }] });
  const generations = new ParagraphMeasureCache();
  generations.measure('old', 0, () => measured(0)); generations.measure('kept', 2, () => measured(2));
  for (let i = 0; i < 4; i++) { generations.nextGeneration(); generations.measure('kept', 2, () => measured(2)); }
  expect([...generations.entries.keys()]).toEqual(['old', 'kept']);
  generations.nextGeneration();
  expect([...generations.entries.keys()]).toEqual(['kept']);
  const cache = new ParagraphMeasureCache(2);
  cache.measure('a', 0, () => measured(0)); cache.measure('b', 0, () => measured(0));
  cache.measure('a', 5, () => { throw new Error('a is remembered'); });
  cache.measure('c', 0, () => measured(0));
  expect([...cache.entries.keys()]).toEqual(['a', 'c']);
  expect(cache.measure('a', 7, () => null)).toEqual(measured(7));
});

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });
it('the canvas editor forgets measured paragraphs whenever it forgets measurements', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 8 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
  });
  const host = document.createElement('div'); document.body.append(host);
  const editor = new CanvasEditor(host, { paragraphs: [paragraph('Alpha'), paragraph('Beta')] });
  const cache = editor.measure.paragraphCache();
  expect(cache.entries.size).toBeGreaterThan(0);
  editor.measureCache.clear();
  expect(cache.entries.size).toBe(0);
  editor.relayout();
  const size = cache.entries.size;
  expect(size).toBeGreaterThan(0);
  // Each keystroke replaces the edited paragraph; old versions do not pile up.
  editor.focus(); editor.model.select(5);
  for (let i = 0; i < 20; i++) editor.execute(() => editor.model.replace('x'));
  expect(editor.model.text.startsWith('Alpha' + 'x'.repeat(20))).toBe(true);
  expect(cache.entries.size).toBeLessThanOrEqual(size + 5);
  editor.destroy();
});
