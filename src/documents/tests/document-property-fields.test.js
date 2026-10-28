import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { evaluateField, packageDocumentProperties } from '../src/engine/field-results.js';
import { docxWithParagraphs } from './helpers/docx.js';

// TITLE, AUTHOR and DOCPROPERTY fields and Insert > Quick Parts > Document Property read the
// document's core properties (ECMA-376 Part 2 §11). They read docProps/core.xml as the file was
// opened, so a title set in File > Properties was not used until the document was reopened, and a
// package whose core properties part has another name (System.IO.Packaging writes
// package/services/metadata/core-properties/<id>.psmdcp) showed none at all.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const CORE = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
function withCore(path) {
  const parts = unzipSync(docxWithParagraphs([{ text: 'Body' }]));
  parts[path] = strToU8(`<cp:coreProperties xmlns:cp="${CORE}" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Old title</dc:title><dc:creator>Ada</dc:creator></cp:coreProperties>`);
  parts['_rels/.rels'] = strToU8(strFromU8(parts['_rels/.rels']).replace('</Relationships>', `<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="/${path}"/></Relationships>`));
  parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace('</Types>', `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`));
  return zipSync(parts);
}
const field = (instruction, pkg) => ({ text: evaluateField(instruction, { now: new Date(2026, 0, 2), properties: packageDocumentProperties(pkg) }) });

it('uses properties changed in this session in title and property fields', async () => {
  const pkg = await DocxPackage.open(withCore('docProps/core.xml'));
  expect(field('TITLE', pkg).text).toBe('Old title');
  pkg.setCoreProperties({ title: 'Quarterly report', creator: 'Grace' });
  expect(field('TITLE', pkg).text).toBe('Quarterly report');
  expect(field('AUTHOR', pkg).text).toBe('Grace');
  expect(packageDocumentProperties(pkg).title).toBe('Quarterly report');
});

it('reads the core properties part the package relationship names', async () => {
  const pkg = await DocxPackage.open(withCore('package/services/metadata/core-properties/4f2c.psmdcp'));
  expect(field('TITLE', pkg).text).toBe('Old title');
  expect(packageDocumentProperties(pkg).author).toBe('Ada');
});
