import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import {
  addBookmarksFromHeadings,
  checkAccessibility,
  describeLinks,
  listFigures,
  readStructure,
  setFieldDescriptions,
  setFigureAltText,
  setLanguage,
  setMarked,
  setTabOrder,
  setTitle,
} from '../src/core/accessibility.js';
import { autotagDocument, tagAnnotations } from '../src/core/autotag.js';
import { addLink } from '../src/core/links.js';
import { readXmp } from '../src/core/xmp.js';
import { PdfSession, duplicatePage } from '../src/core/document.js';

const fontUrl = new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname;
const reload = async (doc) => PDFDocument.load(await doc.save(), { updateMetadata: false });
const status = (report, id) =>
  report.categories.flatMap((c) => c.rules).find((rule) => rule.id === id);

/** An untagged report: a title, headings, a paragraph, a bullet list, a picture, a link. */
async function untaggedPdf({ pages = 1 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const canvas = createCanvas(40, 30);
  const context = canvas.getContext('2d');
  context.fillStyle = '#c33';
  context.fillRect(0, 0, 40, 30);
  context.fillStyle = '#36c';
  context.fillRect(10, 8, 20, 14);
  const picture = await doc.embedPng(canvas.toBuffer('image/png'));
  for (let n = 0; n < pages; n++) {
    const page = doc.addPage([612, 792]);
    page.drawText(n ? `Chapter ${n + 1}` : 'Annual Report', {
      x: 72,
      y: 700,
      size: 24,
      font: bold,
    });
    page.drawText('Overview', { x: 72, y: 660, size: 16, font: bold });
    page.drawText('This is the first line of a paragraph that goes on', {
      x: 72,
      y: 636,
      size: 11,
      font,
    });
    page.drawText('and continues on the second line of the paragraph.', {
      x: 72,
      y: 622,
      size: 11,
      font,
    });
    page.drawText('• First point', { x: 72, y: 590, size: 11, font });
    page.drawText('• Second point', { x: 72, y: 576, size: 11, font });
    page.drawText('Details', { x: 72, y: 540, size: 16, font: bold });
    page.drawText('Visit example.com for more.', {
      x: 72,
      y: 516,
      size: 11,
      font,
    });
    page.drawImage(picture, { x: 72, y: 340, width: 200, height: 150 });
    page.drawRectangle({
      x: 300,
      y: 340,
      width: 200,
      height: 150,
      color: rgb(0.9, 0.9, 0.5),
    });
    page.drawText(String(n + 1), { x: 300, y: 30, size: 10, font });
  }
  addLink(doc, 0, {
    rect: { x: 72, y: 512, width: 140, height: 14 },
    url: 'https://example.com',
  });
  return reload(doc);
}

async function renderAll(bytes) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: fontUrl,
  });
  try {
    const pdf = await task.promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport }).promise;
      const text = await page.getTextContent({ includeMarkedContent: true });
      pages.push({
        pixels: Buffer.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
        marked: text.items.filter((item) => item.type === 'beginMarkedContentProps'),
        text: text.items.map((item) => item.str || '').join(''),
      });
    }
    return { pages, outline: await pdf.getOutline() };
  } finally {
    await task.destroy();
  }
}

/** A tagged document built by hand: `tree` is [role, children?, extra?] under Document. */
async function taggedPdf(tree, { attributes = {} } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 300]);
  page.drawText('Tagged', { x: 20, y: 250, size: 12, font });
  const context = doc.context;
  const rootRef = context.nextRef();
  let mcid = 0;
  const parents = [];
  const build = ([role, children = [], extra = {}], parentRef) => {
    const dict = context.obj({
      Type: 'StructElem',
      S: role,
      P: parentRef,
      Pg: page.ref,
    });
    const ref = context.register(dict);
    const kids = children.length
      ? children.map((child) => build(child, ref))
      : [PDFNumber.of(mcid)].map((n) => (parents.push(ref), mcid++, n));
    dict.set(PDFName.of('K'), context.obj(kids));
    for (const [key, value] of Object.entries(extra)) dict.set(PDFName.of(key), value(context));
    if (attributes[role]) dict.set(PDFName.of('A'), context.obj(attributes[role]));
    return ref;
  };
  const documentRef = build(['Document', tree], rootRef);
  context.assign(
    rootRef,
    context.obj({
      Type: 'StructTreeRoot',
      K: [documentRef],
      ParentTree: { Nums: [0, parents] },
    }),
  );
  doc.catalog.set(PDFName.of('StructTreeRoot'), rootRef);
  doc.catalog.set(PDFName.of('MarkInfo'), context.obj({ Marked: true }));
  page.node.set(PDFName.of('StructParents'), PDFNumber.of(0));
  return reload(doc);
}

