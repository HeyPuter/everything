import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, PDFString, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { addNote } from '../src/core/notes.js';
import { addHighlight, rectQuad } from '../src/core/highlight.js';
import { addLink } from '../src/core/links.js';
import { collectComments, MAX_COMMENTS } from '../src/core/comments.js';

async function withPdf(bytes, fn) {
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    return await fn(await task.promise);
  } finally {
    await task.destroy();
  }
}

describe('collecting comments', () => {
  it('lists notes and markups by page with their text, author, date, and color, skipping the rest', async () => {
    const doc = await PDFDocument.create();
    const first = doc.addPage([300, 300]);
    doc.addPage([300, 300]);
    first.drawText('Hello', { x: 20, y: 200, size: 12 });
    addHighlight(doc, 0, {
      quads: [rectQuad({ x: 20, y: 195, width: 40, height: 14 })],
      hex: '#ffff00',
    });
    addNote(doc, 1, { x: 50, y: 250, text: 'Check this figure', hex: '#f2c438', author: 'Ada' });
    addLink(doc, 0, { rect: { x: 0, y: 0, width: 50, height: 50 }, url: 'example.com' });
    first.node.addAnnot(
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Square',
          Rect: [100, 100, 150, 150],
          C: [1, 0, 0],
          Contents: PDFString.of('Boxed'),
          T: PDFString.of('Grace'),
          M: PDFString.of('D:20260914120000Z'),
        }),
      ),
    );
    const comments = await withPdf(await doc.save(), (pdf) => collectComments(pdf));
    expect(comments.map((c) => [c.page, c.subtype])).toEqual([
      [0, 'Highlight'],
      [0, 'Square'],
      [1, 'Text'],
    ]);
    expect(comments[0]).toMatchObject({ kind: 'Highlight', reveal: 'highlight', hex: '#ffff00' });
    expect(comments[1]).toMatchObject({
      kind: 'Rectangle',
      text: 'Boxed',
      author: 'Grace',
      hex: '#ff0000',
    });
    expect(comments[1].date.toISOString()).toBe('2026-09-14T12:00:00.000Z');
    expect(comments[2]).toMatchObject({
      kind: 'Note',
      reveal: 'note',
      text: 'Check this figure',
      author: 'Ada',
    });
    expect(comments[2].id).toMatch(/^\d+R$/);
    expect(comments[2].date).toBeInstanceOf(Date);
  });
  it('leaves out hidden and NoView annotations, which the page does not show', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    addNote(doc, 0, { x: 40, y: 280, text: 'shown' });
    addNote(doc, 0, { x: 140, y: 280, text: 'hidden' });
    addNote(doc, 0, { x: 240, y: 280, text: 'no view' });
    const notes = page.node
      .Annots()
      .asArray()
      .map((ref) => doc.context.lookup(ref))
      .filter((dict) => dict.get(PDFName.of('Subtype')) === PDFName.of('Text'));
    notes[1].set(PDFName.of('F'), PDFNumber.of(2));
    notes[2].set(PDFName.of('F'), PDFNumber.of(32));
    const comments = await withPdf(await doc.save(), (pdf) => collectComments(pdf));
    expect(comments.map((c) => c.text)).toEqual(['shown']);
  });
  it('excludes comments in hidden groups and membership expressions', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const ctx = doc.context,
      n = PDFName.of;
    const group = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Off') }));
    doc.catalog.set(n('OCProperties'), ctx.obj({ OCGs: [group], D: { OFF: [group] } }));
    const hiddenMembership = ctx.register(ctx.obj({ Type: 'OCMD', OCGs: [group], P: 'AllOn' }));
    const visibleMembership = ctx.register(
      ctx.obj({ Type: 'OCMD', OCGs: [group], VE: ['Not', group] }),
    );
    for (const [i, layer] of [undefined, group, hiddenMembership, visibleMembership].entries()) {
      const note = addNote(doc, 0, { x: 30 + i * 60, y: 250, text: `Note ${i}` });
      const ref = page.node
        .Annots()
        .asArray()
        .find((ref) => ref.toString() === note);
      if (layer) ctx.lookup(ref).set(n('OC'), layer);
    }
    const comments = await withPdf(await doc.save(), (pdf) => collectComments(pdf));
    expect(comments.map((c) => c.text)).toEqual(['Note 0', 'Note 3']);
  });
  it('lists a reply to a note that is gone, as the page offers it as a note', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    addNote(doc, 0, { x: 40, y: 280, text: 'Kept' });
    addNote(doc, 0, { x: 140, y: 280, text: 'Deleted' });
    const [kept, , gone] = page.node.Annots().asArray();
    const reply = (parent, text) =>
      page.node.Annots().push(
        doc.context.register(
          doc.context.obj({
            Type: 'Annot',
            Subtype: 'Text',
            Rect: [40, 260, 60, 280],
            F: 28,
            IRT: parent,
            Contents: PDFString.of(text),
          }),
        ),
      );
    reply(kept, 'Answered');
    reply(gone, 'Left behind');
    // Another editor deleted the second note (and its popup) but not its reply.
    page.node.Annots().remove(3);
    page.node.Annots().remove(2);
    const comments = await withPdf(await doc.save(), (pdf) => collectComments(pdf));
    expect(comments.map((c) => c.text)).toEqual(['Kept', 'Left behind']);
  });
  it('returns an empty list for a plain PDF and null when superseded', async () => {
    const doc = await PDFDocument.create();
    doc
      .addPage([200, 200])
      .drawRectangle({ x: 10, y: 10, width: 50, height: 50, color: rgb(0, 0, 1) });
    const bytes = await doc.save();
    expect(await withPdf(bytes, (pdf) => collectComments(pdf))).toEqual([]);
    expect(
      await withPdf(bytes, (pdf) => collectComments(pdf, { isCurrent: () => false })),
    ).toBeNull();
    expect(MAX_COMMENTS).toBeGreaterThan(100);
  });

  it('collects one comment past the cap so a cut list can be told from a full one', async () => {
    const build = async (total) => {
      const doc = await PDFDocument.create();
      const perPage = 80;
      for (let made = 0; made < total;) {
        const page = doc.addPage([300, 300]);
        for (let i = 0; i < perPage && made < total; i++, made++)
          page.node.addAnnot(
            doc.context.register(
              doc.context.obj({
                Type: 'Annot',
                Subtype: 'Square',
                Rect: [10, 10, 20, 20],
                Contents: PDFString.of(`Remark ${made + 1}`),
              }),
            ),
          );
      }
      return withPdf(await doc.save(), (pdf) => collectComments(pdf));
    };
    // Exactly the cap is a full list; one more stops one past it, so the panel knows.
    expect((await build(MAX_COMMENTS)).length).toBe(MAX_COMMENTS);
    expect((await build(MAX_COMMENTS + 5)).length).toBe(MAX_COMMENTS + 1);
  }, 60000);
});
