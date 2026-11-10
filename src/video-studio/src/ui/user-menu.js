/**
 * puter.js's <puter-user-menu>, as in Builder: when the loaded SDK defines it,
 * it holds the Apps launcher and the account (Sign in, or the picture with
 * Manage account, Usage, Open Puter, Send feedback and Sign out) on the web.
 * The app's own account button stands down: the editor's title bar ends with
 * the element, and the home screen with a Settings button (the theme, which
 * the account menu also held) and the element.
 *
 * The element follows the sign-in through puter.js by itself. The app keeps
 * it on its theme, follows its Sign in, and takes its Sign out over: the
 * element would sign out at once and only then say so, and the app saves the
 * open project and waits for media uploads first.
 *
 * Without the element (an SDK that predates it, or none) and inside a Puter
 * app window, where it renders nothing and the desktop has its own launcher,
 * the account button stays.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { menuButton } from './menu.js';

export const USER_MENU_TAG = 'puter-user-menu';

/** Whether <puter-user-menu> stands in for the account button. */
export function hasUserMenu() {
  return globalThis.puter?.env === 'web' && !!globalThis.customElements?.get(USER_MENU_TAG);
}

/**
 * A <puter-user-menu> for a title bar, or null where the account button
 * stays. `account.onSignOut` runs in place of the element's own Sign out;
 * `account.onSessionChange` after it signed in or out by itself.
 */
export function userMenu(account = {}) {
  if (!hasUserMenu()) return null;
  const menu = document.createElement(USER_MENU_TAG);
  syncTheme(menu);
  // Caught on the way down to the item, before the element's own handler.
  // Should a later puter.js name the item otherwise, the element signs out by
  // itself and the app follows its `signout` below.
  menu.addEventListener('click', (e) => {
    if (!account.onSignOut) return;
    const path = e.composedPath();
    const item = path.slice(0, path.indexOf(menu)).find((node) => node.classList?.contains('sign-out'));
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    // The element closes its menu on Escape and hands focus back to the picture.
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    account.onSignOut();
  }, true);
  // It has already signed in or out by the time it says so.
  menu.addEventListener('signin', () => account.onSessionChange?.('signin'));
  menu.addEventListener('signout', () => account.onSessionChange?.('signout'));
  return menu;
}

/** Beside the element on the home screen: the account menu without the account. */
export function settingsButton(themeItems) {
  const btn = h('button.icon-btn.settings-btn', { type: 'button', 'aria-label': 'Settings', 'data-tip': 'Settings' }, icon('settings', 18));
  menuButton(btn, () => [{ heading: 'Theme' }, ...themeItems()], { align: 'end', label: 'Settings' });
  return btn;
}

// The element and the app browser in it follow an explicit Light or Dark
// choice; left alone they follow the OS, as the System theme does. applyTheme
// (prefs.js) does the same when the theme changes.
function syncTheme(menu) {
  const theme = document.documentElement.dataset.theme;
  if (theme === 'light' || theme === 'dark') menu.setAttribute('theme', theme);
  else menu.removeAttribute('theme');
}
