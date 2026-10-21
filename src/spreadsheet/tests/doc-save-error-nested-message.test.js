import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Doc } from '../src/lib/doc.js';
import { installMockPuter } from './helpers/mock-puter.js';

beforeEach(() => {
  installMockPuter();
  vi.stubGlobal('navigator', { ...globalThis.navigator, onLine: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { delete globalThis.puter; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Puter refuses some writes with a plain object that holds its reason under `error`, not an Error: the save status
// showed "Not saved: [object Object]", and a save asked for by hand said "Could not save: unknown error".
it("says Puter's reason when it refuses a save with its message nested under error", async () => {
  const doc = Doc.blank();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'x');
  expect(await doc.save()).toBe(true);
  puter.fs.write = async () => { throw { success: false, error: { code: 'storage_limit_reached', message: 'Storage capacity limit reached.' } }; };
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'y');
  expect(await doc.save({ auto: true })).toBe(false);
  expect(doc.status).toBe('error');
  expect(doc.error).toBe('Storage capacity limit reached.');
  const thrown = await doc.save().catch((e) => e);
  expect(thrown.message).toBe('Storage capacity limit reached.');
  doc.destroy();
});
