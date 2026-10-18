// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { homeView } from '../src/views/home.js';
import * as P from '../src/lib/puter.js';

vi.mock('../src/lib/session.js', () => ({ session: { settings: {}, username: 'Test user', signedOut: false, addEventListener() {}, removeEventListener() {} } }));
vi.mock('../src/lib/recent.js', () => ({ refreshRecent: async () => [], recentFiles: () => [], forgetRecent() {} }));
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

// Every keystroke in the search, and every change of order, built each row of the list again: on a list of three
// thousand spreadsheets a fifth of a second a keystroke. The rows are built once per listing and put back.
beforeEach(() => { vi.useFakeTimers(); document.body.replaceChildren(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren(); });

const open = () => {
  const view = homeView({ openPath() {}, newDoc() {}, sampleDoc() {}, templateDoc() {}, importFile() {} });
  document.body.append(view.el);
  return view;
};
const files = (n) => Array.from({ length: n }, (_, i) => ({ path: `Spreadsheets/Report ${i}.xlsx`, name: `Report ${i}.xlsx`, size: 1000 + i, modified: Date.now() - 30000 - i * 1000 }));

it('puts the same rows back as the search narrows and widens the list', async () => {
  vi.spyOn(P, 'listFiles').mockResolvedValue(files(300));
  const view = open();
  await vi.advanceTimersByTimeAsync(0);
  const search = view.el.querySelector('.home-search');
  const type = (text) => { search.value = text; search.dispatchEvent(new Event('input')); };
  const rows = () => [...view.el.querySelectorAll('.file-row')];
  const first = rows();
  expect(first).toHaveLength(300);
  const row = view.el.querySelector('[data-focus-key="Spreadsheets/Report 12.xlsx"]');
  type('12');
  expect(rows().map((r) => r.querySelector('.file-name').textContent)).toEqual(['Report 12', 'Report 112', 'Report 120', 'Report 121', 'Report 122', 'Report 123', 'Report 124', 'Report 125', 'Report 126', 'Report 127', 'Report 128', 'Report 129', 'Report 212']);
  expect(rows()[0]).toBe(row);
  type('');
  // The very rows first drawn, none built again.
  expect(rows().every((r, i) => r === first[i])).toBe(true);
  view.destroy();
});

it('keeps the times of rows a search hid current, for when they are shown again', async () => {
  vi.spyOn(P, 'listFiles').mockResolvedValue(files(2));
  const view = open();
  await vi.advanceTimersByTimeAsync(0);
  const search = view.el.querySelector('.home-search');
  const type = (text) => { search.value = text; search.dispatchEvent(new Event('input')); };
  const when = (name) => view.el.querySelector(`[data-focus-key="Spreadsheets/${name}.xlsx"] .file-when`)?.textContent;
  expect(when('Report 1')).toBe('Just now');
  type('Report 0');
  expect(when('Report 1')).toBeUndefined();
  await vi.advanceTimersByTimeAsync(2 * 60000);
  type('');
  expect(when('Report 1')).toBe('2 min ago');
  expect(when('Report 0')).toBe('2 min ago');
  view.destroy();
  expect(vi.getTimerCount()).toBe(0);
});

it('builds the rows again when the list is loaded again, so a renamed or changed file shows as it is now', async () => {
  const list = vi.spyOn(P, 'listFiles').mockResolvedValue(files(2));
  const view = open();
  await vi.advanceTimersByTimeAsync(0);
  const before = view.el.querySelector('.file-row');
  list.mockResolvedValue([{ ...files(2)[0], name: 'Renamed.xlsx', path: 'Spreadsheets/Renamed.xlsx' }, files(2)[1]]);
  view.reload();
  await vi.advanceTimersByTimeAsync(0);
  const after = view.el.querySelector('.file-row');
  expect(after).not.toBe(before);
  expect(after.querySelector('.file-name').textContent).toBe('Renamed');
  view.destroy();
});
