// puter.js's <puter-user-menu> in the title bar: where the SDK defines it, it
// stands in for the app's Sign in button and account button, its Sign out is
// the app's (the open project is saved first), and the app follows a sign-in
// or sign-out the element did by itself. Preferences, which the account menu
// also held, stays in the menus.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app/app.js';
import { setPuterForTests } from '../src/app/puter.js';
import { USER_MENU_TAG } from '../src/app/user-menu.js';
import { buildMenus } from '../src/app/menus.js';
import { closeMenus } from '../src/ui/menu.js';

// A stand-in with the real element's shape: an open shadow root holding the Sign out item.
class FakeUserMenu extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = '<button class="avatar"></button><div class="menu"><button class="menu-item feedback"></button><button class="menu-item sign-out"></button></div>';
    this.ownSignOut = vi.fn();
    this.escapes = 0;
    this.shadowRoot.querySelector('.sign-out').addEventListener('click', this.ownSignOut);
    this.shadowRoot.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.escapes++; });
  }
}

function mockPuter({ env = 'web', signedIn = true, username = 'ada' } = {}) {
  const sdk = {
    env,
    signedIn,
    auth: {
      isSignedIn: () => sdk.signedIn,
      getUser: async () => (sdk.signedIn || env === 'app' ? { username } : null),
      getProfilePicture: vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo='),
      signIn: vi.fn(async () => { sdk.signedIn = true; return {}; }),
      signOut: vi.fn(async () => { sdk.signedIn = false; }),
    },
    fs: { readdir: async () => [], write: async (p) => ({ path: p }), read: async () => new Blob(['{}']) },
    kv: { get: async () => null, set: async () => true },
    ui: {},
  };
  return sdk;
}

async function boot(puterMock) {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  setPuterForTests(null);
  if (puterMock) window.puter = puterMock; else delete window.puter;
  const app = new App(document.getElementById('app'), { puterTimeout: 10 });
  await app.init();
  return app;
}
const userMenu = () => document.querySelector(USER_MENU_TAG);
const toasts = () => [...document.querySelectorAll('.toast')].map((t) => t.textContent);

beforeEach(() => { localStorage.clear(); });
afterEach(() => { closeMenus(); delete window.puter; setPuterForTests(null); document.body.innerHTML = ''; });

describe('without <puter-user-menu> in the SDK', () => {
  it('keeps the account button with Preferences and Sign out', async () => {
    const app = await boot(mockPuter());
    expect(app.userMenu).toBe(null);
    expect(userMenu()).toBe(null);
    expect(document.querySelector('.user-menu-slot').hidden).toBe(true);
    document.querySelector('.account-btn').click();
    const labels = [...document.querySelectorAll('.menu-item')].map((m) => m.textContent);
    expect(labels.some((l) => /preferences/i.test(l))).toBe(true);
    expect(labels.some((l) => /sign out/i.test(l))).toBe(true);
    app.kernel.dispose();
  });
});