describe('accessibility check', () => {
  it('fails an untagged PDF on the document and content rules', async () => {
    const doc = await untaggedPdf();
    const report = checkAccessibility(doc);
    expect(status(report, 'tagged-pdf')).toMatchObject({
      status: 'failed',
      fix: 'tags',
    });
    expect(status(report, 'primary-language')).toMatchObject({
      status: 'failed',
      fix: 'language',
    });
    expect(status(report, 'title')).toMatchObject({
      status: 'failed',
      fix: 'title',
    });
    expect(status(report, 'tagged-content')).toMatchObject({
      status: 'failed',
      fix: 'tags',
    });
    expect(status(report, 'tagged-content').details[0]).toMatchObject({
      page: 0,
    });
    expect(status(report, 'tagged-annotations')).toMatchObject({
      status: 'failed',
      fix: 'tags',
    });
    expect(status(report, 'tab-order')).toMatchObject({
      status: 'failed',
      fix: 'tab-order',
    });
    expect(status(report, 'navigation-links').status).toBe('failed');
    expect(status(report, 'accessibility-permission').status).toBe('passed');
    expect(status(report, 'image-only').status).toBe('passed');
    expect(status(report, 'character-encoding').status).toBe('passed');
    expect(status(report, 'reading-order').status).toBe('skipped');
    expect(status(report, 'color-contrast').status).toBe('manual');
    // Structure rules cannot be judged without tags.
    expect(status(report, 'figures-alt-text').status).toBe('skipped');
    expect(status(report, 'heading-nesting').status).toBe('skipped');
    const counted = report.categories.flatMap((c) => c.rules);
    expect(report.summary.failed).toBe(counted.filter((r) => r.status === 'failed').length);
    expect(report.summary.passed + report.summary.failed + report.summary.manual).toBeGreaterThan(
      10,
    );
  });

  it('passes those rules after the fixes and autotag, without changing how pages look', async () => {
    const doc = await untaggedPdf({ pages: 2 });
    const before = await doc.save();
    setTitle(doc, 'Annual Report');
    setLanguage(doc, 'en-US');
    const result = autotagDocument(doc);
    expect(result.skipped).toEqual([]);
    expect(result.elements).toMatchObject({
      H1: 2,
      H2: 4,
      P: 4,
      L: 2,
      LI: 4,
      Figure: 2,
      Link: 1,
    });
    // Autotag sets the tab order on pages with annotations; the fix sets it everywhere.
    expect(doc.getPage(0).node.get(PDFName.of('Tabs'))).toBe(PDFName.of('S'));
    setTabOrder(doc);
    const after = await doc.save();
    const tagged = await PDFDocument.load(after);
    const report = checkAccessibility(tagged);
    for (const id of [
      'tagged-pdf',
      'primary-language',
      'title',
      'tagged-content',
      'tagged-annotations',
      'tab-order',
      'navigation-links',
      'heading-nesting',
      'list-items',
      'list-parts',
    ])
      expect(status(report, id).status, id).toBe('passed');
    expect(status(report, 'reading-order').status).toBe('manual');
    // Pictures become figures with no alternate text, which the check then asks for.
    expect(status(report, 'figures-alt-text')).toMatchObject({
      status: 'failed',
      fix: 'alt-text',
    });
    expect(readXmp(tagged).values.title).toBe('Annual Report');

    const original = await renderAll(before);
    const rendered = await renderAll(after);
    expect(rendered.pages.length).toBe(2);
    rendered.pages.forEach((page, i) => {
      expect(page.pixels.equals(original.pages[i].pixels), `page ${i + 1}`).toBe(true);
      expect(page.text).toBe(original.pages[i].text);
    });
    expect(original.pages[0].marked).toEqual([]);
    const tags = new Set(rendered.pages[0].marked.map((item) => item.tag));
    for (const tag of ['H1', 'H2', 'P', 'LBody', 'Figure', 'Link']) expect(tags).toContain(tag);
    expect(rendered.pages[0].marked.every((item) => /_mc\d+$/.test(item.id))).toBe(true);

    // Page numbers became artifacts rather than paragraphs.
    const structure = readStructure(tagged);
    expect(structure.elements.map((e) => e.role)).not.toContain('Lbl');
    const pages = structure.elements.filter((e) => e.role === 'P').map((e) => e.page);
    expect(pages).toEqual([0, 0, 1, 1]);
  });

  it('runs inside an editor transaction', async () => {
    const doc = await untaggedPdf();
    const session = new PdfSession(await doc.save());
    let result;
    await session.change((current) => {
      result = autotagDocument(current, { lang: 'en-GB' });
      return result;
    });
    await session.change((current) => setTitle(current, 'Report'));
    expect(result.pages).toBe(1);
    const report = checkAccessibility(await PDFDocument.load(session.bytes));
    expect(status(report, 'tagged-pdf').status).toBe('passed');
    expect(status(report, 'primary-language').status).toBe('passed');
    expect(status(report, 'title').status).toBe('passed');
    expect(await session.change((current) => setLanguage(current, 'en-GB'))).toBe(false);
  });

  it('tags content added to a tagged document without touching the existing tags', async () => {
    const doc = await untaggedPdf();
    autotagDocument(doc);
    const tagged = await reload(doc);
    const elements = readStructure(tagged).elements.length;
    const font = await tagged.embedFont(StandardFonts.Helvetica);
    tagged.getPage(0).drawText('A note added later.', { x: 72, y: 300, size: 11, font });
    addLink(tagged, 0, {
      rect: { x: 72, y: 280, width: 50, height: 12 },
      url: 'https://a.example',
    });
    const edited = await reload(tagged);
    const report = checkAccessibility(edited);
    expect(status(report, 'tagged-content')).toMatchObject({
      status: 'failed',
    });
    expect(status(report, 'tagged-annotations')).toMatchObject({
      status: 'failed',
      fix: 'tag-annotations',
    });
    const before = await edited.save();
    const result = autotagDocument(edited);
    expect(result.elements).toMatchObject({ P: 1 });
    const fixed = await reload(edited);
    const next = checkAccessibility(fixed);
    expect(status(next, 'tagged-content').status).toBe('passed');
    expect(status(next, 'tagged-annotations').status).toBe('passed');
    expect(readStructure(fixed).elements.length).toBe(elements + 2);
    const [a, b] = [await renderAll(before), await renderAll(await fixed.save())];
    expect(b.pages[0].pixels.equals(a.pages[0].pixels)).toBe(true);
    expect(tagAnnotations(fixed)).toBe(false);
  });

  it('counts a copied page whose marked content no tag claims as untagged', async () => {
    const doc = await untaggedPdf();
    autotagDocument(doc);
    const session = new PdfSession(await doc.save());
    expect(
      status(checkAccessibility(await PDFDocument.load(session.bytes)), 'tagged-content').status,
    ).toBe('passed');
    // The copy keeps the page's MCIDs, but the tag tree describes only the original.
    await session.change((current) => duplicatePage(current, 0));
    const report = checkAccessibility(await PDFDocument.load(session.bytes));
    expect(status(report, 'tagged-content').status).toBe('failed');
    expect(status(report, 'tagged-content').details.map((detail) => detail.page)).toEqual([1]);
  });

  it('reports a figure without alternate text and setFigureAltText fixes it', async () => {
    const doc = await taggedPdf([['H1'], ['Figure'], ['P']]);
    const report = checkAccessibility(doc);
    expect(status(report, 'figures-alt-text')).toMatchObject({
      status: 'failed',
      fix: 'alt-text',
      details: [{ page: 0, text: 'Figure without alternate text' }],
    });
    const figures = listFigures(doc);
    expect(figures).toHaveLength(1);
    expect(figures[0]).toMatchObject({ page: 0, alt: '' });
    expect(figures[0].ref).toMatch(/^\d+ 0 R$/);
    setFigureAltText(doc, figures[0].ref, '  A bar chart of revenue  ');
    expect(setFigureAltText(doc, figures[0].ref, 'A bar chart of revenue')).toBe(false);
    const fixed = await reload(doc);
    expect(listFigures(fixed)[0].alt).toBe('A bar chart of revenue');
    expect(status(checkAccessibility(fixed), 'figures-alt-text').status).toBe('passed');
    expect(() => setFigureAltText(fixed, '99999 0 R', 'x')).toThrow(/no longer/);
  });

  it('lists autotagged figures with their bounds', async () => {
    const doc = await untaggedPdf();
    autotagDocument(doc);
    const [figure] = listFigures(await reload(doc));
    expect(figure.page).toBe(0);
    expect(figure.bbox.map(Math.round)).toEqual([72, 340, 272, 490]);
  });

  it('checks alternate text placement', async () => {
    const alt = { Alt: (c) => PDFString.of('Described') };
    const doc = await taggedPdf([['Figure', [['Span', [], alt]], alt], ['Formula']]);
    const report = checkAccessibility(doc);
    expect(status(report, 'nested-alt-text').status).toBe('failed');
    expect(status(report, 'other-alt-text').details[0].text).toMatch(/Formula/);
    expect(status(report, 'alt-text-content').status).toBe('passed');
  });

  it('checks heading nesting', async () => {
    const skipped = checkAccessibility(await taggedPdf([['H1'], ['P'], ['H3'], ['H2']]));
    expect(status(skipped, 'heading-nesting')).toMatchObject({
      status: 'failed',
      details: [{ page: 0, text: expect.stringMatching(/^H3 follows H1/) }],
    });
    const late = checkAccessibility(await taggedPdf([['H2'], ['H3']]));
    expect(status(late, 'heading-nesting').details[0].text).toMatch(/first heading is H2/);
    const good = checkAccessibility(await taggedPdf([['H1'], ['H2'], ['H3'], ['H2'], ['H1']]));
    expect(status(good, 'heading-nesting').status).toBe('passed');
    const none = checkAccessibility(await taggedPdf([['P']]));
    expect(status(none, 'heading-nesting').status).toBe('skipped');
  });

  it('checks table structure', async () => {
    const good = checkAccessibility(
      await taggedPdf(
        [
          [
            'Table',
            [
              ['THead', [['TR', [['TH'], ['TH']]]]],
              [
                'TBody',
                [
                  ['TR', [['TD'], ['TD']]],
                  ['TR', [['TD'], ['TD']]],
                ],
              ],
            ],
          ],
        ],
        {
          attributes: {
            Table: { O: 'Table', Summary: PDFString.of('Totals by year') },
          },
        },
      ),
    );
    for (const id of [
      'table-rows',
      'table-cells',
      'table-headers',
      'table-regularity',
      'table-summary',
    ])
      expect(status(good, id).status, id).toBe('passed');

    const bad = checkAccessibility(
      await taggedPdf([
        ['Table', [['TR', [['TD'], ['TD']]], ['TR', [['TD'], ['P']]], ['TD'], ['TR', [['TD']]]]],
        ['TR', [['TD']]],
      ]),
    );
    expect(status(bad, 'table-rows').details.map((d) => d.text)).toEqual([
      'Row (TR) outside a table',
      'TD directly inside Table',
    ]);
    expect(status(bad, 'table-cells').details.map((d) => d.text)).toEqual([
      'TD outside a row',
      'P directly inside a row',
    ]);
    expect(status(bad, 'table-headers').status).toBe('failed');
    expect(status(bad, 'table-regularity').status).toBe('failed');
    expect(status(bad, 'table-summary').status).toBe('failed');
    expect(status(checkAccessibility(await taggedPdf([['P']])), 'table-rows').status).toBe(
      'skipped',
    );
  });

  it('checks table regularity with spans', async () => {
    const span = (key, n) => ({ A: (c) => c.obj({ O: 'Table', [key]: n }) });
    const report = checkAccessibility(
      await taggedPdf([
        [
          'Table',
          [
            ['TR', [['TH', [], span('ColSpan', 2)], ['TH']]],
            ['TR', [['TD', [], span('RowSpan', 2)], ['TD'], ['TD']]],
            ['TR', [['TD'], ['TD']]],
          ],
        ],
      ]),
    );
    expect(status(report, 'table-regularity').status).toBe('passed');
  });

  it('checks list structure', async () => {
    const report = checkAccessibility(
      await taggedPdf([
        ['L', [['LI', [['Lbl'], ['LBody']]], ['P']]],
        ['LI', [['P']]],
      ]),
    );
    expect(status(report, 'list-items').details.map((d) => d.text)).toEqual([
      'List item (LI) outside a list',
      'P directly inside a list',
    ]);
    expect(status(report, 'list-parts').details.map((d) => d.text)).toEqual([
      'P directly inside a list item',
    ]);
  });

  it('adds bookmarks from tagged headings, nested by level', async () => {
    const doc = await untaggedPdf({ pages: 21 });
    autotagDocument(doc);
    const tagged = await reload(doc);
    const report = checkAccessibility(tagged);
    expect(status(report, 'bookmarks')).toMatchObject({
      status: 'failed',
      fix: 'bookmarks',
    });
    addBookmarksFromHeadings(tagged);
    const bytes = await tagged.save();
    expect(status(checkAccessibility(await PDFDocument.load(bytes)), 'bookmarks').status).toBe(
      'passed',
    );
    const { outline } = await renderAll(bytes);
    expect(outline).toHaveLength(21);
    expect(outline[0].title).toBe('Annual Report');
    expect(outline[0].items.map((item) => item.title)).toEqual(['Overview', 'Details']);
    expect(outline[1].title).toBe('Chapter 2');
    expect(outline[0].dest[1].name).toBe('XYZ');
  });

  it('refuses bookmarks without headings', async () => {
    const doc = await taggedPdf([['P']]);
    expect(() => addBookmarksFromHeadings(doc)).toThrow(/no tagged headings/);
  });

  it('describes links from the text under them', async () => {
    const doc = await untaggedPdf();
    describeLinks(doc);
    const link = doc.getPage(0).node.lookup(PDFName.of('Annots')).lookup(0);
    expect(link.lookup(PDFName.of('Contents')).decodeText()).toBe('Visit example.com for more.');
    expect(describeLinks(doc)).toBe(false);
  });

  it('checks form fields: tags and descriptions', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const field = doc.getForm().createTextField('customer.name');
    field.addToPage(page, { x: 20, y: 200, width: 150, height: 20 });
    const loaded = await reload(doc);
    const report = checkAccessibility(loaded);
    expect(status(report, 'tagged-form-fields')).toMatchObject({
      status: 'failed',
      fix: 'tags',
    });
    expect(status(report, 'field-descriptions')).toMatchObject({
      status: 'failed',
      fix: 'field-descriptions',
      details: [{ page: 0, text: 'customer.name' }],
    });
    setFieldDescriptions(loaded, { 'customer.name': 'Customer name' });
    autotagDocument(loaded);
    const fixed = checkAccessibility(await reload(loaded));
    expect(status(fixed, 'tagged-form-fields').status).toBe('passed');
    expect(status(fixed, 'field-descriptions').status).toBe('passed');
    expect(setFieldDescriptions(loaded, { 'customer.name': 'Customer name' })).toBe(false);
  });

  it('flags fonts without a map to text, image-only pages, and the permission flag', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const context = doc.context;
    const cid = context.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: 'Mystery',
      CIDSystemInfo: {
        Registry: PDFString.of('Adobe'),
        Ordering: PDFString.of('Identity'),
        Supplement: 0,
      },
    });
    const font = context.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: 'ABCDEF+Mystery',
      Encoding: 'Identity-H',
      DescendantFonts: [context.register(cid)],
    });
    page.node.setFontDictionary(PDFName.of('F9'), context.register(font));
    page.node.set(
      PDFName.of('Contents'),
      context.register(context.stream('BT /F9 12 Tf 20 200 Td <00010002> Tj ET')),
    );
    const scan = doc.addPage([300, 300]);
    const canvas = createCanvas(4, 4);
    scan.drawImage(await doc.embedPng(canvas.toBuffer('image/png')), {
      x: 0,
      y: 0,
      width: 300,
      height: 300,
    });
    const loaded = await reload(doc);
    const report = checkAccessibility(loaded, {
      access: { accessibility: false },
    });
    expect(status(report, 'character-encoding')).toMatchObject({
      status: 'failed',
      details: [{ page: 0, text: 'Mystery' }],
    });
    expect(status(report, 'image-only')).toMatchObject({
      status: 'failed',
      details: [{ page: 1 }],
    });
    expect(status(report, 'accessibility-permission')).toMatchObject({
      status: 'failed',
      fix: 'protection',
    });
  });

  it('validates title and language and keeps fixes idempotent', async () => {
    const doc = await untaggedPdf();
    expect(() => setTitle(doc, '   ')).toThrow(/title/);
    expect(() => setLanguage(doc, 'English!')).toThrow(/language tag/);
    setTitle(doc, 'Plan');
    expect(setTitle(doc, 'Plan')).toBe(false);
    expect(
      doc.catalog.lookup(PDFName.of('ViewerPreferences')).get(PDFName.of('DisplayDocTitle')),
    ).toBeTruthy();
    setTabOrder(doc);
    expect(setTabOrder(doc)).toBe(false);
    expect(setMarked(doc)).toBeUndefined();
    expect(setMarked(doc)).toBe(false);
  });
});
