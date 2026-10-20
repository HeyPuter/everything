import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFString } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  duplicatePage,
  insertBlankPage,
  insertPdfPages,
  movePage,
  PdfSession,
  reorderPages,
} from '../src/core/document.js';
import { extractPages } from '../src/core/pages.js';
import { addBookmark } from '../src/core/outline-edit.js';
import { addImagePages } from '../src/core/image-pages.js';

const n = PDFName.of;
async function linkedPdf() {
  const doc = await PDFDocument.create();
  for (const width of [200, 210, 220]) doc.addPage([width, 300]);
  const ctx = doc.context,
    shared = ctx.register(ctx.obj([2, 'XYZ', 12, 34, 2]));
  doc.catalog.set(n('OpenAction'), shared);
  doc.catalog.set(n('Dests'), ctx.obj({ legacy: [2, 'Fit'] }));
  doc.catalog.set(
    n('Names'),
    ctx.obj({ Dests: { Names: [PDFString.of('named'), { D: [2, 'FitH', 30] }] } }),
  );
  addBookmark(doc, { title: 'Last page', pageIndex: 2 });
  doc.catalog.lookup(n('Outlines')).lookup(n('First')).set(n('Dest'), shared);
  const jumps = [
    { Dest: shared },
    { A: { S: 'GoTo', D: shared } },
    { Dest: n('legacy') },
    { Dest: PDFString.of('named') },
    { A: { S: ctx.register(n('GoToR')), F: PDFString.of('other.pdf'), D: shared } },
    { A: { S: ctx.register(n('GoTo')), D: shared } },
  ];
  for (const [index, jump] of jumps.entries())
    doc.getPage(0).node.addAnnot(
      ctx.register(
        ctx.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [10, 20 + index * 30, 100, 40 + index * 30],
          ...jump,
        }),
      ),
    );
  return doc;
}

async function expectLinks(bytes, pageIndex, targetIndex) {
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    const pdf = await task.promise;
    const links = (await (await pdf.getPage(pageIndex + 1)).getAnnotations()).filter((a) => a.dest);
    expect(links).toHaveLength(5);
    for (const link of links) {
      const dest = typeof link.dest === 'string' ? await pdf.getDestination(link.dest) : link.dest;
      const index = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
      const page = await pdf.getPage(index + 1);
      expect(page.view[2] - page.view[0]).toBe(220);
      expect(index).toBe(targetIndex);
    }
  } finally {
    await task.destroy();
  }
}

