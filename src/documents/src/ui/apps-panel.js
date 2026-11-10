/**
 * The Apps launcher: a 3×3 grid button just left of the account button that opens a panel showing the person's
 * Puter apps (puter.com/embed/apps) in an iframe, under a caret pointing at the button. Offered on the web only:
 * inside a Puter app window the desktop already has its own launcher.
 *
 * The panel lives on <body>, so the home screen and the editor share it and a view change can't tear it down.
 * It is built on first open and then only hidden, so reopening keeps the embed's scroll and search; signing in
 * or out discards it, so the next open loads the embed for the new account.
 */

import { el } from './dom.js';
import { icon } from './icons.js';
import { closeMenu } from './menu.js';
import { isDark, onThemeChange } from './theme.js';
import { session } from '../lib/session.js';
import * as P from '../lib/puter.js';
import { hasUserMenu } from './user-menu.js';

export const APPS_EMBED_URL = 'https://puter.com/embed/apps';
export const APPS_NEWTAB_URL = 'https://puter.com/#apps';

// The classic "more apps" grid of nine dots.
const GRID_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="5" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/></svg>';

let panel = null;
let frame = null;
let trigger = null; // the button the open panel hangs from
let isOpen = false;
let builtFor = null; // the account the embed was loaded under
let listening = false;

const accountKey = () => session.accountId || '';

/** The title bar button, or null inside a Puter app window and where <puter-user-menu> has its own. */
export function appsButton() {
  if (P.isApp() || hasUserMenu()) return null;
  return el('button.icon-btn.apps-btn', {
    type: 'button', html: GRID_SVG, title: 'Apps', 'aria-label': 'Apps',
    'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    onclick: (e) => {
      e.preventDefault();
      if (isOpen && trigger === e.currentTarget) closeAppsPanel();
      else openAppsPanel(e.currentTarget);
    },
  });
}

export function isAppsPanelOpen() {
  return isOpen;
}

export function openAppsPanel(button) {
  if (!button) return;
  // The account menu hangs from the same corner: never both at once.
  closeMenu();
  if (panel && (builtFor !== accountKey() || !panel.isConnected)) discard();
  if (!panel) build();
  listen();
  if (trigger && trigger !== button) trigger.setAttribute('aria-expanded', 'false');
  trigger = button;
  isOpen = true;
  trigger.setAttribute('aria-expanded', 'true');
  syncTheme();
  panel.hidden = false;
  position();
  // Focus the dialog itself, so Escape works and Tab reaches the header and the embed.
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
  const close = el('button.icon-btn.apps-panel-action.apps-panel-close', {
    type: 'button', html: icon('x', 16, 2), title: 'Close', 'aria-label': 'Close',
    onclick: () => closeAppsPanel({ focus: true }),
  });
  const newTab = el('a.icon-btn.apps-panel-action.apps-panel-newtab', {
    href: APPS_NEWTAB_URL, target: '_blank', rel: 'noopener noreferrer', html: icon('external', 16, 2),
    title: 'Open in new tab', 'aria-label': 'Open apps in a new tab',
  });
  frame = el('iframe.apps-frame', {
    title: 'Your Puter apps', referrerpolicy: 'strict-origin-when-cross-origin', allow: 'clipboard-read; clipboard-write',
  });
  const body = el('div.apps-panel-body.is-loading', {},
    el('div.apps-panel-loading', { role: 'status', 'aria-label': 'Loading apps' },
      el('span.spin', { html: icon('spinner', 22, 2), 'aria-hidden': 'true' })),
    frame);
  panel = el('div.apps-panel', { role: 'dialog', 'aria-label': 'Apps', tabindex: '-1', hidden: true },
    el('div.apps-panel-header', {},
      el('span.apps-panel-title', {}, 'Apps'),
      el('div.apps-panel-actions', {}, newTab, close)),
    body);
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeAppsPanel({ focus: true });
  });
  // Bound before src is set, so a fast (cached) load can't slip past.
  frame.addEventListener('load', () => body.classList.remove('is-loading'), { once: true });
  syncTheme();
  frame.src = APPS_EMBED_URL;
  builtFor = accountKey();
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
  // The button went with its view, or a narrow layout hid it: nothing to hang from, so the panel closes.
  if (!trigger?.isConnected || !trigger.getClientRects().length) { closeAppsPanel(); return; }
  const btn = trigger.getBoundingClientRect();
  // 10px below the button, so the 8px caret clears it by 2px.
  panel.style.setProperty('--apps-panel-top', `${Math.round(btn.bottom + 10)}px`);
  const box = panel.getBoundingClientRect();
  if (!box.width || !btn.width) { panel.classList.add('caret-hidden'); return; }
  // Kept clear of the panel's rounded corners.
  const x = Math.min(box.width - 20, Math.max(20, btn.left + btn.width / 2 - box.left));
  panel.classList.remove('caret-hidden');
  panel.style.setProperty('--apps-caret-x', `${x.toFixed(1)}px`);
}

// The embed styles itself from prefers-color-scheme, which inside an iframe follows the frame element's
// color-scheme: pinned to the app's theme, it matches an explicit Light or Dark choice and not only the OS.
function syncTheme() {
  if (frame) frame.style.colorScheme = isDark() ? 'dark' : 'light';
}

function listen() {
  if (listening) return;
  listening = true;
  // A press anywhere else closes it. A press inside the embed never reaches this document, so using it keeps
  // the panel open; the button toggles it itself.
  document.addEventListener('pointerdown', (e) => {
    if (!isOpen) return;
    if (panel?.contains(e.target) || e.target.closest?.('.apps-btn')) return;
    closeAppsPanel();
  }, true);
  window.addEventListener('resize', position);
  // Moving between the home screen and a document replaces the button.
  window.addEventListener('hashchange', () => closeAppsPanel());
  // Signing in or out changes whose apps the embed shows.
  session.addEventListener('change', () => {
    if (panel && builtFor !== accountKey()) discard();
  });
  onThemeChange(syncTheme);
}
