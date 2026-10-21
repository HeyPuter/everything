import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFHexString, PDFName, PDFRef } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { addBookmark, removeBookmark, renameBookmark } from '../src/core/outline-edit.js';

async function outlineOf(doc) {
  const task = pdfjs.getDocument({ data: (await doc.save()).slice() });
  try {
    const pdf = await task.promise;
    const items = await pdf.getOutline();
    if (!items) return null;
    const describe = async (list) =>
      Promise.all(
        list.map(async (item) => ({
          title: item.title,
          page: item.dest ? await pdf.getPageIndex(item.dest[0]) : null,
          items: await describe(item.items || []),
        })),
      );
    // Awaited here, or the finally block would destroy the document under the lookups.
    return await describe(items);
  } finally {
    await task.destroy();
  }
}
const count = (doc) =>
  doc.context
    .lookup(doc.catalog.get(PDFName.of('Outlines')))
    ?.lookup(PDFName.of('Count'))
    .asNumber();

describe('editing bookmarks', () => {
  it('adds, renames, and removes top-level bookmarks, dropping the outline with the last one', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([100, 100]);
    expect(await outlineOf(doc)).toBeNull();
    expect(addBookmark(doc, { title: 'Start', pageIndex: 0 })).toEqual([0]);
    expect(addBookmark(doc, { title: '  Middle  part ', pageIndex: 1 })).toEqual([1]);
    expect(addBookmark(doc, { title: 'End', pageIndex: 2 })).toEqual([2]);
    expect(count(doc)).toBe(3);
    expect(await outlineOf(doc)).toEqual([
      { title: 'Start', page: 0, items: [] },
      { title: 'Middle part', page: 1, items: [] },
      { title: 'End', page: 2, items: [] },
    ]);
    renameBookmark(doc, [1], 'Chapter two');
    removeBookmark(doc, [0]);
    expect(count(doc)).toBe(2);
    expect((await outlineOf(doc)).map((i) => i.title)).toEqual(['Chapter two', 'End']);
    removeBookmark(doc, [1]);
    expect((await outlineOf(doc)).map((i) => i.title)).toEqual(['Chapter two']);
    removeBookmark(doc, [0]);
    expect(doc.catalog.has(PDFName.of('Outlines'))).toBe(false);
    expect(await outlineOf(doc)).toBeNull();
  });
  it('edits inside an existing nested outline and keeps the counts right', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([100, 100]);
    const { context } = doc;
    const root = context.obj({ Type: 'Outlines' });
    const rootRef = context.register(root);
    const parent = context.obj({
      Title: PDFHexString.fromText('Part one'),
      Parent: rootRef,
      Dest: [doc.getPage(0).ref, 'Fit'],
    });
    const parentRef = context.register(parent);
    const a = context.obj({
      Title: PDFHexString.fromText('Alpha'),
      Parent: parentRef,
      Dest: [doc.getPage(1).ref, 'Fit'],
    });
    const b = context.obj({
      Title: PDFHexString.fromText('Beta'),
      Parent: parentRef,
      Dest: [doc.getPage(2).ref, 'Fit'],
    });
    const aRef = context.register(a),
      bRef = context.register(b);
    a.set(PDFName.of('Next'), bRef);
    b.set(PDFName.of('Prev'), aRef);
    parent.set(PDFName.of('First'), aRef);
    parent.set(PDFName.of('Last'), bRef);
    parent.set(PDFName.of('Count'), context.obj(-2));
    root.set(PDFName.of('First'), parentRef);
    root.set(PDFName.of('Last'), parentRef);
    root.set(PDFName.of('Count'), context.obj(1));
    doc.catalog.set(PDFName.of('Outlines'), rootRef);
    renameBookmark(doc, [0, 1], 'Gamma');
    expect((await outlineOf(doc))[0].items.map((i) => i.title)).toEqual(['Alpha', 'Gamma']);
    removeBookmark(doc, [0, 0]);
    expect((await outlineOf(doc))[0].items.map((i) => i.title)).toEqual(['Gamma']);
    expect(parent.lookup(PDFName.of('Count')).asNumber()).toBe(-1);
    expect(count(doc)).toBe(1);
    addBookmark(doc, { title: 'Part two', pageIndex: 2 });
    expect((await outlineOf(doc)).map((i) => i.title)).toEqual(['Part one', 'Part two']);
    expect(count(doc)).toBe(2);
    removeBookmark(doc, [0]);
    expect(await outlineOf(doc)).toEqual([{ title: 'Part two', page: 2, items: [] }]);
  });
  it('turns an outline root written straight into the catalog into an indirect object', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.catalog.set(PDFName.of('Outlines'), doc.context.obj({ Type: 'Outlines', Count: 0 }));
    expect(addBookmark(doc, { title: 'Start', pageIndex: 0 })).toEqual([0]);
    const root = doc.catalog.get(PDFName.of('Outlines'));
    expect(root).toBeInstanceOf(PDFRef);
    const item = doc.context.lookup(doc.context.lookup(root).get(PDFName.of('First')));
    expect(item.get(PDFName.of('Parent'))).toBe(root);
    expect(await outlineOf(doc)).toEqual([{ title: 'Start', page: 0, items: [] }]);
    renameBookmark(doc, [0], 'Intro');
    expect(await outlineOf(doc)).toEqual([{ title: 'Intro', page: 0, items: [] }]);
  });
  it('adds to an outline whose items loop back on themselves', async () => {
    for (const mutual of [false, true]) {
      const doc = await PDFDocument.create();
      doc.addPage();
      doc.addPage();
      const ctx = doc.context;
      const a = ctx.obj({ Title: PDFHexString.fromText('A'), Dest: [doc.getPage(0).ref, 'Fit'] });
      const aRef = ctx.register(a);
      const root = ctx.obj({ Type: 'Outlines', First: aRef, Last: aRef, Count: 1 });
      const rootRef = ctx.register(root);
      a.set(PDFName.of('Parent'), rootRef);
      // An item whose First points at itself, or two items that each hold the other.
      let inner = aRef;
      if (mutual)
        inner = ctx.register(
          ctx.obj({
            Title: PDFHexString.fromText('B'),
            Parent: aRef,
            First: aRef,
            Last: aRef,
            Dest: [doc.getPage(1).ref, 'Fit'],
          }),
        );
      a.set(PDFName.of('First'), inner);
      a.set(PDFName.of('Last'), inner);
      doc.catalog.set(PDFName.of('Outlines'), rootRef);
      expect(addBookmark(doc, { title: 'Start', pageIndex: 1 })).toEqual([1]);
      renameBookmark(doc, [1], 'Intro');
      expect((await outlineOf(doc)).at(-1)).toMatchObject({ title: 'Intro', page: 1 });
      removeBookmark(doc, [1]);
      expect((await outlineOf(doc)).map((item) => item.title)).toEqual(['A']);
    }
  });
  it('rejects bad names, pages, and paths', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    expect(() => addBookmark(doc, { title: '  ', pageIndex: 0 })).toThrow('Enter a name');
    expect(() => addBookmark(doc, { title: 'x'.repeat(201), pageIndex: 0 })).toThrow('200');
    expect(() => addBookmark(doc, { title: 'x', pageIndex: 1 })).toThrow('Choose a page');
    expect(() => renameBookmark(doc, [0], 'x')).toThrow('no longer exists');
    expect(() => removeBookmark(doc, [3])).toThrow('no longer exists');
    addBookmark(doc, { title: 'One', pageIndex: 0 });
    expect(() => removeBookmark(doc, [0, 0])).toThrow('no longer exists');
    expect(() => renameBookmark(doc, [0], '')).toThrow('Enter a name');
  });
});

