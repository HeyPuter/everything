import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import { createDocx, DocxPackage, W } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';

let dom;
beforeAll(() => {
  dom = new JSDOM('');
  globalThis.DOMParser = dom.window.DOMParser;
  globalThis.XMLSerializer = dom.window.XMLSerializer;
});
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const bytes = async blob => new Uint8Array(await blob.arrayBuffer());
async function fixture(body, extra = {}) {
  const parts = unzipSync(await bytes(createDocx().export()));
  parts['word/document.xml'] = strToU8(`<w:document xmlns:w="${W}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`);
  Object.assign(parts, extra);
  return zipSync(parts);
}

describe('original DOCX codec', () => {
  it('opens the independent fixture and survives cross-paragraph bold, text edits, undo and export', async () => {
    const source = readFileSync(new URL('../public/fixtures/two-paragraphs.docx', import.meta.url));
    const pkg = await DocxPackage.open(new Uint8Array(source));
    const doc = new TextDocument(pkg.paragraphs);
    const original = doc.text;
    doc.select(8); doc.replace('new ');
    doc.select(3, doc.paragraphs[0].runs.map(r => r.text).join('').length + 14);
    doc.toggleBold();
    doc.undo(); doc.redo();
    const reopened = await DocxPackage.open(await bytes(pkg.export(doc.paragraphs)));
    const result = new TextDocument(reopened.paragraphs);
    expect(result.text).toBe(original.slice(0, 8) + 'new ' + original.slice(8));
    expect(result.paragraphs[0].runs.some(r => r.bold)).toBe(true);
    expect(result.paragraphs[1].runs[0].bold).toBe(true);
  });
  it('preserves every package entry byte-for-byte when there are no edits', async () => {
    const input = await fixture('<w:p><w:r><w:t>Hello</w:t></w:r></w:p>', { 'customXml/item1.xml': strToU8('<custom value="unchanged"/>'), 'word/media/unused.bin': new Uint8Array([0, 1, 255]) });
    const pkg = await DocxPackage.open(input);
    const output = unzipSync(await bytes(pkg.export()));
    expect(output).toEqual(unzipSync(input));
  });
  it('retains unknown properties and unedited paragraphs, while writing explicit bold overrides', async () => {
    const input = await fixture('<w:p w14:paraId="12345678"><w:pPr><w:spacing w:after="160"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial"/><w:color w:val="123456"/></w:rPr><w:t>Alpha</w:t></w:r></w:p><w:p><w:r><w:t>Untouched</w:t></w:r></w:p>', { 'customXml/item1.xml': strToU8('<retained/>') });
    const pkg = await DocxPackage.open(input), doc = new TextDocument(pkg.paragraphs);
    doc.select(0, 5); doc.toggleBold();
    const output = unzipSync(await bytes(pkg.export(doc.paragraphs)));
    expect(output['customXml/item1.xml']).toEqual(unzipSync(input)['customXml/item1.xml']);
    const main = new DOMParser().parseFromString(strFromU8(output['word/document.xml']), 'application/xml');
    expect(main.getElementsByTagNameNS(W, 'color')[0].getAttributeNS(W, 'val')).toBe('123456');
    expect(main.getElementsByTagNameNS(W, 'b')[0].getAttributeNS(W, 'val')).toBe('1');
    expect(main.getElementsByTagNameNS(W, 'spacing')[0].getAttributeNS(W, 'after')).toBe('160');
    expect(main.getElementsByTagNameNS(W, 'p')[1].textContent).toBe('Untouched');
    // A split must not duplicate the stored paragraph IDs.
    doc.select(2); doc.replace('\n');
    const split = strFromU8(unzipSync(await bytes(pkg.export(doc.paragraphs)))['word/document.xml']);
    expect(split.match(/paraId=/g)).toHaveLength(1);
  });
  it('reads inherited bold and allows switching it off with direct formatting', async () => {
    const styles = strToU8(`<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Heading"><w:rPr><w:b/></w:rPr></w:style></w:styles>`);
    const input = await fixture('<w:p><w:pPr><w:pStyle w:val="Heading"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>', { 'word/styles.xml': styles });
    const pkg = await DocxPackage.open(input), doc = new TextDocument(pkg.paragraphs);
    doc.select(0, 5); expect(doc.bold).toBe(true); doc.toggleBold();
    const reopened = await DocxPackage.open(await bytes(pkg.export(doc.paragraphs)));
    expect(reopened.paragraphs[0].runs[0].bold).toBe(false);
    expect(reopened.parts['word/styles.xml']).toEqual(styles);
  });
  it('round trips tabs, spaces, XML escapes, non-Latin text and emoji', async () => {
    const text = ' A & <B>\tCafé 한글 👋 ';
    const reopened = await DocxPackage.open(await bytes(createDocx([paragraph(text)]).export()));
    expect(new TextDocument(reopened.paragraphs).text).toBe(text);
  });
  it.each([
    ['tables', '<w:tbl/>'],
    ['drawings', '<w:p><w:r><w:drawing/></w:r></w:p>'],
    ['fields', '<w:p><w:fldSimple w:instr="COMPARE 1 = 1"/></w:p>'],
    ['next-column section breaks', '<w:p><w:pPr><w:sectPr/></w:pPr></w:p><w:p><w:pPr><w:sectPr><w:type w:val="nextColumn"/></w:sectPr></w:pPr></w:p>'],
  ])('rejects %s before returning an editable document', async (_, body) => {
    await expect(DocxPackage.open(await fixture(body))).rejects.toMatchObject({ name: 'UnsupportedDocumentError' });
  });
  it('rejects malformed archives and XML entity declarations', async () => {
    await expect(DocxPackage.open(new Uint8Array([1, 2, 3]))).rejects.toThrow();
    const data = unzipSync(await fixture('<w:p/>'));
    data['word/document.xml'] = strToU8(`<!DOCTYPE x [<!ENTITY y "bad">]><w:document xmlns:w="${W}"><w:body/></w:document>`);
    await expect(DocxPackage.open(zipSync(data))).rejects.toThrow('entity');
  });
  it('retains continuous section declarations through no-edit export and reopen', async () => {
    const input = await fixture('<w:p><w:pPr><w:sectPr/></w:pPr></w:p><w:p><w:pPr><w:sectPr><w:type w:val="continuous"/></w:sectPr></w:pPr></w:p>');
    const pkg = await DocxPackage.open(input), output = await bytes(pkg.export());
    expect(pkg.paragraphs.filter(p => p.sectionEnd).map(p => p.sectionEnd.sectionType)).toEqual(['nextPage', 'continuous']);
    expect(unzipSync(output)).toEqual(unzipSync(input));
    expect((await DocxPackage.open(output)).paragraphs.filter(p => p.sectionEnd).map(p => p.sectionEnd.sectionType)).toEqual(['nextPage', 'continuous']);
  });
});

