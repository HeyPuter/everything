import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { listMarkers } from '../src/engine/numbering.js';
import { outlineEntries } from '../src/engine/outline.js';
import { setOutlineLevels, promotedLevel, demotedLevel } from '../src/engine/outline-editing.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const relationship = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const p = (text, properties = '') => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
// An outline list whose first two levels are linked to Heading 1 and Heading 2 (§17.9.23 pStyle), and whose third is not.
const level = (ilvl, text, style = '') => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="decimal"/>${style ? `<w:pStyle w:val="${style}"/>` : ''}<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${432 + ilvl * 144}" w:hanging="${432 + ilvl * 144}"/></w:pPr></w:lvl>`;
const numbering = `<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/>${level(0, '%1', 'Heading1')}${level(1, '%1.%2', 'Heading2')}${level(2, '%1.%2.%3')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
const heading = (id, name, outline, ilvl) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:numPr>${ilvl ? `<w:ilvl w:val="${ilvl}"/>` : ''}<w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="${outline}"/></w:pPr><w:rPr><w:sz w:val="${32 - 4 * outline}"/></w:rPr></w:style>`;
const styles = `<w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${heading('Heading1', 'heading 1', 0, 0)}${heading('Heading2', 'heading 2', 1, 1)}</w:styles>`;
const body = [p('Introduction', '<w:pStyle w:val="Heading1"/>'), p('Background', '<w:pStyle w:val="Heading1"/>'), p('Prior work', '<w:pStyle w:val="Heading2"/>'),
  p('Detail', '<w:pStyle w:val="Heading2"/><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr>'), p('Text')].join('');
const source = () => zipSync(Object.fromEntries(Object.entries({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
  '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship('rId1', 'officeDocument', 'word/document.xml')}</Relationships>`,
  'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship('rId1', 'styles', 'styles.xml')}${relationship('rId2', 'numbering', 'numbering.xml')}</Relationships>`,
  'word/document.xml': `<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
  'word/styles.xml': styles, 'word/numbering.xml': numbering,
}).map(([name, xml]) => [name, strToU8(xml)])));
const open = async bytes => { const pkg = await DocxPackage.open(bytes); return { pkg, d: new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets) }; };
const numbers = d => listMarkers(d.paragraphs, d.numbering).map(m => m?.text ?? null);
const levels = d => outlineEntries(d.paragraphs).map(e => [e.text, e.level]);

// Tab at the start of a numbered Heading 1 gave it a level-2 number but left it a Heading 1: still a
// top-level heading in the Navigation pane and the table of contents, in Heading 1's look.
it('moves a heading to the style linked to its new list level, as Tab and Shift+Tab do in Word', async () => {
  const { pkg, d } = await open(source());
  expect(numbers(d)).toEqual(['1', '2', '2.1', '2.2', null]);
  d.select(d.text.indexOf('Background'));
  expect(d.changeListLevel(1)).toBe(true);
  expect(d.paragraphs[1].styleId).toBe('Heading2');
  expect(d.paragraphs[1].list).toMatchObject({ numId: '1', level: 1, direct: false });
  expect(d.paragraphs[1].runs[0].fontSize).toBe(14);
  expect(numbers(d)).toEqual(['1', '1.1', '1.2', '1.3', null]);
  expect(levels(d)).toEqual([['Introduction', 1], ['Background', 2], ['Prior work', 2], ['Detail', 2]]);
  // Saved as Word saves it: the style, with the numbering it brings, and no direct numbering.
  const saved = new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());
  const xml = strFromU8(unzipSync(saved)['word/document.xml']);
  const background = xml.slice(xml.lastIndexOf('<w:p>', xml.indexOf('Background')), xml.indexOf('Background'));
  expect(background).toContain('<w:pStyle w:val="Heading2"/>');
  expect(background).not.toContain('<w:numPr>');
  expect(numbers((await open(saved)).d)).toEqual(['1', '1.1', '1.2', '1.3', null]);
  d.undo();
  expect(d.paragraphs[1].styleId).toBe('Heading1');
  expect(numbers(d)).toEqual(['1', '2', '2.1', '2.2', null]);
  // Shift+Tab on a Heading 2 with numbering of its own: Heading 1, keeping its direct numbering at the new level.
  d.select(d.text.indexOf('Detail'));
  expect(d.changeListLevel(-1)).toBe(true);
  expect(d.paragraphs[3].styleId).toBe('Heading1');
  expect(d.paragraphs[3].list).toMatchObject({ numId: '1', level: 0 });
  expect(numbers(d)).toEqual(['1', '2', '2.1', '3', null]);
  // Level 3 is linked to no style: the heading keeps its style and only its number changes.
  d.select(d.text.indexOf('Prior work'));
  expect(d.changeListLevel(1)).toBe(true);
  expect(d.paragraphs[2].styleId).toBe('Heading2');
  expect(d.paragraphs[2].list).toMatchObject({ level: 2, direct: true });
});

// Promote and Demote in the Navigation pane and Outline view give a heading the next style up or down. A heading
// with numbering of its own (a direct numPr at the level linked to its style, as Word writes when a multilevel list
// is applied to headings) kept its old list level: promoted to Heading 1, "2.2 Detail" stayed numbered 2.2.
it('promotes and demotes a heading with its own numbering to the list level linked to its new style', async () => {
  const { pkg, d } = await open(source());
  const detail = d.paragraphs[3];
  expect(setOutlineLevels(d, [detail.id], promotedLevel, { withSubtree: true })).toBe(true);
  expect(d.paragraphs[3].styleId).toBe('Heading1');
  expect(d.paragraphs[3].list).toMatchObject({ numId: '1', level: 0, direct: true });
  expect(numbers(d)).toEqual(['1', '2', '2.1', '3', null]);
  expect(levels(d)).toEqual([['Introduction', 1], ['Background', 1], ['Prior work', 2], ['Detail', 1]]);
  const saved = new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());
  expect(numbers((await open(saved)).d)).toEqual(['1', '2', '2.1', '3', null]);
  d.undo();
  expect(numbers(d)).toEqual(['1', '2', '2.1', '2.2', null]);
  expect(d.paragraphs[3].styleId).toBe('Heading2');
  // Demoted back from Heading 1, it returns to level 2.
  setOutlineLevels(d, [detail.id], promotedLevel);
  setOutlineLevels(d, [d.paragraphs[3].id], demotedLevel);
  expect(d.paragraphs[3]).toMatchObject({ styleId: 'Heading2', list: { level: 1 } });
  expect(numbers(d)).toEqual(['1', '2', '2.1', '2.2', null]);
  // To body text: the heading keeps its numbering, as the paragraph's own; no style is linked to it.
  setOutlineLevels(d, [d.paragraphs[3].id], () => 10);
  expect(d.paragraphs[3].list).toMatchObject({ level: 1 });
});