it('adds and removes bookmarks in deeply nested outlines without changing open and closed counts', async () => {
  const { addDeepOutline } = await import('./fixtures/deep-outline.js');
  const doc = await PDFDocument.create();
  doc.addPage();
  const nodes = addDeepOutline(doc);
  const middle = 6000;
  nodes[middle].set(PDFName.of('Count'), doc.context.obj(-6000));
  expect(addBookmark(doc, { title: 'New bookmark', pageIndex: 0 })).toEqual([1]);
  expect(count(doc)).toBe(middle + 1);
  for (let i = 1; i < nodes.length - 1; i++) {
    const expected = i < middle ? middle - i : i === middle ? -6000 : 12000 - i;
    expect(nodes[i].lookup(PDFName.of('Count')).asNumber()).toBe(expected);
  }
  expect(nodes.at(-1).has(PDFName.of('Count'))).toBe(false);
  removeBookmark(doc, [1]);
  expect(count(doc)).toBe(middle);
  const reopened = await PDFDocument.load(await doc.save());
  expect(addBookmark(reopened, { title: 'Another bookmark', pageIndex: 0 })).toEqual([1]);
  expect(count(reopened)).toBe(middle + 1);
});

it.each(['missing', 'dangling', 'stale', 'unrelated', 'cyclic'])(
  'appends without losing bookmarks when the outline Last pointer is %s',
  async (kind) => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.addPage();
    addBookmark(doc, { title: 'First', pageIndex: 0 });
    addBookmark(doc, { title: 'Second', pageIndex: 1 });
    const root = doc.catalog.lookup(PDFName.of('Outlines'));
    const first = root.get(PDFName.of('First'));
    const second = root.get(PDFName.of('Last'));
    if (kind === 'missing') root.delete(PDFName.of('Last'));
    if (kind === 'dangling') root.set(PDFName.of('Last'), PDFRef.of(99999));
    if (kind === 'stale') root.set(PDFName.of('Last'), first);
    if (kind === 'unrelated') root.set(PDFName.of('Last'), doc.getPage(0).ref);
    if (kind === 'cyclic') {
      doc.context.lookup(second).set(PDFName.of('Next'), first);
      root.set(PDFName.of('Last'), first);
    }
    expect((await outlineOf(doc)).map((item) => item.title)).toEqual(['First', 'Second']);
    expect(addBookmark(doc, { title: 'Third', pageIndex: 0 })).toEqual([2]);
    expect(await outlineOf(doc)).toEqual([
      { title: 'First', page: 0, items: [] },
      { title: 'Second', page: 1, items: [] },
      { title: 'Third', page: 0, items: [] },
    ]);
    expect(root.get(PDFName.of('First'))).toBe(first);
    expect(root.lookup(PDFName.of('Last')).get(PDFName.of('Prev'))).toBe(second);
    expect(doc.getPage(0).node.has(PDFName.of('Next'))).toBe(false);
    expect(count(doc)).toBe(3);
  },
);

