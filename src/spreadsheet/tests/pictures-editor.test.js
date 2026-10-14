// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { session } from '../src/lib/session.js';
import * as P from '../src/lib/puter.js';
import { closeMenu } from '../src/ui/menu.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SRC = `data:image/png;base64,${PNG}`;
const bytes = Uint8Array.from(atob(PNG), ch => ch.charCodeAt(0));
const picked = { path: '/drive/Pictures/Team logo.png', name: 'Team logo.png', item: { size: bytes.length } };
const settle = () => vi.advanceTimersByTimeAsync(5);
let view, readers, initialSession;

beforeEach(() => {
  const stored = new Map();
  vi.stubGlobal('localStorage', { getItem: k => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)), removeItem: k => stored.delete(k) });
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: t => ({ width: t.length * 7 }), font: '' });
  readers = [];
  vi.stubGlobal('FileReader', class { readAsDataURL(file) { this.file = file; readers.push(this); } });
  vi.stubGlobal('Image', class { naturalWidth = 900; naturalHeight = 450; set src(value) { this.onload?.(); } });
  vi.spyOn(P, 'canPickFiles').mockReturnValue(true);
  vi.spyOn(P, 'pickFile').mockResolvedValue(picked);
  vi.spyOn(P, 'readFile').mockResolvedValue(bytes.buffer);
  initialSession = session.state;
  session.state = 'in';
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  closeMenu(); view?.destroy(); view = null; session.state = initialSession;
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();
});
async function setup() {
  const doc = new Doc({ name: 'Pictures' }), wb = doc.wb, id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Item'); wb.setInput(id, 0, 1, 'Qty');
  wb.setInput(id, 1, 0, 'Pens'); wb.setInput(id, 1, 1, '12');
  wb.clearHistory(); wb.markClean();
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, templateDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await settle();
  return { doc, wb, id };
}
const box = id => view.el.querySelector(`[data-chart="${id}"]`);
function select(objectId) {
  const node = box(objectId);
  node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
  node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
}

it('places a picture from Puter into the active cell, as one undoable step that keeps the cell format', async () => {
  const { wb, id } = await setup();
  wb.applyStyle(id, { r1: 3, c1: 2, r2: 3, c2: 2 }, { bg: '#ffeeaa' }); wb.clearHistory();
  view.goTo('Sheet1!C4');
  view.run('insertImagePuter', 'cell'); await settle();
  readers[0].result = SRC; readers[0].onload(); await settle();
  expect(wb.getCell(id, 3, 2)).toMatchObject({ v: { image: SRC, fit: 'contain', alt: 'Team logo' }, s: { bg: '#ffeeaa' } });
  expect(wb.sheet(id).charts).toHaveLength(0);
  const cell = view.el.querySelector('#gc-3-2');
  expect(cell.classList.contains('img-cell')).toBe(true);
  expect(cell.querySelector('img').getAttribute('alt')).toBe('Team logo');
  expect(cell.getAttribute('aria-label')).toBe('Picture: Team logo');
  wb.undo(); expect(wb.getValue(id, 3, 2)).toBeNull();
});

it('lifts a cell picture out over the cells and puts a floating one back in, each one step', async () => {
  const { wb, id } = await setup();
  wb.setCells(id, [{ r: 4, c: 1, cell: { v: { image: SRC, fit: 'contain', alt: 'Badge' }, s: { bold: true } } }], 'Setup'); wb.clearHistory();
  view.goTo('Sheet1!B5');
  await view.run('placeOverCells'); await settle();
  const [obj] = wb.sheet(id).charts;
  expect(obj).toMatchObject({ type: 'image', src: SRC, description: 'Badge', anchor: { r: 4, c: 1 }, w: 480, h: 240 });
  expect(wb.getCell(id, 4, 1)).toMatchObject({ v: null, s: { bold: true } });
  wb.undo();
  expect(wb.sheet(id).charts).toHaveLength(0);
  expect(wb.getValue(id, 4, 1)).toMatchObject({ image: SRC, alt: 'Badge' });
  wb.redo();
  const objectId = wb.sheet(id).charts[0].id;
  wb.updateChart(id, objectId, { anchor: { r: 6, c: 3 }, dx: 2, dy: 2 }, 'Move'); await settle();
  await view.run('placeObjectInCell', objectId); await settle();
  expect(wb.sheet(id).charts).toHaveLength(0);
  expect(wb.getValue(id, 6, 3)).toEqual({ image: SRC, fit: 'contain', alt: 'Badge' });
  wb.undo();
  expect(wb.sheet(id).charts).toHaveLength(1);
  expect(wb.getValue(id, 6, 3)).toBeNull();
});

