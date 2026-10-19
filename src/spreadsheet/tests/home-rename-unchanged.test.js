// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { homeView } from '../src/views/home.js';
import { closeMenu } from '../src/ui/menu.js';
import { Doc } from '../src/lib/doc.js';
import { saveDraft, loadDraft, draftKey } from '../src/lib/drafts.js';
import { accountStorageKey } from '../src/lib/account-storage.js';
import { Workbook } from '../src/core/workbook.js';
import { toast } from '../src/ui/toast.js';
import { promptDialog } from '../src/ui/modal.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { installMockPuter } from './helpers/mock-puter.js';

vi.mock('../src/lib/session.js', () => ({ session: { settings: {}, username: 'Test user', signedOut: false, addEventListener() {}, removeEventListener() {} } }));
vi.mock('../src/lib/recent.js', () => ({ refreshRecent: async () => [], recentFiles: () => [], forgetRecent: vi.fn(), rememberRecent() {} }));
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
vi.mock('../src/ui/modal.js', () => ({ promptDialog: vi.fn(), confirmDialog: vi.fn(async () => true), openModal: vi.fn() }));

if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function () {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(this); });
  };
}

let mock;
beforeEach(() => { Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true }); mock = installMockPuter(); toast.mockClear(); document.body.replaceChildren(); });
afterEach(() => { closeMenu(); vi.restoreAllMocks(); document.body.replaceChildren(); delete globalThis.puter; });

const settle = async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const consentKey = (path) => `${accountStorageKey('spreadsheet:external')}${path}`;

// Rename… offers the name as it is; pressed through unchanged, it renamed the file onto its own name and moved what
// this browser keeps for the file from that address to the same one, which takes it away: a file whose outside
// content was blocked came back with no decision, and on the drive a rename onto an existing name is refused.
it.each([['Budget'], ['Budget.xlsx'], ['  Budget  ']])('leaves a file and what is kept for it alone when Rename is pressed with its name as it is (%s)', async (typed) => {
  const bytes = await Doc.blank().toXlsxBlob();
  mock.fs.set('Spreadsheets/Budget.xlsx', { blob: bytes, size: bytes.size, modified: 1 });
  const offline = new Workbook();
  offline.setInput(offline.activeSheetId, 0, 0, 'offline edits');
  expect(saveDraft(draftKey('Spreadsheets/Budget.xlsx'), offline, 'Budget', 'rev-1')).toBe(true);
  const blocked = await Doc.fromPath('Spreadsheets/Budget.xlsx');
  blocked.distrustExternal();
  blocked.destroy();
  expect(localStorage.getItem(consentKey('Spreadsheets/Budget.xlsx'))).toMatch(/^0:/);
  promptDialog.mockImplementation(async ({ validate }) => (validate(typed.trim()) ? null : typed.trim()));

  const view = homeView({});
  document.body.append(view.el);
  await settle(4);
  view.el.querySelector('.file-menu-btn').click();
  [...document.querySelectorAll('.menu-item')].find((node) => node.querySelector('.menu-label')?.textContent === 'Rename…').click();
  await settle(8);

  expect(promptDialog).toHaveBeenCalled();
  expect(mock.calls.filter(([op]) => op === 'rename')).toEqual([]);
  expect(mock.fs.has('Spreadsheets/Budget.xlsx')).toBe(true);
  expect(localStorage.getItem(consentKey('Spreadsheets/Budget.xlsx'))).toMatch(/^0:/);
  expect(loadDraft(draftKey('Spreadsheets/Budget.xlsx'))).not.toBeNull();
  expect(toast).not.toHaveBeenCalled();
  view.destroy();
});
