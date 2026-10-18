import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { pageLookup } from '../src/engine/page-lookup.js';
import { parseEntry, entryInstruction, markEntry, markAllEntries, writeIndex, indexFields, parseIndexInstruction, indexInstruction } from '../src/engine/index-entries.js';
import { insertCaption } from '../src/engine/captions.js';
import { updateSequenceFields } from '../src/engine/field-update.js';
import { parseAuthority, markAuthority, markAllAuthorities, writeTableOfAuthorities, tableFields, authorities } from '../src/engine/authorities.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const measure = (text, style) => ({ width: text.length * style.fontSize * .6, ascent: style.fontSize * .8, descent: style.fontSize * .2 });
const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const save = async (pkg, d) => new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());
const pages = (pkg, d) => pageLookup(layoutDocument(d.paragraphs, measure, pageGeometry(d.pageSettings), d.numbering, d.tables, pkg.pageStories, { styles: d.styles }), pkg.pageStories);
async function setup(text) {
  const blank = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const pkg = await DocxPackage.open(new Uint8Array(await blank.export().arrayBuffer()));
  const d = model(pkg); d.replace(text);
  return { pkg, d };
}

describe('index entries and generated indexes', () => {
  it('marks an entry at the start of a field beside that field, so its numbering still updates', async () => {
    const { pkg, d } = await setup('A\nB\nC');
    for (const [at, text] of [['A', 'One'], ['B', 'Two'], ['C', 'Three']]) { d.select(d.text.indexOf(at)); insertCaption(d, { label: 'Figure', text }); }
    // The selection ends where the second caption's number field starts.
    const s = d.text.indexOf('Figure 2');
    d.select(s, s + 'Figure '.length);
    markEntry(d, { main: 'Figure' });
    d.select(s + 'Figure 2: Two\nFigure 3'.length - 1);
    markAuthority(d, { long: 'Smith v. Jones', category: 1 });
    expect(bodyFieldRanges(d.paragraphs).filter(r => ['XE', 'TA'].includes(r.field.type)).map(r => r.parentId || null)).toEqual([null, null]);
    const reopened = model(await DocxPackage.open(await save(pkg, d)));
    expect(bodyFieldRanges(reopened.paragraphs).filter(r => r.parentId).map(r => r.field.type)).toEqual([]);
    for (const doc of [d, reopened]) {
      const a = doc.text.indexOf('Figure 1: One');
      doc.select(a, a + 'Figure 1: One'.length + 1); doc.replace('');
      updateSequenceFields(doc);
      expect(doc.text).toContain('Figure 1: Two');
      expect(doc.text).toContain('Figure 2: Three');
    }
  });

  it('parses and writes XE instructions with levels, escapes and switches', () => {
    const instruction = entryInstruction({ main: 'Ratio: golden', sub: 'proof', bold: true, crossReference: 'See also Fibonacci' });
    expect(instruction).toBe(' XE "Ratio\\\\: golden:proof" \\t "See also Fibonacci" \\b ');
    expect(parseEntry(instruction)).toMatchObject({ levels: ['Ratio: golden', 'proof'], bold: true, crossReference: 'See also Fibonacci' });
    expect(parseIndexInstruction(indexInstruction({ headings: 'A', rightAlign: true, columns: 2 }))).toMatchObject({ headings: 'A', rightAlign: true, columns: 2, entrySeparator: '\t' });
  });

  it('marks entries, generates an indexed list with pages, letter headings and subentries, and round-trips', async () => {
    const { pkg, d } = await setup('Apples grow on trees.\fBananas are yellow. Apples are red.\fCherries are small.\nIndex:\n');
    const mark = (word, options) => { const at = d.text.indexOf(word); d.select(at, at + word.length); markEntry(d, options); };
    mark('Apples', { main: 'Apple' });
    mark('Bananas', { main: 'Banana', bold: true });
    mark('Cherries', { main: 'Fruit', sub: 'cherry' });
    const second = d.text.indexOf('Apples are'); d.select(second, second + 6); markEntry(d, { main: 'Apple' });
    expect(bodyFieldRanges(d.paragraphs).filter(r => r.field.type === 'XE')).toHaveLength(4);
    expect(d.text).toBe('Apples grow on trees.\fBananas are yellow. Apples are red.\fCherries are small.\nIndex:\n');
    d.select(d.text.length);
    writeIndex(d, { options: parseIndexInstruction(indexInstruction({ headings: 'A' })), pageOf: pages(pkg, d) });
    const lines = d.text.split('\n');
    expect(lines.slice(lines.indexOf('Index:') + 1, -1)).toEqual(['A', 'Apple, 1, 2', 'B', 'Banana, 2', 'F', 'Fruit', 'cherry, 3']);
    const banana = d.paragraphs.find(p => p.runs.map(r => r.text).join('') === 'Banana, 2');
    expect(banana.runs.find(r => r.text === '2').bold).toBe(true);
    const bytes = await save(pkg, d), xml = strFromU8(unzipSync(bytes)['word/document.xml']);
    expect(xml).toMatch(/<w:instrText[^>]*> XE "Apple" <\/w:instrText><\/w:r><w:r><w:fldChar w:fldCharType="end"\/>/);
    expect(xml).toMatch(/<w:instrText[^>]*> INDEX \\h "A" \\c "1" \\z "1033" <\/w:instrText>/);
    const again = model(await DocxPackage.open(bytes));
    expect(again.text).toBe(d.text);
    expect(bodyFieldRanges(again.paragraphs).map(r => r.field.type)).toEqual(['XE', 'XE', 'XE', 'XE', 'INDEX']);
    // Rebuild after a new entry: the index updates in place.
    const at = again.text.indexOf('small'); again.select(at, at + 5); markEntry(again, { main: 'Size' });
    writeIndex(again, { existing: indexFields(again.paragraphs)[0], pageOf: pages(pkg, again) });
    expect(again.text).toContain('S\nSize, 3');
    again.undo(); again.undo();
  });

  it('marks every occurrence, run-in subentries and right-aligned pages', async () => {
    const { pkg, d } = await setup('Mercury and Venus. Mercury again.\nOther: mercury lower.\n');
    d.select(0, 7);
    expect(markAllEntries(d, 'Mercury', { main: 'Mercury', sub: 'planet' })).toBe(2);
    d.select(d.text.length);
    writeIndex(d, { options: parseIndexInstruction(indexInstruction({ runIn: true, rightAlign: true })), pageOf: pages(pkg, d) });
    expect(d.text.split('\n').at(-2)).toBe('Mercury: planet\t1');
    const row = d.paragraphs.find(p => p.runs.map(r => r.text).join('') === 'Mercury: planet\t1');
    expect(row.format.tabs[0]).toMatchObject({ alignment: 'right', leader: 'dot' });
  });
});

