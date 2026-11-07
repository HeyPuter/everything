import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { closeAllMenus } from './menu.js';
import { resolvedTheme, onThemeChange } from './prefs.js';

/*
 * The Apps launcher: a 3×3 grid button at the right of the title bar that
 * opens a panel showing the person's Puter apps (puter.com/embed/apps) in an
 * iframe, under a caret pointing at the button. Web only: inside a Puter app
 * window the desktop has its own launcher.
 *
 * The panel lives on <body>. It is built on first open and then only hidden,
 * so reopening keeps the embed's scroll and search. Signing in or out reloads
 * the page, which loads the embed afresh for the new account.
 */

export const APPS_EMBED_URL = 'https://puter.com/embed/apps';
export const APPS_NEWTAB_URL = 'https://puter.com/#apps';

// Nine dots, filled, like the usual "more apps" grid.
const GRID_SVG = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="5" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/></svg>';

let panel = null;
let frame = null;
let trigger = null;
let isOpen = false;
let disposers = [];

/** The title bar button, or null inside a Puter app window. */
export function appsButton({ env = 'web' } = {}) {
  if (env === 'app') return null;
  return h('button.icon-btn.apps-btn', {
    type: 'button',
    html: GRID_SVG,
    'aria-label': 'Apps',
    'data-tip': 'Apps',
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
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
  // The account menu opens from the same corner on phones: never both at once.
  closeAllMenus();
  if (panel && !panel.isConnected) discard();
  if (!panel) build();
  listen();
  if (trigger && trigger !== button) trigger.setAttribute('aria-expanded', 'false');
  trigger = button;
  isOpen = true;
  trigger.setAttribute('aria-expanded', 'true');
  syncTheme();
  panel.hidden = false;
  position();
  if (isOpen) panel.focus({ preventScroll: true });
}

/** `focus` hands focus back to the button (for ✕ and Escape). */
export function closeAppsPanel({ focus = false } = {}) {
  if (!isOpen) return;
  isOpen = false;
  if (panel) panel.hidden = true;
  trigger?.setAttribute('aria-expanded', 'false');
  if (focus && trigger?.isConnected) trigger.focus();
}

/** Removes the panel and its listeners (when the app is torn down, as in tests). */
export function destroyAppsPanel() {
  discard();
  for (const d of disposers) d();
  disposers = [];
  trigger = null;
}

function build() {
  const close = h('button.icon-btn.apps-panel-action.apps-panel-close', {
    type: 'button', 'aria-label': 'Close', 'data-tip': 'Close', onclick: () => closeAppsPanel({ focus: true }),
  }, icon('x', 16));
  const newTab = h('a.icon-btn.apps-panel-action.apps-panel-newtab', {
    href: APPS_NEWTAB_URL, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open apps in a new tab', 'data-tip': 'Open in new tab',
  }, icon('external', 16));
  frame = h('iframe.apps-frame', {
    title: 'Your Puter apps', referrerpolicy: 'strict-origin-when-cross-origin', allow: 'clipboard-read; clipboard-write',
  });
  const body = h('div.apps-panel-body.is-loading',
    h('div.apps-panel-loading', { role: 'status', 'aria-label': 'Loading apps' }, h('div.spinner')),
    frame,
  );
  panel = h('div.apps-panel', { role: 'dialog', 'aria-label': 'Apps', tabindex: '-1', hidden: true },
    h('div.apps-panel-header', h('span.apps-panel-title', 'Apps'), h('div.apps-panel-actions', newTab, close)),
    body,
  );
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeAppsPanel({ focus: true });
  });
  // Bound before src is set, so a fast (cached) load is not missed.
  frame.addEventListener('load', () => body.classList.remove('is-loading'), { once: true });
  syncTheme();
  frame.src = APPS_EMBED_URL;
  document.body.append(panel);
}

function discard() {
  closeAppsPanel();
  panel?.remove();
  panel = frame = null;
}

/** Under the button, sized to the space below it, the caret on the button's centre. */
function position() {
  if (!isOpen || !panel) return;
  // The button went away or a layout hid it: nothing to hang from.
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

// The embed follows prefers-color-scheme, which inside an iframe comes from
// the frame element's color-scheme: pinned to the app's theme, it matches an
// explicit Light or Dark choice and not only the system's.
function syncTheme() {
  if (frame) frame.style.colorScheme = resolvedTheme();
}

function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  disposers.push(() => target.removeEventListener(type, fn, opts));
}

function listen() {
  if (disposers.length) return;
  // A press anywhere else closes it. Presses inside the embed never reach
  // this document; the button toggles the panel itself.
  on(document, 'pointerdown', (e) => {
    if (!isOpen) return;
    if (panel?.contains(e.target) || e.target.closest?.('.apps-btn')) return;
    closeAppsPanel();
  }, true);
  on(window, 'resize', position);
  disposers.push(onThemeChange(syncTheme));
}
