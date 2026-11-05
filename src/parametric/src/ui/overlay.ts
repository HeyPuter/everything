// Dialogs (modal, focus trapped), toasts and tooltips.

import { h, nextDomId, formatShortcut, announce } from './dom';
import { icon } from './icons';

// ---------- Dialogs ----------

export interface DialogOptions {
  title: string;
  body: HTMLElement | (HTMLElement | string)[];
  buttons?: { label: string; primary?: boolean; danger?: boolean; value?: string; left?: boolean; disabled?: boolean }[];
  wide?: boolean;
  /** Return false to keep the dialog open (e.g. validation failed). */
  onAction?: (value: string) => boolean | void | Promise<boolean | void>;
  initialFocus?: string;
  /** Receives a function that closes the dialog with a value. */
  onReady?: (close: (value: string | null) => void) => void;
}

const openDialogs: HTMLElement[] = [];
export const dialogOpen = () => openDialogs.length > 0;

export function showDialog(o: DialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const prevParents: HTMLElement[] = [];
    for (let p = prevFocus?.parentElement; p && p !== document.body; p = p.parentElement) prevParents.push(p);
    const titleId = nextDomId('dlg');
    const body = h('div', { class: 'dialog-body' }, ...(Array.isArray(o.body) ? o.body : [o.body]));
    const foot = h('div', { class: 'dialog-foot' });
    const dialog = h('div', { class: `dialog${o.wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
      h('div', { class: 'dialog-head' }, h('h2', { id: titleId }, o.title),
        h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => finish(null) }, icon('close', 18))),
      body, foot);
    const backdrop = h('div', { class: 'dialog-backdrop' }, dialog);
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      backdrop.remove();
      openDialogs.splice(openDialogs.indexOf(backdrop), 1);
      restoreFocus(prevFocus, prevParents);
      resolve(v);
    };
    for (const b of o.buttons ?? [{ label: 'Close', primary: true, value: 'ok' }]) {
      const btn = h('button', { class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}${b.left ? ' left' : ''}`, 'data-value': b.value ?? b.label, disabled: b.disabled }, b.label);
      btn.addEventListener('click', async () => {
        const v = b.value ?? b.label;
        if (o.onAction) {
          const keep = await o.onAction(v);
          if (keep === false) return;
        }
        finish(v);
      });
      foot.append(btn);
    }
    backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) finish(null); });
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
      if (e.key === 'Tab') {
        const f = [...dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled') && x.offsetParent !== null);
        if (!f.length) return;
        // Focus may be on the dialog itself (after a click on its text): Tab
        // and Shift+Tab then wrap inside it instead of reaching the page behind.
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && (i < 0 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
      }
      if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
        const primary = foot.querySelector<HTMLButtonElement>('.btn.primary');
        if (primary && !primary.disabled) { e.preventDefault(); primary.click(); }
      }
    });
    document.body.append(backdrop);
    openDialogs.push(backdrop);
    o.onReady?.(finish);
    // Destructive confirmations have no primary button: focus starts on the
    // first (safe) button, so Escape and Tab work inside the dialog.
    const focusEl = (o.initialFocus && dialog.querySelector<HTMLElement>(o.initialFocus)) || dialog.querySelector<HTMLElement>('input, select, textarea') || foot.querySelector<HTMLElement>('.btn.primary') || foot.querySelector<HTMLElement>('.btn:not([disabled])') || dialog;
    // Focus moves at once, so keys pressed right after the dialog opens (Esc
    // straight after Delete) reach it rather than the page behind it.
    focusEl.focus();
    requestAnimationFrame(() => {
      // A long body that scrolls must be reachable from the keyboard to scroll it.
      if (body.scrollHeight > body.clientHeight + 1) body.tabIndex = 0;
      if (!done && !dialog.contains(document.activeElement)) focusEl.focus();
    });
  });
}

/**
 * Focus goes back to the dialog's opener. When the opener was re-rendered
 * meanwhile (a design tree row after a rebuild), its replacement (same
 * data-key) or else the current tab stop of its nearest remaining container
 * gets focus, instead of the page body.
 */
function restoreFocus(prev: HTMLElement | null, parents: HTMLElement[]) {
  if (!prev?.focus) return;
  if (prev.isConnected) { prev.focus(); return; }
  const box = parents.find((p) => p.isConnected);
  if (!box) return;
  const key = prev.dataset.key;
  const target = (key ? box.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) : null)
    ?? box.querySelector<HTMLElement>('[tabindex="0"]')
    ?? box.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea');
  target?.focus();
}

export async function confirmDialog(title: string, message: string, ok = 'OK', danger = false): Promise<boolean> {
  const v = await showDialog({
    title,
    body: h('p', {}, message),
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: ok, value: 'ok', primary: !danger, danger }],
  });
  return v === 'ok';
}

