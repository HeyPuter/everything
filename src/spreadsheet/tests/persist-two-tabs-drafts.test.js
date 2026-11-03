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

// A tab whose edits are kept beside the file's draft shared that place with every other such tab: a third tab of
// the file, or one of two tabs reloaded (offered the other's draft, its edits kept beside it meanwhile), wrote over
// the other's edits there, and the last to close kept its edits alone.
it('keeps all three tabs\' unsaved edits when three tabs of one file are edited and closed', async () => {
  await blankFile();
  const a = await Doc.fromPath(PATH), b = await Doc.fromPath(PATH), c = await Doc.fromPath(PATH);
  edit(a, 'tab A');
  edit(b, 'tab B');
  edit(c, 'tab C');
  edit(b, 'tab B again');
  a.destroy(); b.destroy(); c.destroy();
  const reopened = await Doc.fromPath(PATH);
  try {
    expect([text(reopened.recoverable), ...unsaved()].sort()).toEqual(['tab A', 'tab B again', 'tab C']);
  } finally { reopened.destroy(); }
});

it('keeps the edits made in a reloaded tab while the other tab of the file goes on editing', async () => {
  await blankFile();
  const a = await Doc.fromPath(PATH);
  const b = await Doc.fromPath(PATH);
  edit(a, 'tab A');
  edit(b, 'tab B');
  const reloaded = await Doc.fromPath(PATH);
  edit(reloaded, 'reloaded A');
  edit(b, 'tab B again');
  reloaded.destroy(); b.destroy();
  const reopened = await Doc.fromPath(PATH);
  try {
    const kept = [text(reopened.recoverable), ...unsaved()];
    expect(kept).toContain('reloaded A');
    expect(kept).toContain('tab B again');
  } finally { reopened.destroy(); }
});

it('drafts a reloaded tab\'s edits under the file again once it restores the draft it was offered', async () => {
  await blankFile();
  const a = await Doc.fromPath(PATH);
  const b = await Doc.fromPath(PATH);
  edit(a, 'tab A');
  edit(b, 'tab B');
  const reloaded = await Doc.fromPath(PATH);
  edit(b, 'tab B again');
  edit(reloaded, 'meanwhile');
  expect(reloaded.restoreDraft()).toBe(true);
  edit(reloaded, 'restored, then edited');
  try {
    expect(text(loadDraft(KEY()))).toBe('restored, then edited');
    expect(unsaved()).not.toContain('meanwhile');
  } finally { reloaded.destroy(); b.destroy(); }
});

// An unsaved spreadsheet opened from the home screen in a second tab is unsaved there too, though that tab changed
// nothing. Switching away from it copied its book to storage under the spreadsheet's key, as a new draft: the first
// tab's next copy found that one there and took a key of its own, and the home screen listed the spreadsheet twice,
// once as the second tab had viewed it. A tab that only viewed the spreadsheet does not copy it again.
it('lists an unsaved spreadsheet once when a second tab only views it while the first goes on editing', () => {
  const a = Doc.blank();
  edit(a, 'start');
  const b = Doc.fromDraft(a.draftKey);
  expect(b.writeDraft()).toBe(true); // switched away from: what it shows is kept on this device
  edit(a, 'tab A');
  expect(b.writeDraft()).toBe(true);
  edit(a, 'tab A again');
  a.destroy();
  b.destroy();
  expect(unsaved()).toEqual(['tab A again']);
});

it('keeps a viewing tab\'s book when the draft it was opened from is gone, and its edits once it makes some', () => {
  const a = Doc.blank();
  edit(a, 'start');
  const b = Doc.fromDraft(a.draftKey);
  const c = Doc.fromDraft(a.draftKey);
  a.wb.markClean(); // saved, say: the first tab's draft goes
  a.destroy();
  expect(unsaved()).toEqual([]);
  expect(b.writeDraft()).toBe(true);
  expect(unsaved()).toEqual(['start']);
  edit(c, 'tab C');
  c.destroy();
  b.destroy();
  expect(unsaved().sort()).toEqual(['start', 'tab C']);
});
