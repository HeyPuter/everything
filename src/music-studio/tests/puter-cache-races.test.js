import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as puter from '../src/storage/puter.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
function account(name, { user, stat } = {}) {
  return {
    env: 'web',
    auth: { isSignedIn: () => true, getUser: vi.fn(() => user || Promise.resolve({ username: name })), signOut: vi.fn(async () => {}) },
    fs: { stat: vi.fn(() => stat || Promise.resolve({ path: `/${name}/AppData/music/Projects` })), mkdir: vi.fn(async () => ({ path: `/${name}/AppData/music/Projects` })) },
  };
}
beforeEach(() => puter.resetAccountCache());
afterEach(() => { puter.resetAccountCache(); vi.unstubAllGlobals(); });

it.each(['home', 'app'])('does not refill the current %s directory cache with an older account lookup', async (kind) => {
  const old = deferred();
  vi.stubGlobal('puter', account('old', kind === 'home' ? { user: old.promise } : { stat: old.promise }));
  const lookup = kind === 'home' ? puter.homeDir : puter.appDir;
  const pending = lookup().catch(() => null);
  puter.resetAccountCache();
  const current = account('current');
  vi.stubGlobal('puter', current);
  const expected = kind === 'home' ? '/current' : '/current/AppData/music';
  expect(await lookup()).toBe(expected);
  old.resolve(kind === 'home' ? { username: 'old' } : { path: '/old/AppData/music/Projects' });
  await pending;
  expect(await lookup()).toBe(expected);
  expect(kind === 'home' ? current.auth.getUser : current.fs.stat).toHaveBeenCalledOnce();
});

it('does not create a folder for a failed lookup after the account cache was reset', async () => {
  const old = deferred();
  const previous = account('old', { stat: old.promise });
  vi.stubGlobal('puter', previous);
  const pending = puter.appDir().catch(() => null);
  puter.resetAccountCache();
  vi.stubGlobal('puter', account('current'));
  old.reject(new Error('Old request failed'));
  await pending;
  expect(previous.fs.mkdir).not.toHaveBeenCalled();
  expect(await puter.appDir()).toBe('/current/AppData/music');
});

it('ignores a directory creation result that finishes after an account change', async () => {
  const folder = deferred();
  const previous = account('old');
  previous.fs.stat.mockRejectedValueOnce(new Error('Missing'));
  previous.fs.mkdir.mockReturnValueOnce(folder.promise);
  vi.stubGlobal('puter', previous);
  const pending = puter.appDir().catch((err) => err);
  await vi.waitFor(() => expect(previous.fs.mkdir).toHaveBeenCalledOnce());
  puter.resetAccountCache();
  vi.stubGlobal('puter', account('current'));
  expect(await puter.appDir()).toBe('/current/AppData/music');
  folder.resolve({ path: '/old/AppData/music/Projects' });
  expect(await pending).toBeInstanceOf(Error);
  expect(await puter.appDir()).toBe('/current/AppData/music');
});

it('still creates and caches a missing current account directory, then clears it on sign-out', async () => {
  const current = account('current');
  current.fs.stat.mockRejectedValueOnce(new Error('Missing'));
  vi.stubGlobal('puter', current);
  expect(await puter.appDir()).toBe('/current/AppData/music');
  expect(await puter.appDir()).toBe('/current/AppData/music');
  expect(current.fs.mkdir).toHaveBeenCalledOnce();
  await puter.signOut();
  vi.stubGlobal('puter', account('next'));
  expect(await puter.appDir()).toBe('/next/AppData/music');
});
