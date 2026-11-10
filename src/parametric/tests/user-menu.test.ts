// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_MENU_TAG, syncUserMenu, userMenuElement } from '../src/app/user-menu';
import { appsButton } from '../src/app/apps-panel';
import { bindUserMenu, refreshAccount } from '../src/app/start';
import type { App } from '../src/app/app';
import { setPuterForTests, type PuterSDK } from '../src/platform/puter';

// puter.js's <puter-user-menu> stands in for the app's own Apps launcher and
// account button on the web, as in Builder.

let signedIn = false;

function sdk(env = 'web'): PuterSDK {
  return {
    env,
    auth: { isSignedIn: () => signedIn, signIn: vi.fn(), signOut: vi.fn(), getUser: async () => ({ username: 'nariman' }) },
  } as unknown as PuterSDK;
}

function fakeApp() {
  const apps = appsButton();
  const account = document.createElement('button');
  const userMenu = userMenuElement();
  document.body.append(apps, account);
  if (userMenu) document.body.append(userMenu);
  const app = { shell: { apps, account, userMenu }, loadRemoteSettings: vi.fn() };
  return app as unknown as App & { loadRemoteSettings: ReturnType<typeof vi.fn> };
}

const toastText = () => document.querySelector('.toast')?.textContent ?? '';

beforeEach(() => {
  signedIn = false;
  setPuterForTests(sdk());
});
afterEach(() => {
  document.body.replaceChildren();
  delete document.documentElement.dataset.themeResolved;
  setPuterForTests(null);
  vi.restoreAllMocks();
});

// Runs first: a custom element can't be undefined once the next block defines it.
describe('with a puter.js that predates the element', () => {
  it("keeps the app's own launcher and account button", async () => {
    expect(userMenuElement()).toBeNull();
    expect(syncUserMenu(null)).toBe(false);
    const app = fakeApp();
    await refreshAccount(app);
    expect(app.shell.apps.hidden).toBe(false);
    expect(app.shell.account.hidden).toBe(false);
    expect(app.shell.account.getAttribute('aria-label')).toBe('Account: not signed in');
  });
});

describe('with <puter-user-menu>', () => {
  beforeEach(() => {
    if (!customElements.get(USER_MENU_TAG)) customElements.define(USER_MENU_TAG, class extends HTMLElement {});
  });

  it("stands in for the app's own launcher and account button on the web", async () => {
    const app = fakeApp();
    await refreshAccount(app);
    expect(app.shell.userMenu!.hidden).toBe(false);
    expect(app.shell.apps.hidden).toBe(true);
    expect(app.shell.account.hidden).toBe(true);
    signedIn = true;
    await refreshAccount(app);
    expect(app.shell.apps.hidden).toBe(true);
    expect(app.shell.account.hidden).toBe(true);
  });

  it("steps aside inside a Puter app window, where the app's account menu stays", async () => {
    setPuterForTests(sdk('app'));
    const app = fakeApp();
    expect(app.shell.userMenu!.hidden).toBe(true);
    await refreshAccount(app);
    expect(app.shell.userMenu!.hidden).toBe(true);
    expect(app.shell.account.hidden).toBe(false);
    // The desktop has its own launcher.
    expect(app.shell.apps.hidden).toBe(true);
  });

  it("follows the app's theme, not only the OS", () => {
    document.documentElement.dataset.themeResolved = 'dark';
    const app = fakeApp();
    const el = app.shell.userMenu!;
    expect(el.getAttribute('theme')).toBe('dark');
    bindUserMenu(app);
    document.documentElement.dataset.themeResolved = 'light';
    window.dispatchEvent(new CustomEvent('themechange'));
    expect(el.getAttribute('theme')).toBe('light');
  });

  it('loads the account settings after its Sign in', async () => {
    const app = fakeApp();
    bindUserMenu(app);
    signedIn = true;
    app.shell.userMenu!.dispatchEvent(new CustomEvent('signin', { detail: { user: { username: 'nariman' } } }));
    await vi.waitFor(() => expect(app.loadRemoteSettings).toHaveBeenCalledTimes(1));
    expect(toastText()).toContain('saved to your Puter cloud');
    expect(app.shell.account.hidden).toBe(true);
  });

  it('does nothing for a Sign in that ended signed out', async () => {
    const app = fakeApp();
    bindUserMenu(app);
    app.shell.userMenu!.dispatchEvent(new CustomEvent('signin', { detail: { user: null } }));
    await Promise.resolve();
    expect(app.loadRemoteSettings).not.toHaveBeenCalled();
    expect(toastText()).toBe('');
  });

  it('says where new parts go after its Sign out', () => {
    const app = fakeApp();
    bindUserMenu(app);
    app.shell.userMenu!.dispatchEvent(new CustomEvent('signout'));
    expect(toastText()).toContain('saved in this browser');
  });
});
