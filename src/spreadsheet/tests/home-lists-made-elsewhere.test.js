// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Doc } from '../src/lib/doc.js';
import { homeView } from '../src/views/home.js';
import { madeFiles } from '../src/lib/made.js';
import { setStorageUser } from '../src/lib/account-storage.js';
import { installMockPuter } from './helpers/mock-puter.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { workbookToXlsx } from '../src/core/io.js';
import { Workbook } from '../src/core/workbook.js';

vi.mock('../src/lib/session.js', () => ({ session: { settings: {}, username: 'demo', signedOut: false, signedIn: true, user: { uuid: 'u-1' }, addEventListener() {}, removeEventListener() {} } }));

// Inside the Puter desktop a new spreadsheet, and a copy, are saved where the user picks them in Puter's Save dialog,
// outside the app folder the home screen lists as "Your spreadsheets". They showed only among the eight files kept as
// opened elsewhere: the ninth pushed the first out, and nothing on the home screen found it again.
let mock;
beforeAll(async () => { await workbookToXlsx(new Workbook()); });
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  setStorageUser({ uuid: 'u-1' });
  mock = installMockPuter();
  globalThis.puter.env = 'app';
  globalThis.puter.ui.showSaveFilePicker = vi.fn((blob, suggested) => {
    const path = `~/Desktop/${suggested.replace(/^Untitled spreadsheet/, `Plan ${mock.fs.size + 1}`)}`;
    mock.fs.set(path, { blob, size: blob.size, modified: Date.now() / 1000, uid: `uid-${path}` });
    const saved = Promise.resolve({ name: path.split('/').pop(), path, uid: `uid-${path}` });
    return Object.assign(saved, { undefinedOnCancel: saved });
  });
  document.body.replaceChildren();
});
afterEach(() => { vi.unstubAllGlobals(); delete globalThis.puter; document.body.replaceChildren(); });

const until = async (test) => { for (let i = 0; i < 400 && !test(); i++) await new Promise((r) => setTimeout(r, 5)); return test(); };

async function makeTen() {
  for (let i = 0; i < 10; i++) {
    const doc = Doc.blank();
    doc.wb.setInput(doc.wb.activeSheetId, 0, 0, String(i));
    expect(await doc.save()).toBe(true);
    doc.destroy();
  }
}

it('lists every spreadsheet saved through the Save dialog among the user’s own', async () => {
  await makeTen();
  const view = homeView({});
  document.body.append(view.el);
  const names = () => [...view.el.querySelectorAll('.file-row .file-name')].map((n) => n.textContent).sort();
  expect(await until(() => names().length === 10)).toBe(true);
  expect(names()).toContain('Plan 1');
  // Two of the same name in different folders are told apart on hover by their folder.
  expect(view.el.querySelector('.file-main').title).toMatch(/Desktop\/Plan \d+\.xlsx$/);
  // Not listed twice, as opened elsewhere too.
  expect(view.el.querySelectorAll('.home-recent:not(.home-drafts):not(.home-shared) .recent-name')).toHaveLength(0);
  view.destroy();
});

it('follows one moved or renamed elsewhere, and forgets one deleted', async () => {
  await makeTen();
  const at = (n) => `~/Desktop/Plan ${n}.xlsx`;
  mock.fs.set('~/Documents/Moved.xlsx', mock.fs.get(at(1)));
  mock.fs.delete(at(1));
  mock.fs.delete(at(2));
  const files = await madeFiles();
  expect(files.map((f) => f.name)).toContain('Moved.xlsx');
  expect(files.map((f) => f.name)).not.toContain('Plan 2.xlsx');
  expect(files).toHaveLength(9);
  expect(JSON.parse(localStorage.getItem('spreadsheet:made:account:uuid%3Au-1:'))).toHaveLength(9);
});
