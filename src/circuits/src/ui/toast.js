// Non-blocking notifications and the hover tooltip.

import { h, announce, shortcutLabel } from './dom.js';
import { icon } from './icons.js';

let host = null;

function ensureHost() {
  if (!host || !document.body.contains(host)) {
    host = h('div.toasts', { role: 'region', 'aria-label': 'Notifications' });
    document.body.append(host);
  }
  return host;
}

const KIND_ICON = { info: 'info', success: 'ok', error: 'error', warning: 'warning' };

/**
 * Shows a toast. Returns { close }.
 * opts: { kind: 'info'|'success'|'error'|'warning', title, timeout (ms, 0 = sticky), actions: [{label, run, primary}], className }
 */
export function toast(message, { kind = 'info', title, timeout = kind === 'error' ? 8000 : 4000, actions = [], className = '' } = {}) {
  const node = h(`div.toast.${kind}${className ? `.${className}` : ''}`, { role: kind === 'error' ? 'alert' : 'status' },
    icon(KIND_ICON[kind] || 'info', 18),
    h('div.grow', title ? h('div.title', title) : null, h('div', message),
      actions.length ? h('div.actions', actions.map((a) => h(`button.btn.sm${a.primary ? '.primary' : ''}`, { type: 'button', onClick: () => { a.run?.(); close(); } }, a.label))) : null),
    h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Dismiss notification', onClick: () => close() }, icon('x', 14)));
  ensureHost().append(node);
  if (kind !== 'error') announce(title ? `${title}. ${message}` : message);
  let timer = timeout ? setTimeout(() => close(), timeout) : null;
  // The countdown waits while the pointer is over the toast or keyboard focus is
  // inside it, so its buttons can be reached and read before it goes.
  const hold = () => { clearTimeout(timer); timer = null; };
  const resume = () => {
    if (!timeout || timer || node.matches(':hover') || node.contains(document.activeElement)) return;
    timer = setTimeout(() => close(), 2000);
  };
  node.addEventListener('pointerenter', hold);
  node.addEventListener('pointerleave', resume);
  node.addEventListener('focusin', hold);
  // Focus has moved on by the time the timer below runs.
  node.addEventListener('focusout', () => setTimeout(resume, 0));
  function close() { clearTimeout(timer); node.remove(); }
  return { close, el: node };
}

// Tooltips: any element with data-tip shows it on hover or keyboard focus,
// with data-kbd as an optional shortcut hint.
let tipEl = null;
let tipTimer = null;
let tipTarget = null;

function showTip(target) {
  const text = target.dataset.tip;
  if (!text) return;
  hideTip();
  tipTarget = target;
  tipTimer = setTimeout(() => {
    if (!document.contains(target)) return;
    tipEl = h('div.tooltip', { role: 'tooltip' }, text, target.dataset.kbd ? h('kbd', shortcutLabel(target.dataset.kbd)) : null);
    document.body.append(tipEl);
    const r = target.getBoundingClientRect(), t = tipEl.getBoundingClientRect();
    let left = r.left + r.width / 2 - t.width / 2;
    let top = r.bottom + 6;
    if (top + t.height > innerHeight - 4) top = r.top - t.height - 6;
    left = Math.max(4, Math.min(innerWidth - t.width - 4, left));
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${top}px`;
  }, 450);
}

function hideTip() {
  clearTimeout(tipTimer);
  tipEl?.remove();
  tipEl = null;
  tipTarget = null;
}

export function installTooltips(root = document) {
  root.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const t = e.target.closest?.('[data-tip]');
    if (t && t !== tipTarget) showTip(t);
    else if (!t) hideTip();
  });
  root.addEventListener('focusin', (e) => { const t = e.target.closest?.('[data-tip]'); if (t && e.target.matches(':focus-visible')) showTip(t); });
  root.addEventListener('focusout', hideTip);
  root.addEventListener('pointerdown', hideTip, true);
  root.addEventListener('keydown', hideTip, true);
}
