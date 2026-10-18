// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

// The paginator is watched, not replaced: what matters is how wide the sheet is when it is measured for pages.
const measuredAt = [];
vi.mock('../src/ui/print-pagination.js', async (original) => {
  const actual = await original();
  return { ...actual, paginatePrintColumns: (sheet, options) => {
    measuredAt.push({ table: sheet.querySelector('.print-table').getBoundingClientRect().width, page: options.width });
    return actual.paginatePrintColumns(sheet, options);
  } };
});

const { Workbook } = await import('../src/core/workbook.js');
const { buildPrintRoot, preparePrintRoot, printableWidth } = await import('../src/ui/print.js');

afterEach(() => { document.body.replaceChildren(); measuredAt.length = 0; vi.restoreAllMocks(); });

// jsdom has no layout: the table of a sheet narrower than the paper fills its section's width (width: 100%),
// and an unsized section, laid out on screen, is as wide as the window.
const WINDOW = 1440;
function layout(opts) {
  const cells = {};
  for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) cells[`${r},${c}`] = { v: r * 10 + c };
  const wb = new Workbook({ sheets: [{ name: 'Small', cells }] });
  const root = buildPrintRoot(wb, wb.activeSheetId, 'Small', { marginBoxes: true, ...opts });
  document.body.append(root);
  const section = root.querySelector('.print-section'), table = root.querySelector('.print-table');
  vi.spyOn(table, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, parseFloat(section.style.width) || WINDOW, 120));
  return { root, section };
}

it.each(['width', 'pages'])('measures a sheet narrower than the paper for pages at the paper\'s width, not the window\'s (fit: %s)', (fit) => {
  const { root, section } = layout({ fit, fitWidth: 1, fitHeight: 0 });
  preparePrintRoot(root);
  expect(measuredAt).toHaveLength(1);
  expect(measuredAt[0].page).toBeCloseTo(printableWidth());
  // Measured as wide as the window it was cut into several pages of a few stretched columns each.
  expect(measuredAt[0].table).toBeLessThanOrEqual(measuredAt[0].page);
  // Printed on one page, as the browser lays the table out on paper itself.
  expect(root.querySelectorAll('.print-page')).toHaveLength(0);
  expect(root.querySelectorAll('.print-section')).toHaveLength(1);
  expect(section.style.width).toBe('');
});