it('appends beyond 5,000 siblings without replacing the remaining outline chain', async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  const ctx = doc.context;
  const root = ctx.obj({ Type: 'Outlines' });
  const rootRef = ctx.register(root);
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
  let previous;
  for (let i = 0; i < 5001; i++) {
    const item = ctx.obj({
      Title: PDFHexString.fromText(`Item ${i}`),
      Parent: rootRef,
      Dest: [doc.getPage(0).ref, 'Fit'],
      ...(previous && { Prev: previous }),
    });
    const ref = ctx.register(item);
    if (previous) ctx.lookup(previous).set(PDFName.of('Next'), ref);
    else root.set(PDFName.of('First'), ref);
    previous = ref;
  }
  // A readable forward chain with no Last pointer must retain even its unlisted tail.
  expect(addBookmark(doc, { title: 'New last item', pageIndex: 0 })).toEqual([5001]);
  const items = await outlineOf(doc);
  expect(items).toHaveLength(5002);
  expect(items[5000].title).toBe('Item 5000');
  expect(items[5001].title).toBe('New last item');
  expect(count(doc)).toBe(5002);
});

for (const nested of [false, true]) {
  it.each(['missing', 'dangling', 'self', 'wrong sibling', 'unrelated'])(
    `removes only the chosen bookmark with a %s Prev pointer (nested=${nested})`,
    async (kind) => {
      for (const index of [0, 1, 2]) {
        const doc = await PDFDocument.create();
        doc.addPage();
        const ctx = doc.context;
        for (const title of ['First', 'Second', 'Third']) addBookmark(doc, { title, pageIndex: 0 });
        const rootRef = doc.catalog.get(PDFName.of('Outlines'));
        const root = ctx.lookup(rootRef);
        const first = root.get(PDFName.of('First'));
        const second = ctx.lookup(first).get(PDFName.of('Next'));
        const third = ctx.lookup(second).get(PDFName.of('Next'));
        const refs = [first, second, third];
        let parent = root;
        if (nested) {
          parent = ctx.obj({
            Title: PDFHexString.fromText('Parent'),
            Parent: rootRef,
            First: first,
            Last: third,
            Count: -3,
            Dest: [doc.getPage(0).ref, 'Fit'],
          });
          const parentRef = ctx.register(parent);
          root.set(PDFName.of('First'), parentRef);
          root.set(PDFName.of('Last'), parentRef);
          root.set(PDFName.of('Count'), ctx.obj(1));
          for (const ref of refs) ctx.lookup(ref).set(PDFName.of('Parent'), parentRef);
        }
        const selected = ctx.lookup(refs[index]);
        if (kind === 'missing') selected.delete(PDFName.of('Prev'));
        if (kind === 'dangling') selected.set(PDFName.of('Prev'), PDFRef.of(99999));
        if (kind === 'self') selected.set(PDFName.of('Prev'), refs[index]);
        if (kind === 'wrong sibling') selected.set(PDFName.of('Prev'), refs[index === 2 ? 0 : 2]);
        if (kind === 'unrelated') selected.set(PDFName.of('Prev'), doc.getPage(0).ref);
        const original = await outlineOf(doc);
        expect((nested ? original[0].items : original).map((item) => item.title)).toEqual([
          'First',
          'Second',
          'Third',
        ]);
        removeBookmark(doc, nested ? [0, index] : [index]);
        const after = await outlineOf(doc);
        expect((nested ? after[0].items : after).map((item) => item.title)).toEqual(
          ['First', 'Second', 'Third'].filter((_, i) => i !== index),
        );
        const survivors = refs.filter((_, i) => i !== index);
        expect(parent.get(PDFName.of('First'))).toBe(survivors[0]);
        expect(parent.get(PDFName.of('Last'))).toBe(survivors[1]);
        expect(ctx.lookup(survivors[0]).has(PDFName.of('Prev'))).toBe(false);
        expect(ctx.lookup(survivors[0]).get(PDFName.of('Next'))).toBe(survivors[1]);
        expect(ctx.lookup(survivors[1]).get(PDFName.of('Prev'))).toBe(survivors[0]);
        expect(ctx.lookup(survivors[1]).has(PDFName.of('Next'))).toBe(false);
        expect(doc.getPage(0).node.has(PDFName.of('Next'))).toBe(false);
        expect(count(doc)).toBe(nested ? 1 : 2);
        if (nested) expect(parent.lookup(PDFName.of('Count')).asNumber()).toBe(-2);
      }
    },
  );
}

