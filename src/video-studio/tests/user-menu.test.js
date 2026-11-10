// puter.js's <puter-user-menu>: where the SDK defines it, it stands in for the account button in the
// editor's title bar and on the home screen (after a Settings button there), and its Sign out is the app's.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { Editor } from '../src/ui/editor.js';
import { Home } from '../src/ui/home.js';
import { setTheme } from '../src/ui/prefs.js';
import { hasUserMenu, userMenu, USER_MENU_TAG } from '../src/ui/user-menu.js';
import { fixture, clip, onMain } from './helpers.js';

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

let root;
let view;
const account = (extra = {}) => ({ user: { username: 'sam' }, env: 'web', onSignOut: vi.fn(), onSessionChange: vi.fn(), ...extra });

async function mountEditor(acct) {
  const p = fixture();
  onMain(p, clip('video', 0, 4));
  const lib = new Library(memoryBackend());
  await lib.saveProject(p);
  view = new Editor(root, { library: lib, project: p, account: acct, onExit() {}, onNewProject() {} });
  return view;
}
function mountHome(acct) {
  view = new Home(root, { library: new Library(memoryBackend()), account: acct, onOpen: vi.fn(), onCreate: vi.fn(), onImportFiles: vi.fn() });
  return view;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root, Object.assign(document.createElement('div'), { id: 'live-region' }));
  vi.stubGlobal('puter', { env: 'web' });
});
afterEach(() => {
  view?.dispose();
  view = null;
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  setTheme('dark');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('without <puter-user-menu> in the SDK', () => {
  it('keeps the account button in the title bar and the sidebar', async () => {
    expect(hasUserMenu()).toBe(false);
    expect(userMenu(account())).toBe(null);
    await mountEditor(account());
    expect(root.querySelector('.topbar-right > .avatar-btn')).not.toBe(null);
    view.dispose();
    mountHome(account());
    expect(root.querySelector('.side-account .avatar-btn')).not.toBe(null);
    expect(root.querySelector('.home-account')).toBe(null);
    expect(root.querySelector('.home').classList.contains('has-user-menu')).toBe(false);
  });
});

describe('with <puter-user-menu> in the SDK', () => {
  beforeEach(() => {
    if (!customElements.get(USER_MENU_TAG)) customElements.define(USER_MENU_TAG, FakeUserMenu);
  });

  it('ends the title bar in place of the account button', async () => {
    expect(hasUserMenu()).toBe(true);
    await mountEditor(account());
    const right = root.querySelector('.topbar-right');
    expect(right.lastElementChild.localName).toBe(USER_MENU_TAG);
    expect(right.lastElementChild.previousElementSibling.classList.contains('export-btn')).toBe(true);
    expect(root.querySelector('.avatar-btn')).toBe(null);
  });

  it('stands at the top of the home screen after Settings, which keeps the theme', () => {
    mountHome(account());
    const bar = root.querySelector('.home.has-user-menu > .home-account');
    expect([...bar.children].map((n) => n.getAttribute('aria-label') || n.localName)).toEqual(['Settings', USER_MENU_TAG]);
    expect(root.querySelector('.side-account')).toBe(null);
    expect(root.querySelector('.avatar-btn')).toBe(null);
    bar.firstElementChild.click();
    const menu = document.querySelector('.menu');
    expect(menu.querySelector('.menu-heading').textContent).toBe('Theme');
    expect([...menu.querySelectorAll('[role^="menuitem"]')].map((i) => i.textContent.trim())).toEqual(['System', 'Light', 'Dark']);
  });

  it('stays out of a Puter app window, where the element renders nothing', async () => {
    vi.stubGlobal('puter', { env: 'app' });
    expect(hasUserMenu()).toBe(false);
    await mountEditor(account({ env: 'app', onSignOut: null }));
    expect(root.querySelector(USER_MENU_TAG)).toBe(null);
    expect(root.querySelector('.topbar-right > .avatar-btn')).not.toBe(null);
    view.dispose();
    mountHome(account({ env: 'app', onSignOut: null }));
    expect(root.querySelector(USER_MENU_TAG)).toBe(null);
    expect(root.querySelector('.side-account .avatar-btn')).not.toBe(null);
  });

  it("hands Sign out to the app, which saves first, and closes the element's menu", () => {
    const acct = account();
    const menu = userMenu(acct);
    document.body.append(menu);
    menu.shadowRoot.querySelector('.sign-out').click();
    expect(acct.onSignOut).toHaveBeenCalledTimes(1);
    expect(menu.ownSignOut).not.toHaveBeenCalled();
    expect(menu.escapes).toBe(1);
    // Its other items are its own.
    menu.shadowRoot.querySelector('.feedback').click();
    expect(acct.onSignOut).toHaveBeenCalledTimes(1);
  });

  it('leaves Sign out to the element where the app has none of its own', () => {
    const menu = userMenu(account({ user: null, onSignOut: null }));
    document.body.append(menu);
    menu.shadowRoot.querySelector('.sign-out').click();
    expect(menu.ownSignOut).toHaveBeenCalledTimes(1);
  });

  it('tells the app of a sign-in and a sign-out the element did by itself', () => {
    const acct = account();
    const menu = userMenu(acct);
    menu.dispatchEvent(new CustomEvent('signin', { detail: { user: { username: 'sam' } } }));
    expect(acct.onSessionChange).toHaveBeenLastCalledWith('signin');
    menu.dispatchEvent(new CustomEvent('signout'));
    expect(acct.onSessionChange).toHaveBeenLastCalledWith('signout');
    expect(acct.onSignOut).not.toHaveBeenCalled();
  });

  it('follows an explicit theme, and the OS otherwise', () => {
    setTheme('light');
    const menu = userMenu(account());
    document.body.append(menu);
    expect(menu.getAttribute('theme')).toBe('light');
    setTheme('dark');
    expect(menu.getAttribute('theme')).toBe('dark');
    setTheme('system');
    expect(menu.hasAttribute('theme')).toBe(false);
  });

  it('keeps its keys: Space inside it does not play', async () => {
    await mountEditor(account());
    const run = vi.spyOn(view.ctx.commands, 'handleKey');
    const menu = root.querySelector(USER_MENU_TAG);
    const press = (target) => {
      const e = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, composed: true, cancelable: true });
      target.dispatchEvent(e);
      return e;
    };
    expect(press(menu.shadowRoot.querySelector('.feedback')).defaultPrevented).toBe(false);
    expect(run).not.toHaveBeenCalled();
    press(document.body);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
