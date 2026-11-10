/**
 * puter.js's <puter-user-menu>, as in the other Puter apps: when the loaded
 * SDK defines it, it holds the Apps launcher and the account (Sign in, or the
 * picture with Manage account, Usage, Open Puter, Send feedback and Sign out)
 * at the end of the home header, in place of the app's own picture, Sign out
 * button and Sign in button (src/ui/home.js).
 *
 * The element follows the sign-in through puter.js by itself. The app keeps
 * it on its theme, follows its Sign in, and takes its Sign out over, so the
 * meetings panel is emptied of the account's meetings the same way whichever
 * button signed out.
 *
 * Without the element (an SDK that predates it, or none) and inside a Puter
 * app window, where it renders nothing, the app's own controls stay.
 */
export const USER_MENU_TAG = 'puter-user-menu';

let watching = false;

/** Whether <puter-user-menu> stands in for the app's own account controls. */
export function hasUserMenu() {
  return globalThis.puter?.env === 'web' && !!globalThis.customElements?.get(USER_MENU_TAG);
}

/**
 * A <puter-user-menu> for the header, or null where the app's own controls
 * stay. `onSignOut` runs in place of the element's own Sign out; `onSignIn`
 * and `onSignedOut` after it signed in or out by itself.
 *
 * @param {{onSignOut?: () => void, onSignIn?: () => void, onSignedOut?: () => void}} [handlers]
 * @returns {HTMLElement|null}
 */
export function userMenu({ onSignOut, onSignIn, onSignedOut } = {}) {
  if (!hasUserMenu()) return null;
  const menu = document.createElement(USER_MENU_TAG);
  syncTheme(menu);
  watchTheme();
  // Caught on the way down to the item, before the element's own handler.
  // Should a later puter.js name the item otherwise, the element signs out
  // by itself and the app follows its `signout` below.
  menu.addEventListener(
    'click',
    (e) => {
      if (!onSignOut) return;
      const path = e.composedPath();
      const item = path.slice(0, path.indexOf(menu)).find((node) => node.classList?.contains('sign-out'));
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      // The element closes its menu on Escape and hands focus back to the
      // picture.
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      onSignOut();
    },
    true
  );
  // It has already signed in or out by the time it says so.
  menu.addEventListener('signin', () => onSignIn?.());
  menu.addEventListener('signout', () => onSignedOut?.());
  return menu;
}

// The element and the app browser in it follow an explicit Light or Dark
// choice; left alone they follow the OS, as the app does (src/ui/theme.js).
function syncTheme(menu) {
  const theme = document.documentElement.dataset.theme;
  if (theme === 'light' || theme === 'dark') menu.setAttribute('theme', theme);
  else menu.removeAttribute('theme');
}

function watchTheme() {
  if (watching || typeof MutationObserver === 'undefined') return;
  watching = true;
  new MutationObserver(() => document.querySelectorAll(USER_MENU_TAG).forEach(syncTheme)).observe(
    document.documentElement,
    { attributes: true, attributeFilter: ['data-theme'] }
  );
}
