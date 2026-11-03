import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Doc, setAutoSaveEnabled } from '../src/lib/doc.js';
import { draftKey, liveDraftKey, loadDraft, listDrafts } from '../src/lib/drafts.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { installMockPuter } from './helpers/mock-puter.js';

let mock;
// SheetJS is loaded on first use with a real dynamic import; warm it up so no test waits on it.
beforeAll(async () => { await Doc.blank().toXlsxBlob(); });
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  mock = installMockPuter();
  vi.useFakeTimers();
  setAutoSaveEnabled(false);
});
afterEach(() => { vi.useRealTimers(); delete globalThis.puter; });

const PATH = 'Spreadsheets/Budget.xlsx';
const KEY = () => draftKey(PATH);
const text = (draft) => draft?.workbook.sheets[0].cells['0,0']?.v;
const unsaved = () => listDrafts().filter((d) => d.path === null).map((d) => text(loadDraft(d.key)));

async function blankFile() {
  const bytes = await Doc.blank().toXlsxBlob();
  mock.fs.set(PATH, { blob: bytes, size: bytes.size, modified: 1 });
}

function edit(doc, value) {
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, value);
  expect(doc.writeDraft()).toBe(true);
}

// Two tabs of one file, both opened before either was edited, drafted their unsaved edits (AutoSave off)
// under the one key the file's address names, each write replacing the other's: closing both kept only
// the last tab's edits, and the other tab's, which the app had said stay on this device, were gone.
it('keeps both tabs\' unsaved edits when two tabs of one file are edited and closed', async () => {
  await blankFile();
  const a = await Doc.fromPath(PATH);
  const b = await Doc.fromPath(PATH);
  edit(a, 'tab A');
  edit(b, 'tab B');
  edit(a, 'tab A again');
  edit(b, 'tab B again');
  a.destroy();
  b.destroy();
  const reopened = await Doc.fromPath(PATH);
  try {
    // One is offered on opening the file, the other kept as an unsaved spreadsheet on the home screen.
    expect([text(reopened.recoverable), ...unsaved()].sort()).toEqual(['tab A again', 'tab B again']);
  } finally { reopened.destroy(); }
});

it('drafts under the file\'s own key as before when only one tab edits it', async () => {
  await blankFile();
  const a = await Doc.fromPath(PATH);
  edit(a, 'one');
  edit(a, 'two');
  expect(text(loadDraft(KEY()))).toBe('two');
  expect(loadDraft(liveDraftKey(KEY()))).toBeNull();
  a.destroy();
});

it('clears the second tab\'s draft once it saves, and leaves the first tab\'s', async () => {
  await blankFile();
  const a = await Doc.fromPath(PATH);
  const b = await Doc.fromPath(PATH);
  edit(a, 'tab A');
  edit(b, 'tab B');
  try {
    expect(await b.save()).toBe(true);
    await b.versionSettled();
    expect(loadDraft(liveDraftKey(KEY()))).toBeNull();
    expect(text(loadDraft(KEY()))).toBe('tab A');
  } finally { a.destroy(); b.destroy(); }
});

it('moves the second tab\'s draft with the file when that tab renames it', async () => {
  await blankFile();
  const a = await Doc.fromPath(PATH);
  const b = await Doc.fromPath(PATH);
  edit(a, 'tab A');
  edit(b, 'tab B');
  try {
    expect(await b.rename('Renamed')).toBeNull();
    expect(text(loadDraft(liveDraftKey(draftKey(b.path))))).toBe('tab B');
    expect(loadDraft(liveDraftKey(KEY()))).toBeNull();
  } finally { a.destroy(); b.destroy(); }
});

// The same happened to a spreadsheet never saved to Puter, reopened from the home screen's Unsaved spreadsheets
// in two tabs: both drafted under the one key the list gave them, and only the last tab's edits stayed listed.
it('keeps both tabs\' edits of one unsaved spreadsheet reopened in two tabs, each listed on the home screen', () => {
  const first = Doc.blank();
  edit(first, 'start');
  const key = first.draftKey;
  first.destroy();
  const a = Doc.fromDraft(key);
  const b = Doc.fromDraft(key);
  edit(a, 'tab A');
  edit(b, 'tab B');
  edit(a, 'tab A again');
  edit(b, 'tab B again');
  a.destroy();
  b.destroy();
  expect(unsaved().sort()).toEqual(['tab A again', 'tab B again']);
});

it('keeps both when the tab that made the unsaved spreadsheet is still open as another tab reopens it', () => {
  const a = Doc.blank();
  edit(a, 'start');
  const b = Doc.fromDraft(a.draftKey);
  edit(b, 'tab B');
  edit(a, 'tab A');
  edit(b, 'tab B again');
  edit(a, 'tab A again');
  a.destroy();
  b.destroy();
  expect(unsaved().sort()).toEqual(['tab A again', 'tab B again']);
});
