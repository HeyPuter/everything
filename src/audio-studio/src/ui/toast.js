// Transient notifications (also announced to screen readers).
// A toast stays while the pointer is over it or focus is inside it, and one
// with an action button stays longer, so there is time to reach the button.

import { h, announce } from '../lib/dom.js';

let host = null;

/** Default time on screen: longer for errors, longest for toasts with an action. */
export const ACTION_TIMEOUT = 10000;

export function toast(message, { error = false, action, timeout = action ? ACTION_TIMEOUT : error ? 6000 : 3500 } = {}) {
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
  // The countdown pauses while the toast is hovered or holds focus, and resumes with the time left.
  let left = timeout;
  let started = 0;
  let timer = 0;
  const run = () => {
    started = Date.now();
    timer = setTimeout(() => el.remove(), left);
  };
  const pause = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = 0;
    left = Math.max(0, left - (Date.now() - started));
  };
  const resume = () => {
    if (timer || !el.isConnected || el.matches(':hover') || el.contains(document.activeElement)) return;
    run();
  };
  el.addEventListener('pointerenter', pause);
  el.addEventListener('pointerleave', resume);
  el.addEventListener('focusin', pause);
  // After focus has settled on its new element.
  el.addEventListener('focusout', () => setTimeout(resume, 0));
  run();
  return el;
}
