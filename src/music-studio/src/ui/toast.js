// Transient notifications (also announced to screen readers).

import { h, announce } from '../lib/dom.js';

let host = null;

export function toast(message, { error = false, action, timeout = error ? 6000 : 3500 } = {}) {
  if (!host) {
    host = h('div.toasts', { 'aria-live': 'off' });
    document.body.append(host);
  }
  const el = h(`div.toast${error ? '.error' : ''}`, { role: error ? 'alert' : 'status' }, h('span', message));
  if (action) el.append(h('button.btn', { type: 'button', onclick: () => {
    action.run();
    el.remove();
  } }, action.label));
  host.append(el);
  if (!error) announce(message);
  setTimeout(() => el.remove(), timeout);
  return el;
}
