import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  USER_MENU_TAG,
  hasUserMenu,
  inUserMenu,
  mountUserMenu,
  setUserMenuTheme,
} from '../src/ui/userMenu.js';
import { whenPuterLoaded } from '../src/net/online.js';

/**
 * The SDK's <puter-user-menu> in the top bar. These tests run without a DOM,
 * so the element, its shadow tree and the bar are the few methods the module
 * touches: enough to show when the element is added, that its Sign out can be
 * taken over, and that what it does by itself reaches the game.
 */
function fakeNode(className = '') {
  const listeners = [];
  const attributes = new Map();
  return {
    localName: 'div',
    classList: { contains: (name) => className.split(' ').includes(name) },
    attributes,
    dispatched: [],
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => attributes.get(name) ?? null,
    hasAttribute: (name) => attributes.has(name),
    removeAttribute: (name) => attributes.delete(name),
    addEventListener: (type, fn, capture = false) => listeners.push({ type, fn, capture }),
    dispatchEvent(event) {
      this.dispatched.push(event);
      return true;
    },
    /** Run the listeners for `type`, as the browser would for this node. */
    emit(type, event = {}) {
      for (const l of listeners) if (l.type === type) l.fn(event);
    },
    capturing: (type) => listeners.filter((l) => l.type === type && l.capture),
  };
}

function fakeBar() {
  const children = [];
  return {
    children,
    querySelector: (selector) => children.find((c) => c.localName === selector) ?? null,
    append: (node) => children.push(node),
  };
}

/** A click that started on `target` inside the element's shadow tree. */
function clickOn(menu, target) {
  const event = {
    composedPath: () => [target, menu.shadowMenu, menu.shadowRoot, menu, {}, {}],
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
  for (const l of menu.capturing('click')) l.fn(event);
  return event;
}

let defined;

beforeEach(() => {
  defined = false;
  vi.stubGlobal('customElements', {
    get: (name) => (defined && name === USER_MENU_TAG ? class {} : undefined),
  });
  vi.stubGlobal('document', {
    createElement(name) {
      const el = fakeNode();
      el.localName = name;
      el.shadowRoot = fakeNode();
      el.shadowMenu = fakeNode('panel menu');
      el.signOutItem = fakeNode('menu-item sign-out');
      el.feedbackItem = fakeNode('menu-item feedback');
      return el;
    },
  });
  vi.stubGlobal(
    'KeyboardEvent',
    class {
      constructor(type, init) {
        Object.assign(this, { type }, init);
      }
    },
  );
  vi.stubGlobal('puter', { env: 'web' });
});

afterEach(() => vi.unstubAllGlobals());

describe('where the top bar stays as it is', () => {
  it('has no element from an SDK that predates it', () => {
    const bar = fakeBar();
    expect(hasUserMenu()).toBe(false);
    expect(mountUserMenu(bar)).toBe(null);
    expect(bar.children).toEqual([]);
  });

  it('has none before the SDK has loaded', () => {
    defined = true;
    vi.stubGlobal('puter', undefined);
    const bar = fakeBar();
    expect(mountUserMenu(bar)).toBe(null);
    expect(bar.children).toEqual([]);
  });

  it('has none inside a Puter app window, where the element renders nothing', () => {
    defined = true;
    vi.stubGlobal('puter', { env: 'app' });
    const bar = fakeBar();
    expect(hasUserMenu()).toBe(false);
    expect(mountUserMenu(bar)).toBe(null);
    expect(bar.children).toEqual([]);
  });
});

describe('with <puter-user-menu> in the loaded SDK', () => {
  beforeEach(() => {
    defined = true;
  });

  it('goes at the end of the top bar, once', () => {
    const bar = fakeBar();
    bar.append({ localName: 'div' });
    const menu = mountUserMenu(bar);
    expect(menu.localName).toBe(USER_MENU_TAG);
    expect(bar.children.at(-1)).toBe(menu);
    expect(mountUserMenu(bar)).toBe(menu);
    expect(bar.children).toHaveLength(2);
  });

  it('follows an explicit theme, and the OS otherwise', () => {
    const menu = mountUserMenu(fakeBar(), { theme: 'dark' });
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
    const menu = mountUserMenu(fakeBar(), { signOutGuard });
    const event = clickOn(menu, menu.signOutItem);
    expect(signOutGuard).toHaveBeenCalledTimes(1);
    expect(instead).toHaveBeenCalledTimes(1);
    // The element's own handler never sees the click, and its menu is closed
    // the way it closes itself.
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(menu.signOutItem.dispatched).toHaveLength(1);
    expect(menu.signOutItem.dispatched[0]).toMatchObject({
      type: 'keydown',
      key: 'Escape',
      bubbles: true,
    });
  });

  it('leaves Sign out to the element when the game has nothing to settle', () => {
    const signOutGuard = vi.fn(() => null);
    const menu = mountUserMenu(fakeBar(), { signOutGuard });
    const event = clickOn(menu, menu.signOutItem);
    expect(signOutGuard).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(menu.signOutItem.dispatched).toEqual([]);
  });

  it('leaves the rest of the menu to the element', () => {
    const signOutGuard = vi.fn(() => vi.fn());
    const menu = mountUserMenu(fakeBar(), { signOutGuard });
    const event = clickOn(menu, menu.feedbackItem);
    expect(signOutGuard).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it('follows a sign-in and a sign-out the element did by itself', () => {
    const onSignIn = vi.fn();
    const onSignOut = vi.fn();
    const menu = mountUserMenu(fakeBar(), { onSignIn, onSignOut });
    const user = { username: 'kasparov' };
    menu.emit('signin', { detail: { user } });
    expect(onSignIn).toHaveBeenCalledWith(user);
    expect(onSignOut).not.toHaveBeenCalled();
    menu.emit('signout', {});
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

describe('keys from inside the element', () => {
  it('are told apart from the rest of the page', () => {
    const inside = { closest: (selector) => (selector === USER_MENU_TAG ? {} : null) };
    const outside = { closest: () => null };
    expect(inUserMenu(inside)).toBe(true);
    expect(inUserMenu(outside)).toBe(false);
    expect(inUserMenu(null)).toBe(false);
    expect(inUserMenu({})).toBe(false);
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
    const createElement = vi.fn();
    vi.stubGlobal('document', { createElement });
    const fn = vi.fn();
    whenPuterLoaded(fn);
    expect(fn).not.toHaveBeenCalled();
    expect(createElement).not.toHaveBeenCalled();
  });
});
