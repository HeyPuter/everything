import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Doc } from '../src/lib/doc.js';
import { draftKey, saveDraft, loadDraft, sameBook } from '../src/lib/drafts.js';
import { Workbook } from '../src/core/workbook.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { installMockPuter } from './helpers/mock-puter.js';

beforeEach(() => { Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true }); installMockPuter(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); delete globalThis.puter; });

// A book too large for local storage was left without a draft in silence: the document looked
// like any other with unsaved changes, though nothing but the tab held the edits.
it('tells the view when this browser could not keep a copy of the unsaved changes, and when it can again', async () => {
  const doc = Doc.blank();
  const notes = [];
  doc.addEventListener('draft', (e) => notes.push(e.detail));
  expect(doc.draftKept).toBe(true);
  // A cell holds what a file can hold (32,767 characters), so the oversized book is a column of long cells.
  doc.wb.setCells(doc.wb.activeSheetId, Array.from({ length: 100 }, (_, i) => ({ r: i, c: 2, cell: { v: 'x'.repeat(25_000), f: null } })));
  await vi.advanceTimersByTimeAsync(700);
  try {
    expect(doc.draftKept).toBe(false);
    expect(notes).toEqual([{ kept: false }]);
    expect(doc.status).toBe('unsaved');
    expect(doc.error).toBeNull();
    expect(loadDraft(doc.draftKey)).toBeNull();
    // Another edit that still does not fit says nothing new; a book that fits again is noted once.
    doc.wb.setInput(doc.wb.activeSheetId, 1, 0, 'more');
    await vi.advanceTimersByTimeAsync(700);
    expect(notes).toHaveLength(1);
    doc.wb.clearRange(doc.wb.activeSheetId, { r1: 0, c1: 2, r2: 99, c2: 2 });
    await vi.advanceTimersByTimeAsync(700);
    expect(doc.draftKept).toBe(true);
    expect(notes).toEqual([{ kept: false }, { kept: true }]);
    expect(loadDraft(doc.draftKey)).not.toBeNull();
  } finally { doc.destroy(); }
});

it('writes cells without their empty keys and reads them back whole', () => {
  const wb = new Workbook();
  const sheet = wb.activeSheetId;
  wb.setInput(sheet, 0, 0, 'text');
  wb.setInput(sheet, 1, 0, '=A1&"!"');
  wb.setInput(sheet, 2, 0, '42');
  wb.setInput(sheet, 3, 0, 'literal ,"f":null and "v":null, inside a cell');
  const key = draftKey(null, 'Compact');
  expect(saveDraft(key, wb, 'Compact', 'rev-1')).toBe(true);
  const raw = localStorage.getItem(key);
  expect(raw).not.toContain('"f":null');
  expect(raw).not.toContain('"v":null');
  const draft = loadDraft(key);
  // The plain spelling of the same draft: the book and, beside it, the record of edits (Show Changes) the draft carries.
  expect(raw.length).toBeLessThan(JSON.stringify({ ...draft, workbook: { ...wb.toJSON(), changeHistory: draft.workbook.changeHistory } }).length);
  const back = new Workbook(draft.workbook);
  expect(back.getValue(back.activeSheetId, 0, 0)).toBe('text');
  expect(back.getValue(back.activeSheetId, 1, 0)).toBe('text!');
  expect(back.sheets[0].cells.get('1,0').f).toBe('A1&"!"');
  expect(back.getValue(back.activeSheetId, 2, 0)).toBe(42);
  expect(back.getValue(back.activeSheetId, 3, 0)).toBe('literal ,"f":null and "v":null, inside a cell');
  expect(sameBook(draft.workbook, wb.toJSON())).toBe(true);
});

it('stays under the storage quota a browser gives an origin', () => {
  const huge = new Workbook(); // written directly: typed text is cut at what a file can hold
  huge.setCells(huge.activeSheetId, Array.from({ length: 98 }, (_, i) => ({ r: i, c: 0, cell: { v: 'x'.repeat(25_000), f: null } })));
  expect(saveDraft(draftKey(null, 'Huge'), huge, 'Huge')).toBe(false);
  const large = new Workbook();
  large.setCells(large.activeSheetId, Array.from({ length: 92 }, (_, i) => ({ r: i, c: 0, cell: { v: 'x'.repeat(25_000), f: null } })));
  expect(saveDraft(draftKey(null, 'Large'), large, 'Large')).toBe(true);
});
