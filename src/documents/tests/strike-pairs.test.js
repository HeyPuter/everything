import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';

// §17.3.2.37 strike and §17.3.2.9 dstrike are separate on/off properties. Word, Pages and legal
// templates write both in one property set when at most one is on: both switched off
// (<w:strike w:val="0"/><w:dstrike w:val="0"/>), or one on with the other off. That opened the whole
// document read-only ("strike and dstrike on the same property set"). Each pair now resolves its two
// declarations independently; both on, which would need a choice of form, still opens read-only.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const OFF = '<w:strike w:val="0"/><w:dstrike w:val="0"/>', SINGLE = '<w:strike/><w:dstrike w:val="0"/>', DOUBLE = '<w:strike w:val="0"/><w:dstrike/>';
function pkgBytes({ run = OFF, styleRPr = OFF, levelRPr = OFF } = {}) {
  const styles = `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Double"><w:name w:val="Double"/><w:rPr><w:dstrike/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Cleared"><w:name w:val="Cleared"/><w:basedOn w:val="Double"/><w:rPr><w:b w:val="0"/><w:i w:val="0"/>${styleRPr}<w:vanish w:val="0"/></w:rPr></w:style>`
    + `<w:style w:type="character" w:styleId="ClearedChar"><w:name w:val="Cleared Char"/><w:rPr>${styleRPr}</w:rPr></w:style></w:styles>`;
  const numbering = `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr>${levelRPr}</w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const body = `<w:p><w:pPr><w:pStyle w:val="Double"/></w:pPr><w:r><w:rPr>${run}</w:rPr><w:t>Direct pair</w:t></w:r><w:r><w:t xml:space="preserve"> inherited</w:t></w:r></w:p>`
    + `<w:p><w:pPr><w:pStyle w:val="Cleared"/></w:pPr><w:r><w:t>Style pair</w:t></w:r></w:p>`
    + `<w:p><w:pPr><w:pStyle w:val="Double"/></w:pPr><w:r><w:rPr><w:rStyle w:val="ClearedChar"/></w:rPr><w:t>Character pair</w:t></w:r></w:p>`
    + `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Listed</w:t></w:r></w:p>`;
  return zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${R}/numbering" Target="numbering.xml"/></Relationships>`,
    'word/styles.xml': styles, 'word/numbering.xml': numbering,
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  }).map(([name, xml]) => [name, strToU8(xml)])));
}
const model = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const strike = (doc, text) => doc.paragraphs.flatMap(p => p.runs).find(r => r.text === text).strikethrough;
const save = async (pkg, doc) => unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer()));

it('opens both forms switched off for editing and clears an inherited double strikethrough', async () => {
  const pkg = await DocxPackage.open(pkgBytes()), doc = model(pkg);
  expect(pkg.readOnly).toBeFalsy();
  expect(strike(doc, ' inherited')).toBe('double');
  for (const text of ['Direct pair', 'Style pair', 'Character pair']) expect(strike(doc, text), text).toBe('none');
  expect(pkg.numbering.abstracts['0'].levels[0].markerStyle.strikethrough).toBe('bothStrikeOff');
});

it('takes the form that is on when the other is switched off', async () => {
  for (const [pair, expected] of [[SINGLE, 'single'], [DOUBLE, 'double']]) {
    const doc = model(await DocxPackage.open(pkgBytes({ run: pair, styleRPr: pair, levelRPr: pair })));
    for (const text of ['Direct pair', 'Style pair', 'Character pair']) expect(strike(doc, text), `${pair} ${text}`).toBe(expected);
  }
});

it('keeps the pairs through an edit and writes one form when the strikethrough changes', async () => {
  const pkg = await DocxPackage.open(pkgBytes()), doc = model(pkg);
  doc.select(doc.text.indexOf('Listed') + 6); doc.replace(' item');
  let parts = await save(pkg, doc);
  expect(strFromU8(parts['word/styles.xml'])).toBe(strFromU8(unzipSync(pkgBytes())['word/styles.xml']));
  expect(strFromU8(parts['word/document.xml'])).toContain(OFF);
  const at = doc.text.indexOf('Direct pair'); doc.select(at, at + 11); doc.setRunFormat({ strikethrough: 'single' });
  parts = await save(pkg, doc);
  const reopened = model(await DocxPackage.open(zipSync(parts)));
  expect(strike(reopened, 'Direct pair')).toBe('single');
  expect(strFromU8(parts['word/document.xml'])).not.toContain(OFF);
  // A style edited to clear both forms writes the pair.
  doc.editParagraphStyle('Double', { run: { strikethrough: 'bothStrikeOff' } });
  expect(strFromU8((await save(pkg, doc))['word/styles.xml'])).toMatch(/<w:style w:type="paragraph" w:styleId="Double">.*<w:strike w:val="0"\/><w:dstrike w:val="0"\/>/);
});

it('still opens both forms switched on read-only', async () => {
  await expect(DocxPackage.open(pkgBytes({ run: '<w:strike/><w:dstrike/>' }))).rejects.toThrow('strike and dstrike both on');
});
