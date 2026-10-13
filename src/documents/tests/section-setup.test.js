import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry, readingPageGeometry, validatePageSettings } from '../src/engine/page-settings.js';

let dom;
beforeAll(() => { dom = new JSDOM(); for (const name of ['Node', 'document', 'DOMParser', 'XMLSerializer']) globalThis[name] = dom.window[name]; });
afterAll(() => { dom.window.close(); for (const name of ['Node', 'document', 'DOMParser', 'XMLSerializer']) delete globalThis[name]; });

const measure = text => ({ width: text.length * 6, ascent: 12, descent: 4 });
const open = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const layout = doc => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
const save = async (pkg, doc) => new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer());
const fresh = (...texts) => { const pkg = createDocx(texts.map(text => paragraph(text))); return { pkg, doc: open(pkg) }; };
const part = (bytes, name) => strFromU8(unzipSync(bytes)[name]);

describe('section breaks', () => {
  it('inserts each kind of break as one step, copying the split section and starting the next as chosen', async () => {
    const { pkg, doc } = fresh('One', 'Two');
    doc.setPageSettings({ left: 2160 });
    doc.select(3);
    expect(doc.insertSectionBreak('oddPage')).toBe(true);
    expect(doc.sectionCount).toBe(2);
    expect(doc.sectionSettings.map(s => s.sectionType)).toEqual(['nextPage', 'oddPage']);
    expect(doc.sectionSettings.map(s => s.left)).toEqual([2160, 2160]);
    expect(doc.sectionIndexAt(doc.range[0])).toBe(1);
    // The first section has one page; an odd-page section skips page 2.
    const pages = layout(doc);
    expect(pages.pageCount).toBe(3);
    expect(pages.pageSections).toEqual([0, null, 1]);
    expect(pages.lines.find(l => l.fragments.some(f => f.text === 'Two')).page).toBe(2);
    const bytes = await save(pkg, doc);
    const xml = part(bytes, 'word/document.xml');
    expect(xml).toMatch(/<w:p><w:pPr><w:sectPr>.*?w:left="2160".*?<\/w:sectPr><\/w:pPr><w:r><w:t[^>]*>One<\/w:t>/s);
    expect(xml).toMatch(/<w:type w:val="oddPage"\/>.*<\/w:body>/s);
    const reopened = await DocxPackage.open(bytes);
    expect(reopened.readOnly).not.toBe(true);
    expect(reopened.paragraphs.filter(p => p.sectionEnd).map(p => [p.sectionEnd.sectionType, p.sectionEnd.left])).toEqual([['nextPage', 2160]]);
    expect(reopened.pageSettings.sectionType).toBe('oddPage');
    expect(open(reopened).text).toBe(doc.text);
    doc.undo();
    expect(doc.sectionCount).toBe(1);
    expect(doc.text).toBe('One\nTwo');
  });
  it('starts an even-page section on the next even page without a blank page', () => {
    const { doc } = fresh('One', 'Two');
    doc.select(3); doc.insertSectionBreak('evenPage');
    expect(layout(doc).pageCount).toBe(2);
    doc.select(0); doc.insertSectionBreak('continuous');
    expect(doc.sectionSettings.map(s => s.sectionType)).toEqual(['nextPage', 'continuous', 'evenPage']);
  });
  it('refuses breaks in tables and unknown kinds', () => {
    const { doc } = fresh('One');
    expect(() => doc.insertSectionBreak('nextColumn')).toThrow();
  });
});

describe('page settings by section', () => {
  it('applies to the caret section by default, the whole document, or from the caret forward', async () => {
    const { pkg, doc } = fresh('One', 'Two', 'Three');
    doc.select(3); doc.insertSectionBreak('nextPage');
    doc.select(doc.text.length);
    doc.setPageSettings({ top: 2880 });
    expect(doc.sectionSettings.map(s => s.top)).toEqual([1440, 2880]);
    doc.setPageSettings({ right: 720 }, { scope: 'document' });
    expect(doc.sectionSettings.map(s => s.right)).toEqual([720, 720]);
    // Document-wide settings reach every section whatever the scope.
    doc.setPageSettings({ mirrorMargins: true }, { scope: 'section', section: 0 });
    expect(doc.sectionSettings.map(s => s.mirrorMargins)).toEqual([true, true]);
    const bytes = await save(pkg, doc), reopened = await DocxPackage.open(bytes);
    expect(part(bytes, 'word/settings.xml')).toContain('<w:mirrorMargins/>');
    expect([...reopened.paragraphs.filter(p => p.sectionEnd).map(p => p.sectionEnd), reopened.pageSettings].map(s => [s.top, s.right, s.mirrorMargins])).toEqual([[1440, 720, true], [2880, 720, true]]);
  });
  it('gives settings to the text from the caret forward with a new section', () => {
    const { doc } = fresh('One', 'Two', 'Three');
    doc.select(5);
    const columns = { count: 2, space: 720, equalWidth: true, separator: false };
    doc.setPageSettings({ columns }, { scope: 'forward', breakType: 'continuous' });
    expect(doc.sectionCount).toBe(2);
    expect(doc.sectionSettings.map(s => s.columns?.count ?? 1)).toEqual([1, 2]);
    expect(doc.sectionSettings.map(s => s.sectionType)).toEqual(['nextPage', 'continuous']);
    // From the start of a section no further break is needed.
    doc.setPageSettings({ columns: { ...columns, count: 3 } }, { scope: 'forward', breakType: 'continuous' });
    expect(doc.sectionCount).toBe(2);
    expect(doc.sectionSettings.map(s => s.columns?.count ?? 1)).toEqual([1, 3]);
  });
  it('gives selected text its own section between two breaks', () => {
    const { doc } = fresh('One', 'Two', 'Three');
    doc.select(4, 7);
    doc.setPageSettings({ columns: { count: 2, space: 720, equalWidth: true, separator: true } }, { scope: 'selection', breakType: 'continuous' });
    expect(doc.sectionCount).toBe(3);
    expect(doc.sectionSettings.map(s => s.columns?.count ?? 1)).toEqual([1, 2, 1]);
    expect(doc.text.slice(...doc.range)).toBe('Two');
    expect(() => layout(doc)).not.toThrow();
  });
  it('rolls back a section change that cannot fit', () => {
    const { doc } = fresh('One', 'Two');
    doc.select(5);
    expect(() => doc.setPageSettings({ left: 30000 }, { scope: 'forward' })).toThrow();
  });
});

