import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphFormat } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry, validatePageSettings } from '../src/engine/page-settings.js';
import { checkedLineNumbers, lineNumberLabels, lineNumberStyle } from '../src/engine/line-numbers.js';

let dom;
beforeAll(() => { dom = new JSDOM(); for (const n of ['Node', 'document', 'DOMParser', 'XMLSerializer']) globalThis[n] = dom.window[n]; });
afterAll(() => { dom.window.close(); for (const n of ['Node', 'document', 'DOMParser', 'XMLSerializer']) delete globalThis[n]; });

const measure = t => ({ width: t.length * 6, ascent: 12, descent: 4 });
const bytesOf = async blob => new Uint8Array(await blob.arrayBuffer());
const xmlOf = (bytes, part = 'word/document.xml') => strFromU8(unzipSync(bytes)[part]);
const layoutOf = doc => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
const labels = doc => lineNumberLabels(layoutOf(doc), doc.paragraphs, doc.numbering, doc.styles, measure);
const save = (pkg, doc) => pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets);

describe('line numbering settings', () => {
  it('validates countBy, start, distance and restart', () => {
    expect(checkedLineNumbers(null)).toBe(null);
    expect(checkedLineNumbers({})).toEqual({ countBy: 1, start: 0, distance: null, restart: 'newPage' });
    expect(checkedLineNumbers({ countBy: 5, start: 9, distance: 288, restart: 'continuous' })).toEqual({ countBy: 5, start: 9, distance: 288, restart: 'continuous' });
    for (const bad of [{ countBy: 0 }, { countBy: 1.5 }, { start: -1 }, { distance: -2 }, { restart: 'eachLine' }, { other: 1 }, [], 'on'])
      expect(() => checkedLineNumbers(bad)).toThrow();
    expect(validatePageSettings({ lineNumbers: { countBy: 2 } }).lineNumbers).toEqual({ countBy: 2, start: 0, distance: null, restart: 'newPage' });
    expect(() => validatePageSettings({ lineNumbers: { countBy: 101 } })).toThrow(/line numbering/i);
    expect(pageGeometry({ lineNumbers: { countBy: 3 } }).lineNumbers.countBy).toBe(3);
  });
});

