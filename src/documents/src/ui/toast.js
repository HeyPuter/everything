import { el } from './dom.js';
import { icon } from './icons.js';

let root = null;

/* One live region for the whole app, created before anything posts to it so
   screen readers announce changes to it rather than missing a region that
   arrives already filled. */
function ensureRoot() {
  if (!root) root = el('div.toast-root', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' });
  // Whatever replaced the page's children took the region with it; a toast must still land on the page.
  if (!root.isConnected) document.body.append(root);
  return root;
}

if (typeof document !== 'undefined') {
  if (document.body) ensureRoot();
  else document.addEventListener('DOMContentLoaded', ensureRoot, { once: true });
}

/**
 * Say something to screen readers without showing it: the text joins the live
 * region for a few seconds. For a state a visible element already shows, such as
 * the offline banner, which arrives on the page already worded and so is not read.
 */
export function announce(message) {
  const node = el('span.visually-hidden', {}, message);
  ensureRoot().append(node);
  setTimeout(() => node.remove(), 5000);
  return node;
}

/**
 * toast('Saved')
 * toast('Deleted', { icon: 'trash', action: { label: 'Undo', onClick } })
 * toast('Working…', { duration: Infinity }) stays until dismissed; `update(text)` changes its words.
 */
export function toast(message, { icon: name = 'check', duration, action = null } = {}) {
  const ms = duration ?? (action ? 6000 : 2600);
  let timer = null;
  let gone = false;
  let remaining = ms;
  let deadline = 0;
  let hovered = false;
  let focused = false;

  // Where the keyboard came from when F6 brought it to the notice: it goes back there when the notice goes.
  let cameFrom = null;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    if (node.contains(document.activeElement) && cameFrom?.isConnected) cameFrom.focus({ preventScroll: true });
    node.classList.add('leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 400);
  };

  const label = el('span', {}, message);
  const node = el('div.toast', { html: icon(name, 16, 2.2) },
    label,
    action && el('button.toast-action', { type: 'button', onclick: () => { dismiss(); action.onClick(); } }, action.label));

  const arm = (t) => {
    clearTimeout(timer);
    remaining = t;
    // A notice of work in progress has no time limit: it goes when the work does.
    if (!Number.isFinite(t)) { timer = null; return; }
    deadline = Date.now() + t;
    timer = setTimeout(dismiss, t);
  };
  const hold = () => {
    if (timer === null) return;
    remaining = Math.max(0, deadline - Date.now());
    clearTimeout(timer);
    timer = null;
  };
  const release = () => {
    // Pointer and keyboard interaction overlap. Resume only after both end,
    // preserving long-running notices and allowing a short reading grace period.
    if (!gone && !hovered && !focused) arm(Math.max(remaining, 1500));
  };
  node.addEventListener('pointerenter', () => { hovered = true; hold(); });
  node.addEventListener('pointerleave', () => { hovered = false; release(); });
  node.addEventListener('focusin', (e) => { if (e.relatedTarget && !node.contains(e.relatedTarget)) cameFrom = e.relatedTarget; focused = true; hold(); });
  node.addEventListener('focusout', (e) => {
    focused = node.contains(e.relatedTarget);
    if (!focused) release();
  });

  ensureRoot().append(node);
  arm(ms);
  return { dismiss, update: (text) => { if (!gone) label.textContent = text; } };
}
