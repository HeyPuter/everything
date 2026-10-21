// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToXlsx, workbookToOds } from '../src/core/io.js';
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

const KINDS = ['centerContinuous', 'fill', 'justify', 'distributed'];
// Cells A1:A4 with Excel's Center Across Selection, Fill, Justify and Distributed, then a plain Center in A5.
function excelFile() {
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([['Title'], ['ab'], ['Justified'], ['Spread'], ['Middle']]), 'Data');
  const zip = X.CFB.read(new Uint8Array(X.write(book, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const edit = (path, change) => { const entry = X.CFB.find(zip, path); entry.content = new TextEncoder().encode(change(new TextDecoder().decode(entry.content))); entry.size = entry.content.length; };
  edit('/xl/styles.xml', xml => xml.replace(/<cellXfs count="\d+">([\s\S]*?)<\/cellXfs>/, (_, xfs) => `<cellXfs count="${xfs.match(/<xf\b/g).length + 5}">${xfs}${
    [...KINDS, 'center'].map(h => `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="${h}"/></xf>`).join('')}</cellXfs>`));
  const base = new TextDecoder().decode(X.CFB.find(zip, '/xl/styles.xml').content).match(/<cellXfs count="(\d+)"/)[1] - 5;
  edit('/xl/worksheets/sheet1.xml', xml => xml.replace(/<c r="A(\d)"/g, (all, row) => `<c r="A${row}" s="${base + Number(row) - 1}"`));
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
}
// Saved as Excel would see it: without this app's own record of the workbook.
async function resaved(wb) {
  vi.stubGlobal('Blob', NodeBlob);
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const book = X.CFB.find(zip, '/xl/workbook.xml');
  book.content = new TextEncoder().encode(new TextDecoder().decode(book.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  book.size = book.content.length;
  return { styles: new TextDecoder().decode(X.CFB.find(zip, '/xl/styles.xml').content), bytes: X.CFB.write(zip, { type: 'array', fileType: 'zip' }) };
}
const aligns = wb => [0, 1, 2, 3, 4].map(r => wb.getCell(wb.activeSheetId, r, 0).s?.align);

// Opening an Excel file read only Left, Center and Right, so a title set to Center Across Selection, and cells set
// to Fill, Justify or Distributed, opened with no alignment (text at the left) and saving the file lost them.
it('opens Center Across Selection, Fill, Justify and Distributed, and saves them back', async () => {
  const wb = await workbookFromFile(excelFile(), 'aligned.xlsx');
  expect(aligns(wb)).toEqual([...KINDS, 'center']);
  const { styles, bytes } = await resaved(wb);
  for (const kind of [...KINDS, 'center']) expect(styles).toContain(`<alignment horizontal="${kind}"`);
  expect(aligns(await workbookFromFile(bytes, 'again.xlsx'))).toEqual([...KINDS, 'center']);
});

it('centres Center Across Selection and Distributed text in its cell, and sets Justify and Fill from the left', async () => {
  const wb = await workbookFromFile(excelFile(), 'aligned.xlsx');
  grid = createGrid({ wb, sheetId: wb.activeSheetId, announce() {} }); document.body.append(grid.el);
  await new Promise(resolve => setTimeout(resolve, 10));
  const side = r => ['al', 'ac', 'ar'].find(name => grid.el.querySelector(`#gc-${r}-0`).classList.contains(name));
  expect([0, 1, 2, 3, 4].map(side)).toEqual(['ac', 'al', 'al', 'ac', 'ac']);
  const printed = Object.fromEntries([...buildPrintTable(wb, wb.activeSheetId, { fit: 'actual' }).querySelectorAll('td')]
    .filter(td => td.textContent).map(td => [td.textContent, td.style.textAlign]));
  expect(printed).toMatchObject({ Title: 'center', ab: 'left', Justified: 'left', Spread: 'center', Middle: 'center' });
});

it('saves them to an .ods file as the nearest alignment it holds, and keeps them for this app', async () => {
  vi.stubGlobal('Blob', NodeBlob);
  const wb = await workbookFromFile(excelFile(), 'aligned.xlsx');
  const bytes = new Uint8Array(await (await workbookToOds(wb)).arrayBuffer());
  const content = new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);
  const styles = Object.fromEntries([...content.matchAll(/<style:style style:name="([^"]+)"[^>]*>([\s\S]*?)<\/style:style>/g)]
    .map(([, name, body]) => [name, /fo:text-align="([^"]+)"/.exec(body)?.[1] ?? null]));
  const cells = [...content.matchAll(/<table:table-cell\b[^>]*?table:style-name="([^"]+)"[^>]*>\s*<text:p>([^<]*)</g)].map(([, name, text]) => [text, styles[name]]);
  expect(Object.fromEntries(cells)).toMatchObject({ Title: 'center', ab: 'start', Justified: 'justify', Spread: 'center', Middle: 'center' });
  expect(aligns(await workbookFromFile(bytes, 'aligned.ods'))).toEqual([...KINDS, 'center']);
});
