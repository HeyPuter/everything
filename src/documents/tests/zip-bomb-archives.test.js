import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { themeFileXml } from '../src/engine/package-design.js';
import { readWorkbook } from '../src/lib/recipient-files.js';
import { DocxPackage } from '../src/engine/docx.js';
import { docxWithParagraphs } from './helpers/docx.js';

// A theme (.thmx) or recipient workbook (.xlsx) the user picks was unzipped without limits. fflate
// allocates each item at the size the archive declares, so a file of a few hundred bytes declaring
// hundreds of megabytes made the tab allocate, decode and parse them (with gigabytes, it ran out of
// memory). Documents were already limited; these archives now are too.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

// The archive, with `name`'s declared uncompressed size (local header and central directory) set to `size`.
function declaring(files, name, size) {
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])), { level: 0 });
  const view = new DataView(zip.buffer), encoded = strToU8(name);
  const named = at => encoded.every((b, i) => zip[at + i] === b);
  for (let at = 0; at + 46 < zip.length; at++) {
    const signature = view.getUint32(at, true);
    if (signature === 0x04034b50 && view.getUint16(at + 26, true) === encoded.length && named(at + 30)) view.setUint32(at + 22, size, true);
    if (signature === 0x02014b50 && view.getUint16(at + 28, true) === encoded.length && named(at + 46)) view.setUint32(at + 24, size, true);
  }
  return zip;
}
const MB = 1024 * 1024;
const THEME = '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Tiny"/>';

it('refuses a theme file that declares far more than a theme holds', () => {
  const started = performance.now();
  expect(() => themeFileXml(declaring({ 'theme/theme/theme1.xml': THEME }, 'theme/theme/theme1.xml', 60 * MB))).toThrow('This theme file is too large to be a theme.');
  expect(performance.now() - started).toBeLessThan(2000);
  // An ordinary theme package still opens.
  const theme = strFromU8(unzipSync(readFileSync('public/fixtures/two-paragraphs.docx'))['word/theme/theme1.xml']);
  expect(themeFileXml(declaring({ 'theme/theme/theme1.xml': theme }, 'none', 0))).toContain('<a:fontScheme');
});

it('refuses a recipient workbook that expands past the limit', () => {
  const workbook = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>',
    'xl/sharedStrings.xml': '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
  };
  const started = performance.now();
  expect(() => readWorkbook(declaring(workbook, 'xl/sharedStrings.xml', 150 * MB))).toThrow('This workbook expands to more than 100 MB, too large for a recipient list.');
  expect(performance.now() - started).toBeLessThan(2000);
});

it('still refuses a document that expands past the limit, as before', async () => {
  const files = { 'word/media/big.bin': 'x' };
  const zip = declaring(files, 'word/media/big.bin', 200 * MB);
  await expect(DocxPackage.open(zip)).rejects.toThrow('Could not read this DOCX archive: DOCX expanded size exceeds the editor limit.');
  expect((await DocxPackage.open(docxWithParagraphs([{ text: 'Fine' }]))).readOnly).toBeFalsy();
});
