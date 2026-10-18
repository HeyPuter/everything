import { afterEach, beforeEach, expect, it } from 'vitest';
import { Doc } from '../src/lib/doc.js';
import { installMockPuter } from './helpers/mock-puter.js';

beforeEach(() => { installMockPuter(); });
afterEach(() => { delete globalThis.puter; });

// A failed "Save a copy" used to leave the original document in the error
// state ("Not saved", a prompt before leaving) although nothing about it had
// changed: the copy is another file.
it('leaves a clean document saved when saving a copy fails', async () => {
  const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  puter.fs.write = async () => { throw new Error('Network request failed'); };
  expect(await doc.saveAs('Copy')).toBe('Could not save a copy: Puter could not be reached. Check your connection, then try again');
  expect(doc.status).toBe('saved');
  expect(doc.error).toBeNull();
  expect(doc.path).toBe('Spreadsheets/Budget.xlsx');
  doc.destroy();
});

it('keeps an edited document unsaved, not in error, when saving a copy fails', async () => {
  const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'edit');
  puter.fs.write = async () => { throw new Error('Network request failed'); };
  expect(await doc.saveAs('Copy')).toBe('Could not save a copy: Puter could not be reached. Check your connection, then try again');
  expect(doc.status).toBe('unsaved');
  expect(doc.wb.dirty).toBe(true);
  doc.destroy();
});

// A clean book has nothing to write, but a stale error or offline status from
// an earlier attempt must not keep saying so once a save is asked for.
it('clears a stale error status when a clean document is asked to save', async () => {
  const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  doc._setStatus('error', 'Network request failed');
  expect(await doc.save()).toBe(true);
  expect(doc.status).toBe('saved');
  expect(doc.error).toBeNull();
  doc.destroy();
});
