import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
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

import { readMailMerge, writeMailMerge, mergeDocumentParts, xmlMergeFields, partText, MAIL_MERGE_NS } from '../src/engine/docx-mail-merge.js';
import { labelSheetDocx, envelopeDocx, LABEL_LAYOUTS, ENVELOPE_SIZES, layoutProblems } from '../src/engine/mail-documents.js';
import { createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { paragraph } from '../src/engine/model.js';
import { addressBlockInstruction } from '../src/engine/merge-fields.js';
import { insertMergeField, mergeFieldRanges, applyMergeResults, placeholderResults, updateLabels, labelTable, labelCells, insertEnvelope } from '../src/engine/mail-merge-model.js';
import { mergeCopy, mergeRecords } from '../src/engine/merge-fields.js';

const list = { columns: ['First Name', 'Last Name', 'City', 'Status', 'Ship Date', 'Balance', 'Title', 'Address Line 1', 'Country'], rows: [
  { values: ['Rosa', 'Vidal', 'Oslo', 'active', '2026-04-01', '1500', 'Ms.', '1 Pier Rd', 'Norway'], included: true },
  { values: ['Ken', 'Ito', 'Austin', 'inactive', '2026-04-02', '20', '', '9 Elm St', 'United States'], included: true },
  { values: ['Ana', 'Silva', 'Lima', 'active', '', '7.5', 'Dr.', '', 'Peru'], included: false },
  { values: ['Lee', 'Park', 'Seoul', 'active', '2026-05-09', '0', '', '3 Hill Rd', 'South Korea'], included: true },
], sort: [], filters: [] };

describe('mail merge settings and recipient data', () => {
  it('reads an imported main document and keeps unmanaged settings when changing the type', async () => {
    const pkg = await DocxPackage.open(fixture('letter.docx'));
    expect(pkg.mailMerge).toMatchObject({ type: 'formLetters', preview: true, activeRecord: 2, external: 'file:///C:/Data/contacts.csv', list: null });
    pkg.mailMerge = { ...pkg.mailMerge, type: 'email', preview: false, list, mapping: { first: 'First Name' }, source: { kind: 'typed', name: '' }, email: { to: 'Email', format: 'text' } };
    const d = model(pkg), out = await save(pkg, d), parts = unzipSync(out);
    const settings = strFromU8(parts['word/settings.xml']);
    expect(settings).toMatch(/<w:mailMerge><w:mainDocumentType w:val="email"\/><w:linkToQuery\/><w:dataType w:val="textFile"\/><w:connectString w:val=""\/><w:query w:val="SELECT \* FROM contacts.csv"\/><w:dataSource r:id="rMergeSource"\/><w:addressFieldName w:val="Email"\/><w:activeRecord w:val="2"\/><w:odso>/);
    expect(settings).not.toContain('viewMergedData');
    expect(parts['word/_rels/settings.xml.rels']).toEqual(pkg.parts['word/_rels/settings.xml.rels']);
    const again = await DocxPackage.open(out);
    expect(again.mailMerge).toMatchObject({ type: 'email', list, mapping: { first: 'First Name' }, email: { to: 'Email', format: 'text' } });
    expect(strFromU8(parts['customXml/item1.xml'])).toContain(MAIL_MERGE_NS);
    expect(strFromU8(parts['[Content_Types].xml'])).toContain('/customXml/itemProps1.xml');
    // Clearing the list and choosing a normal document removes both.
    again.mailMerge = null;
    const cleared = unzipSync(await save(again, model(again)));
    expect(cleared['customXml/item1.xml']).toBeUndefined();
    expect(strFromU8(cleared['word/settings.xml'])).not.toContain('mailMerge');
    expect(strFromU8(cleared['word/_rels/document.xml.rels'])).not.toContain('customXml');
  });
  it('creates settings and the data part in a new document', async () => {
    const blank = createDocx([paragraph('Hi')], undefined, undefined, undefined, [], {}, WRITING_STYLES);
    const pkg = await DocxPackage.open(new Uint8Array(await blank.export().arrayBuffer()));
    pkg.mailMerge = { type: 'mailingLabels', activeRecord: 3, preview: true, list, mapping: {}, source: { kind: 'csv', name: 'people.csv' }, email: { format: 'html' } };
    const out = await save(pkg, model(pkg));
    expect(strFromU8(unzipSync(out)['word/settings.xml'])).toContain('<w:mailMerge><w:mainDocumentType w:val="mailingLabels"/><w:dataType w:val="native"/><w:viewMergedData/><w:activeRecord w:val="3"/></w:mailMerge>');
    expect((await DocxPackage.open(out)).mailMerge).toMatchObject({ type: 'mailingLabels', activeRecord: 3, preview: true, source: { kind: 'csv', name: 'people.csv' }, list });
  });
});

describe('merging to a new document', () => {
  it('produces one section per record with rules applied', async () => {
    const source = unzipSync(fixture('letter.docx'));
    const data = mergeRecords(list);
    const { parts, copies } = mergeDocumentParts(source, { data, mapping: { first: 'First Name', last: 'Last Name', title: 'Title', city: 'City', address1: 'Address Line 1', country: 'Country' } });
    expect(copies.map(c => c.sequence)).toEqual([1, 2]);
    const text = partText(parts['word/document.xml']);
    expect(text).toContain('Ms. Rosa Vidal\n1 Pier Rd\nOslo\nNorway');
    expect(text).toContain('Dear Ms. Vidal,');
    expect(text).toContain('Your order ships to Oslo on April 1, 2026.');
    expect(text).toContain('See you at the fjord.');
    expect(text).toContain('$1,500.00');
    expect(text).toContain('Lee Park\n3 Hill Rd\nSeoul\nSouth Korea');
    expect(text).toContain('Dear Park,');
    expect(text).not.toContain('Ken');
    expect(text).toContain('Record 4');
    const xml = strFromU8(parts['word/document.xml']);
    expect(xml).not.toMatch(/fldChar|instrText|fldSimple/);
    expect(xml.match(/<w:sectPr>/g)).toHaveLength(2);
    expect(strFromU8(parts['word/settings.xml'])).not.toContain('mailMerge');
    const reopened = await DocxPackage.open(zipSync(parts));
    expect(reopened.readOnly).toBeFalsy();
    expect(reopened.paragraphs.filter(p => p.sectionEnd)).toHaveLength(1);
  });
  it('replaces a field result that spans paragraphs in every copy, keeping the text after it', () => {
    // An address block saved while previewing record 1, its lines as paragraphs, as desktop word processors save one.
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const r = t => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`, fld = kind => `<w:r><w:fldChar w:fldCharType="${kind}"/></w:r>`;
    const instr = t => `<w:r><w:instrText xml:space="preserve">${t}</w:instrText></w:r>`;
    const body = `<w:p><w:pPr><w:jc w:val="left"/></w:pPr>${r('To: ')}${fld('begin')}${instr(' ADDRESSBLOCK ')}${fld('separate')}${r('Rosa Vidal')}</w:p>`
      + `<w:p>${r('1 Pier Rd')}</w:p><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${r('Oslo')}${fld('end')}${r(' (home)')}</w:p>`
      + `<w:p>${r('Dear ')}${fld('begin')}${instr(' MERGEFIELD "First Name" ')}${fld('separate')}${r('Rosa')}${fld('end')}${r(',')}</w:p><w:sectPr/>`;
    const source = { 'word/document.xml': strToU8(`<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`) };
    const two = { ...list, rows: list.rows.slice(0, 2) };
    const { parts } = mergeDocumentParts(source, { data: mergeRecords(two), mapping: { first: 'First Name', last: 'Last Name', city: 'City', address1: 'Address Line 1' } });
    const text = partText(parts['word/document.xml']);
    expect(text).toBe('To: Ms. Rosa Vidal\n1 Pier Rd\nOslo\nNorway (home)\nDear Rosa,\nTo: Ken Ito\n9 Elm St\nAustin\nUnited States (home)\nDear Ken,');
    expect(text.match(/Pier/g)).toHaveLength(1);
    // The paragraph keeps the mark after the field (its centering), as that mark is not part of the result.
    const xml = strFromU8(parts['word/document.xml']);
    expect(xml.match(/<w:jc w:val="center"\/>/g)).toHaveLength(2);
    expect(xml).not.toContain('w:val="left"');
  });
  it('gives every merged letter notes of its own', async () => {
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', T = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const files = {
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>',
      '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${T}/officeDocument" Target="word/document.xml"/></Relationships>`,
      'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${T}/footnotes" Target="footnotes.xml"/></Relationships>`,
      'word/document.xml': `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> MERGEFIELD "First Name" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>«First Name»</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t>, see the terms.</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p><w:sectPr/></w:body></w:document>`,
      'word/footnotes.xml': `<w:footnotes xmlns:w="${W}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p w14:paraId="1A2B3C4D"><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Terms apply.</w:t></w:r></w:p></w:footnote></w:footnotes>`,
    };
    const source = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]));
    const { parts } = mergeDocumentParts(source, { data: mergeRecords(list), mapping: { first: 'First Name' } });
    const xml = strFromU8(parts['word/document.xml']);
    expect(xml.match(/<w:footnoteReference w:id="(\d+)"\/>/g)).toEqual(['<w:footnoteReference w:id="1"/>', '<w:footnoteReference w:id="2"/>', '<w:footnoteReference w:id="3"/>']);
    const notes = strFromU8(parts['word/footnotes.xml']);
    expect(notes.match(/<w:footnote w:id="\d+">/g)).toEqual(['<w:footnote w:id="1">', '<w:footnote w:id="2">', '<w:footnote w:id="3">']);
    expect(notes.match(/paraId/g)).toHaveLength(1);
    const merged = await DocxPackage.open(zipSync(parts));
    expect(merged.readOnly).toBeFalsy();
    const stories = Object.entries(merged.pageStories.stories).filter(([path]) => path.startsWith('word/footnotes.xml#'));
    expect(stories.map(([path, story]) => [path, story.paragraphs.map(p => p.runs.map(r => r.text).join('')).join('')])).toEqual([1, 2, 3].map(id => [`word/footnotes.xml#${id}`, '\uFFFC Terms apply.']));
  });
  it('fills label sheets with NEXT and a directory without breaks', async () => {
    const source = unzipSync(fixture('labels.docx'));
    const data = mergeRecords({ ...list, rows: [...list.rows, ...list.rows, ...list.rows].map(r => ({ ...r, included: true })) });
    const { parts, copies } = mergeDocumentParts(source, { data, type: 'mailingLabels' });
    expect(copies).toHaveLength(2);
    const text = partText(parts['word/document.xml']);
    expect(text.match(/Rosa Oslo/g)).toHaveLength(3);
    expect(xmlMergeFields([...new DOMParser().parseFromString(strFromU8(parts['word/document.xml']), 'application/xml').documentElement.children])).toHaveLength(0);
    const directory = mergeDocumentParts(source, { data: data.slice(0, 2), type: 'catalog' });
    expect(strFromU8(directory.parts['word/document.xml']).match(/<w:sectPr>/g)).toHaveLength(1);
  });
});

