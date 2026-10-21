import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Doc } from '../src/lib/doc.js';
import { installMockPuter } from './helpers/mock-puter.js';

beforeEach(() => {
  installMockPuter();
  vi.stubGlobal('navigator', { ...globalThis.navigator, onLine: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { delete globalThis.puter; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// A save that reached the drive but whose answer was lost left the file newer, with other bytes, than the document
// knew: the retry took its own write for a change made elsewhere and put up "This file changed elsewhere".
it('does not take its own write whose answer was lost for a change made elsewhere', async () => {
  const doc = Doc.blank();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'x');
  expect(await doc.save()).toBe(true);
  await new Promise((r) => setTimeout(r, 1100)); // the drive's times are whole seconds
  doc.wb.setInput(doc.wb.activeSheetId, 1, 0, 'a longer entry than before');
  const write = puter.fs.write;
  puter.fs.write = async (...args) => { puter.fs.write = write; await write(...args); throw new Error('Failed to fetch'); };
  const conflicts = [];
  doc.addEventListener('conflict', (e) => conflicts.push(e.detail));
  expect(await doc.save({ auto: true })).toBe(false);
  expect(await doc.save({ auto: true })).toBe(true);
  expect(conflicts).toEqual([]);
  expect(doc.status).toBe('saved');
  // A change made elsewhere afterwards is still told apart.
  await new Promise((r) => setTimeout(r, 1100));
  await write(doc.path, new Blob(['theirs']));
  doc.wb.setInput(doc.wb.activeSheetId, 2, 0, 'mine');
  expect(await doc.save({ auto: true })).toBe(false);
  expect(conflicts).toHaveLength(1);
  doc.destroy();
});
