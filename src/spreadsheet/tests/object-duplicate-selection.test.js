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

// Ctrl+D (or Duplicate) with a group selected, or several objects, copied only the one pressed, and took
// that copy out of the group: the rest of the group, or of the selection, was left behind. Every object
// selected is copied now, a group's copies grouped among themselves, as one undo step.
async function mount() {
  const doc = new Doc({ name: 'Objects' }); const wb = doc.wb; const id = wb.activeSheetId;
  const a = wb.addChart(id, { type: 'text', text: 'One', anchor: { r: 2, c: 1 }, w: 120, h: 60 });
  const b = wb.addChart(id, { type: 'text', text: 'Two', anchor: { r: 2, c: 4 }, w: 120, h: 60 });
  const c = wb.addChart(id, { type: 'text', text: 'Three', anchor: { r: 9, c: 1 }, w: 120, h: 60 });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
  return { wb, id, a, b, c, texts: () => wb.sheet(id).charts.map(o => [o.text, o.group || null]) };
}
const press = async (objectId, extra = {}) => {
  const box = view.el.querySelector(`.chart-box[data-chart="${objectId}"]`);
  box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5, pointerId: 1, ...extra }));
  box.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5, pointerId: 1, ...extra }));
  await flush();
};

it('duplicates a whole group, its copies a group of their own', async () => {
  const { wb, id, a, b, texts } = await mount();
  const group = wb.groupObjects(id, [a, b]);
  await press(a);
  view.run('duplicateChart', { id: a }); await flush();
  const all = texts();
  expect(all.map(t => t[0])).toEqual(['One', 'Two', 'Three', 'One', 'Two']);
  expect(all[3][1]).toBeTruthy();
  expect(all[3][1]).not.toBe(group);
  expect(all[4][1]).toBe(all[3][1]);
  expect(wb.undoLabel()).toBe('Duplicate objects');
  wb.undo();
  expect(texts().map(t => t[0])).toEqual(['One', 'Two', 'Three']);
});

it('duplicates every object selected, and only the one pressed when it is alone', async () => {
  const { wb, a, c, texts } = await mount();
  await press(a); await press(c, { shiftKey: true });
  view.run('duplicateChart', { id: c }); await flush();
  expect(texts()).toEqual([['One', null], ['Two', null], ['Three', null], ['One', null], ['Three', null]]);
  await press(a);
  view.run('duplicateChart', { id: a }); await flush();
  expect(texts().map(t => t[0])).toEqual(['One', 'Two', 'Three', 'One', 'Three', 'One']);
  expect(wb.undoLabel()).toBe('Duplicate text box');
});
