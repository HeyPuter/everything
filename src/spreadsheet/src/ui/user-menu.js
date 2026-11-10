/**
 * puter.js's <puter-user-menu>, as in Builder: when the loaded SDK defines it, it holds the Apps launcher and the
 * account (Sign in, or the picture with Manage account, Usage, Open Puter, Send feedback and Sign out) on the web,
 * and the app's own Apps button (apps-panel.js) and account button (appmenu.js) stand down. What the account menu
 * held besides the account moves to a Settings button beside it (see accountControls in appmenu.js).
 *
 * The element follows the sign-in through puter.js by itself. The app keeps it in its language and on its theme,
 * follows its Sign in, and takes its Sign out over: the element would sign out at once and only then say so,
 * and the app saves the open spreadsheet first (confirmSignOut).
 *
 * Without the element (an SDK that predates it, the dev mock) and inside a Puter app window, where it renders
 * nothing and the desktop has its own launcher, the app's own controls stay.
 */

import { currentTheme } from './theme.js';
import { session } from '../lib/session.js';
import * as P from '../lib/puter.js';
import { t } from '../i18n/index.js';

export const USER_MENU_TAG = 'puter-user-menu';

// The element's labels, each from the catalog.
const LABELS = {
  'apps-label': 'apps.title',
  'sign-in-label': 'userMenu.signIn',
  'sign-out-label': 'appmenu.signOut',
  'close-label': 'common.close',
  'account-label': 'appmenu.account',
  'manage-account-label': 'userMenu.manageAccount',
  'usage-label': 'userMenu.usage',
  'open-puter-label': 'userMenu.openPuter',
  'feedback-label': 'userMenu.feedback',
};

/** Whether <puter-user-menu> stands in for the app's own Apps button and account button. */
export function hasUserMenu() {
  return P.hasSDK() && P.env() === 'web' && typeof customElements !== 'undefined' && !!customElements.get(USER_MENU_TAG);
}

/**
 * A <puter-user-menu> for a header, or null where the app's own controls stay. `onSignOut` runs in place of
 * the element's own Sign out.
 */
export function userMenu({ onSignOut = null } = {}) {
  if (!hasUserMenu()) return null;
  const menu = document.createElement(USER_MENU_TAG);
  for (const [attribute, key] of Object.entries(LABELS)) menu.setAttribute(attribute, t(key));
  syncTheme(menu);
  watchTheme();
  // Caught on the way down to the item, before the element's own handler. Should a later puter.js name the
  // item otherwise, the element signs out by itself and the app follows its `signout` below.
  if (onSignOut) menu.addEventListener('click', (e) => {
    const path = e.composedPath();
    const item = path.slice(0, path.indexOf(menu)).find((node) => node.classList?.contains('sign-out'));
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    // The element closes its menu on Escape and hands focus back to the picture, where the confirmation returns it.
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    onSignOut();
  }, true);
  // It has already signed in by the time it says so.
  menu.addEventListener('signin', (e) => session.signedInAs(e.detail?.user));
  menu.addEventListener('signout', () => { session.refresh().catch(() => {}); });
  return menu;
}

// The element and the app browser in it follow an explicit Light or Dark choice; left alone they follow the OS,
// as the app's System theme does.
function syncTheme(menu) {
  const theme = currentTheme();
  if (theme === 'light' || theme === 'dark') menu.setAttribute('theme', theme);
  else menu.removeAttribute('theme');
}

let watching = false;
function watchTheme() {
  if (watching || typeof MutationObserver === 'undefined') return;
  watching = true;
  new MutationObserver(() => document.querySelectorAll(USER_MENU_TAG).forEach(syncTheme))
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
