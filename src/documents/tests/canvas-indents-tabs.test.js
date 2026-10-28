import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { createDocx, DocxPackage, W } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphFormat } from '../src/engine/model.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { layoutDocument, caretRect, hitTest, selectionRects } from '../src/engine/layout.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const bytes = async blob => new Uint8Array(await blob.arrayBuffer());
const measure = (text, style) => ({ width: [...text].length * 8 * style.fontSize / 12, ascent: 19 * style.fontSize / 12, descent: 7 * style.fontSize / 12, underlineOffset: 2, underlineThickness: 1 });
const layout = doc => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings));
const stop = (position, alignment = 'left') => ({ position, alignment });
const fixturePath = 'public/fixtures/indents-tabs.docx';
const partsOf = async (pkg, doc) => unzipSync(await bytes(pkg.export(doc?.paragraphs, doc?.pageSettings)));
async function fixture({ pPr = '', styles = '', settings = '', content = '<w:t>Text</w:t>' } = {}) {
  const parts = await partsOf(createDocx());
  parts['word/document.xml'] = strToU8(`<w:document xmlns:w="${W}"><w:body><w:p><w:pPr>${pPr}</w:pPr><w:r>${content}</w:r></w:p></w:body></w:document>`);
  parts['word/styles.xml'] = strToU8(`<w:styles xmlns:w="${W}">${styles}</w:styles>`);
  if (settings) {
    parts['word/settings.xml'] = strToU8(`<w:settings xmlns:w="${W}">${settings}</w:settings>`);
    parts['word/_rels/document.xml.rels'] = strToU8(strFromU8(parts['word/_rels/document.xml.rels']).replace('</Relationships>', '<Relationship Id="settings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>'));
    parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace('</Types>', '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>'));
  }
  return zipSync(parts);
}

describe('paragraph indent and tab transactions', () => {
  it('compares normalized tab sets by value and preserves redo on no-op', () => {
    const doc = new TextDocument([paragraph('One', { format: { tabs: [stop(720), stop(1440, 'right')] } }), paragraph('Two', { format: { tabs: [stop(720), stop(1440, 'right')] } })]);
    doc.select(0, doc.text.length);
    expect(doc.paragraphFormatting.tabs).toEqual([stop(720), stop(1440, 'right')]);
    doc.setParagraphFormat({ indentLeft: 720 }); doc.undo();
    expect(doc.setParagraphGeometry({ tabs: [stop(1440, 'right'), stop(720)] }, 720)).toBe(false);
    expect(doc.future).toHaveLength(1);
    doc.redo(); expect(doc.paragraphFormatting.indentLeft).toBe(720);
  });
  it('applies mixed paragraph properties and document defaults in a single undo step', () => {
    const doc = new TextDocument([paragraph('One'), paragraph('Two', { format: { indentLeft: 360, tabs: [stop(1440)] } })]);
    doc.select(0, doc.text.length); const before = doc.snapshot();
    expect(doc.paragraphFormatting.indentLeft).toBe(null); expect(doc.paragraphFormatting.tabs).toBe(null);
    doc.setParagraphGeometry({ firstLine: -360, tabs: [stop(2160, 'decimal')] }, 480);
    expect(doc.history).toHaveLength(1); expect(doc.pageSettings.defaultTabStop).toBe(480);
    expect(doc.paragraphs.map(p => paragraphFormat(p).indentLeft)).toEqual([0, 360]);
    doc.undo(); expect(doc.snapshot()).toEqual(before);
    doc.redo(); expect(doc.paragraphFormatting.tabs).toEqual([stop(2160, 'decimal')]);
  });
  it.each([{ firstLine: NaN }, { indentLeft: 0.5 }, { indentRight: 40000 }, { tabs: [stop(0), stop(0)] }, { tabs: [stop(720, 'vertical')] }, { tabs: [{ ...stop(720), leader: 'invalid' }] }])('rejects invalid geometry atomically: %j', patch => {
    const doc = new TextDocument([paragraph('Text')]); const before = doc.snapshot();
    expect(() => doc.setParagraphGeometry(patch, 360)).toThrow();
    expect(doc.snapshot()).toEqual(before); expect(doc.history).toHaveLength(0);
  });
  it('validates the default interval before applying paragraph edits', () => {
    const doc = new TextDocument();
    expect(() => doc.setParagraphGeometry({ indentLeft: 720 }, 0)).toThrow();
    expect(doc.history).toHaveLength(0); expect(doc.paragraphFormatting.indentLeft).toBe(0);
  });
  it('keeps indent differences when increasing a selection and preserves geometry across split/merge', () => {
    const doc = new TextDocument([paragraph('First', { format: { firstLine: -360, indentLeft: 720, tabs: [stop(1440)] } }), paragraph('Next', { format: { indentLeft: 1440 } })]);
    doc.select(0, doc.text.length); doc.adjustIndent(720);
    expect(doc.paragraphs.map(p => paragraphFormat(p).indentLeft)).toEqual([1440, 2160]);
    doc.undo(); doc.select(2); doc.replace('\n');
    expect(paragraphFormat(doc.paragraphs[1])).toEqual(paragraphFormat(doc.paragraphs[0]));
    doc.delete(-1); expect(doc.text).toBe('First\nNext');
    expect(paragraphFormat(doc.paragraphs[0]).tabs).toEqual([stop(1440)]);
  });
});

