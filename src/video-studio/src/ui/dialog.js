/**
 * Modal dialogs on top of <dialog> (native focus trapping, Escape, inert
 * background), plus confirm/prompt helpers and toasts.
 */
import { h, announce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

let dialogCount = 0;

/**
 * Open a modal. body is a node (or array); actions are buttons laid out in
 * the footer. Returns { el, close(result), result: Promise }.
 */
export function openDialog({ title, body, actions = [], className = '', onClose, closeOnBackdrop = true, labelledBody = false, wide = false } = {}) {
  const id = `dlg-${++dialogCount}`;
  const titleEl = h('h2.dialog-title', { id: `${id}-title` }, title);
  const closeBtn = h('button.icon-btn.dialog-close', { type: 'button', 'aria-label': 'Close' }, icon('close', 18));
  const content = h('div.dialog-body', { id: `${id}-body` }, body);
  const footer = actions.length ? h('div.dialog-actions', actions) : null;
  const el = h(`dialog.dialog${wide ? '.wide' : ''}${className ? '.' + className.split(' ').join('.') : ''}`, {
    'aria-labelledby': `${id}-title`,
    'aria-describedby': labelledBody ? `${id}-body` : null,
  }, h('div.dialog-head', titleEl, closeBtn), content, footer);
  let resolve;
  const result = new Promise((r) => (resolve = r));
  const opener = document.activeElement;
  let closed = false;
  const close = (value) => {
    if (closed) return;
    closed = true;
    el.close();
    el.remove();
    onClose?.(value);
    resolve(value);
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  };
  closeBtn.addEventListener('click', () => close(undefined));
  el.addEventListener('cancel', (e) => {
    e.preventDefault();
    close(undefined);
  });
  el.addEventListener('mousedown', (e) => {
    if (closeOnBackdrop && e.target === el) close(undefined);
  });
  document.body.append(el);
  el.showModal();
  // Focus the first field, else the primary action, else the close button.
  const first = content.querySelector('[autofocus], input:not([type=hidden]), select, textarea') || footer?.querySelector('.btn.primary') || closeBtn;
  first?.focus();
  return { el, close, result };
}

export function confirmDialog({ title, message, confirm = 'OK', cancel = 'Cancel', danger = false }) {
  const ok = h(`button.btn${danger ? '.danger' : '.primary'}`, { type: 'button' }, confirm);
  const no = h('button.btn', { type: 'button' }, cancel);
  const d = openDialog({ title, body: h('p.dialog-text', message), actions: [no, ok], labelledBody: true, className: 'small' });
  ok.addEventListener('click', () => d.close(true));
  no.addEventListener('click', () => d.close(false));
  ok.focus();
  return d.result.then((v) => v === true);
}

export function promptDialog({ title, label, value = '', confirm = 'Save', maxLength = 200 }) {
  const input = h('input.input', { type: 'text', value, maxLength, 'aria-label': label, autofocus: true });
  const ok = h('button.btn.primary', { type: 'submit' }, confirm);
  const no = h('button.btn', { type: 'button' }, 'Cancel');
  const form = h('form.dialog-form', h('label.field-label', { for: '' }, label), input);
  const d = openDialog({ title, body: form, actions: [no, ok], className: 'small' });
  const submit = (e) => {
    e?.preventDefault();
    const v = input.value.trim();
    if (!v) {
      input.focus();
      return;
    }
    d.close(v);
  };
  form.addEventListener('submit', submit);
  ok.addEventListener('click', submit);
  no.addEventListener('click', () => d.close(null));
  input.select();
  return d.result.then((v) => (typeof v === 'string' ? v : null));
}

/* Toasts */
let toastHost = null;

export function toast(message, { kind = 'info', action, duration = 3800 } = {}) {
  if (!toastHost?.isConnected) {
    toastHost ||= h('div.toasts', { role: 'region', 'aria-label': 'Notifications' });
    document.body.append(toastHost);
  }
  const iconName = kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'info';
  const btn = action ? h('button.toast-action', { type: 'button' }, action.label) : null;
  const t = h(`div.toast.${kind}`, { role: kind === 'error' ? 'alert' : 'status' }, icon(iconName, 16), h('span.toast-text', message), btn);
  let timer = null;
  const remove = () => {
    clearTimeout(timer);
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 180);
  };
  btn?.addEventListener('click', () => {
    action.onClick();
    remove();
  });
  toastHost.append(t);
  if (kind !== 'error') announce(message);
  const arm = () => (timer = setTimeout(remove, duration));
  t.addEventListener('pointerenter', () => clearTimeout(timer));
  t.addEventListener('pointerleave', arm);
  arm();
  return { remove };
}

/*
 * Tooltips: any element with data-tip gets a hover/focus tooltip. Installed once on the
 * document, so the home screen, the editor and dialogs all get them. data-tip-key shows a
 * fixed key; data-tip-cmd shows the key bound to that command when the tooltip opens.
 */
let tooltipsInstalled = false;
let tipShortcut = null;

/** Set how data-tip-cmd command ids become key labels; returns a function that unsets it. */
export function setTooltipShortcuts(fn) {
  tipShortcut = fn;
  return () => {
    if (tipShortcut === fn) tipShortcut = null;
  };
}

export function installTooltips() {
  if (tooltipsInstalled) return;
  tooltipsInstalled = true;
  const root = document;
  let tip = null;
  let timer = null;
  let current = null;
  const hide = () => {
    clearTimeout(timer);
    tip?.remove();
    tip = null;
    current = null;
  };
  const show = (el) => {
    const text = el.getAttribute('data-tip');
    if (!text) return;
    hide();
    current = el;
    const cmd = el.getAttribute('data-tip-cmd');
    const kbd = (cmd && tipShortcut?.(cmd)) || el.getAttribute('data-tip-key');
    tip = h('div.tooltip', { role: 'tooltip' }, text, kbd ? h('span.tooltip-key', kbd) : null);
    // A modal dialog is in the top layer, above anything in the page: put the tooltip in it.
    (el.closest('dialog[open]') || document.body).append(tip);
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    let x = r.left + r.width / 2 - t.width / 2;
    let y = r.bottom + 6;
    if (y + t.height > window.innerHeight - 4) y = r.top - t.height - 6;
    x = Math.max(4, Math.min(window.innerWidth - t.width - 4, x));
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };
  root.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = e.target.closest?.('[data-tip]');
    if (!el || el === current) return;
    clearTimeout(timer);
    timer = setTimeout(() => show(el), tip ? 0 : 450);
  });
  root.addEventListener('pointerout', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el && !el.contains(e.relatedTarget)) hide();
  });
  root.addEventListener('focusin', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el && e.target.matches(':focus-visible')) show(el);
  });
  root.addEventListener('focusout', hide);
  root.addEventListener('pointerdown', hide, true);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tip) hide();
  });
}
