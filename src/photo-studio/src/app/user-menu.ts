// puter.js's <puter-user-menu>, as in Builder: when the loaded SDK defines it,
// it follows Export in the top bar and holds the Apps launcher and the account
// (Sign in, or the picture with Manage account, Usage, Open Puter, Send
// feedback and Sign out) on the web. The app's own account button stands down.
//
// The element signs in and out through puter.js by itself, then says so; the
// editor follows as it does for its own account dialog, and keeps the element
// on its theme.
//
// Without it (an SDK that predates it, or none) and inside a Puter app window,
// where it renders nothing and the desktop has its own launcher, the account
// button stays.
import type { Editor } from '../editor';

export const USER_MENU_TAG = 'puter-user-menu';

/** Whether <puter-user-menu> stands in for the account button. */
export function hasUserMenu() {
  const env = (globalThis as { puter?: { env?: string } }).puter?.env;
  return env === 'web' && !!globalThis.customElements?.get(USER_MENU_TAG);
}

/** Puts the element after the account button, which it replaces. puter.js is
 * loaded (deferred) before the app's module, so it is there from the first paint. */
export function installUserMenu(e: Editor) {
  if (!hasUserMenu()) return;
  const account = e.root.querySelector<HTMLElement>('#account');
  if (!account) return;
  const menu = document.createElement(USER_MENU_TAG);
  syncTheme(menu);
  // It has already signed in or out by the time it says so.
  menu.addEventListener('signin', () => e.message('Connected to Puter'));
  menu.addEventListener('signout', () => {
    // Every open document forgets its cloud file: it belonged to that account.
    for (const session of e.sessions) session.storage.reset();
    e.message('Signed out');
  });
  account.hidden = true;
  account.after(menu);
  new MutationObserver(() => syncTheme(menu)).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

// The element and the app browser in it follow Light, and Dark and Medium (a
// dark theme, as is the workspace before a theme is set); left alone they
// follow the OS, as the System theme does.
function syncTheme(menu: HTMLElement) {
  const theme = document.documentElement.dataset.theme;
  if (theme === 'system') menu.removeAttribute('theme');
  else menu.setAttribute('theme', theme === 'light' ? 'light' : 'dark');
}
