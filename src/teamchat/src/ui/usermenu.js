/**
 * puter.js's <puter-user-menu>, as in the other Puter apps: when the loaded
 * SDK defines it, it ends the top bar on the web, with the Apps launcher and
 * the Puter account (the picture with Manage account, Usage, Open Puter,
 * Send feedback and Sign out). The app's own Sign out, in the rail's menu
 * and in "You", stands down while the element shows; the rail's avatar stays,
 * being this workspace's profile (status, notifications, settings).
 *
 * The element follows the session through puter.js by itself. The app keeps
 * it on its theme and takes its Sign out over: the element would sign out at
 * once and only then say so, and the app asks first, leaves the huddle and
 * takes this browser's pushes down before the session goes.
 *
 * Without the element (an SDK that predates it, or the dev mock's), inside a
 * Puter app window, where it renders nothing, and on a phone, which has no
 * top bar, the app's own Sign out stays.
 */
export const USER_MENU_TAG = 'puter-user-menu';

/** Whether <puter-user-menu> holds the account in the top bar. */
export function hasUserMenu() {
  return globalThis.puter?.env === 'web' && !!globalThis.customElements?.get(USER_MENU_TAG);
}

/**
 * A <puter-user-menu> for the top bar, or null where the app's own controls
 * stay. `onSignOut` runs in place of the element's own Sign out;
 * `onSessionChanged` after it signed in or out by itself.
 */
export function userMenu({ onSignOut, onSessionChanged } = {}) {
  if (!hasUserMenu()) return null;
  const menu = document.createElement(USER_MENU_TAG);
  syncTheme(menu);
  // Caught on the way down to the item, before the element's own handler.
  // Should a later puter.js name the item otherwise, the element signs out
  // by itself and the app follows its `signout` below.
  menu.addEventListener('click', (e) => {
    if (!onSignOut) return;
    const path = e.composedPath();
    const item = path.slice(0, path.indexOf(menu)).find((node) => node.classList?.contains('sign-out'));
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    // The element closes its menu on Escape and hands focus back to the
    // picture, where the confirmation returns it.
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    onSignOut();
  }, true);
  // It has already signed in or out by the time it says so.
  menu.addEventListener('signin', () => onSessionChanged?.());
  menu.addEventListener('signout', () => onSessionChanged?.());
  return menu;
}

/**
 * Whether the element is on screen: in a top bar that shows (a workspace
 * open, at the widths that have one; see .topbar in app.css). The app's own
 * Sign out stands down only then.
 */
export function userMenuShown() {
  if (!hasUserMenu() || !matchMedia('(min-width: 720px)').matches) return false;
  return [...document.querySelectorAll(USER_MENU_TAG)].some((menu) => menu.isConnected && !menu.closest('[hidden]'));
}

// The element and the app browser in it follow an explicit Light or Dark
// choice; left alone they follow the OS, as the app's System theme does.
function syncTheme(menu) {
  const theme = document.documentElement.dataset.theme;
  if (theme === 'light' || theme === 'dark') menu.setAttribute('theme', theme);
  else menu.removeAttribute('theme');
}

/** After the theme changed (see applyTheme): the element on screen follows. */
export function syncUserMenuTheme() {
  document.querySelectorAll(USER_MENU_TAG).forEach(syncTheme);
}
