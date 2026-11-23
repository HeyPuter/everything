import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { hasPart } from '../src/engine/package-part-paths.js';

// Part names compare without regard to ASCII case, and a package may not hold two equivalent ones (ECMA-376 Part 2,
// §9.1.1.1). A part the editor adds took the first free name in exact case: beside an existing word/Header1.xml a new
// header was written as word/header1.xml, a file Word refuses and that opens here only read-only ("parts that share
// a name"). Core properties whose relationship named docProps/core.xml for the item docProps/Core.xml read as none,
// and setting a title wrote a second, empty part beside it.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships', TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.';
function packageWith({ types = '', packageRels = '', rels = '', section = '', extra = {} }) {
  const files = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${TYPE}document.main+xml"/>${types}</Types>`,
    '_rels/.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>${packageRels}</Relationships>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="${REL}">${rels}</Relationships>`,
    'word/document.xml': `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p><w:r><w:t>Body text</w:t></w:r></w:p><w:sectPr>${section}</w:sectPr></w:body></w:document>`,
    ...extra,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}
const modelOf = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
async function saved(pkg, model = modelOf(pkg)) {
  return new Uint8Array(await pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets).arrayBuffer());
}
const equivalentNames = bytes => {
  const names = Object.keys(unzipSync(bytes)).map(name => name.toLowerCase());
  return names.filter((name, i) => names.indexOf(name) !== i);
};

it('adds a header under a name no existing part has in any case', async () => {
  const pkg = await DocxPackage.open(packageWith({
    types: `<Override PartName="/word/Header1.xml" ContentType="${TYPE}header+xml"/>`,
    rels: `<Relationship Id="rH" Type="${R}/header" Target="Header1.xml"/>`,
    section: '<w:headerReference w:type="default" r:id="rH"/>',
    extra: { 'word/Header1.xml': `<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>Existing header</w:t></w:r></w:p></w:hdr>` },
  }));
  expect(pkg.readOnly).toBeFalsy();
  const created = pkg.addPageStory('header', { variant: 'first' });
  expect(created.toLowerCase()).not.toBe('word/header1.xml');
  const bytes = await saved(pkg);
  expect(equivalentNames(bytes)).toEqual([]);
  const parts = unzipSync(bytes);
  // The existing header keeps its own content type declaration.
  expect(strFromU8(parts['[Content_Types].xml'])).toContain('PartName="/word/Header1.xml"');
  expect(strFromU8(parts['word/Header1.xml'])).toContain('Existing header');
  const reopened = await DocxPackage.open(bytes, { bestEffort: true });
  expect(reopened.readOnly).toBeFalsy();
});

it('adds notes beside a part of the conventional name in other capitals', async () => {
  // An orphan part (no relationship names it) stays as it was, under its own name.
  for (const kind of ['footnote', 'endnote']) {
    const orphan = `word/${kind[0].toUpperCase()}${kind.slice(1)}s.xml`;
    const pkg = await DocxPackage.open(packageWith({ extra: { [orphan]: `<w:${kind}s xmlns:w="${W}"/>` } }));
    expect(pkg.readOnly).toBeFalsy();
    const note = kind === 'footnote' ? pkg.addFootnote() : pkg.addEndnote();
    expect(note.part.toLowerCase()).not.toBe(orphan.toLowerCase());
    expect(equivalentNames(await saved(pkg))).toEqual([]);
  }
});

it('sets the title in core properties stored in other capitals than their relationship names', async () => {
  const core = `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Old title</dc:title><dc:creator>Ada</dc:creator></cp:coreProperties>`;
  const pkg = await DocxPackage.open(packageWith({
    types: '<Override PartName="/docProps/Core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    packageRels: `<Relationship Id="rC" Type="${REL}/metadata/core-properties" Target="docProps/core.xml"/>`,
    extra: { 'docProps/Core.xml': core },
  }));
  expect(pkg.coreProperties.title).toBe('Old title');
  pkg.setCoreProperties({ title: 'New title' });
  const bytes = await saved(pkg);
  expect(equivalentNames(bytes)).toEqual([]);
  const reopened = await DocxPackage.open(bytes, { bestEffort: true });
  expect(reopened.readOnly).toBeFalsy();
  expect(reopened.coreProperties).toMatchObject({ title: 'New title', creator: 'Ada' });
});

it('tells a part name in use in any capitals from a free one', () => {
  const parts = { 'word/Header1.xml': new Uint8Array() };
  expect(hasPart(parts, 'word/Header1.xml')).toBe(true);
  expect(hasPart(parts, 'word/header1.xml')).toBe(true);
  expect(hasPart(parts, 'word/header2.xml')).toBe(false);
});
