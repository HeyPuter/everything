// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { hasUserMenu, userMenuSlot, USER_MENU_TAG } from '../src/ui/user-menu.js';

// puter.js's <puter-user-menu> in the title bar: where the SDK defines it, it stands in for the
// app's Sign in button and account button, its Sign out is the app's, and the app follows a
// sign-in or sign-out it did by itself.

// A stand-in with the real element's shape: an open shadow root holding the Sign out item.
class FakeUserMenu extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML =
      '<button class="avatar"></button><div class="menu"><button class="menu-item feedback"></button><button class="menu-item sign-out"></button></div>';
    this.ownSignOut = vi.fn();
    this.escapes = 0;
    this.shadowRoot.querySelector('.sign-out').addEventListener('click', this.ownSignOut);
    this.shadowRoot.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.escapes++;
    });
  }
}

let sdk;

/** The account part of the app, on a title bar with the account and the slot. */
function account() {
  const accountEl = document.createElement('div');
  accountEl.className = 'account';
  const titlebar = document.createElement('header');
  titlebar.className = 'titlebar';
  titlebar.append(accountEl, userMenuSlot());
  document.body.append(titlebar);
  const app = { shell: { account: accountEl, userMenu: titlebar.lastChild }, signedIn: false, user: null, settings: {}, setTheme() {}, applySettings() {} };
  for (const name of ['mountUserMenu', 'renderAccount', 'onSignedIn', 'afterSignIn', 'signIn', 'signOut', 'signedOut', 'accountMenu', 'syncSettingsFromCloud']) {
    app[name] = App.prototype[name].bind(app);
  }
  return app;
}
const toasts = () => [...document.querySelectorAll('.toast-msg')].map((t) => t.textContent);

