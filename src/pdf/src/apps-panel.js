/**
 * The Apps launcher: a 3×3 grid button just left of Settings that opens a panel showing the
 * person's Puter apps (puter.com/embed/apps) in an iframe, under a caret pointing at the button.
 * Left out in a Puter desktop window, which has its own launcher, and where puter.js has
 * <puter-user-menu>, which has its own Apps button (user-menu.js). A tab Puter opened from the
 * dashboard is a plain browser tab with no launcher, so it keeps the button.
 *
 * The panel lives on <body>, so the library and the editor share it and a view change cannot
 * tear it down. It is built on first open and then only hidden, so reopening keeps the embed's
 * scroll and search; a different account discards it, so the next open loads the embed for
 * that account.
 */
import './apps-panel.css';
import { el, icon, iconButton } from './lib/ui.js';
import { closeMenu } from './lib/menu.js';
import * as P from './lib/puter.js';
import { hasUserMenu } from './user-menu.js';

export const APPS_EMBED_URL = 'https://puter.com/embed/apps';
export const APPS_NEWTAB_URL = 'https://puter.com/#apps';

let panel = null;
let frame = null;
let trigger = null; // the button the open panel hangs from
let isOpen = false;
let account = ''; // the signed-in account, as a key
let builtFor = null; // the account the embed was loaded under
let listening = false;

/** The nine dots, filled, as the "more apps" button is drawn elsewhere. */
function gridIcon(size = 18) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [key, value] of Object.entries({
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'currentColor',
    'aria-hidden': 'true',
    focusable: 'false',
  }))
    svg.setAttribute(key, String(value));
  for (const cy of [5, 12, 19])
    for (const cx of [5, 12, 19]) {
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', cy);
      dot.setAttribute('r', 2);
      svg.append(dot);
    }
  return svg;
}

/**
 * Whether the desktop owns the launcher. The SDK loads after the first render; until then a
 * framed window with Puter's launch address is taken for a desktop window, so the button does
 * not flash there.
 */
function onDesktop() {
  if (P.isApp()) return true;
  if (globalThis.puter) return false;
  try {
    return (
      window.parent !== window && new URLSearchParams(location.search).has('puter.app_instance_id')
    );
  } catch {
    return false;
  }
}

/** Whether the button stands down: on the Puter desktop, and for <puter-user-menu>'s own. */
const standsDown = () => onDesktop() || hasUserMenu();

/** The title bar button. Hidden where it stands down; refreshAppsButtons() follows the SDK. */
export function appsButton() {
  const button = iconButton('Apps', gridIcon(), (e) => {
    e.preventDefault();
    if (isOpen && trigger === e.currentTarget) closeAppsPanel();
    else openAppsPanel(e.currentTarget);
  });
  button.classList.add('apps-btn');
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.hidden = standsDown();
  return button;
}

/** Once the SDK has loaded: show or hide the buttons for the environment it reports. */
export function refreshAppsButtons() {
  const hide = standsDown();
  for (const button of document.querySelectorAll('.apps-btn')) button.hidden = hide;
  if (hide) closeAppsPanel();
}

/** The signed-in account changed: the embed shows whose apps, so it reloads on the next open. */
export function setAppsAccount(user) {
  account = user ? user.uuid || user.username || '' : '';
  if (panel && builtFor !== account) discard();
}

export const isAppsPanelOpen = () => isOpen;

export function openAppsPanel(button) {
  if (!button) return;
  // Menus hang from the same title bar: never both at once.
  closeMenu();
  if (panel && (builtFor !== account || !panel.isConnected)) discard();
  if (!panel) build();
  listen();
  if (trigger && trigger !== button) trigger.setAttribute('aria-expanded', 'false');
  trigger = button;
  isOpen = true;
  trigger.setAttribute('aria-expanded', 'true');
  syncTheme();
  panel.hidden = false;
  position();
  // The dialog itself takes the focus, so Escape works and Tab reaches the header and the embed.
  if (isOpen) panel.focus({ preventScroll: true });
}

