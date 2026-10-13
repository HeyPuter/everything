import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { createDocx, DocxPackage, W } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { DEFAULT_PAGE_SETTINGS, PAPER_SIZES, validatePageSettings, pageGeometry } from '../src/engine/page-settings.js';
import { layoutDocument, caretRect, hitTest, selectionRects } from '../src/engine/layout.js';

let dom;
beforeAll(() => {
  dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer;
});
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const bytes = async blob => new Uint8Array(await blob.arrayBuffer());
const measure = (text, style) => ({ width: text.length * 8, ascent: 19 * style.fontSize / 12, descent: 7 * style.fontSize / 12 });
const layout = doc => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings));
const partsOf = async (pkg, doc) => unzipSync(await bytes(pkg.export(doc?.paragraphs, doc?.pageSettings)));
async function fixture({ section = '<w:pgSz w:w="12240" w:h="15840"/>', body = '<w:p><w:r><w:t>Text</w:t></w:r></w:p>', settings, styles, extra = {} } = {}) {
  const parts = await partsOf(createDocx());
  parts['word/document.xml'] = strToU8(`<w:document xmlns:w="${W}"><w:body>${body}${section === null ? '' : `<w:sectPr>${section}</w:sectPr>`}</w:body></w:document>`);
  if (settings) {
    parts['word/settings.xml'] = strToU8(`<w:settings xmlns:w="${W}">${settings}</w:settings>`);
    parts['word/_rels/document.xml.rels'] = strToU8(strFromU8(parts['word/_rels/document.xml.rels']).replace('</Relationships>', '<Relationship Id="settings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>'));
    parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace('</Types>', '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>'));
  }
  if (styles) parts['word/styles.xml'] = strToU8(`<w:styles xmlns:w="${W}">${styles}</w:styles>`);
  return zipSync({ ...parts, ...extra });
}
const mainXml = parts => new DOMParser().parseFromString(strFromU8(parts['word/document.xml']), 'application/xml');
const node = (xml, tag) => xml.getElementsByTagNameNS(W, tag)[0];

describe('single-section page settings and transactions', () => {
  it('keeps saved dimensions independent of orientation and maps asymmetric margins and gutters', () => {
    expect(pageGeometry({ width: 16838, height: 11906, orientation: 'landscape', left: 720, right: 1080, top: -360, bottom: 1440, gutter: 180 })).toMatchObject({ width: 16838 / 15, height: 11906 / 15, left: 60, right: 72, top: 24, bottom: 96 });
    expect(pageGeometry({ width: 12240, height: 15840, orientation: 'landscape' }).width).toBe(816);
    expect(pageGeometry({ gutterAtTop: true, gutter: 360 })).toMatchObject({ left: 96, top: 120 });
  });
  it.each([{ width: 0 }, { height: 40000 }, { left: -1 }, { width: 12240.5 }, { orientation: 'diagonal' }, { top: NaN }, { left: 6000, right: 6000 }, { bogus: 2 }])('rejects invalid settings without disturbing selection/history: %j', patch => {
    const doc = new TextDocument([paragraph('Hello')]); doc.select(1, 4);
    const before = doc.snapshot();
    expect(() => doc.setPageSettings(patch)).toThrow();
    expect(doc.snapshot()).toEqual(before); expect(doc.history).toHaveLength(0);
  });
  it('repaginates narrower pages, undo restores geometry, and unchanged settings preserve redo', () => {
    const doc = new TextDocument([paragraph('word '.repeat(600))]); doc.select(3, 7);
    const before = layout(doc), selection = { ...doc.selection };
    expect(doc.setPageSettings({ left: 3600, right: 3600 })).toBe(true);
    expect(layout(doc).pageCount).toBeGreaterThan(before.pageCount);
    expect(doc.selection).toEqual(selection);
    doc.undo(); expect(layout(doc)).toEqual(before);
    expect(doc.setPageSettings({ ...DEFAULT_PAGE_SETTINGS })).toBe(false);
    expect(doc.future).toHaveLength(1); doc.redo();
    expect(doc.pageSettings.left).toBe(3600);
    doc.replace('Edited'); doc.undo(); expect(doc.pageSettings.left).toBe(3600);
    doc.undo(); expect(doc.pageSettings.left).toBe(1440);
  });
});

