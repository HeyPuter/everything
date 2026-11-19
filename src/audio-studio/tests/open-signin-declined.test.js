import { afterEach, expect, it, vi } from 'vitest';
import { openFromPuter } from '../src/storage/files.js';

afterEach(() => delete window.puter);

it('File > Open says where else files come from when Puter sign-in is declined', async () => {
  window.puter = { auth: { isSignedIn: () => false, signIn: async () => Promise.reject(new Error('popup blocked')) } };
  const app = { notify: vi.fn() };
  expect(await openFromPuter(app)).toEqual([]);
  expect(app.notify.mock.calls[0][0]).toContain('Open from This Device');
});
