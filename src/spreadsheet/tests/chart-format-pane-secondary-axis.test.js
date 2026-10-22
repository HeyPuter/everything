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


// Format Axis on a combo chart's secondary axis offered only its line: no bounds, unit, number format, order or
// text size, though the chart draws all of them on that axis (and keeps them from an Excel file).
it('offers the secondary axis the options of the primary one, set on the secondary axis', async () => {
  const { wb, id, chart } = await mount();
  wb.setInput(id, 0, 2, 'Margin'); ['0.2', '0.3', '0.4'].forEach((v, r) => wb.setInput(id, r + 1, 2, v));
  await view.run('chart', { action: 'insert', subtype: 'comboColumnLineSecondary', range: { r1: 0, c1: 0, r2: 3, c2: 2 } }); await flush();
  await view.run('chart', { action: 'formatPane', element: 'y2Axis' }); await flush();
  const pane = view.el.querySelector('.chart-format-pane');
  expect(pane.hidden).toBe(false);
  const labels = [...pane.querySelectorAll('[aria-label], label.check span')].map(n => n.getAttribute('aria-label') || n.textContent);
  for (const name of ['Minimum', 'Maximum', 'Major', 'Display units', 'Values in reverse order', 'Label Position', 'Format Code', 'Size (pt)']) expect(labels).toContain(name);
  expect(labels).not.toContain('Logarithmic scale');
  const set = (label, value) => { const input = pane.querySelector(`input[aria-label="${label}"]`); input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); };
  set('Maximum', '1'); await flush();
  set('Format Code', '0%'); await flush();
  expect(chart().appearance).toMatchObject({ y2Max: 1, y2Format: '0%' });
  expect(chart().yMax).toBeNull();
  expect(chart().appearance.yFormat || '').toBe('');
  expect([...view.el.querySelectorAll('.chart-box svg [data-el="y2Axis"]')].map(n => n.textContent)).toContain('100%');
});
