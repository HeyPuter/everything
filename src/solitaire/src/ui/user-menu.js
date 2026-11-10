// puter.js's <puter-user-menu>: the account button (Sign in, or the player's
// picture with Manage account, Usage, Open Puter, Send feedback and Sign out)
// and, on a *.puter.com page, the Apps launcher. It goes at the far end of
// the header, after New.
//
// Solitaire has no account control of its own: it syncs silently for a
// player who is already signed in. So the element stands in for nothing; it
// is simply added, and main.js follows the `signin` and `signout` events it
// sends after signing in or out through the SDK.
//
// Where there is nothing to add, the header stays as it was: an SDK that
// predates the element, no SDK at all (offline), and a Puter app window,
// where the element renders nothing and the desktop has its own account menu.

export const USER_MENU_TAG = 'puter-user-menu';

/** Whether the loaded SDK has the element and this page is where it shows. */
export function hasUserMenu() {
  return globalThis.puter?.env === 'web' && !!globalThis.customElements?.get(USER_MENU_TAG);
}

// True for an event target inside the element. Keys pressed in its menu reach
// window listeners retargeted to the element itself, and the game's own
// shortcuts have to leave them alone.
export function inUserMenu(target) {
  return !!target?.closest?.(USER_MENU_TAG);
}

// Adds the element to the end of `bar`, once. Returns it, or null where the
// header stays as it is. `theme` is 'light' or 'dark' (the table is always
// dark, and the element would otherwise follow the OS); onSignIn(user) and
// onSignOut() run after the element has signed in or out.
export function mountUserMenu(bar, { theme, onSignIn, onSignOut } = {}) {
  if (!bar || !hasUserMenu()) return null;
  const existing = bar.querySelector(USER_MENU_TAG);
  if (existing) return existing;

  const menu = document.createElement(USER_MENU_TAG);
  if (theme === 'light' || theme === 'dark') menu.setAttribute('theme', theme);
  menu.addEventListener('signin', e => onSignIn?.(e.detail?.user ?? null));
  menu.addEventListener('signout', () => onSignOut?.());
  bar.append(menu);
  return menu;
}
