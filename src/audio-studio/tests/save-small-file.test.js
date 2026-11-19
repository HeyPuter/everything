import { afterEach, expect, it, vi } from 'vitest';
import { Prefs } from '../src/lib/prefs.js';
import { saveSmallFile, withFileExtension } from '../src/export/save-file.js';

afterEach(() => {
  delete window.puter;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it('keeps the extension a file needs', () => {
  expect(withFileExtension('Talk Markers', '.csv')).toBe('Talk Markers.csv');
  expect(withFileExtension('Talk.txt', '.csv')).toBe('Talk.csv');
  expect(withFileExtension('Talk.CSV', '.csv')).toBe('Talk.CSV');
});

it('downloads at once when not signed in to Puter', async () => {
  const blobs = [];
  vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: (b) => (blobs.push(b), 'blob:x'), revokeObjectURL: () => {} }));
  const app = { prefs: new Prefs(null) };
  expect(await saveSmallFile(app, new Blob(['a']), 'A.csv')).toEqual({ type: 'download', name: 'A.csv' });
  expect(blobs).toHaveLength(1);
});

it('saves into a Puter folder, asking before replacing a file, and remembers the folder', async () => {
  const stored = new Map([['/u/Lists/Old.csv', 'x']]);
  window.puter = {
    auth: { isSignedIn: () => true },
    ui: { showDirectoryPicker: async () => ({ path: '/u/Lists' }) },
    fs: {
      stat: async (p) => (stored.has(p) ? { path: p } : Promise.reject({ code: 'subject_does_not_exist' })),
      write: async (p, b) => (stored.set(p, b), { path: p }),
    },
  };
  const app = { prefs: new Prefs(null) };
  const pending = saveSmallFile(app, new Blob(['a,b']), 'Old.csv', { title: 'Export', ext: '.csv', pref: 'listFolder' });
  await vi.waitFor(() => expect(document.querySelector('.io-export-dialog')).not.toBeNull());
  [...document.querySelectorAll('.io-export-dialog button')].find((b) => b.textContent === 'Browse...').click();
  await vi.waitFor(() => expect(document.querySelector('.io-path').textContent).toBe('/u/Lists'));
  document.querySelector('.dialog-foot button[data-value="ok"]').click();
  await vi.waitFor(() => expect([...document.querySelectorAll('.dialog-foot button')].some((b) => b.textContent === 'Replace')).toBe(true));
  [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Replace').click();
  expect(await pending).toEqual({ type: 'puter', path: '/u/Lists/Old.csv' });
  expect(stored.get('/u/Lists/Old.csv')).toBeInstanceOf(Blob);
  expect(app.prefs.get('listFolder')).toBe('/u/Lists');
});
