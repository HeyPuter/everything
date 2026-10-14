import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Doc } from '../src/lib/doc.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { workbookToXlsx } from '../src/core/io.js';
import { installMockPuter } from './helpers/mock-puter.js';

let mock;
// SheetJS is loaded on first use with a real dynamic import; warm it up so no test waits on it.
beforeAll(async () => { await Doc.blank().toXlsxBlob(); });
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  mock = installMockPuter();
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000); // the clock stands still: every write lands within one second
});
afterEach(() => { vi.useRealTimers(); delete globalThis.puter; });

async function savedDocument() {
  const doc = Doc.blank();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'mine');
  expect(await doc.save()).toBe(true);
  return doc;
}

// The drive keeps modification times in whole seconds, so another tab's save within the same
// second as ours looked unchanged and was overwritten without a word.
it('sees another tab\'s save within the same second as a change made elsewhere', async () => {
  const doc = await savedDocument();
  const path = doc.path;
  const theirs = new Blob(['written by another tab in the same second']);
  mock.fs.set(path, { blob: theirs, size: theirs.size, modified: mock.fs.get(path).modified, uid: mock.fs.get(path).uid });
  const conflicts = [];
  doc.addEventListener('conflict', (e) => conflicts.push(e.detail));
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'mine again');
  try {
    expect(await doc.save()).toBe(false);
    expect(conflicts).toEqual([{ kind: 'changed', remoteModified: expect.any(Number) }]);
    expect(doc.status).toBe('conflict');
    expect(doc.error).toBe('This file changed elsewhere');
    expect(mock.fs.get(path).blob).toBe(theirs);
    // Overwriting on purpose still works, and the next save is measured against that write.
    expect(await doc.forceSave()).toBe(true);
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'and again');
    expect(await doc.save()).toBe(true);
    expect(conflicts).toHaveLength(1);
  } finally { doc.destroy(); }
});

it('does not mistake its own file for a change when saving twice within one second', async () => {
  const doc = await savedDocument();
  const conflicts = [];
  doc.addEventListener('conflict', (e) => conflicts.push(e.detail));
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'mine, longer this time');
  try {
    expect(await doc.save()).toBe(true);
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'm');
    expect(await doc.save()).toBe(true);
    expect(conflicts).toEqual([]);
    expect(doc.status).toBe('saved');
  } finally { doc.destroy(); }
});

// An edit of the same length zips to the same length: another tab's save within the second this
// document's baseline names changed neither the time nor the size, and was overwritten without a word.
it('reads the file back before overwriting a same-size write made within the baseline second', async () => {
  const doc = await savedDocument();
  const path = doc.path;
  const other = Doc.blank();
  other.wb.setInput(other.wb.activeSheetId, 0, 0, 'thei'); // as long as "mine", so the file is the same size
  // The file carries the record of recent edits (Show Changes) too: the other tab's is the same, but for its sheet's id.
  other.wb.changeHistory = structuredClone(doc.wb.changeHistory);
  const theirs = await workbookToXlsx(other.wb); // as the other tab's save writes it, the record included
  other.destroy();
  expect(theirs.size).toBe(doc.remoteSize);
  mock.fs.set(path, { blob: theirs, size: theirs.size, modified: mock.fs.get(path).modified, uid: mock.fs.get(path).uid });
  const conflicts = [];
  doc.addEventListener('conflict', (e) => conflicts.push(e.detail));
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'ours');
  try {
    expect(await doc.save()).toBe(false);
    expect(conflicts).toEqual([{ kind: 'changed', remoteModified: expect.any(Number) }]);
    expect(doc.status).toBe('conflict');
    expect(mock.fs.get(path).blob).toBe(theirs);
    // Overwriting on purpose still works.
    expect(await doc.forceSave()).toBe(true);
    expect(mock.fs.get(path).blob).not.toBe(theirs);
  } finally { doc.destroy(); }
});

// The same for a file opened while another tab was saving it: the baseline is the second of that save.
it('reads the file back before overwriting a same-size write made in the second the file was opened', async () => {
  const first = await savedDocument();
  const path = first.path;
  first.destroy();
  const doc = await Doc.fromPath(path);
  const other = Doc.blank();
  other.wb.setInput(other.wb.activeSheetId, 0, 0, 'thei');
  // The file carries the record of recent edits (Show Changes) too: the other tab's is the same, but for its sheet's id.
  other.wb.changeHistory = structuredClone(doc.wb.changeHistory);
  const theirs = await workbookToXlsx(other.wb); // as the other tab's save writes it, the record included
  other.destroy();
  expect(theirs.size).toBe(doc.remoteSize);
  mock.fs.set(path, { blob: theirs, size: theirs.size, modified: mock.fs.get(path).modified, uid: mock.fs.get(path).uid });
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'ours');
  try {
    expect(await doc.save()).toBe(false);
    expect(doc.status).toBe('conflict');
    expect(doc.error).toBe('This file changed elsewhere');
    expect(mock.fs.get(path).blob).toBe(theirs);
  } finally { doc.destroy(); }
});

// Reading the file back is how a same-second write is told from none; a read that will not answer
// must not put the question to the user instead, or a flaky connection would ask on every save.
it('saves as it would have when the file cannot be read back to be compared', async () => {
  const doc = await savedDocument();
  puter.fs.read = async () => { throw new Error('Network request failed'); };
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'mine again');
  try {
    expect(await doc.save()).toBe(true);
    expect(doc.status).toBe('saved');
  } finally { doc.destroy(); }
});

it('goes by the modification time alone when the drive reports no size', async () => {
  const doc = await savedDocument();
  const stat = puter.fs.stat;
  puter.fs.stat = async (p) => ({ ...(await stat(p)), size: null });
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'mine again');
  try {
    expect(await doc.save()).toBe(true);
    expect(doc.status).toBe('saved');
  } finally { doc.destroy(); }
});
