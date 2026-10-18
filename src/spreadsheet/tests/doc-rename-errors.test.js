import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Doc } from '../src/lib/doc.js';
import { installMockPuter } from './helpers/mock-puter.js';

let mock;
beforeEach(() => { mock = installMockPuter(); });
afterEach(() => { delete globalThis.puter; vi.restoreAllMocks(); });

// A network error while checking whether the new name was free escaped as a rejected
// promise: the prompt closed and nothing told the user why nothing happened.
it('returns the failure as a message from rename and save-as instead of rejecting', async () => {
  const doc = new Doc({ name: 'Plan', path: 'Spreadsheets/Plan.xlsx' });
  puter.fs.stat = async () => { throw new Error('Network request failed'); };
  await expect(doc.rename('Budget')).resolves.toBe('Could not rename the file: Puter could not be reached. Check your connection, then try again');
  expect(doc.path).toBe('Spreadsheets/Plan.xlsx');
  await expect(doc.saveAs('Copy')).resolves.toBe('Could not save a copy: Puter could not be reached. Check your connection, then try again');
  expect(mock.calls.filter(([op]) => op === 'write')).toEqual([]);
});