describe('line number labels', () => {
  const longText = 'word '.repeat(400); // about 21 lines of 96 characters

  it('numbers every line of a section and shows every countBy-th number', () => {
    const doc = new TextDocument([paragraph(longText), paragraph('')], { lineNumbers: { countBy: 5 } });
    const layout = layoutOf(doc), body = layout.lines.filter(l => !l.virtual);
    const result = labels(doc);
    expect(result.map(l => l.text)).toEqual(Array.from({ length: Math.floor(body.length / 5) }, (_, i) => String((i + 1) * 5)));
    // The fifth line's label sits on its baseline, right-aligned a quarter inch left of the text.
    expect(result[0].baseline).toBe(body[4].baseline);
    expect(result[0].x + result[0].width).toBeCloseTo(96 - 24);
  });

  it('applies start, distance and the restart modes', () => {
    const many = Array.from({ length: 70 }, (_, i) => paragraph(`Line ${i}`));
    const run = lineNumbers => labels(new TextDocument(many, { lineNumbers })).map(l => [l.page, Number(l.text)]);
    const perPage = run({ countBy: 1, restart: 'newPage' });
    const pages = [...new Set(perPage.map(([page]) => page))];
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(perPage.find(([p]) => p === page)[1]).toBe(1);
    const continuous = run({ countBy: 1, start: 9, restart: 'continuous' });
    expect(continuous.map(([, n]) => n)).toEqual(continuous.map((_, i) => 10 + i));
    const distant = labels(new TextDocument([paragraph('A')], { lineNumbers: { distance: 720 } }));
    expect(distant[0].x + distant[0].width).toBeCloseTo(96 - 48);
  });

  it('restarts or continues at section boundaries', () => {
    const sectionEnd = lineNumbers => validatePageSettings({ lineNumbers, sectionType: 'nextPage' });
    const make = (first, second) => {
      const a = paragraph('First'), b = paragraph('Second'), c = paragraph('Third');
      Object.assign(b, { sectionEnd: sectionEnd(first), sectionProperties: '<w:sectPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>' });
      return new TextDocument([a, b, c], { lineNumbers: second });
    };
    expect(labels(make({ restart: 'continuous' }, { restart: 'continuous' })).map(l => l.text)).toEqual(['1', '2', '3']);
    expect(labels(make({ restart: 'continuous' }, { restart: 'newSection' })).map(l => l.text)).toEqual(['1', '2', '1']);
    // A section without numbering is skipped; the next numbered section continues.
    expect(labels(make(null, { restart: 'continuous', start: 4 })).map(l => l.text)).toEqual(['5']);
  });

  it('skips suppressed paragraphs, table cells and virtual lines, and numbers each column', () => {
    const doc = new TextDocument([paragraph('Counted'), paragraph('Hidden'), paragraph('Counted again')], { lineNumbers: { countBy: 1 } });
    doc.select(9); doc.setParagraphFormat({ suppressLineNumbers: true });
    expect(paragraphFormat(doc.paragraphs[1], doc.numbering).suppressLineNumbers).toBe(true);
    const result = labels(doc);
    expect(result.map(l => l.text)).toEqual(['1', '2']);
    expect(result[1].baseline).toBe(layoutOf(doc).lines.find(l => l.paragraphId === doc.paragraphs[2].id).baseline);
    const table = new TextDocument([paragraph('Before'), paragraph('After')], { lineNumbers: { countBy: 1 } });
    table.select(6); expect(table.insertTable(2, 2)).toBe(true);
    const cellLines = layoutOf(table).lines.filter(l => table.paragraphs.find(p => p.id === l.paragraphId)?.cellId);
    expect(cellLines.length).toBeGreaterThan(0);
    const tableLabels = labels(table);
    expect(tableLabels.every(label => !cellLines.some(l => l.baseline === label.baseline && l.page === label.page))).toBe(true);
    expect(tableLabels.map(l => l.text)).toEqual(tableLabels.map((_, i) => String(i + 1)));
    const columns = new TextDocument([paragraph('word '.repeat(2000))], { lineNumbers: { countBy: 1, restart: 'newPage' }, columns: { count: 2, space: 720, equalWidth: true, separator: false } });
    const colLayout = layoutOf(columns), colLabels = labels(columns);
    const second = colLayout.lines.find(l => l.page === 0 && l.column === 1);
    const label = colLabels.find(l => l.page === 0 && l.baseline === second.baseline && l.x > 200);
    expect(label).toBeTruthy();
    expect(label.x + label.width).toBeCloseTo(second.columnLeft - 24);
    // Column two continues the count from column one on the same page.
    expect(Number(label.text)).toBe(colLayout.lines.filter(l => l.page === 0 && l.column === 0 && !l.virtual).length + 1);
  });

  it('uses the Line Number character style over the default paragraph style', async () => {
    const pkg = await DocxPackage.open(readFileSync('public/fixtures/line-numbers.docx'));
    const style = lineNumberStyle(pkg.styles);
    expect(style.color).toBe('7F7F7F');
    expect(style.fontSize).toBe(8);
    expect(style.fontFamily).toBe('Noto Sans');
    expect(lineNumberStyle(createDocx().styles).fontSize).toBe(12);
  });
});

