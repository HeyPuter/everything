// The Apps launcher: a 3×3 grid button just left of the account button that
// opens a panel showing the person's Puter apps (puter.com/embed/apps) under a
// caret pointing at the button. Left out inside a Puter app window, where the
// desktop has its own launcher.
//
// The panel lives on <body>, built on first open and then only hidden, so
// reopening keeps the embed's scroll and search. Signing in or out discards
// it, so the next open loads the embed for the new account.

import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import { closeMenus } from '../ui/menu';
import { attachTooltip } from '../ui/overlay';
import { env, isSignedIn } from '../platform/puter';
import { resolvedTheme } from '../platform/theme';

export const APPS_EMBED_URL = 'https://puter.com/embed/apps';
export const APPS_NEWTAB_URL = 'https://puter.com/#apps';

let panel: HTMLElement | null = null;
let frame: HTMLIFrameElement | null = null;
let trigger: HTMLButtonElement | null = null;
let isOpen = false;
let builtFor: string | null = null;
let listening = false;

const accountKey = () => (isSignedIn() ? 'in' : 'out');

// Puter opens app windows with this in the URL, so the button can stay hidden
// before the SDK has loaded; puter.env decides once it has.
function inPuterApp() {
  if (env() !== 'none') return env() === 'app';
  try {
    return new URLSearchParams(location.search).has('puter.app_instance_id');
  } catch {
    return false;
  }
}

/** The title bar button. Hidden inside a Puter app window (see syncAppsLauncher). */
export function appsButton(): HTMLButtonElement {
  const b = h('button', {
    class: 'icon-btn apps-btn', type: 'button', 'aria-label': 'Apps', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
  }, icon('apps', 18));
  b.hidden = inPuterApp();
  attachTooltip(b, 'Apps');
  b.addEventListener('click', () => {
    if (isOpen && trigger === b) closeAppsPanel();
    else openAppsPanel(b);
  });
  return b;
}

/** After the SDK loads and after signing in or out: shows or hides the button, and drops an embed loaded for another account. */
export function syncAppsLauncher(button: HTMLButtonElement) {
  button.hidden = inPuterApp();
  if (button.hidden && trigger === button) closeAppsPanel();
  if (panel && builtFor !== accountKey()) discard();
}

export function isAppsPanelOpen() {
  return isOpen;
}

export function openAppsPanel(button: HTMLButtonElement) {
  // The account menu hangs from the same corner: never both at once.
  closeMenus();
  if (panel && (builtFor !== accountKey() || !panel.isConnected)) discard();
  if (!panel) build();
  listen();
  if (trigger && trigger !== button) trigger.setAttribute('aria-expanded', 'false');
  trigger = button;
  isOpen = true;
  button.setAttribute('aria-expanded', 'true');
  syncTheme();
  panel!.hidden = false;
  position();
  // The dialog itself takes focus, so Escape works and Tab reaches the header and the embed.
  if (isOpen) panel!.focus({ preventScroll: true });
}

/** `focus` hands focus back to the button (✕ and Escape), which would otherwise fall to <body>. */
export function closeAppsPanel({ focus = false } = {}) {
  if (!isOpen) return;
  isOpen = false;
  if (panel) panel.hidden = true;
  trigger?.setAttribute('aria-expanded', 'false');
  if (focus && trigger?.isConnected) trigger.focus();
}

function build() {
  const close = h('button', { class: 'icon-btn apps-panel-action apps-panel-close', type: 'button', 'aria-label': 'Close' }, icon('close', 16));
  close.addEventListener('click', () => closeAppsPanel({ focus: true }));
  attachTooltip(close, 'Close');
  const newTab = h('a', {
    class: 'icon-btn apps-panel-action apps-panel-newtab', href: APPS_NEWTAB_URL, target: '_blank', rel: 'noopener noreferrer',
    'aria-label': 'Open Apps in a new tab',
  }, icon('external', 16));
  attachTooltip(newTab, 'Open in new tab');
  const f = h('iframe', {
    class: 'apps-frame', title: 'Your Puter apps', referrerpolicy: 'strict-origin-when-cross-origin', allow: 'clipboard-read; clipboard-write',
  });
  const body = h('div', { class: 'apps-panel-body is-loading' },
    h('div', { class: 'apps-panel-loading', role: 'status', 'aria-label': 'Loading your apps' }, h('span', { class: 'spinner', 'aria-hidden': 'true' })),
    f);
  const p = h('div', { class: 'apps-panel', role: 'dialog', 'aria-label': 'Apps', tabindex: '-1', hidden: true },
    h('div', { class: 'apps-panel-header' },
      h('span', { class: 'apps-panel-title' }, 'Apps'),
      h('div', { class: 'apps-panel-actions' }, newTab, close)),
    body);
  p.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeAppsPanel({ focus: true });
  });
  // Bound before src is set, so a fast (cached) load can't slip past.
  f.addEventListener('load', () => body.classList.remove('is-loading'), { once: true });
  panel = p;
  frame = f;
  syncTheme();
  f.src = APPS_EMBED_URL;
  builtFor = accountKey();
  document.body.append(p);
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
  // The button is gone or hidden: nothing to hang from, so the panel closes.
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

// Inside an iframe prefers-color-scheme follows the frame element's
// color-scheme: pinned to the app's theme, the embed matches an explicit
// Light or Dark choice and not only the OS.
function syncTheme() {
  if (!frame) return;
  const resolved = document.documentElement.dataset.themeResolved;
  frame.style.colorScheme = (resolved === 'dark' || resolved === 'light' ? resolved : resolvedTheme());
}

function listen() {
  if (listening) return;
  listening = true;
  // A press anywhere else closes it; only closes, so the press still reaches
  // the viewport or control under it. Presses inside the embed never reach
  // this document; the button toggles the panel itself.
  document.addEventListener('pointerdown', (e) => {
    if (!isOpen) return;
    const t = e.target as Node | null;
    if (panel?.contains(t) || trigger?.contains(t)) return;
    closeAppsPanel();
  }, true);
  window.addEventListener('resize', position);
  window.addEventListener('themechange', syncTheme);
}