describe('indent and tab geometry', () => {
  it('uses first-line indents once and hanging indents on wrapped/manual/page continuation lines', () => {
    for (const firstLine of [360, -360]) {
      const doc = new TextDocument([paragraph('word '.repeat(150) + '\vManual\fPage', { format: { indentLeft: 720, indentRight: 360, firstLine } })]);
      const result = layout(doc);
      expect(result.lines[0].stops[0].x).toBe(144 + firstLine / 15);
      for (const line of result.lines.slice(1)) expect(line.stops[0].x).toBe(144);
      expect(result.lines.at(-1).page).toBeGreaterThan(0);
      for (const line of result.lines) expect(line.stops.at(-1).x).toBeLessThanOrEqual(696);
    }
  });
  it('retains signed indents beyond the paper and rejects exhausted writing areas', () => {
    const doc = new TextDocument([paragraph('Text', { format: { indentLeft: -720, indentRight: -360 } })]);
    expect(layout(doc).lines[0].stops[0].x).toBe(48);
    doc.setParagraphFormat({ indentLeft: -2000 }); expect(layout(doc).lines[0].stops[0].x).toBeCloseTo(96 - 2000 / 15);
    doc.setParagraphFormat({ indentLeft: 5000, indentRight: 5000 }); expect(() => layout(doc)).toThrow(/writing space/);
  });
  it('anchors default stops to the text margin, after all custom stops', () => {
    const doc = new TextDocument([paragraph('a\tb\tc\td', { format: { tabs: [stop(1800)] } })], { defaultTabStop: 720 });
    const result = layout(doc), line = result.lines[0];
    expect(line.fragments.map(f => f.x)).toEqual([96, 216, 240, 288]);
    expect(line.fragments.map(f => f.text)).toEqual(['a', 'b', 'c', 'd']);
    expect(selectionRects(result, 1, 2)[0]).toMatchObject({ x: 104, width: 112 });
    for (const s of line.stops) expect(hitTest(result, 0, s.x, line.y + 10)).toBe(s.offset);
    expect(caretRect(result, 2).x).toBe(216);
    const plain = layout(new TextDocument([paragraph('a\tb')]));
    expect(plain.lines[0].fragments[1].x).toBe(144);
  });
  it('uses hanging-indent stops unless disabled and respects an explicit stop at the same position', () => {
    const doc = new TextDocument([paragraph('a\tb', { format: { indentLeft: 1800, firstLine: -1800 } })]);
    expect(layout(doc).lines[0].fragments[1].x).toBe(216);
    const disabled = new TextDocument(doc.paragraphs, { noTabHangInd: true });
    expect(layout(disabled).lines[0].fragments[1].x).toBe(144);
    doc.setParagraphFormat({ tabs: [stop(1800, 'right')] });
    expect(layout(doc).lines[0].fragments[1].x).toBe(208);
  });
  it('wraps consecutive tabs at the right edge instead of collapsing all remaining tabs there', () => {
    const doc = new TextDocument([paragraph('\t\t\t\t')], { width: 4320 });
    const result = layout(doc);
    expect(result.lines.map(l => [l.start, l.end])).toEqual([[0, 2], [2, 4]]);
    for (const line of result.lines) expect(line.stops.map(s => s.x)).toEqual([96, 144, 192]);
    expect(caretRect(result, 2).y).toBe(result.lines[1].y);
  });
  it.each([['left', 288], ['center', 268], ['right', 248], ['decimal', 272]])('aligns %s tab fields across mixed runs', (alignment, x) => {
    const p = paragraph('', { format: { tabs: [stop(2880, alignment)] }, runs: [{ text: 'X\t12', fontSize: 12 }, { text: '.34', fontSize: 12, italic: true, underline: true }] });
    const line = layout(new TextDocument([p])).lines[0];
    expect(line.fragments[1].x).toBe(x); expect(line.fragments[2].x).toBe(x + 16);
    expect(line.underlines[0]).toMatchObject({ x: x + 16, width: 24 });
    expect(line.stops.map(s => s.offset)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
  it('aligns a decimal field without a point after the first number, before its suffix', () => {
    const doc = new TextDocument([paragraph('X\t123 kg', { format: { tabs: [stop(2880, 'decimal')] } })]);
    expect(layout(doc).lines[0].fragments[1].x).toBe(264);
  });
  it.each(['center', 'right'])('excludes ordinary tails from %s fields while retaining editable spaces', alignment => {
    const format = { tabs: [stop(2880, alignment), stop(5760)] };
    const baseline = layout(new TextDocument([paragraph('X\tAB', { format })])).lines[0].fragments[1].x;
    for (const tail of [' ', '   ', '   \tZ', '   \vZ']) {
      const doc = new TextDocument([paragraph('X\tAB' + tail, { format })]);
      const result = layout(doc), line = result.lines[0];
      expect(line.fragments[1].x).toBe(baseline);
      expect(line.stops.some(s => s.offset === 5 && s.x === baseline + 24)).toBe(true);
      const space = selectionRects(result, 4, 5)[0];
      expect(space).toMatchObject({ x: baseline + 16, width: 8 });
      doc.select(4, 5); doc.replace('C');
      expect(layout(doc).lines[0].fragments[1].x).toBe(baseline - (alignment === 'right' ? 8 : 4));
      doc.undo(); expect(layout(doc).lines[0].fragments[1].x).toBe(baseline);
    }
    const mixed = paragraph('', { format, runs: [{ text: 'X\tAB', fontSize: 12 }, { text: '  ', fontSize: 24 }] });
    expect(layout(new TextDocument([mixed])).lines[0].fragments[1].x).toBe(baseline);
    const nbsp = layout(new TextDocument([paragraph('X\tAB\u00a0', { format })])).lines[0];
    expect(nbsp.fragments[1].x).toBe(baseline - (alignment === 'right' ? 8 : 4));
  });
  it('uses the tab run’s size for the caret and draws its underline across the actual gap', () => {
    const doc = new TextDocument([paragraph('', { runs: [{ text: 'A', fontSize: 12 }, { text: '\t', fontSize: 24, underline: true }, { text: 'B', fontSize: 12 }] })]);
    const result = layout(doc);
    expect(caretRect(result, 2).height).toBe(52);
    expect(result.lines[0].underlines[0]).toMatchObject({ x: 104, width: 40 });
  });
  it('measures alignment after tabs and honors forgetLastTabAlignment', () => {
    const p = paragraph('X\tAB', { format: { alignment: 'center', tabs: [stop(2880, 'right')] } });
    const standard = layout(new TextDocument([p])).lines[0];
    const compat = layout(new TextDocument([p], { forgetLastTabAlignment: true })).lines[0];
    expect(standard.fragments[0].x).toBe(312); // width 192, remaining 432 / 2
    expect(compat.fragments[0].x).toBe(396); // ignore the 168 px generated by the tab
  });
  it('wraps aligned fields, keeps source coverage, and resumes at the paragraph indent', () => {
    const doc = new TextDocument([paragraph('A\tlong words '.repeat(15), { format: { indentLeft: 360, firstLine: 360, tabs: [stop(2000, 'center')] } })], { width: 5000, left: 500, right: 500 });
    const result = layout(doc);
    expect(result.lines.length).toBeGreaterThan(2);
    for (let i = 1; i < result.lines.length; i++) {
      expect(result.lines[i].start).toBe(result.lines[i - 1].end);
      expect(result.lines[i].stops[0].x).toBeCloseTo(500 / 15 + 24);
    }
    expect(result.lines.at(-1).end).toBe(doc.text.length);
    expect(result.lines.flatMap(l => l.fragments).map(f => f.text).join('')).toBe(doc.text.replaceAll('\t', ''));
  });
  it('repaginates indent changes and restores identical geometry on undo, including empty paragraphs', () => {
    const doc = new TextDocument([paragraph('word '.repeat(800)), paragraph('', { format: { indentLeft: 720, firstLine: 360 } })]);
    const before = layout(doc); expect(caretRect(before, doc.text.length).x).toBe(168);
    doc.select(0); doc.setParagraphFormat({ indentLeft: 2880, indentRight: 2160 });
    expect(layout(doc).pageCount).toBeGreaterThan(before.pageCount);
    doc.undo(); expect(layout(doc)).toEqual(before);
  });
});

describe('DOCX indent and tab conformance', () => {
  it('reads independently generated style inheritance, clears and mixed aligned runs', async () => {
    const source = readFileSync(fixturePath), pkg = await DocxPackage.open(source);
    expect(pkg.paragraphs[0].format).toMatchObject({ indentLeft: 1080, indentRight: 360, firstLine: -360, tabs: [stop(2160), stop(4320, 'center'), stop(6480, 'right'), stop(8640, 'decimal')] });
    expect(pkg.paragraphs[1].format).toMatchObject({ indentLeft: 1080, indentRight: 720, firstLine: 540, tabs: [stop(4320, 'right'), stop(6480, 'right'), stop(8640, 'decimal')] });
    expect(pkg.paragraphs[2].runs.map(r => r.text).join('')).toContain('\v');
    const original = unzipSync(source), exported = await partsOf(pkg);
    for (const name of Object.keys(original)) expect(Buffer.compare(exported[name], original[name]), name).toBe(0);
  });
  it('writes clear records for inherited stops and preserves unrelated package parts and paragraphs', async () => {
    const source = readFileSync(fixturePath), pkg = await DocxPackage.open(source), doc = new TextDocument(pkg.paragraphs, pkg.pageSettings);
    doc.setParagraphGeometry({ indentLeft: 720, indentRight: 720, firstLine: 360, tabs: [stop(2520), stop(4320, 'center'), stop(6480, 'right'), stop(8640, 'decimal')] }, 360);
    const parts = await partsOf(pkg, doc), reopened = await DocxPackage.open(zipSync(parts));
    expect(reopened.paragraphs[0].format).toMatchObject({ indentLeft: 720, indentRight: 720, firstLine: 360, tabs: doc.paragraphs[0].format.tabs });
    expect(reopened.pageSettings.defaultTabStop).toBe(360);
    expect(strFromU8(parts['word/document.xml'])).toContain('w:val="clear" w:pos="2160"');
    const original = unzipSync(source);
    for (const name of Object.keys(original).filter(n => !['word/document.xml', 'word/settings.xml'].includes(n))) expect(Buffer.compare(parts[name], original[name]), name).toBe(0);
    expect(reopened.paragraphs.slice(1).map(p => p.format)).toEqual(pkg.paragraphs.slice(1).map(p => p.format));
    doc.undo(); const undone = await partsOf(pkg, doc);
    for (const name of Object.keys(original)) expect(Buffer.compare(undone[name], original[name]), name).toBe(0);
  });
  it('creates a settings part and collision-free relationship when editing a file without settings', async () => {
    const source = await partsOf(createDocx([paragraph('A\tB')]));
    source['word/_rels/document.xml.rels'] = strToU8(strFromU8(source['word/_rels/document.xml.rels']).replace('Id="rStyles"', 'Id="rSettings"'));
    const pkg = await DocxPackage.open(zipSync(source));
    const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings);
    doc.setParagraphGeometry({}, 481);
    const parts = await partsOf(pkg, doc), reopened = await DocxPackage.open(zipSync(parts));
    expect(reopened.pageSettings.defaultTabStop).toBe(481);
    expect(strFromU8(parts['word/_rels/document.xml.rels'])).toContain('Target="settings.xml"');
    expect(strFromU8(parts['word/_rels/document.xml.rels'])).toContain('Id="rSettings_"');
    expect(strFromU8(parts['[Content_Types].xml'])).toContain('PartName="/word/settings.xml"');
    const fresh = createDocx([paragraph('x\ty')], { defaultTabStop: 481, noTabHangInd: true, forgetLastTabAlignment: true });
    expect((await DocxPackage.open(await bytes(fresh.export()))).pageSettings).toMatchObject({ defaultTabStop: 481, noTabHangInd: true, forgetLastTabAlignment: true });
  });
  it('resolves logical indent aliases, signed unit positions, and same-level hanging precedence', async () => {
    const pkg = await DocxPackage.open(await fixture({ pPr: '<w:tabs><w:tab w:val="start" w:pos="-0.25in"/><w:tab w:val="end" w:pos="2in"/></w:tabs><w:ind w:left="720" w:start="1in" w:end="0.5in" w:firstLine="360" w:hanging="180"/>' }));
    expect(pkg.paragraphs[0].format).toMatchObject({ indentLeft: 1440, indentRight: 720, firstLine: -180, tabs: [stop(-360), stop(2880, 'right')] });
  });
  it('clears unsupported inherited stops before validating the effective tab set', async () => {
    const pkg = await DocxPackage.open(await fixture({ styles: '<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:pPr><w:tabs><w:tab w:val="bar" w:pos="720"/></w:tabs></w:pPr></w:style>', pPr: '<w:tabs><w:tab w:val="clear" w:pos="720"/></w:tabs>' }));
    expect(pkg.paragraphs[0].format.tabs).toEqual([]);
    const doc = new TextDocument(pkg.paragraphs); doc.setParagraphFormat({ tabs: [stop(1440)] });
    expect((await DocxPackage.open(await bytes(pkg.export(doc.paragraphs)))).paragraphs[0].format.tabs).toEqual([stop(1440)]);
  });
  it('preserves explicit zero character-unit overrides when replacing an inherited special indent', async () => {
    const source = await fixture({ styles: '<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:pPr><w:ind w:hangingChars="100"/></w:pPr></w:style>', pPr: '<w:ind w:hangingChars="0" w:hanging="360"/>' });
    const pkg = await DocxPackage.open(source), doc = new TextDocument(pkg.paragraphs);
    doc.setParagraphFormat({ firstLine: 540 });
    const reopened = await DocxPackage.open(await bytes(pkg.export(doc.paragraphs)));
    expect(reopened.paragraphs[0].format.firstLine).toBe(540);
    const uncleared = await fixture({ styles: '<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:pPr><w:ind w:hangingChars="100"/></w:pPr></w:style>', pPr: '<w:ind w:firstLine="360"/>' });
    // The inherited character-unit hanging indent overrides the direct twips (§17.3.1.12); tests/character-unit-indents.test.js covers the sizes.
    expect((await DocxPackage.open(uncleared)).paragraphs[0].format.firstLine).toBeLessThan(0);
  });
  it('clears all inherited tabs using schema-valid clear records and inherits stops through an empty source set', async () => {
    const pkg = await DocxPackage.open(await fixture({ styles: '<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr></w:style>', pPr: '<w:tabs/>' }));
    expect(pkg.paragraphs[0].format.tabs).toEqual([stop(720)]);
    const doc = new TextDocument(pkg.paragraphs); doc.setParagraphFormat({ tabs: [] });
    const parts = await partsOf(pkg, doc);
    expect(strFromU8(parts['word/document.xml'])).toContain('w:val="clear" w:pos="720"');
    expect((await DocxPackage.open(zipSync(parts))).paragraphs[0].format.tabs).toEqual([]);
  });
  it.each(['<w:tabs><w:tab w:val="left" w:pos="720" w:leader="invalid"/></w:tabs>', '<w:tabs><w:tab w:val="left"/></w:tabs>', '<w:ind w:hanging="-20"/>'])('rejects unsupported or invalid geometry instead of flattening it: %s', async pPr => {
    await expect(DocxPackage.open(await fixture({ pPr }))).rejects.toThrow();
  });
  it('preserves legacy list tabs without using them as ordinary text tabs', async () => {
    const pkg = await DocxPackage.open(await fixture({ pPr: '<w:tabs><w:tab w:val="num" w:pos="1080"/></w:tabs>', content: '<w:t>A</w:t><w:tab/><w:t>B</w:t>' }));
    const doc = new TextDocument(pkg.paragraphs);
    expect(layout(doc).lines[0].stops.find(s => s.offset === 2).x).toBe(144);
    doc.select(0); doc.replace('C');
    expect(strFromU8((await partsOf(pkg, doc))['word/document.xml'])).toContain('w:val="num"');
  });
  it('reads automatic intervals and retained tab compatibility flags', async () => {
    const pkg = await DocxPackage.open(await fixture({ settings: '<w:defaultTabStop w:val="0.25in"/><w:compat><w:noTabHangInd/><w:forgetLastTabAlignment/></w:compat>' }));
    expect(pkg.pageSettings).toMatchObject({ defaultTabStop: 360, noTabHangInd: true, forgetLastTabAlignment: true });
    await expect(DocxPackage.open(await fixture({ settings: '<w:defaultTabStop w:val="0"/>' }))).rejects.toThrow();
  });
});
