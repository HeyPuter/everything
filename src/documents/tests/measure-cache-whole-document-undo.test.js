import { it, expect, vi } from 'vitest';
import { paragraph } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry, DEFAULT_PAGE_SETTINGS } from '../src/engine/page-settings.js';
import { createCanvasMeasurer } from '../src/engine/canvas-measurer.js';
import { ParagraphMeasureCache } from '../src/engine/paragraph-measure-cache.js';

// Formatting a whole document and then undoing it lays every paragraph out twice over. The measured
// paragraphs were kept up to a fixed 10,000, so in a document of more than about 5,000 paragraphs
// (table cells included) the formatting pushed out the measurements Undo needed, and Undo measured
// the whole document again. The cache now keeps room for two measurements of every paragraph (three:
// the third for another view, measure-cache-views.test.js).
const context = { fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 6 }) };
const lay = (paragraphs, measure) => { measure.paragraphCache().nextGeneration(); return layoutDocument(paragraphs, measure, pageGeometry(DEFAULT_PAGE_SETTINGS)); };

it('undoes formatting the whole of a long document from the measurements it had', () => {
  const plain = Array.from({ length: 6000 }, (_, i) => paragraph(`Row ${i} words`, { format: { spaceAfter: 0 } }));
  const bold = plain.map(p => ({ ...p, runs: p.runs.map(r => ({ ...r, bold: true })) }));
  const measure = createCanvasMeasurer(context);
  lay(plain, measure);
  lay(bold, measure);
  const original = ParagraphMeasureCache.prototype.measure;
  let misses = 0;
  const spy = vi.spyOn(ParagraphMeasureCache.prototype, 'measure').mockImplementation(function (key, ...rest) {
    if (!this.entries.has(key)) misses++;
    return original.call(this, key, ...rest);
  });
  const undone = lay(plain, measure);
  spy.mockRestore();
  expect(misses).toBe(0);
  expect(undone.lines.length).toBeGreaterThanOrEqual(6000);
});

it('keeps its limit for short documents and never lowers it', () => {
  const cache = new ParagraphMeasureCache();
  cache.reserve(100); expect(cache.limit).toBe(10000);
  cache.reserve(8000); expect(cache.limit).toBe(25000);
  cache.reserve(10); expect(cache.limit).toBe(25000);
});
