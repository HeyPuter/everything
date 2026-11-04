import { afterAll, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  OPS,
  buildCompareReport,
  compareDocuments,
  describeSummary,
  diffSequences,
  extractComparable,
  pageTransform,
} from '../src/core/compare.js';

const tasks = [];
afterAll(() => Promise.all(tasks.map((task) => task.destroy())));
async function open(bytes) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  tasks.push(task);
  return task.promise;
}

/**
 * A PDF whose pages are lists of lines; a line is a string or a list of [text, size] runs drawn
 * one after another.
 */
async function build(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([612, 792]);
    lines.forEach((line, k) => {
      let x = 72;
      const y = 700 - k * 30;
      for (const [text, size] of typeof line === 'string' ? [[line, 12]] : line) {
        page.drawText(text, { x, y, size, font });
        x += font.widthOfTextAtSize(text, size);
      }
    });
  }
  return { bytes: await doc.save(), font };
}

const intro = [
  'Alpha report on quarterly results',
  'Revenue grew strongly in the third quarter of the year.',
  'Costs remained stable across all regions and divisions.',
];
const roadmap = (count, size) => [
  'Section two describes the product roadmap in detail.',
  `We plan to deliver ${count} new features before winter.`,
  [
    ['The ', 12],
    ['launch', size],
    [' date is planned for the middle of May.', 12],
  ],
];
const appendix = [
  'Appendix lists every supplier contract signed this year.',
  'Each contract includes renewal terms and penalties.',
];
const glossary = [
  'Glossary of zebra xylophone quokka terminology entries.',
  'Narwhal ocelot pangolin vocabulary remains unexplained.',
];
const closing = ['Closing remarks thank the entire team for the effort.'];

it('uses the operator codes of the installed PDF.js', () => {
  for (const [name, code] of Object.entries(OPS)) expect(pdfjs.OPS[name], name).toBe(code);
});

it('reports inserted, deleted, replaced and restyled words, and added and removed pages', async () => {
  const before = await build([intro, roadmap('three', 12), appendix, closing]);
  const after = await build([
    [
      intro[0],
      'Revenue grew very strongly in the third quarter of the year.',
      'Costs remained stable across regions and divisions.',
    ],
    roadmap('four', 16),
    glossary,
    closing,
  ]);
  const result = await compareDocuments(await open(before.bytes), await open(after.bytes));
  expect(result.summary).toEqual({
    pages: { old: 4, new: 4 },
    total: 6,
    inserted: 1,
    deleted: 1,
    replaced: 1,
    formatting: 1,
    pagesAdded: 1,
    pagesRemoved: 1,
    pagesMoved: 0,
    imageChanges: 0,
    otherChanges: 0,
  });
  expect(result.pages.map((p) => [p.oldIndex, p.newIndex, p.status])).toEqual([
    [0, 0, 'changed'],
    [1, 1, 'changed'],
    [2, null, 'removed'],
    [null, 2, 'added'],
    [3, 3, 'same'],
  ]);
  const changes = result.pages.flatMap((p) =>
    p.changes.map((c) => [c.type, c.oldText, c.newText, c.oldPage, c.newPage]),
  );
  expect(changes).toEqual([
    ['insert', '', 'very', 0, 0],
    ['delete', 'all', '', 0, 0],
    ['replace', 'three', 'four', 1, 1],
    ['format', 'launch', 'launch', 1, 1],
  ]);
  const format = result.pages[1].changes[1].format;
  expect(format).toEqual({
    old: { font: 'Helvetica', size: 12 },
    new: { font: 'Helvetica', size: 16 },
  });
  expect(describeSummary(result.summary)).toBe(
    '6 changes: 1 insertion, 1 deletion, 1 replacement, 1 formatting change, 1 page inserted, 1 page deleted',
  );

  // The inserted word's box sits where pdf-lib drew it, on the second line.
  const [insert] = result.pages[0].changes;
  const x = 72 + after.font.widthOfTextAtSize('Revenue grew ', 12);
  const w = after.font.widthOfTextAtSize('very', 12);
  expect(insert.newRects).toHaveLength(1);
  const [x1, y1, x2, y2] = insert.newRects[0];
  expect(Math.abs(x1 - x)).toBeLessThan(1.5);
  expect(Math.abs(x2 - (x + w))).toBeLessThan(1.5);
  expect(y1).toBeLessThan(670);
  expect(y2).toBeGreaterThan(670);
  expect(insert.oldRects).toEqual([]);
  const deleted = result.pages[0].changes[1];
  expect(deleted.oldRects[0][1]).toBeLessThan(640);
  expect(deleted.oldRects[0][3]).toBeGreaterThan(640);
});

