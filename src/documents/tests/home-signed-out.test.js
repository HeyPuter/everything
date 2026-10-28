// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { homeView } from '../src/views/home.js';
import { session } from '../src/lib/session.js';
import { closeMenu } from '../src/ui/menu.js';

let sdk, view;
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {} }));
  sdk = {
    env: 'web',
    _signedIn: false,
    auth: {
      isSignedIn: () => sdk._signedIn,
      signIn: vi.fn(async () => { sdk._signedIn = true; }),
      getUser: async () => (sdk._signedIn ? { username: 'nariman' } : null),
    },
    fs: {
      readdir: vi.fn(async () => [{ path: 'Documents/Report.docx', name: 'Report.docx', size: 12, modified: 1 }]),
      stat: async () => null, mkdir: async () => {},
    },
  };
  vi.stubGlobal('puter', sdk);
});
afterEach(() => {
  view?.destroy();
  closeMenu();
  document.body.replaceChildren();
  session.state = 'unknown';
  session.user = null;
  vi.unstubAllGlobals();
});

it('offers the sign-in in place of the list, then lists the documents once signed in', async () => {
  await session.init();
  const newDoc = vi.fn();
  view = homeView({ openPath: vi.fn(), newDoc, newFromTemplate: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await Promise.resolve();

  const list = view.el.querySelector('.file-list');
  expect(list.textContent).toContain('Sign in to see your documents');
  expect(sdk.fs.readdir).not.toHaveBeenCalled();
  expect(list.querySelector('.file-row')).toBeNull();
  const account = view.el.querySelector('.user-btn');
  expect(account.title).toBe('Not signed in');
  // With nothing listed, sorting and searching have nothing to work on: they are not offered.
  const tools = view.el.querySelector('.home-list-tools');
  expect(tools.hidden).toBe(true);

  // Writing needs no account at all.
  [...list.querySelectorAll('button')].find((b) => b.textContent === 'New document').click();
  expect(newDoc).toHaveBeenCalledTimes(1);

  [...list.querySelectorAll('button')].find((b) => b.textContent === 'Sign in to Puter').click();
  await vi.waitFor(() => expect(sdk.auth.signIn).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(list.querySelector('.file-row .file-name')?.textContent).toBe('Report'));
  expect(list.textContent).not.toContain('Sign in to see your documents');
  expect(tools.hidden).toBe(false);
  expect(account.title).toBe('nariman');
  expect(account.textContent).toBe('n');
});

it('asks for the sign-in before opening Puter\'s file picker', async () => {
  sdk.ui = { showOpenFilePicker: vi.fn(async () => ({ path: 'Desktop/Picked.docx', name: 'Picked.docx' })) };
  await session.init();
  const openPath = vi.fn();
  view = homeView({ openPath, newDoc: vi.fn(), newFromTemplate: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  [...view.el.querySelectorAll('.home-actions button')].find((b) => b.textContent === 'Open from Puter').click();
  await vi.waitFor(() => expect(openPath).toHaveBeenCalledWith('Desktop/Picked.docx'));
  expect(sdk.auth.signIn).toHaveBeenCalledTimes(1);
  expect(sdk.auth.signIn.mock.invocationCallOrder[0]).toBeLessThan(sdk.ui.showOpenFilePicker.mock.invocationCallOrder[0]);
});
