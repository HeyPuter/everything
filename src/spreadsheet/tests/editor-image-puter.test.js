// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { session } from '../src/lib/session.js';
import * as P from '../src/lib/puter.js';
import * as notifications from '../src/ui/toast.js';
import { closeMenu } from '../src/ui/menu.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import * as X from '../src/vendor/xlsx.mjs';
import { Blob as NodeBlob } from 'node:buffer';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const bytes = Uint8Array.from(atob(PNG), ch => ch.charCodeAt(0));
const picked = { path: '/drive/Pictures/Company logo.png', name: 'Company logo.png', item: { size: bytes.length } };
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = () => vi.advanceTimersByTimeAsync(5);
let view, readers, notify, initialSession;

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
  notify = vi.spyOn(notifications, 'toast');
  initialSession = session.state;
  session.state = 'in';
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  closeMenu(); view?.destroy(); view = null; session.state = initialSession;
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();
});
async function setup() {
  const doc = new Doc({ name: 'Pictures' }), wb = doc.wb;
  wb.setInput(wb.activeSheetId, 2, 2, 'Covered cell');
  wb.clearHistory(); wb.markClean();
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, templateDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await settle(); view.goTo('Sheet1!C3');
  return { doc, wb, id: wb.activeSheetId };
}
function chooseCloud() {
  view.el.querySelector('[data-menu="insert"]').click();
  const item = label => [...document.querySelectorAll('.menu-item')].find(b => b.querySelector('.menu-label')?.textContent === label);
  item('Image').click(); item('From Puter…').click();
}
async function decode() { readers[0].result = `data:image/png;base64,${PNG}`; readers[0].onload(); await settle(); }

it('embeds a chosen cloud image, preserves cells, supports undo/redo, and exports a native XLSX picture', async () => {
  const { wb, id } = await setup(); chooseCloud(); await settle();
  expect(P.pickFile).toHaveBeenCalledWith({ accept: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'] });
  expect(P.readFile).toHaveBeenCalledWith(picked.path);
  expect(readers[0].file).toMatchObject({ name: picked.name, type: 'image/png' });
  await decode();
  expect(wb.sheet(id).charts).toHaveLength(1);
  expect(wb.sheet(id).charts[0]).toMatchObject({ type: 'image', src: `data:image/png;base64,${PNG}`, title: picked.name, anchor: { r: 2, c: 2 }, w: 480, h: 240 });
  expect(wb.getValue(id, 2, 2)).toBe('Covered cell');
  wb.undo(); expect(wb.sheet(id).charts).toHaveLength(0); expect(wb.canUndo()).toBe(false);
  wb.redo(); expect(wb.sheet(id).charts).toHaveLength(1);
  // Only native parts count: the app's saved metadata must not conceal a missing picture.
  vi.stubGlobal('Blob', NodeBlob);
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const part = X.CFB.find(zip, '/xl/workbook.xml');
  part.content = new TextEncoder().encode(new TextDecoder().decode(part.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, '')); part.size = part.content.length;
  const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }));
  expect(back.sheets[0].charts[0]).toMatchObject({ type: 'image', src: `data:image/png;base64,${PNG}`, anchor: { r: 2, c: 2 }, w: 480, h: 240 });
  expect(back.getValue(back.activeSheetId, 2, 2)).toBe('Covered cell');
});

it('keeps the original destination through a delayed sign-in, picker and file read', async () => {
  const { wb, id } = await setup(), other = wb.addSheet('Other').id; wb.clearHistory(); view.goTo('Sheet1!C3');
  const auth = defer(), picker = defer(), read = defer();
  session.state = 'out'; vi.spyOn(session, 'signIn').mockReturnValue(auth.promise);
  P.pickFile.mockReturnValue(picker.promise); P.readFile.mockReturnValue(read.promise);
  chooseCloud(); view.goTo('Other!D5');
  expect(P.pickFile).not.toHaveBeenCalled(); auth.resolve(true); await settle();
  picker.resolve(picked); await settle(); expect(P.readFile).toHaveBeenCalledWith(picked.path);
  read.resolve(bytes.buffer); await settle(); await decode();
  expect(wb.sheet(id).charts[0].anchor).toEqual({ r: 2, c: 2 });
  expect(wb.sheet(other).charts).toHaveLength(0);
  expect(view.el.querySelector('.grid-viewport').getAttribute('aria-activedescendant')).toContain('4-3');
});

