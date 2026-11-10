import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Store } from '../src/data/store.js';
import { memoryBackend } from '../src/data/backend.js';
import { App } from '../src/ui/app.js';
import { closeAllMenus } from '../src/ui/menu.js';
import { setTheme } from '../src/ui/prefs.js';
import { hasUserMenu, USER_MENU_TAG } from '../src/ui/user-menu.js';

// puter.js's <puter-user-menu> in the title bar: where the SDK defines it, it stands in for the app's Apps button
// and the rail's account button, and its Sign out is the app's, which saves first.

// A stand-in with the real element's shape: an open shadow root holding the Sign out item.
class FakeUserMenu extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = '<div class="menu"><button class="menu-item feedback"></button><button class="menu-item sign-out"></button></div>';
    this.ownSignOut = vi.fn();
    this.escapes = 0;
    this.shadowRoot.querySelector('.sign-out').addEventListener('click', this.ownSignOut);
    this.shadowRoot.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.escapes++;
    });
  }
}

let app;
let store;
let onSignOut;
let onSessionChange;
const labels = () => [...document.querySelectorAll('.menu [role^="menuitem"]')].map((item) => item.textContent);

async function mount(env = 'web') {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  localStorage.clear();
  store = new Store(memoryBackend(), { saveDelay: 0 });
  await store.load({ defaultName: "sam's Notebook" });
  onSignOut = vi.fn();
  onSessionChange = vi.fn();
  app = new App(document.getElementById('app'), { store, user: { username: 'sam' }, env, onSignOut: env === 'app' ? null : onSignOut, onSessionChange });
  await app.start();
  return app;
}

afterEach(() => {
  closeAllMenus();
  app?.destroy();
  app = null;
  document.body.replaceChildren();
  setTheme('system');
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('without <puter-user-menu> in the SDK', () => {
  it('keeps the Apps button and the rail\'s account button', async () => {
    vi.stubGlobal('puter', { env: 'web' });
    expect(hasUserMenu()).toBe(false);
    await mount();
    expect(app.userMenu).toBe(null);
    expect(app.titlebar.querySelector('.apps-btn')).toBe(app.appsBtn);
    expect(app.rail.lastElementChild).toBe(app.avatar);
    app.mobileMore.click();
    expect(labels().some((label) => label.startsWith('Sign Out'))).toBe(true);
  });
});

describe('with <puter-user-menu> in the SDK', () => {
  beforeEach(() => {
    if (!customElements.get(USER_MENU_TAG)) customElements.define(USER_MENU_TAG, FakeUserMenu);
    vi.stubGlobal('puter', { env: 'web' });
  });

  it('ends the title bar, in place of the Apps button and the account button', async () => {
    await mount();
    expect(hasUserMenu()).toBe(true);
    expect(app.titlebar.querySelector('.titlebar-end').lastElementChild).toBe(app.userMenu);
    expect(app.userMenu.localName).toBe(USER_MENU_TAG);
    expect(document.querySelectorAll(USER_MENU_TAG)).toHaveLength(1);
    expect(app.appsBtn).toBe(null);
    expect(document.querySelector('.apps-btn')).toBe(null);
    expect(document.querySelector('.avatar-btn')).toBe(null);
  });

  it('leaves the account out of the phone\'s More menu, whose File items keep the settings', async () => {
    await mount();
    app.mobileMore.click();
    expect(document.querySelector('.menu .menu-header')).toBe(null);
    expect(labels().some((label) => label.startsWith('Sign Out'))).toBe(false);
    for (const name of ['Theme', 'Keyboard Shortcuts', 'About Notes']) {
      expect(labels().filter((label) => label.startsWith(name))).toHaveLength(1);
    }
  });

  it('stays out of a Puter app window, where the element renders nothing', async () => {
    puter.env = 'app';
    expect(hasUserMenu()).toBe(false);
    await mount('app');
    expect(app.userMenu).toBe(null);
    expect(document.querySelector(USER_MENU_TAG)).toBe(null);
    expect(app.rail.lastElementChild).toBe(app.avatar);
  });

  it('keeps the app\'s own controls when the app runs without the SDK\'s session', async () => {
    puter.env = 'app';
    await mount('web');
    expect(app.userMenu).toBe(null);
    expect(app.titlebar.querySelector('.apps-btn')).toBe(app.appsBtn);
  });

  it('hands Sign out to the app, which saves first, and closes the element\'s menu', async () => {
    await mount();
    const order = [];
    vi.spyOn(store, 'hasUnsaved').mockReturnValue(true);
    vi.spyOn(store, 'flush').mockImplementation(async () => {
      order.push('flush');
    });
    onSignOut.mockImplementation(() => order.push('signOut'));
    app.userMenu.shadowRoot.querySelector('.sign-out').click();
    await vi.waitFor(() => expect(onSignOut).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['flush', 'signOut']);
    expect(app.userMenu.ownSignOut).not.toHaveBeenCalled();
    expect(app.userMenu.escapes).toBe(1);
    expect(onSessionChange).not.toHaveBeenCalled();
    // Its other items are its own.
    app.userMenu.shadowRoot.querySelector('.feedback').click();
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('follows a sign-in and a sign-out the element did by itself', async () => {
    await mount();
    app.userMenu.dispatchEvent(new CustomEvent('signin', { detail: { user: { username: 'sam' } } }));
    expect(onSessionChange).toHaveBeenCalledTimes(1);
    app.userMenu.dispatchEvent(new CustomEvent('signout'));
    expect(onSessionChange).toHaveBeenCalledTimes(2);
    expect(onSignOut).not.toHaveBeenCalled();
  });

  it('follows an explicit theme, and the OS otherwise', async () => {
    await mount();
    expect(app.userMenu.hasAttribute('theme')).toBe(false);
    setTheme('dark');
    expect(app.userMenu.getAttribute('theme')).toBe('dark');
    setTheme('light');
    expect(app.userMenu.getAttribute('theme')).toBe('light');
    setTheme('system');
    expect(app.userMenu.hasAttribute('theme')).toBe(false);
  });

  it('leaves the element\'s own keys alone', async () => {
    await mount();
    app.setTool('pen');
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true });
    app.userMenu.shadowRoot.querySelector('.feedback').dispatchEvent(escape);
    expect(app.editor.ink.tool).toBe('pen');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(app.editor.ink.tool).toBe('type');
  });
});
