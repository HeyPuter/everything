import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, degrees } from 'pdf-lib';
import { PdfSession, deletePage, rotatePage } from '../src/core/document.js';

async function pdf(sizes) {
  const doc = await PDFDocument.create();
  for (const size of sizes) doc.addPage(size);
  return doc.save();
}

describe('page geometry across revisions', () => {
  it('keeps its number through edits that resize no page, and their undo and redo', async () => {
    const session = new PdfSession(
      await pdf([
        [612, 792],
        [1000, 612],
        [612, 792],
      ]),
    );
    const opened = session.geometry;
    await session.change((doc) => doc.setTitle('Renamed'));
    expect(session.geometry).toBe(opened);
    await session.change((doc) => rotatePage(doc, 1));
    const turned = session.geometry;
    expect(turned).not.toBe(opened);
    session.undo();
    expect(session.geometry).toBe(opened);
    session.redo();
    expect(session.geometry).toBe(turned);
    await session.change((doc) => doc.setAuthor('Someone'));
    expect(session.geometry).toBe(turned);
  });

  it('changes with a page box, an inherited one, a unit, or the page count', async () => {
    const changes = [
      (doc) => doc.getPage(0).setMediaBox(0, 0, 500, 500),
      (doc) => doc.getPage(0).setCropBox(10, 10, 300, 300),
      (doc) => doc.catalog.Pages().set(PDFName.of('Rotate'), doc.context.obj(90)),
      (doc) =>
        doc.catalog.Pages().set(PDFName.of('MediaBox'), doc.context.obj([0, 0, 200, 200])) ||
        doc.getPages().forEach((page) => page.node.delete(PDFName.of('MediaBox'))),
      (doc) => doc.getPage(1).node.set(PDFName.of('UserUnit'), doc.context.obj(2)),
      (doc) => doc.getPage(1).setRotation(degrees(180)),
      (doc) => deletePage(doc, 2),
      (doc) => doc.addPage([612, 792]),
    ];
    for (const change of changes) {
      const session = new PdfSession(
        await pdf([
          [612, 792],
          [612, 792],
          [612, 792],
        ]),
      );
      const opened = session.geometry;
      await session.change(change);
      expect(session.geometry).not.toBe(opened);
    }
  });

  it('counts pages adopted from elsewhere as resized', async () => {
    const session = new PdfSession(await pdf([[612, 792]]));
    const opened = session.geometry;
    session.adopt(await pdf([[612, 792]]));
    expect(session.geometry).not.toBe(opened);
  });
});
