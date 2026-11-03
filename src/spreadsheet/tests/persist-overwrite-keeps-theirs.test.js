import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Doc, THEIRS_NOT_KEPT } from '../src/lib/doc.js';
import { listVersions, readVersion, OVERWRITE_LABEL } from '../src/lib/versions.js';
import { workbookFromFile } from '../src/core/io.js';
import { Workbook } from '../src/core/workbook.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { installMockPuter } from './helpers/mock-puter.js';

let mock;
// SheetJS is loaded on first use with a real dynamic import; warm it up so no test waits on it.
beforeAll(async () => { await Doc.blank().toXlsxBlob(); });
beforeEach(() => { Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true }); mock = installMockPuter(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); delete globalThis.puter; });

const cellA1 = (wb) => wb.getValue(wb.activeSheetId, 0, 0);
const snapshotText = async (v) => cellA1(await workbookFromFile(await readVersion(v.path), 'v.xlsx'));

/** A file saved here, then written from another device; the document has an edit of its own waiting. */
async function changedElsewhere() {
  const doc = Doc.blank();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'v1');
  await doc.rename('Budget');
  expect(await doc.save()).toBe(true);
  await doc.versionSettled();
  const other = new Workbook();
  other.setInput(other.activeSheetId, 0, 0, 'theirs');
  const theirs = await new Doc({ wb: other }).toXlsxBlob();
  mock.fs.set(doc.path, { blob: theirs, size: theirs.size, modified: doc.remoteModified / 1000 + 60, uid: doc.uid });
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'mine');
  return doc;
}

// "Overwrite with mine" wrote over the other device's save with nothing kept of it, while restoring an older
// draft or a version keeps what it replaces in the history first: the other person's work was gone for good.
it('keeps the version it writes over in the history when the user overwrites a file changed elsewhere', async () => {
  const doc = await changedElsewhere();
  try {
    expect(await doc.save()).toBe(false);
    expect(doc.status).toBe('conflict');
    expect(await doc.forceSave()).toBe(true);
    await doc.versionSettled();
    const reopened = await Doc.fromPath(doc.path);
    try { expect(cellA1(reopened.wb)).toBe('mine'); } finally { reopened.destroy(); }
    const kept = (await listVersions(doc.file)).filter((v) => v.label === OVERWRITE_LABEL);
    expect(kept).toHaveLength(1);
    expect(await snapshotText(kept[0])).toBe('theirs');
  } finally { doc.destroy(); }
});

it('keeps nothing extra when the file at the address is still the one this document wrote', async () => {
  const doc = Doc.blank();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'v1');
  await doc.rename('Budget');
  expect(await doc.save()).toBe(true);
  await doc.versionSettled();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'mine');
  try {
    expect(await doc.forceSave()).toBe(true);
    expect((await listVersions(doc.file)).filter((v) => v.label === OVERWRITE_LABEL)).toEqual([]);
  } finally { doc.destroy(); }
});

it('ages the kept version out with the automatic ones, rather than keeping it for good as a label of the user\'s', async () => {
  const { saveVersion, pruneVersions } = await import('../src/lib/versions.js');
  const path = 'Spreadsheets/Pruned.xlsx';
  for (let i = 0; i < 40; i++) await saveVersion(path, new Blob([`r${i}`]), OVERWRITE_LABEL, new Date(2026, 0, 1, 0, i));
  await pruneVersions(path, 5);
  expect((await listVersions(path)).length).toBe(5);
});

const fileText = async (doc) => cellA1(await workbookFromFile(mock.fs.get(doc.path).blob, 'f.xlsx'));

// Both conflict dialogs say theirs is kept in Version history, but a read of their file or a write of the version
// that failed was only logged, and the overwrite went ahead: their work was gone, the user told it was kept.
it('does not overwrite their version when it could not be read to keep, and says so', async () => {
  const doc = await changedElsewhere();
  try {
    expect(await doc.save()).toBe(false);
    const read = globalThis.puter.fs.read;
    globalThis.puter.fs.read = async () => { throw new Error('Network error'); };
    await expect(doc.forceSave()).rejects.toThrow(THEIRS_NOT_KEPT);
    globalThis.puter.fs.read = read;
    expect(await fileText(doc)).toBe('theirs');
    expect(doc.status).toBe('conflict');
    expect(doc.wb.dirty).toBe(true);
    // Told, the user may still overwrite it.
    expect(await doc.forceSave({ keepTheirs: false })).toBe(true);
    expect(await fileText(doc)).toBe('mine');
  } finally { doc.destroy(); }
});

it('does not overwrite their version when Version history would not take it', async () => {
  const doc = await changedElsewhere();
  try {
    expect(await doc.save()).toBe(false);
    const write = globalThis.puter.fs.write;
    globalThis.puter.fs.write = async (p, ...rest) => { if (p !== doc.path) throw new Error('Storage is full'); return write(p, ...rest); };
    await expect(doc.forceSave()).rejects.toThrow(THEIRS_NOT_KEPT);
    globalThis.puter.fs.write = write;
    expect(await fileText(doc)).toBe('theirs');
    expect(doc.status).toBe('conflict');
  } finally { doc.destroy(); }
});

// The file is read and kept before the user's own goes over it: the status says the save is under way meanwhile.
it('shows the save under way while their version is kept', async () => {
  const doc = await changedElsewhere();
  try {
    expect(await doc.save()).toBe(false);
    const statuses = [];
    doc.addEventListener('status', () => statuses.push(doc.status));
    const read = globalThis.puter.fs.read;
    let reading = null;
    globalThis.puter.fs.read = (p) => { reading = statuses.slice(); return read(p); };
    expect(await doc.forceSave()).toBe(true);
    expect(reading).toEqual(['saving']);
    expect(statuses.at(-1)).toBe('saved');
    expect(mock.calls.filter(([op, p]) => op === 'write' && p === doc.path)).toHaveLength(2); // the first save and the overwrite
  } finally { doc.destroy(); }
});