describe('recipient values with control characters', () => {
  // A list exported with in-cell line breaks as vertical tabs, or ending in a DOS end-of-file mark.
  const odd = { columns: ['First Name', 'Last Name', 'City', 'Title', 'Address Line 1', 'Country'], rows: [
    { values: ['Rosa', 'Vidal', 'Oslo', 'Ms.', '1 Pier Rd\vUnit 4', 'Norway\x1a'], included: true },
  ], sort: [], filters: [] };
  const wellFormed = bytes => new DOMParser().parseFromString(strFromU8(bytes), 'application/xml').getElementsByTagName('parsererror').length === 0;
  it('keep the embedded list readable', async () => {
    const pkg = await DocxPackage.open(fixture('letter.docx'));
    pkg.mailMerge = { ...pkg.mailMerge, list: odd, source: { kind: 'csv', name: 'people.csv' } };
    const out = await save(pkg, model(pkg)), item = Object.entries(unzipSync(out)).find(([name, bytes]) => name.startsWith('customXml/item') && strFromU8(bytes).includes(MAIL_MERGE_NS));
    expect(wellFormed(item[1])).toBe(true);
    expect((await DocxPackage.open(out)).mailMerge.list.rows[0].values).toEqual(['Rosa', 'Vidal', 'Oslo', 'Ms.', '1 Pier Rd\nUnit 4', 'Norway']);
  });
  it('keep the merged document readable', async () => {
    const { parts } = mergeDocumentParts(unzipSync(fixture('letter.docx')), { data: mergeRecords(odd), mapping: { first: 'First Name', last: 'Last Name', title: 'Title', city: 'City', address1: 'Address Line 1', country: 'Country' } });
    expect(wellFormed(parts['word/document.xml'])).toBe(true);
    expect(partText(parts['word/document.xml'])).toContain('Ms. Rosa Vidal\n1 Pier Rd\nUnit 4\nOslo\nNorway');
  });
});

