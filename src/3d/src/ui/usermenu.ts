// puter.js's <puter-user-menu>, as in the other apps: when the loaded SDK defines it, it ends the
// top bar and holds the Apps launcher and the account (Sign in, or the picture with Manage
// account, Usage, Open Puter, Send feedback and Sign out) on the web. This app has no account
// control of its own and keeps nothing per account (the assistant asks Puter whether someone is
// signed in each time it is used), so the element signs in and out by itself and the app only
// keeps it on its theme.
//
// Without the element (an SDK that predates it, or no SDK: offline, blocked) and inside a Puter
// app window, where it renders nothing and the desktop has its own launcher, the top bar is as
// it was.
import { raw, type VNode } from './h';

export const USER_MENU_TAG = 'puter-user-menu';

/** Whether <puter-user-menu> has a place in the top bar. */
export function hasUserMenu(): boolean {
  const env = (globalThis as unknown as { puter?: { env?: string } }).puter?.env;
  return env === 'web' && typeof customElements !== 'undefined' && !!customElements.get(USER_MENU_TAG);
}

/** The element for the end of the top bar (created once, then left alone), or null. */
export function userMenu(): VNode | null {
  return hasUserMenu() ? raw(USER_MENU_TAG, create) : null;
}

let watching = false;

function create(): Element {
  const menu = document.createElement(USER_MENU_TAG);
  syncTheme(menu);
  if (!watching && typeof MutationObserver !== 'undefined') {
    watching = true;
    new MutationObserver(() => document.querySelectorAll(USER_MENU_TAG).forEach(syncTheme)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  return menu;
}

// The element and the app browser in it follow the interface theme, which is dark unless a
// light theme is chosen in the Preferences (never the OS setting).
function syncTheme(menu: Element) {
  menu.setAttribute('theme', document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
}
