import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFHexString, PDFName, PDFNull } from 'pdf-lib';
import { extractPages } from '../src/core/pages.js';
import { splitPdf, splitRanges } from '../src/core/split.js';

/** Five pages with bookmarks: [{ title, page?, url?, children? }]. */
async function bookmarked(tree) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 5; i++) doc.addPage([400, 400 + i * 10]);
  const context = doc.context;
  const root = context.nextRef();
  const build = (items, parent) => {
    const refs = items.map(() => context.nextRef());
    items.forEach((item, i) => {
      const dict = context.obj({
        Title: PDFHexString.fromText(item.title),
        Parent: parent,
        ...(item.url
          ? { A: { S: 'URI', URI: PDFHexString.fromText(item.url) } }
          : { Dest: [doc.getPage(item.page).ref, 'XYZ', PDFNull, 300, PDFNull] }),
      });
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
      if (i < refs.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
      if (item.children) {
        const [first, last] = build(item.children, refs[i]);
        dict.set(PDFName.of('First'), first);
        dict.set(PDFName.of('Last'), last);
        dict.set(PDFName.of('Count'), context.obj(item.children.length));
      }
      context.assign(refs[i], dict);
    });
    return [refs[0], refs.at(-1)];
  };
  const [first, last] = build(tree, root);
  context.assign(root, context.obj({ Type: 'Outlines', First: first, Last: last, Count: 1 }));
  doc.catalog.set(PDFName.of('Outlines'), root);
  return doc.save();
}

/** The bookmarks of a PDF as [title, page index or null, children]. */
async function outlineOf(bytes) {
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages().map((page) => page.ref);
  const read = (node) => {
    const items = [];
    for (
      let item = node?.lookup(PDFName.of('First'));
      item;
      item = item.lookup(PDFName.of('Next'))
    ) {
      const dest = item.lookup(PDFName.of('Dest'));
      const page = dest ? pages.indexOf(dest.get(0)) : null;
      const children = read(item);
      items.push(
        children.length
          ? [item.lookup(PDFName.of('Title')).decodeText(), page, children]
          : [item.lookup(PDFName.of('Title')).decodeText(), page],
      );
    }
    return items;
  };
  return read(doc.catalog.lookup(PDFName.of('Outlines')));
}

const TREE = [
  { title: 'Cover', page: 0 },
  {
    title: 'Part two',
    page: 1,
    children: [
      { title: 'Section A', page: 2 },
      { title: 'Section B', page: 3 },
    ],
  },
  { title: 'Website', url: 'https://example.com' },
  { title: 'End', page: 4 },
];

describe('bookmarks of pages taken out', () => {
  it('come with extracted pages, leading to them there', async () => {
    const bytes = await bookmarked(TREE);
    // The part's own bookmark leads to a page left behind; it stays as the sections' heading.
    expect(await outlineOf(await extractPages(bytes, [2, 3]))).toEqual([
      [
        'Part two',
        null,
        [
          ['Section A', 0],
          ['Section B', 1],
        ],
      ],
    ]);
    // Pages taken in another order keep their own bookmarks.
    expect(await outlineOf(await extractPages(bytes, [4, 0]))).toEqual([
      ['Cover', 1],
      ['End', 0],
    ]);
  });

  it('come with each part of a split', async () => {
    const bytes = await bookmarked(TREE);
    const parts = await splitPdf(bytes, splitRanges(5, { mode: 'at', at: [3] }), 'Book');
    // Pages 1-2, then 3-5.
    expect(await outlineOf(parts[0].bytes)).toEqual([
      ['Cover', 0],
      ['Part two', 1],
    ]);
    expect(await outlineOf(parts[1].bytes)).toEqual([
      [
        'Part two',
        null,
        [
          ['Section A', 0],
          ['Section B', 1],
        ],
      ],
      ['End', 2],
    ]);
  });
});
