// Opening reuses work it used to repeat: each distinct numbering level is read once,
// relationships are parsed once, and body paragraph sources are serialized on demand.
// These check that the reuse never shares state or changes what is read or saved.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { serializeFragment, deferredFragment } from '../src/engine/docx-compatibility.js';
import { childElement, childElements, elementChildren } from '../src/engine/docx-xml.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const level = (ilvl, extra = '') => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${ilvl + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="${720 * (ilvl + 1)}"/></w:tabs><w:ind w:left="${720 * (ilvl + 1)}" w:hanging="360"/>${extra}</w:pPr><w:rPr><w:b/></w:rPr></w:lvl>`;
function docx({ numbering, body, rels = '' }) {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/_rels/document.xml.rels': strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${rels}</Relationships>`),
    'word/numbering.xml': strToU8(`<w:numbering xmlns:w="${W}">${numbering}</w:numbering>`),
    'word/document.xml': strToU8(`<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`),
  });
}
const listParagraph = (numId, text) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;

it('gives repeated numbering levels equal but separate readings', async () => {
  const levels = level(0) + level(1);
  const pkg = await DocxPackage.open(docx({
    numbering: `<w:abstractNum w:abstractNumId="1">${levels}</w:abstractNum><w:abstractNum w:abstractNumId="2">${levels}</w:abstractNum>`
      + `<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="2"/><w:lvlOverride w:ilvl="0">${level(0)}</w:lvlOverride></w:num>`,
    body: listParagraph(1, 'One') + listParagraph(2, 'Two'),
  }));
  const [first, second] = [pkg.numbering.abstracts[1].levels, pkg.numbering.abstracts[2].levels];
  expect(second).toEqual(first);
  expect(first[0].geometry).toEqual({ indentLeft: 720, firstLine: -360, tabs: [{ position: 720, alignment: 'left', leader: 'none', numberingOnly: true }] });
  expect(first[0].markerStyle.bold).toBe(true);
  expect(second[0]).not.toBe(first[0]);
  expect(second[0].geometry.tabs).not.toBe(first[0].geometry.tabs);
  // The override reads the same markup; its later count adjustment touches only itself.
  const override = pkg.numbering.instances[2].overrides[0].level;
  expect(override.restartStart).toBe(1);
  expect(first[0].restartStart).toBeUndefined();
  first[0].geometry.tabs.push({ position: 1 });
  expect(second[0].geometry.tabs).toHaveLength(1);
  expect(override.geometry.tabs).toHaveLength(1);
});

it('reports an unsupported property of a repeated level and still reads every copy', async () => {
  const odd = level(0, '<w:snapToGrid w:val="0"/>');
  const bytes = docx({
    numbering: `<w:abstractNum w:abstractNumId="1">${odd}</w:abstractNum><w:abstractNum w:abstractNumId="2">${odd}</w:abstractNum>`
      + '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>',
    body: listParagraph(1, 'One') + listParagraph(2, 'Two'),
  });
  await expect(DocxPackage.open(bytes)).rejects.toThrow('Unsupported numbering paragraph property: snapToGrid.');
  const pkg = await DocxPackage.open(bytes, { bestEffort: true });
  expect(pkg.readOnly).toBe(true);
  expect(pkg.previewIssues).toContain('Unsupported numbering paragraph property: snapToGrid.');
  const [first, second] = [pkg.numbering.abstracts[1].levels[0], pkg.numbering.abstracts[2].levels[0]];
  expect(first.geometry.indentLeft).toBe(720);
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
});

it('reads hyperlinks through the shared relationship index and keeps saving unchanged paragraphs as they were', async () => {
  const link = (id, text) => `<w:p><w:hyperlink r:id="${id}"><w:r><w:t>${text}</w:t></w:r></w:hyperlink></w:p>`;
  const bytes = docx({
    numbering: '',
    rels: '<Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/a" TargetMode="External"/>'
      + '<Relationship Id="rB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/b" TargetMode="External"/>'
      + '<Relationship Id="rB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/c" TargetMode="External"/>',
    body: link('rA', 'First') + link('rA', 'Again') + '<w:p w:rsidR="00AB12CD"><w:r><w:t xml:space="preserve">Kept  as written</w:t></w:r></w:p>',
  });
  const pkg = await DocxPackage.open(bytes);
  expect(pkg.paragraphs.slice(0, 2).map(p => p.runs[0].link.target)).toEqual(['https://example.com/a', 'https://example.com/a']);
  // A duplicate relationship ID is still ambiguous.
  const ambiguous = docx({ numbering: '', rels: strFromU8(unzipSync(bytes)['word/_rels/document.xml.rels']).replace(/^.*?<Relationship Id="rNum"[^>]*\/>/, '').replace('</Relationships>', ''), body: link('rB', 'Which') });
  await expect(DocxPackage.open(ambiguous)).rejects.toThrow(/hyperlink relationship/);
  const edited = structuredClone(pkg.paragraphs);
  edited[0].runs[0].text += '!';
  const saved = strFromU8(pkg.exportBodyParts(edited)['word/document.xml']);
  expect(saved).toContain('<w:p w:rsidR="00AB12CD"><w:r><w:t xml:space="preserve">Kept  as written</w:t></w:r></w:p>');
  expect(saved).toContain('First!');
});

it('serializes a deferred fragment exactly as it was when taken', () => {
  const doc = new DOMParser().parseFromString(`<w:document xmlns:w="${W}" xmlns:o="urn:other" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="o"><w:body><w:p o:attr="1"><w:r><w:t>Text</w:t></w:r></w:p></w:body></w:document>`, 'application/xml');
  const p = doc.getElementsByTagNameNS(W, 'p')[0], expected = serializeFragment(p);
  const later = deferredFragment(p);
  p.firstElementChild.remove();
  doc.documentElement.removeAttribute('xmlns:o');
  doc.documentElement.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:x', 'urn:x');
  expect(expected).toContain('xmlns:o="urn:other"');
  expect(later()).toBe(expected);
  expect(later()).toBe(expected);
  expect(serializeFragment(p)).not.toBe(expected);
});

it('lists element children as the collection does', () => {
  const doc = new DOMParser().parseFromString(`<a xmlns:w="${W}"> <w:b/>text<w:c/><!-- x --><w:b n="2"/><other/></a>`, 'application/xml');
  const root = doc.documentElement;
  expect(elementChildren(root)).toEqual([...root.children]);
  expect(elementChildren(doc)).toEqual([...doc.children]);
  expect(childElement(root, W, 'b')).toBe(root.children[0]);
  expect(childElement(root, W, 'missing')).toBeUndefined();
  expect(childElements(root, W, 'b')).toEqual([root.children[0], root.children[2]]);
  expect(childElements(null, W, 'b')).toEqual([]);
  expect(childElements(root.firstChild, W, 'b')).toEqual([]);
  expect(() => elementChildren(root.firstChild)).toThrow(TypeError);
});
