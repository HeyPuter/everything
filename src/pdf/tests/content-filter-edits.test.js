import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { contentReport, filterContent } from '../src/core/content-filter.js';

afterEach(() => vi.restoreAllMocks());

const shapes = (count) =>
  Array.from({ length: count }, (_, i) => `q 0 0 1 rg ${i % 50} ${(i / 50) | 0} 5 5 re f Q`).join(
    '\n',
  );

describe('filtering content', () => {
  it('removes many paths in one pass over the stream rather than one copy per path', async () => {
    const doc = await PDFDocument.create();
    const source = shapes(3000);
    // Every other shape goes, as a redaction across a page of shapes takes hundreds of them.
    let painted = 0;
    const policy = { path: () => painted++ % 2 === 0 };
    const slice = vi.spyOn(String.prototype, 'slice');
    const result = await filterContent(doc, {
      source,
      resources: doc.context.obj({}),
      policy,
      report: contentReport(),
    });
    const copied = slice.mock.results.reduce((sum, { value }) => sum + value.length, 0);
    slice.mockRestore();
    expect(result.changed).toBe(true);
    expect(result.source).toBe(
      source
        .split('\n')
        .map((line, i) => (i % 2 ? line : 'q 0 0 1 rg  Q'))
        .join('\n'),
    );
    // Splicing each removal into the whole stream copied about 1,500 streams' worth.
    expect(copied).toBeLessThan(source.length * 3);
  });
  it('keeps what lies between removed paths', async () => {
    const doc = await PDFDocument.create();
    const source = '0 0 5 5 re f 1 1 5 5 re f';
    const result = await filterContent(doc, {
      source,
      resources: doc.context.obj({}),
      policy: { path: () => true },
      report: contentReport(),
    });
    expect(result.source).toBe(' ');
  });
});
