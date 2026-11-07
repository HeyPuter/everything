import { addTranslations, t } from "./i18n.js";
import { escape } from "./model.js";

addTranslations({
  "Sign in": "Se connecter",
  "Sign in to Puter": "Se connecter à Puter",
  Account: "Compte",
  "Account menu": "Menu du compte",
  "Signed in with Puter": "Connecté avec Puter",
  "Loading your account…": "Chargement de votre compte…",
  "Sign out": "Se déconnecter",
  "Signed in as {name}.": "Connecté en tant que {name}.",
  "Signed in with Puter.": "Connecté avec Puter.",
  "Signed out. Your local boards are still available.":
    "Déconnexion effectuée. Vos tableaux locaux restent disponibles.",
  "Could not sign in. Try again.": "Connexion impossible. Réessayez.",
});

// Whether this person is signed in is answered at a glance, in the same
// place on every screen: a Sign in button while signed out and, once signed
// in, an avatar that opens the account menu with their name, their cloud
// boards, and a way to sign out. Puter's desktop signs its apps in itself,
// so there the menu offers no sign-out.
export function createAccountUI({
  puter = () => window.puter,
  icon,
  action,
  refresh = () => {},
  // The Apps panel shares the corner and follows the account.
  onMenuOpen = () => {},
  onChange = () => {},
}) {
  let user = null,
    picture = null,
    loading = null,
    openMenu = null;
  const signedIn = () => !!puter()?.auth?.isSignedIn?.();
  const canSignOut = () => puter()?.env !== "app";
  const name = () => user?.username || "";
  // A stable color per account, so the same person's avatar looks the same
  // on every visit and in every header.
  const hue = (text) => {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  };
  const initial = (text) => [...text.trim()][0]?.toLocaleUpperCase() || "";
  // Puter answers with the picture's own data, which is drawn only when it
  // is an image, so a profile could not slip a script in.
  const validPicture = (value) =>
    typeof value === "string" &&
    /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(value)
      ? value
      : null;
  function avatar(extra = "") {
    const label = name();
    if (picture)
      return `<img class="avatar avatar-picture${extra}" src="${picture}" alt="" draggable="false">`;
    return label
      ? `<span class="avatar avatar-initial${extra}" style="--avatar-hue:${hue(label)}" aria-hidden="true">${escape(initial(label))}</span>`
      : `<span class="avatar${extra}" aria-hidden="true">${icon("user-round")}</span>`;
  }
  function markup() {
    if (!signedIn())
      return `<button type="button" class="account-signin" data-account-action="sign-in" aria-label="Sign in" title="Sign in">${icon("log-in")}<span>Sign in</span></button>`;
    const label = name();
    return `<button type="button" class="account-button" data-account-action="menu" aria-haspopup="menu" aria-expanded="false" aria-label="${escape(label ? `${t("Account menu")} · ${label}` : t("Account menu"))}" title="${escape(label || t("Account"))}"${loading ? ' aria-busy="true"' : ""}>${avatar()}</button>`;
  }
  function menuMarkup() {
    const label = name();
    const detail = user?.email && user.email !== label ? user.email : "";
    const heading = label
      ? `<strong data-user-content>${escape(label)}</strong>`
      : `<strong>${loading ? "Loading your account…" : "Signed in with Puter"}</strong>`;
    const line = detail
      ? `<small data-user-content>${escape(detail)}</small>`
      : label
        ? `<small>Signed in with Puter</small>`
        : "";
    // Only menu items are read inside a menu, so the account's name and
    // email describe the menu instead.
    const items = canSignOut()
      ? `<button type="button" role="menuitem" tabindex="-1" data-account-action="sign-out">${icon("log-out")}Sign out</button>`
      : "";
    // In Puter's own app there is nothing to choose, so the popover is the
    // account's card rather than an empty menu.
    return `<div class="account-menu" role="${items ? "menu" : "group"}" aria-label="Account" aria-describedby="account-identity"><div class="account-identity" id="account-identity" role="none">${avatar(" avatar-large")}<div role="none">${heading}${line}</div></div>${items ? `<div class="account-menu-items" role="none">${items}</div>` : ""}</div>`;
  }
  function close(focusButton = false) {
    if (!openMenu) return;
    const { menu, button, dispose } = openMenu;
    openMenu = null;
    dispose();
    menu.remove();
    button.setAttribute("aria-expanded", "false");
    if (focusButton && button.isConnected) button.focus();
  }
  function open(button) {
    close();
    onMenuOpen();
    const host = button.closest("[data-account]");
    host.insertAdjacentHTML("beforeend", menuMarkup());
    const menu = host.querySelector(".account-menu");
    const items = () => [...menu.querySelectorAll('[role="menuitem"]')];
    const focusItem = (index) => {
      const list = items();
      list.at(((index % list.length) + list.length) % list.length)?.focus();
    };
    for (const item of items())
      item.onclick = () => {
        const chosen = item.dataset.accountAction;
        // Focus returns to the control; signing out replaces it with Sign
        // in, which then takes the focus over.
        close(true);
        action(chosen);
      };
    menu.onkeydown = (e) => {
      const at = items().indexOf(document.activeElement);
      if (e.key === "ArrowDown") focusItem(at + 1);
      else if (e.key === "ArrowUp") focusItem(at - 1);
      else if (e.key === "Home") focusItem(0);
      else if (e.key === "End") focusItem(-1);
      else if (e.key === "Escape") close(true);
      else if (e.key === "Tab") return close();
      else return;
      e.preventDefault();
    };
    const outside = (e) => {
      if (!host.contains(e.target)) close();
    };
    const away = () => {
      // Focus that leaves the control, as to the canvas, takes the menu away.
      setTimeout(() => {
        if (openMenu?.menu === menu && !host.contains(document.activeElement))
          close();
      });
    };
    document.addEventListener("pointerdown", outside, true);
    host.addEventListener("focusout", away);
    openMenu = {
      menu,
      button,
      focusItem,
      dispose() {
        document.removeEventListener("pointerdown", outside, true);
        host.removeEventListener("focusout", away);
      },
    };
    button.setAttribute("aria-expanded", "true");
    refresh(menu);
  }
  // Draws the account as last read into every header that shows it.
  function bind(root = document) {
    // A menu open while the account's picture arrives stays open.
    const reopen =
      openMenu && root.contains(openMenu.button)
        ? openMenu.button.closest("[data-account]")
        : null;
    close();
    for (const host of root.querySelectorAll("[data-account]")) {
      // The keyboard stays on the control through sign-in, sign-out, and
      // the account's arrival.
      const focused = host.contains(document.activeElement);
      host.innerHTML = markup();
      const control = host.firstElementChild;
      if (focused) control.focus({ preventScroll: true });
      if (control.dataset.accountAction === "sign-in") {
        control.onclick = () => action("sign-in");
        continue;
      }
      control.onclick = () => {
        if (openMenu?.button === control) return close(true);
        // Opening puts the first choice under the keyboard, as a menu button
        // promises; a pointer leaves no visible ring there.
        open(control);
        openMenu?.focusItem(0);
      };
      control.onkeydown = (e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        if (openMenu?.button !== control) open(control);
        openMenu?.focusItem(e.key === "ArrowDown" ? 0 : -1);
      };
    }
    if (reopen?.isConnected) open(reopen.firstElementChild);
    refresh(root);
    onChange();
  }
  return {
    // The container both headers include; its content follows the account.
    markup: () => `<div class="account" data-account>${markup()}</div>`,
    bind,
    close,
    // Reads who is signed in, as on arrival and after signing in or out,
    // and redraws the headers: at once with what is known, then with the
    // account's name when Puter answers.
    async refresh() {
      user = null;
      picture = null;
      loading = null;
      const p = puter();
      if (!signedIn() || !p.auth.getUser) return bind();
      const attempt = (loading = Promise.all([
        p.auth.getUser(),
        // The picture is optional: without one, the avatar shows the
        // account's initial.
        Promise.resolve()
          .then(() => p.auth.getProfilePicture?.())
          .catch(() => null),
      ])
        .then(([result, image]) => {
          if (attempt !== loading || !signedIn()) return;
          user = result || null;
          picture = validPicture(image);
        })
        .catch(() => {}));
      bind();
      await attempt;
      if (attempt !== loading) return;
      loading = null;
      bind();
    },
    user: () => user,
    name,
  };
}
