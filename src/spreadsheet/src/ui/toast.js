import { el, isComposing } from './dom.js';
import { icon } from './icons.js';
import { isMenuOpen } from './menu.js';
import { t } from '../i18n/index.js';

let root = null;

/* One live region for the whole app, created before anything posts to it so
   screen readers announce changes to it rather than missing a region that
   arrives already filled. */
function ensureRoot() {
  if (!root) {
    root = el('div.toast-root', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' });
    document.body.append(root);
  }
  return root;
}

/* Escape takes the newest toast away when nothing else claims the key: an open menu, dialog or palette
   answers its own Escape (and stops it before it gets here), and a key the sheet has used, to cancel an
   edit or collapse a selection, is left at that. The handler sits in the bubbling phase for that reason.
   With the focus in a toast, that toast is the one it takes. */
function onKey(e) {
  if (e.key !== 'Escape' || e.defaultPrevented || isComposing(e) || isMenuOpen()) return;
  if (document.querySelector('.modal-root:not(.closing), .palette-root')) return;
  const shown = [...(root?.querySelectorAll('.toast:not(.leaving)') ?? [])];
  (shown.find((node) => node.contains(document.activeElement)) ?? shown.at(-1))?._dismiss?.();
}

if (typeof document !== 'undefined') {
  if (document.body) ensureRoot();
  else document.addEventListener('DOMContentLoaded', ensureRoot, { once: true });
  document.addEventListener('keydown', onKey);
}

/**
 * toast('Saved')
 * toast('Deleted', { icon: 'trash', action: { label: 'Undo', onClick } })
 */
export function toast(message, { icon: name = 'check', duration, action = null } = {}) {
  // A longer message stays longer: about 45 ms a character over a 1.2 s base, never less than the 2.6 s a
  // short one has had (6 s when there is an action to take) and never more than 7 s.
  const ms = duration ?? Math.min(7000, Math.max(action ? 6000 : 2600, 1200 + 45 * (typeof message === 'string' ? message.length : 0)));
  let timer = null;
  let gone = false;
  // Where the focus was before it came into the toast: a toast that goes while holding it hands it back
  // there, instead of dropping it to the page where the arrow keys no longer reach the sheet.
  let cameFrom = null;

  const dismiss = () => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    if (node.contains(document.activeElement) && cameFrom?.isConnected && !cameFrom.closest('[inert]')) cameFrom.focus({ preventScroll: true });
    node.classList.add('leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 400);
  };

  const node = el('div.toast', { html: icon(name, 16, 2.2) },
    el('span', {}, message),
    action && el('button.toast-action', { type: 'button', onclick: () => { dismiss(); action.onClick(); } }, action.label),
    // A toast with an action stays six seconds or more; a close button lets it go sooner. A plain notice is
    // brief and Escape takes it away.
    action && el('button.toast-close', { type: 'button', 'aria-label': t('toast.dismiss'), title: t('toast.dismiss'), html: icon('x', 14, 2.4), onclick: dismiss }));
  node._dismiss = dismiss;

  // Hovering pauses the countdown; leaving resumes what was left of it (at least a moment to read).
  let due = 0;
  const arm = (ms) => { clearTimeout(timer); due = Date.now() + ms; timer = setTimeout(dismiss, ms); };
  const hold = () => clearTimeout(timer);
  const release = () => { if (!gone) arm(Math.max(1500, due - Date.now())); };
  node.addEventListener('pointerenter', hold);
  node.addEventListener('pointerleave', release);
  node.addEventListener('focusin', (e) => { if (e.relatedTarget && !node.contains(e.relatedTarget)) cameFrom = e.relatedTarget; hold(); });
  node.addEventListener('focusout', release);

  ensureRoot().append(node);
  arm(ms);
  return { dismiss };
}
