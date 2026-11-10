/**
 * puter.js's <puter-user-menu> in the shell: where the SDK defines it, it
 * holds the account at the head of the view on the desktop layout, the
 * sidebar's account row stands down, and its Sign out is the app's.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// pdf.js needs browser globals jsdom does not have, and none of this is about
// documents.
vi.mock('../src/lib/pdfdoc.js', () => ({
  openPdf: async () => ({}),
  pagePoints: async () => ({ w: 612, h: 792 }),
  pageAspect: async () => 792 / 612,
  renderPage: async () => ({ width: 612, height: 792 }),
}));

const events = new EventTarget();
vi.mock('../src/lib/store.js', () => ({
  store: {
    listDocs: () => [],
    listTemplates: () => [],
    getSavedSignature: async () => null,
    addEventListener: (...a) => events.addEventListener(...a),
    removeEventListener: (...a) => events.removeEventListener(...a),
    get settings() { return {}; },
    get user() { return { username: 'ava', email: 'ava@example.com' }; },
  },
}));

const { mountShell } = await import('../src/ui/shell.js');
const { hasUserMenu, userMenu, USER_MENU_TAG } = await import('../src/ui/usermenu.js');
const { applyTheme } = await import('../src/ui/theme.js');

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
      if (e.key === 'Escape') this.escapes++;
    });
  }
}

let appRoot;
let sdk;

function mount(hash = '#/') {
  location.hash = hash;
  appRoot = document.createElement('div');
  appRoot.id = 'app';
  document.body.append(appRoot);
  mountShell(appRoot);
  return appRoot;
}
const element = () => appRoot.querySelector(USER_MENU_TAG);
const dialogButton = (text) =>
  [...document.querySelectorAll('.modal-root button')].find((b) => b.textContent.trim() === text);

beforeEach(() => {
  window.scrollTo = () => {};
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  // signOut never settles, so the reload after it is never reached and
  // jsdom's location is left alone.
  sdk = { env: 'web', auth: { signOut: vi.fn(() => new Promise(() => {})), signIn: vi.fn() } };
  vi.stubGlobal('puter', sdk);
});

afterEach(() => {
  document.body.replaceChildren();
  document.body.className = '';
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

describe('without <puter-user-menu> in the SDK', () => {
  it('keeps the sidebar\'s account row, with its Sign out', () => {
    expect(hasUserMenu()).toBe(false);
    expect(userMenu()).toBe(null);
    mount();
    expect(element()).toBe(null);
    expect(appRoot.querySelector('.shell').classList.contains('has-user-menu')).toBe(false);
    expect(appRoot.querySelector('.sidebar-user .name').textContent).toBe('ava');
    expect(appRoot.querySelector('.sidebar-user [aria-label="Sign out"]')).toBeTruthy();
  });
});

describe('with <puter-user-menu> in the SDK', () => {
  beforeEach(() => {
    if (!customElements.get(USER_MENU_TAG)) customElements.define(USER_MENU_TAG, FakeUserMenu);
  });

  it('holds the account at the head of the view, and the sidebar\'s account row stands down', () => {
    expect(hasUserMenu()).toBe(true);
    mount();
    expect(appRoot.querySelector('.main > .main-account puter-user-menu')).toBe(element());
    // Straight before the view, whose head it lies over.
    expect(appRoot.querySelector('.main-account').nextElementSibling.querySelector('.view-head')).toBeTruthy();
    expect(appRoot.querySelector('.shell').classList.contains('has-user-menu')).toBe(true);
    expect(appRoot.querySelector('.sidebar-user')).toBe(null);
    expect(appRoot.querySelector('[aria-label="Sign out"]')).toBe(null);
  });

  it('stays in place from one view to the next', async () => {
    mount();
    const first = element();
    location.hash = '#/settings';
    await vi.waitFor(() => expect(appRoot.querySelector('.view-head h1').textContent).toBe('Settings'));
    expect(element()).toBe(first);
    expect(appRoot.querySelectorAll(USER_MENU_TAG)).toHaveLength(1);
    // Settings keeps its Sign out for the phone layout, where the element is
    // not shown; the stylesheet hides it on the desktop layout.
    expect(appRoot.querySelector('.settings-signout')).toBeTruthy();
  });

  it('stays out of a Puter app window, where the element renders nothing', () => {
    sdk.env = 'app';
    expect(hasUserMenu()).toBe(false);
    mount();
    expect(element()).toBe(null);
    expect(appRoot.querySelector('.sidebar-user')).toBeTruthy();
  });

  it('hands Sign out to the app, which asks first', async () => {
    mount();
    const menu = element();
    menu.shadowRoot.querySelector('.sign-out').click();
    expect(menu.ownSignOut).not.toHaveBeenCalled();
    expect(menu.escapes).toBe(1);
    await vi.waitFor(() => expect(document.querySelector('.modal-root')).toBeTruthy());
    expect(document.querySelector('.modal-root').textContent).toContain('Sign out?');
    expect(sdk.auth.signOut).not.toHaveBeenCalled();
    dialogButton('Sign out').click();
    await vi.waitFor(() => expect(sdk.auth.signOut).toHaveBeenCalledTimes(1));
    expect(menu.ownSignOut).not.toHaveBeenCalled();
  });

  it('signs nobody out when the question is turned down, and leaves its other items alone', async () => {
    mount();
    const menu = element();
    menu.shadowRoot.querySelector('.feedback').click();
    expect(document.querySelector('.modal-root')).toBe(null);
    menu.shadowRoot.querySelector('.sign-out').click();
    await vi.waitFor(() => expect(dialogButton('Cancel')).toBeTruthy());
    dialogButton('Cancel').click();
    await Promise.resolve();
    expect(sdk.auth.signOut).not.toHaveBeenCalled();
  });

  it('says so after a sign-in or a sign-out the element did by itself', () => {
    const onSessionChanged = vi.fn();
    const onSignOut = vi.fn();
    const menu = userMenu({ onSignOut, onSessionChanged });
    menu.dispatchEvent(new CustomEvent('signout'));
    expect(onSessionChanged).toHaveBeenCalledTimes(1);
    menu.dispatchEvent(new CustomEvent('signin', { detail: { user: { username: 'ben' } } }));
    expect(onSessionChanged).toHaveBeenCalledTimes(2);
    expect(onSignOut).not.toHaveBeenCalled();
    expect(sdk.auth.signIn).not.toHaveBeenCalled();
  });

  it('follows an explicit theme, and the OS otherwise', () => {
    mount();
    expect(element().hasAttribute('theme')).toBe(false);
    applyTheme('dark');
    expect(element().getAttribute('theme')).toBe('dark');
    applyTheme('system');
    expect(element().hasAttribute('theme')).toBe(false);
  });
});
