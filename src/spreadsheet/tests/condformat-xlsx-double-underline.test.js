// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { createGrid } from '../src/ui/grid.js';

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

const DXF = '';
const RULE = '<conditionalFormatting sqref="A1:A3"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>1000</formula></cfRule></conditionalFormatting>';
function excelFile({ dxf = DXF, rule = RULE } = {}) {
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([[12345], [5], [2500]]), 'Data');
  const zip = X.CFB.read(new Uint8Array(X.write(book, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const edit = (path, change) => { const entry = X.CFB.find(zip, path); entry.content = new TextEncoder().encode(change(new TextDecoder().decode(entry.content))); entry.size = entry.content.length; };
  edit('/xl/worksheets/sheet1.xml', xml => xml.replace('</sheetData>', () => `</sheetData>${rule}`));
  edit('/xl/styles.xml', xml => xml.replace('</cellXfs>', () => `</cellXfs>${dxf}`));
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
}
const shown = async wb => {
  grid = createGrid({ wb, sheetId: wb.activeSheetId, announce() {} }); document.body.append(grid.el);
  await new Promise(resolve => setTimeout(resolve, 10));
  const out = [0, 1, 2].map(r => grid.el.querySelector(`#gc-${r}-0`).textContent);
  grid.destroy(); grid = null;
  return out;
};
// Saved as Excel would see it: without this app's own record of the workbook.
async function resaved(wb) {
  vi.stubGlobal('Blob', NodeBlob);
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const book = X.CFB.find(zip, '/xl/workbook.xml');
  book.content = new TextEncoder().encode(new TextDecoder().decode(book.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  book.size = book.content.length;
  return { styles: new TextDecoder().decode(X.CFB.find(zip, '/xl/styles.xml').content), bytes: X.CFB.write(zip, { type: 'array', fileType: 'zip' }) };
}

// A cell's double or accounting underline is kept by name, but a conditional format's was read only as underlined
// or not, and a double one not at all: a rule underlining matching totals twice opened with no underline, and saving
// the file wrote the rule back without it.
const dxfWith = (u) => `<dxfs count="1"><dxf><font><u val="${u}"/></font></dxf></dxfs>`;

it.each(['double', 'singleAccounting', 'doubleAccounting'])('keeps a rule\'s %s underline, shows it and saves it', async (u) => {
  const wb = await workbookFromFile(excelFile({ dxf: dxfWith(u) }), 'rules.xlsx');
  expect(wb.activeSheet.rules[0].style).toMatchObject({ underline: u });
  grid = createGrid({ wb, sheetId: wb.activeSheetId, announce() {} }); document.body.append(grid.el);
  await new Promise(resolve => setTimeout(resolve, 10));
  const cell = grid.el.querySelector('#gc-0-0');
  expect(cell.classList.contains('u') || cell.querySelector('.u')).toBeTruthy();
  if (u.startsWith('double')) expect(cell.outerHTML).toContain('text-decoration-style: double');
  const { styles, bytes } = await resaved(wb);
  expect(styles).toMatch(new RegExp(`<dxf><font><u val="${u}"/>`));
  expect((await workbookFromFile(bytes, 'again.xlsx')).activeSheet.rules[0].style).toMatchObject({ underline: u });
});

it('still reads a single underline, and its explicit removal', async () => {
  expect((await workbookFromFile(excelFile({ dxf: dxfWith('single') }), 'rules.xlsx')).activeSheet.rules[0].style).toMatchObject({ underline: true });
  expect((await workbookFromFile(excelFile({ dxf: dxfWith('none') }), 'rules.xlsx')).activeSheet.rules[0].style).toMatchObject({ underline: false });
});
