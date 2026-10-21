// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { createGrid } from '../src/ui/grid.js';
import { buildPrintTable } from '../src/ui/print.js';

let grid;
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: t => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = () => {};
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
afterEach(() => { grid?.destroy(); grid = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const KINDS = ['single', 'double', 'singleAccounting', 'doubleAccounting'];
// Cells A1:A4, each underlined in one of Excel's four ways.
function excelFile({ link = false } = {}) {
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet(KINDS.map(kind => [kind])), 'Data');
  const zip = X.CFB.read(new Uint8Array(X.write(book, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const edit = (path, change) => { const entry = X.CFB.find(zip, path); entry.content = new TextEncoder().encode(change(new TextDecoder().decode(entry.content))); entry.size = entry.content.length; };
  let fontBase, xfBase;
  edit('/xl/styles.xml', xml => xml
    .replace(/<fonts count="(\d+)">([\s\S]*?)<\/fonts>/, (_, count, body) => { fontBase = Number(count); return `<fonts count="${fontBase + KINDS.length}">${body}${
      KINDS.map(kind => `<font><u${kind === 'single' ? '' : ` val="${kind}"`}/><sz val="12"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>`).join('')}</fonts>`; })
    .replace(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/, (_, count, body) => { xfBase = Number(count); return `<cellXfs count="${xfBase + KINDS.length}">${body}${
      KINDS.map((_, i) => `<xf numFmtId="0" fontId="${fontBase + i}" fillId="0" borderId="0" xfId="0" applyFont="1"/>`).join('')}</cellXfs>`; }));
  edit('/xl/worksheets/sheet1.xml', xml => xml.replace(/<c r="A(\d)"/g, (all, row) => `<c r="A${row}" s="${xfBase + Number(row) - 1}"`));
  // A2 as a link: =HYPERLINK("https://example.com", "double").
  if (link) edit('/xl/worksheets/sheet1.xml', xml => xml.replace(/<c r="A2" (s="\d+")[^>]*>[\s\S]*?<\/c>/,
    (_, style) => `<c r="A2" ${style} t="str"><f>HYPERLINK("https://example.com","double")</f><v>double</v></c>`));
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
}
const underlines = wb => KINDS.map((_, r) => wb.getCell(wb.activeSheetId, r, 0).s?.underline);
const withoutAppRecord = zip => {
  const book = X.CFB.find(zip, '/xl/workbook.xml');
  book.content = new TextEncoder().encode(new TextDecoder().decode(book.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  book.size = book.content.length;
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
};

// A cell's double or accounting underline opened as a single underline, and was saved back as one.
it('opens a double or accounting underline and saves it as it was', async () => {
  vi.stubGlobal('Blob', NodeBlob);
  const wb = await workbookFromFile(excelFile(), 'underlines.xlsx');
  expect(underlines(wb)).toEqual([true, 'double', 'singleAccounting', 'doubleAccounting']);
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const styles = new TextDecoder().decode(X.CFB.find(zip, '/xl/styles.xml').content);
  for (const kind of KINDS.slice(1)) expect(styles).toContain(`<u val="${kind}"/>`);
  expect(underlines(await workbookFromFile(withoutAppRecord(zip), 'again.xlsx'))).toEqual([true, 'double', 'singleAccounting', 'doubleAccounting']);
});

it('draws a double underline doubled on the grid and in print', async () => {
  const wb = await workbookFromFile(excelFile(), 'underlines.xlsx');
  grid = createGrid({ wb, sheetId: wb.activeSheetId, announce() {} }); document.body.append(grid.el);
  await new Promise(resolve => setTimeout(resolve, 10));
  const cells = [0, 1, 2, 3].map(r => grid.el.querySelector(`#gc-${r}-0`));
  expect(cells.every(cell => cell.classList.contains('u'))).toBe(true);
  expect(cells.map(cell => cell.style.textDecorationStyle)).toEqual(['', 'double', '', 'double']);
  const printed = Object.fromEntries([...buildPrintTable(wb, wb.activeSheetId, { fit: 'actual' }).querySelectorAll('td')]
    .filter(td => td.textContent).map(td => [td.textContent, td.style.textDecorationStyle]));
  expect(printed).toEqual({ single: '', double: 'double', singleAccounting: '', doubleAccounting: 'double' });
});

it('keeps a linked cell\'s double underline', async () => {
  const wb = await workbookFromFile(excelFile({ link: true }), 'underlines.xlsx');
  expect(wb.getCell(wb.activeSheetId, 1, 0)).toMatchObject({ f: 'HYPERLINK("https://example.com","double")', s: { underline: 'double' } });
});
