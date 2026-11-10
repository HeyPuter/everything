/**
 * puter.js's <puter-user-menu>: when the loaded SDK defines it, it holds the
 * Apps launcher and the account (Sign in, or the picture with Manage account,
 * Usage, Open Puter, Send feedback and Sign out) at the end of the title bar
 * on the web, and the app's own Sign in button and account button stand down.
 *
 * The element signs in and out through puter.js by itself, then says so. The
 * app keeps it on its theme and follows both as it follows its own.
 *
 * The SDK script is async, so the title bar is built with an empty slot that
 * mountUserMenu() fills once the SDK has loaded. Without the element (an SDK
 * that predates it, or none) and inside a Puter app window, where it renders
 * nothing, the slot stays empty and the app's own controls stay.
 */
import { h } from './dom.js';

export const USER_MENU_TAG = 'puter-user-menu';

/** Whether <puter-user-menu> stands in for the app's own account controls. */
export function hasUserMenu() {
  return globalThis.puter?.env === 'web' && !!globalThis.customElements?.get(USER_MENU_TAG);
}

/** For the title bar: the place that waits for the SDK. */
export function userMenuSlot() {
  return h('span.user-menu-slot', { hidden: true });
}

/**
 * Once the SDK has loaded: puts the element in the slot and returns it, or
 * null where the app's own controls stay. `signedIn` and `signedOut` run
 * after the element signed in or out.
 */
export function mountUserMenu(slot, { signedIn, signedOut } = {}) {
  if (!slot?.isConnected || !hasUserMenu()) return null;
  const menu = document.createElement(USER_MENU_TAG);
  syncTheme(menu);
  watchTheme();
  menu.addEventListener('signin', () => signedIn?.());
  menu.addEventListener('signout', () => signedOut?.());
  slot.replaceWith(menu);
  return menu;
}

// The element and the app browser in it follow an explicit Light or Dark
// choice; left alone they follow the OS, as the app's System theme does.
function syncTheme(menu) {
  const theme = document.documentElement.dataset.theme;
  if (theme === 'light' || theme === 'dark') menu.setAttribute('theme', theme);
  else menu.removeAttribute('theme');
}

let watching = false;
function watchTheme() {
  if (watching || typeof MutationObserver === 'undefined') return;
  watching = true;
  new MutationObserver(() => document.querySelectorAll(USER_MENU_TAG).forEach(syncTheme)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
