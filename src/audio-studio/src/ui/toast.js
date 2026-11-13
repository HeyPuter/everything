// Transient notifications (also announced to screen readers).
// A toast stays while the pointer is over it or focus is inside it, and one
// with an action button stays longer, so there is time to reach the button.

import { h, announce } from '../lib/dom.js';

let host = null;

/** Default time on screen: longer for errors, longest for toasts with an action. */
export const ACTION_TIMEOUT = 10000;

/** Toasts on screen at most: older ones give way, so a burst cannot cover the window. */
export const MAX_TOASTS = 4;

export function toast(message, { error = false, action, timeout = action ? ACTION_TIMEOUT : error ? 6000 : 3500 } = {}) {
  if (!host) {
    host = h('div.toasts', { 'aria-live': 'off' });
    document.body.append(host);
  }
  if (!host.isConnected) document.body.append(host);
  const el = h(`div.toast${error ? '.error' : ''}`, { role: error ? 'alert' : 'status' }, h('span', message));
  if (action) el.append(h('button.btn', { type: 'button', onclick: () => {
    action.run();
    el.remove();
  } }, action.label));
  // The same message again (a repeated key or command) replaces the one showing instead of stacking.
  const key = `${error ? 'e' : 's'}:${message}`;
  if (!action) el.dataset.key = key;
  for (const old of host.querySelectorAll('.toast')) {
    if (!action && old.dataset.key === key && !old.contains(document.activeElement)) old.remove();
  }
  host.append(el);
  // Oldest first, but plain notices give way before toasts with an action, so a burst of status
  // messages cannot take an Undo or Open button away before there was time to use it.
  const shown = [...host.querySelectorAll('.toast')];
  const spare = shown.filter((t) => t !== el && !t.contains(document.activeElement));
  const hasAction = (t) => !!t.querySelector('button');
  const order = [...spare.filter((t) => !hasAction(t)), ...spare.filter(hasAction)];
  order.slice(0, Math.max(0, shown.length - MAX_TOASTS)).forEach((t) => t.remove());
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
