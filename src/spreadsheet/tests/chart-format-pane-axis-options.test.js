// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';

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
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const flush = async (n = 3) => { for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(1); };
const key = (node, k, extra = {}) => node.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
const viewport = () => view.el.querySelector('.grid-viewport');
const tab = name => [...view.el.querySelectorAll('.ribbon [role="tab"]')].find(n => n.textContent === name);
const button = label => [...view.el.querySelectorAll(`button[aria-label="${label}"]`)].find(b => !b.closest('[hidden]'));
const menuItem = label => [...document.querySelectorAll('.menu [role^="menuitem"]')].find(b => b.querySelector('.menu-label')?.firstChild?.textContent === label);
const dialog = title => document.querySelector(`[role="dialog"][aria-label="${title}"]`);

async function mount() {
  const doc = new Doc({ name: 'Charts' }); const wb = doc.wb; const id = wb.activeSheetId;
  [['Month', 'North', 'South'], ['Jan', '12', '9'], ['Feb', '15', '11'], ['Mar', '9', '14']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
  const name = view.el.querySelector('.name-box'); name.value = 'A1:C4'; key(name, 'Enter'); await flush();
  return { wb, id, chart: () => wb.sheet(id).charts[0] };
}
async function quickChart() {
  viewport().focus();
  key(viewport(), 'F1', { altKey: true }); await flush();
}
const svgNode = sel => view.el.querySelector(`.chart-box .chart-body svg ${sel}`);
async function press(node) {
  node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
  node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
  await flush();
}
const elementBox = () => view.el.querySelector('select[aria-label="Chart Elements"]');


// Format Axis on a box and whisker chart offered a logarithmic scale, reversed values, display units and label
// positions, which the chart, drawing its own axis, never showed.
it.each([['boxWhisker', false], ['stockHlc', false], ['columnClustered', true]])('offers the %s chart only the axis options it draws', async (subtype, full) => {
  const { wb } = await mount();
  const id = wb.activeSheetId;
  [['Date', 'High', 'Low', 'Close'], ['1/1/2024', '5', '3', '4'], ['1/2/2024', '6', '2', '5'], ['1/3/2024', '7', '4', '6']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r + 10, c, v)));
  await view.run('chart', { action: 'insert', subtype, range: { r1: 10, c1: 0, r2: 13, c2: 3 } }); await flush();
  await view.run('chart', { action: 'formatPane', element: 'yAxis' }); await flush();
  const pane = view.el.querySelector('.chart-format-pane');
  expect(pane.hidden).toBe(false);
  const labels = [...pane.querySelectorAll('[aria-label], label.check span')].map(n => n.getAttribute('aria-label') || n.textContent);
  for (const name of ['Minimum', 'Maximum', 'Major', 'Format Code']) expect(labels).toContain(name);
  for (const name of ['Logarithmic scale', 'Values in reverse order', 'Display units', 'Label Position']) expect(labels.includes(name)).toBe(full);
});