it('finds no changes between identical documents', async () => {
  const { bytes } = await build([intro, roadmap('three', 12), appendix]);
  const copy = await build([intro, roadmap('three', 12), appendix]);
  const result = await compareDocuments(await open(bytes), await open(copy.bytes));
  expect(result.summary.total).toBe(0);
  expect(result.pages.map((p) => p.status)).toEqual(['same', 'same', 'same']);
  expect(describeSummary(result.summary)).toBe('No differences found');
});

it('detects moved pages and still diffs them', async () => {
  const before = await build([intro, roadmap('three', 12), appendix, glossary, closing]);
  const after = await build([
    intro,
    appendix,
    glossary,
    closing,
    roadmap('five', 12), // page 2 moved to the end, with one word replaced
  ]);
  const result = await compareDocuments(await open(before.bytes), await open(after.bytes));
  expect(result.summary).toMatchObject({
    pagesMoved: 1,
    pagesAdded: 0,
    pagesRemoved: 0,
    replaced: 1,
  });
  expect(result.summary.total).toBe(2);
  const moved = result.pages.find((p) => p.status === 'moved');
  expect([moved.oldIndex, moved.newIndex]).toEqual([1, 4]);
  expect(moved.changes.map((c) => [c.type, c.oldText, c.newText])).toEqual([
    ['replace', 'three', 'five'],
  ]);
  expect(result.pages.filter((p) => p.status === 'same')).toHaveLength(4);
});

it('does not report text that reflowed onto the next page', async () => {
  const lines = Array.from(
    { length: 20 },
    (_, k) => `Line ${k + 1} of the long body text, numbered ${k + 1}.`,
  );
  const before = await build([lines.slice(0, 10), lines.slice(10)]);
  // A new line on page one pushes its last line onto page two.
  const after = await build([
    ['A brand new opening sentence appears here.', ...lines.slice(0, 9)],
    lines.slice(9),
  ]);
  const result = await compareDocuments(await open(before.bytes), await open(after.bytes));
  expect(result.summary.total).toBe(1);
  expect(result.pages[0].changes.map((c) => [c.type, c.newText])).toEqual([
    ['insert', 'A brand new opening sentence appears here.'],
  ]);
});

it('maps rectangles to the viewport the way PDF.js does', async () => {
  const doc = await PDFDocument.create();
  for (const rotation of [0, 90, 180, 270]) {
    const page = doc.addPage([300, 500]);
    page.setCropBox(20, 30, 250, 400);
    page.setRotation(degrees(rotation));
  }
  const pdf = await open(await doc.save());
  for (let i = 1; i <= 4; i++) {
    const page = await pdf.getPage(i);
    const expected = page.getViewport({ scale: 1.5 });
    const ours = pageTransform({ view: page.view, rotate: page.rotate }, 1.5);
    expect(ours.width).toBeCloseTo(expected.width, 6);
    expect(ours.height).toBeCloseTo(expected.height, 6);
    ours.transform.forEach((v, k) => expect(v).toBeCloseTo(expected.transform[k], 6));
  }
});

it('diffs long sequences quickly through the patience and bisection paths', () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const a = Int32Array.from({ length: 60000 }, () => Math.floor(random() * 5000));
  const b = Array.from(a);
  for (let k = 0; k < 300; k++) b.splice(Math.floor(random() * b.length), 1, 999999 + k);
  const started = Date.now();
  const match = diffSequences(a, Int32Array.from(b));
  expect(Date.now() - started).toBeLessThan(1500);
  let matched = 0,
    last = -1,
    wrong = 0;
  for (let i = 0; i < a.length; i++)
    if (match[i] >= 0) {
      if (match[i] <= last || b[match[i]] !== a[i]) wrong++;
      last = match[i];
      matched++;
    }
  expect(wrong).toBe(0);
  expect(matched).toBeGreaterThanOrEqual(a.length - 300);
});

it('extracts words with fonts and sizes, and pictures with their place', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  page.drawText('Hello world', {
    x: 50,
    y: 300,
    size: 20,
    font: await doc.embedFont(StandardFonts.TimesRoman),
  });
  // A one-pixel PNG, placed in a 100 by 50 box.
  const png = await doc.embedPng(
    Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    ),
  );
  page.drawImage(png, { x: 100, y: 100, width: 100, height: 50 });
  const { pages } = await extractComparable(await open(await doc.save()));
  expect(pages[0].words.map((w) => [w.text, w.font, w.size])).toEqual([
    ['Hello', 'Times-Roman', 20],
    ['world', 'Times-Roman', 20],
  ]);
  expect(pages[0].images).toEqual([{ rect: [100, 100, 200, 150], w: 1, h: 1 }]);
});

