import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8, unzipSync, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { updateSequenceFields } from '../src/engine/field-update.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const field = (instruction, result = 'cache') => `<w:p><w:fldSimple w:instr="${instruction}"><w:r><w:t>${result}</w:t></w:r></w:fldSimple></w:p>`;
const source = '<w:p><w:bookmarkStart w:id="1" w:name="Target"/><w:r><w:t xml:space="preserve">  source text  </w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>';
async function open(body) {
  const parts = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  };
  const pkg = await DocxPackage.open(zipSync(Object.fromEntries(Object.entries(parts).map(([k,v]) => [k,strToU8(v)]))));
  return { pkg, model: new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets) };
}

it('plain REF retains leading and trailing bookmark text on refresh and reopen', async () => {
  const { pkg, model } = await open(source + field('REF Target'));
  updateSequenceFields(model);
  expect(model.text).toBe('  source text  \n  source text  ');
  const bytes = new Uint8Array(await pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets).arrayBuffer());
  const again = await DocxPackage.open(bytes);
  expect(new TextDocument(again.paragraphs).text).toBe(model.text);
  expect(updateSequenceFields(model)).toBe(0);
});

it('relative REF uses source order, not bookmark text', async () => {
  const { model } = await open(field('REF Target \\p') + source + field('REF Target \\p'));
  updateSequenceFields(model);
  expect(model.text).toBe('below\n  source text  \nabove');
});

it.each([['\\* Upper', '  SOURCE TEXT  '], ['\\* Upper \\* Lower \\* FirstCap \\* MERGEFORMAT', '  Source text  '], ['\\* Caps', '  Source Text  ']])('applies the REF case format %s', async (switches, text) => {
  const { model } = await open(source + field(`REF Target ${switches}`, 'original result'));
  const issues = [];
  updateSequenceFields(model, { onIssue: issue => issues.push(issue) });
  expect(model.text).toBe(`  source text  \n${text}`);
  expect(issues).toEqual([]);
});

it.each(['\\n', '\\r', '\\w', '\\f', '\\* Ordinal'])('retains unsupported REF switch %s caches', async switches => {
  const { model } = await open(source + field(`REF Target ${switches}`, 'original result'));
  const issues = [];
  updateSequenceFields(model, { onIssue: issue => issues.push(issue) });
  expect(model.text).toBe('  source text  \noriginal result');
  expect(issues).toHaveLength(1);
  expect(issues[0].message).toMatch(/switches.*cached result is retained/);
});

it('retains structural and self-referencing results while other fields refresh', async () => {
  const structural = '<w:p><w:bookmarkStart w:id="2" w:name="Multi"/><w:r><w:t>First</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r><w:bookmarkEnd w:id="2"/></w:p>';
  const self = field('REF Self \\p', 'self cache').replace('<w:p>', '<w:p><w:bookmarkStart w:id="3" w:name="Self"/>').replace('</w:p>', '<w:bookmarkEnd w:id="3"/></w:p>');
  const { pkg, model } = await open(source + structural + field('REF Multi', 'multi cache') + self + field('REF Target'));
  const issues = [];
  expect(updateSequenceFields(model, { onIssue: issue => issues.push(issue) })).toBe(1);
  expect(model.text).toBe('  source text  \nFirst\nSecond\nmulti cache\nself cache\n  source text  ');
  expect(issues).toHaveLength(2);
  const bytes = new Uint8Array(await pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets).arrayBuffer());
  const again = await DocxPackage.open(bytes);
  expect(new TextDocument(again.paragraphs).text).toBe(model.text);
  const fields = part => [...new DOMParser().parseFromString(strFromU8(part), 'application/xml').getElementsByTagNameNS(W, 'fldSimple')];
  const retained = nodes => nodes.filter(n => n.getAttributeNS(W, 'instr') !== 'REF Target').map(n => {
    // The serializer adds xml:space="preserve". It has no effect on text
    // without edge whitespace; keep every other element/attribute unchanged.
    for (const t of n.getElementsByTagNameNS(W, 't')) if (t.textContent === t.textContent.trim()) t.removeAttributeNS('http://www.w3.org/XML/1998/namespace', 'space');
    return new XMLSerializer().serializeToString(n);
  });
  expect(retained(fields(unzipSync(bytes)['word/document.xml']))).toEqual(retained(fields(pkg.parts['word/document.xml'])));
});
