// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { homeView } from '../src/views/home.js';
import * as P from '../src/lib/puter.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';

const pending = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
let view, openPath, importFile;
beforeEach(async () => {
  vi.useFakeTimers(); localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.spyOn(P, 'listFiles').mockResolvedValue([]);
  vi.spyOn(P, 'canPickFiles').mockReturnValue(true);
  openPath = vi.fn(); importFile = vi.fn();
  view = homeView({ openPath, importFile, newDoc: vi.fn() });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(0);
});
afterEach(() => {
  view?.destroy(); closeMenu(); closeAllModals(); document.body.replaceChildren();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const leave = () => { view.destroy(); view.el.remove(); };

it('ignores a cloud picker result after leaving the document list', async () => {
  const picked = pending(); vi.spyOn(P, 'pickFile').mockReturnValue(picked.promise);
  [...view.el.querySelectorAll('button')].find((b) => b.textContent === 'Open from Puter').click();
  leave(); picked.resolve({ path: 'Documents/Old selection.docx' });
  await vi.advanceTimersByTimeAsync(0);
  expect(openPath).not.toHaveBeenCalled();
});

it('does not open a stale template menu after navigation', async () => {
  const listed = pending(); vi.spyOn(P, 'listFolder').mockReturnValue(listed.promise);
  [...view.el.querySelectorAll('button')].find((b) => b.textContent === 'Templates').click();
  leave(); listed.resolve([]); await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it('finishes a bulk document write without opening a text import over the new view', async () => {
  const written = pending(); vi.spyOn(P, 'createFile').mockReturnValue(written.promise);
  vi.spyOn(P, 'uniqueName').mockResolvedValue('Imported.docx');
  const input = view.el.querySelector('input[type="file"]');
  Object.defineProperty(input, 'files', { value: [new File(['word'], 'Imported.docx'), new File(['text'], 'Notes.txt')] });
  input.dispatchEvent(new Event('change')); await vi.advanceTimersByTimeAsync(0);
  expect(P.createFile).toHaveBeenCalledOnce();
  leave(); written.resolve('Documents/Imported.docx'); await vi.advanceTimersByTimeAsync(0);
  expect(importFile).not.toHaveBeenCalled();
});

it('does not replace a newer file listing with an older response', async () => {
  const old = pending(), recent = pending();
  P.listFiles.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
  const first = view.reload(), second = view.reload();
  recent.resolve([{ name: 'Latest.docx', path: 'Documents/Latest.docx' }]); await second;
  old.resolve([{ name: 'Stale.docx', path: 'Documents/Stale.docx' }]); await first;
  expect(view.el.querySelector('.file-name').textContent).toBe('Latest');
});

it.each(['stale listing', 'listing error', 'earlier listing error', 'failed deletion'])('keeps a concurrent deletion consistent with a duplication refresh (%s)', async (result) => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const removed = { name: 'Removed.docx', path: 'Documents/Removed.docx' };
  const kept = { name: 'Kept.docx', path: 'Documents/Kept.docx' };
  const copy = { name: 'Kept copy.docx', path: 'Documents/Kept copy.docx' };
  P.listFiles.mockResolvedValueOnce([removed, kept]);
  await view.reload();
  const deletion = pending(), listing = pending();
  vi.spyOn(P, 'deleteFile').mockReturnValueOnce(deletion.promise).mockResolvedValue();
  vi.spyOn(P, 'listFolder').mockResolvedValue([]);
  vi.spyOn(P, 'readFile').mockResolvedValue(new Blob(['kept']));
  vi.spyOn(P, 'createFile').mockResolvedValue(copy.path);
  const choose = (name, action) => {
    view.el.querySelector(`[aria-label="Options for ${name}"]`).click();
    [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.querySelector('.menu-label')?.textContent === action).click();
  };
  choose(removed.name, 'Delete');
  document.querySelector('.modal-root:last-child .btn-danger').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(P.deleteFile).toHaveBeenCalledWith(removed.path);
  P.listFiles.mockReturnValueOnce(listing.promise).mockResolvedValue([kept, copy]);
  choose(kept.name, 'Duplicate'); await vi.advanceTimersByTimeAsync(0);
  expect(P.createFile).toHaveBeenCalledOnce();
  expect(view.el.textContent).toContain('Loading your documents');
  if (result === 'earlier listing error') { listing.reject(new Error('Old request failed')); await vi.advanceTimersByTimeAsync(0); }
  if (result === 'failed deletion') deletion.reject(new Error('Deletion unavailable'));
  else deletion.resolve();
  await vi.advanceTimersByTimeAsync(0);
  if (result === 'listing error') listing.reject(new Error('Old request failed'));
  else if (result !== 'earlier listing error') listing.resolve([removed, kept, copy]);
  await vi.advanceTimersByTimeAsync(0);
  const names = [...view.el.querySelectorAll('.file-name')].map((element) => element.textContent).sort();
  expect(names).toEqual(result === 'failed deletion' ? ['Kept', 'Kept copy', 'Removed'] : ['Kept', 'Kept copy']);
  expect(view.el.textContent).not.toContain('Could not load');
  expect(P.listFiles).toHaveBeenCalledTimes(result === 'failed deletion' ? 3 : 4);
  // A subsequently recreated file at the same path must remain discoverable.
  P.listFiles.mockResolvedValue([removed, kept, copy]);
  await view.reload();
  expect(view.el.querySelector('[aria-label="Options for Removed.docx"]')).not.toBeNull();
});

it('still opens a cloud selection while the document list is active', async () => {
  vi.spyOn(P, 'pickFile').mockResolvedValue({ path: 'Documents/Selected.docx' });
  [...view.el.querySelectorAll('button')].find((b) => b.textContent === 'Open from Puter').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(openPath).toHaveBeenCalledWith('Documents/Selected.docx');
});

it('duplicates a document without joining the room of a shared one deleted elsewhere under the copy’s name', async () => {
  const { rememberRoom, rememberedRoom } = await import('../src/collab/room-memory.js');
  const kv = new Map();
  vi.stubGlobal('puter', { kv: { get: async (k) => kv.get(k) ?? null, set: async (k, v) => { kv.set(k, v); }, del: async (k) => { kv.delete(k); } } });
  const original = { name: 'Plan.docx', path: 'Documents/Plan.docx' };
  P.listFiles.mockResolvedValue([original]);
  await view.reload();
  await rememberRoom('Documents/Plan copy.docx', { server: 'https://documents-abc.puter.work', room: 'old' });
  vi.spyOn(P, 'readFile').mockResolvedValue(new Blob(['plan']));
  vi.spyOn(P, 'createFile').mockResolvedValue('Documents/Plan copy.docx');
  view.el.querySelector('[aria-label="Options for Plan.docx"]').click();
  [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.querySelector('.menu-label')?.textContent === 'Duplicate').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(P.createFile).toHaveBeenCalledOnce();
  expect(await rememberedRoom('Documents/Plan copy.docx')).toBeNull();
});
