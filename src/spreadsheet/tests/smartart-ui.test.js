// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';
import { buildPrintSheet } from '../src/ui/print.js';
import { newSmartArt } from '../src/core/smartart.js';

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
const flush = () => vi.advanceTimersByTimeAsync(1);
async function mount() {
  const doc = new Doc({ name: 'Diagrams' }); const wb = doc.wb; const id = wb.activeSheetId;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
  return { wb, id };
}
const tabs = () => [...view.el.querySelectorAll('.ribbon [role="tab"]')];
const tab = async name => { tabs().find(n => n.textContent === name && !n.hidden).click(); await flush(); };
const ribbonButton = label => [...view.el.querySelectorAll('.ribbon-panels button')].find(b => b.getAttribute('aria-label') === label && !b.closest('[hidden]')) || null;
const paneInputs = () => [...view.el.querySelectorAll('.sa-pane-input')];
const key = (el, k, o = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
/** A press on the diagram's box, as a click on the sheet selects it. */
const select = async (d) => {
  await flush();
  const node = view.el.querySelector(`.chart-box[data-chart="${d}"]`);
  node.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
  node.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
  await flush();
};
const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };

it('inserts a diagram from the gallery, with its tabs and its Text Pane', async () => {
  const { wb, id } = await mount();
  view.goTo('B2'); await flush();
  await tab('Insert');
  ribbonButton('Insert SmartArt graphic').click(); await flush();
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog.querySelectorAll('.sa-gallery-tile').length).toBeGreaterThanOrEqual(30);
  [...dialog.querySelectorAll('.sa-gallery-cat')].find(c => c.textContent === 'Cycle').click();
  expect([...dialog.querySelectorAll('.sa-gallery-tile')].every(t => ['basicCycle', 'radialCycle', 'segmentedCycle', 'textCycle', 'blockCycle'].includes(t.dataset.id))).toBe(true);
  dialog.querySelector('.sa-gallery-tile[data-id="radialCycle"]').click();
  expect(dialog.querySelector('.sa-gallery-name').textContent).toBe('Hub and Spokes');
  dialog.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
  const [obj] = wb.sheet(id).charts;
  expect(obj).toMatchObject({ type: 'smartart', layout: 'radialCycle', anchor: { r: 1, c: 1 } });
  // The diagram is drawn on the sheet and described from its text.
  const box = view.el.querySelector('.smartart-box');
  expect(box.querySelector('svg [data-item]')).not.toBeNull();
  expect(box.getAttribute('aria-label')).toMatch(/^SmartArt graphic: Hub and Spokes diagram: Customer/);
  // Its two tabs, the Design one open; the Text Pane shows its outline.
  const visible = tabs().filter(t => !t.hidden).map(t => t.textContent);
  expect(visible).toContain('SmartArt Design');
  expect(visible).toContain('Format');
  expect(tabs().find(t => t.getAttribute('aria-selected') === 'true').textContent).toBe('SmartArt Design');
  expect(paneInputs().map(i => i.value)).toEqual(obj.items.map(it => it.text));
  wb.undo(); await flush();
  expect(wb.sheet(id).charts).toHaveLength(0);
  expect(tabs().find(t => t.textContent === 'SmartArt Design').hidden).toBe(true);
});

it('edits the outline from the keyboard in the Text Pane, one undo step per edit', async () => {
  const { wb, id } = await mount();
  const d = wb.addChart(id, { ...newSmartArt('basicProcess', [{ text: 'Plan', level: 0 }, { text: 'Build', level: 0 }]), anchor: { r: 1, c: 1 }, w: 400, h: 200 });
  await select(d);
  view.run('editChart', d); await flush();
  let inputs = paneInputs();
  expect(inputs.map(i => i.value)).toEqual(['Plan', 'Build']);
  // Typing, letter by letter, is one step.
  inputs[1].focus();
  for (const v of ['Buil', 'Build it', 'Build it all']) type(inputs[1], v);
  expect(wb.chartById(id, d).items[1].text).toBe('Build it all');
  // Enter starts a new item after this one; Tab makes it a sub-item.
  inputs[1].setSelectionRange(12, 12); key(inputs[1], 'Enter'); await flush();
  inputs = paneInputs();
  expect(inputs).toHaveLength(3);
  expect(document.activeElement).toBe(inputs[2]);
  type(inputs[2], 'Test'); key(inputs[2], 'Tab'); await flush();
  expect(wb.chartById(id, d).items).toEqual([{ text: 'Plan', level: 0 }, { text: 'Build it all', level: 0 }, { text: 'Test', level: 1 }]);
  expect(paneInputs()[2].parentElement.style.getPropertyValue('--level')).toBe('1');
  // Shift+Tab promotes again; Alt+Shift+Up moves it up past its sibling.
  key(paneInputs()[2], 'Tab', { shiftKey: true }); await flush();
  key(paneInputs()[2], 'ArrowUp', { altKey: true, shiftKey: true }); await flush();
  expect(wb.chartById(id, d).items.map(it => it.text)).toEqual(['Plan', 'Test', 'Build it all']);
  // Backspace at the start of an empty item removes it.
  key(paneInputs()[1], 'Enter'); await flush();
  const empty = paneInputs()[2];
  expect(empty.value).toBe('');
  empty.setSelectionRange(0, 0); key(empty, 'Backspace'); await flush();
  expect(wb.chartById(id, d).items.map(it => it.text)).toEqual(['Plan', 'Test', 'Build it all']);
  // Each edit undoes on its own: the move, the promote, the demote, the new item, then all the typing.
  for (let i = 0; i < 2; i++) wb.undo();
  expect(wb.chartById(id, d).items.map(it => it.text)).toEqual(['Plan', 'Test', 'Build it all']);
  for (let i = 0; i < 4; i++) wb.undo();
  expect(wb.chartById(id, d).items.map(it => it.text)).toEqual(['Plan', 'Build it all', '']);
  wb.undo(); wb.undo();
  expect(wb.chartById(id, d).items.map(it => it.text)).toEqual(['Plan', 'Build']);
});

