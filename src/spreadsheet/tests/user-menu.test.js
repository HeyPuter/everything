// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/memory-storage.js';
import { hasUserMenu, userMenu, USER_MENU_TAG } from '../src/ui/user-menu.js';
import { accountControls } from '../src/ui/appmenu.js';
import { appsButton } from '../src/ui/apps-panel.js';
import { session } from '../src/lib/session.js';
import { applyTheme } from '../src/ui/theme.js';
import { closeMenu } from '../src/ui/menu.js';

// puter.js's <puter-user-menu> in the headers: where the SDK defines it, it stands in for the app's Apps button
// and account button, a Settings button keeps the rest of the account menu, and its Sign out is the app's.

// A stand-in with the real element's shape: an open shadow root holding the Sign out item.
class FakeUserMenu extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = '<div class="menu"><button class="menu-item feedback"></button><button class="menu-item sign-out"></button></div>';
    this.ownSignOut = vi.fn();
    this.escapes = 0;
    this.shadowRoot.querySelector('.sign-out').addEventListener('click', this.ownSignOut);
    this.shadowRoot.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.escapes++; });
  }
}

let sdk;
const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);

beforeEach(async () => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  sdk = {
    env: 'web',
    _user: { username: 'nariman', uuid: 'u-1' },
    auth: { isSignedIn: () => !!sdk._user, signIn: vi.fn(), getUser: async () => sdk._user, signOut: vi.fn() },
    kv: { get: async () => null, set: async () => true },
  };
  vi.stubGlobal('puter', sdk);
  await session.init();
});
afterEach(() => {
  closeMenu();
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
  session.state = 'unknown';
  session.user = null;
  vi.unstubAllGlobals();
});

describe('without <puter-user-menu> in the SDK', () => {
  it('keeps the Apps button and the account button', () => {
    expect(hasUserMenu()).toBe(false);
    expect(userMenu()).toBe(null);
    const { nodes } = accountControls({ label: 'Account menu' });
    expect(nodes.map((node) => node.className)).toEqual(['icon-btn apps-btn', 'icon-btn user-btn']);
  });
});

describe('with <puter-user-menu> in the SDK', () => {
  beforeEach(() => {
    if (!customElements.get(USER_MENU_TAG)) customElements.define(USER_MENU_TAG, FakeUserMenu);
  });

  it('stands in for the Apps button and the account button, after a Settings button', () => {
    expect(hasUserMenu()).toBe(true);
    expect(appsButton()).toBe(null);
    const { nodes } = accountControls();
    expect(nodes).toHaveLength(2);
    expect(nodes[0].getAttribute('aria-label')).toBe('Settings');
    expect(nodes[1].localName).toBe(USER_MENU_TAG);
    expect(nodes[1].getAttribute('sign-in-label')).toBe('Sign in');
    expect(nodes[1].getAttribute('sign-out-label')).toBe('Sign out');
  });

  it('keeps the settings in the Settings menu, without the account rows', () => {
    const { nodes } = accountControls();
    document.body.append(...nodes);
    nodes[0].click();
    expect(document.querySelector('.menu-header')).toBe(null);
    expect(menuItems().some((label) => label.startsWith('Keyboard shortcuts'))).toBe(true);
    expect(menuItems().some((label) => label.startsWith('Sign out') || label.startsWith('Sign in'))).toBe(false);
  });

  it('stays out of a Puter app window, where the element renders nothing', () => {
    sdk.env = 'app';
    expect(hasUserMenu()).toBe(false);
    expect(accountControls({ label: 'Account menu' }).nodes.at(-1).className).toBe('icon-btn user-btn');
  });

  it('hands Sign out to the app, and closes the element\'s menu', () => {
    const onSignOut = vi.fn();
    const menu = userMenu({ onSignOut });
    document.body.append(menu);
    menu.shadowRoot.querySelector('.sign-out').click();
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(menu.ownSignOut).not.toHaveBeenCalled();
    expect(menu.escapes).toBe(1);
    // Its other items are its own.
    menu.shadowRoot.querySelector('.feedback').click();
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('follows a sign-in and a sign-out the element did by itself', async () => {
    sdk._user = null;
    await session.refresh();
    const menu = userMenu();
    sdk._user = { username: 'nariman', uuid: 'u-1' };
    menu.dispatchEvent(new CustomEvent('signin', { detail: { user: sdk._user } }));
    await vi.waitFor(() => expect(session.signedIn).toBe(true));
    sdk._user = null;
    menu.dispatchEvent(new CustomEvent('signout'));
    await vi.waitFor(() => expect(session.signedOut).toBe(true));
  });

  it('follows an explicit theme, and the OS otherwise', async () => {
    const menu = userMenu();
    document.body.append(menu);
    expect(menu.hasAttribute('theme')).toBe(false);
    applyTheme('dark');
    await vi.waitFor(() => expect(menu.getAttribute('theme')).toBe('dark'));
    applyTheme('system');
    await vi.waitFor(() => expect(menu.hasAttribute('theme')).toBe(false));
  });
});
