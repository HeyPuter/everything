import { expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { destinationPage } from '../src/outline.js';

it.each([false, true])(
  'rejects out-of-range destinations returned by PDF.js (named=%s)',
  async (named) => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([200, 200]);
    if (named) doc.catalog.set(PDFName.of('Dests'), doc.context.obj({ missing: [3, 'Fit'] }));
    doc.getPage(0).node.addAnnot(
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [10, 10, 100, 40],
          Dest: named ? PDFString.of('missing') : [3, 'Fit'],
        }),
      ),
    );
    const task = pdfjs.getDocument({ data: await doc.save() });
    try {
      const pdf = await task.promise;
      const [link] = await (await pdf.getPage(1)).getAnnotations();
      expect(link.dest).toBeDefined();
      expect(await destinationPage(pdf, link.dest)).toBeNull();
      expect(await destinationPage(pdf, [0, { name: 'Fit' }])).toBe(0);
      expect(await destinationPage(pdf, [2, { name: 'Fit' }])).toBe(2);
      expect(
        await destinationPage(pdf, [
          { num: doc.getPage(2).ref.objectNumber, gen: 0 },
          { name: 'Fit' },
        ]),
      ).toBe(2);
    } finally {
      await task.destroy();
    }
  },
);

it.each([-1, 3, 999, 1.5, NaN, '2', undefined])('rejects invalid page index %s', async (index) => {
  expect(await destinationPage({ numPages: 3 }, [index, { name: 'Fit' }])).toBeNull();
});

it('reads the place on the page that a destination puts at the top left of the view', async () => {
  const { destinationTarget } = await import('../src/outline.js');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 2; i++) doc.addPage([200, 300]);
  const ref = doc.getPage(1).ref;
  doc.catalog.set(
    PDFName.of('Dests'),
    doc.context.obj({
      xyz: [ref, 'XYZ', 20, 150, 2],
      xyzTop: [ref, 'XYZ', null, 120, null],
      fitH: [ref, 'FitH', 80],
      fitV: [ref, 'FitV', 30],
      fitR: [ref, 'FitR', 10, 20, 90, 140],
      fit: [ref, 'Fit'],
    }),
  );
  const task = pdfjs.getDocument({ data: await doc.save() });
  try {
    const pdf = await task.promise;
    const target = (name) => destinationTarget(pdf, name);
    expect(await target('xyz')).toEqual({ page: 1, left: 20, top: 150 });
    expect(await target('xyzTop')).toEqual({ page: 1, left: null, top: 120 });
    expect(await target('fitH')).toEqual({ page: 1, left: null, top: 80 });
    expect(await target('fitV')).toEqual({ page: 1, left: 30, top: null });
    expect(await target('fitR')).toEqual({ page: 1, left: 10, top: 140 });
    expect(await target('fit')).toEqual({ page: 1, left: null, top: null });
    expect(await target('missing')).toBeNull();
  } finally {
    await task.destroy();
  }
});
