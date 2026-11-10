/**
 * puter.js's <puter-user-menu>: the account button (Sign in, or the player's
 * picture with Manage account, Usage, Open Puter, Send feedback and Sign out)
 * and, on a *.puter.com page, the Apps launcher. It goes at the far end of the
 * top bar, after the theme toggle.
 *
 * The element belongs to the Puter SDK, which this app loads only for online
 * play (see net/online.js), so there is nothing to mount until then: main.js
 * calls mountUserMenu() once the SDK is on the page. An SDK that predates the
 * element, a Puter app window (where the element renders nothing and the
 * desktop has its own account menu) and no SDK at all leave the top bar as it
 * was.
 *
 * The element signs in and out through the SDK by itself and says so with
 * `signin` and `signout` events. Its Sign out is immediate, so a caller with
 * something to settle first — an online game in progress — can take the click
 * over with `signOutGuard`.
 */

export const USER_MENU_TAG = 'puter-user-menu';

/** Whether the loaded SDK has the element and this page is where it shows. */
export function hasUserMenu() {
  return (
    globalThis.puter?.env === 'web' &&
    !!globalThis.customElements?.get(USER_MENU_TAG)
  );
}

/**
 * True for an event target inside the element. Keys pressed in its menu reach
 * window listeners retargeted to the element itself, and the game's own
 * shortcuts have to leave them alone.
 */
export function inUserMenu(target) {
  return !!target?.closest?.(USER_MENU_TAG);
}

/**
 * The element follows an explicit Light or Dark choice (and hands it to the
 * app browser it opens); left alone it follows the OS, as "system" does here.
 */
export function setUserMenuTheme(menu, theme) {
  if (!menu) return;
  if (theme === 'light' || theme === 'dark') menu.setAttribute('theme', theme);
  else menu.removeAttribute('theme');
}

/**
 * Add the element to the end of `bar`, once. Returns it, or null where the
 * top bar stays as it is.
 *
 * @param {Element} bar
 * @param {{
 *   theme?: string,                  // 'light' | 'dark' | 'system'
 *   signOutGuard?(): (() => void) | null, // asked on a click on Sign out: a
 *                                    // function to run in its place, or null
 *                                    // to let the element sign out
 *   onSignIn?(user): void,           // the element has signed in
 *   onSignOut?(): void,              // the element has signed out
 * }} options
 */
export function mountUserMenu(bar, { theme, signOutGuard, onSignIn, onSignOut } = {}) {
  if (!bar || !hasUserMenu()) return null;
  const existing = bar.querySelector(USER_MENU_TAG);
  if (existing) return existing;

  const menu = document.createElement(USER_MENU_TAG);
  setUserMenuTheme(menu, theme);
  // Caught on the way down to the item, ahead of the element's own handler.
  // Should a later SDK name the item differently, the element signs out by
  // itself and `signout` below still tells the game.
  menu.addEventListener(
    'click',
    (e) => {
      const path = e.composedPath();
      const item = path
        .slice(0, path.indexOf(menu))
        .find((node) => node.classList?.contains('sign-out'));
      if (!item) return;
      const instead = signOutGuard?.();
      if (!instead) return;
      e.preventDefault();
      e.stopPropagation();
      // Escape is how the element closes its own menu.
      item.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      instead();
    },
    true,
  );
  // By the time it says so, the element has already signed in or out.
  menu.addEventListener('signin', (e) => onSignIn?.(e.detail?.user ?? null));
  menu.addEventListener('signout', () => onSignOut?.());
  bar.append(menu);
  return menu;
}
