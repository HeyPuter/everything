import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName } from 'pdf-lib';
import {
  PdfSession,
  deletePage,
  duplicatePage,
  fillFields,
  mergePdf,
} from '../src/core/document.js';

afterEach(() => vi.restoreAllMocks());

/** An XFA form: its form lives in XFA, and the PDF's page only says to wait for it. */
async function xfaPdf({ field = false } = {}) {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  doc.addPage([400, 400]);
  const form = doc.getForm();
  if (field)
    form
      .createTextField('Name')
      .addToPage(doc.getPage(0), { x: 40, y: 300, width: 200, height: 24 });
  const xfa = doc.context.flateStream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"/>');
  form.acroForm.dict.set(PDFName.of('XFA'), doc.context.register(xfa));
  doc.catalog.set(PDFName.of('NeedsRendering'), doc.context.obj(true));
  return doc.save();
}
const hasXfa = async (bytes) =>
  (await PDFDocument.load(bytes)).catalog.lookup(PDFName.of('AcroForm')).has(PDFName.of('XFA'));

for (const [edit, change] of [
  ['deleting a page', (doc) => deletePage(doc, 1)],
  ['duplicating a page', (doc) => duplicatePage(doc, 0)],
  [
    'combining with another PDF',
    async (doc) => mergePdf(doc, await (await PDFDocument.create()).addPage().doc.save()),
  ],
])
  it(`keeps an XFA form after ${edit}`, async () => {
    const session = new PdfSession(await xfaPdf());
    await session.change(change);
    expect(await hasXfa(session.bytes)).toBe(true);
  });

it('still drops the out-of-date XFA of a hybrid form whose fields are filled in', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url))),
  );
  const session = new PdfSession(await xfaPdf({ field: true }));
  await session.change((doc) => fillFields(doc, { Name: 'Ada' }));
  expect(await hasXfa(session.bytes)).toBe(false);
});
