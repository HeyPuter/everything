import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFRawStream, PDFString, decodePDFRawStream } from 'pdf-lib';
import { fillFields } from '../src/core/document.js';

const drawnSize = (doc, widget) => {
  const stream = doc.context.lookup(widget.dict.lookup(PDFName.of('AP')).get(PDFName.of('N')));
  const data =
    stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
  return Number(new TextDecoder().decode(data).match(/([\d.]+) Tf/)[1]);
};

it('keeps an automatic font size automatic for every widget and later value', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url) =>
      new Response(await readFile(`public/fonts/${String(url).split('/fonts/').pop()}`)),
  );
  try {
    const source = await PDFDocument.create();
    const page = source.addPage();
    const field = source.getForm().createTextField('name');
    field.addToPage(page, { x: 20, y: 600, width: 300, height: 40 });
    field.addToPage(page, { x: 20, y: 100, width: 120, height: 14 });
    field.acroField.dict.set(PDFName.of('DA'), PDFString.of('/Helv 0 Tf 0 g'));
    let doc = await PDFDocument.load(await source.save({ updateFieldAppearances: false }));
    await fillFields(doc, { name: 'Jane Doe' });
    doc = await PDFDocument.load(await doc.save());
    const filled = doc.getForm().getTextField('name').acroField;
    expect(filled.getDefaultAppearance()).toMatch(/ 0 Tf/);
    const [large, small] = filled.getWidgets().map((widget) => drawnSize(doc, widget));
    expect(small).toBeLessThan(large);
    expect(small).toBeLessThanOrEqual(12);
    // A longer value later still shrinks to fit the larger box.
    await fillFields(doc, { name: 'A much longer value that has to shrink to fit its box' });
    doc = await PDFDocument.load(await doc.save());
    const later = doc.getForm().getTextField('name').acroField.getWidgets()[0];
    expect(drawnSize(doc, later)).toBeLessThan(large);
  } finally {
    vi.restoreAllMocks();
  }
});