describe('editing merge fields in the model', () => {
  const blankModel = async (text = 'Hello ') => {
    const blank = createDocx([paragraph(text)], undefined, undefined, undefined, [], {}, WRITING_STYLES);
    const pkg = await DocxPackage.open(new Uint8Array(await blank.export().arrayBuffer()));
    return { pkg, d: model(pkg) };
  };
  it('inserts a merge field just before another field, beside it', async () => {
    const pkg = await DocxPackage.open(fixture('letter.docx')), d = model(pkg);
    const before = bodyFieldRanges(d.paragraphs), target = before[3];
    d.select(target.start); insertMergeField(d, ' MERGEFIELD Title ');
    const after = bodyFieldRanges(d.paragraphs), added = after.find(r => r.field.instruction === ' MERGEFIELD Title ');
    expect(added.parentId).toBeUndefined();
    expect(after.find(r => r.field.id === target.field.id).start).toBe(added.end);
    const again = model(await DocxPackage.open(await save(pkg, d)));
    expect(bodyFieldRanges(again.paragraphs).map(r => r.field.instruction)).toEqual(after.map(r => r.field.instruction));
  });
  it('inserts fields that save as complex fields and preview record values', async () => {
    const { pkg, d } = await blankModel();
    d.select(6); insertMergeField(d, ' MERGEFIELD "First Name" ');
    d.replace('!\n'); insertMergeField(d, addressBlockInstruction());
    d.replace('\n'); insertMergeField(d, ' IF "{ MERGEFIELD City }" = "Oslo" "Hei" "Hello" ');
    expect(d.text).toBe('Hello «First Name»!\n«AddressBlock»\nHei');
    const fields = mergeFieldRanges(d);
    const copy = mergeCopy(fields.map(f => f.code), { data: mergeRecords(list), mapping: { first: 'First Name', last: 'Last Name', title: 'Title', address1: 'Address Line 1', city: 'City', country: 'Country' } });
    applyMergeResults(d, fields, copy.results);
    expect(d.text).toBe('Hello Rosa!\nMs. Rosa Vidal\v1 Pier Rd\vOslo\vNorway\nHei');
    applyMergeResults(d, mergeFieldRanges(d), placeholderResults(mergeFieldRanges(d)));
    expect(d.text).toBe('Hello «First Name»!\n«AddressBlock»\nHei');
    const out = await save(pkg, d), xml = strFromU8(unzipSync(out)['word/document.xml']);
    expect(xml).toContain('<w:instrText xml:space="preserve"> MERGEFIELD "First Name" </w:instrText>');
    expect(xml).toContain('<w:instrText xml:space="preserve"> MERGEFIELD City </w:instrText>');
    const again = model(await DocxPackage.open(out));
    expect(mergeFieldRanges(again).map(f => f.code)).toEqual(fields.map(f => f.code));
  });
  it('inserts a field over a selection as a tracked change with Track Changes on', async () => {
    const { d } = await blankModel('Dear world, hello.');
    d.trackChanges = true; d.revisionAuthor = 'Reviewer';
    d.select(5, 10); insertMergeField(d, ' MERGEFIELD "First Name" ');
    expect(d.revisions.map(r => [r.type, d.text.slice(r.start, r.end)])).toEqual([['del', 'world'], ['ins', '«First Name»']]);
    const [field] = mergeFieldRanges(d);
    expect(d.text.slice(field.range.start, field.range.end)).toBe('«First Name»');
    d.resolveRevisions(true);
    expect(d.text).toBe('Dear «First Name», hello.');
    expect(d.text.slice(mergeFieldRanges(d)[0].range.start, mergeFieldRanges(d)[0].range.end)).toBe('«First Name»');
  });
  it('keeps a field result\'s formatting through a recipient without a value', async () => {
    const { pkg, d } = await blankModel('Hi ');
    d.select(3); insertMergeField(d, ' MERGEFIELD "First Name" '); d.replace('!');
    d.select(3, 3 + '«First Name»'.length); d.toggleBold();
    const bold = () => d.paragraphs[0].runs.filter(r => r.bold).map(r => r.text);
    expect(bold()).toEqual(['«First Name»']);
    const preview = value => applyMergeResults(d, mergeFieldRanges(d), [value]);
    preview('');
    expect(d.text).toBe('Hi !');
    preview('Bob');
    expect(d.text).toBe('Hi Bob!');
    expect(bold()).toEqual(['Bob']);
    preview(''); applyMergeResults(d, mergeFieldRanges(d), placeholderResults(mergeFieldRanges(d)));
    expect(bold()).toEqual(['«First Name»']);
    // The remembered formatting is not written to the file.
    expect(strFromU8(unzipSync(await save(pkg, d))['word/document.xml'])).not.toContain('resultFormatting');
  });
  it('builds label sheets that open editable and propagates the first label', async () => {
    const layout = LABEL_LAYOUTS.find(l => l.id === 'letter-10');
    expect(layoutProblems(layout)).toEqual([]);
    const blob = labelSheetDocx(layout, i => i === 0 ? { fields: [{ field: addressBlockInstruction() }] } : null, { mailMerge: { type: 'mailingLabels', list, mapping: {}, activeRecord: 1 } });
    const pkg = await DocxPackage.open(new Uint8Array(await blob.arrayBuffer()));
    expect(pkg.readOnly).toBeFalsy();
    expect(pkg.mailMerge.type).toBe('mailingLabels');
    const d = model(pkg);
    expect(labelCells(labelTable(d))).toHaveLength(10);
    d.checkpoint = () => {};
    expect(updateLabels(d)).toBe(9);
    expect(d.text.match(/«Next Record»«AddressBlock»/g)).toHaveLength(9);
    const out = await save(pkg, d);
    const plan = mergeDocumentParts(unzipSync(out), { data: mergeRecords(list), type: 'mailingLabels' });
    expect(plan.copies).toHaveLength(1);
    expect(partText(plan.parts['word/document.xml'])).toContain('Lee Park');
  });
  it('lays out envelopes in an empty document and as a first section', async () => {
    const size = ENVELOPE_SIZES[0];
    const blob = await envelopeDocx({ width: size.width, height: size.height, delivery: 'Rosa Vidal\n1 Pier Rd', returnAddress: 'Sam Lee\n4 Main St' });
    const pkg = await DocxPackage.open(new Uint8Array(await blob.arrayBuffer()));
    expect(pkg.pageSettings).toMatchObject({ width: size.width, height: size.height, orientation: 'landscape' });
    expect(model(pkg).text).toBe('Sam Lee\v4 Main St\nRosa Vidal\v1 Pier Rd');
    const { pkg: letter, d } = await blankModel('Dear reader');
    d.checkpoint = () => {};
    insertEnvelope(d, { width: size.width, height: size.height, delivery: 'Rosa Vidal', returnAddress: '' });
    expect(d.text).toBe('\nRosa Vidal\nDear reader');
    expect(d.paragraphs[1].sectionEnd).toMatchObject({ width: size.width, height: size.height });
    const again = await DocxPackage.open(await save(letter, d));
    expect(again.paragraphs[1].sectionEnd).toMatchObject({ width: size.width });
    expect(again.pageSettings.width).toBe(12240);
  });
});

