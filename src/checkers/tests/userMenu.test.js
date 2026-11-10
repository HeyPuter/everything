// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  USER_MENU_TAG,
  hasUserMenu,
  inUserMenu,
  mountUserMenu,
  setUserMenuTheme,
} from '../src/ui/userMenu.js';
import { whenPuterLoaded } from '../src/net/online.js';

// The SDK's <puter-user-menu> in the top bar: when it is added, that its Sign
// out can be taken over, and that what it does by itself reaches the game.

/** A stand-in with the real element's shape: an open shadow root holding the menu. */
class FakeUserMenu extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML =
      '<div class="panel menu">' +
      '<button class="menu-item feedback"></button>' +
      '<button class="menu-item sign-out"></button>' +
      '</div>';
    this.ownSignOut = vi.fn();
    this.escapes = 0;
    this.shadowRoot.querySelector('.sign-out').addEventListener('click', this.ownSignOut);
    this.shadowRoot.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.escapes++;
    });
  }
}

function topbar() {
  document.body.innerHTML =
    '<header class="topbar"><div class="topbar-right">' +
    '<span class="topbar-note"></span><div class="theme-toggle"></div>' +
    '</div></header>';
  return document.querySelector('.topbar-right');
}

beforeEach(() => {
  vi.stubGlobal('puter', { env: 'web' });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('without <puter-user-menu> in the SDK', () => {
  // Runs before the element is ever defined: a registry cannot forget one.
  it('leaves the top bar as it is', () => {
    const bar = topbar();
    expect(hasUserMenu()).toBe(false);
    expect(mountUserMenu(bar)).toBe(null);
    expect(bar.lastElementChild.className).toBe('theme-toggle');
  });
});

describe('with <puter-user-menu> in the loaded SDK', () => {
  beforeEach(() => {
    if (!customElements.get(USER_MENU_TAG)) customElements.define(USER_MENU_TAG, FakeUserMenu);
  });

  it('goes at the end of the top bar, once', () => {
    const bar = topbar();
    expect(hasUserMenu()).toBe(true);
    const menu = mountUserMenu(bar);
    expect(menu.localName).toBe(USER_MENU_TAG);
    expect(bar.lastElementChild).toBe(menu);
    expect(menu.previousElementSibling.className).toBe('theme-toggle');
    expect(mountUserMenu(bar)).toBe(menu);
    expect(bar.querySelectorAll(USER_MENU_TAG)).toHaveLength(1);
  });

  it('stays out before the SDK has loaded', () => {
    vi.stubGlobal('puter', undefined);
    const bar = topbar();
    expect(mountUserMenu(bar)).toBe(null);
    expect(bar.querySelector(USER_MENU_TAG)).toBe(null);
  });

  it('stays out of a Puter app window, where the element renders nothing', () => {
    vi.stubGlobal('puter', { env: 'app' });
    const bar = topbar();
    expect(hasUserMenu()).toBe(false);
    expect(mountUserMenu(bar)).toBe(null);
    expect(bar.lastElementChild.className).toBe('theme-toggle');
  });

  it('follows an explicit theme, and the OS otherwise', () => {
    const menu = mountUserMenu(topbar(), { theme: 'dark' });
    expect(menu.getAttribute('theme')).toBe('dark');
    setUserMenuTheme(menu, 'light');
    expect(menu.getAttribute('theme')).toBe('light');
    setUserMenuTheme(menu, 'system');
    expect(menu.hasAttribute('theme')).toBe(false);
    expect(() => setUserMenuTheme(null, 'dark')).not.toThrow();
  });

  it('hands Sign out to the game when it has something to settle first', () => {
    const instead = vi.fn();
    const signOutGuard = vi.fn(() => instead);
    const menu = mountUserMenu(topbar(), { signOutGuard });
    menu.shadowRoot.querySelector('.sign-out').click();
    expect(instead).toHaveBeenCalledTimes(1);
    // The element's own handler never sees the click, and its menu is closed
    // the way it closes itself.
    expect(menu.ownSignOut).not.toHaveBeenCalled();
    expect(menu.escapes).toBe(1);
    // Its other items are its own.
    menu.shadowRoot.querySelector('.feedback').click();
    expect(signOutGuard).toHaveBeenCalledTimes(1);
    expect(instead).toHaveBeenCalledTimes(1);
  });

  it('leaves Sign out to the element when the game has nothing to settle', () => {
    const signOutGuard = vi.fn(() => null);
    const menu = mountUserMenu(topbar(), { signOutGuard });
    menu.shadowRoot.querySelector('.sign-out').click();
    expect(signOutGuard).toHaveBeenCalledTimes(1);
    expect(menu.ownSignOut).toHaveBeenCalledTimes(1);
    expect(menu.escapes).toBe(0);
  });

  it('follows a sign-in and a sign-out the element did by itself', () => {
    const onSignIn = vi.fn();
    const onSignOut = vi.fn();
    const menu = mountUserMenu(topbar(), { onSignIn, onSignOut });
    const user = { username: 'tinsley' };
    menu.dispatchEvent(new CustomEvent('signin', { detail: { user } }));
    expect(onSignIn).toHaveBeenCalledWith(user);
    expect(onSignOut).not.toHaveBeenCalled();
    menu.dispatchEvent(new CustomEvent('signout'));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('tells keys from inside the element apart from the rest of the page', () => {
    const bar = topbar();
    const menu = mountUserMenu(bar);
    const seen = [];
    const listen = (e) => seen.push(inUserMenu(e.target));
    window.addEventListener('keydown', listen);
    // From inside the shadow tree, a key reaches the window retargeted to the element.
    menu.shadowRoot
      .querySelector('.feedback')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, composed: true }));
    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    window.removeEventListener('keydown', listen);
    expect(seen).toEqual([true, false]);
    expect(inUserMenu(null)).toBe(false);
  });
});

describe('waiting for the lazily loaded SDK', () => {
  it('runs at once when the SDK is already on the page', () => {
    const fn = vi.fn();
    whenPuterLoaded(fn);
    expect(fn).toHaveBeenCalledWith(globalThis.puter);
  });

  it('starts no load of its own', () => {
    vi.stubGlobal('puter', undefined);
    const fn = vi.fn();
    whenPuterLoaded(fn);
    expect(fn).not.toHaveBeenCalled();
    expect(document.querySelector('script')).toBe(null);
  });
});