describe('legacy numeric destinations', () => {
  it.each([false, true])(
    'does not activate a missing source-page number against unrelated destination pages (action=%s)',
    async (action) => {
      const source = await PDFDocument.create();
      source.addPage([100, 100]).node.addAnnot(
        source.context.register(
          source.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [0, 0, 20, 20],
            ...(action ? { A: { S: 'GoTo', D: [1, 'Fit'] } } : { Dest: [1, 'Fit'] }),
          }),
        ),
      );
      const target = await PDFDocument.create();
      target.addPage([200, 200]);
      target.addPage([300, 300]);
      await insertPdfPages(target, await source.save());
      const link = target.context.lookup(target.getPage(2).node.Annots().get(0));
      expect(link.get(n('Dest'))).toBeUndefined();
      expect(link.get(n('A'))).toBeUndefined();
    },
  );
  it('stabilizes chained and additional local actions without changing remote or invalid numbers', async () => {
    const doc = await linkedPdf(),
      ctx = doc.context;
    const shared = ctx.register(ctx.obj([2, 'FitH', 60]));
    const local = ctx.obj({ S: 'GoTo', D: shared });
    const remote = ctx.obj({ S: 'GoToE', D: shared, T: { R: 'P' } });
    const invalid = ctx.obj({ S: 'GoTo', D: [-1.5, 'Fit'] });
    const localRef = ctx.register(local);
    local.set(n('Next'), ctx.obj([localRef, remote, invalid]));
    doc.catalog.set(n('AA'), ctx.obj({ WC: localRef }));
    doc.getPage(0).node.set(n('AA'), ctx.obj({ O: localRef }));
    const target = doc.getPage(2).ref;
    movePage(doc, 2, 1);
    movePage(doc, 1, 0);
    expect(local.lookup(n('D')).get(0)).toBe(target);
    expect(local.lookup(n('D')).get(2).asNumber()).toBe(60);
    expect(remote.lookup(n('D')).get(0).asNumber()).toBe(2);
    expect(invalid.lookup(n('D')).get(0).asNumber()).toBe(-1.5);
    await expectLinks(await doc.save(), 1, 0);
  });
  it('keeps local page identity when several pages are reordered at once', async () => {
    const doc = await linkedPdf();
    const target = doc.getPage(2).ref;
    reorderPages(doc, [1, 2, 0]);
    const bytes = await doc.save();
    await expectLinks(bytes, 2, 1);
    const saved = await PDFDocument.load(bytes);
    expect(saved.getPages().map((page) => page.getWidth())).toEqual([210, 220, 200]);
    expect(saved.catalog.lookup(n('OpenAction')).get(0)).toBe(target);
    const action = saved.context.lookup(saved.getPage(2).node.Annots().get(4)).lookup(n('A'));
    expect(action.lookup(n('D')).get(0).asNumber()).toBe(2);
    expect(() => reorderPages(doc, [0, 0, 1])).toThrow('every page');
  });
  it.each(['move', 'blank', 'duplicate', 'insert', 'picture'])(
    'keeps local page identity after %s',
    async (operation) => {
      const doc = await linkedPdf();
      await expectLinks(await doc.save(), 0, 2);
      const target = doc.getPage(2).ref;
      if (operation === 'move') movePage(doc, 2, 1);
      else if (operation === 'blank') insertBlankPage(doc, 0);
      else if (operation === 'duplicate') await duplicatePage(doc, 0);
      else if (operation === 'picture')
        await addImagePages(
          doc,
          [
            Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=',
              'base64',
            ),
          ],
          { after: 0 },
        );
      else {
        const source = await PDFDocument.create();
        source.addPage([100, 100]);
        await insertPdfPages(doc, await source.save(), { after: 0 });
      }
      const bytes = await doc.save(),
        index = operation === 'move' ? 1 : 3;
      await expectLinks(bytes, 0, index);
      if (operation === 'duplicate') await expectLinks(bytes, 1, index);
      const saved = await PDFDocument.load(bytes);
      expect(saved.catalog.lookup(n('OpenAction')).get(0)).toBe(target);
      expect(saved.catalog.lookup(n('Outlines')).lookup(n('First')).lookup(n('Dest')).get(0)).toBe(
        target,
      );
      const action = saved.context.lookup(saved.getPage(0).node.Annots().get(4)).lookup(n('A'));
      expect(action.lookup(n('D')).get(0).asNumber()).toBe(2);
    },
  );

  it.each(['extract', 'insert'])(
    'maps numeric destinations into reordered copies on %s',
    async (operation) => {
      const source = await linkedPdf(),
        original = await source.save();
      await expectLinks(original, 0, 2);
      let bytes;
      if (operation === 'extract') bytes = await extractPages(original, [2, 0]);
      else {
        const target = await PDFDocument.create();
        target.addPage([100, 100]);
        await insertPdfPages(target, original, { pages: [2, 0], after: -1 });
        bytes = await target.save();
      }
      await expectLinks(bytes, 1, 0);
      const saved = await PDFDocument.load(bytes);
      const jump = saved.context.lookup(saved.getPage(1).node.Annots().get(0)).lookup(n('Dest'));
      const remote = saved.context.lookup(saved.getPage(1).node.Annots().get(4)).lookup(n('A'));
      expect(remote.lookup(n('D')).get(0).asNumber()).toBe(2);
      expect(jump.get(0)).toBeInstanceOf(PDFRef);
      expect(
        jump
          .asArray()
          .slice(1)
          .map((v) => v.toString()),
      ).toEqual(['/XYZ', '12', '34', '2']);
    },
  );

  it('drops numeric jumps to omitted pages and preserves undo/redo', async () => {
    const doc = await linkedPdf(),
      bytes = await doc.save();
    const extracted = await PDFDocument.load(await extractPages(bytes, [0, 1]));
    const annotations = extracted.getPage(0).node.Annots();
    for (const ref of annotations.asArray().filter((_, index) => index !== 4)) {
      const link = extracted.context.lookup(ref);
      expect(link.get(n('Dest'))).toBeUndefined();
      expect(link.get(n('A'))).toBeUndefined();
    }
    const session = new PdfSession(bytes);
    await session.change((pdf) => movePage(pdf, 2, 1));
    await expectLinks(session.bytes, 0, 1);
    session.undo();
    expect(session.bytes).toEqual(bytes);
    session.redo();
    await expectLinks(session.bytes, 0, 1);
  });
});
