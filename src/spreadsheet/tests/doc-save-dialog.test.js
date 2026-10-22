import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Doc, CANCELLED } from '../src/lib/doc.js';
import { installMockPuter } from './helpers/mock-puter.js';
import { memoryStorage } from './helpers/memory-storage.js';

// Inside the Puter desktop a new spreadsheet was written, at the first Save or AutoSave, into the app's own
// data folder, which the user never sees, and Save a copy went there too: neither asked where. Both open
// Puter's Save dialog now, and only a Save asked for does; on the open web the app folder stands.
let mock;
let doc;
beforeEach(() => {
  mock = installMockPuter();
  vi.stubGlobal('localStorage', memoryStorage());
});
afterEach(() => { doc?.destroy(); doc = null; vi.useRealTimers(); vi.unstubAllGlobals(); delete globalThis.puter; });

const documentWrites = () => mock.calls.filter(([op, p]) => op === 'write' && !p.includes('/.versions/')).map(([, p]) => p);

/** Puter's Save dialog, answered with a name in ~/Desktop (true: the one offered), or cancelled (null). */
function inPuter(answer) {
  globalThis.puter.env = 'app';
  const dialog = vi.fn((blob, suggested) => {
    // Like the SDK: the promise of a cancelled dialog never settles; `undefinedOnCancel` resolves undefined.
    if (answer == null) return Object.assign(new Promise(() => {}), { undefinedOnCancel: Promise.resolve(undefined) });
    const path = `~/Desktop/${answer === true ? suggested : answer}`;
    mock.fs.set(path, { blob, size: blob.size, modified: Date.now() / 1000, uid: `uid-${path}` });
    const saved = Promise.resolve({ name: path.split('/').pop(), path, uid: `uid-${path}` });
    return Object.assign(saved, { undefinedOnCancel: saved });
  });
  globalThis.puter.ui.showSaveFilePicker = dialog;
  return dialog;
}

it('asks where to save a new spreadsheet, and saves there from then on', async () => {
  const dialog = inPuter('Budget.xlsx');
  doc = Doc.blank();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Rent');
  const paths = [];
  doc.addEventListener('path', (e) => paths.push(e.detail.path));
  expect(await doc.save()).toBe(true);
  expect(dialog).toHaveBeenCalledTimes(1);
  expect(dialog.mock.calls[0][1]).toBe('Untitled spreadsheet.xlsx');
  expect(dialog.mock.calls[0][0]).toBeInstanceOf(Blob);
  expect(doc.path).toBe('~/Desktop/Budget.xlsx');
  expect(doc.name).toBe('Budget');
  expect(doc.uid).toBe('uid-~/Desktop/Budget.xlsx');
  expect(doc.status).toBe('saved');
  expect(paths).toEqual(['~/Desktop/Budget.xlsx']);
  expect(documentWrites()).toEqual([]); // the dialog wrote it
  doc.wb.setInput(doc.wb.activeSheetId, 0, 1, '1200');
  expect(await doc.save()).toBe(true);
  expect(dialog).toHaveBeenCalledTimes(1);
  expect(documentWrites()).toEqual(['~/Desktop/Budget.xlsx']);
});

it('writes nothing when the dialog is cancelled, and the edits stay unsaved', async () => {
  const dialog = inPuter(null);
  doc = Doc.blank();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Rent');
  expect(await doc.save()).toBe(false);
  expect(dialog).toHaveBeenCalledTimes(1);
  expect(doc.path).toBeNull();
  expect(doc.status).toBe('unsaved');
  expect(doc.wb.dirty).toBe(true);
  expect(documentWrites()).toEqual([]);
});

it('never opens the dialog for an AutoSave of a new spreadsheet', async () => {
  vi.useFakeTimers();
  const dialog = inPuter(true);
  doc = Doc.blank();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Rent');
  await vi.advanceTimersByTimeAsync(5000); // past the AutoSave delay
  expect(await doc.save({ auto: true })).toBe(false);
  expect(dialog).not.toHaveBeenCalled();
  expect(documentWrites()).toEqual([]);
  expect(doc.status).toBe('unsaved');
});

