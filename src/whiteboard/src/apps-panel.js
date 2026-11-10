import { addTranslations } from "./i18n.js";

addTranslations({
  Apps: "Applications",
  "Open in new tab": "Ouvrir dans un nouvel onglet",
  "Open apps in a new tab": "Ouvrir les applications dans un nouvel onglet",
  "Your Puter apps": "Vos applications Puter",
  "Loading apps": "Chargement des applications",
});

export const APPS_EMBED_URL = "https://puter.com/embed/apps";
export const APPS_NEWTAB_URL = "https://puter.com/#apps";

// The "more apps" grid of nine dots.
const GRID_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="5" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/></svg>';

// The Apps launcher: a grid button just left of the account control that
// opens a panel showing the person's Puter apps (puter.com/embed/apps).
// Left out inside Puter's desktop, which has its own launcher.
//
// The panel lives on <body>, built on first open and then only hidden, so
// reopening keeps the embed's state. Signing in or out discards it, so the
// next open loads the embed for the new account.
export function createAppsPanel({
  puter = () => window.puter,
  icon,
  refresh = () => {},
  closeAccountMenu = () => {},
  accountKey = () => "",
}) {
  let panel = null,
    frame = null,
    trigger = null,
    open = false,
    builtFor = null,
    listening = false;
  const available = () => puter()?.env !== "app";

  // An account still loading its name matches any signed-in account.
  const PENDING = "pending";
  const sameAccount = (a, b) =>
    a === b || (!!a && !!b && (a === PENDING || b === PENDING));

  function markup() {
    if (!available()) return "";
    return `<button type="button" class="icon-btn apps-button" data-apps aria-label="Apps" title="Apps" aria-haspopup="dialog" aria-expanded="false">${GRID_SVG}</button>`;
  }

  // Wires the buttons a render just drew. A render that took the open
  // panel's button away, as a change of view does, closes it.
  function bind(root = document) {
    for (const button of root.querySelectorAll("[data-apps]"))
      button.onclick = (e) => {
        e.preventDefault();
        if (open && trigger === button) close();
        else show(button);
      };
    if (open && !trigger?.isConnected) close();
  }

  function show(button) {
    if (!button) return;
    // The account menu hangs from the same corner: never both at once.
    closeAccountMenu();
    if (panel && (!sameAccount(builtFor, accountKey()) || !panel.isConnected))
      discard();
    if (!panel) build();
    listen();
    if (trigger && trigger !== button)
      trigger.setAttribute("aria-expanded", "false");
    trigger = button;
    open = true;
    trigger.setAttribute("aria-expanded", "true");
    syncTheme();
    panel.hidden = false;
    position();
    // The dialog itself takes focus, so Escape works and Tab reaches the
    // header and the embed.
    if (open) panel.focus({ preventScroll: true });
  }

  // `focus` hands focus back to the button, for ✕ and Escape.
  function close({ focus = false } = {}) {
    if (!open) return;
    open = false;
    if (panel) panel.hidden = true;
    trigger?.setAttribute("aria-expanded", "false");
    if (focus && trigger?.isConnected) trigger.focus();
  }

  function build() {
    panel = document.createElement("div");
    panel.className = "apps-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Apps");
    panel.tabIndex = -1;
    panel.hidden = true;
    panel.innerHTML = `<div class="apps-panel-header"><span class="apps-panel-title">Apps</span><div class="apps-panel-actions"><a class="icon-btn apps-panel-action apps-panel-newtab" href="${APPS_NEWTAB_URL}" target="_blank" rel="noopener noreferrer" title="Open in new tab" aria-label="Open apps in a new tab">${icon("external-link")}</a><button type="button" class="icon-btn apps-panel-action apps-panel-close" title="Close" aria-label="Close">${icon("x")}</button></div></div><div class="apps-panel-body is-loading"><div class="apps-panel-loading" role="status" aria-label="Loading apps"><span class="spinner" aria-hidden="true"></span></div></div>`;
    frame = document.createElement("iframe");
    frame.className = "apps-frame";
    frame.title = "Your Puter apps";
    frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    frame.setAttribute("allow", "clipboard-read; clipboard-write");
    const body = panel.querySelector(".apps-panel-body");
    body.append(frame);
    panel.querySelector(".apps-panel-close").onclick = () =>
      close({ focus: true });
    // Keys typed in the panel are its own: board shortcuts never see them.
    panel.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key !== "Escape") return;
      e.preventDefault();
      close({ focus: true });
    });
    // Bound before src is set, so a fast (cached) load can't slip past.
    frame.addEventListener("load", () => body.classList.remove("is-loading"), {
      once: true,
    });
    syncTheme();
    frame.src = APPS_EMBED_URL;
    builtFor = accountKey();
    document.body.append(panel);
    refresh(panel);
  }

  function discard() {
    close();
    panel?.remove();
    panel = frame = null;
    builtFor = null;
  }

  // Under the button, sized to the space below it, the caret on the
  // button's centre.
  function position() {
    if (!open || !panel) return;
    // The button went with its view, or a narrow layout hid it.
    if (!trigger?.isConnected || !trigger.getClientRects().length)
      return close();
    const btn = trigger.getBoundingClientRect();
    // 10px below the button, so the 8px caret clears it by 2px.
    panel.style.setProperty(
      "--apps-panel-top",
      `${Math.round(btn.bottom + 10)}px`,
    );
    const box = panel.getBoundingClientRect();
    if (!box.width || !btn.width) {
      panel.classList.add("caret-hidden");
      return;
    }
    // Kept clear of the panel's rounded corners.
    const x = Math.min(
      box.width - 20,
      Math.max(20, btn.left + btn.width / 2 - box.left),
    );
    panel.classList.remove("caret-hidden");
    panel.style.setProperty("--apps-caret-x", `${x.toFixed(1)}px`);
  }

  // Inside an iframe, prefers-color-scheme follows the frame element's
  // color-scheme: pinned to the app's theme, the embed matches an explicit
  // Light or Dark choice and not only the system's.
  function syncTheme() {
    if (frame)
      frame.style.colorScheme =
        document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  }

  // After the account changes: another account's embed is dropped.
  function syncAccount() {
    if (!panel) return;
    const key = accountKey();
    if (!sameAccount(builtFor, key)) discard();
    else if (builtFor === PENDING) builtFor = key;
  }

  function listen() {
    if (listening) return;
    listening = true;
    // A press anywhere else only closes the panel; the board still gets the
    // press. One inside the embed never reaches this document.
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!open) return;
        if (panel?.contains(e.target) || e.target.closest?.("[data-apps]"))
          return;
        close();
      },
      true,
    );
    window.addEventListener("resize", position);
    new MutationObserver(syncTheme).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }

  return {
    markup,
    bind,
    open: show,
    close,
    isOpen: () => open,
    syncAccount,
    PENDING,
  };
}