it('reports a picture that moved as one change', async () => {
  const png = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    ),
    (c) => c.charCodeAt(0),
  );
  const build = async (x) => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    page.drawText('Picture page caption', { x: 50, y: 350, size: 12 });
    page.drawImage(await doc.embedPng(png), { x, y: 100, width: 80, height: 60 });
    return doc.save();
  };
  const result = await compareDocuments(await open(await build(40)), await open(await build(250)));
  expect(result.summary).toMatchObject({ total: 1, imageChanges: 1 });
  expect(result.pages[0].changes).toMatchObject([
    {
      type: 'image',
      detail: 'Image moved',
      oldRects: [[40, 100, 120, 160]],
      newRects: [[250, 100, 330, 160]],
    },
  ]);
});

it('writes a report that lists every change', async () => {
  const before = await build([intro, roadmap('three', 12), appendix, closing]);
  const after = await build([
    [intro[0], 'Revenue grew very strongly in the third quarter of the year.', intro[2]],
    roadmap('four', 12),
    closing,
  ]);
  const result = await compareDocuments(await open(before.bytes), await open(after.bytes));
  const bytes = await buildCompareReport(result, {
    oldName: 'draft-v1.pdf',
    newName: 'draft-v2.pdf',
    date: new Date(2026, 0, 2),
  });
  expect(bytes).toBeInstanceOf(Uint8Array);
  const pdf = await open(bytes);
  const page = await pdf.getPage(1);
  const text = (await page.getTextContent()).items.map((item) => item.str).join('\n');
  expect(text).toContain('Compare report');
  expect(text).toContain('Old file: draft-v1.pdf (4 pages)');
  expect(text).toContain('New file: draft-v2.pdf (3 pages)');
  expect(text).toContain('3 changes: 1 insertion, 1 replacement, 1 page deleted');
  expect(text).toContain('Inserted "very"');
  expect(text).toContain('Replaced "three" with "four"');
  expect(text).toContain('Page 3 deleted');
});

it("writes the report date in digits its font can print, whatever the reader's language", async () => {
  const { bytes } = await build([intro]);
  const result = await compareDocuments(await open(bytes), await open(bytes));
  const native = Date.prototype.toLocaleString;
  const lines = {};
  try {
    for (const locale of ['ar-EG', 'bn-BD', 'ko-KR', 'en-US']) {
      // The reader's language, as the browser would apply it to a date given no locale.
      vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function (asked, options) {
        return native.call(this, asked ?? locale, options);
      });
      const report = await buildCompareReport(result, { date: new Date(2026, 0, 2, 15, 4) });
      vi.restoreAllMocks();
      const page = await (await open(report)).getPage(1);
      const text = (await page.getTextContent()).items.map((item) => item.str).join('\n');
      lines[locale] = text.split('\n').find((line) => line.startsWith('Compared:'));
    }
  } finally {
    vi.restoreAllMocks();
  }
  expect(lines['ar-EG']).toBe('Compared: 2026-01-02 15:04');
  expect(lines['ko-KR']).toBe('Compared: 2026-01-02 15:04');
  expect(lines['bn-BD']).toBe('Compared: 2/1/2026, 3:04:00 PM');
  expect(lines['en-US']).toBe('Compared: 1/2/2026, 3:04:00 PM');
});

it('counts a page that changed as a whole, so the summary does not say there are no differences', async () => {
  const draw = async (x, width = 612) => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([width, 792]);
    page.drawText('The same words on both versions', { x: 72, y: 700, size: 12, font });
    page.drawRectangle({ x, y: 100, width: 100, height: 100 });
    return open(await doc.save());
  };
  const moved = await compareDocuments(await draw(100), await draw(300));
  expect(moved.pages.map((p) => [p.status, p.notes])).toEqual([
    ['changed', ['Vector graphics differ']],
  ]);
  expect(moved.summary).toMatchObject({ total: 1, otherChanges: 1 });
  expect(describeSummary(moved.summary)).toBe('1 change: 1 other change');
  const resized = await compareDocuments(await draw(100), await draw(100, 700));
  expect(describeSummary(resized.summary)).toBe('1 change: 1 other change');
  const report = await (await open(await buildCompareReport(resized))).getPage(1);
  const text = (await report.getTextContent()).items.map((item) => item.str).join('\n');
  expect(text).toContain('1 change: 1 other change');
  expect(text).toContain('Page size changed');
});

it('draws only the pages that their words cannot tell apart', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 300]).drawText('Words alone', { x: 20, y: 200, size: 12, font });
  doc.addPage([300, 300]);
  const drawn = [];
  const { pages } = await extractComparable(await open(await doc.save()), {
    renderPage: (page, index) => drawn.push(index) && `hash ${index}`,
  });
  expect(drawn).toEqual([1]);
  expect(pages.map((page) => page.renderHash)).toEqual([null, 'hash 1']);
});
