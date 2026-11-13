import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAccount } from '../src/ui/account.js';
import * as puter from '../src/storage/puter.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const settle = () => new Promise((resolve) => setTimeout(resolve));
let sdk, app;
beforeEach(() => {
  sdk = {
    env: 'web', user: { username: 'previous' },
    auth: {
      isSignedIn: () => !!sdk.user,
      getUser: vi.fn(async () => sdk.user),
      getProfilePicture: vi.fn(async () => null),
      signIn: vi.fn(async () => { sdk.user = { username: 'current' }; }),
      signOut: vi.fn(async () => { sdk.user = null; }),
    },
  };
  vi.stubGlobal('puter', sdk);
  puter.resetAccountCache();
  app = { emit: vi.fn(), notify: vi.fn(), openMenu: vi.fn() };
});
afterEach(() => {
  puter.resetAccountCache();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it.each(['user', 'picture'])('keeps the current account when an earlier %s lookup completes', async (kind) => {
  const previous = deferred();
  if (kind === 'user') sdk.auth.getUser.mockReturnValueOnce(previous.promise);
  else sdk.auth.getProfilePicture.mockReturnValueOnce(previous.promise);
  const el = createAccount(app);
  document.body.append(el);
  sdk.user = { username: 'current' };
  sdk.auth.getProfilePicture.mockResolvedValue('data:image/png;base64,current');
  await app.refreshAccount();
  expect(el.querySelector('.account-btn').getAttribute('aria-label')).toBe('Account: current');
  const emitted = app.emit.mock.calls.length;
  previous.resolve(kind === 'user' ? { username: 'previous' } : 'data:image/png;base64,previous');
  await settle();
  expect(el.querySelector('.account-btn').getAttribute('aria-label')).toBe('Account: current');
  expect(el.querySelector('.avatar').getAttribute('src')).toBe('data:image/png;base64,current');
  expect(app.emit).toHaveBeenCalledTimes(emitted);
});

it('invalidates a pending profile refresh when signing out with the fallback menu', async () => {
  const previous = deferred();
  sdk.auth.getProfilePicture.mockReturnValueOnce(previous.promise);
  const el = createAccount(app);
  el.querySelector('.account-btn').click();
  await app.openMenu.mock.calls[0][0].find((item) => item.label === 'Sign Out').run();
  expect(el.querySelector('.account-signin')).not.toBe(null);
  const emitted = app.emit.mock.calls.length;
  previous.resolve('data:image/png;base64,previous');
  await settle();
  expect(el.querySelector('.account-signin')).not.toBe(null);
  expect(app.emit).toHaveBeenCalledTimes(emitted);
  el.querySelector('.account-signin').click();
  await settle();
  expect(el.querySelector('.account-btn').getAttribute('aria-label')).toBe('Account: current');
});

it('announces fallback sign-in without waiting for the profile picture', async () => {
  sdk.user = null;
  const el = createAccount(app);
  app.emit.mockClear();
  const picture = deferred();
  sdk.auth.getProfilePicture.mockReturnValueOnce(picture.promise);
  el.querySelector('.account-signin').click();
  await settle();
  expect(sdk.auth.isSignedIn()).toBe(true);
  expect(app.emit).toHaveBeenCalledExactlyOnceWith('account');
  expect(el.querySelector('.account-btn')).not.toBe(null);
  picture.resolve('data:image/png;base64,current');
  await settle();
  expect(el.querySelector('.avatar').getAttribute('src')).toBe('data:image/png;base64,current');
  expect(app.emit).toHaveBeenCalledOnce();
});

it('reports a failed fallback sign-out and allows retry without claiming the session ended', async () => {
  const el = createAccount(app);
  await settle();
  const emitted = app.emit.mock.calls.length;
  sdk.auth.signOut.mockRejectedValueOnce(new Error('Sign out is temporarily unavailable'));
  el.querySelector('.account-btn').click();
  const signOut = app.openMenu.mock.calls.at(-1)[0].find((item) => item.label === 'Sign Out');
  await expect(signOut.run()).resolves.toBeUndefined();
  expect(app.notify).toHaveBeenCalledWith('Sign out is temporarily unavailable', { error: true });
  expect(app.emit).toHaveBeenCalledTimes(emitted);
  expect(el.querySelector('.account-btn').getAttribute('aria-label')).toBe('Account: previous');
  el.querySelector('.account-btn').click();
  await app.openMenu.mock.calls.at(-1)[0].find((item) => item.label === 'Sign Out').run();
  expect(el.querySelector('.account-signin')).not.toBe(null);
  expect(app.emit).toHaveBeenCalledTimes(emitted + 1);
});
