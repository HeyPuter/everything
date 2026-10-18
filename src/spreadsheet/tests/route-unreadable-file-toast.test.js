// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Opening a damaged, password-protected or oversized file said only "Could not open the file" (or
// "Could not read <name>" for a file from this device), though the reader had said what was wrong.
const mocks = vi.hoisted(() => ({ fromPath: vi.fn(), fromBrowserFile: vi.fn(), editor: vi.fn(), home: vi.fn(), toast: vi.fn() }));
vi.mock('../src/lib/doc.js', () => ({ Doc: { fromPath: mocks.fromPath, fromBrowserFile: mocks.fromBrowserFile, fromDraft: vi.fn() } }));
vi.mock('../src/views/editor.js', () => ({ editorView: mocks.editor }));
vi.mock('../src/views/home.js', () => ({ homeView: mocks.home }));
vi.mock('../src/ui/toast.js', () => ({ toast: mocks.toast }));
vi.mock('../src/lib/session.js', () => ({ session: { init: async () => {}, signedOut: false, addEventListener() {}, removeEventListener() {} } }));
vi.mock('../src/lib/recent.js', () => ({ rememberRecent: vi.fn(), forgetRecent: vi.fn() }));
vi.mock('../src/lib/puter.js', () => ({
  hasSDK: () => true, isSignedIn: async () => true, onAuth() {}, onLaunchedWithItems() {}, onWindowClose() {}, setWindowTitle() {}, isNotFound: () => false, samePath: (a, b) => a === b,
}));

let handlers;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  document.body.innerHTML = '<div id="app"></div>';
  mocks.home.mockImplementation(() => ({ el: document.createElement('div'), destroy: vi.fn() }));
  handlers = [];
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => { handlers.push([type, listener, options]); add(type, listener, options); });
});
afterEach(() => {
  for (const [type, listener, options] of handlers) window.removeEventListener(type, listener, options);
  vi.restoreAllMocks();
  document.body.replaceChildren();
  history.replaceState(null, '', '#/');
});

const unreadable = () => Object.assign(new Error('This file could not be read. It may be damaged or incomplete, or not a spreadsheet'), { code: 'unreadable' });

it('says why a file from the drive could not be opened', async () => {
  mocks.fromPath.mockRejectedValue(unreadable());
  history.replaceState(null, '', `#/edit/${encodeURIComponent('/nj/Desktop/Cut.xlsx')}`);
  await import('../src/main.js');
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/damaged or incomplete/), expect.anything());
});

it('keeps the plain message for a failure the reader did not explain', async () => {
  mocks.fromPath.mockRejectedValue(new Error('Network down at 10.0.0.1'));
  history.replaceState(null, '', `#/edit/${encodeURIComponent('/nj/Desktop/Any.xlsx')}`);
  await import('../src/main.js');
  await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(mocks.toast).toHaveBeenCalledWith('Could not open the file', expect.anything());
});
