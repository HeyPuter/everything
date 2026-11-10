import { addTranslations, t } from "./i18n.js";

addTranslations({
  "Sign in": "Se connecter",
  "Sign out": "Se déconnecter",
  Apps: "Applications",
  Close: "Fermer",
  Account: "Compte",
  "Manage account": "Gérer le compte",
  Usage: "Utilisation",
  "Open Puter": "Ouvrir Puter",
  "Send feedback": "Envoyer la rétroaction",
});

export const USER_MENU_TAG = "puter-user-menu";

// The element's labels, each in the app's language.
const LABELS = {
  "apps-label": "Apps",
  "sign-in-label": "Sign in",
  "sign-out-label": "Sign out",
  "close-label": "Close",
  "account-label": "Account",
  "manage-account-label": "Manage account",
  "usage-label": "Usage",
  "open-puter-label": "Open Puter",
  "feedback-label": "Send feedback",
};

// puter.js's <puter-user-menu>: when the loaded SDK defines it, it holds the
// Apps launcher and the account (Sign in, or the picture with Manage
// account, Usage, Open Puter, Send feedback and Sign out) at the end of the
// library's and the editor's header, and the app's own Apps button
// (apps-panel.js) and account control (account-ui.js) stand down.
//
// The element follows the sign-in through puter.js by itself. The app keeps
// it in its language and on its theme, follows a sign-in it did, and takes
// its Sign out over: the element would sign out at once and only then say
// so, and the app first leaves a shared board and uploads a waiting edit.
//
// Without the element (an SDK that predates it, or none) and inside Puter's
// desktop, where it renders nothing and the desktop has its own launcher,
// the app's own controls stay.
export function createUserMenu({
  puter = () => window.puter,
  // "light" or "dark" for an explicit choice; anything else follows the OS.
  theme = () => "system",
  // Runs in place of the element's own Sign out.
  signOut = null,
  // After the element signed in or out by itself.
  onSignIn = () => {},
  onSignOut = () => {},
} = {}) {
  const active = () =>
    puter()?.env === "web" && !!window.customElements?.get(USER_MENU_TAG);

  function applyTheme(menu) {
    const chosen = theme();
    if (chosen === "light" || chosen === "dark")
      menu.setAttribute("theme", chosen);
    else menu.removeAttribute("theme");
  }

  function create() {
    const menu = document.createElement(USER_MENU_TAG);
    for (const [attribute, text] of Object.entries(LABELS))
      menu.setAttribute(attribute, t(text));
    applyTheme(menu);
    // Caught on the way down to the item, before the element's own handler.
    // Should a later puter.js name the item otherwise, the element signs
    // out by itself and the app follows its `signout` below.
    if (signOut)
      menu.addEventListener(
        "click",
        (e) => {
          const path = e.composedPath();
          const item = path
            .slice(0, path.indexOf(menu))
            .find((node) => node.classList?.contains("sign-out"));
          if (!item) return;
          e.preventDefault();
          e.stopPropagation();
          // The element closes its menu on Escape.
          item.dispatchEvent(
            new window.KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
              cancelable: true,
            }),
          );
          signOut();
        },
        true,
      );
    // It has already signed in or out by the time it says so.
    menu.addEventListener("signin", (e) => onSignIn(e.detail?.user ?? null));
    menu.addEventListener("signout", () => onSignOut());
    return menu;
  }

  return {
    // Whether the element stands in for the Apps button and the account
    // control.
    active,
    // The place both headers keep for it; a render fills it in bind().
    markup: () => (active() ? `<span data-user-menu hidden></span>` : ""),
    // Each header a render drew gets its element. The headers are drawn
    // anew with their view, and the element with them.
    bind(root = document) {
      for (const slot of root.querySelectorAll("span[data-user-menu]"))
        slot.replaceWith(create());
    },
    // After the app's theme changed.
    syncTheme(root = document) {
      for (const menu of root.querySelectorAll(USER_MENU_TAG)) applyTheme(menu);
    },
  };
}
