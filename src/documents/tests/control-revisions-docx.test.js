import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { createDocx, DocxPackage, W } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

const bytes = async blob => new Uint8Array(await blob.arrayBuffer());
async function fixture(body) {
  const parts = unzipSync(await bytes(createDocx().export()));
  parts['word/document.xml'] = strToU8(`<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`);
  return zipSync(parts);
}
const control = (type, extra = '') => `<w:p><w:r><w:t xml:space="preserve">Before </w:t></w:r><w:sdt><w:sdtPr><w:alias w:val="Name"/><w:id w:val="810"/>${extra}<w:${type}/></w:sdtPr><w:sdtContent><w:r><w:t>Inside text</w:t></w:r></w:sdtContent></w:sdt><w:r><w:t xml:space="preserve"> after</w:t></w:r></w:p><w:p><w:r><w:t>Last</w:t></w:r></w:p>`;
const tracked = async body => {
  const pkg = await DocxPackage.open(await fixture(body));
  expect(pkg.readOnly).toBeFalsy();
  const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { trackChanges: true });
  model.revisionAuthor = 'Reviewer';
  return { pkg, model };
};
const save = async (pkg, model) => bytes(pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets, undefined, [], true));
const revisions = paragraphs => paragraphs.flatMap(p => p.runs.filter(r => r.revision).map(r => [r.revision.type, r.text, !!r.contentControl]));

describe('tracked changes inside content controls', () => {
  for (const [name, body] of [['rich-text', control('richText')], ['plain-text', control('text')], ['temporary rich-text', control('richText', '<w:temporary/>')]]) {
    it(`saves a tracked deletion inside a ${name} control`, async () => {
      const { pkg, model } = await tracked(body);
      const at = model.text.indexOf('Inside') + 2;
      model.select(at, at + 3); model.replace('');
      expect(revisions(model.paragraphs)).toEqual([['del', 'sid', true]]);
      const saved = await save(pkg, model);
      expect(strFromU8(unzipSync(saved)['word/document.xml'])).toMatch(/<w:sdtContent>.*<w:del [^>]*><w:r><w:delText xml:space="preserve">sid<\/w:delText><\/w:r><\/w:del>.*<\/w:sdtContent>/);
      const reopened = await DocxPackage.open(saved);
      expect(reopened.readOnly).toBeFalsy();
      expect(revisions(reopened.paragraphs)).toEqual([['del', 'sid', true]]);
    });
  }
  for (const [name, body] of [['rich-text', control('richText')], ['plain-text', control('text')]]) {
    it(`reopens a tracked replacement inside a ${name} control for editing`, async () => {
      const { pkg, model } = await tracked(body);
      const at = model.text.indexOf('Inside') + 2;
      model.select(at, at + 3); model.replace('Q');
      const expected = revisions(model.paragraphs);
      expect(expected).toEqual([['del', 'sid', true], ['ins', 'Q', true]]);
      const reopened = await DocxPackage.open(await save(pkg, model));
      expect(reopened.readOnly).toBeFalsy();
      expect(revisions(reopened.paragraphs)).toEqual(expected);
      const again = new TextDocument(reopened.paragraphs, reopened.pageSettings, reopened.numbering, reopened.styles, reopened.tables, reopened.assets);
      expect(again.text).toBe(model.text);
    });
  }
  it('still rejects text outside runs and revisions in an inline control', async () => {
    const pkg = await DocxPackage.open(await fixture(control('richText').replace('<w:r><w:t>Inside text</w:t></w:r>', '<w:ins w:id="1" w:author="A"><w:r><w:t>In</w:t></w:r></w:ins><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple>')), { bestEffort: true });
    expect(pkg.readOnly).toBe(true);
  });
});
