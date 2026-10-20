import { expect, it } from 'vitest';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { listFonts, readInitialView, writeInitialView } from '../src/core/initial-view.js';

it('reads the defaults of a PDF that does not say how to open', async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  expect(readInitialView(doc)).toEqual({
    layout: 'default',
    panel: 'none',
    fullScreen: false,
    page: 0,
    zoom: 'default',
    displayTitle: false,
  });
});

it('writes the layout, panel, open page, zoom, and title display and reads them back', async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage();
  writeInitialView(doc, {
    layout: 'two-continuous',
    panel: 'bookmarks',
    page: 2,
    zoom: 'page',
    displayTitle: true,
  });
  const reopened = await PDFDocument.load(await doc.save());
  expect(readInitialView(reopened)).toEqual({
    layout: 'two-continuous',
    panel: 'bookmarks',
    fullScreen: false,
    page: 2,
    zoom: 'page',
    displayTitle: true,
  });
  writeInitialView(reopened, { zoom: 1.5 });
  expect(readInitialView(reopened)).toMatchObject({ page: 2, zoom: 1.5 });
});

it('names the two-page layouts as this app shows them, page 1 beside page 2', async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage();
  const layout = () => doc.catalog.lookup(PDFName.of('PageLayout'))?.decodeText();
  writeInitialView(doc, { layout: 'two' });
  expect(layout()).toBe('TwoPageLeft');
  writeInitialView(doc, { layout: 'two-continuous' });
  expect(layout()).toBe('TwoColumnLeft');
  expect(readInitialView(doc).layout).toBe('two-continuous');
});

it('lists the fonts the pages use, with whether each is embedded', async () => {
  const doc = await PDFDocument.create();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const courier = await doc.embedFont(StandardFonts.CourierBold);
  const page = doc.addPage();
  page.drawText('One', { font: helvetica, x: 10, y: 10 });
  page.drawText('Two', { font: courier, x: 10, y: 40 });
  const fonts = listFonts(await PDFDocument.load(await doc.save()));
  expect(fonts.map((font) => [font.name, font.type, font.embedded])).toEqual([
    ['Courier-Bold', 'Type1', false],
    ['Helvetica', 'Type1', false],
  ]);
});

it('reads the PDF/A level a file claims in its XMP metadata', async () => {
  const { readPdfaClaim } = await import('../src/core/initial-view.js');
  const doc = await PDFDocument.create();
  doc.addPage();
  expect(readPdfaClaim(doc)).toBeNull();
  const xmp = `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="2" pdfaid:conformance="U"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  doc.catalog.set(
    (await import('pdf-lib')).PDFName.of('Metadata'),
    doc.context.register(
      doc.context.flateStream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' }),
    ),
  );
  const reopened = await PDFDocument.load(await doc.save());
  expect(readPdfaClaim(reopened)).toEqual({ part: 2, conformance: 'u' });
});
