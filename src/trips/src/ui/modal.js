import { el, uid } from './dom.js';
import { iconButton, button } from './bits.js';
import { t } from '../lib/i18n/index.js';

const stack = [];
const overlayListeners = new Set();
export function overlayHost() { return stack.at(-1)?.panel ?? document.body; }
export function onOverlayChange(listener) { overlayListeners.add(listener); return () => overlayListeners.delete(listener); }
function notifyOverlayChange() { for (const listener of overlayListeners) listener(overlayHost()); }
const originalInert = new Map();
let observer;
let originalOverflow;
const selector = 'button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"]):not(:disabled)';
function focusable(panel) {
  return [...panel.querySelectorAll(selector)].filter((node) => {
    for (let parent = node; parent && parent !== panel; parent = parent.parentElement) {
      if (parent.hidden || parent.inert || getComputedStyle(parent).display === 'none' || getComputedStyle(parent).visibility === 'hidden') return false;
    }
    return node.tabIndex >= 0;
  });
}
function syncInert() {
  const top = stack.at(-1)?.root;
  for (const child of document.body.children) {
    if (!originalInert.has(child)) originalInert.set(child, child.inert);
    child.inert = child !== top;
  }
}
function keydown(event) {
  const active = stack.at(-1);
  if (!active) return;
  if (event.key === 'Escape' && !event.defaultPrevented) {
    event.preventDefault(); active.close('escape');
  } else if (event.key === 'Tab') {
    const nodes = focusable(active.panel);
    const index = nodes.indexOf(document.activeElement);
    if (!nodes.length) { event.preventDefault(); active.panel.focus(); }
    else if (event.shiftKey && index <= 0) { event.preventDefault(); nodes.at(-1).focus(); }
    else if (!event.shiftKey && (index === -1 || index === nodes.length - 1)) { event.preventDefault(); nodes[0].focus(); }
  }
}
function focusin(event) {
  const panel = stack.at(-1)?.panel;
  if (panel && !panel.contains(event.target)) panel.focus();
}

/** Returns {root, panel, close, closed}. All teardown is owned by close(). */
export function openModal({ title, content, actions = [], kind = 'modal', wide = false, onClose, dismissOnBackdrop = true, initialFocus } = {}) {
  const opener = document.activeElement;
  const titleId = uid('dialog-title');
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  let isClosed = false;
  const panel = el(`section.modal-panel${kind !== 'modal' ? `.${kind}` : ''}${wide ? '.wide' : ''}`, {
    role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabIndex: -1,
  });
  const root = el('div.modal-root', {}, el('div.modal-scrim', { 'aria-hidden': 'true' }), panel);
  const close = (reason = 'close') => {
    if (isClosed) return;
    isClosed = true;
    const wasTop = stack.at(-1)?.root === root;
    panel.dispatchEvent(new CustomEvent('ui:overlayclose', { detail: reason }));
    stack.splice(stack.findIndex((entry) => entry.root === root), 1);
    notifyOverlayChange();
    root.remove();
    if (!stack.length) {
      observer?.disconnect();
      for (const [node, inert] of originalInert) node.inert = inert;
      originalInert.clear();
      document.body.style.overflow = originalOverflow;
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('focusin', focusin);
    } else syncInert();
    if (wasTop) {
      const nextPanel = stack.at(-1)?.panel;
      if (opener?.isConnected && !opener.closest('[inert]') && (!nextPanel || nextPanel.contains(opener))) opener.focus();
      else nextPanel?.focus();
    }
    resolveClosed(reason);
    onClose?.(reason);
  };
  const body = el('div.modal-body', {}, content);
  panel.append(el('div.sheet-handle', { 'aria-hidden': 'true' }),
    el('header.modal-head', {}, el('h2.modal-title', { id: titleId }, title), iconButton('close', t('ui.close'), { onclick: () => close() })),
    body);
  if (actions.length) panel.append(el('footer.modal-actions', {}, actions));
  root.addEventListener('click', (event) => {
    if (dismissOnBackdrop && (event.target === root || event.target.classList.contains('modal-scrim'))) close('backdrop');
  });
  if (!stack.length) {
    originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', keydown);
    document.addEventListener('focusin', focusin);
    observer = new MutationObserver(syncInert);
    observer.observe(document.body, { childList: true });
  }
  stack.push({ root, panel, close });
  document.body.append(root);
  syncInert();
  notifyOverlayChange();
  // Long content with nothing focusable (a read-only form) still scrolls from the keyboard.
  if (body.scrollHeight > body.clientHeight && !focusable(body).length) body.tabIndex = 0;
  const candidates = focusable(panel);
  if (initialFocus && candidates.includes(initialFocus)) initialFocus.focus();
  else if (window.innerWidth >= 640) (candidates.find((node) => node.matches('input,textarea,select')) ?? panel).focus();
  else panel.focus();
  return { root, panel, close, closed };
}
export function confirmDialog({ title, body, confirmLabel = t('ui.confirm'), danger = false }) {
  return new Promise((resolve) => {
    const dialog = openModal({ title, content: el('p', {}, body), onClose: () => resolve(false), actions: [
      button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }),
      button(confirmLabel, { variant: danger ? 'danger' : 'primary', onclick: () => { resolve(true); dialog.close('confirm'); } }),
    ] });
  });
}
export function promptDialog({ title, label, value = '', confirmLabel = t('ui.save') }) {
  return new Promise((resolve) => {
    const id = uid('prompt');
    const input = el('input.input', { id, value, required: true });
    const form = el('form', { onsubmit: (event) => { event.preventDefault(); if (form.reportValidity()) { resolve(input.value); dialog.close('confirm'); } } },
      el('label.field', { htmlFor: id }, el('span.field-label', {}, label), input),
      el('div.modal-actions', {}, button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), button(confirmLabel, { type: 'submit', variant: 'primary' })));
    const dialog = openModal({ title, content: form, onClose: () => resolve(null) });
  });
}
