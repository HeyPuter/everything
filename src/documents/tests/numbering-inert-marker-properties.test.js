import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { listMarkers } from '../src/engine/numbering.js';

// A list level's rPr (ECMA-376 Part 1 §17.9.24, CT_RPr §17.3.2) formats its number. Word's
// Define New Multilevel List > Font writes every font option it shows, switched off where unused:
// noProof, vanish, outline, shadow, emboss, imprint, webHidden w:val="0", em w:val="none"… Any of
// them made the whole document open read-only ("Unsupported numbering symbol formatting: vanish").
// Declared off, they change nothing, so they are now accepted and kept.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const LEGAL = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:hint="default"/><w:b w:val="0"/><w:i w:val="0"/><w:caps w:val="0"/><w:smallCaps w:val="0"/><w:strike w:val="0"/><w:noProof w:val="0"/><w:outline w:val="0"/><w:shadow w:val="0"/><w:emboss w:val="0"/><w:imprint w:val="0"/><w:vanish w:val="0"/><w:webHidden w:val="0"/><w:color w:val="000000"/><w:spacing w:val="0"/><w:w w:val="100"/><w:kern w:val="0"/><w:position w:val="0"/><w:sz w:val="24"/><w:highlight w:val="none"/><w:u w:val="none"/><w:effect w:val="none"/><w:bdr w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:vertAlign w:val="baseline"/><w:rtl w:val="0"/><w:cs w:val="0"/><w:em w:val="none"/><w:specVanish w:val="0"/>';
function listPackage(rPr) {
  const numbering = `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="Article %1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1440" w:hanging="1440"/></w:pPr><w:rPr>${rPr}</w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const item = text => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  return zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/numbering" Target="numbering.xml"/></Relationships>`,
    'word/numbering.xml': numbering,
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${item('Definitions')}${item('Term')}<w:sectPr/></w:body></w:document>`,
  }).map(([name, xml]) => [name, strToU8(xml)])));
}

it('opens a list whose number switches every font option off, as Word writes legal outlines, for editing', async () => {
  const pkg = await DocxPackage.open(listPackage(LEGAL));
  expect(pkg.readOnly).toBeFalsy();
  expect(listMarkers(pkg.paragraphs, pkg.numbering).map(m => m.text)).toEqual(['Article 1.', 'Article 2.']);
  const style = pkg.numbering.abstracts['0'].levels[0].markerStyle;
  expect(style.bold).toBe(false); expect(style.fontSize).toBe(12);
  // An edit keeps the level as authored.
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  doc.select(doc.text.length); doc.insertParagraph(); doc.replace('Scope');
  const parts = unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer()));
  expect(strFromU8(parts['word/numbering.xml'])).toContain('<w:vanish w:val="0"/>');
  const reopened = await DocxPackage.open(zipSync(parts));
  expect(listMarkers(reopened.paragraphs, reopened.numbering).map(m => m.text)).toEqual(['Article 1.', 'Article 2.', 'Article 3.']);
});

it('still opens a number that is hidden, outlined or emphasized read-only', async () => {
  for (const rPr of ['<w:vanish/>', '<w:outline/>', '<w:em w:val="dot"/>', '<w:highlight w:val="yellow"/>', '<w:bdr w:val="single" w:sz="4" w:space="0" w:color="auto"/>']) {
    await expect(DocxPackage.open(listPackage(rPr)), rPr).rejects.toThrow('Unsupported numbering symbol formatting');
  }
});