export async function promptDialog(title: string, label: string, value: string, validate?: (v: string) => string | null): Promise<string | null> {
  const id = nextDomId('prompt');
  const input = h('input', { class: 'input', id, value, autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const err = h('div', { class: 'field-label', role: 'alert', style: { color: 'var(--danger)' } });
  const pending = showDialog({
    title,
    body: [h('label', { class: 'field-label', for: id }, label), input, err],
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'OK', value: 'ok', primary: true }],
    onAction: (a) => {
      if (a !== 'ok') return;
      const msg = validate?.(input.value) ?? null;
      if (msg) { err.textContent = msg; input.focus(); return false; }
    },
  });
  requestAnimationFrame(() => requestAnimationFrame(() => input.select()));
  const v = await pending;
  return v === 'ok' ? input.value : null;
}

// ---------- Toasts ----------

export interface ToastOptions {
  title?: string;
  message: string;
  kind?: 'info' | 'success' | 'warning' | 'error';
  timeout?: number;
  actions?: { label: string; run: () => void; primary?: boolean }[];
  onClose?: () => void;
}

function region(): HTMLElement {
  let r = document.querySelector<HTMLElement>('.toasts');
  if (!r) {
    r = h('div', { class: 'toasts', role: 'region', 'aria-label': 'Notifications' });
    document.body.append(r);
  }
  return r;
}

export function toast(o: ToastOptions): () => void {
  const kind = o.kind ?? 'info';
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' });
  const close = () => { el.remove(); o.onClose?.(); };
  const body = h('div', { class: 'body' }, o.title ? h('div', { class: 't' }, o.title) : null, h('div', { class: 'm' }, o.message));
  if (o.actions?.length) {
    body.append(h('div', { class: 'actions' }, o.actions.map((a) => h('button', { class: `btn small${a.primary ? ' primary' : ''}`, onclick: () => { close(); a.run(); } }, a.label))));
  }
  el.append(h('span', { style: { color: `var(--${kind === 'info' ? 'accent' : kind === 'success' ? 'success' : kind === 'warning' ? 'warning' : 'danger'})` } }, icon(kind === 'info' ? 'info' : kind === 'success' ? 'check' : kind === 'warning' ? 'warning' : 'error', 18)), body,
    h('button', { class: 'icon-btn', 'aria-label': 'Dismiss notification', onclick: close }, icon('close', 16)));
  region().append(el);
  const t = o.timeout ?? (kind === 'error' ? 9000 : o.actions?.length ? 0 : 4500);
  if (t > 0) {
    let timer = setTimeout(close, t);
    el.addEventListener('pointerenter', () => clearTimeout(timer));
    el.addEventListener('pointerleave', () => { timer = setTimeout(close, 2500); });
  }
  if (kind !== 'error') announce(`${o.title ? o.title + '. ' : ''}${o.message}`);
  return close;
}

// ---------- Tooltips ----------

let tip: HTMLElement | null = null;
let tipOwner: HTMLElement | null = null;
let tipTimer = 0;
let tipWatch = false;

export function attachTooltip(el: HTMLElement, title: string, shortcut?: string, desc?: string) {
  if (matchMedia?.('(pointer: coarse)').matches) return;
  const show = () => {
    clearTimeout(tipTimer);
    tipTimer = window.setTimeout(() => {
      hideTooltip();
      // The control may have been re-rendered away meanwhile (toolbars are
      // rebuilt when the CommandManager tab changes).
      if (!el.isConnected) return;
      tipOwner = el;
      if (!tipWatch) {
        tipWatch = true;
        // A removed control never gets pointerleave: hide on the next move elsewhere.
        document.addEventListener('pointerover', (e) => {
          if (tip && (!tipOwner?.isConnected || !tipOwner.contains(e.target as Node))) hideTooltip();
        }, true);
      }
      tip = h('div', { class: 'tooltip', role: 'tooltip' }, h('div', { class: 'tt-title' }, h('span', {}, title), shortcut ? h('span', { class: 'kbd' }, formatShortcut(shortcut)) : null), desc ? h('div', { class: 'tt-desc' }, desc) : null);
      document.body.append(tip);
      const r = el.getBoundingClientRect();
      const tr = tip.getBoundingClientRect();
      let x = r.left + r.width / 2 - tr.width / 2;
      let y = r.bottom + 6;
      if (y + tr.height > window.innerHeight - 4) y = r.top - tr.height - 6;
      x = Math.max(4, Math.min(window.innerWidth - tr.width - 4, x));
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    }, 450);
  };
  el.addEventListener('pointerenter', show);
  el.addEventListener('pointerleave', hideTooltip);
  el.addEventListener('pointerdown', hideTooltip);
  el.addEventListener('focus', () => { if (el.matches(':focus-visible')) show(); });
  el.addEventListener('blur', hideTooltip);
}

export function hideTooltip() {
  clearTimeout(tipTimer);
  tip?.remove();
  tip = null;
  tipOwner = null;
}
