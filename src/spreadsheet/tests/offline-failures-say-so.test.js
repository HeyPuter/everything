// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Doc } from '../src/lib/doc.js';
import * as P from '../src/lib/puter.js';
import { homeView } from '../src/views/home.js';
import { closeMenu } from '../src/ui/menu.js';
import { toast } from '../src/ui/toast.js';
import { installMockPuter } from './helpers/mock-puter.js';
import { memoryStorage } from './helpers/memory-storage.js';

// Renaming, saving a copy, or renaming, duplicating or deleting from the list while offline told the user only
// "Failed to fetch", the browser's words for a request that never left: nothing said the connection was the
// trouble, or what to do. A failure to connect now says so; the service's own messages are kept as they are.
vi.mock('../src/lib/session.js', () => ({ session: { settings: {}, username: 'Test user', signedOut: false, addEventListener() {}, removeEventListener() {} } }));
vi.mock('../src/lib/recent.js', () => ({ refreshRecent: async () => [], recentFiles: () => [], forgetRecent() {} }));
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
vi.mock('../src/ui/modal.js', () => ({ promptDialog: vi.fn(), confirmDialog: vi.fn(async () => true), openModal: vi.fn() }));

let online;
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  installMockPuter();
  online = true;
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { closeMenu(); vi.restoreAllMocks(); delete globalThis.puter; document.body.replaceChildren(); });

it('words a failure to connect, and keeps the service’s own message', () => {
  expect(P.unreachable(new TypeError('Failed to fetch'))).toBe(true);
  expect(P.unreachable(new TypeError('Load failed'))).toBe(true);
  expect(P.unreachable(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(true);
  expect(P.unreachable(new Error('A file with that name already exists'))).toBe(false);
  expect(P.failureText(new TypeError('Failed to fetch'), 'Could not rename')).toBe('Could not rename: Puter could not be reached. Check your connection, then try again');
  expect(P.failureText({ error: { message: 'Storage capacity limit reached' } }, 'Could not rename')).toBe('Storage capacity limit reached');
  expect(P.failureText(null, 'Could not rename')).toBe('Could not rename');
  online = false;
  expect(P.failureText(new Error('anything'), 'Could not delete')).toBe('Could not delete: you are offline. Connect to the internet, then try again');
});

it('says a rename or a copy failed for being offline', async () => {
  const doc = new Doc({ name: 'Plan', path: 'Spreadsheets/Plan.xlsx' });
  online = false;
  puter.fs.stat = async () => { throw new TypeError('Failed to fetch'); };
  await expect(doc.rename('Budget')).resolves.toBe('Could not rename the file: you are offline. Connect to the internet, then try again');
  await expect(doc.saveAs('Copy')).resolves.toBe('Could not save a copy: you are offline. Connect to the internet, then try again');
  doc.destroy();
});

it('says a delete from the list failed for being offline', async () => {
  const path = 'Spreadsheets/Budget.xlsx';
  vi.spyOn(P, 'listFiles').mockResolvedValue([{ path, name: 'Budget.xlsx', modified: Date.now(), size: 1000 }]);
  vi.spyOn(P, 'deleteFile').mockRejectedValue(new TypeError('Failed to fetch'));
  const view = homeView({});
  document.body.append(view.el);
  await vi.waitFor(() => expect(view.el.querySelector('.file-menu-btn')).toBeTruthy());
  online = false;
  view.el.querySelector('.file-menu-btn').click();
  [...document.querySelectorAll('.menu .menu-item')].find((b) => /delete/i.test(b.textContent)).click();
  await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Could not delete: you are offline. Connect to the internet, then try again', expect.anything()));
  view.destroy();
});