beforeEach(() => {
  sdk = {
    env: 'web',
    _user: null,
    auth: {
      isSignedIn: () => !!sdk._user,
      getUser: async () => sdk._user,
      signIn: vi.fn(),
      signOut: vi.fn(() => {
        sdk._user = null;
      }),
    },
    kv: { get: async () => null, set: vi.fn(async () => true) },
  };
  vi.stubGlobal('puter', sdk);
});
afterEach(() => {
  // The toast region is made once and kept.
  document.querySelectorAll('.titlebar, .menu, .toast').forEach((el) => el.remove());
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('without <puter-user-menu> in the SDK', () => {
  it('keeps the Sign in button and the account button', async () => {
    expect(hasUserMenu()).toBe(false);
    const app = account();
    app.mountUserMenu();
    app.renderAccount();
    expect(app.userMenu).toBe(null);
    expect(document.querySelector(USER_MENU_TAG)).toBe(null);
    expect(app.shell.userMenu.hidden).toBe(true);
    expect(app.shell.account.hidden).toBe(false);
    expect(app.shell.account.querySelector('button.signin')).not.toBe(null);

    sdk._user = { username: 'ada' };
    await app.afterSignIn();
    app.shell.account.querySelector('button.avatar-btn').click();
    expect([...document.querySelectorAll('.menu .menu-item')].map((b) => b.textContent)).toEqual(['Sign out']);
  });
});

describe('with <puter-user-menu> in the SDK', () => {
  beforeEach(() => {
    if (!customElements.get(USER_MENU_TAG)) customElements.define(USER_MENU_TAG, FakeUserMenu);
  });

  it('takes the place of the Sign in button once the SDK has loaded', () => {
    const app = account();
    // The title bar is drawn before the async SDK script arrives.
    vi.stubGlobal('puter', undefined);
    app.mountUserMenu();
    app.renderAccount();
    expect(app.shell.account.querySelector('button.signin')).not.toBe(null);

    vi.stubGlobal('puter', sdk);
    app.mountUserMenu();
    app.renderAccount();
    const menu = document.querySelector(USER_MENU_TAG);
    expect(menu).toBe(app.userMenu);
    expect(menu.previousElementSibling).toBe(app.shell.account);
    expect(document.querySelector('.user-menu-slot')).toBe(null);
    expect(app.shell.account.hidden).toBe(true);
    expect(app.shell.account.childElementCount).toBe(0);
    // Once is enough: later calls keep the element.
    app.mountUserMenu();
    expect(document.querySelectorAll(USER_MENU_TAG)).toHaveLength(1);
  });

  it("stays on the app's theme", async () => {
    document.documentElement.dataset.theme = 'dark';
    const app = account();
    app.mountUserMenu();
    expect(app.userMenu.getAttribute('theme')).toBe('dark');
    document.documentElement.dataset.theme = 'light';
    await Promise.resolve();
    expect(app.userMenu.getAttribute('theme')).toBe('light');
    // System: the element follows the OS by itself.
    delete document.documentElement.dataset.theme;
    await Promise.resolve();
    expect(app.userMenu.hasAttribute('theme')).toBe(false);
  });

  it("runs the app's sign-out in place of its own", async () => {
    sdk._user = { username: 'ada' };
    const app = account();
    app.mountUserMenu();
    await app.afterSignIn();
    const pending = vi.fn();
    app._kvTimer = setTimeout(pending, 1e9);
    const cleared = vi.spyOn(globalThis, 'clearTimeout');

    app.userMenu.shadowRoot.querySelector('.sign-out').click();
    expect(app.userMenu.ownSignOut).not.toHaveBeenCalled();
    expect(app.userMenu.escapes).toBe(1);
    expect(sdk.auth.signOut).toHaveBeenCalledTimes(1);
    // The settings write waiting to sync is dropped before the SDK signs out.
    expect(cleared).toHaveBeenCalledWith(app._kvTimer);
    expect(cleared.mock.invocationCallOrder[0]).toBeLessThan(sdk.auth.signOut.mock.invocationCallOrder[0]);
    expect(app.signedIn).toBe(false);
    expect(app.user).toBe(null);
    expect(toasts()).toContain('Signed out. Open drawings stay on this device.');
    // Other items are the element's.
    app.userMenu.shadowRoot.querySelector('.feedback').click();
    expect(sdk.auth.signOut).toHaveBeenCalledTimes(1);
    clearTimeout(app._kvTimer);
  });

  it('follows a sign-out the element did by itself', async () => {
    sdk._user = { username: 'ada' };
    const app = account();
    app.mountUserMenu();
    await app.afterSignIn();
    sdk._user = null;
    app.userMenu.dispatchEvent(new CustomEvent('signout'));
    expect(sdk.auth.signOut).not.toHaveBeenCalled();
    expect(app.signedIn).toBe(false);
    expect(app.user).toBe(null);
    expect(toasts()).toContain('Signed out. Open drawings stay on this device.');
  });

  it('follows a sign-in the element did', async () => {
    const app = account();
    app.mountUserMenu();
    sdk._user = { username: 'ada' };
    app.userMenu.dispatchEvent(new CustomEvent('signin', { detail: { user: sdk._user } }));
    await vi.waitFor(() => expect(app.user).toEqual({ username: 'ada' }));
    expect(app.signedIn).toBe(true);
    expect(sdk.auth.signIn).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(toasts()).toContain('Signed in. You can now save drawings to your Puter drive.'));
    expect(app.shell.account.hidden).toBe(true);
    expect(app.shell.account.childElementCount).toBe(0);
  });

  it('leaves keys from inside the element alone', () => {
    const app = account();
    app.mountUserMenu();
    const other = document.createElement('button');
    document.querySelector('.titlebar').append(other);
    const typed = [];
    const keys = {
      editor: { shiftDown: false, spaceSubmits: true, busy: false, cancel: vi.fn() },
      cmdline: { input: document.createElement('input'), type: (k) => typed.push(k), setValue: vi.fn(), submit: vi.fn() },
      ribbon: { flyoutOpen: false },
      shell: { overlay: document.createElement('canvas') },
      doc: { selection: new Set() },
    };
    const events = [];
    const onKey = (e) => {
      App.prototype.onKey.call(keys, e);
      events.push(e);
    };
    window.addEventListener('keydown', onKey);
    const press = (from, key) => from.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true }));

    const avatar = app.userMenu.shadowRoot.querySelector('.avatar');
    for (const key of [' ', 'l', 'Escape', 'Enter']) press(avatar, key);
    expect(events.map((e) => e.target)).toEqual(Array(4).fill(app.userMenu));
    expect(events.some((e) => e.defaultPrevented)).toBe(false);
    expect(typed).toEqual([]);
    expect(keys.editor.cancel).not.toHaveBeenCalled();

    // The same letter from the title bar's own buttons still starts a command.
    press(other, 'l');
    expect(typed).toEqual(['l']);
    window.removeEventListener('keydown', onKey);
  });

  it("keeps the app's own account controls inside a Puter app window", async () => {
    sdk.env = 'app';
    sdk._user = { username: 'ada' };
    expect(hasUserMenu()).toBe(false);
    const app = account();
    app.mountUserMenu();
    await app.afterSignIn();
    expect(app.userMenu).toBe(null);
    expect(document.querySelector(USER_MENU_TAG)).toBe(null);
    expect(app.shell.account.hidden).toBe(false);
    expect(app.shell.account.querySelector('button.avatar-btn')).not.toBe(null);
  });
});
