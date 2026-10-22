// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/memory-storage.js';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { session } from '../src/lib/session.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';
import { installMockPuter } from './helpers/mock-puter.js';
import { workbookToXlsx } from '../src/core/io.js';
import { Workbook } from '../src/core/workbook.js';

// Inside the Puter desktop a new spreadsheet is saved where the user picks it, in Puter's Save dialog. Leaving
// one never saved offers leaving beside saving, since the dialog alone left no way out but saving; Save a copy
// opens the dialog without first asking for a name.
let view;
let mock;
let answer;
beforeAll(async () => { await workbookToXlsx(new Workbook()); });
beforeEach(async () => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
  mock = installMockPuter();
  puter.env = 'app';
  answer = 'Budget.xlsx';
  // Puter's Save dialog: it writes the file in ~/Desktop under the name answered, or is cancelled (null).
  puter.ui.showSaveFilePicker = vi.fn((blob) => {
    if (answer == null) return Object.assign(new Promise(() => {}), { undefinedOnCancel: Promise.resolve(undefined) });
    const path = `~/Desktop/${answer}`;
    mock.fs.set(path, { blob, size: blob.size, modified: Date.now() / 1000, uid: 'uid-dialog' });
    const saved = Promise.resolve({ name: answer, path, uid: 'uid-dialog' });
    return Object.assign(saved, { undefinedOnCancel: saved });
  });
  await session.init();
});
afterEach(() => {
  closeMenu();
  closeAllModals();
  view?.destroy();
  view = null;
  session.state = 'unknown';
  session.user = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete globalThis.puter;
  document.body.replaceChildren();
});

function setup(doc = Doc.blank()) {
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  return doc;
}

const until = async (test) => { for (let i = 0; i < 200 && !test(); i++) await new Promise((r) => setTimeout(r, 5)); return test(); };
const modal = (title) => document.querySelector(`.modal-panel[aria-label="${title}"]`);
const press = (title, label) => [...modal(title).querySelectorAll('button')].find((b) => b.textContent === label).click();
const menuItem = (text) => [...document.querySelectorAll('.menu-item')].find((item) => item.querySelector('.menu-label')?.textContent === text);

it('offers to leave a new spreadsheet unsaved, the draft keeping it, without opening the Save dialog', async () => {
  const doc = setup();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Rent');
  const leaving = view.flush();
  expect(await until(() => modal('Save before leaving?'))).toBeTruthy();
  press('Save before leaving?', 'Leave');
  expect(await leaving).toBe(true);
  expect(puter.ui.showSaveFilePicker).not.toHaveBeenCalled();
  expect(doc.path).toBeNull();
});

it('saves a new spreadsheet on the way out where the Save dialog puts it', async () => {
  const doc = setup();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Rent');
  const leaving = view.flush();
  expect(await until(() => modal('Save before leaving?'))).toBeTruthy();
  press('Save before leaving?', 'Save…');
  expect(await leaving).toBe(true);
  expect(puter.ui.showSaveFilePicker).toHaveBeenCalledTimes(1);
  expect(doc.path).toBe('~/Desktop/Budget.xlsx');
});

it('stays when the Save dialog on the way out is cancelled', async () => {
  answer = null;
  const doc = setup();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Rent');
  const leaving = view.flush();
  expect(await until(() => modal('Save before leaving?'))).toBeTruthy();
  press('Save before leaving?', 'Save…');
  expect(await leaving).toBe(false);
  expect(doc.path).toBeNull();
  expect(doc.wb.dirty).toBe(true);
});

it('leaves an unchanged new spreadsheet without asking', async () => {
  setup();
  expect(await view.flush()).toBe(true);
  expect(modal('Save before leaving?')).toBeNull();
  expect(puter.ui.showSaveFilePicker).not.toHaveBeenCalled();
});

it('opens the Save dialog for Save a copy, without asking for a name first', async () => {
  mock.fs.set('Spreadsheets/Plan.xlsx', { blob: new Blob(['x']), size: 1, modified: 1 });
  const doc = setup(new Doc({ name: 'Plan', path: 'Spreadsheets/Plan.xlsx' }));
  answer = 'Plan 2027.xlsx';
  view.el.querySelector('[data-menu="file"]').click();
  menuItem('Save a copy…').click();
  expect(await until(() => doc.path === '~/Desktop/Plan 2027.xlsx')).toBe(true);
  expect(modal('Save a copy')).toBeNull();
  expect(puter.ui.showSaveFilePicker.mock.calls[0][1]).toBe('Plan copy.xlsx');
  expect(doc.name).toBe('Plan 2027');
});

it('says nothing when the Save a copy dialog is cancelled', async () => {
  mock.fs.set('Spreadsheets/Plan.xlsx', { blob: new Blob(['x']), size: 1, modified: 1 });
  const doc = setup(new Doc({ name: 'Plan', path: 'Spreadsheets/Plan.xlsx' }));
  answer = null;
  view.el.querySelector('[data-menu="file"]').click();
  menuItem('Save a copy…').click();
  expect(await until(() => puter.ui.showSaveFilePicker.mock.calls.length === 1)).toBe(true);
  await new Promise((r) => setTimeout(r, 20));
  expect(doc.path).toBe('Spreadsheets/Plan.xlsx');
  expect(document.querySelector('.toast')).toBeNull();
});

it('says a new spreadsheet is not saved yet, AutoSave or not, and saves it from the pill', async () => {
  const doc = setup();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Rent');
  doc.dispatchEvent(new CustomEvent('status'));
  const pill = view.el.querySelector('.save-status');
  expect(await until(() => pill.textContent === 'Not saved yet')).toBe(true);
  await new Promise((r) => setTimeout(r, 1700)); // past the AutoSave delay: nothing is written
  expect(puter.ui.showSaveFilePicker).not.toHaveBeenCalled();
  expect(pill.disabled).toBe(false);
  pill.click();
  expect(await until(() => doc.path === '~/Desktop/Budget.xlsx')).toBe(true);
  expect(await until(() => pill.textContent === 'Saved')).toBe(true);
  expect(pill.disabled).toBe(true);
});

it('says where the changes to a .csv from the drive are kept when it is left unsaved', async () => {
  // A file of another kind is on Puter already, and its draft is offered when it is opened again, not listed
  // under Unsaved spreadsheets: the question said both of a new spreadsheet only.
  mock.fs.set('~/Desktop/data.csv', { blob: new Blob(['a,b']), size: 3, modified: 1 });
  const doc = setup(new Doc({ name: 'data', path: '~/Desktop/data.csv' }));
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Rent');
  const leaving = view.flush();
  expect(await until(() => modal('Save before leaving?'))).toBeTruthy();
  const text = modal('Save before leaving?').querySelector('.modal-text').textContent;
  expect(text).toContain('Your changes to "data.csv" are not saved yet');
  expect(text).toContain('offered again when you open data.csv here');
  expect(text).not.toContain('Unsaved spreadsheets');
  expect(text).not.toContain('not saved to Puter yet');
  press('Save before leaving?', 'Leave');
  expect(await leaving).toBe(true);
});
