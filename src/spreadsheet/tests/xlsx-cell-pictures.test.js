import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { readXlsxRichValues } from '../src/core/xlsx-rich-values.js';
import { cellPicture } from '../src/core/cell-picture.js';
import { dashboardImage } from './helpers/xlsx-dashboard-fixture.js';

const PNG = `data:image/png;base64,${dashboardImage}`;
const xml = (z, p) => new TextDecoder().decode(X.CFB.find(z, p)?.content);
const zipOf = async wb => X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
const bytes = z => X.CFB.write(z, { type: 'array', fileType: 'zip' });
/** The file as another program saves it: the cells and rich values alone, without this app's own record. */
function native(z) {
  X.CFB.utils.cfb_add(z, '/xl/workbook.xml', new TextEncoder().encode(xml(z, '/xl/workbook.xml').replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, '')));
  return z;
}

it('keeps a cell picture\'s alt text in its rich value and reads it back', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setCells(id, [
    { r: 0, c: 0, cell: { v: cellPicture(PNG, { alt: 'Sales & <targets>' }) } },
    { r: 1, c: 0, cell: { v: cellPicture(PNG) } },
  ], 'Pictures');
  wb.setInput(id, 2, 0, '=A1');
  const z = await zipOf(wb);
  const structures = xml(z, '/xl/richData/rdrichvaluestructure.xml');
  expect(structures).toContain('<k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/><k n="Text" t="s"/>');
  const values = xml(z, '/xl/richData/rdrichvalue.xml');
  expect(values).toContain('<v>Sales &amp; &lt;targets&gt;</v>');
  // One picture file however many cells show it; the referring formula is a computed picture (origin 4).
  expect(z.FullPaths.filter(p => /media\/cellImage/.test(p))).toHaveLength(1);
  expect(values).toMatch(/<rv s="\d+"><v>0<\/v><v>4<\/v><v>Sales/);
  const sheet = xml(z, '/xl/worksheets/sheet1.xml');
  expect(sheet).toMatch(/<c r="A1"[^>]*t="e"[^>]*vm="\d+"/);
  const read = readXlsxRichValues(X.read(bytes(z), { type: 'array', bookFiles: true }));
  expect([...read.values()].map(v => v.alt || null)).toContain('Sales & <targets>');
  const back = await workbookFromFile(bytes(native(z)), 'pictures.xlsx'), bid = back.activeSheetId;
  expect(back.getValue(bid, 0, 0)).toEqual({ image: PNG, fit: 'contain', alt: 'Sales & <targets>' });
  expect(back.getValue(bid, 1, 0)).toEqual({ image: PNG, fit: 'contain' });
  expect(back.getValue(bid, 2, 0)).toEqual({ image: PNG, fit: 'contain', alt: 'Sales & <targets>' });
});

it('writes an IMAGE formula reading the web as a web image rich value, keeping the formula', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '=IMAGE("https://example.com/logo.png", "Logo", 1)');
  const z = await zipOf(wb);
  expect(xml(z, '/xl/richData/rdrichvaluestructure.xml')).toContain('<s t="_webimage"><k n="WebImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/><k n="ComputedImage" t="b"/><k n="ImageSizing" t="i"/><k n="Text" t="s"/></s>');
  expect(xml(z, '/xl/richData/rdrichvalue.xml')).toContain('<v>0</v><v>1</v><v>1</v><v>1</v><v>Logo</v>');
  expect(xml(z, '/xl/richData/rdRichValueWebImage.xml')).toContain('<webImageSrd><address r:id="rId1"/></webImageSrd>');
  expect(xml(z, '/xl/richData/_rels/rdRichValueWebImage.xml.rels')).toContain('Target="https://example.com/logo.png" TargetMode="External"');
  expect(xml(z, '/xl/_rels/workbook.xml.rels')).toContain('relationships/rdRichValueWebImage');
  expect(xml(z, '[Content_Types].xml')).toContain('application/vnd.ms-excel.rdrichvaluewebimage+xml');
  const sheet = xml(z, '/xl/worksheets/sheet1.xml');
  expect(sheet).toMatch(/<c r="A1"[^>]*vm="\d+"[^>]*><f>[^<]*IMAGE\(/);
  const back = await workbookFromFile(bytes(z), 'web.xlsx');
  expect(back.getCell(back.activeSheetId, 0, 0).f).toMatch(/IMAGE\("https:\/\/example.com\/logo.png", ?"Logo", ?1\)/);
});
