// puter.js's <puter-user-menu>: where the SDK defines it, it stands in for the top bar's Sign in
// and account buttons, and the app follows the sign-ins and sign-outs it does.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootApp } from './helpers.js';
import { applyTheme } from '../src/theme.js';
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

const key = (target, init) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, composed: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

beforeEach(() => {
  vi.stubGlobal('puter', { env: 'web' });
});
afterEach(() => {
  applyTheme('system');
  vi.unstubAllGlobals();
});

describe('without <puter-user-menu> in the SDK', () => {
  it('keeps the account button', () => {
    expect(hasUserMenu()).toBe(false);
    const app = bootApp({ env: 'web', user: { username: 'ada' } });
    expect(app.userMenu).toBe(null);
    expect(document.querySelector('.account > .account-btn')).not.toBeNull();
  });

  it('keeps the Sign in button', () => {
    const app = bootApp({ env: 'web' });
    app.onSignIn = vi.fn();
    app.renderAccount();
    document.querySelector('.account > .signin-btn').click();
    expect(app.onSignIn).toHaveBeenCalledTimes(1);
  });
});

describe('with <puter-user-menu> in the SDK', () => {
  beforeEach(() => {
    if (!customElements.get(USER_MENU_TAG)) customElements.define(USER_MENU_TAG, FakeUserMenu);
  });

  it('ends the top bar in place of the Sign in and account buttons', () => {
    expect(hasUserMenu()).toBe(true);
    const app = bootApp({ env: 'web' });
    app.onSignIn = vi.fn();
    app.renderAccount();
    const right = document.querySelector('.topbar-right');
    expect(right.lastElementChild.className).toBe('account');
    expect([...right.lastElementChild.children].map((n) => n.localName)).toEqual([USER_MENU_TAG]);
    expect(document.querySelector('.signin-btn, .account-btn')).toBeNull();
    // The same element stays in place when the account changes.
    const menu = app.userMenu;
    app.setUser({ username: 'ada' }, null);
    expect(document.querySelector('.account').firstElementChild).toBe(menu);
    expect(document.querySelector('.signin-btn, .account-btn')).toBeNull();
  });

  it('stays out of a Puter app window, where the element renders nothing', () => {
    vi.stubGlobal('puter', { env: 'app' });
    expect(hasUserMenu()).toBe(false);
    bootApp({ env: 'app', user: { username: 'ada' } });
    expect(document.querySelector(USER_MENU_TAG)).toBeNull();
    expect(document.querySelector('.account > .account-btn')).not.toBeNull();
  });

  it('follows a sign-in and a sign-out the element did, and leaves its Sign out alone', () => {
    const app = bootApp({ env: 'web' });
    app.onSessionChange = vi.fn();
    app.onSignOut = vi.fn();
    app.userMenu.dispatchEvent(new CustomEvent('signin', { detail: { user: { username: 'ada' } } }));
    expect(app.onSessionChange).toHaveBeenCalledTimes(1);
    app.userMenu.shadowRoot.querySelector('.sign-out').click();
    expect(app.userMenu.ownSignOut).toHaveBeenCalledTimes(1);
    expect(app.onSignOut).not.toHaveBeenCalled();
    app.userMenu.dispatchEvent(new CustomEvent('signout'));
    expect(app.onSessionChange).toHaveBeenCalledTimes(2);
  });

  it('follows a chosen brightness, and the OS otherwise', () => {
    const app = bootApp({ env: 'web' });
    expect(app.userMenu.hasAttribute('theme')).toBe(false);
    applyTheme('medium-dark');
    expect(app.userMenu.getAttribute('theme')).toBe('dark');
    applyTheme('medium-light');
    expect(app.userMenu.getAttribute('theme')).toBe('light');
    applyTheme('system');
    expect(app.userMenu.hasAttribute('theme')).toBe(false);
  });

  it('keeps its keys: tool shortcuts and Space do nothing from inside it', () => {
    const app = bootApp({ env: 'web' });
    app.newDocument();
    const inside = app.userMenu.shadowRoot.querySelector('.sign-in');
    key(inside, { key: 'p', code: 'KeyP' });
    expect(app.toolId).toBe('selection');
    expect(key(inside, { key: ' ', code: 'Space' }).defaultPrevented).toBe(false);
    expect(app.input.spaceDown).toBeFalsy();
    key(document.body, { key: 'p', code: 'KeyP' });
    expect(app.toolId).toBe('pen');
  });
});