describe('multiple pages', () => {
  it('mirrors margins on even pages with the gutter inside', () => {
    const page = pageGeometry(validatePageSettings({ mirrorMargins: true, left: 1440, right: 720, gutter: 360 }));
    expect(page.mirror).toBe(true);
    expect([readingPageGeometry(page, 0).left, readingPageGeometry(page, 0).right]).toEqual([120, 48]);
    expect([readingPageGeometry(page, 1).left, readingPageGeometry(page, 1).right]).toEqual([48, 120]);
  });
  it('lays out text on the outside-shifted even pages', () => {
    const { doc } = fresh(...Array.from({ length: 120 }, (_, i) => `Line ${i}`));
    doc.setPageSettings({ mirrorMargins: true, left: 2880, right: 720 });
    const result = layout(doc);
    expect(result.pageCount).toBeGreaterThan(1);
    const first = page => Math.min(...result.lines.filter(l => l.page === page).map(l => l.fragments[0]?.x ?? Infinity));
    expect(first(0)).toBeCloseTo(192, 0);
    expect(first(1)).toBeCloseTo(48, 0);
  });
  it('halves the sheet for two pages per sheet', () => {
    const page = pageGeometry(validatePageSettings({ printTwoOnOne: true, top: 720, bottom: 720 }));
    expect([page.width, page.height]).toEqual([816, 528]);
    expect(() => validatePageSettings({ printTwoOnOne: true, top: 4000, bottom: 3600 })).toThrow('quarter inch');
  });
  it('writes gutter position, two pages per sheet and booklet settings and reads them back', async () => {
    const { pkg, doc } = fresh('One');
    doc.setPageSettings({ gutterAtTop: true, printTwoOnOne: true });
    let bytes = await save(pkg, doc);
    expect(part(bytes, 'word/settings.xml')).toMatch(/<w:gutterAtTop\/>.*<w:printTwoOnOne\/>/s);
    let reopened = await DocxPackage.open(bytes);
    expect([reopened.pageSettings.gutterAtTop, reopened.pageSettings.printTwoOnOne]).toEqual([true, true]);
    const next = open(reopened);
    next.setPageSettings({ printTwoOnOne: false, bookFoldPrinting: true, orientation: 'landscape', width: 15840, height: 12240, gutterAtTop: false });
    bytes = await save(reopened, next);
    const settings = part(bytes, 'word/settings.xml');
    expect(settings).toContain('<w:bookFoldPrinting/>');
    expect(settings).not.toContain('printTwoOnOne');
    expect(settings).not.toContain('gutterAtTop');
    reopened = await DocxPackage.open(bytes);
    expect(reopened.pageSettings.bookFoldPrinting).toBe(true);
  });
});

describe('text-wrapping breaks', () => {
  it('insert a clearing line break that saves as br clear="all"', async () => {
    const { pkg, doc } = fresh('Before after');
    doc.select(6);
    expect(doc.insertTextWrappingBreak('all')).toBe(true);
    expect(doc.text).toBe('Before\v after');
    expect(doc.paragraphs[0].runs.find(r => r.text === '\v').breakClear).toBe('all');
    const bytes = await save(pkg, doc);
    expect(part(bytes, 'word/document.xml')).toContain('<w:br w:clear="all"/>');
    const reopened = await DocxPackage.open(bytes);
    expect(reopened.paragraphs[0].runs.find(r => r.text === '\v').breakClear).toBe('all');
    doc.undo(); expect(doc.text).toBe('Before after');
  });
});

describe('section layout fixture', () => {
  it('opens odd-page, continuous and column sections with mirrored margins for editing and saves them unchanged', async () => {
    const { readFileSync } = await import('node:fs');
    const bytes = readFileSync('public/fixtures/section-layout.docx'), pkg = await DocxPackage.open(bytes);
    expect(pkg.readOnly).not.toBe(true);
    const doc = open(pkg);
    expect(doc.sectionSettings.map(s => s.sectionType)).toEqual(['nextPage', 'oddPage', 'continuous']);
    expect(doc.sectionSettings.map(s => s.mirrorMargins)).toEqual([true, true, true]);
    expect(doc.sectionSettings[1].columns).toMatchObject({ count: 2, separator: true });
    expect(doc.paragraphs[2].runs.some(r => r.breakClear === 'all')).toBe(true);
    const pages = layout(doc);
    // Title page, an empty even page, then the odd landscape page shared by the last two sections.
    expect(pages.pageCount).toBe(3);
    expect(pages.pageSections).toEqual([0, null, 1]);
    expect(unzipSync(await save(pkg, doc))).toEqual(unzipSync(bytes));
    doc.select(doc.text.length);
    doc.setPageSettings({ left: 2160 }, { scope: 'section' });
    const edited = await DocxPackage.open(await save(pkg, doc));
    expect([...edited.paragraphs.filter(p => p.sectionEnd).map(p => p.sectionEnd.left), edited.pageSettings.left]).toEqual([1800, 1800, 2160]);
  });
});
