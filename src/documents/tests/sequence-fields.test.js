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
