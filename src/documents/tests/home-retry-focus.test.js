// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { homeView } from '../src/views/home.js';
import * as P from '../src/lib/puter.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
let view, listFiles;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  listFiles = vi.spyOn(P, 'listFiles').mockRejectedValue(new Error('offline'));
  vi.spyOn(P, 'listFolder').mockResolvedValue([]);
  view = homeView({ openPath: vi.fn(), newDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(0);
});
afterEach(() => {
  view.destroy(); vi.runAllTimers(); document.body.replaceChildren();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const retryButton = () => [...view.el.querySelectorAll('button')].find((b) => b.textContent === 'Retry');

it('keeps the keyboard on Retry while the list fails, then on the first document once it loads', async () => {
  expect(view.el.textContent).toContain('Could not load your files');
  // The failure is announced; so is the loading state while a retry runs. Both go through one live region that was
  // on the page before it had anything to say, because a region added already filled is missed by screen readers.
  const status = view.el.querySelector('[role="status"]');
  expect(status.textContent).toContain('Could not load your files');
  expect(view.el.querySelectorAll('[role="status"]')).toHaveLength(1);
  listFiles.mockImplementationOnce(() => new Promise(() => {}));
  retryButton().focus();
  retryButton().click();
  await vi.advanceTimersByTimeAsync(0);
  expect(status.textContent).toBe('Loading your documents');
  expect(view.el.querySelectorAll('[role="status"]')).toHaveLength(1);
  view.destroy();
  view = homeView({ openPath: vi.fn(), newDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(0);
  retryButton().focus();
  retryButton().click();
  await vi.advanceTimersByTimeAsync(0);
  // Failed again: the new Retry button has the focus, not the page body.
  expect(document.activeElement).toBe(retryButton());
  listFiles.mockResolvedValue([{ name: 'Report.docx', path: 'Documents/Report.docx', size: 10, modified: 2 }, { name: 'Notes.docx', path: 'Documents/Notes.docx', size: 10, modified: 1 }]);
  retryButton().click();
  await vi.advanceTimersByTimeAsync(0);
  expect(retryButton()).toBeUndefined();
  expect(document.activeElement).toBe(view.el.querySelector('.file-row .file-main'));
  expect(document.activeElement.textContent).toContain('Report');
});

it('loads the list by itself once the connection is back, with the keyboard on its first document', async () => {
  expect(retryButton()).toBeDefined();
  retryButton().focus();
  listFiles.mockResolvedValue([{ name: 'Report.docx', path: 'Documents/Report.docx', size: 10, modified: 2 }]);
  window.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(0);
  expect(retryButton()).toBeUndefined();
  expect(view.el.querySelector('.file-row')?.textContent).toContain('Report');
  expect(document.activeElement).toBe(view.el.querySelector('.file-row .file-main'));
  // A list that loaded is not read again for a later reconnection.
  listFiles.mockClear();
  window.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(0);
  expect(listFiles).not.toHaveBeenCalled();
});
