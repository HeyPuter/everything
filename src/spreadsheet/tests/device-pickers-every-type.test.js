// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { homeView } from '../src/views/home.js';
import { Doc } from '../src/lib/doc.js';
import * as P from '../src/lib/puter.js';
import { IMPORT_EXTENSIONS } from '../src/core/filetypes.js';

vi.mock('../src/lib/recent.js', () => ({ refreshRecent: async () => [], recentFiles: () => [], forgetRecent() {}, rememberRecent() {} }));

// Open from this device (home and File ▸ Open) and Import offered six kinds of file, so a Numbers file,
// an .xlsb, a flat .ods or an Excel template, which open when dropped, could not be picked there.
let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.replaceChildren();
});
afterEach(() => { view?.destroy?.(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const spreadsheetPickers = (root) => [...root.querySelectorAll('input[type="file"]')].filter((i) => i.accept.includes('.xlsx'));

it('offer every kind of file the app opens, on the home screen and in the editor', async () => {
  vi.spyOn(P, 'listFiles').mockResolvedValue([]);
  view = homeView({});
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(0);
  const home = spreadsheetPickers(view.el);
  expect(home).toHaveLength(1);
  view.destroy?.();

  view = editorView({ doc: new Doc({ name: 'Pickers' }), goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const editor = spreadsheetPickers(view.el);
  expect(editor).toHaveLength(2);
  for (const input of [...home, ...editor]) {
    const offered = input.accept.split(',');
    for (const ext of IMPORT_EXTENSIONS) expect(offered, ext).toContain(ext);
    for (const ext of ['.numbers', '.xlsb', '.fods', '.xltx']) expect(offered).toContain(ext);
  }
});
