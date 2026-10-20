import { expect, it, vi } from 'vitest';
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFString,
  StandardFonts,
  decodePDFRawStream,
} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PdfSession, deletePage, deletePages } from '../src/core/document.js';

/** Three tagged pages, each with a paragraph, and a list that spans the second and third. */
async function tagged() {
  const doc = await PDFDocument.create();
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const pages = ['PUBLIC', 'TOPSECRET', 'CLOSING'].map((word, i) => {
    const page = doc.addPage([300, 300]);
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font.ref } }));
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(
        doc.context.stream(
          `/P <</MCID 0>> BDC BT /F1 20 Tf 20 200 Td (${word}) Tj ET EMC ` +
            `/LI <</MCID 1>> BDC BT /F1 12 Tf 20 100 Td (item ${i}) Tj ET EMC`,
        ),
      ),
    );
    page.node.set(PDFName.of('StructParents'), doc.context.obj(i));
    return page;
  });
  const paragraphs = pages.map((page) =>
    doc.context.register(doc.context.obj({ Type: 'StructElem', S: 'P', Pg: page.ref, K: 0 })),
  );
  const list = doc.context.register(
    doc.context.obj({
      Type: 'StructElem',
      S: 'L',
      Pg: pages[1].ref,
      K: [1, { Type: 'MCR', Pg: pages[2].ref, MCID: 1 }],
    }),
  );
  const root = doc.context.register(
    doc.context.obj({
      Type: 'StructTreeRoot',
      K: [...paragraphs, list],
      ParentTree: {
        Nums: [0, [paragraphs[0]], 1, [paragraphs[1], list], 2, [paragraphs[2], list]],
      },
    }),
  );
  for (const ref of [...paragraphs, list]) doc.context.lookup(ref).set(PDFName.of('P'), root);
  doc.catalog.set(PDFName.of('StructTreeRoot'), root);
  doc.catalog.set(PDFName.of('MarkInfo'), doc.context.obj({ Marked: true }));
  return doc.save({ useObjectStreams: false });
}

async function streamsContain(bytes, text) {
  const doc = await PDFDocument.load(bytes);
  return doc.context
    .enumerateIndirectObjects()
    .some(
      ([, object]) =>
        object instanceof PDFRawStream &&
        Buffer.from(decodePDFRawStream(object).decode()).toString('latin1').includes(text),
    );
}

it('takes a deleted page out of the structure tree so nothing of it stays in the file', async () => {
  const session = new PdfSession(await tagged());
  await session.change((doc) => deletePage(doc, 1));
  expect(await streamsContain(session.bytes, 'TOPSECRET')).toBe(false);
  const doc = await PDFDocument.load(session.bytes);
  const root = doc.catalog.lookup(PDFName.of('StructTreeRoot'));
  const kids = root
    .lookup(PDFName.of('K'))
    .asArray()
    .map((ref) => doc.context.lookup(ref));
  expect(kids.map((kid) => kid.lookup(PDFName.of('S')).decodeText())).toEqual(['P', 'P', 'L']);
  // The list keeps its item on the closing page and no longer names the deleted one.
  const list = kids[2];
  expect(list.has(PDFName.of('Pg'))).toBe(false);
  expect(list.lookup(PDFName.of('K')).size()).toBe(1);
  const nums = root.lookup(PDFName.of('ParentTree')).lookup(PDFName.of('Nums'));
  expect(
    nums
      .asArray()
      .filter((_, i) => i % 2 === 0)
      .map((key) => key.asNumber()),
  ).toEqual([0, 2]);
  const task = pdfjs.getDocument({ data: session.bytes.slice() });
  try {
    const pdf = await task.promise;
    expect(pdf.numPages).toBe(2);
    const tree = await (await pdf.getPage(2)).getStructTree();
    expect(JSON.stringify(tree)).toContain('"role":"L"');
  } finally {
    await task.destroy();
  }
});

it('leaves nothing of a deleted page that the tags name by ID', async () => {
  // Some tagging tools give every element an ID and list them in the ID tree.
  const source = await PDFDocument.load(await tagged());
  const root = source.catalog.lookup(PDFName.of('StructTreeRoot'));
  const elements = root.lookup(PDFName.of('K')).asArray();
  const names = elements.flatMap((ref, i) => [PDFString.of(`id${i}`), ref]);
  root.set(PDFName.of('IDTree'), source.context.obj({ Kids: [{ Names: names }] }));
  const session = new PdfSession(await source.save({ useObjectStreams: false }));
  await session.change((doc) => deletePage(doc, 1));
  expect(await streamsContain(session.bytes, 'TOPSECRET')).toBe(false);
  expect(await streamsContain(session.bytes, 'CLOSING')).toBe(true);
  const doc = await PDFDocument.load(session.bytes);
  const leaf = doc.catalog
    .lookup(PDFName.of('StructTreeRoot'))
    .lookup(PDFName.of('IDTree'))
    .lookup(PDFName.of('Kids'))
    .lookup(0);
  const ids = leaf
    .lookup(PDFName.of('Names'))
    .asArray()
    .filter((_, i) => i % 2 === 0)
    .map((id) => id.decodeText());
  // The deleted page's paragraph goes; the list it shared with the next page stays.
  expect(ids).toEqual(['id0', 'id2', 'id3']);
});

it('takes many deleted pages out of the tags in one pass', async () => {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const paragraphs = [];
  const nums = [];
  for (let i = 0; i < 30; i++) {
    const page = doc.addPage([300, 300]);
    page.node.set(
      PDFName.of('Contents'),
      ctx.register(ctx.stream(`/P <</MCID 0>> BDC BT 20 200 Td (page ${i}) Tj ET EMC`)),
    );
    page.node.set(PDFName.of('StructParents'), ctx.obj(i));
    const paragraph = ctx.register(ctx.obj({ Type: 'StructElem', S: 'P', Pg: page.ref, K: 0 }));
    paragraphs.push(paragraph);
    nums.push(i, [paragraph]);
  }
  const body = ctx.obj({ Type: 'StructElem', S: 'Document', K: paragraphs });
  const root = ctx.obj({
    Type: 'StructTreeRoot',
    K: [ctx.register(body)],
    ParentTree: { Nums: nums },
  });
  doc.catalog.set(PDFName.of('StructTreeRoot'), ctx.register(root));
  // A long tagged document has many thousands of tags; walking them all again for each
  // deleted page made deleting many pages slow.
  const removed = Array.from({ length: 20 }, (_, i) => i + 5);
  const lookup = PDFDict.prototype.lookup;
  let walks = 0;
  const spy = vi.spyOn(PDFDict.prototype, 'lookup').mockImplementation(function (key, ...rest) {
    if (this === body && key === PDFName.of('K')) walks++;
    return lookup.call(this, key, ...rest);
  });
  try {
    deletePages(doc, removed);
  } finally {
    spy.mockRestore();
  }
  expect(walks).toBeLessThan(5);
  expect(doc.getPageCount()).toBe(10);
  const left = body.lookup(PDFName.of('K')).asArray();
  expect(left).toEqual([...paragraphs.slice(0, 5), ...paragraphs.slice(25)]);
  const keys = root
    .lookup(PDFName.of('ParentTree'))
    .lookup(PDFName.of('Nums'))
    .asArray()
    .filter((_, i) => i % 2 === 0)
    .map((key) => key.asNumber());
  expect(keys).toEqual([0, 1, 2, 3, 4, 25, 26, 27, 28, 29]);
});
