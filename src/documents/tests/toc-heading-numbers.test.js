import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraphText } from '../src/engine/model.js';
import { insertTableOfContents, tableOfContents } from '../src/engine/toc.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const relationship = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const p = (text, properties = '') => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
// Headings numbered by an outline list their styles link to (I., 1.1 with isLgl), one heading numbered with a space after it,
// and a bulleted heading.
const level = (ilvl, format, text, extra = '') => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>${extra}<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${432 + ilvl * 144}" w:hanging="${432 + ilvl * 144}"/></w:pPr></w:lvl>`;
const numbering = `<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/>${level(0, 'upperRoman', '%1.', '<w:pStyle w:val="Heading1"/>')}${level(1, 'lowerLetter', '%1.%2', '<w:pStyle w:val="Heading2"/><w:isLgl/>')}${level(2, 'decimal', '(%3)', '<w:suff w:val="space"/>')}</w:abstractNum>`
  + `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum>`
  + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>';
const heading = (id, name, outline, ilvl) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr>${ilvl ? `<w:ilvl w:val="${ilvl}"/>` : ''}<w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="${outline}"/></w:pPr></w:style>`;
const styles = `<w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${heading('Heading1', 'heading 1', 0, 0)}${heading('Heading2', 'heading 2', 1, 1)}`
  + `<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style></w:styles>`;
const body = [p('Introduction', '<w:pStyle w:val="Heading1"/>'), p('Scope', '<w:pStyle w:val="Heading2"/>'), p('Body text'),
  p('Detail', '<w:pStyle w:val="Heading3"/><w:numPr><w:ilvl w:val="2"/><w:numId w:val="1"/></w:numPr>'), p('Plain heading', '<w:pStyle w:val="Heading3"/>'),
  p('Methods', '<w:pStyle w:val="Heading1"/>'), p('Bulleted', '<w:pStyle w:val="Heading3"/><w:numPr><w:numId w:val="2"/></w:numPr>'), p('')].join('');
const source = () => zipSync(Object.fromEntries(Object.entries({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
  '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship('rId1', 'officeDocument', 'word/document.xml')}</Relationships>`,
  'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship('rId1', 'styles', 'styles.xml')}${relationship('rId2', 'numbering', 'numbering.xml')}</Relationships>`,
  'word/document.xml': `<w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  'word/styles.xml': styles, 'word/numbering.xml': numbering,
}).map(([name, xml]) => [name, strToU8(xml)])));
const open = async bytes => { const pkg = await DocxPackage.open(bytes); return { pkg, d: new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets) }; };

// A table of contents left out the numbers of numbered headings: "Introduction 1" where Word lists "I.  Introduction 1".
it('starts the entries of numbered headings with their numbers, as Word lists them', async () => {
  const { pkg, d } = await open(source());
  d.select(d.text.length);
  insertTableOfContents(d);
  const toc = tableOfContents(d.paragraphs);
  const entries = d.paragraphs.slice(toc.first, toc.last + 1);
  // isLgl shows level 2 in Arabic numerals; a level followed by a space keeps the space; bullets and unnumbered headings have no number.
  expect(entries.map(paragraphText)).toEqual(['I.\tIntroduction\t1', '1.1\tScope\t1', '(1) Detail\t1', 'Plain heading\t1', 'II.\tMethods\t1', 'Bulleted\t1']);
  // The tab after a number has a stop of its own, before the page number's.
  expect(entries[0].format.tabs).toEqual([{ position: 440, alignment: 'left' }, { position: 9360, alignment: 'right', leader: 'dot' }]);
  expect(entries[1].format.tabs).toEqual([{ position: 880, alignment: 'left' }, { position: 9360, alignment: 'right', leader: 'dot' }]);
  expect(entries[2].format.tabs).toEqual([{ position: 9360, alignment: 'right', leader: 'dot' }]);
  // The whole entry, number included, links to its heading.
  expect(entries[0].runs.every(r => r.link?.anchor === entries[0].runs[0].link.anchor)).toBe(true);
  const saved = new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());
  const xml = strFromU8(unzipSync(saved)['word/document.xml']);
  expect(xml).toContain('<w:tab w:val="left" w:pos="440"/>');
  const again = await open(saved);
  expect(again.d.text).toBe(d.text);
  // A rebuild after the headings change renumbers the entries.
  d.select(d.text.indexOf('Introduction')); d.replace('\n');
  d.select(d.text.indexOf('Introduction') - 1); d.replace('Background');
  d.select(d.text.indexOf('Background')); d.setParagraphStyle('Heading1');
  insertTableOfContents(d, { existing: tableOfContents(d.paragraphs) });
  const rebuilt = tableOfContents(d.paragraphs);
  expect(d.paragraphs.slice(rebuilt.first, rebuilt.last + 1).map(paragraphText).slice(0, 3)).toEqual(['I.\tBackground\t1', 'II.\tIntroduction\t1', '2.1\tScope\t1']);
});
