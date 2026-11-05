/** Lightweight, self-dismissing toasts with an optional action (e.g. Undo). */
import { el } from './dom.js';
import { icon } from './icons.js';

let container = null;

function ensureContainer() {
  // A container something replaced out from under us (a full-screen
  // re-render, a test resetting the body) is gone along with whatever it
  // held: start a fresh one rather than append to a node nobody sees.
  if (!container || !container.isConnected) {
    container = el('div', { class: 'toaster', role: 'status', 'aria-live': 'polite' });
    document.body.append(container);
  }
  return container;
}

/**
 * @param {string} message
 * @param {{ variant?: 'default'|'danger'|'success', duration?: number,
 *           action?: { label: string, onClick: () => void },
 *           onClose?: () => void }} [opts]
 * `duration: Infinity` keeps it up until acted on; `onClose` adds a close
 * button and runs when it's pressed.
 */
export function toast(message, opts = {}) {
  const { variant = 'default', action, onClose } = opts;
  // Four seconds reads a confirmation. It does not notice a button, move to
  // it and press it — and for a keyboard user the toaster is last in tab
  // order — so a toast that offers something to do (Undo, after every
  // destructive action here) stays twice as long, and any toast waits while
  // the pointer or focus is on it.
  const duration = opts.duration ?? (action ? 8000 : 4000);
  const root = ensureContainer();

  const leadIcon =
    variant === 'success' ? 'check' : variant === 'danger' ? 'close' : null;

  const node = el('div', {
    class: `toast toast--${variant}`,
    // Errors interrupt (assertive); success/info wait their turn (polite).
    role: variant === 'danger' ? 'alert' : 'status',
  }, [
    leadIcon ? el('span', { class: 'toast__icon', html: icon(leadIcon, { size: 'sm' }) }) : null,
    el('span', { class: 'toast__msg', text: message }),
  ]);

  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    node.classList.add('is-leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
  };

  if (action) {
    node.append(
      el('button', {
        class: 'toast__action',
        type: 'button',
        text: action.label,
        on: {
          click: () => {
            dismiss();
            action.onClick();
          },
        },
      }),
    );
  }

  if (onClose) {
    node.append(
      el('button', {
        class: 'toast__close',
        type: 'button',
        'aria-label': 'Dismiss',
        html: icon('close', { size: 'sm' }),
        on: {
          click: () => {
            dismiss();
            onClose();
          },
        },
      }),
    );
  }

  // Hovering or focusing the toast holds it; leaving resumes the clock with
  // what was left (at least a moment, so it never vanishes under the pointer
  // the instant it leaves).
  let remaining = duration;
  let armedAt = 0;
  const arm = () => {
    clearTimeout(timer);
    if (!Number.isFinite(remaining)) return;
    armedAt = Date.now();
    timer = setTimeout(dismiss, remaining);
  };
  const hold = () => {
    if (!armedAt) return;
    clearTimeout(timer);
    remaining = Math.max(1500, remaining - (Date.now() - armedAt));
    armedAt = 0;
  };
  node.addEventListener('pointerenter', hold);
  node.addEventListener('focusin', hold);
  node.addEventListener('pointerleave', arm);
  node.addEventListener('focusout', (e) => {
    if (!node.contains(e.relatedTarget)) arm();
  });

  root.append(node);
  arm();
  return dismiss;
}
