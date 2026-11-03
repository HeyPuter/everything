import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { docxWithParagraphs } from './helpers/docx.js';

// A package may not hold two parts with equivalent names, which compare without regard to ASCII case
// (ECMA-376 Part 2, §9.1.1); Word refuses such a file. Here a ZIP holding word/document.xml twice opened
// for editing showing the second copy, and a save kept only that one. Which copy is meant is unknown, so
// the document now opens read-only, and its download stays the original file.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

// A ZIP with two items named word/document.xml: write a placeholder name of the same length, then rename it.
function repeatedEntry() {
  const parts = unzipSync(docxWithParagraphs([{ text: 'Approved budget' }]));
  parts['word/documenX.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('Approved budget', 'Other text'));
  const zip = zipSync(parts, { level: 0 }), name = strToU8('word/documenX.xml');
  outer: for (let i = 0; i <= zip.length - name.length; i++) {
    for (let j = 0; j < name.length; j++) if (zip[i + j] !== name[j]) continue outer;
    zip[i + 12] = 't'.charCodeAt(0);
  }
  return zip;
}

it('opens a package that repeats a part name read-only', async () => {
  const bytes = repeatedEntry();
  const pkg = await DocxPackage.open(bytes, { bestEffort: true });
  expect(pkg.readOnly).toBe(true);
  expect(pkg.previewIssues).toContain('parts that share a name (word/document.xml)');
  await expect(DocxPackage.open(bytes)).rejects.toThrow('parts that share a name (word/document.xml)');
});

it('opens a package with two part names differing only in case read-only', async () => {
  const parts = unzipSync(docxWithParagraphs([{ text: 'Approved budget' }]));
  parts['word/Document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('Approved budget', 'Other text'));
  const pkg = await DocxPackage.open(zipSync(parts), { bestEffort: true });
  expect(pkg.readOnly).toBe(true);
  expect(pkg.previewIssues).toContain('parts that share a name (word/Document.xml)');
});

it('still edits a package whose folders are listed as their own ZIP items', async () => {
  const parts = unzipSync(docxWithParagraphs([{ text: 'Approved budget' }]));
  const pkg = await DocxPackage.open(zipSync({ 'word/': new Uint8Array(), 'WORD/': new Uint8Array(), ...parts }));
  expect(pkg.readOnly).toBeFalsy();
});
