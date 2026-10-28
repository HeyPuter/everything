import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { docxWithParagraphs } from './helpers/docx.js';

// A package has at most one core properties relationship (ECMA-376 Part 2 §8.3, M4.1: a package with
// more than one is invalid). Metadata scrubbers can delete docProps/core.xml and leave its
// relationship behind. Setting a property then added a second core properties relationship beside
// the dangling one, so the saved file was an invalid package. The part is now created where the
// existing relationship points.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const CORE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';
it('creates a missing core properties part at the target of its existing relationship', async () => {
  const parts = unzipSync(docxWithParagraphs([{ text: 'Body' }]));
  parts['_rels/.rels'] = strToU8(strFromU8(parts['_rels/.rels']).replace('</Relationships>', `<Relationship Id="rId9" Type="${CORE_REL}" Target="docProps/core.xml"/></Relationships>`));
  const pkg = await DocxPackage.open(zipSync(parts));
  expect(pkg.setCoreProperties({ title: 'Kept' })).toBe(true);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const saved = unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer()));
  const rels = strFromU8(saved['_rels/.rels']);
  expect(rels.match(new RegExp(CORE_REL.replace(/[/.]/g, '\\$&'), 'g'))).toHaveLength(1);
  expect(strFromU8(saved['docProps/core.xml'])).toContain('Kept');
  expect(strFromU8(saved['[Content_Types].xml'])).toContain('<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>');
  expect((await DocxPackage.open(zipSync(saved))).coreProperties.title).toBe('Kept');
});
