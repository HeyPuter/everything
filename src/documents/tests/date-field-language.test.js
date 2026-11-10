import { beforeAll, afterAll, afterEach, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { formatDatePicture } from '../src/engine/field-results.js';
import { updateSequenceFields } from '../src/engine/field-update.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
afterEach(() => vi.useRealTimers());

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const relationship = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const run = (body, language) => `<w:r>${language ? `<w:rPr><w:lang w:val="${language}"/></w:rPr>` : ''}${body}</w:r>`;
// A complex DATE field whose runs carry a language, or whose language comes from the document defaults.
const dateField = (picture, cached, language) => `<w:p>${run('<w:fldChar w:fldCharType="begin"/>', language)}${run(`<w:instrText xml:space="preserve"> DATE \\@ "${picture}" </w:instrText>`, language)}${run('<w:fldChar w:fldCharType="separate"/>', language)}${run(`<w:t>${cached}</w:t>`, language)}${run('<w:fldChar w:fldCharType="end"/>', language)}</w:p>`;
const source = (body, defaultLanguage = 'en-US') => zipSync(Object.fromEntries(Object.entries({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
  '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship('rId1', 'officeDocument', 'word/document.xml')}</Relationships>`,
  'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship('rId1', 'styles', 'styles.xml')}</Relationships>`,
  'word/document.xml': `<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
  'word/styles.xml': `<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:lang w:val="${defaultLanguage}"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
}).map(([name, xml]) => [name, strToU8(xml)])));
const open = async bytes => { const pkg = await DocxPackage.open(bytes); return { pkg, d: new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets) }; };
const results = d => bodyFieldRanges(d.paragraphs).map(r => d.text.slice(r.start, r.end));

it('names months and days in the given language, and in English without one', () => {
  const date = new Date(2026, 2, 3, 9, 5); // Tuesday, 3 March 2026
  expect(formatDatePicture(date, 'dddd, d. MMMM yyyy', 'de-DE')).toBe('Dienstag, 3. März 2026');
  expect(formatDatePicture(date, 'd MMMM yyyy', 'fr-FR')).toBe('3 mars 2026');
  // A month beside a day number takes the form used in dates; alone, its own form.
  expect(formatDatePicture(date, 'd MMMM yyyy', 'ru-RU')).toBe('3 марта 2026');
  expect(formatDatePicture(date, 'MMMM yyyy', 'ru-RU')).toBe('март 2026');
  expect(formatDatePicture(date, 'dddd d MMMM', 'es-ES')).toBe('martes 3 marzo');
  // English, or no language, as before.
  expect(formatDatePicture(date, 'dddd, MMMM d, yyyy', 'en-GB')).toBe('Tuesday, March 3, 2026');
  expect(formatDatePicture(date, 'ddd d MMM yy', null)).toBe('Tue 3 Mar 26');
  // A tag the browser does not know falls back to English names.
  expect(formatDatePicture(date, 'MMMM', 'not a language')).toBe('March');
  // Literal text is not read as a day.
  expect(formatDatePicture(date, "'d' MMMM", 'ru-RU')).toBe('d март');
});

// Update Fields rewrote a German date in English: "3. März 2026" became "3. March 2026".
it('updates a date field in the language of its text, as Word does', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 2, 3, 12, 0));
  const body = dateField('d. MMMM yyyy', '1. Februar 2026', 'de-DE') + dateField('dddd d MMMM', 'lundi 2 février', null) + dateField('MMMM d, yyyy', 'February 1, 2026', 'en-US');
  // The second field takes the document's default language (French).
  const { pkg, d } = await open(source(body, 'fr-FR'));
  expect(updateSequenceFields(d)).toBe(3);
  expect(results(d)).toEqual(['3. März 2026', 'mardi 3 mars', 'March 3, 2026']);
  const saved = new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());
  expect(strFromU8(unzipSync(saved)['word/document.xml'])).toContain('>3. März 2026<');
});
