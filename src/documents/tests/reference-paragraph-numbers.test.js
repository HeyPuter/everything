import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';
import { updateSequenceFields } from '../src/engine/field-update.js';
import { moveOutlineSection } from '../src/engine/outline-editing.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const relationship = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const t = text => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const p = (body, properties = '') => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${body}</w:p>`;
const marked = (id, name, text) => `<w:bookmarkStart w:id="${id}" w:name="${name}"/>${t(text)}<w:bookmarkEnd w:id="${id}"/>`;
const ref = (instruction, cached) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instruction} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${t(cached)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
const level = (ilvl, format, text, style = '') => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>${style ? `<w:pStyle w:val="${style}"/>` : ''}<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${432 + ilvl * 144}" w:hanging="432"/></w:pPr></w:lvl>`;
// Headings numbered "1." and "1.1" through their styles; a list numbered "1." and "a)", whose second level does not write the first.
const numbering = `<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/>${level(0, 'decimal', '%1.', 'Heading1')}${level(1, 'decimal', '%1.%2', 'Heading2')}</w:abstractNum>`
  + `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="multilevel"/>${level(0, 'decimal', '%1.')}${level(1, 'lowerLetter', '%2)')}</w:abstractNum>`
  + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>';
const heading = (id, name, outline, ilvl) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr>${ilvl ? `<w:ilvl w:val="${ilvl}"/>` : ''}<w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="${outline}"/></w:pPr></w:style>`;
const styles = `<w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${heading('Heading1', 'heading 1', 0, 0)}${heading('Heading2', 'heading 2', 1, 1)}</w:styles>`;
const item = (ilvl, body) => p(body, `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="2"/></w:numPr>`);
const body = [
  p(t('Introduction'), '<w:pStyle w:val="Heading1"/>'),
  p(t('See section ') + ref('REF _Ref1 \\r \\h', '9.9') + t(', ') + ref('REF _Ref1 \\n', '9.9') + t(', ') + ref('REF _Ref1 \\w \\* MERGEFORMAT', '9.9') + t(' and step ') + ref('REF _Ref2 \\n \\h', 'z)') + t('/') + ref('REF _Ref2 \\w', 'kept') + t('/') + ref('REF _Ref1 \\n \\t', 'kept') + t('/') + ref('REF _Ref3 \\n', 'kept') + t('.')),
  p(t('Methods'), '<w:pStyle w:val="Heading1"/>'),
  p(marked(1, '_Ref1', 'Sampling'), '<w:pStyle w:val="Heading2"/>'),
  item(0, t('First step')), item(1, marked(2, '_Ref2', 'Detail')), p(marked(3, '_Ref3', 'Plain text')),
  p(t('Results'), '<w:pStyle w:val="Heading1"/>'), p(t('End')),
].join('');
const source = () => zipSync(Object.fromEntries(Object.entries({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
  '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship('rId1', 'officeDocument', 'word/document.xml')}</Relationships>`,
  'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship('rId1', 'styles', 'styles.xml')}${relationship('rId2', 'numbering', 'numbering.xml')}</Relationships>`,
  'word/document.xml': `<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
  'word/styles.xml': styles, 'word/numbering.xml': numbering,
}).map(([name, xml]) => [name, strToU8(xml)])));
const open = async bytes => { const pkg = await DocxPackage.open(bytes); return { pkg, d: new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets) }; };
const results = d => bodyFieldRanges(d.paragraphs).map(r => d.text.slice(r.start, r.end));

// Cross-references to a heading's number (REF \r, \n, \w: "see section 2.1") kept whatever they showed: after the
// sections were reordered, Update Fields left "see section 2.1" pointing at what had become 1.1.
it('updates references to heading and list item numbers, as Word does', async () => {
  const { pkg, d } = await open(source());
  const issues = [];
  updateSequenceFields(d, { onIssue: issue => issues.push(issue.message) });
  // A number without its trailing period; a level that does not write the levels above it ("a)") is shown alone for
  // \n and kept for \w; \t and an unnumbered paragraph are kept.
  expect(results(d)).toEqual(['2.1', '2.1', '2.1', 'a)', 'kept', 'kept', 'kept']);
  expect(issues).toHaveLength(3);
  // Methods moves before Introduction in the Navigation pane: its subsection becomes 1.1.
  const methods = d.paragraphs.find(q => q.runs.map(r => r.text).join('') === 'Methods');
  expect(moveOutlineSection(d, methods.id, d.paragraphs[0].id, 'before')).toBe(true);
  updateSequenceFields(d, { onIssue: () => {} });
  expect(results(d)).toEqual(['1.1', '1.1', '1.1', 'a)', 'kept', 'kept', 'kept']);
  const saved = new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());
  expect(strFromU8(unzipSync(saved)['word/document.xml'])).toContain('REF _Ref1 \\r \\h');
  expect(results((await open(saved)).d)).toEqual(['1.1', '1.1', '1.1', 'a)', 'kept', 'kept', 'kept']);
});
