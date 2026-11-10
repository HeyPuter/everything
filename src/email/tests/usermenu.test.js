import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderApp } from '../src/ui/app.js';
import { hasUserMenu, userMenu, USER_MENU_TAG } from '../src/ui/usermenu.js';
import { applyTheme } from '../src/ui/theme.js';
import { createSampleMailbox } from '../src/lib/sample.js';

/**
 * puter.js's <puter-user-menu> at the end of the top bar: where the SDK
 * defines it, it stands in for the app's own account button, after Settings,
 * and its Sign out is the app's.
 */

// A stand-in with the real element's shape: an open shadow root holding the
// Sign out item.
class FakeUserMenu extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML =
      '<div class="menu"><button class="menu-item feedback"></button><button class="menu-item sign-out"></button></div>';
    this.ownSignOut = vi.fn();
    this.escapes = 0;
    this.shadowRoot.querySelector('.sign-out').addEventListener('click', this.ownSignOut);
    this.shadowRoot.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.escapes += 1;
    });
  }
}

const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

let root;
let sdk;
let onSignOut;
let onSessionChanged;

const mount = () => {
  const { fs, mailPath, objectsPath } = createSampleMailbox();
  renderApp(root, {
    fs, mailPath, objectsPath, sample: true, account: { username: 'sample' },
    onSignOut, onSessionChanged,
  });
};
const actions = () => root.querySelector('.topbar-actions');
const element = () => root.querySelector(USER_MENU_TAG);

beforeEach(() => {
  sdk = { env: 'web', auth: { signOut: vi.fn(), signIn: vi.fn() } };
  vi.stubGlobal('puter', sdk);
  onSignOut = vi.fn();
  onSessionChanged = vi.fn();
  root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
});

afterEach(() => {
  root.remove();
  document.querySelectorAll('.toast, .menu, .modal-root').forEach((node) => node.remove());
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

describe('without <puter-user-menu> in the SDK', () => {
  it('keeps the account button, with Sign out in its menu', async () => {
    expect(hasUserMenu()).toBe(false);
    expect(userMenu()).toBeNull();
    mount();
    await settle();
    expect(element()).toBeNull();
    const account = actions().querySelector('[aria-label="Account"]');
    expect(account).not.toBeNull();
    account.click();
    const signOut = [...document.querySelectorAll('.menu [role="menuitem"]')]
      .find((item) => item.textContent.includes('Sign out'));
    signOut.click();
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

describe('with <puter-user-menu> in the SDK', () => {
  beforeEach(() => {
    if (!customElements.get(USER_MENU_TAG)) customElements.define(USER_MENU_TAG, FakeUserMenu);
  });

  it('ends the top bar after Settings, in place of the account button', async () => {
    expect(hasUserMenu()).toBe(true);
    mount();
    await settle();
    expect(actions().lastElementChild).toBe(element());
    expect(element().previousElementSibling.querySelector('button').getAttribute('aria-label')).toBe('Settings');
    expect(root.querySelector('[aria-label="Account"]')).toBeNull();
    expect(root.querySelectorAll(USER_MENU_TAG)).toHaveLength(1);
  });

  it('stays out of a Puter app window, where the element renders nothing', async () => {
    sdk.env = 'app';
    expect(hasUserMenu()).toBe(false);
    mount();
    await settle();
    expect(element()).toBeNull();
    expect(actions().querySelector('[aria-label="Account"]')).not.toBeNull();
  });

  it("hands Sign out to the app, and closes the element's menu", async () => {
    mount();
    await settle();
    const menu = element();
    menu.shadowRoot.querySelector('.sign-out').click();
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(menu.ownSignOut).not.toHaveBeenCalled();
    expect(sdk.auth.signOut).not.toHaveBeenCalled();
    expect(menu.escapes).toBe(1);
    // Its other items are its own.
    menu.shadowRoot.querySelector('.feedback').click();
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(onSessionChanged).not.toHaveBeenCalled();
  });

  it('follows a sign-in and a sign-out the element did by itself', async () => {
    mount();
    await settle();
    element().dispatchEvent(new CustomEvent('signout'));
    expect(onSessionChanged).toHaveBeenCalledTimes(1);
    element().dispatchEvent(new CustomEvent('signin', { detail: { user: { username: 'ana' } } }));
    expect(onSessionChanged).toHaveBeenCalledTimes(2);
    expect(sdk.auth.signIn).not.toHaveBeenCalled();
    expect(onSignOut).not.toHaveBeenCalled();
  });

  it('follows an explicit theme, and the OS otherwise', async () => {
    mount();
    await settle();
    expect(element().hasAttribute('theme')).toBe(false);
    applyTheme('dark');
    expect(element().getAttribute('theme')).toBe('dark');
    applyTheme('system');
    expect(element().hasAttribute('theme')).toBe(false);
  });

  it('leaves the keys pressed inside it to the element', async () => {
    mount();
    await settle();
    // `/` puts the keyboard in the search box from anywhere else on the page.
    const elsewhere = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    root.querySelector('[aria-label="Settings"]').dispatchEvent(elsewhere);
    expect(elsewhere.defaultPrevented).toBe(true);
    // A key pressed in the element's shadow tree reaches the page with the
    // element itself as its target.
    const inside = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    element().dispatchEvent(inside);
    expect(inside.defaultPrevented).toBe(false);
  });
});
