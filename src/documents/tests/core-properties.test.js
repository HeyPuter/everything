import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { readCoreProperties, writeCoreProperties, corePropertiesPath, w3cdtf } from '../src/engine/docx-core-properties.js';

const source = readFileSync('tests/fixtures/core-properties/properties.docx');
const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const save = async (p, d = model(p)) => unzipSync(new Uint8Array(await p.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer()));
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

describe('document core properties', () => {
  it('reads every core property from the package part the relationship names', async () => {
    const pkg = await DocxPackage.open(source);
    expect(pkg.coreProperties).toMatchObject({ title: 'Harbour Survey', subject: 'Tide gauges', creator: 'R. Okafor', keywords: 'tides; harbour; 2024',
      description: 'Field notes from the spring survey.', category: 'Survey', contentStatus: 'Draft', revision: '3',
      created: '2024-03-01T08:00:00Z', modified: '2024-03-02T09:30:00Z' });
  });

  it('keeps the core and extended property parts byte for byte when nothing is edited', async () => {
    const pkg = await DocxPackage.open(source), original = unzipSync(source);
    const out = await save(pkg);
    expect(out['docProps/core.xml']).toEqual(original['docProps/core.xml']);
    expect(out['docProps/app.xml']).toEqual(original['docProps/app.xml']);
  });

  it('writes edited properties, stamps the modification time and keeps the other elements', async () => {
    const pkg = await DocxPackage.open(source);
    pkg.clock = () => new Date('2026-10-13T12:34:56.789Z');
    pkg.coreAuthor = 'Editor Person';
    expect(pkg.setCoreProperties({ title: 'Harbour Survey 2024', keywords: '', subject: 'Tide gauges' })).toBe(true);
    const out = await save(pkg);
    const text = strFromU8(out['docProps/core.xml']);
    expect(text).toContain('<dc:title>Harbour Survey 2024</dc:title>');
    expect(text).not.toContain('keywords');
    expect(text).toContain('<dc:creator>R. Okafor</dc:creator>');
    expect(text).toContain('<cp:category>Survey</cp:category>');
    expect(text).toContain('<dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-13T12:34:56Z</dcterms:modified>');
    expect(text).toContain('<cp:lastModifiedBy>Editor Person</cp:lastModifiedBy>');
    expect(out['docProps/app.xml']).toEqual(unzipSync(source)['docProps/app.xml']);
    // The saved file reopens with the new values.
    const reopened = await DocxPackage.open(new Uint8Array(await new Blob([await pkg.export().arrayBuffer()]).arrayBuffer()));
    expect(reopened.coreProperties).toMatchObject({ title: 'Harbour Survey 2024', keywords: '', creator: 'R. Okafor' });
  });

  it('leaves the part untouched when only the content changes, so an undone edit saves the source bytes', async () => {
    const pkg = await DocxPackage.open(source);
    const d = model(pkg);
    d.select(0); d.replace('New ');
    expect((await save(pkg, d))['docProps/core.xml']).toEqual(unzipSync(source)['docProps/core.xml']);
  });

  it('creates the part, its relationship and its content type in a package that has none', async () => {
    const pkg = createDocx();
    pkg.clock = () => new Date('2026-05-06T07:08:09Z');
    expect(corePropertiesPath(pkg.parts)).toBeNull();
    const untouched = await save(pkg);
    expect(Object.keys(untouched).some(k => k.startsWith('docProps/'))).toBe(false);
    pkg.setCoreProperties({ title: 'Minutes', creator: 'A. Writer', keywords: 'board, minutes' });
    const out = await save(pkg);
    expect(strFromU8(out['_rels/.rels'])).toContain('relationships/metadata/core-properties');
    expect(strFromU8(out['[Content_Types].xml'])).toContain('PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"');
    const props = readCoreProperties(out);
    expect(props).toMatchObject({ title: 'Minutes', creator: 'A. Writer', keywords: 'board, minutes', created: '2026-05-06T07:08:09Z', modified: '2026-05-06T07:08:09Z' });
    const reopened = await DocxPackage.open(new Uint8Array(await pkg.export().arrayBuffer()));
    expect(reopened.coreProperties.title).toBe('Minutes');
  });

  it('ignores unknown keys, strips control characters and reports when nothing changed', () => {
    const pkg = createDocx();
    expect(pkg.setCoreProperties({ bogus: 'x' })).toBe(false);
    expect(pkg.setCoreProperties({ title: 'A\u0001B ' })).toBe(true);
    expect(pkg.coreProperties.title).toBe('AB');
    expect(pkg.setCoreProperties({ title: 'AB' })).toBe(false);
    expect(w3cdtf(new Date('2020-01-01T00:00:00.500Z'))).toBe('2020-01-01T00:00:00Z');
  });

  it('refuses edits to a read-only package', () => {
    const pkg = createDocx(); pkg.readOnly = true;
    expect(() => pkg.setCoreProperties({ title: 'x' })).toThrow(/read-only/);
  });

  it('declares a missing namespace prefix when it adds an element', () => {
    const parts = { '_rels/.rels': new TextEncoder().encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="c" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="/docProps/core.xml"/></Relationships>'),
      'docProps/core.xml': new TextEncoder().encode('<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"/>') };
    writeCoreProperties(parts, { title: 'T', modified: '2026-01-01T00:00:00Z' });
    const doc = new DOMParser().parseFromString(strFromU8(parts['docProps/core.xml']), 'application/xml');
    expect(doc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0].textContent).toBe('T');
    expect(doc.getElementsByTagNameNS('http://purl.org/dc/terms/', 'modified')[0].getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'type')).toBe('dcterms:W3CDTF');
  });
});