describe('DOCX line numbering', () => {
  it('reads the fixture, preserves it untouched and round-trips edits', async () => {
    const bytes = readFileSync('public/fixtures/line-numbers.docx');
    const pkg = await DocxPackage.open(bytes);
    expect(pkg.readOnly).not.toBe(true);
    const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
    const firstSection = doc.paragraphs.find(p => p.sectionEnd).sectionEnd;
    expect(firstSection.lineNumbers).toEqual({ countBy: 1, start: 0, distance: null, restart: 'newPage' });
    expect(doc.pageSettings.lineNumbers).toEqual({ countBy: 5, start: 9, distance: 288, restart: 'continuous' });
    const direct = doc.paragraphs.find(p => p.runs[0]?.text.startsWith('This paragraph is not numbered'));
    const styled = doc.paragraphs.find(p => p.runs[0]?.text.startsWith('This one uses'));
    const reset = doc.paragraphs.find(p => p.runs[0]?.text.startsWith('This paragraph turns'));
    expect([direct, styled, reset].map(p => paragraphFormat(p, doc.numbering).suppressLineNumbers)).toEqual([true, true, false]);
    // Unedited, the package is returned unchanged.
    expect(unzipSync(await bytesOf(save(pkg, doc)))).toEqual(unzipSync(bytes));
    const result = lineNumberLabels(layoutOf(doc), doc.paragraphs, doc.numbering, doc.styles, measure);
    expect(result.length).toBeGreaterThan(10);
    expect(result.some(l => l.text === '10')).toBe(true);
  });

  it('writes, changes and removes lnNumType and suppressLineNumbers', async () => {
    const pkg = createDocx([paragraph('One'), paragraph('Two')]);
    const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
    expect(doc.setPageSettings({ lineNumbers: { countBy: 2, start: 4, distance: 360, restart: 'newSection' } })).toBe(true);
    doc.select(5); doc.setParagraphFormat({ suppressLineNumbers: true });
    let bytes = await bytesOf(save(pkg, doc));
    let xml = xmlOf(bytes);
    expect(xml).toMatch(/<w:lnNumType w:countBy="2" w:start="4" w:distance="360" w:restart="newSection"\/>/);
    expect(xml).toMatch(/<w:pgMar[^>]*\/><w:lnNumType/);
    expect(xml).toContain('<w:suppressLineNumbers w:val="1"/>');
    let reopened = await DocxPackage.open(bytes);
    expect(reopened.pageSettings.lineNumbers).toEqual({ countBy: 2, start: 4, distance: 360, restart: 'newSection' });
    expect(paragraphFormat(reopened.paragraphs[1], reopened.numbering).suppressLineNumbers).toBe(true);
    const again = new TextDocument(reopened.paragraphs, reopened.pageSettings, reopened.numbering, reopened.styles, reopened.tables, reopened.assets);
    expect(again.setPageSettings({ lineNumbers: { countBy: 1, start: 0, distance: null, restart: 'continuous' } })).toBe(true);
    xml = xmlOf(await bytesOf(save(reopened, again)));
    expect(xml).toMatch(/<w:lnNumType w:countBy="1" w:restart="continuous"\/>/);
    again.setPageSettings({ lineNumbers: null });
    xml = xmlOf(await bytesOf(save(reopened, again)));
    expect(xml).not.toContain('lnNumType');
    again.undo();
    expect(again.pageSettings.lineNumbers.restart).toBe('continuous');
  });

  it('keeps a declaration without countBy as retained, inactive numbering', async () => {
    const base = createDocx([paragraph('x')]);
    const parts = { ...base.parts };
    parts['word/document.xml'] = new TextEncoder().encode(xmlOf(await bytesOf(base.export())).replace('</w:pgMar>', '').replace(/(<w:pgMar[^>]*\/>)/, '$1<w:lnNumType w:restart="newSection"/>'));
    const { zipSync } = await import('fflate');
    const pkg = await DocxPackage.open(zipSync(parts));
    expect(pkg.pageSettings.lineNumbers).toBe(null);
    expect(pkg.readOnly).not.toBe(true);
    const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
    doc.select(0); doc.replace('y');
    expect(xmlOf(await bytesOf(save(pkg, doc)))).toContain('<w:lnNumType w:restart="newSection"/>');
  });
});
