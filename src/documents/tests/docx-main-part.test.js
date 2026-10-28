import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';

// OPC finds the main document part through the package relationship of type …/officeDocument
// (ECMA-376 Part 2 §8.3, Part 1 §11.3.10), not by its name, and part names compare without regard to
// ASCII case (Part 2 §9.1.1.1). Packages written by the Open XML SDK can name it word/document2.xml;
// others write the target as ./word/document.xml or capitalize the content type entry differently.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
function packageWith({ main = 'word/document.xml', target = main, overrideName = `/${main}` } = {}) {
  const file = main.slice(main.lastIndexOf('/') + 1);
  return zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="${overrideName}" ContentType="${MAIN_TYPE}"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="R1" Type="${OFFICE}/officeDocument" Target="${target}"/></Relationships>`,
    [`word/_rels/${file}.rels`]: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="R2" Type="${OFFICE}/styles" Target="styles.xml"/></Relationships>`,
    [main]: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Report</w:t></w:r></w:p><w:p><w:r><w:t>Body text</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
    'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style></w:styles>`,
  }).map(([name, text]) => [name, strToU8(text)])));
}
const text = pkg => pkg.paragraphs.map(p => p.runs.map(r => r.text).join(''));
async function editAndSave(pkg) {
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  doc.select(doc.text.length); doc.replace(' added');
  return unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer()));
}

for (const [name, options] of [
  ['a main part named word/document2.xml', { main: 'word/document2.xml' }],
  ['a main part target written as ./word/document.xml', { target: './word/document.xml' }],
  ['a main part target written with a leading slash and other capitals', { main: 'word/Document.xml', target: '/word/Document.xml' }],
  ['a content type entry that capitalizes the main part name', { overrideName: '/word/Document.xml' }],
]) it(`opens ${name} for editing and saves it as word/document.xml`, async () => {
  const pkg = await DocxPackage.open(packageWith(options));
  expect(pkg.readOnly).toBeFalsy();
  expect(text(pkg)).toEqual(['Report', 'Body text']);
  // Its relationships still resolve: the heading keeps its style.
  expect(pkg.paragraphs[0].styleId).toBe('Heading1');
  const parts = await editAndSave(pkg);
  expect(Object.keys(parts).filter(key => /^word\/[^/]*document[^/]*\.xml$/i.test(key))).toEqual(['word/document.xml']);
  expect(Object.keys(parts).filter(key => /^word\/_rels\//.test(key))).toEqual(['word/_rels/document.xml.rels']);
  expect(strFromU8(parts['[Content_Types].xml'])).toContain(`<Override PartName="/word/document.xml" ContentType="${MAIN_TYPE}"/>`);
  expect(strFromU8(parts['_rels/.rels'])).toMatch(/Target="\/?word\/document\.xml"/);
  const reopened = await DocxPackage.open(zipSync(parts));
  expect(reopened.readOnly).toBeFalsy();
  expect(text(reopened)).toEqual(['Report', 'Body text added']);
  expect(reopened.paragraphs[0].styleId).toBe('Heading1');
});

it('leaves the package parts of a main part already at word/document.xml as they were', async () => {
  const bytes = packageWith(), source = unzipSync(bytes);
  const parts = await editAndSave(await DocxPackage.open(bytes));
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/styles.xml']) expect(strFromU8(parts[name]), name).toBe(strFromU8(source[name]));
});

it('still refuses a main part outside the word folder or one that competes with word/document.xml', async () => {
  await expect(DocxPackage.open(packageWith({ main: 'content/main.xml' }))).rejects.toThrow();
  const parts = unzipSync(packageWith({ main: 'word/document2.xml' }));
  parts['word/document.xml'] = parts['word/document2.xml'];
  await expect(DocxPackage.open(zipSync(parts))).rejects.toThrow();
});