it('runs the SmartArt Design and Format commands on the shape picked', async () => {
  const { wb, id } = await mount();
  const d = wb.addChart(id, { ...newSmartArt('basicProcess', [{ text: 'A', level: 0 }, { text: 'B', level: 0 }, { text: 'C', level: 0 }]), anchor: { r: 1, c: 1 }, w: 400, h: 200 });
  await select(d);
  await tab('SmartArt Design');
  expect(ribbonButton('Promote').disabled).toBe(true);
  view.run('smartArt', { action: 'pick', id: d, item: 1 }); await flush();
  expect(view.el.querySelector('.smartart-box .sa-sel')).not.toBeNull();
  expect(ribbonButton('Demote').disabled).toBe(false);
  ribbonButton('Demote').click(); await flush();
  expect(wb.chartById(id, d).items[1]).toEqual({ text: 'B', level: 1 });
  view.run('smartArt', { action: 'add', where: 'below' }); await flush();
  expect(wb.chartById(id, d).items.map(it => [it.text, it.level])).toEqual([['A', 0], ['B', 1], ['', 2], ['C', 0]]);
  view.run('smartArt', { action: 'rtl' }); await flush();
  expect(wb.chartById(id, d).rtl).toBe(true);
  view.run('smartArt', { action: 'layout', layout: 'orgChart' }); await flush();
  view.run('smartArt', { action: 'colors', colors: 'colorful2' }); await flush();
  view.run('smartArt', { action: 'style', style: 'intense' }); await flush();
  expect(wb.chartById(id, d)).toMatchObject({ layout: 'orgChart', colors: 'colorful2', style: 'intense' });
  // Format: the picked shape's fill and size; Reset Graphic clears them and the style.
  view.run('smartArt', { action: 'pick', id: d, item: 0 }); await flush();
  await tab('Format');
  expect(ribbonButton('Larger').disabled).toBe(false);
  ribbonButton('Larger').click(); await flush();
  view.run('smartArt', { action: 'format', fill: '#ff0000' }); await flush();
  view.run('smartArt', { action: 'shape', shape: 'ellipse' }); await flush();
  expect(wb.chartById(id, d).items[0].fmt).toEqual({ fill: '#ff0000', scale: 1.1, shape: 'ellipse' });
  view.run('smartArt', { action: 'reset' }); await flush();
  expect(wb.chartById(id, d).items[0].fmt).toBeUndefined();
  expect(wb.chartById(id, d).style).toBe('flat');
  // Every one of those was its own step.
  wb.undo(); expect(wb.chartById(id, d).items[0].fmt).toEqual({ fill: '#ff0000', scale: 1.1, shape: 'ellipse' });
});

it('converts a diagram to a group of ordinary shapes, as one step', async () => {
  const { wb, id } = await mount();
  const d = wb.addChart(id, { ...newSmartArt('basicProcess', [{ text: 'A', level: 0 }, { text: 'B', level: 0 }]), anchor: { r: 1, c: 1 }, w: 400, h: 200 });
  await select(d);
  view.run('smartArt', { action: 'convert' }); await flush();
  const objects = wb.sheet(id).charts;
  expect(objects.some(o => o.type === 'smartart')).toBe(false);
  expect(objects.length).toBeGreaterThanOrEqual(3);
  expect(new Set(objects.map(o => o.group)).size).toBe(1);
  expect(objects.filter(o => o.type === 'image').length).toBeGreaterThanOrEqual(1);
  wb.undo();
  expect(wb.sheet(id).charts.map(o => o.type)).toEqual(['smartart']);
});

it('prints the diagram as it shows', async () => {
  const { wb, id } = await mount();
  wb.setInput(id, 0, 0, 'Plan');
  wb.addChart(id, { ...newSmartArt('basicPyramid'), anchor: { r: 1, c: 1 }, w: 300, h: 200 });
  const sheet = buildPrintSheet(wb, id, {});
  const node = sheet.querySelector('.print-object svg');
  expect(node).not.toBeNull();
  expect(node.getAttribute('aria-label')).toMatch(/^Pyramid diagram: Vision/);
  expect(node.textContent).toContain('Strategy');
});

it('takes a new diagram\'s outline from the cells selected, a column further right a level deeper', async () => {
  const { wb, id } = await mount();
  [['Plan', ''], ['', 'Budget'], ['', 'People'], ['Ship', '']].forEach((row, r) => row.forEach((v, c) => { if (v) wb.setInput(id, r, c, v); }));
  view.goTo('A1:B4'); await flush();
  view.run('smartArt', { action: 'insert', layout: 'hierarchyList' }); await flush();
  const obj = wb.sheet(id).charts[0];
  expect(obj.items).toEqual([{ text: 'Plan', level: 0 }, { text: 'Budget', level: 1 }, { text: 'People', level: 1 }, { text: 'Ship', level: 0 }]);
  expect(obj.anchor).toEqual({ r: 0, c: 0 });
  // Alt text: left empty, it reads out the diagram's text, which the dialog offers to start from.
  view.run('altText', obj.id); await flush();
  const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  expect(dialog.querySelector('textarea').placeholder).toBe('Tree List diagram: Plan (Budget, People); Ship');
  dialog.querySelector('.alt-text-fill').click();
  dialog.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
  expect(wb.sheet(id).charts[0].description).toBe('Tree List diagram: Plan (Budget, People); Ship');
});
