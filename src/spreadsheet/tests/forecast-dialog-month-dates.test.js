// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';

let view;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
  localStorage.clear(); document.body.replaceChildren();
});
afterEach(() => { closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function open(setup) {
  const doc = new Doc({ name: 'Forecast' }); const wb = doc.wb; const id = wb.activeSheetId;
  setup(wb, id);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await vi.advanceTimersByTimeAsync(1);
  [...view.el.querySelectorAll('.ribbon [role="tab"]')].find(t => t.textContent === 'Data').click(); await vi.advanceTimersByTimeAsync(1);
  return { wb, id };
}

const ribbon = (label) => [...view.el.querySelectorAll('.ribbon-panels button')].find(b => b.getAttribute('aria-label') === label);

// The Forecast End and Start boxes show their dates in the timeline's own format and read back what they show. A
// monthly timeline formatted mmm-yy showed its end as "Apr-24", which reads back as 24 April of the current year,
// so an untouched dialog forecast two and a half years instead of four months.
it('keeps the default end and start of a month-year timeline', async () => {
  const { wb } = await open((wb, id) => {
    [12, 15, 14, 18, 16, 19, 21, 20, 23, 25, 24, 27].forEach((v, i) => {
      wb.setInput(id, i, 0, `2023-${String(i + 1).padStart(2, '0')}-01`);
      wb.setInput(id, i, 1, String(v));
    });
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 11, c2: 0 }, { fmt: 'custom', code: 'mmm-yy' });
  });
  view.goTo('A1:B12'); await vi.advanceTimersByTimeAsync(1);
  ribbon('Forecast Sheet').click(); await vi.advanceTimersByTimeAsync(1);
  const form = document.querySelector('.fs-dialog');
  expect(form.querySelector('input[id*="fs-end"]').value).toBe('Apr-24');
  form.requestSubmit(); await vi.advanceTimersByTimeAsync(1);
  const sheet = wb.sheets.find(s => s.charts.length);
  expect(wb.getDisplay(sheet.id, 16, 0)).toBe('Apr-24'); // twelve months of history, then four forecast
  expect(wb.getValue(sheet.id, 17, 0)).toBeNull();
});
