import { expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PdfSession, deletePage, duplicatePage, insertBlankPage } from '../src/core/document.js';

async function labelled() {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 5; i++) doc.addPage([300, 300]);
  // Front matter i, ii; then the body 1, 2, 3.
  doc.catalog.set(
    PDFName.of('PageLabels'),
    doc.context.obj({ Nums: [0, { S: 'r' }, 2, { S: 'D' }] }),
  );
  return doc.save();
}
async function labels(bytes) {
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    return await (await task.promise).getPageLabels();
  } finally {
    await task.destroy();
  }
}

for (const [label, operation, expected] of [
  ['deleting the first page', (doc) => deletePage(doc, 0), ['i', '1', '2', '3']],
  ['deleting the first body page', (doc) => deletePage(doc, 2), ['i', 'ii', '1', '2']],
  ['deleting the last page', (doc) => deletePage(doc, 4), ['i', 'ii', '1', '2']],
  [
    'adding a blank page in the front matter',
    (doc) => insertBlankPage(doc, 1),
    ['i', 'ii', 'iii', '1', '2', '3'],
  ],
  [
    'adding a blank page after the body',
    (doc) => insertBlankPage(doc, 4),
    ['i', 'ii', '1', '2', '3', '4'],
  ],
  [
    'duplicating the last front matter page',
    (doc) => duplicatePage(doc, 1),
    ['i', 'ii', 'iii', '1', '2', '3'],
  ],
])
  it(`keeps page labels with their pages after ${label}`, async () => {
    const session = new PdfSession(await labelled());
    await session.change(operation);
    expect(await labels(session.bytes)).toEqual(expected);
  });

it('extracted pages and the parts of a split keep their page labels', async () => {
  const { extractPages } = await import('../src/core/pages.js');
  const { splitPdf } = await import('../src/core/split.js');
  const bytes = await labelled();
  expect(await labels(await extractPages(bytes, [1, 2, 3]))).toEqual(['ii', '1', '2']);
  // Out of order, each page still says what it said.
  expect(await labels(await extractPages(bytes, [4, 0]))).toEqual(['3', 'i']);
  // Pages that were numbered from 1 need no labels of their own.
  expect(await labels(await extractPages(bytes, [2, 3]))).toBeNull();
  const parts = await splitPdf(
    bytes,
    [
      [0, 1],
      [2, 3, 4],
    ],
    'Book',
  );
  expect(await labels(parts[0].bytes)).toEqual(['i', 'ii']);
  expect(await labels(parts[1].bytes)).toBeNull();
  const thirds = await splitPdf(bytes, [[0], [1, 2], [3, 4]], 'Book');
  expect(await Promise.all(thirds.map((part) => labels(part.bytes)))).toEqual([
    ['i'],
    ['ii', '1'],
    ['2', '3'],
  ]);
});

it('pages inserted from a PDF with page labels keep them, and the pages around them keep theirs', async () => {
  const { insertPdfPages } = await import('../src/core/document.js');
  const appendix = await PDFDocument.create();
  for (let i = 0; i < 2; i++) appendix.addPage([300, 300]);
  appendix.catalog.set(
    PDFName.of('PageLabels'),
    appendix.context.obj({ Nums: [0, { S: 'D', P: PDFString.of('A-') }] }),
  );
  const appendixBytes = await appendix.save();
  let session = new PdfSession(await labelled());
  await session.change((doc) => insertPdfPages(doc, appendixBytes, { after: 2 }));
  expect(await labels(session.bytes)).toEqual(['i', 'ii', '1', 'A-1', 'A-2', '2', '3']);
  // Into a PDF without labels, the other pages keep showing their page numbers.
  const plain = await PDFDocument.create();
  for (let i = 0; i < 3; i++) plain.addPage([300, 300]);
  const plainBytes = await plain.save();
  session = new PdfSession(plainBytes);
  await session.change((doc) => insertPdfPages(doc, appendixBytes, { after: 0 }));
  expect(await labels(session.bytes)).toEqual(['1', 'A-1', 'A-2', '4', '5']);
  // Pages without labels of their own carry on the numbering where they land.
  session = new PdfSession(await labelled());
  await session.change((doc) => insertPdfPages(doc, plainBytes, { after: 4 }));
  expect(await labels(session.bytes)).toEqual(['i', 'ii', '1', '2', '3', '4', '5', '6']);
});