describe('manual breaks and pagination geometry', () => {
  it('keeps manual line, page and paragraph breaks distinct through deletion, formatting and undo', () => {
    const doc = new TextDocument([paragraph('AlphaBeta', { runs: [{ text: 'Alpha', bold: true }, { text: 'Beta', italic: true, fontSize: 18 }] })]);
    doc.select(5); doc.insertPageBreak();
    expect(doc.text).toBe('Alpha\fBeta'); expect(doc.paragraphs).toHaveLength(1);
    doc.delete(-1); expect(doc.text).toBe('AlphaBeta'); expect(doc.paragraphs[0].runs.at(-1).italic).toBe(true);
    doc.undo(); const before = doc.snapshot();
    doc.select(3, 8); doc.replace('X'); expect(doc.text).toBe('AlpXta');
    doc.undo(); expect(doc.paragraphs).toEqual(before.paragraphs);
    doc.select(0, doc.text.length); doc.setRunFormat({ underline: true });
    expect(doc.text).toBe('Alpha\fBeta'); expect(doc.paragraphs[0].runs.every(r => r.underline)).toBe(true);
  });
  it('lays out forced breaks without painting control glyphs or charging paragraph spacing', () => {
    const doc = new TextDocument([paragraph('One\vTwo\fThree', { format: { spaceBefore: 6, spaceAfter: 18 } })]);
    const result = layout(doc);
    expect(result.lines.map(l => [l.start, l.end, l.page, l.y, l.hardBreak])).toEqual([[0, 3, 0, 104, 'line'], [4, 7, 0, 130, 'page'], [8, 13, 1, 96, null]]);
    expect(result.lines.flatMap(l => l.fragments).map(f => f.text)).toEqual(['One', 'Two', 'Three']);
    for (const pos of [0, 3, 4, 7, 8, 13]) {
      const c = caretRect(result, pos); expect(hitTest(result, c.page, c.x, c.y + 5)).toBe(pos);
    }
    expect(caretRect(result, 7).page).toBe(0); expect(caretRect(result, 8).page).toBe(1);
    expect(selectionRects(result, 7, 8)).toMatchObject([{ page: 0, width: 7 }]);
    expect(new Set(selectionRects(result, 5, 10).map(r => r.page))).toEqual(new Set([0, 1]));
  });
  it.each(['\f', '\f\f', 'End\f', 'End\f\f'])('gives every intentionally blank page an editable caret: %j', text => {
    const result = layout(new TextDocument([paragraph(text)]));
    expect(result.pageCount).toBe(1 + text.split('\f').length - 1);
    expect(result.lines.at(-1)).toMatchObject({ start: text.length, end: text.length, paragraphEnd: true, page: result.pageCount - 1 });
    expect(caretRect(result, text.length).page).toBe(result.pageCount - 1);
    expect(new Set(result.lines.map(l => l.page)).size).toBe(result.pageCount);
  });
  it('retains a trailing manual line and handles wrapping immediately before a break', () => {
    const doc = new TextDocument([paragraph('word '.repeat(30) + '\v')]);
    const result = layout(doc);
    expect(result.lines.length).toBeGreaterThan(2);
    expect(result.lines.at(-2).hardBreak).toBe('line');
    expect(result.lines.at(-1).start).toBe(doc.text.length);
    expect(result.lines.slice(0, -1).map(l => l.fragments.map(f => f.text).join('')).join('')).toBe(doc.text.slice(0, -1));
  });
  it('does not create an extra automatic page just before a standalone manual break at the bottom', () => {
    const doc = new TextDocument([paragraph('First', { format: { spaceAfter: 0 } }), paragraph('\fNext')], { height: 3360 });
    expect(layout(doc).pageCount).toBe(2);
    expect(layout(doc).lines.at(-1)).toMatchObject({ page: 1, y: 96 });
  });
  it('starts specified paragraphs on a fresh page and never adds a leading blank page', () => {
    const doc = new TextDocument([paragraph('First', { format: { pageBreakBefore: true } }), paragraph('Second', { format: { pageBreakBefore: true, spaceBefore: 6 } })]);
    // Layout consumes the preceding 9pt after-gap before this 6pt before-gap.
    // Independent section-before-spacing reference cases cover the boundary rule.
    expect(layout(doc).lines.map(l => [l.page, l.y])).toEqual([[0, 96], [1, 96]]);
    doc.select(0, doc.text.length); doc.setParagraphFormat({ pageBreakBefore: false });
    expect(layout(doc).pageCount).toBe(1); doc.undo(); expect(layout(doc).pageCount).toBe(2);
  });
  it('does not allocate a paragraph-mark line after a terminal break unless splitPgBreakAndParaMark is enabled', () => {
    const ps = [paragraph('First\f'), paragraph('Second')];
    const normal = layout(new TextDocument(ps));
    expect(normal.lines.at(-1)).toMatchObject({ page: 1, y: 96 });
    expect(normal.lines[1].virtual).toBe(true);
    // A virtual insertion caret is available after the break, but does not displace the next paragraph.
    expect(caretRect(normal, 6)).toMatchObject({ page: 1, y: 96 });
    expect(hitTest(normal, 1, 96, 100)).toBe(7);
    const split = layout(new TextDocument(ps, { splitPgBreakAndParaMark: true }));
    expect(split.lines.at(-1)).toMatchObject({ page: 1, y: 134 });
    expect(split.lines[1].virtual).toBe(false);
    ps[1].format = { pageBreakBefore: true };
    expect(layout(new TextDocument(ps)).pageCount).toBe(2);
    expect(layout(new TextDocument(ps, { splitPgBreakAndParaMark: true })).pageCount).toBe(3);
  });
  it('postpones before spacing after leading page breaks, unless the compatibility flag suppresses it', () => {
    const ps = [paragraph('\f\fContent', { format: { spaceBefore: 50 } })];
    expect(layout(new TextDocument(ps)).lines.at(-1)).toMatchObject({ page: 2, y: 96 + 50 * 4 / 3 });
    expect(layout(new TextDocument(ps, { suppressSpBfAfterPgBrk: true })).lines.at(-1)).toMatchObject({ page: 2, y: 96 });
    expect(layout(new TextDocument([paragraph('Text\fContent', { format: { spaceBefore: 50 } })])).lines.at(-1).y).toBe(96);
  });
  it('includes a large paragraph mark on the old page by default, or the new page when split is enabled', () => {
    const ps = [paragraph('Small\f', { markFormat: { fontSize: 36 } }), paragraph('Next')];
    const normal = layout(new TextDocument(ps));
    expect(normal.lines[0].height).toBe(78);
    expect(normal.lines.at(-1).y).toBe(96);
    const split = layout(new TextDocument(ps, { splitPgBreakAndParaMark: true }));
    expect(split.lines[0].height).toBe(26);
    expect(split.lines.at(-1).y).toBe(96 + 78 + 12);
  });
});

