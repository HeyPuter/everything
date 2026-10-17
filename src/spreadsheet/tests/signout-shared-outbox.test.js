// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/memory-storage.js';

const mocks = vi.hoisted(() => ({ cleared: [] }));
vi.mock('../src/collab/outbox.js', async (original) => ({ ...(await original()), clearOutbox: async (user) => { mocks.cleared.push(user); } }));

const { confirmSignOut } = await import('../src/ui/appmenu.js');
const { closeAllModals } = await import('../src/ui/modal.js');
const P = await import('../src/lib/puter.js');
const { session } = await import('../src/lib/session.js');

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('location', { hash: '#/', reload: vi.fn() });
  vi.stubGlobal('localStorage', memoryStorage());
  vi.spyOn(P, 'signOut').mockImplementation(async () => {});
  document.body.innerHTML = '<div id="app"></div>';
  session.user = { uuid: 'u-alice', username: 'alice' };
});
afterEach(() => { closeAllModals(); vi.restoreAllMocks(); vi.unstubAllGlobals(); session.user = null; });

it("signing out removes the account's unsent shared-workbook changes from this browser before the session ends", async () => {
  const signedOut = [];
  P.signOut.mockImplementation(async () => { signedOut.push([...mocks.cleared]); });
  const pending = confirmSignOut();
  [...document.querySelectorAll('.modal-panel button')].find((b) => b.textContent === 'Sign out').click();
  await pending;
  expect(mocks.cleared).toEqual(['u-alice']);
  expect(signedOut).toEqual([['u-alice']]);
});
