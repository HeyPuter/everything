import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { docxWithParagraphs } from './helpers/docx.js';

// Macros and signatures were recognised by their part names alone (vbaProject…, _xmlsignatures/…). Part
// names are the producer's choice (ECMA-376 Part 2, §9.1.1): a .docm whose VBA project is stored as
// word/code.bin opened for editing, and saving it wrote a .docx (document content type) that still held
// the macros, which Word does not open. A package signed under another folder kept its stale signature.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const MACRO_MAIN = 'application/vnd.ms-word.document.macroEnabled.main+xml';
function withParts(edit) {
  const parts = unzipSync(docxWithParagraphs([{ text: 'Quarterly figures' }]));
  const text = name => strFromU8(parts[name]);
  edit(parts, text);
  return zipSync(parts);
}
const addTypes = (parts, text, entries) => { parts['[Content_Types].xml'] = strToU8(text('[Content_Types].xml').replace('</Types>', `${entries}</Types>`)); };
const addRels = (parts, text, name, entries) => { parts[name] = strToU8(text(name).replace('</Relationships>', `${entries}</Relationships>`)); };

const cases = {
  'a macro-enabled document whose VBA project has another name': (parts, text) => {
    parts['[Content_Types].xml'] = strToU8(text('[Content_Types].xml').replace('wordprocessingml.document.main+xml', 'x').replace('application/vnd.openxmlformats-officedocument.x', MACRO_MAIN));
    addTypes(parts, text, '<Override PartName="/word/code.bin" ContentType="application/vnd.ms-office.vbaProject"/>');
    addRels(parts, text, 'word/_rels/document.xml.rels', '<Relationship Id="rVba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="code.bin"/>');
    parts['word/code.bin'] = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]);
  },
  'a document whose VBA project type comes from its extension': (parts, text) => {
    addTypes(parts, text, '<Default Extension="VBA" ContentType="application/vnd.ms-office.vbaProject"/>');
    parts['word/macros.vba'] = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]);
  },
  'a document whose macro data has another name': (parts, text) => {
    addTypes(parts, text, '<Override PartName="/word/data.xml" ContentType="application/vnd.ms-word.vbaData+xml"/>');
    parts['word/data.xml'] = strToU8('<wne:vbaSuppData xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"/>');
  },
  'a document signed in another folder': (parts, text) => {
    addTypes(parts, text, '<Default Extension="sigs" ContentType="application/vnd.openxmlformats-package.digital-signature-origin"/><Override PartName="/sig/s1.xml" ContentType="application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml"/>');
    addRels(parts, text, '_rels/.rels', '<Relationship Id="rSig" Type="http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/origin" Target="sig/origin.sigs"/>');
    parts['sig/origin.sigs'] = new Uint8Array();
    parts['sig/_rels/origin.sigs.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/signature" Target="s1.xml"/></Relationships>');
    parts['sig/s1.xml'] = strToU8('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/>');
  },
};

for (const [name, edit] of Object.entries(cases)) it(`shows ${name} read-only`, async () => {
  const pkg = await DocxPackage.open(withParts(edit), { bestEffort: true });
  expect(pkg.readOnly).toBe(true);
  expect(pkg.previewIssues).toContain('macros or digital signatures');
  expect(pkg.paragraphs.map(p => p.runs.map(r => r.text).join(''))).toEqual(['Quarterly figures']);
  // Strict opening (used to edit) refuses it.
  await expect(DocxPackage.open(withParts(edit))).rejects.toThrow(/macros or digital signatures/);
});

it('still edits a document whose other binary parts are not macros', async () => {
  const pkg = await DocxPackage.open(withParts((parts, text) => {
    addTypes(parts, text, '<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>');
    parts['word/embeddings/unused.bin'] = new Uint8Array([1, 2, 3]);
  }));
  expect(pkg.readOnly).toBeFalsy();
});
