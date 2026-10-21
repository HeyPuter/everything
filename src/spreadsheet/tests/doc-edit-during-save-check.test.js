import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { Doc } from '../src/lib/doc.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { installMockPuter } from './helpers/mock-puter.js';

// A save first asks the drive whether the file changed elsewhere, then encodes the book and writes it. An entry
// typed while the drive was being asked went into the bytes written, but the save had noted the book's version
// before asking, so the book stayed "Unsaved changes" and the whole file was uploaded again a moment later.
beforeAll(async () => { await Doc.blank().toXlsxBlob(); });
beforeEach(() => { Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true }); installMockPuter(); });
afterEach(() => { delete globalThis.puter; });

it('counts an edit made while the file was being checked as saved, since the bytes written hold it', async () => {
  const doc = Doc.blank();
  const s = doc.wb.activeSheetId;
  doc.wb.setInput(s, 0, 0, 'first');
  await doc.save();
  const stat = puter.fs.stat;
  puter.fs.stat = async (...args) => {
    const st = await stat.apply(puter.fs, args);
    doc.wb.setInput(s, 1, 0, 'typed meanwhile'); // the next entry lands while the drive answers
    puter.fs.stat = stat;
    return st;
  };
  const write = puter.fs.write;
  let writes = 0;
  puter.fs.write = (path, ...rest) => { if (!path.includes('/.versions/')) writes++; return write.call(puter.fs, path, ...rest); };
  try {
    doc.wb.setInput(s, 0, 0, 'second');
    expect(await doc.save()).toBe(true);
    expect(doc.wb.dirty).toBe(false);
    expect(doc.status).toBe('saved');
    expect(writes).toBe(1);
  } finally { doc.destroy(); }
});
