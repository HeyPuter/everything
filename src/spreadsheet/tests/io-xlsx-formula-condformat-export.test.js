import { expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';
import { cellsToHtml, parseHtmlClipboard, cellsFromHtmlRows } from '../src/core/clipboard.js';

const parser = new (new JSDOM('').window.DOMParser)();
async function exported(wb) {
  const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
  const zip = X.CFB.read(bytes, { type: 'array' });
  const text = path => new TextDecoder().decode(X.CFB.find(zip, path).content);
  const xml = path => {
    const doc = parser.parseFromString(text(path), 'application/xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    return doc;
  };
  const part = X.CFB.find(zip, '/xl/workbook.xml');
  part.content = new TextEncoder().encode(text('/xl/workbook.xml').replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  part.size = part.content.length;
  const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'external.xlsx');
  return { back, sheet: xml('/xl/worksheets/sheet1.xml'), styles: xml('/xl/styles.xml') };
}
const look = (wb, r, c) => wb.conditionalStyle(wb.activeSheetId, r, c, wb.getValue(wb.activeSheetId, r, c));

it.each(['C3:C7', 'F9:H12'])('exports imported text comparisons on %s as live native rules', async ref => {
  const wb = await workbookFromFile(otherProgramsXlsx({
    sheetXml: { Data: { tail: `<conditionalFormatting sqref="${ref}"><cfRule type="cellIs" dxfId="0" priority="4" operator="equal" stopIfTrue="1"><formula>"A &amp; B 🛒"</formula></cfRule></conditionalFormatting>` } },
    patch: { '/xl/styles.xml': xml => xml.replace(/<dxfs[^>]*(?:\/>|>[\s\S]*?<\/dxfs>)/, '<dxfs count="1"><dxf><font><color rgb="FF123456"/></font><fill><patternFill><bgColor rgb="FFFEDCBA"/></patternFill></fill></dxf></dxfs>') },
  }), 'input.xlsx');
  const g = wb.activeSheet.rules[0].range;
  wb.setInput(wb.activeSheetId, g.r1, g.c1, 'A & B 🛒');
  const { back, sheet } = await exported(wb);
  expect(sheet.querySelector('conditionalFormatting').getAttribute('sqref')).toBe(ref);
  // Excel's own Cell Value rule again (see io-xlsx-condformat-cell-value.test.js), live as before.
  expect(sheet.querySelector('cfRule').getAttribute('type')).toBe('cellIs');
  expect(sheet.querySelector('cfRule').getAttribute('operator')).toBe('equal');
  expect(back.activeSheet.rules).toHaveLength(1);
  expect(look(back, g.r1, g.c1)).toMatchObject({ bg: '#fedcba', color: '#123456' });
  back.setInput(back.activeSheetId, g.r2, g.c2, 'A & B 🛒');
  expect(look(back, g.r2, g.c2)).toMatchObject({ bg: '#fedcba' });
  back.setInput(back.activeSheetId, g.r1, g.c1, 'Different');
  expect(look(back, g.r1, g.c1)).toBeNull();
});

it('retains priority, mixed references, stop rules, and differential border resets', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  const range = { r1: 2, c1: 2, r2: 5, c2: 3 };
  wb.setInput(id, 0, 0, '10'); wb.setInput(id, 2, 2, '12'); wb.setInput(id, 3, 2, '8');
  const rules = [
    { value: ' = $C3>$A$1', stopIfTrue: false, style: { bg: '#ffeedd', bold: false, bt: false, br: true, brBorder: { bs: 'double', bc: '#345678' } } },
    { value: '$C3>0', stopIfTrue: false, style: { bg: '#aabbcc', color: '#123456' } },
    { value: '$C3>11', stopIfTrue: true, style: {} },
    { value: 'TRUE', style: { bold: true } },
  ];
  for (const rule of rules) wb.addRule(id, { ...rule, type: 'formula', range });
  const { back, sheet, styles } = await exported(wb);
  expect([...sheet.querySelectorAll('cfRule')].map(n => n.getAttribute('priority'))).toEqual(['1', '2', '3', '4']);
  expect([...sheet.querySelectorAll('cfRule')].map(n => n.getAttribute('stopIfTrue'))).toEqual(['0', '0', '1', '1']);
  for (const [r, c] of [[2, 2], [2, 3], [3, 2], [3, 3]]) expect(look(back, r, c)).toMatchObject(look(wb, r, c));
  const dxf = styles.querySelector('dxf');
  // Excel reads conditional cell shading from the differential background.
  // A normal cell's fgColor + indexed=64 background turns this fill black.
  expect(dxf.querySelector('patternFill').hasAttribute('patternType')).toBe(false);
  expect(dxf.querySelector('bgColor').getAttribute('rgb')).toBe('FFFFEEDD');
  expect(dxf.querySelector('fgColor')).toBeNull();
  expect(dxf.querySelector('font name')).toBeNull();
  expect(dxf.querySelector('font sz')).toBeNull();
  expect(dxf.querySelector('left')).toBeNull();
  expect(dxf.querySelector('top').hasAttribute('style')).toBe(false);
  expect(dxf.querySelector('right').getAttribute('style')).toBe('double');
  back.setInput(back.activeSheetId, 0, 0, '20');
  expect(look(back, 2, 2)).toMatchObject({ bg: '#aabbcc', color: '#123456' });
  expect(look(back, 2, 2)?.bold).toBeUndefined();
});

it('shares differential formats with tables and writes rules before validations and drawings', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Amount'); wb.setInput(id, 1, 0, '5'); wb.setInput(id, 2, 0, '7');
  const range = { r1: 1, c1: 0, r2: 4, c2: 0 };
  wb.activeSheet.tables.push({ id: 'items', name: 'Items', range: { r1: 0, c1: 0, r2: 2, c2: 0 }, style: 'custom', banded: true,
    customStyle: { headerRow: { bg: '#ffeedd', bold: true } } });
  wb.addRule(id, { type: 'formula', range, value: 'A2>AVERAGE(Items[Amount])', style: { bg: '#ffeedd', bold: true } });
  wb.addValidation(id, { type: 'list', range, source: '5,7,9' });
  const { back, sheet, styles } = await exported(wb);
  expect(sheet.querySelector('formula').textContent).toBe('A2>AVERAGE($A$2:$A$3)');
  const children = [...sheet.documentElement.children].map(n => n.localName);
  expect(children.indexOf('conditionalFormatting')).toBeLessThan(children.indexOf('dataValidations'));
  expect(children.indexOf('conditionalFormatting')).toBeLessThan(children.indexOf('tableParts'));
  expect(styles.querySelectorAll('dxf')).toHaveLength(1);
  expect(look(back, 2, 0)).toMatchObject({ bg: '#ffeedd', bold: true });
});

