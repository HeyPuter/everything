// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { pageLayoutMetrics } from '../src/ui/page-layout.js';
import { pageBreaks, pagesOf } from '../src/ui/pagebreaks.js';
import { printPreviewJob } from '../src/ui/print-preview.js';
import { currentPrintPrefs } from '../src/ui/printdialog.js';
import { effectivePrintSettings, savePrintPrefs, PRINT_DEFAULTS } from '../src/ui/print.js';

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: String(t).length * 7 }), font: '' });
  localStorage.clear();
});
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

/** 20 columns by 80 rows, with no page setup of its own. */
function wide() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < 80; r++) for (let c = 0; c < 20; c++) wb.setInput(id, r, c, String(r * 20 + c));
  return { wb, id };
}
const layoutPages = (wb, id) => { const p = pageLayoutMetrics(wb, id).printed; return (p.a1 - p.a0 + 1) * (p.d1 - p.d0 + 1); };
const printedPages = (wb, id) => printPreviewJob(wb, id, currentPrintPrefs(wb.sheet(id))).length;

describe('a sheet with no page setup of its own', () => {
  it('is laid out in Page Layout and Page Break Preview as it prints', () => {
    const { wb, id } = wide();
    const prints = printedPages(wb, id);
    expect(prints).toBe(1); // fitted to the page's width, as the print does by default
    expect(layoutPages(wb, id)).toBe(prints);
    expect(pagesOf(pageBreaks(wb, id))).toHaveLength(prints);
  });

  it('follows the choices the print was last made with', () => {
    const { wb, id } = wide();
    savePrintPrefs({ ...PRINT_DEFAULTS, fit: 'actual' });
    const prints = printedPages(wb, id);
    expect(prints).toBeGreaterThan(1);
    expect(layoutPages(wb, id)).toBe(prints);
    expect(pagesOf(pageBreaks(wb, id))).toHaveLength(prints);
  });

  it('keeps a sheet\'s own page setup as it is', () => {
    const { wb, id } = wide();
    wb.setPrintSettings(id, { margins: {}, scale: 100 });
    expect(effectivePrintSettings(wb.sheet(id))).toBe(wb.sheet(id).printSettings);
    expect(effectivePrintSettings(wb.sheet(id)).fitToPage).toBe(false);
    expect(layoutPages(wb, id)).toBe(printedPages(wb, id));
  });
});

describe('a Page Layout change on a sheet with no page setup of its own', () => {
  it('starts from the setup it prints with, rather than switching the print to 100%', async () => {
    const { Blob: NodeBlob } = await import('node:buffer');
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
    const { editorView } = await import('../src/views/editor.js');
    const { Doc } = await import('../src/lib/doc.js');
    const doc = new Doc({ name: 'Wide' });
    const id = doc.wb.activeSheetId;
    for (let r = 0; r < 80; r++) for (let c = 0; c < 20; c++) doc.wb.setInput(id, r, c, String(r * 20 + c));
    const view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, templateDoc() {}, importFile() {} });
    document.body.append(view.el);
    try {
      const before = effectivePrintSettings(doc.wb.sheet(id));
      await view.run('pageSetup', { orientation: 'landscape' });
      const p = doc.wb.sheet(id).printSettings;
      expect(p).toMatchObject({ orientation: 'landscape', fitToPage: true, fitWidth: 1, fitHeight: 0 });
      expect(p.margins.left).toBeCloseTo(before.margins.left);
      // Still one page wide, as before the change; the turned page fits fewer rows.
      expect(pageLayoutMetrics(doc.wb, id).printed.a1).toBe(pageLayoutMetrics(doc.wb, id).printed.a0);
      expect(layoutPages(doc.wb, id)).toBe(printedPages(doc.wb, id));
    } finally { view.destroy(); document.body.replaceChildren(); vi.unstubAllGlobals(); }
  });
});
