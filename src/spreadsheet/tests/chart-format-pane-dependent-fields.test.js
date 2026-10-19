// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';

let view;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
  localStorage.clear(); document.body.replaceChildren();
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const flush = async () => { for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1); };

async function openPane(element) {
  const doc = new Doc({ name: 'Pane' }), wb = doc.wb, id = wb.activeSheetId;
  [['Month', 'Sales'], ['Jan', '12'], ['Feb', '15']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 2, c2: 1 }, 'columnClustered'));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
  const box = view.el.querySelector('.chart-box');
  box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
  box.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
  await flush();
  view.run('chart', { action: 'formatPane', element }); await flush();
  return { wb, chart: () => wb.chartById(id, chartId), pane: view.el.querySelector('.chart-format-pane') };
}

it('shows the colour of a Solid fill picked in the Format pane at once, the fill box keeping the focus', async () => {
  const { chart, pane } = await openPane('plotArea');
  const fill = pane.querySelector('select[aria-label="Fill"]');
  fill.focus();
  expect(pane.querySelector('input[aria-label="Fill Color"]')).toBeNull();
  fill.value = 'solid'; fill.dispatchEvent(new Event('change')); await flush();
  expect(chart().appearance.plotFill).toBe('#4472c4');
  expect(pane.querySelector('input[aria-label="Fill Color"]')).not.toBeNull();
  expect(document.activeElement).toBe(pane.querySelector('select[aria-label="Fill"]'));
});

it('leaves the pane as it is while a change from elsewhere arrives during typing', async () => {
  const { wb, pane } = await openPane('title');
  const text = pane.querySelector('input[aria-label="Text"]');
  text.focus(); text.value = 'Half-typed';
  wb.setInput(wb.activeSheetId, 5, 5, 'elsewhere'); await flush();
  expect(pane.querySelector('input[aria-label="Text"]')).toBe(text);
  expect(text.value).toBe('Half-typed');
});