describe('with <puter-user-menu> in the SDK', () => {
  beforeEach(() => {
    if (!customElements.get(USER_MENU_TAG)) customElements.define(USER_MENU_TAG, FakeUserMenu);
  });

  it('ends the title bar and stands in for the account button', async () => {
    const app = await boot(mockPuter());
    const menu = userMenu();
    expect(menu).toBe(app.userMenu);
    expect(menu.parentElement).toBe(document.querySelector('.titlebar'));
    expect(menu.nextElementSibling).toBe(null);
    expect(menu.previousElementSibling).toBe(app.accountEl);
    expect(document.querySelector('.user-menu-slot')).toBe(null);
    expect(app.accountEl.hidden).toBe(true);
    expect(document.querySelector('.account-btn')).toBe(null);
    // Preferences stays in the menus.
    expect(buildMenus(app).some((m) => JSON.stringify(m.items()).includes('app.preferences'))).toBe(true);
    app.kernel.dispose();
  });

  it('stands in for the Sign in button when signed out', async () => {
    const app = await boot(mockPuter({ signedIn: false }));
    expect(userMenu()).toBeTruthy();
    expect(app.accountEl.hidden).toBe(true);
    expect(app.accountEl.childElementCount).toBe(0);
    app.kernel.dispose();
  });

  it("stays on the app's theme", async () => {
    const app = await boot(mockPuter());
    expect(userMenu().getAttribute('theme')).toBe('light');
    app.settings.set('theme', 'dark');
    expect(userMenu().getAttribute('theme')).toBe('dark');
    app.settings.set('theme', 'light');
    expect(userMenu().getAttribute('theme')).toBe('light');
    app.kernel.dispose();
  });

  it("runs the app's sign-out in place of its own: the project is saved first", async () => {
    const sdk = mockPuter();
    const app = await boot(sdk);
    const order = [];
    await app.openExample();
    app.project.touchMeta();
    expect(app.project.dirty).toBe(true);
    app.save = vi.fn(async () => { order.push('save'); });
    sdk.auth.signOut.mockImplementation(async () => { order.push('signOut'); sdk.signedIn = false; });

    userMenu().shadowRoot.querySelector('.sign-out').click();
    await vi.waitFor(() => expect(toasts().some((t) => /signed out/i.test(t))).toBe(true));
    expect(userMenu().ownSignOut).not.toHaveBeenCalled();
    expect(userMenu().escapes).toBe(1);
    expect(order).toEqual(['save', 'signOut']);
    expect(app.user).toBe(null);
    // Other items are the element's.
    userMenu().shadowRoot.querySelector('.feedback').click();
    expect(sdk.auth.signOut).toHaveBeenCalledTimes(1);
    app.kernel.dispose();
  });

  it('follows a sign-out the element did by itself', async () => {
    const sdk = mockPuter();
    const app = await boot(sdk);
    expect(app.user).toEqual({ username: 'ada' });
    sdk.signedIn = false;
    userMenu().dispatchEvent(new CustomEvent('signout'));
    await vi.waitFor(() => expect(toasts().some((t) => /signed out/i.test(t))).toBe(true));
    expect(sdk.auth.signOut).not.toHaveBeenCalled();
    expect(app.user).toBe(null);
    expect(app.picture).toBe(null);
    expect(app.accountEl.hidden).toBe(true);
    app.kernel.dispose();
  });

  it('follows a sign-in the element did', async () => {
    const sdk = mockPuter({ signedIn: false });
    const app = await boot(sdk);
    expect(app.user).toBeFalsy();
    sdk.signedIn = true;
    userMenu().dispatchEvent(new CustomEvent('signin', { detail: { user: { username: 'ada' } } }));
    await vi.waitFor(() => expect(toasts().some((t) => /Signed in as ada/.test(t))).toBe(true));
    expect(sdk.auth.signIn).not.toHaveBeenCalled();
    expect(app.user).toEqual({ username: 'ada' });
    expect(app.accountEl.hidden).toBe(true);
    expect(app.accountEl.childElementCount).toBe(0);
    app.kernel.dispose();
  });

  it('leaves keys from inside the element alone', async () => {
    const app = await boot(mockPuter());
    const run = vi.spyOn(app.commands, 'run').mockImplementation(() => {});
    // Ahead of the key handlers of the apps earlier tests booted, which are still on the document.
    const first = (e) => app.keys.handle(e);
    document.addEventListener('keydown', first, true);
    const press = (from, init) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, composed: true, cancelable: true, ...init });
      from.dispatchEvent(e);
      return e;
    };
    const avatar = userMenu().shadowRoot.querySelector('.avatar');
    for (const init of [{ key: ',', ctrlKey: true }, { key: ',', metaKey: true }, { key: 'F1' }, { key: ' ' }, { key: 'Enter' }]) {
      expect(press(avatar, init).defaultPrevented).toBe(false);
    }
    expect(run).not.toHaveBeenCalled();
    // The same shortcut from the title bar's own buttons still runs.
    press(document.querySelector('.titlebar .icon-btn'), { key: 'F1' });
    expect(run).toHaveBeenCalledWith('help.shortcuts');
    document.removeEventListener('keydown', first, true);
    app.kernel.dispose();
  });

  it("keeps the app's own account button inside a Puter app window", async () => {
    const app = await boot(mockPuter({ env: 'app' }));
    expect(app.userMenu).toBe(null);
    expect(userMenu()).toBe(null);
    expect(app.accountEl.hidden).toBe(false);
    expect(document.querySelector('.account-btn')).toBeTruthy();
    app.kernel.dispose();
  });
});