describe('page and break DOCX preservation', () => {
  it.each(Object.entries(PAPER_SIZES))('round trips fresh %s pages, margins, orientation and break elements', async (_, dims) => {
    const settings = validatePageSettings({ width: dims[1], height: dims[0], orientation: 'landscape', left: 720, right: 900, top: -1080, bottom: 1440, gutter: 120, gutterAtTop: true });
    const pkg = createDocx([paragraph('One\vTwo\fThree')], settings);
    const reopened = await DocxPackage.open(await bytes(pkg.export()));
    expect(reopened.pageSettings).toEqual(settings);
    expect(new TextDocument(reopened.paragraphs).text).toBe('One\vTwo\fThree');
    expect(reopened.paragraphs).toHaveLength(1);
    const main = mainXml(reopened.parts);
    expect(node(main, 'pgMar').attributes).toHaveLength(7);
    expect([...main.getElementsByTagNameNS(W, 'br')].map(n => n.getAttributeNS(W, 'type'))).toEqual([null, 'page']);
    expect(main.getElementsByTagName('parsererror')).toHaveLength(0);
  });
  it('reads universal measurements, leaves saved dimensions unswapped, and preserves untouched attributes/parts', async () => {
    const source = await fixture({ section: '<w:pgSz w:w="210mm" w:h="297mm" w:orient="landscape" w:code="9"/><w:pgMar w:top="-0.5in" w:right="72pt" w:bottom="6pc" w:left="2.54cm" w:header="720" w:footer="720" w:gutter="0"/><w:pgNumType w:start="7"/><w:cols w:space="720"/>', extra: { 'customXml/item.xml': strToU8('<keep/>') } });
    const pkg = await DocxPackage.open(source), doc = new TextDocument(pkg.paragraphs, pkg.pageSettings);
    expect(doc.pageSettings).toMatchObject({ width: 11906, height: 16838, orientation: 'landscape', top: -720, right: 1440, bottom: 1440, left: 1440 });
    expect(await partsOf(pkg, doc)).toEqual(unzipSync(source));
    doc.setPageSettings({ left: 1080 });
    const parts = await partsOf(pkg, doc), main = mainXml(parts);
    expect(node(main, 'pgSz').getAttributeNS(W, 'w')).toBe('210mm');
    expect(node(main, 'pgSz').getAttributeNS(W, 'code')).toBe('9');
    expect(node(main, 'pgMar').getAttributeNS(W, 'left')).toBe('1080');
    expect(node(main, 'pgMar').getAttributeNS(W, 'top')).toBe('-0.5in');
    expect(node(main, 'pgNumType').getAttributeNS(W, 'start')).toBe('7');
    for (const [name, part] of Object.entries(unzipSync(source))) if (name !== 'word/document.xml') expect(parts[name]).toEqual(part);
    doc.setPageSettings({ width: 15840, height: 12240 });
    expect(node(mainXml(await partsOf(pkg, doc)), 'pgSz').hasAttributeNS(W, 'code')).toBe(false);
    expect((await DocxPackage.open(await bytes(pkg.export(doc.paragraphs, doc.pageSettings)))).pageSettings).toEqual(doc.pageSettings);
    doc.undo(); doc.undo(); expect(await partsOf(pkg, doc)).toEqual(unzipSync(source));
  });
  it('initializes required margin attributes and maintains section child order when properties were absent', async () => {
    const pkg = await DocxPackage.open(await fixture({ section: '<w:pgNumType w:start="2"/><w:cols/>' }));
    const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings);
    doc.setPageSettings({ width: 11906, height: 16838, left: 720 });
    const main = mainXml(await partsOf(pkg, doc));
    expect([...node(main, 'sectPr').children].map(n => n.localName)).toEqual(['pgSz', 'pgMar', 'pgNumType', 'cols']);
    expect(node(main, 'pgMar').attributes).toHaveLength(7);
    const missing = await DocxPackage.open(await fixture({ section: null }));
    const edited = new TextDocument(missing.paragraphs, missing.pageSettings); edited.setPageSettings({ right: 720 });
    expect(node(mainXml(await partsOf(missing, edited)), 'pgMar').getAttributeNS(W, 'right')).toBe('720');
  });
  it('reads paragraph page-break inheritance and explicit off, retaining styles on override', async () => {
    const pkg = await DocxPackage.open(await fixture({
      styles: '<w:style w:type="paragraph" w:styleId="Base" w:default="1"><w:pPr><w:pageBreakBefore/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Child"><w:basedOn w:val="Base"/></w:style>',
      body: '<w:p><w:pPr><w:pStyle w:val="Child"/></w:pPr><w:r><w:t>One</w:t></w:r></w:p><w:p><w:pPr><w:pageBreakBefore w:val="0"/></w:pPr><w:r><w:t>Two</w:t></w:r></w:p>',
    }));
    expect(pkg.paragraphs.map(p => p.format.pageBreakBefore)).toEqual([true, false]);
    const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings); doc.select(0, doc.text.length); doc.setParagraphFormat({ pageBreakBefore: false });
    const reopened = await DocxPackage.open(await bytes(pkg.export(doc.paragraphs, doc.pageSettings)));
    expect(reopened.paragraphs.map(p => p.format.pageBreakBefore)).toEqual([false, false]);
    expect(reopened.parts['word/styles.xml']).toEqual(pkg.parts['word/styles.xml']);
  });
  it('retains page-break compatibility flags and top gutters across new documents and source edits', async () => {
    const pkg = createDocx([paragraph('\fText\f'), paragraph('Next')], { splitPgBreakAndParaMark: true, suppressSpBfAfterPgBrk: true, gutterAtTop: true, gutter: 180 });
    const imported = await DocxPackage.open(await bytes(pkg.export()));
    expect(imported.pageSettings).toEqual(pkg.pageSettings);
    const doc = new TextDocument(imported.paragraphs, imported.pageSettings);
    doc.setPageSettings({ right: 720 });
    const out = await partsOf(imported, doc);
    expect(out['word/settings.xml']).toEqual(imported.parts['word/settings.xml']);
    expect((await DocxPackage.open(zipSync(out))).pageSettings).toEqual(doc.pageSettings);
    expect(() => doc.setPageSettings({ splitPgBreakAndParaMark: false })).toThrow('retained');
  });
  it('treats cached page markers as hints, cr as line breaks and br as authored breaks; edits invalidate hints', async () => {
    const pkg = await DocxPackage.open(await fixture({ body: '<w:p><w:r><w:t>A</w:t><w:lastRenderedPageBreak/><w:t>B</w:t><w:cr/><w:t>C</w:t><w:br w:type="page"/><w:t>D</w:t></w:r></w:p>' }));
    const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings);
    expect(doc.text).toBe('AB\vC\fD');
    expect(node(mainXml(await partsOf(pkg, doc)), 'lastRenderedPageBreak')).toBeDefined();
    doc.setPageSettings({ left: 720 });
    expect(node(mainXml(await partsOf(pkg, doc)), 'lastRenderedPageBreak')).toBeUndefined();
    doc.select(0); doc.replace('X');
    const reopened = await DocxPackage.open(await bytes(pkg.export(doc.paragraphs, doc.pageSettings)));
    expect(new TextDocument(reopened.paragraphs).text).toBe('XAB\vC\fD');
  });
  it.each([
    { section: '<w:rtlGutter/>' }, { section: '<w:textDirection w:val="tbRl"/>' }, { section: '<w:vAlign w:val="invalid"/>' },
    { section: '<w:pgSz w:w="0"/>' }, { section: '<w:pgMar w:left="-20"/>' },
    { settings: '<w:bookFoldPrinting w:val="invalid"/>' },
    { body: '<w:p/><w:sectPr/>' },
  ])('rejects unsupported page structure before edit: %j', async input => {
    await expect(DocxPackage.open(await fixture(input))).rejects.toMatchObject({ name: 'UnsupportedDocumentError' });
  });
  it.each([
    { section: '<w:cols w:num="2" w:sep="1"/>', columns: { count: 2, equalWidth: true, separator: true }, right: 384 },
    { section: '<w:cols w:equalWidth="0"><w:col w:w="1000"/></w:cols>', columns: { count: 1, equalWidth: false, separator: false, entries: [{ width: 1000, space: 0 }] }, right: 96 + 1000 / 15 },
  ])('retains supported column declarations through editing: $section', async ({ section, columns, right }) => {
    const input = await fixture({ section }), pkg = await DocxPackage.open(input);
    expect(pkg.readOnly).not.toBe(true); expect(pkg.pageSettings.columns).toMatchObject(columns);
    expect(await partsOf(pkg)).toEqual(unzipSync(input));
    const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles);
    doc.select(0); doc.replace('Edited ');
    const rendered = layout(doc);
    expect(rendered.lines[0].fragments[0].x).toBe(96);
    for (const line of rendered.lines) for (const fragment of line.fragments) {
      expect(fragment.x).toBeGreaterThanOrEqual(96);
      expect(fragment.x + fragment.width).toBeLessThanOrEqual(right + 0.001);
    }
    const saved = await bytes(pkg.export(doc.paragraphs, doc.pageSettings));
    const reopened = await DocxPackage.open(saved);
    expect(reopened.pageSettings.columns).toEqual(pkg.pageSettings.columns);
    expect(new TextDocument(reopened.paragraphs, reopened.pageSettings).text).toBe('Edited Text');
  });
  it('opens the independent landscape fixture with authored breaks, asymmetric margins and inherited pagination', async () => {
    const pkg = await DocxPackage.open(new Uint8Array(readFileSync('public/fixtures/page-settings.docx')));
    expect(pkg.pageSettings).toMatchObject({ width: 16838, height: 11906, orientation: 'landscape', left: 1080, right: 1440, top: 720, bottom: 1080, gutter: 180 });
    const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings);
    expect(doc.text).toBe('Before break\fAfter break\vSame paragraph\nNew page from style\nLast paragraph');
    expect(pkg.paragraphs[1].format.pageBreakBefore).toBe(true);
    expect(layout(doc).pageCount).toBe(3);
    const out = await partsOf(pkg, doc);
    expect(Object.keys(out)).toEqual(Object.keys(pkg.parts));
    for (const [name, data] of Object.entries(pkg.parts)) expect(Buffer.from(out[name]).equals(Buffer.from(data))).toBe(true);
  });
  it.each([false, true])('matches independent leading/trailing-break fixtures with compatibility flags enabled=%s', async enabled => {
    const pkg = await DocxPackage.open(new Uint8Array(readFileSync(`public/fixtures/page-breaks-${enabled ? 'compat' : 'default'}.docx`)));
    expect(pkg.pageSettings).toMatchObject({ splitPgBreakAndParaMark: enabled, suppressSpBfAfterPgBrk: enabled });
    const result = layout(new TextDocument(pkg.paragraphs, pkg.pageSettings));
    expect(result.lines.find(l => l.fragments.some(f => f.text === 'Leading')).y).toBeCloseTo(enabled ? 96 : 96 + 50 * 4 / 3);
    expect(result.lines.at(-1)).toMatchObject({ page: 2, y: enabled ? 122 : 96 });
  });
});
