// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { printPreviewLayout } from '../src/ui/print-preview.js';
import { PRINT_DEFAULTS } from '../src/ui/print.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

// The print dialog shows the pages as they will print, beside the choices, and follows each change.
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
const drawn = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  const data = new Map();
  vi.stubGlobal('localStorage', { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) });
  // A canvas that records the text it is asked to draw.
  drawn.length = 0;
  const g = new Proxy({ fillText: (t) => drawn.push(t) }, { get: (o, k) => (k in o ? o[k] : () => {}), set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(g);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function book(rows = 120) {
  const wb = new Workbook(), id = wb.activeSheetId;
  for (let r = 0; r < rows; r++) { wb.setInput(id, r, 0, `Item ${r + 1}`); wb.setInput(id, r, 1, String(r * 3)); }
  return { wb, id };
}

it('lays the printed range out in pages of whole rows, following paper, orientation, scale and breaks', () => {
  const { wb, id } = book();
  const portrait = printPreviewLayout(wb, id, { ...PRINT_DEFAULTS, fit: 'actual' });
  expect(portrait.pages.length).toBeGreaterThan(1);
  expect(portrait.pages[0].rows[0]).toBe(0);
  expect(portrait.pages[1].rows[0]).toBe(portrait.pages[0].rows[1] + 1);
  const landscape = printPreviewLayout(wb, id, { ...PRINT_DEFAULTS, fit: 'actual', orientation: 'landscape' });
  expect(landscape.pages.length).toBeGreaterThan(portrait.pages.length);
  const onePage = printPreviewLayout(wb, id, { ...PRINT_DEFAULTS, fit: 'pages', fitWidth: 1, fitHeight: 1 });
  expect(onePage.pages).toHaveLength(1); expect(onePage.scale).toBeLessThan(1);
  const broken = printPreviewLayout(wb, id, { ...PRINT_DEFAULTS, fit: 'actual', rowBreaks: [10] });
  expect(broken.pages[0].rows).toEqual([0, 9]);
  const selection = printPreviewLayout(wb, id, { ...PRINT_DEFAULTS, area: 'selection' }, { r1: 4, c1: 1, r2: 6, c2: 1 });
  expect(selection.pages).toEqual([{ rows: [4, 6], cols: [1, 1] }]);
  expect(printPreviewLayout(new Workbook(), new Workbook().activeSheetId, PRINT_DEFAULTS).pages).toEqual([null]);
});

it('shows the pages beside the choices, steps through them, and follows a change of orientation', async () => {
  const { wb, id } = book();
  const ctx = { wb, sheetId: () => id, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} }, doc: { name: 'Stock' } };
  const modal = openPrintDialog(ctx);
  modal.panel.querySelector('[aria-label="Scale"] [data-key="actual"]').click();
  await vi.advanceTimersByTimeAsync(5);
  const preview = modal.panel.querySelector('[aria-label="Print preview"]');
  expect(preview).not.toBeNull();
  const count = () => preview.querySelector('.print-preview-count').textContent;
  const pages = Number(count().match(/of (\d+)/)[1]);
  expect(count()).toBe(`Page 1 of ${pages}`);
  expect(drawn).toContain('Item 1');
  expect(drawn).toContain(`Page 1 of ${pages}`); // the default footer
  expect(drawn).toContain('Stock'); // the title
  const prev = preview.querySelector('[aria-label="Previous page"]'), next = preview.querySelector('[aria-label="Next page"]');
  expect(prev.disabled).toBe(true);
  drawn.length = 0; next.click();
  expect(count()).toBe(`Page 2 of ${pages}`); expect(prev.disabled).toBe(false);
  expect(drawn).not.toContain('Item 1');
  modal.panel.querySelector('[aria-label="Orientation"] [data-key="landscape"]').click();
  await vi.advanceTimersByTimeAsync(5);
  expect(Number(count().match(/of (\d+)/)[1])).toBeGreaterThan(pages);
  // Typing a footer redraws the page with it.
  const footer = modal.panel.querySelector('[aria-label="Footer text"]');
  footer.value = '&LConfidential'; footer.dispatchEvent(new Event('input', { bubbles: true }));
  drawn.length = 0; await vi.advanceTimersByTimeAsync(5);
  expect(drawn).toContain('Confidential');
});
