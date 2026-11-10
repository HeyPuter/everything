import { getTheme, onThemeChange } from './prefs.js';

/*
 * puter.js's <puter-user-menu>, as in the other apps: when the loaded SDK
 * defines it, it holds the Apps launcher and the account (Sign in, or the
 * picture with Manage account, Usage, Open Puter, Send feedback and Sign out)
 * at the end of the title bar, and the app's own Apps button (apps-panel.js)
 * and the rail's account button stand down.
 *
 * The element follows the sign-in through puter.js by itself. The app keeps
 * it on its theme, follows a sign-in or sign-out it did, and takes its Sign
 * out over: the element would sign out at once and only then say so, and the
 * app saves the open page first.
 *
 * Without the element (an SDK that predates it, the tests' and ?local's lack
 * of one) and inside a Puter app window, where it renders nothing and the
 * desktop has its own launcher, the app's own controls stay.
 */

export const USER_MENU_TAG = 'puter-user-menu';

/** Whether <puter-user-menu> stands in for the app's Apps button and account button. */
export function hasUserMenu(env = 'web') {
  return env === 'web' && globalThis.puter?.env === 'web' && !!globalThis.customElements?.get(USER_MENU_TAG);
}

/**
 * A <puter-user-menu> for the title bar, or null where the app's own controls
 * stay. `onSignOut` runs in place of the element's own Sign out;
 * `onSessionChange` after it signed in or out by itself. `dispose` on the
 * result stops it following the theme.
 */
export function userMenu({ env = 'web', onSignOut = null, onSessionChange = null } = {}) {
  if (!hasUserMenu(env)) return null;
  const menu = document.createElement(USER_MENU_TAG);
  const syncTheme = () => {
    // An explicit Light or Dark; left alone it follows the OS, as "Use System Setting" does.
    const theme = getTheme();
    if (theme === 'light' || theme === 'dark') menu.setAttribute('theme', theme);
    else menu.removeAttribute('theme');
  };
  syncTheme();
  menu.dispose = onThemeChange(syncTheme);
  // Caught on the way down to the item, before the element's own handler.
  // Should a later puter.js name the item otherwise, the element signs out by
  // itself and the app follows its `signout` below.
  if (onSignOut) {
    menu.addEventListener('click', (e) => {
      const path = e.composedPath();
      const item = path.slice(0, path.indexOf(menu)).find((node) => node.classList?.contains('sign-out'));
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      // The element closes its menu on Escape.
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      onSignOut();
    }, true);
  }
  // It has already signed in or out by the time it says so.
  menu.addEventListener('signin', () => onSessionChange?.());
  menu.addEventListener('signout', () => onSessionChange?.());
  return menu;
}
