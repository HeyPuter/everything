import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { layoutDocument } from '../src/engine/layout.js';
import { createCanvasMeasurer } from '../src/engine/canvas-measurer.js';
import { ParagraphMeasureCache } from '../src/engine/paragraph-measure-cache.js';
import { squareWrapDocx, offset } from './helpers/square-wrap-docx.js';
import { squareHintsKey } from '../src/engine/square-wrap.js';

// Paragraphs on and just before a page with a square-wrapped picture used to be measured again in
// every pass of every layout, since wrapping can change them. A document with pictures on many
// pages took 1.8 s per keystroke. They are now remembered by what wrapping reads of them.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

const context = { fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 6 }) };
const filler = n => Array.from({ length: n }, (_, i) => `<w:p><w:r><w:t xml:space="preserve">Paragraph ${i} ${'runs on beside the picture and past it to the next page. '.repeat(1 + i % 3)}</w:t></w:r></w:p>`).join('');
async function document() {
  const files = unzipSync(squareWrapDocx(['column', offset(0)], ['paragraph', offset(0)]));
  const xml = strFromU8(files['word/document.xml']).replace('<w:body>', `<w:body>${filler(30)}`).replace(/<w:sectPr/, `${filler(30)}<w:sectPr`);
  files['word/document.xml'] = strToU8(xml);
  const pkg = await DocxPackage.open(zipSync(files));
  return new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
}
const lay = (model, measure) => layoutDocument(model.paragraphs, measure, pageGeometry(model.pageSettings), model.numbering, model.tables, undefined, { styles: model.styles });
const plain = layout => JSON.stringify({ ...layout, flowSignature: undefined });

it('measures only the edited paragraph again in a document with a square-wrapped picture', async () => {
  const model = await document(), base = createCanvasMeasurer(context);
  // Text measured during a layout: a paragraph taken from the cache measures none.
  let texts = new Set();
  const measure = Object.assign((text, style) => { texts.add(text); return base(text, style); }, { paragraphCache: base.paragraphCache });
  const first = lay(model, measure);
  expect(first.pageCount).toBeGreaterThan(3);
  expect(first.lines.some(line => line.wrapSegments || line.page === first.floatingObjects[0].page && line.width < 400)).toBe(true);
  // Type into a paragraph pages after the picture.
  const last = model.paragraphs.at(-2);
  model.select(model.text.length - 1 - last.runs.map(r => r.text).join('').length + 3); model.replace('typed ');
  texts = new Set();
  measure.paragraphCache().nextGeneration();
  const cached = lay(model, measure), reused = texts;
  texts = new Set();
  const freshBase = createCanvasMeasurer(context);
  const fresh = lay(model, Object.assign((text, style) => { texts.add(text); return freshBase(text, style); }, { paragraphCache: freshBase.paragraphCache }));
  expect(plain(cached)).toBe(plain(fresh));
  // The edited paragraph is measured again, the paragraphs beside the picture are not.
  expect([...reused].some(text => text.includes('typed'))).toBe(true);
  expect(reused.size).toBeLessThan(texts.size / 10);
});

it('keys a paragraph by the lines and exclusions wrapping reads, counted from its start', () => {
  const line = (page, y, start, end) => ({ page, y, height: 14, start, end });
  const picture = { page: 2, left: 100, right: 200, top: 50, bottom: 150, side: 'bothSides' };
  const hints = (at, exclusions = [picture]) => ({ paragraphs: new Map([['p', [line(1, 700, at, at + 40), line(1, 714, at + 40, at + 80)]], ['far', [line(9, 0, 0, 1)]]]), exclusions });
  // Neither the paragraph's pages nor the next one hold an exclusion.
  expect(squareHintsKey(hints(0), 'far', 0)).toBeNull();
  expect(squareHintsKey(hints(0), 'missing', 0)).toBeNull();
  expect(squareHintsKey(hints(0, []), 'p', 0)).toBeNull();
  // Text typed before the paragraph moves it, not what wrapping reads of it.
  expect(squareHintsKey(hints(0), 'p', 0)).toBe(squareHintsKey(hints(25), 'p', 25));
  expect(squareHintsKey(hints(0), 'p', 0)).not.toBe(squareHintsKey(hints(0, [{ ...picture, top: 60 }]), 'p', 0));
  // Exclusions elsewhere are not read.
  expect(squareHintsKey(hints(0), 'p', 0)).toBe(squareHintsKey(hints(0, [picture, { ...picture, page: 7 }]), 'p', 0));
  // A frame that keeps text off both sides spans infinite edges, which JSON alone would write as null.
  const frame = { ...picture, left: -Infinity, right: Infinity, side: 'largest' };
  expect(squareHintsKey(hints(0, [frame]), 'p', 0)).not.toBe(squareHintsKey(hints(0, [{ ...frame, left: null, right: null }]), 'p', 0));
});
