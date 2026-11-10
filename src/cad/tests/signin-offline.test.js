// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../src/io/storage.js', () => ({ recovery: {} }));
const { App } = await import('../src/app.js');

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.puter;
});

const lastError = () => [...document.querySelectorAll('.toast.error .toast-msg')].at(-1).textContent;

function fakeApp() {
  const app = Object.create(App.prototype);
  app.signedIn = false;
  app.renderAccount = () => {};
  return app;
}

describe('signing in', () => {
  it('says that Puter could not be reached when its SDK has not loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await fakeApp().signIn()).toBe(false);
    expect(lastError()).toMatch(/Puter could not be reached/);
    // Not reported as a failed attempt (with a ReferenceError in the console).
    expect(warn).not.toHaveBeenCalled();
  });

  it('still reports a sign-in that failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.puter = { auth: { signIn: async () => Promise.reject({ error: 'server_error' }) } };
    expect(await fakeApp().signIn()).toBe(false);
    expect(lastError()).toMatch(/Could not sign in/);
  });
});