it('keeps copied sheet rules live and retains their displayed colors in external HTML paste', async () => {
  const wb = new Workbook(), id = wb.activeSheetId, range = { r1: 3, c1: 2, r2: 4, c2: 2 };
  wb.setInput(id, 3, 2, '12');
  wb.addRule(id, { type: 'formula', range, value: 'C4>10', style: { color: '#123456', bg: '#fedcba', bold: true } });
  const copied = wb.duplicateSheet(id);
  const { back } = await exported(wb);
  const sheet = back.sheets.find(s => s.name === copied.name);
  back.setInput(sheet.id, 4, 2, '15');
  expect(back.conditionalStyle(sheet.id, 4, 2, 15)).toMatchObject({ bg: '#fedcba' });
  const html = cellsToHtml([['12']], wb.copyRange(id, { ...range, r2: 3 }), [[look(wb, 3, 2)]], [[12]]);
  // External clipboard HTML carries the evaluated appearance, not the
  // workbook's rule records. Re-pasting it must preserve typed values/styles.
  vi.stubGlobal('DOMParser', new JSDOM('').window.DOMParser);
  try {
    const external = html.replace(/ data-spreadsheet-[\w-]+="[^"]*"/g, '');
    const pasted = cellsFromHtmlRows(parseHtmlClipboard(external).rows)[0].cell;
    expect(pasted.v).toBe(12);
    expect(pasted.s).toMatchObject({ color: '#123456', bg: '#fedcba', bold: true });
  } finally { vi.unstubAllGlobals(); }
});