// MAIL_MERGE_EXPORTS=<dir> writes representative outputs for schema validation (tools/check-docx-schema.py).
it.runIf(!!process.env.MAIL_MERGE_EXPORTS)('writes outputs for schema validation', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = process.env.MAIL_MERGE_EXPORTS; mkdirSync(dir, { recursive: true });
  const write = async (name, data) => writeFileSync(`${dir}/${name}`, data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data);
  const data = mergeRecords(list);
  await write('merged-letters.docx', zipSync(mergeDocumentParts(unzipSync(fixture('letter.docx')), { data }).parts));
  await write('merged-labels.docx', zipSync(mergeDocumentParts(unzipSync(fixture('labels.docx')), { data, type: 'mailingLabels' }).parts));
  for (const layout of [LABEL_LAYOUTS[0], LABEL_LAYOUTS.find(l => l.id === 'a4-21')]) await write(`labels-${layout.id}.docx`, labelSheetDocx(layout, i => ({ text: `Label ${i + 1}\nSecond line` }), { mailMerge: { type: 'mailingLabels', list, mapping: {}, activeRecord: 1 } }));
  await write('envelope.docx', await envelopeDocx({ width: ENVELOPE_SIZES[5].width, height: ENVELOPE_SIZES[5].height, delivery: { field: addressBlockInstruction() }, returnAddress: 'Sam Lee\n4 Main St' }, { mailMerge: { type: 'envelopes', list, mapping: {}, activeRecord: 1 } }));
  const pkg = await DocxPackage.open(fixture('letter.docx'));
  pkg.mailMerge = { ...pkg.mailMerge, type: 'catalog', list, mapping: { first: 'First Name' } };
  const d = model(pkg); d.select(0); insertMergeField(d, ' IF "{ MERGEFIELD City }" <> "" "{ MERGEFIELD City }" "none" ');
  await write('main-document.docx', await save(pkg, d));
});

describe('field updates beside merge rules', () => {
  it('leaves a REF to an Ask bookmark for the merge to fill', async () => {
    const { fieldUpdatePlan } = await import('../src/engine/field-update.js');
    const blank = createDocx([paragraph('Due: ')], undefined, undefined, undefined, [], {}, WRITING_STYLES);
    const pkg = await DocxPackage.open(new Uint8Array(await blank.export().arrayBuffer()));
    const d = model(pkg);
    d.select(0); insertMergeField(d, ' ASK due "When?" \\d "Friday" ');
    d.select(d.text.length); insertMergeField(d, ' REF due ', 'Friday');
    insertMergeField(d, ' REF missing ', 'x');
    expect(fieldUpdatePlan(d).map(c => c.text)).toEqual(['Error! Reference source not found.']);
  });
});
