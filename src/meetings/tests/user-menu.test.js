// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mountHome } from '../src/ui/home.js';
import { hasUserMenu, USER_MENU_TAG } from '../src/ui/user-menu.js';
import { setTheme } from '../src/ui/theme.js';

// puter.js's <puter-user-menu> in the home header: where the SDK defines it,
// it stands in for the app's picture, Sign out button and Sign in button,
// and its Sign out is the app's.

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

let root, unmount, ctx, sdk, name;
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const menu = () => root.querySelector(USER_MENU_TAG);

beforeEach(() => {
  localStorage.clear();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  name = '';
  sdk = {
    env: 'web',
    _user: { username: 'ada', uuid: 'u-1' },
    auth: {
      isSignedIn: () => !!sdk._user,
      getUser: vi.fn(async () => sdk._user),
      signIn: vi.fn(),
      signOut: vi.fn(async () => {
        sdk._user = null;
      }),
      getProfilePicture: async () => null,
    },
  };
  window.puter = sdk;
  root = document.createElement('div');
  document.body.append(root);
  ctx = {
    getUserName: () => name,
    setUserName: vi.fn((next) => {
      name = next;
    }),
  };
});
afterEach(() => {
  unmount?.();
  unmount = null;
  root.remove();
  delete window.puter;
  delete document.documentElement.dataset.theme;
});

describe('without <puter-user-menu> in the SDK', () => {
  it('keeps the picture and the Sign out button, or the Sign in button', async () => {
    expect(hasUserMenu()).toBe(false);
    unmount = mountHome(root, ctx);
    await flush();
    expect(menu()).toBeNull();
    expect(root.querySelector('.home-user .avatar')).not.toBeNull();
    root.querySelector('[aria-label="Sign out"]').click();
    await flush();
    expect(sdk.auth.signOut).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.home-signin').textContent).toBe('Sign in');
  });
});

describe('with <puter-user-menu> in the SDK', () => {
  beforeEach(() => {
    if (!customElements.get(USER_MENU_TAG)) customElements.define(USER_MENU_TAG, FakeUserMenu);
  });

  it('ends the header, in place of the picture and the Sign out button', async () => {
    expect(hasUserMenu()).toBe(true);
    unmount = mountHome(root, ctx);
    await flush();
    const actions = root.querySelector('.home-header-actions');
    expect(actions.lastElementChild.firstElementChild).toBe(menu());
    expect(root.querySelector('.home-user').children).toHaveLength(1);
    expect(root.querySelector('[aria-label="Sign out"]')).toBeNull();
    expect(root.querySelector('[aria-label="Settings"]')).not.toBeNull();
    expect(root.querySelector('[aria-label="Toggle theme"]')).not.toBeNull();
    // The account's username is still the fallback display name.
    expect(ctx.setUserName).toHaveBeenCalledWith('ada');
  });

  it('stands in for the Sign in button too', async () => {
    sdk._user = null;
    unmount = mountHome(root, ctx);
    await flush();
    expect(menu()).not.toBeNull();
    expect(root.querySelector('.home-signin')).toBeNull();
    expect(ctx.setUserName).not.toHaveBeenCalled();
  });

  it('stays out of a Puter app window, where the element renders nothing', async () => {
    sdk.env = 'app';
    expect(hasUserMenu()).toBe(false);
    unmount = mountHome(root, ctx);
    await flush();
    expect(menu()).toBeNull();
    expect(root.querySelector('[aria-label="Sign out"]')).not.toBeNull();
  });

  it("hands Sign out to the app, and closes the element's menu", async () => {
    unmount = mountHome(root, ctx);
    await flush();
    const element = menu();
    element.shadowRoot.querySelector('.sign-out').click();
    await flush();
    expect(sdk.auth.signOut).toHaveBeenCalledTimes(1);
    expect(element.ownSignOut).not.toHaveBeenCalled();
    expect(element.escapes).toBe(1);
    // The same element stays in the header through the change.
    expect(menu()).toBe(element);
    // Its other items are its own.
    element.shadowRoot.querySelector('.feedback').click();
    expect(sdk.auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('follows a sign-in and a sign-out the element did by itself', async () => {
    sdk._user = null;
    unmount = mountHome(root, ctx);
    await flush();
    const element = menu();
    sdk._user = { username: 'grace', uuid: 'u-2' };
    element.dispatchEvent(new CustomEvent('signin', { detail: { user: sdk._user } }));
    await flush();
    expect(sdk.auth.signIn).not.toHaveBeenCalled();
    expect(ctx.setUserName).toHaveBeenCalledWith('grace');
    expect(menu()).toBe(element);

    sdk._user = null;
    const asked = sdk.auth.getUser.mock.calls.length;
    element.dispatchEvent(new CustomEvent('signout'));
    await flush();
    expect(sdk.auth.signOut).not.toHaveBeenCalled();
    expect(sdk.auth.getUser.mock.calls.length).toBe(asked);
    expect(menu()).toBe(element);
  });

  it('follows an explicit theme, and the OS otherwise', async () => {
    unmount = mountHome(root, ctx);
    await flush();
    expect(menu().hasAttribute('theme')).toBe(false);
    setTheme('dark');
    await vi.waitFor(() => expect(menu().getAttribute('theme')).toBe('dark'));
    setTheme(null);
    await vi.waitFor(() => expect(menu().hasAttribute('theme')).toBe(false));
  });
});
