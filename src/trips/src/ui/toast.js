import { el } from './dom.js';
import { t } from '../lib/i18n/index.js';
import { overlayHost, onOverlayChange } from './modal.js';
const active = new Set();
let root;
let unsubscribe;
export function toast(message, { action, duration = 6000 } = {}) {
  if (root && !root.isConnected) for (const dismiss of [...active]) dismiss();
  if (!root) {
    root = el('div.toast-root', { 'aria-live': 'polite', 'aria-relevant': 'additions' });
    overlayHost().append(root);
    unsubscribe = onOverlayChange((host) => {
      if (root.parentElement !== host) host.append(root);
      root.inert = false;
    });
  }
  let timer;
  let closed = false;
  let hovered = false;
  let focused = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer); active.delete(close);
    if (node.contains(document.activeElement)) document.activeElement.blur();
    node.remove();
    if (!active.size) { unsubscribe?.(); unsubscribe = null; root?.remove(); root = null; }
  };
  const arm = () => { clearTimeout(timer); if (!closed && !hovered && !focused && duration > 0) timer = setTimeout(close, duration); };
  const node = el('div.toast', { role: 'status' }, el('span', {}, message),
    action && el('button.toast-action', { type: 'button', onclick: () => { close(); action.onClick(); } }, action.label),
    el('button.toast-dismiss', { type: 'button', 'aria-label': t('ui.close'), onclick: close }, '×'));
  node.addEventListener('pointerenter', () => { hovered = true; clearTimeout(timer); });
  node.addEventListener('pointerleave', () => { hovered = false; arm(); });
  node.addEventListener('focusin', () => { focused = true; clearTimeout(timer); });
  node.addEventListener('focusout', (event) => { focused = node.contains(event.relatedTarget); arm(); });
  root.append(node); active.add(close); arm();
  if (active.size > 3) active.values().next().value();
  return { element: node, close };
}
