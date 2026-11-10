/**
 * puter.js's <puter-user-menu>, as in Builder: when the loaded SDK defines it,
 * it holds the Apps launcher and the account (Sign in, or the picture with
 * Manage account, Usage, Open Puter, Send feedback and Sign out) on the web.
 * The app's own Apps button (apps-panel.js) stands down, and its account
 * button becomes a Settings button for what the account menu held besides the
 * account (see accountButton in main.js).
 *
 * The element follows the sign-in through puter.js by itself. The app keeps
 * it on its theme, follows its Sign in, and takes its Sign out over: the
 * element would sign out at once and only then say so, and the app asks about
 * the open presentation first.
 *
 * Without the element (an SDK that predates it, or none) and inside a Puter
 * app window, where it renders nothing and the desktop has its own launcher,
 * the app's own controls stay.
 */
export const USER_MENU_TAG = "puter-user-menu";

/** Whether <puter-user-menu> stands in for the app's Apps and account buttons. */
export function hasUserMenu() {
  return (
    globalThis.puter?.env === "web" &&
    !!globalThis.customElements?.get(USER_MENU_TAG)
  );
}

/**
 * A <puter-user-menu> for a header, or null where the app's own controls
 * stay. `onSignOut` runs in place of the element's own Sign out; `onSignIn`
 * and `onSignedOut` after it signed in or out by itself.
 */
export function userMenu({ cls = "", onSignOut, onSignIn, onSignedOut } = {}) {
  if (!hasUserMenu()) return null;
  const menu = document.createElement(USER_MENU_TAG);
  if (cls) menu.className = cls;
  syncTheme(menu);
  // Caught on the way down to the item, before the element's own handler.
  // Should a later puter.js name the item otherwise, the element signs out by
  // itself and the app follows its `signout` below.
  menu.addEventListener(
    "click",
    (e) => {
      if (!onSignOut) return;
      const path = e.composedPath();
      const item = path
        .slice(0, path.indexOf(menu))
        .find((node) => node.classList?.contains("sign-out"));
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      // The element closes its menu on Escape and hands focus back to the
      // picture, where a confirmation returns it.
      item.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      onSignOut();
    },
    true,
  );
  // It has already signed in or out by the time it says so.
  menu.addEventListener("signin", () => onSignIn?.());
  menu.addEventListener("signout", () => onSignedOut?.());
  return menu;
}

// The element and the app browser in it follow an explicit Light or Dark
// choice; left alone they follow the OS, as the app's System mode does.
function syncTheme(menu) {
  const theme = document.documentElement.dataset.theme;
  if (theme === "light" || theme === "dark") menu.setAttribute("theme", theme);
  else menu.removeAttribute("theme");
}

/** After the color mode changed: the elements on screen follow. */
export function syncUserMenuTheme() {
  document.querySelectorAll(USER_MENU_TAG).forEach(syncTheme);
}
