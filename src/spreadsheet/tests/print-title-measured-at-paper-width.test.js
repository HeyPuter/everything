// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

// A sheet cut into pages by the app repeats its title above the cells on every page. The room left for the cells is
// the page less that title, measured as wide as it prints: a long title wraps onto more lines on paper than across
// a wide window, and measured there it left the cells too much room, so every page ran over onto another sheet.
const heights = [];
vi.mock('../src/ui/print-pagination.js', async (original) => {
  const actual = await original();
  return { ...actual, paginatePrintColumns: (sheet, options) => { heights.push(options.height); return actual.paginatePrintColumns(sheet, options); } };
});

const { Workbook } = await import('../src/core/workbook.js');
const { buildPrintRoot, preparePrintRoot, printableHeight } = await import('../src/ui/print.js');

afterEach(() => { document.body.replaceChildren(); heights.length = 0; vi.restoreAllMocks(); });

it('leaves the cells the page less the title as it wraps on paper', () => {
  const cells = {};
  for (let r = 0; r < 5; r++) for (let c = 0; c < 40; c++) cells[`${r},${c}`] = { v: r * 10 + c };
  const wb = new Workbook({ sheets: [{ name: 'Wide', cells }] });
  const title = 'Quarterly regional sales forecast and reconciliation for the northern and southern districts';
  const root = buildPrintRoot(wb, wb.activeSheetId, title, { marginBoxes: true, fit: 'actual' });
  document.body.append(root);
  const section = root.querySelector('.print-section'), head = section.querySelector('.print-head');
  expect(head).not.toBeNull();
  // jsdom has no layout: the title takes one line across the window (no width set) and three at the paper's width.
  vi.spyOn(head, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 100, section.style.width ? 90 : 30));
  preparePrintRoot(root);
  expect(heights).toHaveLength(1);
  expect(heights[0]).toBeCloseTo(printableHeight({ fit: 'actual' }) - 90);
});
