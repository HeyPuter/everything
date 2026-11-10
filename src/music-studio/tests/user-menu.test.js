// puter.js's <puter-user-menu>: where the SDK defines it, it stands in for the toolbar's Sign in
// and account buttons, and the app follows the sign-ins and sign-outs it does.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app.js';
import { newProject } from '../src/model/demo.js';
import { createAccount } from '../src/ui/account.js';
import { closeWindows } from '../src/ui/windows.js';
import { applyTheme } from '../src/ui/theme.js';
import { hasUserMenu, USER_MENU_TAG } from '../src/ui/user-menu.js';

// A stand-in with the real element's shape: an open shadow root holding its buttons.
class FakeUserMenu extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = '<button class="sign-in"></button><div class="menu"><button class="menu-item sign-out"></button></div>';
    this.ownSignOut = vi.fn();
    this.shadowRoot.querySelector('.sign-out').addEventListener('click', this.ownSignOut);
  }
}

let sdk;
let app;
const settle = () => new Promise((r) => setTimeout(r));

beforeEach(() => {
  sdk = {
    env: 'web',
    user: { username: 'ada' },
    auth: {
      isSignedIn: () => !!sdk.user,
      signIn: vi.fn(async () => {}),
      signOut: vi.fn(async () => {}),
      getUser: async () => sdk.user,
      getProfilePicture: async () => null,
    },
  };
  window.puter = sdk;
  app = { notify: vi.fn(), emit: vi.fn(), openMenu: vi.fn() };
  document.body.replaceChildren();
});
afterEach(() => {
  delete window.puter;
  applyTheme('system');
});

describe('without <puter-user-menu> in the SDK', () => {
  it('keeps the account button and its Sign Out', async () => {
    expect(hasUserMenu()).toBe(false);
    const el = createAccount(app);
    await settle();
    el.querySelector('.account-btn').click();
    const items = app.openMenu.mock.calls[0][0];
    expect(items.map((i) => i.label)).toEqual(['Signed in as ada', undefined, 'Sign Out']);
  });

  it('keeps the Sign in button', async () => {
    sdk.user = null;
    const el = createAccount(app);
    await settle();
    expect(el.querySelector('.account-signin')).not.toBeNull();
  });
});

describe('with <puter-user-menu> in the SDK', () => {
  beforeEach(() => {
    if (!customElements.get(USER_MENU_TAG)) customElements.define(USER_MENU_TAG, FakeUserMenu);
  });

  it('stands in for the Sign in and account buttons', async () => {
    expect(hasUserMenu()).toBe(true);
    const el = createAccount(app);
    document.body.append(el);
    const menu = el.firstElementChild;
    expect([...el.children].map((n) => n.localName)).toEqual([USER_MENU_TAG]);
    await settle();
    // The same element stays in place when the account is read again.
    await app.refreshAccount();
    expect(el.firstElementChild).toBe(menu);
    expect(el.querySelector('.account-btn, .account-signin')).toBeNull();
  });

  it('stays out of a Puter app window, where the element renders nothing', async () => {
    sdk.env = 'app';
    expect(hasUserMenu()).toBe(false);
    const el = createAccount(app);
    await settle();
    expect(el.querySelector(USER_MENU_TAG)).toBeNull();
    expect(el.querySelector('.account-btn')).not.toBeNull();
  });

  it('follows a sign-in and a sign-out the element did, and leaves its Sign out alone', async () => {
    sdk.user = null;
    const el = createAccount(app);
    await settle();
    app.emit.mockClear();
    const menu = el.firstElementChild;
    sdk.user = { username: 'ada' };
    menu.dispatchEvent(new CustomEvent('signin', { detail: { user: sdk.user } }));
    await settle();
    expect(app.emit).toHaveBeenCalledWith('account');
    app.emit.mockClear();
    menu.shadowRoot.querySelector('.sign-out').click();
    expect(menu.ownSignOut).toHaveBeenCalledTimes(1);
    sdk.user = null;
    menu.dispatchEvent(new CustomEvent('signout'));
    await settle();
    expect(app.emit).toHaveBeenCalledWith('account');
    // The app did not sign in or out a second time.
    expect(sdk.auth.signIn).not.toHaveBeenCalled();
    expect(sdk.auth.signOut).not.toHaveBeenCalled();
  });

  it('follows an explicit theme, and the OS otherwise', () => {
    applyTheme('dark');
    const menu = createAccount(app).firstElementChild;
    expect(menu.getAttribute('theme')).toBe('dark');
    applyTheme('light');
    expect(menu.getAttribute('theme')).toBe('light');
    applyTheme('system');
    expect(menu.hasAttribute('theme')).toBe(false);
  });

  it('ends the toolbar, and keeps its keys from the shortcuts and the typing keyboard', () => {
    const raf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 0;
    Element.prototype.scrollIntoView ||= () => {};
    try {
      document.body.innerHTML = '<div id="app"></div>';
      const m = new Map();
      const storage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
      const real = new App(document.getElementById('app'), { project: newProject(), storage }).start([]);
      const menu = document.querySelector(`.tb-right > .account > ${USER_MENU_TAG}`);
      expect(document.querySelector('.tb-right').lastElementChild).toBe(menu.parentElement);
      expect(document.querySelector('.account-btn, .account-signin')).toBeNull();

      const run = vi.spyOn(real.commands, 'run').mockImplementation(() => {});
      real.prefs.set('typingKeyboard', true);
      const notes = (real.emitKeyboardNote = vi.fn(() => true));
      const press = (target, type, init) => {
        const e = new KeyboardEvent(type, { bubbles: true, composed: true, cancelable: true, ...init });
        target.dispatchEvent(e);
        return e;
      };
      const inside = menu.shadowRoot.querySelector('.sign-in');
      expect(press(inside, 'keydown', { key: 'a', code: 'KeyA' }).defaultPrevented).toBe(false);
      press(inside, 'keyup', { key: 'a', code: 'KeyA' });
      expect(notes).not.toHaveBeenCalled();
      real.prefs.set('typingKeyboard', false);
      expect(press(inside, 'keydown', { key: ' ', code: 'Space' }).defaultPrevented).toBe(false);
      expect(run).not.toHaveBeenCalled();
      expect(press(document.body, 'keydown', { key: ' ', code: 'Space' }).defaultPrevented).toBe(true);
      expect(run).toHaveBeenCalledTimes(1);
      closeWindows();
    } finally {
      globalThis.requestAnimationFrame = raf;
    }
  });
});
