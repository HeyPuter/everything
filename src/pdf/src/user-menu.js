/**
 * puter.js's <puter-user-menu>, as in Builder: when the loaded SDK defines it, it holds the Apps
 * launcher and the account (Sign in, or the picture with Manage account, Usage, Open Puter, Send
 * feedback and Sign out) on the web, after Settings in the title bar. The app's own Apps button
 * (apps-panel.js), its account label and the account rows of Settings stand down.
 *
 * The element follows the sign-in through puter.js by itself. The app keeps it on its theme,
 * follows its Sign in, and takes its Sign out over: the element would sign out at once and only
 * then say so, and the app asks about unsaved changes first.
 *
 * The SDK script is async, so a title bar built before it arrived holds an empty slot, filled by
 * refreshUserMenus() once it has. Without the element (an SDK that predates it, or none) and in
 * a Puter desktop window, where it renders nothing and the desktop has its own launcher, the
 * app's own controls stay.
 */
export const USER_MENU_TAG = 'puter-user-menu';

let handlers = { signOut: null, sessionChanged: null };
let watching = false;

/** `signOut` runs in place of the element's own Sign out; `sessionChanged` after it signed in or out by itself. */
export function configureUserMenu(next) {
  handlers = { ...handlers, ...next };
}

/** Whether <puter-user-menu> stands in for the app's own Apps button and account controls. */
export function hasUserMenu() {
  return globalThis.puter?.env === 'web' && !!globalThis.customElements?.get(USER_MENU_TAG);
}

/** For a title bar, after Settings: the element, or the slot that waits for the SDK. */
export function userMenuSlot() {
  if (hasUserMenu()) return create();
  const slot = document.createElement('span');
  slot.className = 'user-menu-slot';
  slot.hidden = true;
  return slot;
}

/** Once the SDK has loaded: the waiting title bars get the element. */
export function refreshUserMenus() {
  if (!hasUserMenu()) return;
  for (const slot of document.querySelectorAll('.user-menu-slot')) slot.replaceWith(create());
}

function create() {
  const menu = document.createElement(USER_MENU_TAG);
  syncTheme(menu);
  watchTheme();
  // Caught on the way down to the item, before the element's own handler. Should a later
  // puter.js name the item otherwise, the element signs out by itself and the app follows its
  // `signout` below.
  menu.addEventListener(
    'click',
    (e) => {
      if (!handlers.signOut) return;
      const path = e.composedPath();
      const item = path
        .slice(0, path.indexOf(menu))
        .find((node) => node.classList?.contains('sign-out'));
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      // The element closes its menu on Escape and hands focus back to the picture, where a
      // confirmation returns it.
      item.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      handlers.signOut();
    },
    true,
  );
  // It has already signed in or out by the time it says so.
  menu.addEventListener('signin', () => handlers.sessionChanged?.());
  menu.addEventListener('signout', () => handlers.sessionChanged?.());
  return menu;
}

// The element and the app browser in it follow an explicit Light or Dark choice; left alone
// they follow the OS, as the app's System theme does.
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
    { attributes: true, attributeFilter: ['data-theme'] },
  );
}