describe('tables of authorities', () => {
  it('marks citations, lists each category with pages and passim, and round-trips', async () => {
    const pagesText = Array.from({ length: 6 }, (_, i) => `Page ${i + 1} cites Roe v. Wade.`).join('\f');
    const { pkg, d } = await setup(`Brown v. Board of Education, 347 U.S. 483 (1954), is cited first.\f${pagesText}\fThe statute 42 U.S.C. § 1983 applies.\n`);
    const select = text => { const at = d.text.indexOf(text); d.select(at, at + text.length); };
    select('Brown v. Board of Education, 347 U.S. 483 (1954)'); markAuthority(d, { long: 'Brown v. Board of Education, 347 U.S. 483 (1954)', short: 'Brown v. Board of Education', category: 1 });
    select('Roe v. Wade'); expect(markAllAuthorities(d, { long: 'Roe v. Wade, 410 U.S. 113 (1973)', short: 'Roe v. Wade', category: 1, italic: true })).toBe(6);
    select('42 U.S.C. § 1983'); markAuthority(d, { long: '42 U.S.C. § 1983', short: '42 U.S.C. § 1983', category: 2 });
    expect(authorities(d.paragraphs).map(a => [a.long, a.marks.length])).toEqual([['Brown v. Board of Education, 347 U.S. 483 (1954)', 1], ['Roe v. Wade, 410 U.S. 113 (1973)', 6], ['42 U.S.C. § 1983', 1]]);
    expect(parseAuthority(bodyFieldRanges(d.paragraphs).find(r => r.field.type === 'TA').field.instruction)).toMatchObject({ long: 'Brown v. Board of Education, 347 U.S. 483 (1954)', category: 1 });
    d.select(d.text.length);
    writeTableOfAuthorities(d, { options: { category: 1, passim: true, headings: true, keepFormatting: true, entrySeparator: '\t', pageSeparator: ', ', extra: [] }, pageOf: pages(pkg, d) });
    const tail = d.text.split('\n').slice(-4, -1);
    expect(tail).toEqual(['Cases', 'Brown v. Board of Education, 347 U.S. 483 (1954)\t1', 'Roe v. Wade, 410 U.S. 113 (1973)\tpassim']);
    const bytes = await save(pkg, d), xml = strFromU8(unzipSync(bytes)['word/document.xml']);
    expect(xml).toMatch(/<w:instrText[^>]*> TA \\l "Brown v\. Board of Education, 347 U\.S\. 483 \(1954\)" \\s "Brown v\. Board of Education" \\c 1 <\/w:instrText><\/w:r><w:r><w:fldChar w:fldCharType="end"\/>/);
    expect(xml).toMatch(/<w:instrText[^>]*> TOA \\h \\c "1" \\p <\/w:instrText>/);
    const again = model(await DocxPackage.open(bytes));
    expect(again.text).toBe(d.text);
    expect(tableFields(again.paragraphs)).toHaveLength(1);
    // Without passim the pages are listed.
    writeTableOfAuthorities(again, { existing: tableFields(again.paragraphs)[0], options: { category: 1, passim: false, headings: true, keepFormatting: true, entrySeparator: '\t', pageSeparator: ', ', extra: [] }, pageOf: pages(pkg, again) });
    expect(again.text).toContain('Roe v. Wade, 410 U.S. 113 (1973)\t2, 3, 4, 5, 6, 7');
  });
});
