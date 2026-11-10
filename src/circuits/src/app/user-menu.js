// puter.js's <puter-user-menu>: when the loaded SDK defines it, it holds the
// Apps launcher and the account (Sign in, or the picture with Manage account,
// Usage, Open Puter, Send feedback and Sign out) at the end of the title bar
// on the web, and the app's own Sign in button and account button stand down.
//
// The element follows the sign-in through puter.js by itself. The app keeps it
// on its theme, follows its Sign in, and takes its Sign out over: the element
// would sign out at once and only then say so, and the app saves the open
// project first.
//
// The title bar is built before the SDK is known, with an empty slot that
// mountUserMenu() fills once it is. Without the element (an SDK that predates
// it, or none) and inside a Puter app window, where it renders nothing, the
// slot stays empty and the app's own controls stay.

import { h } from '../ui/dom.js';
import { resolvedTheme } from './theme.js';
import * as P from './puter.js';

export const USER_MENU_TAG = 'puter-user-menu';

/** Whether <puter-user-menu> stands in for the app's own account controls. */
export function hasUserMenu() {
  return P.env() === 'web' && typeof customElements !== 'undefined' && !!customElements.get(USER_MENU_TAG);
}

/** For the title bar: the place that waits for the SDK. */
export function userMenuSlot() {
  return h('span.user-menu-slot', { hidden: true });
}

/**
 * Once the SDK has loaded: puts the element in the slot and returns it, or
 * null where the app's own controls stay. `signOut` runs in place of the
 * element's own Sign out; `signedIn` and `signedOut` after it signed in or
 * out by itself.
 */
export function mountUserMenu(slot, { signOut, signedIn, signedOut } = {}) {
  if (!slot?.isConnected || !hasUserMenu()) return null;
  const menu = document.createElement(USER_MENU_TAG);
  // It and the app browser in it follow the app's theme, not only the OS.
  const syncTheme = () => menu.setAttribute('theme', resolvedTheme());
  syncTheme();
  window.addEventListener('themechange', syncTheme);
  // Caught on the way down to the item, before the element's own handler.
  // Should a later puter.js name the item otherwise, the element signs out by
  // itself and the app follows its `signout` below.
  menu.addEventListener('click', (e) => {
    if (!signOut) return;
    const path = e.composedPath();
    const item = path.slice(0, path.indexOf(menu)).find((node) => node.classList?.contains('sign-out'));
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    // The element closes its menu on Escape and hands focus back to the picture.
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    signOut();
  }, true);
  // It has already signed in or out by the time it says so.
  menu.addEventListener('signin', () => signedIn?.());
  menu.addEventListener('signout', () => signedOut?.());
  slot.replaceWith(menu);
  return menu;
}
