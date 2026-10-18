import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { updateSequenceFields } from '../src/engine/field-update.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

// Independent OOXML source: deliberately stale results, not app-created fields.
async function sequenceDocument(switches) {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const fields = switches.map(s => `<w:p><w:fldSimple w:instr="SEQ Figure ${s}"><w:r><w:t>stale</w:t></w:r></w:fldSimple></w:p>`).join('');
  const parts = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${fields}<w:sectPr/></w:body></w:document>`,
  };
  const pkg = await DocxPackage.open(zipSync(Object.fromEntries(Object.entries(parts).map(([k,v]) => [k,strToU8(v)]))));
  return { pkg, model: new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets) };
}

it('hidden SEQ results advance, repeat and reset counters without printing', async () => {
  const { model, pkg } = await sequenceDocument(['', '\\h', '', '\\h \\c', '', '\\h \\r 10', '']);
  expect(updateSequenceFields(model)).toBe(7);
  expect(model.text).toBe('1\n\n3\n\n4\n\n11');
  const bytes = new Uint8Array(await pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets).arrayBuffer());
  const again = await DocxPackage.open(bytes);
  expect(new TextDocument(again.paragraphs).text).toBe(model.text);
  expect(updateSequenceFields(model)).toBe(0);
});

it.each(['\\* roman', '\\* MERGEFORMAT'])('a general switch %s overrides SEQ hiding', async switches => {
  const { model } = await sequenceDocument(['', `\\h ${switches}`, '']);
  updateSequenceFields(model);
  expect(model.text).toBe(`1\n${switches.includes('roman') ? 'ii' : '2'}\n3`);
});

describe('text typed where a hidden sequence field stands', () => {
  it('stays the reader\'s text through saving, reopening and Update Fields', async () => {
    const { createDocx: create, DocxPackage: Package, WRITING_STYLES: writing } = await import('../src/engine/docx.js');
    const { TextDocument: Doc, paragraph: para } = await import('../src/engine/model.js');
    const { insertBodyField } = await import('../src/engine/field-results.js');
    const { updateSequenceFields } = await import('../src/engine/field-update.js');
    const open = async bytes => { const p = await Package.open(bytes); return new Doc(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets); };
    const blank = create([para()], undefined, undefined, undefined, [], {}, writing);
    const pkg = await Package.open(new Uint8Array(await blank.export().arrayBuffer()));
    const d = new Doc(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
    d.replace('Chapter 2\nPic2');
    d.select(9); insertBodyField(d, ' SEQ Figure \\r 0 \\h ', '');
    const e = await open(new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer()));
    e.select(9); e.replace(' and more');
    updateSequenceFields(e);
    expect(e.text).toBe('Chapter 2 and more\nPic2');
  });
});

describe('sequence fields Update Fields cannot reproduce', () => {
  it('keep their cached results, and still count', async () => {
    const { createDocx: create, DocxPackage: Package, WRITING_STYLES: writing } = await import('../src/engine/docx.js');
    const { TextDocument: Doc, paragraph: para } = await import('../src/engine/model.js');
    const { insertBodyField } = await import('../src/engine/field-results.js');
    const blank = create([para()], undefined, undefined, undefined, [], {}, writing);
    const pkg = await Package.open(new Uint8Array(await blank.export().arrayBuffer()));
    const d = new Doc(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
    d.replace('a ');
    insertBodyField(d, ' SEQ Figure \\s 1 ', '2-1'); d.replace(' b ');
    insertBodyField(d, ' SEQ Item \\* DollarText ', 'one'); d.replace(' c ');
    insertBodyField(d, ' SEQ Item \\# "00" ', '02'); d.replace(' d ');
    insertBodyField(d, ' SEQ Item ', '9');
    const issues = [];
    updateSequenceFields(d, { onIssue: issue => issues.push(issue) });
    expect(d.text).toBe('a 2-1 b one c 02 d 3');
    expect(issues).toHaveLength(3);
  });
});

it.each([['\\* Ordinal', '1st\n2nd\n3rd'], ['\\* CardText', 'one\ntwo\nthree'], ['\\* OrdText \\* FirstCap', 'First\nSecond\nThird'], ['\\* ROMAN \\* Lower', 'i\nii\niii'], ['\\* CardText \\* Upper', 'ONE\nTWO\nTHREE']])('numbers SEQ fields with %s', async (switches, text) => {
  const { model } = await sequenceDocument([switches, switches, switches]);
  const issues = [];
  expect(updateSequenceFields(model, { onIssue: issue => issues.push(issue) })).toBe(3);
  expect(model.text).toBe(text);
  expect(issues).toEqual([]);
});

it('applies a case format to a cross-reference to a bookmark', async () => {
  const { createDocx: create, DocxPackage: Package, WRITING_STYLES: writing } = await import('../src/engine/docx.js');
  const { TextDocument: Doc, paragraph: para } = await import('../src/engine/model.js');
  const { insertBodyField, fieldInstruction } = await import('../src/engine/field-results.js');
  const blank = create([para()], undefined, undefined, undefined, [], {}, writing);
  const pkg = await Package.open(new Uint8Array(await blank.export().arrayBuffer()));
  const d = new Doc(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  d.replace('hello world. ');
  d.select(0, 5); d.addBookmark('Greeting');
  for (const format of ['Upper', 'Caps']) { d.select(d.text.length); insertBodyField(d, fieldInstruction({ name: 'REF', argument: 'Greeting', format }), 'hello'); d.replace(' '); }
  d.select(d.text.length); insertBodyField(d, ' REF Greeting \\p \\* Upper ', 'above');
  const issues = [];
  updateSequenceFields(d, { onIssue: issue => issues.push(issue) });
  expect(d.text).toBe('hello world. HELLO Hello ABOVE');
  expect(issues).toEqual([]);
});

it('lists captions whose label has a space in a table of figures', async () => {
  const { createDocx: create, DocxPackage: Package, WRITING_STYLES: writing } = await import('../src/engine/docx.js');
  const { TextDocument: Doc, paragraph: para } = await import('../src/engine/model.js');
  const { insertCaption } = await import('../src/engine/captions.js');
  const { insertTableOfContents, figuresOptions } = await import('../src/engine/toc.js');
  const blank = create([para()], undefined, undefined, undefined, [], {}, writing);
  const pkg = await Package.open(new Uint8Array(await blank.export().arrayBuffer()));
  const d = new Doc(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  d.replace('Chart\nEnd');
  d.select(1); insertCaption(d, { label: 'My Chart', text: 'Revenue' });
  d.select(d.text.length);
  expect(insertTableOfContents(d, { title: null, options: figuresOptions({ label: 'My Chart' }) }).entries).toBe(1);
});

it('brings a cross-reference up to date in the same Update Fields as its caption', async () => {
  const { createDocx: create, DocxPackage: Package, WRITING_STYLES: writing } = await import('../src/engine/docx.js');
  const { TextDocument: Doc, paragraph: para } = await import('../src/engine/model.js');
  const { insertCaption, insertCrossReference, referenceTargets } = await import('../src/engine/captions.js');
  const blank = create([para()], undefined, undefined, undefined, [], {}, writing);
  const pkg = await Package.open(new Uint8Array(await blank.export().arrayBuffer()));
  const d = new Doc(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  d.replace('A\nB\nSee ');
  d.select(0); insertCaption(d, { label: 'Figure', text: 'Alpha' });
  d.select(d.text.indexOf('B')); insertCaption(d, { label: 'Figure', text: 'Beta' });
  d.select(d.text.length); insertCrossReference(d, referenceTargets(d).captions.find(c => c.label.includes('Beta')), { show: 'label' });
  expect(d.text).toContain('See Figure 2');
  const at = d.text.indexOf('Figure 1: Alpha');
  d.select(at, at + 'Figure 1: Alpha'.length + 1); d.replace('');
  updateSequenceFields(d);
  expect(d.text).toContain('Figure 1: Beta');
  expect(d.text).toContain('See Figure 1');
});
