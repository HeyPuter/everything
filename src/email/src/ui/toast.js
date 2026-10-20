import { el } from './dom.js';
import { icon } from './icons.js';

let region = null;

// One polite live region reused for every toast, so screen readers announce
// the text without the region itself appearing and disappearing.
function ensureRegion() {
  if (!region) {
    region = el('div.toast-region', { role: 'status', 'aria-live': 'polite' });
    document.body.append(region);
  }
  return region;
}

/**
 * toast('Archived', { action: { label: 'Undo', onSelect } }) — an action makes
 * the toast the only way back from a move, so it stays up longer than a plain
 * confirmation and takes pointer events (the region itself does not).
 */
export function toast(message, { iconName = 'check', duration, action = null } = {}) {
  const node = el('div.toast', {},
    el('span.toast-icon', { html: icon(iconName, 16) }),
    el('span', {}, message),
    action && el('button.toast-action', {
      type: 'button',
      onclick: () => {
        dismiss();
        action.onSelect();
      },
    }, action.label),
  );

  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    node.classList.add('toast-out');
    setTimeout(() => node.remove(), 250);
  };

  // A toast someone is pointing at, or has tabbed to, stays until they leave
  // it. Timing out under the keyboard dropped focus onto the page body, and
  // an Undo reached with a moment left vanished before it could be pressed.
  const wait = duration ?? (action ? 8000 : 3200);
  const hold = () => clearTimeout(timer);
  const resume = () => {
    if (!node.isConnected || node.classList.contains('toast-out') || node.matches(':hover, :focus-within')) return;
    clearTimeout(timer);
    timer = setTimeout(dismiss, Math.min(wait, 3200));
  };
  node.addEventListener('pointerenter', hold);
  node.addEventListener('focusin', hold);
  node.addEventListener('pointerleave', resume);
  // After the focus has landed wherever it went, which may be inside.
  node.addEventListener('focusout', () => setTimeout(resume));

  ensureRegion().append(node);
  timer = setTimeout(dismiss, wait);
  return dismiss;
}
