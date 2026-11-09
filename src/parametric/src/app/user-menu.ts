// puter.js's <puter-user-menu>, as in Builder: when the loaded SDK defines it,
// it holds the Apps launcher and the account button on the web, and the app's
// own launcher (apps-panel.ts) and account menu (start.ts) stand down. It
// follows the sign-in through puter.js by itself; the app keeps it on its
// theme and answers its Sign in and Sign out (bindUserMenu in start.ts).
//
// Without it (an SDK that predates it) the app's own controls stay. Inside a
// Puter app window it renders nothing, so the app's account menu stays there
// too, and the desktop has its own launcher.

import { inPuterApp } from './apps-panel';
import { resolvedTheme } from '../platform/theme';

export const USER_MENU_TAG = 'puter-user-menu';

/** The title bar's <puter-user-menu>, or null when the loaded puter.js doesn't define it. */
export function userMenuElement(): HTMLElement | null {
  if (typeof customElements === 'undefined' || !customElements.get(USER_MENU_TAG)) return null;
  const el = document.createElement(USER_MENU_TAG);
  el.hidden = inPuterApp();
  syncUserMenuTheme(el);
  return el;
}

/**
 * After the SDK loads and after signing in or out: shows the element where it
 * renders. Returns whether it stands in for the app's own launcher and account
 * button.
 */
export function syncUserMenu(el: HTMLElement | null | undefined): boolean {
  if (!el) return false;
  el.hidden = inPuterApp();
  syncUserMenuTheme(el);
  return !el.hidden;
}

/** It and the app browser in it follow the app's theme, not only the OS. */
export function syncUserMenuTheme(el: HTMLElement) {
  const resolved = document.documentElement.dataset.themeResolved;
  el.setAttribute('theme', resolved === 'dark' || resolved === 'light' ? resolved : resolvedTheme());
}
