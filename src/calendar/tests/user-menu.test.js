/**
 * puter.js's <puter-user-menu> at the end of the header: where the SDK defines
 * it, it stands in for the avatar, a Settings button keeps the rest of the
 * account menu, and its Sign out is the app's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { signOut } from '../src/js/auth.js';
import { hasUserMenu, userMenu, USER_MENU_TAG } from '../src/js/user-menu.js';

// signOut never settles, so the reload in handleSignOut's `finally` is never
// reached and jsdom's location is left alone (as in app-signout.test.js).
vi.mock(import('../src/js/auth.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  signOut: vi.fn(() => new Promise(() => {})),
}));

const { createApp, applyTheme } = await import('../src/js/app.js');

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

function makeStore() {
  const s = { ...DEFAULT_SETTINGS, defaultView: 'agenda' };
  const listeners = new Set();
  return {
    getSettings: () => ({ ...s }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    _emit() {
      for (const fn of [...listeners]) fn();
    },
    getAllEvents: () => [],
    getEventsInRange: () => [],
    getAllTasks: () => [],
    getTasksInRange: () => [],
    getTask: () => null,
    getEvent: () => null,
    saveSettings: async (patch) => (Object.assign(s, patch), { ...s }),
    toggleTask: async () => {},
  };
}

function makeContacts() {
  return {
    ready: () => false,
    inUse: () => false,
    warm: () => Promise.resolve(),
    revalidate: () => Promise.resolve(null),
    suggest: () => [],
    noteTyped: () => {},
    settle: () => {},
    onChange: () => () => {},
    invalidate: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('app — <puter-user-menu>', () => {
  let app;
  let root;
  let store;
  let contacts;

  const mount = () => {
    store = makeStore();
    contacts = makeContacts();
    app = createApp(root, { store, user: { username: 'ada', email: 'ada@example.com' }, contacts });
  };
  const tools = () => [...root.querySelector('.header__tools').children];
  const element = () => root.querySelector(USER_MENU_TAG);
  const popover = () => document.querySelector('.popover');
  const signOutItem = () =>
    [...document.querySelectorAll('.popover .menu-item')].find((b) => b.textContent.includes('Sign out'));

  beforeEach(() => {
    signOut.mockClear();
    vi.stubGlobal('puter', { env: 'web', auth: {} });
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
    root = document.createElement('div');
    document.body.append(root);
  });

  afterEach(() => {
    if (app) app.destroy();
    app = null;
    document.body.replaceChildren();
    delete document.documentElement.dataset.theme;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('without the element in the SDK', () => {
    it('keeps the avatar, with the account and Sign out in its menu', () => {
      expect(hasUserMenu()).toBe(false);
      expect(userMenu()).toBe(null);
      mount();
      expect(element()).toBe(null);
      expect(tools().at(-1).className).toBe('avatar');
      root.querySelector('button.avatar').click();
      expect(popover().getAttribute('aria-label')).toBe('Account and settings');
      expect(popover().querySelector('.popover__name').textContent).toBe('ada');
      expect(signOutItem()).toBeTruthy();
    });
  });

  describe('with the element in the SDK', () => {
    beforeEach(() => {
      if (!customElements.get(USER_MENU_TAG)) customElements.define(USER_MENU_TAG, FakeUserMenu);
    });

    it('ends the header, after a Settings button that keeps the settings without the account', () => {
      expect(hasUserMenu()).toBe(true);
      mount();
      expect(tools().at(-1)).toBe(element());
      const settings = tools().at(-2);
      expect(settings.getAttribute('aria-label')).toBe('Settings');
      expect(root.querySelector('button.avatar')).toBe(null);

      settings.click();
      expect(popover().getAttribute('aria-label')).toBe('Settings');
      expect(popover().querySelector('[aria-label="Theme"]')).toBeTruthy();
      expect(popover().textContent).toContain('Start week on Monday');
      expect(popover().textContent).toContain('Import & export');
      expect(popover().querySelector('.popover__header')).toBe(null);
      expect(signOutItem()).toBeFalsy();
    });

    it('stays with the header through re-renders', () => {
      mount();
      const first = element();
      store._emit();
      store._emit();
      expect(element()).toBe(first);
      expect(root.querySelectorAll(USER_MENU_TAG)).toHaveLength(1);
    });

    it('stays out of a Puter app window, where the element renders nothing', () => {
      puter.env = 'app';
      expect(hasUserMenu()).toBe(false);
      mount();
      expect(element()).toBe(null);
      expect(tools().at(-1).className).toBe('avatar');
    });

    it("hands Sign out to the app, and closes the element's menu", async () => {
      localStorage.setItem(
        'cal:profile-pic',
        JSON.stringify({ user: 'previous-account', picture: 'data:image/png;base64,AA==' }),
      );
      mount();
      const menu = element();
      menu.shadowRoot.querySelector('.sign-out').click();
      expect(menu.ownSignOut).not.toHaveBeenCalled();
      expect(menu.escapes).toBe(1);
      // The app's sign-out: this account's caches go and Contacts is let go
      // before the session.
      expect(contacts.invalidate).toHaveBeenCalledTimes(1);
      expect(contacts.dispose).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('cal:profile-pic')).toBe(null);
      await vi.waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
      // Its other items are its own.
      menu.shadowRoot.querySelector('.feedback').click();
      expect(contacts.dispose).toHaveBeenCalledTimes(1);
    });

    it('drops the account from the device after a sign-out the element did by itself', () => {
      // The reload that follows is not checked: jsdom does not navigate, and
      // only logs that it was asked to.
      localStorage.setItem(
        'cal:profile-pic',
        JSON.stringify({ user: 'previous-account', picture: 'data:image/png;base64,AA==' }),
      );
      mount();
      element().dispatchEvent(new CustomEvent('signout'));
      expect(contacts.invalidate).toHaveBeenCalledTimes(1);
      expect(contacts.dispose).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('cal:profile-pic')).toBe(null);
      expect(signOut).not.toHaveBeenCalled();
    });

    it('does the same after a sign-in the element did by itself', () => {
      mount();
      element().dispatchEvent(new CustomEvent('signin', { detail: { user: { username: 'grace' } } }));
      expect(contacts.dispose).toHaveBeenCalledTimes(1);
      expect(signOut).not.toHaveBeenCalled();
    });

    it('follows an explicit theme, and the OS otherwise', () => {
      mount();
      expect(element().hasAttribute('theme')).toBe(false);
      applyTheme('dark');
      expect(element().getAttribute('theme')).toBe('dark');
      applyTheme('system');
      expect(element().hasAttribute('theme')).toBe(false);
    });

    it('leaves the keys pressed inside it to the element', () => {
      mount();
      const press = (target) => {
        const e = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
        target.dispatchEvent(e);
        return e.defaultPrevented;
      };
      // A key pressed in the element's shadow tree reaches the page with the
      // element itself as its target.
      expect(press(element())).toBe(false);
      // `/` opens search from anywhere else on the page.
      expect(press(tools().at(-2))).toBe(true);
    });
  });
});
