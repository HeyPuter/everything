import { describe, expect, it, vi } from 'vitest';
import { PDFDict, PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PdfSession, deletePage } from '../src/core/document.js';
import { addBookmark } from '../src/core/outline-edit.js';

const n = PDFName.of;
async function fixture() {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([200 + i, 300]);
  return doc;
}
const rootOf = (doc) => doc.catalog.lookup(n('Outlines'));
const firstOf = (doc) => rootOf(doc).lookup(n('First'));
const targetOf = (dict, key = 'Dest') => dict.lookup(n(key)).get(0);
const reopen = (doc) => doc.save().then((bytes) => PDFDocument.load(bytes));

describe('destinations after deleting a page', () => {
  it.each([
    ['GoToR', 1],
    ['GoToR', 2],
    ['GoToE', 1],
    ['GoToE', 2],
  ])('preserves a shared remote %s destination when deleting page %s', async (kind, index) => {
    const doc = await fixture(),
      ctx = doc.context;
    const shared = ctx.register(ctx.obj([2, 'XYZ', 12, 34, 2]));
    const remote = ctx.obj({ S: kind, F: PDFHexString.fromText('other.pdf'), D: shared });
    const local = ctx.obj({ S: ctx.register(n('GoTo')), D: shared });
    const link = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 20, 20], Dest: shared });
    doc.getPage(0).node.addAnnot(ctx.register(link));
    doc
      .getPage(0)
      .node.addAnnot(
        ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [30, 0, 50, 20], A: remote })),
      );
    doc.getPage(0).node.set(n('AA'), ctx.obj({ O: local }));
    doc.catalog.set(n('OpenAction'), shared);
    const before = remote.lookup(n('D')).toString();
    deletePage(doc, index);
    const saved = await reopen(doc);
    const annotations = saved.getPage(0).node.Annots();
    const savedRemote = saved.context.lookup(annotations.get(1)).lookup(n('A'));
    expect(savedRemote.lookup(n('D')).toString()).toBe(before);
    const target = saved.getPage(1).ref;
    const expected = index === 2 ? `[ ${target} /Fit ]` : `[ ${target} /XYZ 12 34 2 ]`;
    expect(saved.context.lookup(annotations.get(0)).lookup(n('Dest')).toString()).toBe(expected);
    expect(saved.getPage(0).node.lookup(n('AA')).lookup(n('O')).lookup(n('D')).toString()).toBe(
      expected,
    );
    expect(saved.catalog.lookup(n('OpenAction')).toString()).toBe(expected);
  });
  it.each([0, 1, 2])(
    'retargets page %s to the next page, or the previous page at the end',
    async (index) => {
      const doc = await fixture();
      for (let pageIndex = 0; pageIndex < 3; pageIndex++)
        addBookmark(doc, { title: `Page ${pageIndex}`, pageIndex });
      const refs = doc.getPages().map((page) => page.ref);
      deletePage(doc, index);
      const saved = await reopen(doc);
      let item = firstOf(saved);
      for (let i = 0; i < 3; i++) {
        expect(targetOf(item).toString()).toBe(
          refs[i === index ? (index === 2 ? 1 : index + 1) : i].toString(),
        );
        item = item.lookup(n('Next'));
      }
      expect(rootOf(saved).lookup(n('Count')).asNumber()).toBe(3);
      const task = pdfjs.getDocument({ data: await saved.save() });
      try {
        const pdf = await task.promise;
        for (const entry of await pdf.getOutline())
          expect(await pdf.getPageIndex(entry.dest[0])).toBeLessThan(2);
      } finally {
        await task.destroy();
      }
    },
  );
  it('preserves nested outline relationships, closed counts, surviving coordinates, and history', async () => {
    const doc = await fixture();
    addBookmark(doc, { title: 'Parent', pageIndex: 1 });
    addBookmark(doc, { title: 'Sibling', pageIndex: 0 });
    const parent = firstOf(doc);
    const parentRef = rootOf(doc).get(n('First'));
    const child = doc.context.register(
      doc.context.obj({
        Title: PDFHexString.fromText('Child'),
        Parent: parentRef,
        Dest: [doc.getPage(2).ref, 'XYZ', 12, 42, 2],
      }),
    );
    parent.set(n('First'), child);
    parent.set(n('Last'), child);
    parent.set(n('Count'), doc.context.obj(-1));
    const childBefore = doc.context.lookup(child).toString();
    const session = new PdfSession(await doc.save());
    await session.change((pdf) => deletePage(pdf, 1));
    const changed = session.bytes.slice();
    const after = await PDFDocument.load(session.bytes);
    expect(firstOf(after).lookup(n('Count')).asNumber()).toBe(-1);
    expect(rootOf(after).lookup(n('Count')).asNumber()).toBe(2);
    expect(firstOf(after).lookup(n('Next')).get(n('Prev'))).toBe(parentRef);
    expect(firstOf(after).lookup(n('First')).toString()).toBe(childBefore);
    expect(targetOf(firstOf(after))).toBe(after.getPage(1).ref);
    session.undo();
    const undone = await PDFDocument.load(session.bytes);
    expect(undone.getPageCount()).toBe(3);
    expect(targetOf(firstOf(undone))).toBe(undone.getPage(1).ref);
    session.redo();
    expect(session.bytes).toEqual(changed);
  });
  it('repairs explicit links, named destinations, catalog jumps, and chained or additional GoTo actions', async () => {
    const doc = await fixture();
    const ctx = doc.context;
    const dest = ctx.obj([doc.getPage(1).ref, 'XYZ', 1000, 2000, 4]);
    const destRef = ctx.register(dest);
    const survivor = ctx.obj([doc.getPage(2).ref, 'XYZ', 10, 20, 2]);
    const keepBefore = survivor.toString();
    const goto = ctx.register(ctx.obj({ S: ctx.register(n('GoTo')), D: destRef }));
    const remote = ctx.obj({ S: 'GoToR', F: PDFHexString.fromText('other.pdf'), D: [1, 'Fit'] });
    const remoteBefore = remote.toString();
    const link = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], Dest: destRef });
    const actionLink = ctx.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [20, 0, 30, 10],
      A: { S: 'URI', URI: PDFHexString.fromText('https://example.com'), Next: [goto, remote] },
    });
    doc.getPage(0).node.set(n('Annots'), ctx.obj([ctx.register(link), ctx.register(actionLink)]));
    doc.getPage(0).node.set(n('AA'), ctx.obj({ O: goto }));
    doc.catalog.set(n('OpenAction'), destRef);
    doc.catalog.set(n('Dests'), ctx.obj({ deleted: { D: destRef }, surviving: survivor }));
    doc.catalog.set(
      n('Names'),
      ctx.obj({
        Dests: {
          Kids: [
            ctx.register(
              ctx.obj({
                Limits: [PDFHexString.fromText('deleted'), PDFHexString.fromText('surviving')],
                Names: [
                  PDFHexString.fromText('deleted'),
                  destRef,
                  PDFHexString.fromText('surviving'),
                  { D: survivor },
                ],
              }),
            ),
          ],
        },
      }),
    );
    addBookmark(doc, { title: 'Named', pageIndex: 1 });
    firstOf(doc).set(n('Dest'), PDFHexString.fromText('deleted'));
    deletePage(doc, 1);
    const saved = await reopen(doc);
    const replacement = saved.getPage(1).ref;
    expect(saved.catalog.lookup(n('OpenAction')).toString()).toBe(`[ ${replacement} /Fit ]`);
    expect(saved.catalog.lookup(n('Dests')).lookup(n('deleted')).lookup(n('D')).get(0)).toBe(
      replacement,
    );
    expect(saved.catalog.lookup(n('Dests')).lookup(n('surviving')).toString()).toBe(keepBefore);
    const annots = saved.getPage(0).node.Annots();
    expect(targetOf(saved.context.lookup(annots.get(0)))).toBe(replacement);
    const chain = saved.context.lookup(annots.get(1)).lookup(n('A')).lookup(n('Next'));
    expect(targetOf(saved.context.lookup(chain.get(0)), 'D')).toBe(replacement);
    expect(saved.context.lookup(chain.get(1)).toString()).toBe(remoteBefore);
    const task = pdfjs.getDocument({ data: await saved.save() });
    try {
      const pdf = await task.promise;
      expect(await pdf.getPageIndex((await pdf.getDestination('deleted'))[0])).toBe(1);
      expect(await pdf.getPageIndex((await pdf.getDestination('surviving'))[0])).toBe(1);
    } finally {
      await task.destroy();
    }
  });
  it('handles numeric local destinations once when shared, without changing remote page numbers', async () => {
    const doc = await fixture();
    const shared = doc.context.register(doc.context.obj([2, 'FitH', 30]));
    addBookmark(doc, { title: 'Numeric', pageIndex: 0 });
    firstOf(doc).set(n('Dest'), shared);
    doc.catalog.set(n('OpenAction'), shared);
    deletePage(doc, 1);
    const saved = await reopen(doc);
    expect(targetOf(firstOf(saved))).toBe(saved.getPage(1).ref);
    expect(saved.catalog.lookup(n('OpenAction')).toString()).toBe(
      `[ ${saved.getPage(1).ref} /FitH 30 ]`,
    );
  });
  it('keeps remote open actions unchanged', async () => {
    for (const kind of ['GoToR', 'GoToE']) {
      const doc = await fixture();
      const action = doc.context.obj({
        S: kind,
        F: PDFHexString.fromText('other.pdf'),
        D: [2, 'Fit'],
      });
      doc.catalog.set(n('OpenAction'), action);
      const before = action.toString();
      deletePage(doc, 1);
      expect((await reopen(doc)).catalog.lookup(n('OpenAction')).toString()).toBe(before);
    }
  });
  it('repairs destinations across successive deletions in one transaction', async () => {
    const doc = await fixture();
    addBookmark(doc, { title: 'Middle', pageIndex: 1 });
    addBookmark(doc, { title: 'Last', pageIndex: 2 });
    const session = new PdfSession(await doc.save());
    await session.change((pdf) => {
      deletePage(pdf, 1);
      deletePage(pdf, 1);
    });
    const saved = await PDFDocument.load(session.bytes);
    expect(saved.getPageCount()).toBe(1);
    expect(targetOf(firstOf(saved))).toBe(saved.getPage(0).ref);
    expect(targetOf(firstOf(saved).lookup(n('Next')))).toBe(saved.getPage(0).ref);
  });
  it('handles cyclic actions and name trees without recursion or repeated rewrites', async () => {
    const doc = await fixture();
    const ctx = doc.context;
    const action = ctx.obj({ S: 'GoTo', D: [doc.getPage(1).ref, 'Fit'] });
    const ref = ctx.register(action);
    action.set(n('Next'), ref);
    doc.catalog.set(n('OpenAction'), ref);
    const tree = ctx.obj({ Names: [PDFHexString.fromText('target'), [doc.getPage(1).ref, 'Fit']] });
    const treeRef = ctx.register(tree);
    tree.set(n('Kids'), ctx.obj([treeRef]));
    doc.catalog.set(n('Names'), ctx.obj({ Dests: treeRef }));
    const replacement = doc.getPage(2).ref;
    deletePage(doc, 1);
    expect(targetOf(action, 'D')).toBe(replacement);
    expect(tree.lookup(n('Names')).lookup(1).get(0)).toBe(replacement);
  });
  it('finds the jumps to a deleted page without reading the pages’ content', async () => {
    // Fonts, pictures, and drawings are most of a long document; walking them for every page
    // edit made deleting, moving, and inserting pages slow down with the document's length.
    const doc = await fixture();
    const font = doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
    const appearance = doc.context.obj({ Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] });
    for (const page of doc.getPages())
      page.node.set(
        n('Resources'),
        doc.context.obj({ Font: { F1: doc.context.register(font) }, XObject: { X: appearance } }),
      );
    addBookmark(doc, { title: 'Last', pageIndex: 2 });
    const original = PDFDict.prototype.entries;
    const read = new Set();
    const entries = vi.spyOn(PDFDict.prototype, 'entries').mockImplementation(function () {
      read.add(this);
      return original.call(this);
    });
    try {
      deletePage(doc, 2);
    } finally {
      entries.mockRestore();
    }
    expect(read.has(font) || read.has(appearance)).toBe(false);
    expect(targetOf(firstOf(doc))).toBe(doc.getPage(1).ref);
  });
});
