import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const fixture = name => readFileSync(`tests/fixtures/mail-merge/${name}`);
const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const save = async (p, d) => new Uint8Array(await p.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());

describe('mail merge main documents', () => {
  it('open editable with nested rule operands and round-trip untouched', async () => {
    const pkg = await DocxPackage.open(fixture('letter.docx'));
    expect(pkg.readOnly).toBeFalsy();
    const d = model(pkg), ranges = bodyFieldRanges(d.paragraphs);
    expect(ranges.map(r => r.field.type)).toEqual(['SKIPIF', 'ADDRESSBLOCK', 'GREETINGLINE', 'MERGEFIELD', 'MERGEFIELD', 'IF', 'MERGEFIELD', 'MERGEREC']);
    expect(ranges[5].field.instruction).toBe(' IF "{ MERGEFIELD City }" = "Oslo" "See you at the fjord." "See you soon." ');
    expect(ranges[0].field.instruction).toBe(' SKIPIF { MERGEFIELD Status } = "inactive" ');
    expect(ranges[1].field.instruction).toContain('\n<<_COMPANY_\n>>');
    expect(d.text.slice(ranges[5].start, ranges[5].end)).toBe('See you soon.');
    expect(unzipSync(await save(pkg, d))).toEqual(pkg.parts);
  });
  it('keeps nested instruction envelopes when the text around them is edited', async () => {
    const pkg = await DocxPackage.open(fixture('letter.docx')), d = model(pkg);
    const ifRange = bodyFieldRanges(d.paragraphs)[5];
    d.select(ifRange.start, ifRange.end); d.replace('Changed result');
    d.select(0); d.replace('Note: ');
    const out = await save(pkg, d), xml = strFromU8(unzipSync(out)['word/document.xml']);
    expect(xml).toContain('<w:instrText xml:space="preserve"> MERGEFIELD City </w:instrText>');
    expect(xml).toMatch(/<w:t xml:space="preserve">Lisbon<\/w:t>/);
    const again = model(await DocxPackage.open(out));
    expect(bodyFieldRanges(again.paragraphs).map(r => r.field.instruction)).toEqual(bodyFieldRanges(d.paragraphs).map(r => r.field.instruction));
    expect(again.text).toBe(d.text);
  });
});
