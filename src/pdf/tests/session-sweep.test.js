import { expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PdfSession, deletePage } from '../src/core/document.js';
import { setPageSource } from '../src/core/text-edit.js';

async function twoPages() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 300]).drawText('Public page', { x: 20, y: 200, size: 12, font });
  doc.addPage([300, 300]).drawText('SECRET page', { x: 20, y: 200, size: 12, font });
  return new PdfSession(await doc.save({ useObjectStreams: false }));
}
/** Whether any stream of the saved file, decoded, still holds `text` (as drawn, in hex). */
async function contains(bytes, text) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const wanted = Buffer.from(text).toString('hex').toUpperCase();
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const data = Buffer.from(decodePDFRawStream(object).decode()).toString('latin1');
    if (data.includes(wanted)) return true;
  }
  return false;
}

it('leaves no trace of a deleted page in the saved file', async () => {
  const session = await twoPages();
  expect(await contains(session.bytes, 'SECRET page')).toBe(true);
  await session.change((doc) => doc.removePage(1));
  expect(await contains(session.bytes, 'SECRET page')).toBe(false);
  expect(await contains(session.bytes, 'Public page')).toBe(true);
});

it('does not keep replaced page content as the PDF is edited again and again', async () => {
  const session = await twoPages();
  const sizes = [];
  for (let i = 0; i < 6; i++) {
    await session.change((doc) =>
      setPageSource(doc, doc.getPage(0), `BT /F1 12 Tf 20 ${100 + i} Td (Edit ${i}) Tj ET`),
    );
    sizes.push(session.bytes.length);
  }
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(64);
});

it('leaves no trace of a deleted page that an article thread ran across', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const pages = ['Public page', 'SECRET page', 'Closing page'].map((text) => {
    const page = doc.addPage([300, 300]);
    page.drawText(text, { x: 20, y: 200, size: 12, font });
    return page;
  });
  // One article running over all three pages, a bead on each (ISO 32000-1, 12.4.3).
  const thread = ctx.obj({ Type: 'Thread' });
  const threadRef = ctx.register(thread);
  const beads = pages.map((page) =>
    ctx.obj({ Type: 'Bead', T: threadRef, P: page.ref, R: [10, 10, 290, 290] }),
  );
  const refs = beads.map((bead) => ctx.register(bead));
  beads.forEach((bead, i) => {
    bead.set(PDFName.of('N'), refs[(i + 1) % 3]);
    bead.set(PDFName.of('V'), refs[(i + 2) % 3]);
    pages[i].node.set(PDFName.of('B'), ctx.obj([refs[i]]));
  });
  thread.set(PDFName.of('F'), refs[0]);
  const aside = ctx.obj({ Type: 'Thread' });
  const asideRef = ctx.register(aside);
  const bead = ctx.obj({ Type: 'Bead', T: asideRef, P: pages[1].ref, R: [0, 0, 50, 50] });
  const beadRef = ctx.register(bead);
  bead.set(PDFName.of('N'), beadRef);
  bead.set(PDFName.of('V'), beadRef);
  aside.set(PDFName.of('F'), beadRef);
  pages[1].node.lookup(PDFName.of('B')).push(beadRef);
  doc.catalog.set(PDFName.of('Threads'), ctx.obj([threadRef, asideRef]));
  const session = new PdfSession(await doc.save({ useObjectStreams: false }));
  await session.change((pdf) => deletePage(pdf, 1));
  expect(await contains(session.bytes, 'SECRET page')).toBe(false);
  expect(await contains(session.bytes, 'Closing page')).toBe(true);
  // The article still runs from the first page to the last one.
  const saved = await PDFDocument.load(session.bytes);
  const first = saved.catalog.lookup(PDFName.of('Threads')).lookup(0).lookup(PDFName.of('F'));
  const next = first.lookup(PDFName.of('N'));
  expect(first.get(PDFName.of('P'))).toBe(saved.getPage(0).ref);
  expect(next.get(PDFName.of('P'))).toBe(saved.getPage(1).ref);
  expect(next.lookup(PDFName.of('N'))).toBe(first);
  expect(first.lookup(PDFName.of('V'))).toBe(next);
  const task = pdfjs.getDocument({ data: session.bytes.slice() });
  try {
    expect((await task.promise).numPages).toBe(2);
  } finally {
    await task.destroy();
  }
  // An article that ran over the deleted page alone goes with it.
  expect(saved.catalog.lookup(PDFName.of('Threads')).size()).toBe(1);
});