describe('DOCX paragraph formatting', () => {
  it('resolves defaults, basedOn chains and direct spacing one attribute at a time', async () => {
    const styles = strToU8(`<w:styles xmlns:w="${W}"><w:docDefaults><w:pPrDefault><w:pPr><w:spacing w:before="60" w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Base" w:default="1"><w:pPr><w:jc w:val="center"/><w:spacing w:before="120"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Child"><w:basedOn w:val="Base"/><w:pPr><w:spacing w:after="240"/></w:pPr></w:style></w:styles>`);
    const input = await fixture('<w:p><w:pPr><w:pStyle w:val="Child"/><w:spacing w:before="0"/><w:ind w:left="100"/><w:jc w:val="right"/><w:rPr><w:color w:val="123456"/></w:rPr></w:pPr><w:r><w:t>First</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p>', { 'word/styles.xml': styles, 'customXml/item.xml': strToU8('<preserved/>') });
    const pkg = await DocxPackage.open(input), doc = new TextDocument(pkg.paragraphs);
    expect(doc.paragraphs[0].format).toEqual({ paragraphBorders: {}, paragraphShading: 'auto', contextualSpacing: false, suppressLineNumbers: false, outlineLevel: 9, keepNext: false, keepLines: false, widowControl: true, indentLeft: 100, indentRight: 0, firstLine: 0, tabs: [], pageBreakBefore: false, alignment: 'right', spaceBefore: 0, spaceAfter: 12, lineRule: 'auto', lineSpacing: 1.15 });
    expect(doc.paragraphs[1].format).toMatchObject({ alignment: 'center', spaceBefore: 6, spaceAfter: 8 });
    doc.select(0, doc.text.length); doc.setParagraphFormat({ alignment: 'left', spaceBefore: 12, lineSpacing: 2 });
    const output = unzipSync(await bytes(pkg.export(doc.paragraphs)));
    for (const [name, part] of Object.entries(unzipSync(input))) if (name !== 'word/document.xml') expect(output[name]).toEqual(part);
    const main = new DOMParser().parseFromString(strFromU8(output['word/document.xml']), 'application/xml');
    const pPr = main.getElementsByTagNameNS(W, 'pPr')[0];
    expect([...pPr.children].map(n => n.localName)).toEqual(['pStyle', 'spacing', 'ind', 'jc', 'rPr']);
    expect(pPr.getElementsByTagNameNS(W, 'spacing')[0].hasAttributeNS(W, 'after')).toBe(false);
    expect(pPr.getElementsByTagNameNS(W, 'ind')[0].getAttributeNS(W, 'left')).toBe('100');
    const reopened = await DocxPackage.open(zipSync(output));
    expect(reopened.paragraphs.map(p => p.format)).toEqual(doc.paragraphs.map(p => p.format));
    doc.undo(); expect(unzipSync(await bytes(pkg.export(doc.paragraphs)))).toEqual(unzipSync(input));
  });
  it('retains inherited exact spacing while changing only alignment', async () => {
    const styles = strToU8(`<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:pPr><w:spacing w:line="360" w:lineRule="exact"/></w:pPr></w:style></w:styles>`);
    const pkg = await DocxPackage.open(await fixture('<w:p><w:r><w:t>One</w:t></w:r></w:p>', { 'word/styles.xml': styles }));
    const doc = new TextDocument(pkg.paragraphs);
    // The engine retains application after-spacing when the defaults category is
    // absent, even when the paragraph style supplies an exact line height.
    expect(doc.paragraphFormatting).toMatchObject({ lineSpacing: 18, lineRule: 'exact', spaceAfter: 8 });
    doc.setParagraphFormat({ alignment: 'center' });
    const data = await bytes(pkg.export(doc.paragraphs));
    expect(strFromU8(unzipSync(data)['word/document.xml'])).not.toContain('w:spacing');
    expect((await DocxPackage.open(data)).paragraphs[0].format).toMatchObject({ alignment: 'center', lineSpacing: 18, lineRule: 'exact' });
    doc.setParagraphFormat({ lineSpacing: 1.5, lineRule: 'auto' });
    expect((await DocxPackage.open(await bytes(pkg.export(doc.paragraphs)))).paragraphs[0].format).toMatchObject({ lineSpacing: 1.5, lineRule: 'auto' });
  });
  it('round trips formatting on newly split paragraphs and an empty paragraph', async () => {
    const doc = new TextDocument([paragraph('One')]);
    doc.setParagraphFormat({ alignment: 'center', spaceBefore: 12.5, spaceAfter: 18, lineSpacing: 1.5 });
    doc.select(3); doc.replace('\n');
    const reopened = await DocxPackage.open(await bytes(createDocx(doc.paragraphs).export()));
    expect(reopened.paragraphs.map(p => p.format)).toEqual(doc.paragraphs.map(p => p.format));
    expect(new TextDocument(reopened.paragraphs).text).toBe('One\n');
  });
  it.each([
    '<w:spacing w:beforeAutospacing="invalid"/>', '<w:spacing w:beforeLines="5001"/>',
    '<w:spacing w:line="bad"/>', '<w:spacing w:before="-20"/>',
    '<w:jc w:val="distribute"/>',
  ])('rejects unsupported effective formatting: %s', async properties => {
    await expect(DocxPackage.open(await fixture(`<w:p><w:pPr>${properties}</w:pPr><w:r><w:t>One</w:t></w:r></w:p>`))).rejects.toMatchObject({ name: 'UnsupportedDocumentError' });
  });
});

