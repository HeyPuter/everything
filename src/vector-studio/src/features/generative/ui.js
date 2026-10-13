/** Small UI pieces shared by the generative panels and dialogs. */
import { h } from '../../lib/dom.js';
import { icon } from '../../ui/icons.js';
import { aiStatus } from './ai.js';

let seq = 0;
export const nextId = (p) => `${p}-${++seq}`;

/**
 * Inline progress with a Cancel button: { el, start(), stop(), set(v) }.
 * set(null) shows an indeterminate bar. Escape inside `scope` cancels.
 */
export function progressBlock({ label, onCancel }) {
  const bar = h('span.gen-progress-bar');
  const text = h('span.gen-progress-label', `${label}...`);
  const pct = h('span.gen-progress-pct');
  const cancel = h('button.btn.small', { type: 'button', onclick: () => onCancel?.() }, 'Cancel');
  const el = h('div.gen-progress', { role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', hidden: true }, text, h('span.gen-progress-track', { 'aria-hidden': 'true' }, bar), pct, cancel);
  const set = (v) => {
    if (v == null) {
      el.classList.add('indeterminate');
      el.removeAttribute('aria-valuenow');
      pct.textContent = '';
      return;
    }
    el.classList.remove('indeterminate');
    const p = Math.round(Math.max(0, Math.min(1, v)) * 100);
    bar.style.width = `${p}%`;
    pct.textContent = `${p}%`;
    el.setAttribute('aria-valuenow', String(p));
  };
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel?.();
    }
  });
  return {
    el,
    set,
    setLabel: (t) => (text.textContent = `${t}...`),
    start(v = null) {
      el.hidden = false;
      set(v);
    },
    stop() {
      el.hidden = true;
    },
    get cancelButton() {
      return cancel;
    },
  };
}

/**
 * A notice for when generative features cannot run (signed out, offline,
 * no Puter): { el, refresh() -> ok }. Signed out it offers a Sign In button.
 */
export function availabilityNotice(app) {
  const msg = h('p.gen-notice-text');
  const signIn = h('button.btn.small.primary', { type: 'button', onclick: () => app.onSignIn?.() }, icon('login', 14), h('span', 'Sign In'));
  const el = h('div.gen-notice', { role: 'status', hidden: true }, icon('info', 16), h('div.gen-notice-body', msg, signIn));
  return {
    el,
    refresh() {
      const st = aiStatus(app);
      el.hidden = st.ok;
      if (!st.ok) {
        msg.textContent = st.message;
        signIn.hidden = !(st.reason === 'signedOut' && app.onSignIn);
      }
      return st.ok;
    },
  };
}

/** A radio group of buttons: { el, value, set(v) }. onChange(value) on user change. */
export function segmented(label, options, value, onChange, { className = '' } = {}) {
  const lid = nextId('gen-seg');
  let current = value;
  const buttons = options.map((o) =>
    h(`button.gen-seg-btn`, {
      type: 'button',
      role: 'radio',
      'data-value': o.id,
      onclick: () => pick(o.id, true),
      onkeydown: (e) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const i = options.findIndex((x) => x.id === o.id);
        const n = options[(i + d + options.length) % options.length];
        pick(n.id, true);
        buttons[options.indexOf(n)].focus();
      },
    }, o.icon ? icon(o.icon, 14) : null, h('span', o.label)),
  );
  const group = h(`div.gen-seg${className ? `.${className}` : ''}`, { role: 'radiogroup', 'aria-labelledby': lid }, buttons);
  const el = h('div.gen-field', h('span.gen-label', { id: lid }, label), group);
  const pick = (v, user = false) => {
    current = v;
    buttons.forEach((b) => {
      const on = b.dataset.value === v;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    if (user) onChange?.(v);
  };
  pick(value);
  return {
    el,
    get value() {
      return current;
    },
    set: (v) => pick(v),
  };
}

/** A labeled select: { el, sel }. */
export function selectField(label, options, value, onChange) {
  const id = nextId('gen-sel');
  const sel = h('select.select', { id, onchange: () => onChange?.(sel.value) }, options.map((o) => h('option', { value: o.id, selected: o.id === value }, o.label)));
  return { el: h('div.gen-field', h('label.gen-label', { for: id }, label), sel), sel };
}
