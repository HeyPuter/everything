import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_MENU_TAG, hasUserMenu, inUserMenu, mountUserMenu } from './user-menu.js';

// The SDK's <puter-user-menu> in the header. These tests run without a DOM,
// so the element and the header are the few methods the module touches:
// enough to show when the element is added and that what it does by itself
// reaches the game.
function fakeElement(localName) {
  const listeners = [];
  const attributes = new Map();
  return {
    localName,
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: name => attributes.get(name) ?? null,
    hasAttribute: name => attributes.has(name),
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    emit(type, event = {}) {
      for (const l of listeners) if (l.type === type) l.fn(event);
    },
  };
}

function fakeBar() {
  const children = [fakeElement('button')];
  return {
    children,
    querySelector: selector => children.find(c => c.localName === selector) ?? null,
    append: node => children.push(node),
  };
}

let defined;

beforeEach(() => {
  defined = false;
  vi.stubGlobal('customElements', {
    get: name => (defined && name === USER_MENU_TAG ? class {} : undefined),
  });
  vi.stubGlobal('document', { createElement: fakeElement });
  vi.stubGlobal('puter', { env: 'web' });
});

afterEach(() => vi.unstubAllGlobals());

describe('where the header stays as it is', () => {
  it('has no element from an SDK that predates it', () => {
    const bar = fakeBar();
    expect(hasUserMenu()).toBe(false);
    expect(mountUserMenu(bar)).toBe(null);
    expect(bar.children).toHaveLength(1);
  });

  it('has none when the SDK never loaded', () => {
    defined = true;
    vi.stubGlobal('puter', undefined);
    const bar = fakeBar();
    expect(hasUserMenu()).toBe(false);
    expect(mountUserMenu(bar)).toBe(null);
    expect(bar.children).toHaveLength(1);
  });

  it('has none inside a Puter app window, where the element renders nothing', () => {
    defined = true;
    vi.stubGlobal('puter', { env: 'app' });
    const bar = fakeBar();
    expect(hasUserMenu()).toBe(false);
    expect(mountUserMenu(bar)).toBe(null);
    expect(bar.children).toHaveLength(1);
  });
});

describe('with <puter-user-menu> in the loaded SDK', () => {
  beforeEach(() => {
    defined = true;
  });

  it('goes at the end of the header, once, on the dark theme', () => {
    const bar = fakeBar();
    expect(hasUserMenu()).toBe(true);
    const menu = mountUserMenu(bar, { theme: 'dark' });
    expect(menu.localName).toBe(USER_MENU_TAG);
    expect(bar.children.at(-1)).toBe(menu);
    expect(menu.getAttribute('theme')).toBe('dark');
    expect(mountUserMenu(bar, { theme: 'dark' })).toBe(menu);
    expect(bar.children).toHaveLength(2);
  });

  it('follows the OS when given no theme', () => {
    expect(mountUserMenu(fakeBar()).hasAttribute('theme')).toBe(false);
  });

  it('follows a sign-in and a sign-out the element did by itself', () => {
    const onSignIn = vi.fn();
    const onSignOut = vi.fn();
    const menu = mountUserMenu(fakeBar(), { onSignIn, onSignOut });
    const user = { username: 'klondike' };
    menu.emit('signin', { detail: { user } });
    expect(onSignIn).toHaveBeenCalledWith(user);
    expect(onSignOut).not.toHaveBeenCalled();
    menu.emit('signout', {});
    expect(onSignOut).toHaveBeenCalledTimes(1);
    // A sign-in whose account could not be read still counts.
    menu.emit('signin', { detail: {} });
    expect(onSignIn).toHaveBeenLastCalledWith(null);
  });
});

describe('keys from inside the element', () => {
  it('are told apart from the rest of the page', () => {
    const inside = { closest: selector => (selector === USER_MENU_TAG ? {} : null) };
    const outside = { closest: () => null };
    expect(inUserMenu(inside)).toBe(true);
    expect(inUserMenu(outside)).toBe(false);
    expect(inUserMenu(null)).toBe(false);
    expect(inUserMenu({})).toBe(false);
  });
});