describe('OOXML run-format conformance', () => {
  it('resolves half-point sizes, nearest italic declarations, character-style toggles and direct off values', async () => {
    const styles = strToU8(`<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="27"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Base"><w:rPr><w:i/><w:u w:val="single"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Derived"><w:basedOn w:val="Base"/><w:rPr><w:i/></w:rPr></w:style><w:style w:type="character" w:styleId="Emphasis"><w:rPr><w:i/><w:sz w:val="48"/></w:rPr></w:style></w:styles>`);
    const pkg = await DocxPackage.open(await fixture('<w:p><w:pPr><w:pStyle w:val="Derived"/><w:rPr><w:sz w:val="72"/></w:rPr></w:pPr><w:r><w:t>A</w:t></w:r><w:r><w:rPr><w:rStyle w:val="Emphasis"/></w:rPr><w:t>B</w:t></w:r><w:r><w:rPr><w:rStyle w:val="Emphasis"/><w:i w:val="0"/><w:u w:val="none"/><w:sz w:val="28"/></w:rPr><w:t>C</w:t></w:r></w:p>', { 'word/styles.xml': styles }));
    expect(pkg.paragraphs[0].runs.map(r => [r.fontSize, r.italic, r.underline])).toEqual([[13.5, true, true], [24, false, true], [14, false, false]]);
    expect(pkg.paragraphs[0].markFormat.fontSize).toBe(36);
    const doc = new TextDocument(pkg.paragraphs); doc.select(0, 2); doc.setRunFormat({ fontSize: 18.5, italic: false, underline: false });
    const data = await bytes(pkg.export(doc.paragraphs));
    const reopened = await DocxPackage.open(data);
    expect(reopened.paragraphs[0].runs.map(r => [r.fontSize, r.italic, r.underline])).toEqual([[18.5, false, false], [18.5, false, false], [14, false, false]]);
    expect(reopened.parts['word/styles.xml']).toEqual(styles);
    const main = strFromU8(unzipSync(data)['word/document.xml']);
    expect(main).toContain('w:sz w:val="37"');
    expect(main).toContain('w:i w:val="0"');
    expect(main).toContain('w:u w:val="none"');
  });
  it('keeps a true document-default toggle through style levels while allowing a direct off override', async () => {
    const styles = strToU8(`<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:i/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:rPr><w:i/></w:rPr></w:style><w:style w:type="character" w:styleId="Emphasis"><w:rPr><w:i/></w:rPr></w:style></w:styles>`);
    const pkg = await DocxPackage.open(await fixture('<w:p><w:r><w:rPr><w:rStyle w:val="Emphasis"/></w:rPr><w:t>A</w:t></w:r><w:r><w:rPr><w:i w:val="0"/></w:rPr><w:t>B</w:t></w:r></w:p>', { 'word/styles.xml': styles }));
    expect(pkg.paragraphs[0].runs.map(r => r.italic)).toEqual([true, false]);
  });
  it('saves empty paragraph-mark formatting, then uses it for inserted text after reopening', async () => {
    const doc = new TextDocument([paragraph()]);
    doc.setRunFormat({ fontSize: 24, italic: true, underline: true });
    const pkg = await DocxPackage.open(await bytes(createDocx(doc.paragraphs).export()));
    const reopened = new TextDocument(pkg.paragraphs);
    expect(reopened.runFormatting).toMatchObject({ fontSize: 24, italic: true, underline: true });
    reopened.replace('Heading');
    const roundTrip = await DocxPackage.open(await bytes(pkg.export(reopened.paragraphs)));
    expect(roundTrip.paragraphs[0].runs[0]).toMatchObject({ text: 'Heading', fontSize: 24, italic: true, underline: true });
  });
  it('uses explicit false from the nearest based-on style before combining hierarchy levels', async () => {
    const styles = strToU8(`<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Base"><w:rPr><w:i/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Child" w:default="1"><w:basedOn w:val="Base"/><w:rPr><w:i w:val="false"/></w:rPr></w:style></w:styles>`);
    const pkg = await DocxPackage.open(await fixture('<w:p><w:r><w:t>A</w:t></w:r></w:p>', { 'word/styles.xml': styles }));
    expect(pkg.paragraphs[0].runs[0].italic).toBe(false);
  });
  it('imports an active complex-script run property', async () => {
    const pkg = await DocxPackage.open(await fixture('<w:p><w:r><w:rPr><w:cs/></w:rPr><w:t>A</w:t></w:r></w:p>'));
    expect(pkg.paragraphs[0].runs[0]).toMatchObject({text:'A',cs:true});
  });
  it.each(['<w:sz w:val="oops"/>', '<w:sz w:val="27.5"/>', '<w:u w:val="zigzag"/>'])('rejects unsupported effective run properties instead of misrendering them: %s', async properties => {
    await expect(DocxPackage.open(await fixture(`<w:p><w:r><w:rPr>${properties}</w:rPr><w:t>A</w:t></w:r></w:p>`))).rejects.toMatchObject({ name: 'UnsupportedDocumentError' });
  });
});
