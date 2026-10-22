// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook, DEFAULT_ROW_HEIGHT } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { cellLayoutText, heightForLines } from '../src/core/textfit.js';
import { cellsToHtml, cellsFromHtmlRows, parseHtmlClipboard } from '../src/core/clipboard.js';
import { createGrid } from '../src/ui/grid.js';
import { buildPrintTable } from '../src/ui/print.js';

/** The height a row fitted to one line of 13px text takes (never less than the default row). */
const ONE_LINE = heightForLines(1, 13, DEFAULT_ROW_HEIGHT);

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: t => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = () => {};
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });
const flush = () => new Promise(resolve => setTimeout(resolve, 10));

// Checked with separate LF, CRLF and CR examples: LF lays out a
// new line only with wrapping; CR itself has no displayed width or line break.
it.each(['\n', '\r\n', '\r'])('honors wrapping without changing stored %j text or formula values', async sep => {
  const wb = new Workbook(), id = wb.activeSheetId, raw = `Alpha${sep}Bravo`;
  wb.setInput(id, 0, 0, raw);
  wb.setInput(id, 2, 0, '=A1');
  wb.setInput(id, 3, 0, '=LEN(A1)');
  const grid = createGrid({ wb, sheetId: id, announce() {} });
  document.body.append(grid.el);
  try {
    for (const wrap of [false, true, false]) {
      wb.applyStyle(id, { r1: 0, c1: 0, r2: 2, c2: 0 }, { wrap });
      await flush();
      const shown = wrap && sep.includes('\n') ? 'Alpha\nBravo' : 'AlphaBravo';
      expect(grid.el.querySelector('#gc-0-0').textContent).toBe(shown);
      expect(grid.el.querySelector('#gc-2-0').textContent).toBe(shown);
      const printed = buildPrintTable(wb, id);
      expect(printed.querySelector('td').textContent).toBe(shown);
      grid.autoFitRows(0, 0, { force: true });
      expect(wb.rowHeight(id, 0)).toBe(shown.includes('\n') ? 37 : ONE_LINE);
      grid.el.querySelector('.col-resizer[data-c="0"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      expect(wb.colWidth(id, 0)).toBe(shown.includes('\n') ? 49 : wrap ? 40 : 84);
      expect(wb.getValue(id, 0, 0)).toBe(raw);
      expect(wb.getValue(id, 3, 0)).toBe(raw.length);
    }
  } finally { grid.destroy(); }
});

it.each([false, true])('retains raw line endings and wrap=%s in external HTML and native XLSX', async wrap => {
  const raw = 'alpha\r\nbeta\rgamma\nend', cell = { v: raw, f: null, s: { wrap } };
  const html = cellsToHtml([[raw]], [[cell]], null, [[raw]]).replace(/ data-spreadsheet-[\w-]+="[^"]*"/g, '');
  const parsed = parseHtmlClipboard(html);
  const back = cellsFromHtmlRows(parsed.rows)[0].cell;
  expect(back.v).toBe(raw);
  expect(back.s.wrap).toBe(wrap);
  const dom = document.createElement('div'); dom.innerHTML = html;
  expect(dom.querySelectorAll('br')).toHaveLength(2);
  for (const br of dom.querySelectorAll('br')) expect(br.style.display).toBe(wrap ? '' : 'none');
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setCells(id, [{ r: 4, c: 3, cell }]);
  const blob = await workbookToXlsx(wb);
  const bytes = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsArrayBuffer(blob); });
  const zip = X.CFB.read(new Uint8Array(bytes), { type: 'array' });
  const book = X.CFB.find(zip, '/xl/workbook.xml');
  book.content = new TextEncoder().encode(new TextDecoder().decode(book.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  book.size = book.content.length;
  const native = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'line-breaks.xlsx');
  const read = native.getCell(native.activeSheetId, 4, 3);
  expect(read.v).toBe(raw);
  expect(!!read.s?.wrap).toBe(wrap);
});

it('keeps spaces, tabs and Unicode while suppressing only inactive line controls', () => {
  expect(cellLayoutText('  A\t\r\n東京\n B  ', false)).toBe('  A\t東京 B  ');
  expect(cellLayoutText('  A\t\r\n東京\n B  ', true)).toBe('  A\t\n東京\n B  ');
  expect(cellLayoutText(null, false)).toBe('');
});