it('pastes copied cells as a linked picture that follows them and is retargeted from the formula bar', async () => {
  const { wb, id } = await setup();
  view.goTo('Sheet1!A1:B2'); await view.run('copy'); await settle();
  view.goTo('Sheet1!E2'); await view.run('pasteWith', { picture: 'linked' }); await settle();
  const [obj] = wb.sheet(id).charts;
  expect(obj).toMatchObject({ type: 'image', pictureRef: 'Sheet1!$A$1:$B$2', anchor: { r: 1, c: 4 } });
  // Drawn inline, so the cells' fonts apply to it as they do on the sheet.
  const svgText = () => box(obj.id).querySelector('.chart-body > svg').outerHTML;
  expect(svgText()).toContain('>12<');
  wb.setInput(id, 1, 1, '99'); await settle();
  expect(svgText()).toContain('>99<');
  // The formula bar shows the cells the picture draws; Enter there points it at others.
  const input = view.el.querySelector('.formula-input');
  expect(input.value).toBe('=Sheet1!$A$1:$B$2');
  expect(view.el.querySelector('.name-box').value).toBe('Linked picture');
  input.focus(); input.value = '=A2:B2';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle();
  expect(wb.chartById(id, obj.id).pictureRef).toBe('Sheet1!$A$2:$B$2');
  expect(wb.getValue(id, 0, 0)).toBe('Item'); // no cell was edited
  input.focus(); input.value = '=Nowhere!A1';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle();
  expect(wb.chartById(id, obj.id).pictureRef).toBe('Sheet1!$A$2:$B$2');
  // A static picture keeps what it showed.
  view.goTo('Sheet1!A1:B2'); await view.run('copy'); view.goTo('Sheet1!H2');
  await view.run('pasteWith', { picture: true }); await settle();
  expect(wb.sheet(id).charts[1].pictureRef).toBeUndefined();
});

it('offers Picture Format for a selected picture and applies its commands to it with undo', async () => {
  const { wb, id } = await setup();
  const objectId = wb.addChart(id, { type: 'image', src: SRC, title: 'Logo', anchor: { r: 3, c: 1 }, dx: 0, dy: 0, w: 200, h: 100 });
  wb.clearHistory(); await settle();
  select(objectId); await settle();
  const tab = [...view.el.querySelectorAll('[role=tab]')].find(t => t.textContent === 'Picture Format');
  expect(tab.hidden).toBe(false);
  expect(tab.getAttribute('aria-selected')).toBe('true');
  await view.run('pictureFormat', { action: 'adjust', adjust: { brightness: 0.2, contrast: -0.2 } });
  await view.run('pictureFormat', { action: 'style', style: 'dropShadow' });
  await view.run('pictureFormat', { action: 'transparency', transparency: 0.5 });
  await view.run('pictureFormat', { action: 'cropAspect', ratio: 1 });
  await view.run('pictureFormat', { action: 'size', h: 50 });
  await settle();
  const obj = wb.chartById(id, objectId);
  expect(obj).toMatchObject({ adjust: { brightness: 0.2, contrast: -0.2 }, shadow: true, transparency: 0.5, srcRect: { l: 0.25, r: 0.25 }, w: 50, h: 50 });
  const node = box(objectId);
  expect(node.querySelector('feComponentTransfer')).not.toBeNull();
  expect(node.querySelector('.chart-body > svg').style.opacity).toBe('0.5');
  expect(node.querySelector('.chart-body').style.boxShadow).toMatch(/rgba/);
  await view.run('pictureFormat', { action: 'reset' });
  expect(wb.chartById(id, objectId).adjust).toBeUndefined();
  for (let i = 0; i < 6; i++) wb.undo();
  expect(wb.chartById(id, objectId)).toMatchObject({ w: 200, h: 100 });
  expect(wb.chartById(id, objectId).adjust).toBeUndefined();
});
