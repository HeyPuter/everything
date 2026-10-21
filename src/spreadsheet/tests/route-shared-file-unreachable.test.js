// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// A file its owner shares for editing together, opened while the room could not be reached, opened as a file like any
// other: what the owner saved into it was written over by the room the next time anyone saved the shared workbook.
const mocks = vi.hoisted(() => ({ fromPath: vi.fn(), editor: vi.fn(), home: vi.fn(), toast: vi.fn(), roomForFile: vi.fn(), openRoom: vi.fn() }));
vi.mock('../src/lib/doc.js', () => ({ Doc: { fromPath: mocks.fromPath, fromBrowserFile: vi.fn(), fromDraft: vi.fn() } }));
vi.mock('../src/collab/session.js', () => ({ roomForFile: mocks.roomForFile, openRoom: mocks.openRoom }));
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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  document.body.innerHTML = '<div id="app"></div>';
  mocks.home.mockImplementation(() => ({ el: document.createElement('div'), destroy: vi.fn() }));
  mocks.editor.mockImplementation(({ doc }) => ({ el: document.createElement('div'), doc, destroy: vi.fn() }));
  mocks.roomForFile.mockResolvedValue({ server: 'https://s.puter.work', room: 'r1' });
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

const fileDoc = () => ({ path: '/nj/Spreadsheets/Budget.xlsx', uid: 'u1', file: { path: '/nj/Spreadsheets/Budget.xlsx', uid: 'u1' }, holdForRoom: vi.fn(), destroy: vi.fn(), addEventListener() {}, removeEventListener() {} });

it('opens the file to view only when the room cannot be reached', async () => {
  const doc = fileDoc();
  mocks.fromPath.mockResolvedValue(doc);
  mocks.openRoom.mockRejectedValue(Object.assign(new Error('Could not reach the shared workbook.'), { status: 0 }));
  history.replaceState(null, '', `#/edit/${encodeURIComponent(doc.path)}`);
  await import('../src/main.js');
  await vi.waitFor(() => expect(mocks.editor).toHaveBeenCalled());
  expect(mocks.editor.mock.calls[0][0].doc).toBe(doc);
  expect(doc.holdForRoom).toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/view only/), expect.anything());
});

it('opens the file as any file once its room is closed', async () => {
  const doc = fileDoc();
  mocks.fromPath.mockResolvedValue(doc);
  mocks.openRoom.mockRejectedValue(Object.assign(new Error('The owner stopped sharing this workbook.'), { status: 410 }));
  history.replaceState(null, '', `#/edit/${encodeURIComponent(doc.path)}`);
  await import('../src/main.js');
  await vi.waitFor(() => expect(mocks.editor).toHaveBeenCalled());
  expect(doc.holdForRoom).not.toHaveBeenCalled();
});
