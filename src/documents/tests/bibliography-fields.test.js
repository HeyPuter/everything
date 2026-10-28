import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';
import { BIB_NS, parseSources } from '../src/engine/bibliography.js';
import { readBibliographyPart, writeBibliographyPart, insertCitation, insertBibliography, updateCitations, updateBibliographies, citationFields, convertToText, styleOf, renameCitedTag } from '../src/engine/bibliography-fields.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const save = async (pkg, d) => new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());
const setup = async () => {
  const blank = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const pkg = await DocxPackage.open(new Uint8Array(await blank.export().arrayBuffer()));
  const d = model(pkg);
  d.replace('Engines compute. Machines learn.');
  return { pkg, d };
};
const book = { tag: 'Lov20', type: 'Book', names: { Author: [{ last: 'Lovelace', first: 'Ada' }] }, fields: { Title: 'Notes on engines', Year: '2020', Publisher: 'Harbor Press' } };
const article = { tag: 'Hop19', type: 'JournalArticle', names: { Author: [{ last: 'Hopper', first: 'Grace' }] }, fields: { Title: 'Compilers', JournalName: 'Machine Review', Year: '2019', Volume: '4', Pages: '1-9' } };

describe('citations and bibliography fields', () => {
  it('stores sources in the bibliography custom XML part and reads them back', async () => {
    const { pkg, d } = await setup();
    writeBibliographyPart(pkg.parts, { style: 'apa', styleName: 'APA', sources: [book, article] });
    const bytes = await save(pkg, d), parts = unzipSync(bytes);
    const item = Object.keys(parts).find(n => /^customXml\/item\d+\.xml$/.test(n));
    expect(strFromU8(parts[item])).toContain(`<b:Sources xmlns:b="${BIB_NS}"`);
    expect(strFromU8(parts[item])).toContain('<b:Tag>Lov20</b:Tag><b:SourceType>Book</b:SourceType>');
    expect(strFromU8(parts['word/_rels/document.xml.rels'])).toContain('relationships/customXml" Target="../customXml/item1.xml"');
    expect(strFromU8(parts['customXml/_rels/item1.xml.rels'])).toContain('customXmlProps');
    expect(strFromU8(parts['[Content_Types].xml'])).toContain('/customXml/itemProps1.xml');
    const reopened = await DocxPackage.open(bytes);
    const data = readBibliographyPart(reopened.parts).data;
    expect(data.sources.map(s => [s.tag, s.type, s.names.Author[0].last, s.fields.Title])).toEqual([['Lov20', 'Book', 'Lovelace', 'Notes on engines'], ['Hop19', 'JournalArticle', 'Hopper', 'Compilers']]);
    expect(styleOf(data)).toBe('apa');
  });

  it('inserts citations and a bibliography that update when the style changes and survive a round trip', async () => {
    const { pkg, d } = await setup();
    const sources = [book, article];
    d.select('Engines compute'.length); insertCitation(d, { tags: ['Lov20'], pages: '4' }, sources, 'apa');
    d.select(d.text.length - 1); insertCitation(d, { tags: ['Hop19'] }, sources, 'apa');
    expect(d.text).toBe('Engines compute (Lovelace, 2020, p. 4). Machines learn (Hopper, 2019).');
    d.select(d.text.length); d.replace('\n'); insertBibliography(d, sources, 'apa', { heading: 'References' });
    expect(d.text.split('\n').slice(1)).toEqual(['References', 'Hopper, G. (2019). Compilers. Machine Review, 4, 1–9.', 'Lovelace, A. (2020). Notes on engines. Harbor Press.', '']);
    const bib = d.paragraphs[3];
    expect(bib.format.indentLeft).toBe(720); expect(bib.format.firstLine).toBe(-720);
    expect(bib.runs.find(r => r.text === 'Notes on engines').italic).toBe(true);
    // Switching to IEEE renumbers citations in order and rebuilds the list.
    updateCitations(d, sources, 'ieee'); updateBibliographies(d, sources, 'ieee');
    expect(d.text.split('\n').slice(0, 4)).toEqual(['Engines compute [1, p. 4]. Machines learn [2].', 'References', '[1]\tA. Lovelace, Notes on engines. Harbor Press, 2020.', '[2]\tG. Hopper, “Compilers,” Machine Review, vol. 4, pp. 1–9, 2019.']);
    writeBibliographyPart(pkg.parts, { style: 'ieee', styleName: 'IEEE', sources });
    const bytes = await save(pkg, d), xml = strFromU8(unzipSync(bytes)['word/document.xml']);
    expect(xml).toMatch(/<w:instrText[^>]*> CITATION Lov20 \\l 1033 \\p 4 <\/w:instrText>/);
    expect(xml).toMatch(/<w:instrText[^>]*> BIBLIOGRAPHY \\l 1033 <\/w:instrText>/);
    const again = await DocxPackage.open(bytes), reopened = model(again);
    expect(reopened.text).toBe(d.text);
    expect(bodyFieldRanges(reopened.paragraphs).map(r => r.field.type)).toEqual(['CITATION', 'CITATION', 'BIBLIOGRAPHY']);
    expect(citationFields(reopened.paragraphs).map(r => r.citation.tags[0])).toEqual(['Lov20', 'Hop19']);
    // Back to APA after reopening, from the stored sources.
    const stored = readBibliographyPart(again.parts).data;
    updateCitations(reopened, stored.sources, styleOf(stored) === 'ieee' ? 'apa' : 'ieee');
    expect(reopened.text.startsWith('Engines compute (Lovelace, 2020, p. 4)')).toBe(true);
  });

  it('keeps imported sources and unknown source elements unchanged', async () => {
    const { pkg, d } = await setup();
    const part = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Sources xmlns="${BIB_NS}" SelectedStyle="custom" StyleName="House"><Source><Tag>Old01</Tag><SourceType>Book</SourceType><Title>Old book</Title><Year>2001</Year></Source></Sources>`;
    writeBibliographyPart(pkg.parts, { sources: [] });
    const path = readBibliographyPart(pkg.parts).path;
    pkg.parts[path] = strToU8(part);
    const data = readBibliographyPart(pkg.parts).data;
    expect(data.sources[0].fields.Title).toBe('Old book');
    writeBibliographyPart(pkg.parts, { ...data, sources: [...data.sources, book] });
    const written = strFromU8(pkg.parts[path]);
    expect(written).toContain(`<Source xmlns="${BIB_NS}"><Tag>Old01</Tag><SourceType>Book</SourceType><Title>Old book</Title><Year>2001</Year></Source>`);
    expect(parseSources(written).sources.map(s => s.tag)).toEqual(['Old01', 'Lov20']);
    expect(written).toContain('SelectedStyle="custom"');
  });

  it('converts a citation to static text', async () => {
    const { d } = await setup();
    d.select(0); insertCitation(d, { tags: ['Lov20'] }, [book], 'mla');
    const [range] = citationFields(d.paragraphs);
    convertToText(d, range);
    expect(bodyFieldRanges(d.paragraphs)).toEqual([]);
    expect(d.text.startsWith('(Lovelace)')).toBe(true);
  });
});

describe('updating citations keeps the caret where it was', () => {
  it('so a citation inserted after an update goes where the caret is', async () => {
    const { d } = await setup();
    const second = { ...book, tag: 'Lov20b', fields: { ...book.fields, Title: 'A sketch of the engine' } };
    d.select(0, d.text.length); d.replace('Claim one. Claim two.');
    d.select('Claim one'.length); insertCitation(d, { tags: ['Lov20'] }, [book], 'apa');
    const caret = d.text.indexOf('Claim two') + 'Claim two'.length;
    d.select(caret);
    // A second source by the same author and year turns the first citation into "2020a" or "2020b".
    expect(updateCitations(d, [book, second], 'apa')).toBe(1);
    expect(d.text).toMatch(/^Claim one \(Lovelace, 2020[ab]\)\. Claim two\.$/);
    expect(d.range).toEqual([caret + 1, caret + 1]);
    insertCitation(d, { tags: ['Lov20b'] }, [book, second], 'apa');
    expect(d.text).toMatch(/^Claim one \(Lovelace, 2020[ab]\)\. Claim two \(Lovelace, 2020[ab]\)\.$/);
  });
});

describe('changing a cited source\'s tag', () => {
  it('points its citations, including those that cite several sources, at the new tag', async () => {
    const { pkg, d } = await setup();
    d.select(7); insertCitation(d, { tags: ['Lov20'], pages: '4' }, [book, article], 'apa');
    d.select(d.text.length); insertCitation(d, { tags: ['Hop19', 'lov20'] }, [book, article], 'apa');
    const renamed = { ...book, tag: 'Ada2020' };
    expect(renameCitedTag(d, 'Lov20', 'Ada2020')).toBe(2);
    expect(citationFields(d.paragraphs).map(r => r.citation.tags)).toEqual([['Ada2020'], ['Hop19', 'Ada2020']]);
    expect(citationFields(d.paragraphs)[0].citation.pages).toBe('4');
    updateCitations(d, [renamed, article], 'apa');
    expect(d.text).toContain('(Lovelace, 2020, p. 4)');
    expect(d.text).toContain('(Hopper, 2019; Lovelace, 2020)');
    expect(strFromU8(unzipSync(await save(pkg, d))['word/document.xml'])).not.toContain('Lov20');
  });

  it('puts a citation inserted with the caret inside another citation after it, not inside its result', async () => {
    const { d } = await setup();
    d.select(d.text.indexOf('.')); insertCitation(d, { tags: ['Lov20'] }, [book, article], 'apa');
    const first = citationFields(d.paragraphs)[0];
    d.select(first.start + 3);
    insertCitation(d, { tags: ['Hop19'] }, [book, article], 'apa');
    expect(d.text).toBe('Engines compute (Lovelace, 2020) (Hopper, 2019). Machines learn.');
    expect(citationFields(d.paragraphs).map(r => [r.citation.tags, r.parentId ?? null])).toEqual([[['Lov20'], null], [['Hop19'], null]]);
    // Refreshing keeps both.
    updateCitations(d, [book, article], 'apa');
    expect(d.text).toBe('Engines compute (Lovelace, 2020) (Hopper, 2019). Machines learn.');
  });
});

