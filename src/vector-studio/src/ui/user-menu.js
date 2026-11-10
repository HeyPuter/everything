/**
 * puter.js's <puter-user-menu>, as in Builder: when the loaded SDK defines it,
 * it ends the top bar and holds the Apps launcher and the account (Sign in, or
 * the picture with Manage account, Usage, Open Puter, Send feedback and Sign
 * out) on the web. The app's own Sign in button and account button stand down.
 *
 * The element signs in and out through puter.js by itself, then says so; the
 * app follows as it does for its own Sign in and Sign out (onSessionChange in
 * main.js), and keeps the element on its theme.
 *
 * Without the element (an SDK that predates it, or none) and inside a Puter
 * app window, where it renders nothing and the desktop has its own launcher,
 * the app's own controls stay.
 */
export const USER_MENU_TAG = 'puter-user-menu';

/** Whether <puter-user-menu> stands in for the Sign in and account buttons. */
export function hasUserMenu() {
  return globalThis.puter?.env === 'web' && !!globalThis.customElements?.get(USER_MENU_TAG);
}

/**
 * A <puter-user-menu> for the top bar, or null where the app's own controls
 * stay. `onSessionChange` runs after it signed in or out.
 */
export function userMenu({ onSessionChange } = {}) {
  if (!hasUserMenu()) return null;
  const menu = document.createElement(USER_MENU_TAG);
  syncTheme(menu);
  window.addEventListener('themechange', () => syncTheme(menu));
  // It has already signed in or out by the time it says so.
  menu.addEventListener('signin', () => onSessionChange?.());
  menu.addEventListener('signout', () => onSessionChange?.());
  return menu;
}

// The element and the app browser in it follow a chosen brightness (the two
// dark levels as dark, the two light ones as light); left alone they follow
// the OS, as Use System Setting does.
function syncTheme(menu) {
  const root = document.documentElement;
  const resolved = root.dataset.themeResolved;
  if (root.dataset.theme && root.dataset.theme !== 'system' && (resolved === 'dark' || resolved === 'light')) menu.setAttribute('theme', resolved);
  else menu.removeAttribute('theme');
}
