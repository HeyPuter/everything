import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { Doc } from '../src/lib/doc.js';
import { clearChangeHistory } from '../src/core/change-history.js';
import { workbookFromFile } from '../src/core/io.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { installMockPuter } from './helpers/mock-puter.js';

// Clear in the Show Changes pane emptied the record and marked the book changed, but left its version as it
// was: the save that followed took the book for the one it had just encoded, wrote those bytes again, and
// marked the book saved, so the file kept every entry and the pane listed them all again on the next open.
// Clearing is now a new version of the book, which the save encodes afresh.
let mock;
beforeAll(async () => { await Doc.blank().toXlsxBlob(); });
beforeEach(() => { Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true }); mock = installMockPuter(); });
afterEach(() => { delete globalThis.puter; });

it('writes the cleared record to the file', async () => {
  const doc = Doc.blank();
  try {
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'hello');
    expect(await doc.save()).toBe(true);
    const saved = async () => (await workbookFromFile(await mock.fs.get(doc.path).blob.arrayBuffer(), 'book.xlsx')).changeHistory || [];
    expect((await saved()).length).toBeGreaterThan(0);
    expect(clearChangeHistory(doc.wb)).toBe(true);
    expect(doc.status).toBe('unsaved');
    expect(await doc.save()).toBe(true);
    expect(doc.status).toBe('saved');
    expect(await saved()).toEqual([]);
  } finally { doc.destroy(); }
});