/** `focus` hands focus back to the button, for ✕ and Escape: it would otherwise fall to <body>. */
export function closeAppsPanel({ focus = false } = {}) {
  if (!isOpen) return;
  isOpen = false;
  if (panel) panel.hidden = true;
  trigger?.setAttribute('aria-expanded', 'false');
  if (focus && trigger?.isConnected) trigger.focus();
}

function build() {
  const close = iconButton('Close', 'X', () => closeAppsPanel({ focus: true }), {
    class: 'icon-btn apps-panel-action',
  });
  const newTab = el(
    'a',
    {
      class: 'icon-btn apps-panel-action',
      href: APPS_NEWTAB_URL,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: 'Open in a new tab',
      'aria-label': 'Open your apps in a new tab',
    },
    icon('ExternalLink', 16, { plain: true }),
  );
  frame = el('iframe', {
    class: 'apps-frame',
    title: 'Your Puter apps',
    referrerpolicy: 'strict-origin-when-cross-origin',
    allow: 'clipboard-read; clipboard-write',
  });
  const body = el(
    'div',
    { class: 'apps-panel-body is-loading' },
    el(
      'div',
      { class: 'apps-panel-loading', role: 'status', 'aria-label': 'Loading your apps' },
      el('span', { class: 'apps-panel-spinner', 'aria-hidden': 'true' }),
    ),
    frame,
  );
  panel = el(
    'div',
    { class: 'apps-panel', role: 'dialog', 'aria-label': 'Apps', tabindex: '-1', hidden: true },
    el(
      'div',
      { class: 'apps-panel-header' },
      el('span', { class: 'apps-panel-title' }, 'Apps'),
      el('div', { class: 'apps-panel-actions' }, newTab, close),
    ),
    body,
  );
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeAppsPanel({ focus: true });
  });
  // Bound before src is set, so a fast (cached) load cannot slip past.
  frame.addEventListener('load', () => body.classList.remove('is-loading'), { once: true });
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

/** Under the button, sized to the space below it, the caret on the button's centre. */
function position() {
  if (!isOpen || !panel) return;
  // The button went with its view, or a layout hid it: nothing to hang from, so it closes.
  if (!trigger?.isConnected || !trigger.getClientRects().length) {
    closeAppsPanel();
    return;
  }
  const btn = trigger.getBoundingClientRect();
  // 10px below the button, so the 8px caret clears it by 2px.
  panel.style.setProperty('--apps-panel-top', `${Math.round(btn.bottom + 10)}px`);
  const box = panel.getBoundingClientRect();
  if (!box.width || !btn.width) {
    panel.classList.add('caret-hidden');
    return;
  }
  // Kept clear of the panel's rounded corners.
  const x = Math.min(box.width - 20, Math.max(20, btn.left + btn.width / 2 - box.left));
  panel.classList.remove('caret-hidden');
  panel.style.setProperty('--apps-caret-x', `${x.toFixed(1)}px`);
}

/** The app's own light or dark: an explicit choice, else the system's. */
function isDark() {
  const theme = document.documentElement.dataset.theme;
  if (theme === 'dark' || theme === 'light') return theme === 'dark';
  return !!globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

// The embed styles itself from prefers-color-scheme, which inside an iframe follows the frame
// element's color-scheme: pinned to the app's theme, it matches an explicit Light or Dark choice.
function syncTheme() {
  if (frame) frame.style.colorScheme = isDark() ? 'dark' : 'light';
}

function listen() {
  if (listening) return;
  listening = true;
  // A press anywhere else closes it. A press inside the embed never reaches this document, so
  // using it keeps the panel open; the button toggles it itself.
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!isOpen) return;
      if (panel?.contains(e.target) || e.target.closest?.('.apps-btn')) return;
      closeAppsPanel();
    },
    true,
  );
  window.addEventListener('resize', position);
  // Full screen shows one element alone, which never holds the panel.
  document.addEventListener('fullscreenchange', () => closeAppsPanel());
  // Moving between the library and a PDF replaces the title bar, button and all.
  const app = document.querySelector('#app');
  if (app)
    new MutationObserver(() => {
      if (isOpen && !trigger?.isConnected) closeAppsPanel();
    }).observe(app, { childList: true });
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  globalThis.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', syncTheme);
}