describe('bookmarks of inserted pages', () => {
  async function bookPdf() {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([300 + i, 300]);
    addBookmark(doc, { title: 'Intro', pageIndex: 0 });
    addBookmark(doc, { title: 'Chapter', pageIndex: 1 });
    addBookmark(doc, { title: 'Web', pageIndex: 0 });
    const ctx = doc.context;
    const root = ctx.lookup(doc.catalog.get(PDFName.of('Outlines')));
    const items = [];
    for (
      let ref = root.get(PDFName.of('First'));
      ref;
      ref = ctx.lookup(ref).get(PDFName.of('Next'))
    )
      items.push(ref);
    // The chapter is closed and holds a section reached through a named destination.
    const chapterDict = ctx.lookup(items[1]);
    const section = ctx.register(
      ctx.obj({
        Title: PDFHexString.fromText('Section'),
        Parent: items[1],
        A: { S: 'GoTo', D: PDFHexString.fromText('sec') },
      }),
    );
    chapterDict.set(PDFName.of('First'), section);
    chapterDict.set(PDFName.of('Last'), section);
    chapterDict.set(PDFName.of('Count'), ctx.obj(-1));
    doc.catalog.set(
      PDFName.of('Names'),
      ctx.obj({ Dests: { Names: [PDFHexString.fromText('sec'), [doc.getPage(2).ref, 'Fit']] } }),
    );
    const webDict = ctx.lookup(items[2]);
    webDict.delete(PDFName.of('Dest'));
    webDict.set(
      PDFName.of('A'),
      ctx.obj({ S: 'URI', URI: PDFHexString.fromText('https://example.com/') }),
    );
    return doc.save();
  }

  it('come along when pages are inserted from another PDF', async () => {
    const { insertPdfPages } = await import('../src/core/document.js');
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    doc.addPage([200, 200]);
    addBookmark(doc, { title: 'Cover', pageIndex: 0 });
    await insertPdfPages(doc, await bookPdf(), { pages: [1, 2], after: 0 });
    const saved = await PDFDocument.load(await doc.save());
    expect(saved.getPages().map((page) => page.getWidth())).toEqual([100, 301, 302, 200]);
    // Intro's page was not inserted; the rest point at the pages they now are.
    expect(await outlineOf(saved)).toEqual([
      { title: 'Cover', page: 0, items: [] },
      { title: 'Chapter', page: 1, items: [{ title: 'Section', page: 2, items: [] }] },
      { title: 'Web', page: null, items: [] },
    ]);
    const root = saved.context.lookup(saved.catalog.get(PDFName.of('Outlines')));
    // The chapter stays closed, so only the three top-level bookmarks show.
    expect(root.lookup(PDFName.of('Count')).asNumber()).toBe(3);
  });
});