it.each(['sign-in', 'picker'])('does nothing when %s is cancelled', async which => {
  const { wb, id } = await setup();
  if (which === 'sign-in') { session.state = 'out'; vi.spyOn(session, 'signIn').mockResolvedValue(false); }
  else P.pickFile.mockResolvedValue(null);
  chooseCloud(); await settle();
  expect(P.readFile).not.toHaveBeenCalled(); expect(readers).toHaveLength(0);
  expect(wb.sheet(id).charts).toHaveLength(0); expect(wb.canUndo()).toBe(false);
});

it.each(['picker', 'read', 'decode'])('does not insert after the editor closes during %s', async phase => {
  const { wb, id } = await setup(), pending = defer();
  if (phase === 'picker') P.pickFile.mockReturnValue(pending.promise);
  if (phase === 'read') P.readFile.mockReturnValue(pending.promise);
  chooseCloud(); await settle(); view.destroy(); view = null;
  if (phase === 'picker') pending.resolve(picked);
  if (phase === 'read') pending.resolve(bytes.buffer);
  await settle(); if (phase === 'decode') await decode();
  expect(wb.sheet(id).charts).toHaveLength(0); expect(wb.canUndo()).toBe(false);
});

it('refuses protected destinations both before the picker and after a pending read', async () => {
  const { wb, id } = await setup(); wb.setSheetProtected(id, true); wb.clearHistory();
  chooseCloud(); await settle(); expect(P.pickFile).not.toHaveBeenCalled();
  wb.setSheetProtected(id, false);
  const read = defer(); P.readFile.mockReturnValue(read.promise); chooseCloud(); await settle();
  wb.setSheetProtected(id, true); wb.clearHistory(); read.resolve(bytes.buffer); await settle(); await decode();
  expect(wb.sheet(id).charts).toHaveLength(0); expect(wb.canUndo()).toBe(false);
  expect(notify.mock.calls.some(([message]) => /protected/.test(message))).toBe(true);
});

it.each(['metadata', 'actual bytes'])('refuses an oversized image by %s before decoding', async source => {
  const { wb, id } = await setup();
  if (source === 'metadata') P.pickFile.mockResolvedValue({ ...picked, item: { size: 13 * 1024 * 1024 } });
  else { const large = new Uint8Array(13 * 1024 * 1024); large.set(bytes); P.readFile.mockResolvedValue(large.buffer); }
  chooseCloud(); await settle();
  if (source === 'metadata') expect(P.readFile).not.toHaveBeenCalled();
  expect(readers).toHaveLength(0); expect(wb.sheet(id).charts).toHaveLength(0); expect(wb.canUndo()).toBe(false);
  expect(notify.mock.calls.some(([message]) => /12 MB/.test(message))).toBe(true);
});

it('reports a cloud read failure and rejects renamed non-image files without changing the sheet', async () => {
  const { wb, id } = await setup(); P.readFile.mockRejectedValue({ error: { message: 'File access denied' } });
  chooseCloud(); await settle(); expect(notify).toHaveBeenCalledWith(expect.stringContaining('File access denied'), expect.anything());
  P.readFile.mockResolvedValue(new TextEncoder().encode('not an image').buffer); chooseCloud(); await settle();
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('not a supported image'), expect.anything());
  expect(readers).toHaveLength(0); expect(wb.sheet(id).charts).toHaveLength(0); expect(wb.canUndo()).toBe(false);
});

it('offers all sources from the image toolbar and omits the cloud choice when no picker exists', async () => {
  await setup(); const button = view.el.querySelector('.toolbar [aria-label="Pictures"]');
  expect(button.getAttribute('aria-haspopup')).toBe('menu'); button.click();
  expect([...document.querySelectorAll('.menu-label')].map(b => b.textContent)).toEqual(['From this device…', 'From Puter…', 'From a URL…', 'Place in Cell']);
  closeMenu(); P.canPickFiles.mockReturnValue(false); button.click();
  expect([...document.querySelectorAll('.menu-label')].map(b => b.textContent)).toEqual(['From this device…', 'From a URL…', 'Place in Cell']);
});
