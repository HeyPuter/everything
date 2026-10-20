import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  PDFDocument,
  PDFName,
  PDFHexString,
  PDFNumber,
  PDFPageTree,
  StandardFonts,
  degrees,
  decodePDFRawStream,
} from 'pdf-lib';
import {
  PdfSession,
  safeName,
  validatePdf,
  blankPdf,
  samplePdf,
  normalizeRect,
  rotatePage,
  deletePage,
  movePage,
  insertBlankPage,
  visibleBox,
  mergePdf,
  insertPdfPages,
  duplicatePage,
  duplicatePages,
  drawMark,
  fillFields,
  addImage,
  listFields,
  MAX_FILE_SIZE,
  MAX_IMAGE_SIZE,
  MAX_PAGES,
  textVariant,
  addText,
} from '../src/core/document.js';
import { addImagePages } from '../src/core/image-pages.js';
import { addLink } from '../src/core/links.js';

describe('PDF validation and names', () => {
  it('sanitizes paths and control characters while keeping one extension', () => {
    expect(safeName('../a\\b\u0000.PDF')).toBe('.. a b.pdf');
    expect(safeName('')).toBe('Untitled.pdf');
  });
  it.each(['漢'.repeat(120), '😀'.repeat(90), 'a'.repeat(179) + '😀'])(
    'keeps long Unicode filenames within the byte budget without splitting characters',
    (value) => {
      const name = safeName(value);
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(184);
      expect(name.isWellFormed()).toBe(true);
      expect(value.startsWith(name.slice(0, -4))).toBe(true);
      expect(safeName(name)).toBe(name);
    },
  );
  it('retains ordinary Unicode filenames', () => {
    expect(safeName('日本語 😀.PDF')).toBe('日本語 😀.pdf');
  });
  it('rejects corrupt, empty and oversized files with useful errors', async () => {
    await expect(validatePdf(new Uint8Array())).rejects.toThrow('empty');
    await expect(validatePdf(new Uint8Array([1, 2, 3]))).rejects.toThrow('not a PDF');
    await expect(validatePdf(new TextEncoder().encode('Plain text file'))).rejects.toThrow(
      'not a PDF',
    );
    const damaged = new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Type /Catalog >>\ngarbage');
    await expect(validatePdf(damaged)).rejects.toThrow('damaged');
    await expect(validatePdf({ length: MAX_FILE_SIZE + 1 })).rejects.toThrow('100 MB');
  });
  it('creates readable standard PDF files and fillable samples', async () => {
    expect((await validatePdf(await blankPdf())).getPageCount()).toBe(1);
    const d = await validatePdf(await samplePdf());
    expect(listFields(d)).toMatchObject([{ name: 'Your name', type: 'text', value: '' }]);
  });
});
describe('atomic editing and undo', () => {
  it('rejects oversized exports without committing an unreadable working copy', async () => {
    const bytes = await blankPdf();
    const s = new PdfSession(bytes);
    await expect(
      s.change((d) => {
        const stream = d.context.stream(new Uint8Array(MAX_FILE_SIZE));
        d.catalog.set(PDFName.of('LargeStream'), d.context.register(stream));
      }),
    ).rejects.toThrow('100 MB');
    expect(s.bytes).toEqual(bytes);
    expect(s.past).toHaveLength(0);
    expect(s.dirty).toBe(false);
  });
  it('rejects edits exceeding the page limit without changing history or bytes', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < MAX_PAGES; i++) doc.addPage();
    const bytes = await doc.save();
    const s = new PdfSession(bytes);
    await expect(s.change((d) => d.addPage())).rejects.toThrow('1,000 pages');
    expect(s.bytes).toEqual(bytes);
    expect(s.past).toHaveLength(0);
    expect(s.dirty).toBe(false);
    await s.change((d) => rotatePage(d, 0));
    expect((await validatePdf(s.bytes)).getPageCount()).toBe(MAX_PAGES);
  });
  it('restores exact bytes and tracks save state across undo and branching', async () => {
    const bytes = await blankPdf();
    const s = new PdfSession(bytes);
    expect(s.dirty).toBe(false);
    await s.change((d) => rotatePage(d, 0));
    expect(s.dirty).toBe(true);
    s.markSaved();
    s.undo();
    expect(s.bytes).toEqual(bytes);
    expect(s.dirty).toBe(true);
    s.redo();
    expect(s.dirty).toBe(false);
    s.undo();
    await s.change((d) => d.addPage());
    expect(s.future).toHaveLength(0);
    expect(s.dirty).toBe(true);
  });
  it('does not commit a partial failed operation', async () => {
    const bytes = await blankPdf();
    const s = new PdfSession(bytes);
    await expect(
      s.change((d) => {
        d.addPage();
        throw new Error('failure');
      }),
    ).rejects.toThrow('failure');
    expect(s.bytes).toEqual(bytes);
    expect(s.past).toHaveLength(0);
  });
  it('does not mark concurrent edits saved by an older cloud write', async () => {
    const s = new PdfSession(await blankPdf());
    await s.change((d) => d.addPage());
    const revision = s.revision;
    await s.change((d) => d.addPage());
    s.markSaved(revision);
    expect(s.dirty).toBe(true);
  });
  it('bounds retained history', async () => {
    const s = new PdfSession(await blankPdf());
    for (let i = 0; i < 30; i++) await s.change((d) => rotatePage(d, 0));
    expect(s.past).toHaveLength(25);
  });
});
describe('page operations persist correctly', () => {
  it.each([
    [0, 160, 310, 180],
    [90, 325, 325, 150],
    [180, 340, 490, 180],
    [270, 175, 475, 150],
    [-90, 175, 475, 150],
  ])('centers images within the visible crop at %i degrees', async (angle, x, y, size) => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    page.setCropBox(100, 200, 300, 400);
    page.setRotation(degrees(angle));
    await addImage(
      doc,
      0,
      new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=',
          'base64',
        ),
      ),
    );
    const reopened = await PDFDocument.load(await doc.save());
    const ref = reopened.getPage(0).node.Contents().get(0);
    const contents = Buffer.from(
      decodePDFRawStream(reopened.context.lookup(ref)).decode(),
    ).toString();
    expect(contents).toContain(`1 0 0 1 ${x} ${y} cm`);
    expect(contents).toContain(`${size} 0 0 ${size} 0 0 cm`);
  });
  it('rejects images that are not decodable PNG or JPEG files', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const gif = new Uint8Array(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary'));
    await expect(addImage(doc, 0, gif)).rejects.toThrow('valid PNG or JPEG');
    const truncatedPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    await expect(addImage(doc, 0, truncatedPng)).rejects.toThrow('valid PNG or JPEG');
    const truncatedJpeg = new Uint8Array([255, 216, 255, 224, 0, 16]);
    await expect(addImage(doc, 0, truncatedJpeg)).rejects.toThrow('valid PNG or JPEG');
    await expect(addImage(doc, 0, new Uint8Array())).rejects.toThrow('valid PNG or JPEG');
    await expect(addImage(doc, 0, { length: MAX_IMAGE_SIZE + 1 })).rejects.toThrow('20 MB');
    expect(doc.getPage(0).node.Contents()).toBeUndefined();
  });
  it('keeps radio options aligned with their widgets after deleting a page', async () => {
    const d = await PDFDocument.create();
    const removed = d.addPage();
    const kept = d.addPage();
    const radio = d.getForm().createRadioGroup('Choice');
    radio.addOptionToPage('First', removed);
    radio.addOptionToPage('Second', kept);
    radio.addOptionToPage('Third', kept);
    radio.select('Third');
    deletePage(d, 0);
    const reopened = await PDFDocument.load(await d.save());
    const field = reopened.getForm().getRadioGroup('Choice');
    expect(field.getOptions()).toEqual(['Second', 'Third']);
    expect(field.getSelected()).toBe('Third');
    field.select('Second');
    expect(field.getSelected()).toBe('Second');
  });
  it('can delete fields without appearance streams', async () => {
    const d = await PDFDocument.create();
    const page = d.addPage();
    d.addPage();
    const field = d.getForm().createTextField('No appearance');
    field.addToPage(page);
    field.acroField.getWidgets()[0].dict.delete(PDFName.of('AP'));
    deletePage(d, 0);
    expect(listFields(await PDFDocument.load(await d.save()))).toEqual([]);
  });
  it('removes deleted-page fields and keeps shared widgets on remaining pages usable', async () => {
    const d = await PDFDocument.create();
    const removedPage = d.addPage();
    const keptPage = d.addPage();
    const form = d.getForm();
    form.createTextField('Deleted').addToPage(removedPage);
    form.createTextField('Kept').addToPage(keptPage);
    const shared = form.createTextField('Shared');
    shared.setText('Keep this value');
    shared.addToPage(removedPage);
    shared.addToPage(keptPage);
    // Some PDFs identify a widget's page only through the page's annotation array.
    shared.acroField.getWidgets()[0].dict.delete(PDFName.of('P'));
    const session = new PdfSession(await d.save());
    await session.change((doc) => deletePage(doc, 0));
    const reopened = await PDFDocument.load(session.bytes);
    expect(listFields(reopened).map((field) => field.name)).toEqual(['Kept', 'Shared']);
    expect(reopened.getForm().getTextField('Shared').acroField.getWidgets()).toHaveLength(1);
    expect(reopened.getForm().getTextField('Shared').getText()).toBe('Keep this value');
    expect(() => reopened.getForm().flatten()).not.toThrow();
    const target = await PDFDocument.load(await blankPdf());
    await expect(mergePdf(target, session.bytes)).resolves.toBeUndefined();
    session.undo();
    expect(listFields(await PDFDocument.load(session.bytes))).toHaveLength(3);
  });
  it('inserts blank pages that match the visible size, rotation, and unit of the current page', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 300]);
    const landscape = doc.addPage([842, 595]);
    landscape.setRotation(degrees(90));
    landscape.setCropBox(21, 30, 800, 500);
    landscape.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    doc.addPage([200, 300]);
    insertBlankPage(doc, 1);
    expect(doc.getPageCount()).toBe(4);
    const inserted = doc.getPage(2);
    expect(inserted.getSize()).toEqual({ width: 800, height: 500 });
    expect(inserted.getRotation().angle).toBe(90);
    expect(inserted.node.get(PDFName.of('UserUnit'))).toBe(
      landscape.node.get(PDFName.of('UserUnit')),
    );
    expect(doc.getPage(3).getSize()).toEqual({ width: 200, height: 300 });
    const plain = await PDFDocument.create();
    plain.addPage([595.28, 841.89]);
    insertBlankPage(plain, 0);
    expect(plain.getPage(1).getSize()).toEqual({ width: 595.28, height: 841.89 });
    expect(plain.getPage(1).getRotation().angle).toBe(0);
    expect(plain.getPage(1).node.get(PDFName.of('UserUnit'))).toBeUndefined();
  });
  it('gives added pages their own crop box and rotation under a page tree that hands them down', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    // Some writers put a CropBox or Rotate on the page tree's root for every page to inherit.
    const root = doc.catalog.Pages();
    root.set(PDFName.of('CropBox'), doc.context.obj([100, 150, 500, 700]));
    root.set(PDFName.of('Rotate'), PDFNumber.of(90));
    insertBlankPage(doc, 0);
    const other = await PDFDocument.create();
    other.addPage([300, 400]);
    await insertPdfPages(doc, await other.save());
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=',
      'base64',
    );
    await addImagePages(doc, [png], { paper: 'letter' });
    await duplicatePage(doc, 0);
    const reopened = await PDFDocument.load(await doc.save());
    const boxes = reopened.getPages().map((page) => [page.getCropBox(), page.getRotation().angle]);
    expect(boxes).toEqual([
      // The original page, its duplicate, and what the tree gave them.
      [{ x: 100, y: 150, width: 400, height: 550 }, 90],
      [{ x: 100, y: 150, width: 400, height: 550 }, 90],
      // A blank page sized like the original's visible area, turned the same way, uncropped.
      [{ x: 0, y: 0, width: 400, height: 550 }, 90],
      // Pages from another PDF and a picture page keep their own full size, unturned.
      [{ x: 0, y: 0, width: 300, height: 400 }, 0],
      [{ x: 0, y: 0, width: 612, height: 792 }, 0],
    ]);
  });
  it('keeps what a page inherits from its branch of the page tree when moving it to another', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = [1, 2, 3, 4].map((n) => {
      const page = doc.addPage([612, 792]);
      page.drawText(`Page ${n}`, { x: 50, y: 700, size: 40, font });
      return page;
    });
    // Two branches: the first holds landscape pages turned 90 degrees whose font lives on the
    // branch node; the second holds plain portrait pages.
    const root = doc.catalog.Pages();
    const rootRef = doc.catalog.get(PDFName.of('Pages'));
    const branch = (kids) => {
      const node = PDFPageTree.withContext(doc.context, rootRef);
      const ref = doc.context.register(node);
      node.set(PDFName.of('Kids'), doc.context.obj(kids.map((page) => page.ref)));
      node.set(PDFName.of('Count'), PDFNumber.of(kids.length));
      for (const page of kids) page.node.set(PDFName.of('Parent'), ref);
      return [ref, node];
    };
    const [aRef, a] = branch(pages.slice(0, 2));
    const [bRef] = branch(pages.slice(2));
    root.set(PDFName.of('Kids'), doc.context.obj([aRef, bRef]));
    a.set(PDFName.of('MediaBox'), doc.context.obj([0, 0, 842, 595]));
    a.set(PDFName.of('Rotate'), PDFNumber.of(90));
    a.set(PDFName.of('Resources'), pages[0].node.get(PDFName.of('Resources')));
    for (const page of pages.slice(0, 2)) {
      page.node.delete(PDFName.of('MediaBox'));
      page.node.delete(PDFName.of('Resources'));
    }
    const bytes = await doc.save();
    const describe = (d) =>
      d
        .getPages()
        .map((page) => [
          page.getSize(),
          page.getRotation().angle,
          !!page.node.Resources()?.lookup(PDFName.of('Font'))?.entries().length,
        ]);
    const before = describe(await PDFDocument.load(bytes));
    expect(before[0]).toEqual([{ width: 842, height: 595 }, 90, true]);
    expect(before[3]).toEqual([{ width: 612, height: 792 }, 0, true]);
    const down = await PDFDocument.load(bytes);
    movePage(down, 0, 3);
    expect(describe(await PDFDocument.load(await down.save()))[3]).toEqual(before[0]);
    const up = await PDFDocument.load(bytes);
    movePage(up, 3, 0);
    expect(describe(await PDFDocument.load(await up.save()))[0]).toEqual(before[3]);
  });
  it('turns and extends pages whose rotation is not a quarter turn as readers show them', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 500]).node.set(PDFName.of('Rotate'), PDFNumber.of(45));
    // Readers show such a page upright, so one turn from there is 90.
    rotatePage(doc, 0);
    expect(doc.getPage(0).getRotation().angle).toBe(90);
    doc.getPage(0).node.set(PDFName.of('Rotate'), PDFNumber.of(45));
    insertBlankPage(doc, 0);
    expect(doc.getPage(1).getRotation().angle).toBe(0);
    expect(doc.getPage(1).getSize()).toEqual({ width: 400, height: 500 });
  });
  it('treats a page without a MediaBox as Letter, as readers do', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 500]).node.delete(PDFName.of('MediaBox'));
    expect(visibleBox(doc.getPage(0))).toEqual({ x: 0, y: 0, width: 612, height: 792 });
    const session = new PdfSession(await doc.save());
    await session.change((d) => insertBlankPage(d, 0));
    const reopened = await PDFDocument.load(session.bytes);
    expect(reopened.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(reopened.getPage(1).getSize()).toEqual({ width: 612, height: 792 });
  });
  it('rotates, reorders and deletes without losing page identity', async () => {
    const d = await PDFDocument.create();
    d.addPage([100, 200]);
    d.addPage([300, 400]);
    rotatePage(d, 0);
    movePage(d, 0, 1);
    const reopened = await PDFDocument.load(await d.save());
    expect(reopened.getPage(1).getSize()).toEqual({ width: 100, height: 200 });
    expect(reopened.getPage(1).getRotation().angle).toBe(90);
    deletePage(reopened, 0);
    expect(() => deletePage(reopened, 0)).toThrow('at least one');
  });
  it('merges source pages and preserves the original form fields', async () => {
    const d = await PDFDocument.load(await samplePdf());
    await mergePdf(d, await samplePdf());
    const reopened = await PDFDocument.load(await d.save());
    expect(reopened.getPageCount()).toBe(2);
    expect(listFields(reopened)).toHaveLength(1);
  });
  it("carries a merged page's internal links to their new pages and drops the orphan copies", async () => {
    const other = await PDFDocument.create();
    const font = await other.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 3; i++)
      other.addPage([300, 300]).drawText(`S${i + 1}`, { x: 20, y: 200, size: 16, font });
    addLink(other, 0, { rect: { x: 10, y: 250, width: 40, height: 14 }, page: 2 }); // s1 -> s3
    addLink(other, 2, { rect: { x: 10, y: 250, width: 40, height: 14 }, page: 1 }); // s3 -> s2
    const target = await PDFDocument.create();
    target.addPage([300, 300]);
    // Merge only source pages 0 and 2 after the target's page: the s1->s3 link should follow to
    // the copied s3; the s3->s2 link points at a page that was not merged, so it is dropped.
    await insertPdfPages(target, await other.save(), { pages: [0, 2] });
    const reopened = await PDFDocument.load(await target.save());
    expect(reopened.getPageCount()).toBe(3);
    let pageDicts = 0;
    for (const [, obj] of reopened.context.enumerateIndirectObjects())
      if (obj.get?.(PDFName.of('Type')) === PDFName.of('Page')) pageDicts++;
    expect(pageDicts).toBe(3); // no orphan page copies
    const destOf = (index) => {
      const annots = reopened.getPage(index).node.lookup(PDFName.of('Annots'));
      const link = annots
        .asArray()
        .map((r) => reopened.context.lookup(r))
        .find((a) => a.get(PDFName.of('Subtype')) === PDFName.of('Link'));
      const dest = link.get(PDFName.of('Dest'));
      return dest === undefined ? null : reopened.context.lookup(dest).get(0);
    };
    // Merged s1 is target page 1, its link now points at merged s3 (target page 2).
    expect(destOf(1)).toBe(reopened.getPage(2).ref);
    // Merged s3 is target page 2; its link targeted s2, which was not merged, so it is gone.
    expect(destOf(2)).toBeNull();
  });
  it('embeds the bold, italic, and bold italic faces for styled text', async () => {
    const files = new Map();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const file = String(url).split('/').pop();
      if (!files.has(file))
        files.set(file, await readFile(new URL(`../public/fonts/${file}`, import.meta.url)));
      return new Response(files.get(file));
    });
    expect(textVariant(false, false)).toBe('regular');
    expect(textVariant(true, false)).toBe('bold');
    expect(textVariant(false, true)).toBe('italic');
    expect(textVariant(true, true)).toBe('boldItalic');
    const d = await PDFDocument.load(await blankPdf());
    await addText(d, 0, { text: 'Plain', x: 20, y: 200 });
    await addText(d, 0, { text: 'Bold', x: 20, y: 160, variant: 'bold' });
    await addText(d, 0, { text: 'Italic', x: 20, y: 120, variant: 'italic' });
    await addText(d, 0, { text: 'Both', x: 20, y: 80, variant: 'boldItalic' });
    await expect(addText(d, 0, { text: 'x', x: 0, y: 0, variant: 'huge' })).rejects.toThrow(
      'text style',
    );
    const reopened = await PDFDocument.load(await d.save());
    const fonts = reopened.getPage(0).node.Resources().lookup(PDFName.of('Font'));
    const names = fonts
      .entries()
      .map(([, ref]) => reopened.context.lookup(ref).lookup(PDFName.of('BaseFont')).decodeText())
      .map((name) => name.replace(/^[A-Z]{6}\+/, '').replace(/-\d+$/, ''))
      .sort();
    expect(names).toEqual([
      'NotoSans-Bold',
      'NotoSans-BoldItalic',
      'NotoSans-Italic',
      'NotoSans-Regular',
    ]);
    vi.restoreAllMocks();
  });
  it('duplicates a page right after itself as an independent copy', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 100]).drawText('First', { x: 10, y: 50, size: 12 });
    doc.addPage([300, 100]);
    expect(await duplicatePage(doc, 0)).toBe(1);
    expect(doc.getPages().map((p) => p.getWidth())).toEqual([200, 200, 300]);
    const reopened = await PDFDocument.load(await doc.save());
    const [first, copy] = reopened.getPages();
    expect(copy.node.Contents().toString()).not.toBe(first.node.Contents().toString());
    copy.drawText('Only on the copy', { x: 10, y: 20, size: 10 });
    expect(reopened.getPageCount()).toBe(3);
  });
  it("keeps a duplicated page's internal link and drops the hidden page copy", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 3; i++)
      doc.addPage([300, 300]).drawText(`P${i + 1}`, { x: 20, y: 200, size: 16, font });
    addLink(doc, 0, { rect: { x: 10, y: 250, width: 40, height: 14 }, page: 2 }); // p1 -> p3
    await duplicatePage(doc, 0);
    const reopened = await PDFDocument.load(await doc.save());
    expect(reopened.getPageCount()).toBe(4);
    let pageDicts = 0;
    for (const [, obj] of reopened.context.enumerateIndirectObjects())
      if (obj.get?.(PDFName.of('Type')) === PDFName.of('Page')) pageDicts++;
    expect(pageDicts).toBe(4); // no orphan copy of the linked page
    const destPage = (index) => {
      const link = reopened
        .getPage(index)
        .node.lookup(PDFName.of('Annots'))
        .asArray()
        .map((r) => reopened.context.lookup(r))
        .find((a) => a.has(PDFName.of('Dest')));
      return reopened.context.lookup(link.get(PDFName.of('Dest'))).get(0);
    };
    // The original page and its duplicate both link to the existing page 3 (now index 3).
    expect(destPage(0)).toBe(reopened.getPage(3).ref);
    expect(destPage(1)).toBe(reopened.getPage(3).ref);
  });
  it('duplicates a page with a form field without leaving an orphan widget', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    doc.addPage([300, 300]);
    doc.getForm().createTextField('name').addToPage(page, { x: 20, y: 40, width: 200, height: 24 });
    await duplicatePage(doc, 0);
    const bytes = await doc.save();
    const reopened = await PDFDocument.load(bytes);
    expect(reopened.getPageCount()).toBe(3);
    // The one field stays on the original page; the copy carries its appearance as fixed content.
    expect(listFields(reopened).map((f) => f.name)).toEqual(['name']);
    const widgetPages = reopened.getPages().map((p) => (p.node.Annots()?.asArray() || []).length);
    expect(widgetPages).toEqual([1, 0, 0]);
    // The field still fills, and deleting the original page leaves nothing dangling behind.
    const session = new PdfSession(bytes);
    await session.change((d) => fillFields(d, { name: 'Ada' }));
    await session.change((d) => deletePage(d, 0));
    const after = await PDFDocument.load(session.bytes);
    expect(after.getPageCount()).toBe(2);
    expect(listFields(after)).toEqual([]);
    expect(after.getForm().getFields()).toHaveLength(0);
  });
  it('keeps the destination unchanged when an inserted field cannot be flattened', async () => {
    const other = await PDFDocument.create();
    const page = other.addPage([300, 300]);
    const ctx = other.context;
    // An unsigned signature field has no appearance stream; pdf-lib's flatten() throws on it.
    const sig = ctx.register(
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        T: PDFHexString.fromText('sig'),
        Rect: [10, 10, 200, 60],
        F: 4,
        P: page.ref,
      }),
    );
    page.node.addAnnot(sig);
    const text = other.getForm().createTextField('name');
    text.setText('Ada');
    text.addToPage(page, { x: 10, y: 100, width: 200, height: 30 });
    other.catalog.lookup(PDFName.of('AcroForm')).lookup(PDFName.of('Fields')).push(sig);
    const target = await PDFDocument.create();
    target.addPage([100, 100]);
    const session = new PdfSession(await target.save());
    const original = session.bytes.slice();
    const source = await other.save();
    await expect(session.change((doc) => insertPdfPages(doc, source))).rejects.toThrow(
      'could not be flattened safely',
    );
    expect(session.bytes).toEqual(original);
    expect(session.dirty).toBe(false);
    const duplication = new PdfSession(source);
    await expect(duplication.change((doc) => duplicatePage(doc, 0))).rejects.toThrow(
      'could not be flattened safely',
    );
    expect(duplication.bytes).toEqual(source);
    expect(duplication.dirty).toBe(false);
  });
  it('inserts chosen pages of another PDF at a position, in the order given', async () => {
    const target = await PDFDocument.create();
    target.addPage([100, 100]);
    target.addPage([100, 100]);
    const other = await PDFDocument.create();
    for (const width of [201, 202, 203]) other.addPage([width, 300]);
    const bytes = await other.save();
    expect(await insertPdfPages(target, bytes, { pages: [2, 0], after: 0 })).toEqual([1, 2]);
    expect(target.getPages().map((p) => p.getWidth())).toEqual([100, 203, 201, 100]);
    expect(await insertPdfPages(target, bytes, { pages: [1], after: -1 })).toEqual([0]);
    expect(target.getPages().map((p) => p.getWidth())).toEqual([202, 100, 203, 201, 100]);
    expect(await insertPdfPages(target, bytes)).toEqual([5, 6, 7]);
    expect(target.getPageCount()).toBe(8);
    await expect(insertPdfPages(target, bytes, { pages: [] })).rejects.toThrow('at least one page');
    await expect(insertPdfPages(target, bytes, { pages: [3] })).rejects.toThrow('between 1 and 3');
    expect(target.getPageCount()).toBe(8);
  });
  it('exports highlights as annotations and ink as page content', async () => {
    const d = await PDFDocument.load(await blankPdf());
    drawMark(d, 0, {
      type: 'highlight',
      rect: { x: 12, y: 50, width: 100, height: 20 },
      hex: '#ffff00',
    });
    drawMark(d, 0, {
      type: 'ink',
      points: [
        { x: 0, y: 0 },
        { x: 40, y: 80 },
      ],
      width: 2,
      hex: '#111111',
    });
    const reopened = await PDFDocument.load(await d.save());
    expect(reopened.getPage(0).node.Contents().size()).toBeGreaterThan(0);
    const annot = reopened.context.lookup(reopened.getPage(0).node.Annots().get(0));
    expect(annot.get(PDFName.of('Subtype'))).toBe(PDFName.of('Highlight'));
  });
  it('draws check marks and crosses as single stroked paths inside their box', async () => {
    const d = await PDFDocument.load(await blankPdf());
    drawMark(d, 0, {
      shape: 'check',
      rect: { x: 100, y: 200, width: 20, height: 20 },
      width: 2,
      hex: '#111111',
    });
    drawMark(d, 0, {
      shape: 'cross',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      width: 1,
      hex: '#d92626',
    });
    const reopened = await PDFDocument.load(await d.save());
    const content = reopened
      .getPage(0)
      .node.Contents()
      .asArray()
      .map((ref) =>
        new TextDecoder('latin1').decode(decodePDFRawStream(reopened.context.lookup(ref)).decode()),
      )
      .join('\n');
    expect(content).toMatch(/102\.4 210\.4 m\s+108 203\.6 l\s+118 217\.2 l\s+S/);
    expect(content).toMatch(/1\.5 8\.5 m\s+8\.5 1\.5 l\s+1\.5 1\.5 m\s+8\.5 8\.5 l\s+S/);
  });
  it('normalizes reverse-direction selections', () => {
    expect(normalizeRect({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({
      x: 10,
      y: 20,
      width: 40,
      height: 60,
    });
  });
});

for (const phase of ['operation', 'serialization'])
  for (const fails of [false, true])
    it(`cancels a pending edit during ${phase} and ignores its late ${fails ? 'failure' : 'success'}`, async () => {
      const session = new PdfSession(await blankPdf());
      const original = session.bytes.slice();
      const controller = new AbortController();
      let release, started;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const ready = new Promise((resolve) => {
        started = resolve;
      });
      const pause = async () => {
        started();
        await gate;
        if (fails) throw new Error('Late edit failure');
      };
      let saveSpy;
      if (phase === 'serialization') {
        const save = PDFDocument.prototype.save;
        saveSpy = vi.spyOn(PDFDocument.prototype, 'save').mockImplementationOnce(async function (
          ...args
        ) {
          const bytes = await save.apply(this, args);
          await pause();
          return bytes;
        });
      }
      let outcome = 'pending';
      const pending = session
        .change(
          async (doc) => {
            doc.addPage([300, 400]);
            if (phase === 'operation') await pause();
          },
          { signal: controller.signal },
        )
        .then(
          () => {
            outcome = 'committed';
          },
          (error) => {
            outcome = error.name;
          },
        );
      try {
        await ready;
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(outcome).toBe('AbortError');
        expect(session.bytes).toEqual(original);
        expect(session.past).toHaveLength(0);
        await session.change((doc) => doc.setTitle('Newer edit'));
        release();
        await pending;
        await new Promise((resolve) => setTimeout(resolve, 0));
        const doc = await PDFDocument.load(session.bytes);
        expect(doc.getPageCount()).toBe(1);
        expect(doc.getTitle()).toBe('Newer edit');
        expect(session.past).toHaveLength(1);
      } finally {
        release();
        await pending;
        saveSpy?.mockRestore();
      }
    });

it('duplicates several pages of a form at once as one by one, flattening the form once', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(
        await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)),
      ),
  );
  try {
    const build = async () => {
      const doc = await PDFDocument.create();
      const form = doc.getForm();
      for (let i = 0; i < 5; i++) {
        const page = doc.addPage([300 + i, 300]);
        const field = form.createTextField(`f${i}`);
        field.setText(`Value ${i}`);
        field.addToPage(page, { x: 20, y: 200, width: 150, height: 24 });
      }
      addLink(doc, 3, { rect: { x: 20, y: 20, width: 50, height: 20 }, page: 0 });
      doc.catalog.set(
        PDFName.of('PageLabels'),
        doc.context.obj({ Nums: [0, { S: 'r' }, 2, { S: 'D' }] }),
      );
      return PDFDocument.load(await doc.save());
    };
    const describe = async (doc) => {
      const saved = await PDFDocument.load(await doc.save());
      return {
        widths: saved.getPages().map((page) => page.getWidth()),
        fields: listFields(saved).map((field) => field.name),
        labels: String(saved.catalog.lookup(PDFName.of('PageLabels'))),
        link: saved.getPages().map((page) => {
          const annots = page.node.Annots();
          const link = annots && saved.context.lookup(annots.get(annots.size() - 1));
          const dest =
            link?.lookup(PDFName.of('Dest')) ??
            link?.lookup(PDFName.of('A'))?.lookup(PDFName.of('D'));
          return dest ? saved.getPages().findIndex((p) => p.ref === dest.get(0)) : null;
        }),
      };
    };
    const oneByOne = await build();
    for (const index of [3, 1]) await duplicatePage(oneByOne, index);
    const together = await build();
    // Each copy of a page with a form went through a saved, reloaded, flattened snapshot.
    const load = vi.spyOn(PDFDocument, 'load');
    await duplicatePages(together, [1, 3]);
    expect(load).toHaveBeenCalledTimes(1);
    load.mockRestore();
    const result = await describe(together);
    expect(result).toEqual(await describe(oneByOne));
    expect(result.widths).toEqual([300, 301, 301, 302, 303, 303, 304]);
    expect(result.link.slice(4, 6)).toEqual([0, 0]);
  } finally {
    vi.restoreAllMocks();
  }
});