it('asks where to save a .xlsx made from a file of another kind', async () => {
  const dialog = inPuter(true);
  mock.fs.set('~/Desktop/data.csv', { blob: new Blob(['a,b']), size: 3, modified: 1 });
  doc = new Doc({ name: 'data', path: '~/Desktop/data.csv' });
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Rent');
  expect(await doc.save({ auto: true })).toBe(false);
  expect(dialog).not.toHaveBeenCalled();
  expect(await doc.save()).toBe(true);
  expect(dialog.mock.calls[0][1]).toBe('data.xlsx');
  expect(doc.path).toBe('~/Desktop/data.xlsx');
});

it('writes no version of a new spreadsheet whose Save dialog was cancelled', async () => {
  inPuter(null);
  doc = Doc.blank();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Rent');
  expect(await doc.saveVersion('First')).toBeNull();
  expect(mock.calls.filter(([op]) => op === 'write')).toEqual([]);
});

it('asks where to save a copy, and continues in it', async () => {
  const dialog = inPuter('Budget 2027.xlsx');
  mock.fs.set('Spreadsheets/Budget.xlsx', { blob: new Blob(['x']), size: 1, modified: 1 });
  doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  expect(await doc.saveAs('Budget copy')).toBeNull();
  expect(dialog.mock.calls[0][1]).toBe('Budget copy.xlsx');
  expect(doc.path).toBe('~/Desktop/Budget 2027.xlsx');
  expect(doc.name).toBe('Budget 2027');
  expect(doc.status).toBe('saved');
  expect(documentWrites()).toEqual([]);
});

it('leaves the spreadsheet as it was when the Save a copy dialog is cancelled', async () => {
  inPuter(null);
  mock.fs.set('Spreadsheets/Budget.xlsx', { blob: new Blob(['x']), size: 1, modified: 1 });
  doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Rent');
  expect(await doc.saveAs('Budget copy')).toBe(CANCELLED);
  expect(doc.path).toBe('Spreadsheets/Budget.xlsx');
  expect(doc.name).toBe('Budget');
  expect(doc.status).toBe('unsaved');
});

it('keeps saving a new spreadsheet in the app folder on the open web', async () => {
  globalThis.puter.ui.showSaveFilePicker = vi.fn();
  doc = Doc.blank();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Rent');
  expect(await doc.save()).toBe(true);
  expect(await doc.saveAs('Rent copy')).toBeNull();
  expect(globalThis.puter.ui.showSaveFilePicker).not.toHaveBeenCalled();
  expect(documentWrites()).toEqual(['Spreadsheets/Untitled spreadsheet.xlsx', 'Spreadsheets/Rent copy.xlsx']);
});

it('keeps the question about a moved or deleted file when the Save a copy dialog is cancelled', async () => {
  // "Save as new file" in the dialog about a file gone from its address is Save a copy. Cancelled, the edits are
  // where they were and so is the file: the pill went back to plain unsaved changes, and an AutoSave a moment
  // later put the same question again, though nothing had been typed since.
  vi.useFakeTimers();
  inPuter(null);
  mock.fs.set('~/Desktop/Plan.xlsx', { blob: new Blob(['x']), size: 1, modified: 1 });
  doc = new Doc({ name: 'Plan', path: '~/Desktop/Plan.xlsx' });
  doc.remoteModified = 1000;
  mock.fs.delete('~/Desktop/Plan.xlsx');
  const asked = [];
  doc.addEventListener('conflict', (e) => asked.push(e.detail.kind));
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'Rent');
  await vi.advanceTimersByTimeAsync(2000);
  expect(asked).toEqual(['missing']);
  expect(await doc.saveAs('Plan copy')).toBe(CANCELLED);
  expect(doc.status).toBe('conflict');
  expect(doc.error).toBe('This file was moved or deleted');
  await vi.advanceTimersByTimeAsync(5000);
  expect(asked).toEqual(['missing']);
  doc.wb.setInput(doc.wb.activeSheetId, 0, 1, '1200');
  await vi.advanceTimersByTimeAsync(2000);
  expect(asked).toEqual(['missing', 'missing']);
});
