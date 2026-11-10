// The Apps launcher: a 3×3 grid button just left of the account button that
// opens a panel showing the person's Puter apps (puter.com/embed/apps) in an
// iframe, under a caret pointing at the button. Offered on the web only:
// inside a Puter app window the desktop has its own launcher.
//
// The panel lives on <body>, so the home screen and the editor share it. It is
// built on first open and then only hidden, so reopening keeps the embed's
// scroll and search; a change of account discards it, so the next open loads
// the embed for the new account.
import { el, icon, closeMenu } from "./ui.js";
import { isApp } from "./cloud.js";
import { hasUserMenu } from "./user-menu.js";

export const APPS_EMBED_URL = "https://puter.com/embed/apps";
export const APPS_NEWTAB_URL = "https://puter.com/#apps";

let panel = null;
let frame = null;
let trigger = null; // the button the open panel hangs from
let isOpen = false;
let account = ""; // the account signed in now
let builtFor = null; // the account the embed was loaded under
let listening = false;

// The classic "more apps" grid of nine filled dots.
function gridIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "currentColor",
    "aria-hidden": "true",
    focusable: "false",
  }))
    svg.setAttribute(k, v);
  for (const cy of [5, 12, 19])
    for (const cx of [5, 12, 19]) {
      const dot = document.createElementNS(ns, "circle");
      dot.setAttribute("cx", cx);
      dot.setAttribute("cy", cy);
      dot.setAttribute("r", 2);
      svg.append(dot);
    }
  return svg;
}

/**
 * The header button, or null inside a Puter app window and where puter.js's
 * <puter-user-menu> has its own.
 */
export function appsButton(cls = "") {
  if (isApp() || hasUserMenu()) return null;
  const control = el(
    "button",
    {
      type: "button",
      class: `btn icon-btn apps-btn ${cls}`.trim(),
      title: "Apps",
      "aria-label": "Apps",
      "aria-haspopup": "dialog",
      "aria-expanded": isOpen ? "true" : "false",
      onclick: (e) => {
        e.preventDefault();
        if (isOpen && trigger === e.currentTarget) closeAppsPanel();
        else openAppsPanel(e.currentTarget);
      },
    },
    gridIcon(),
  );
  return control;
}

export const isAppsPanelOpen = () => isOpen;

export function openAppsPanel(button) {
  if (!button) return;
  // The account menu hangs from the same corner: never both at once.
  closeMenu();
  if (panel && (builtFor !== account || !panel.isConnected)) discard();
  if (!panel) build();
  listen();
  if (trigger && trigger !== button)
    trigger.setAttribute("aria-expanded", "false");
  trigger = button;
  isOpen = true;
  trigger.setAttribute("aria-expanded", "true");
  syncTheme();
  panel.hidden = false;
  position();
  // The dialog itself takes focus, so Escape works and Tab reaches the header
  // and the embed.
  if (isOpen) panel.focus({ preventScroll: true });
}

/** `focus` hands focus back to the button, for ✕ and Escape. */
export function closeAppsPanel({ focus = false } = {}) {
  if (!isOpen) return;
  isOpen = false;
  if (panel) panel.hidden = true;
  trigger?.setAttribute("aria-expanded", "false");
  if (focus && trigger?.isConnected) trigger.focus();
}

/** Signing in or out changes whose apps the embed shows. */
export function setAppsPanelAccount(key) {
  account = key || "";
  if (panel && builtFor !== account) discard();
}

function build() {
  const close = el(
    "button",
    {
      type: "button",
      class: "btn icon-btn apps-panel-action apps-panel-close",
      title: "Close",
      "aria-label": "Close",
      onclick: () => closeAppsPanel({ focus: true }),
    },
    icon("X", 16),
  );
  const newTab = el(
    "a",
    {
      class: "btn icon-btn apps-panel-action apps-panel-newtab",
      href: APPS_NEWTAB_URL,
      target: "_blank",
      rel: "noopener noreferrer",
      title: "Open in a new tab",
      "aria-label": "Open Puter apps in a new tab",
    },
    icon("ExternalLink", 16),
  );
  frame = el("iframe", {
    class: "apps-frame",
    title: "Your Puter apps",
    referrerpolicy: "strict-origin-when-cross-origin",
    allow: "clipboard-read; clipboard-write",
  });
  const body = el(
    "div",
    { class: "apps-panel-body is-loading" },
    el(
      "div",
      { class: "apps-panel-loading", role: "status", "aria-label": "Loading" },
      el(
        "span",
        { class: "apps-panel-spinner", "aria-hidden": "true" },
        icon("LoaderCircle", 22),
      ),
    ),
    frame,
  );
  panel = el(
    "div",
    {
      class: "apps-panel",
      role: "dialog",
      "aria-label": "Apps",
      tabindex: -1,
      hidden: true,
    },
    el(
      "div",
      { class: "apps-panel-header" },
      el("span", { class: "apps-panel-title" }, "Apps"),
      el("div", { class: "apps-panel-actions" }, newTab, close),
    ),
    body,
  );
  panel.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    closeAppsPanel({ focus: true });
  });
  // Bound before src is set, so a fast (cached) load can't slip past.
  frame.addEventListener("load", () => body.classList.remove("is-loading"), {
    once: true,
  });
  syncTheme();
  frame.src = APPS_EMBED_URL;
  builtFor = account;
  document.body.append(panel);
}

function discard() {
  closeAppsPanel();
  panel?.remove();
  panel = frame = null;
  builtFor = null;
}

/** Under the button, sized to the space below it, the caret on its centre. */
function position() {
  if (!isOpen || !panel) return;
  // The button went with its view, or a narrow layout hid it: nothing to hang
  // from, so the panel closes.
  if (!trigger?.isConnected || !trigger.getClientRects().length) {
    closeAppsPanel();
    return;
  }
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

const darkScheme =
  typeof matchMedia === "function"
    ? matchMedia("(prefers-color-scheme: dark)")
    : null;
/** The app's light or dark look: its Appearance choice, or the device's. */
export function effectiveScheme() {
  const theme = document.documentElement.dataset.theme;
  if (theme === "dark" || theme === "light") return theme;
  return darkScheme?.matches ? "dark" : "light";
}
// The embed styles itself from prefers-color-scheme, which inside an iframe
// follows the frame element's color-scheme: pinned to the app's look, it
// matches an explicit Light or Dark choice and not only the device's.
function syncTheme() {
  if (frame) frame.style.colorScheme = effectiveScheme();
}

function listen() {
  if (listening) return;
  listening = true;
  // A press anywhere else closes it. A press inside the embed never reaches
  // this document; the button toggles the panel itself.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!isOpen) return;
      if (panel?.contains(e.target) || e.target.closest?.(".apps-btn")) return;
      closeAppsPanel();
    },
    true,
  );
  window.addEventListener("resize", position);
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  darkScheme?.addEventListener?.("change", syncTheme);
}
