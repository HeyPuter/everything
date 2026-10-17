// @vitest-environment jsdom
import { beforeAll, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/memory-storage.js';
import { installMockPuter } from './helpers/mock-puter.js';

const mocks = vi.hoisted(() => ({ views: [] }));
vi.mock('../src/views/editor.js', () => ({ editorView: (o) => { const v = { el: document.createElement('div'), doc: o.doc, flush: async () => true, destroy() {}, goTo() {} }; mocks.views.push(v); return v; } }));
vi.mock('../src/views/home.js', () => ({ homeView: () => ({ el: document.createElement('div'), destroy() {} }) }));

let mock, doc, online = true;
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const writes = () => mock.calls.filter(([op, p]) => op === 'write' && !p.includes('/.versions/')).map(([, p]) => p);
const blip = (back = true) => {
  online = false; window.dispatchEvent(new Event('offline'));
  if (back) { online = true; window.dispatchEvent(new Event('online')); }
};

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  mock = installMockPuter();
  document.body.innerHTML = '<div id="app"></div>';
  history.replaceState(null, '', '#/new');
  const { setAutoSaveEnabled } = await import('../src/lib/doc.js');
  setAutoSaveEnabled(false); // the title bar's AutoSave switch: edits wait for Save
  await import('../src/main.js');
  await vi.waitFor(() => expect(mocks.views.length).toBe(1));
  doc = mocks.views[0].doc;
});

it('does not save, on coming back online, edits held back with AutoSave off', async () => {
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'what-if, not to be saved');
  await settle(1700); // past the autosave pause
  expect(writes()).toEqual([]);
  blip();
  await settle(500);
  expect(writes()).toEqual([]);
  expect(doc.status).toBe('unsaved');
});

it('still tries again at once, on coming back online, a Save that failed offline', async () => {
  const write = globalThis.puter.fs.write;
  globalThis.puter.fs.write = async (...a) => { if (!online) throw new Error('Network unavailable'); return write(...a); };
  blip(false);
  await expect(doc.save()).rejects.toThrow();
  expect(doc.status).toBe('offline');
  expect(writes()).toEqual([]);
  online = true; window.dispatchEvent(new Event('online'));
  await vi.waitFor(() => expect(doc.status).toBe('saved'), { timeout: 3000 }); // well before the retry's pause
  expect(writes().length).toBeGreaterThan(0);
});
