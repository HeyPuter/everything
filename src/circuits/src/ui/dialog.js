// Modal dialogs with focus trapping, plus confirm/prompt/form helpers.

import { h, nextId, trapFocus, isComposing } from './dom.js';
import { icon } from './icons.js';
import { closeMenus } from './menu.js';

const stack = [];

/**
 * Opens a modal dialog.
 * actions: [{ label, primary?, danger?, left?, run?: () => (false | Promise<false>) keeps it open }]
 * Returns { el, body, close(result), result: Promise }.
 */
export function openDialog({ title, body, actions = [{ label: 'Close', primary: true }], size = '', onClose, initialFocus, describedBy } = {}) {
  closeMenus();
  const prevFocus = document.activeElement;
  const titleId = nextId('dlg-title');
  let resolve;
  const result = new Promise((r) => { resolve = r; });
  const bodyEl = h('div.dialog-body', body);
  const foot = h('div.dialog-foot');
  const left = h('div.left');
  const dialog = h(`div.dialog${size ? `.${size}` : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': describedBy || null },
    h('div.dialog-head', h('h2', { id: titleId }, title),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Close dialog', onClick: () => close(undefined) }, icon('x', 16))),
    bodyEl, foot);
  const backdrop = h('div.dialog-backdrop', dialog);
  let closed = false;
  const close = (value) => {
    if (closed) return;
    closed = true;
    release();
    backdrop.remove();
    stack.splice(stack.indexOf(api), 1);
    onClose?.(value);
    resolve(value);
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus?.();
  };
  let hasLeft = false;
  for (const a of actions) {
    const btn = h(`button.btn${a.primary ? '.primary' : ''}${a.danger ? '.danger' : ''}`, { type: 'button' }, a.label);
    btn.addEventListener('click', async () => {
      if (a.run) {
        btn.disabled = true;
        try {
          const keep = await a.run(api);
          if (keep === false) return;
          close(a.value ?? a.label);
        } finally { btn.disabled = false; }
      } else close(a.value ?? a.label);
    });
    if (a.left) { left.append(btn); hasLeft = true; } else foot.append(btn);
    a.el = btn;
  }
  if (hasLeft) foot.prepend(left);
  if (!actions.length) foot.remove();
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) backdrop.dataset.downOutside = '1'; });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && backdrop.dataset.downOutside) close(undefined); delete backdrop.dataset.downOutside; });
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(undefined); }
    // A field that handles Enter itself (prevents the default) keeps it.
    else if (e.key === 'Enter' && !isComposing(e) && !e.shiftKey && !e.defaultPrevented && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'SELECT') {
      const primary = actions.find((a) => a.primary);
      if (primary?.el && !primary.el.disabled) { e.preventDefault(); primary.el.click(); }
    }
    e.stopPropagation();
  });
  document.body.append(backdrop);
  const release = trapFocus(dialog);
  const api = { el: dialog, body: bodyEl, close, result, actions };
  stack.push(api);
  requestAnimationFrame(() => {
    // A long body with nothing to focus (a table of shortcuts, say) must
    // still be scrollable from the keyboard.
    const focusable = bodyEl.querySelector('button, [href], input, select, textarea, [tabindex]');
    if (!focusable && bodyEl.scrollHeight > bodyEl.clientHeight) {
      bodyEl.tabIndex = 0;
      bodyEl.setAttribute('role', 'region');
      bodyEl.setAttribute('aria-labelledby', titleId);
    }
    const target = initialFocus?.() || dialog.querySelector('[autofocus], input, select, textarea') || actions.find((a) => a.primary)?.el || dialog.querySelector('button');
    target?.focus();
    if (target?.select && target.type === 'text') target.select();
  });
  return api;
}

export const dialogOpen = () => stack.length > 0;

export async function confirmDialog({ title, message, confirm = 'OK', cancel = 'Cancel', danger = false }) {
  const r = await openDialog({
    title, body: h('p', message),
    actions: [{ label: cancel, value: false }, { label: confirm, primary: !danger, danger, value: true }],
  }).result;
  return r === true;
}

/** Three-way choice: returns the value of the chosen action or undefined. */
export async function choiceDialog({ title, message, choices }) {
  return openDialog({ title, body: h('p', message), actions: choices }).result;
}

export async function promptDialog({ title, label, value = '', confirm = 'OK', validate }) {
  const id = nextId('prompt');
  const input = h('input', { id, type: 'text', value, autocomplete: 'off', spellcheck: 'false' });
  const err = h('div.small.sev-error', { role: 'alert' });
  let out;
  const r = await openDialog({
    title,
    body: h('div.form-grid', h('label', { for: id }, label), input, h('div.full', err)),
    actions: [{ label: 'Cancel', value: null }, {
      label: confirm, primary: true,
      run: () => {
        const v = input.value.trim();
        const msg = validate?.(v);
        if (msg) { err.textContent = msg; input.setAttribute('aria-invalid', 'true'); input.focus(); return false; }
        out = v;
        return true;
      },
    }],
  }).result;
  return r === null || r === undefined ? null : out;
}

/**
 * Builds a labelled form from field specs and returns { el, values(), validate() }.
 * Field: { key, label, type: 'text'|'number'|'length'|'select'|'bool'|'textarea'|'color', value, options, hint, parse, min, max, step }
 */
export function buildForm(fields) {
  const el = h('div.form-grid');
  const inputs = new Map();
  for (const f of fields) {
    const id = nextId('f');
    let input;
    if (f.type === 'select') {
      input = h('select', { id }, f.options.map((o) => {
        const [val, lab] = Array.isArray(o) ? o : typeof o === 'object' ? [o.value, o.label] : [o, o];
        return h('option', { value: String(val), selected: String(val) === String(f.value) }, lab);
      }));
    } else if (f.type === 'bool') {
      input = h('input', { id, type: 'checkbox', checked: !!f.value });
    } else if (f.type === 'textarea') {
      input = h('textarea', { id, rows: f.rows || 6, spellcheck: 'false' }, f.value ?? '');
    } else if (f.type === 'color') {
      input = h('input', { id, type: 'color', value: f.value || '#000000' });
    } else {
      input = h('input', { id, type: f.type === 'number' ? 'number' : 'text', value: f.value ?? '', min: f.min, max: f.max, step: f.step, autocomplete: 'off', spellcheck: 'false', inputmode: f.type === 'length' || f.type === 'number' ? 'decimal' : null });
    }
    inputs.set(f.key, { f, input });
    if (f.type === 'bool') el.append(h('span'), h('label.check-row', input, f.label));
    else el.append(h('label', { for: id }, f.label), input);
    if (f.hint) el.append(h('div.hint', f.hint));
  }
  const values = () => {
    const out = {};
    for (const [k, { f, input }] of inputs) {
      let v = f.type === 'bool' ? input.checked : input.value;
      if (f.type === 'number') v = Number(v);
      if (f.parse) v = f.parse(v);
      out[k] = v;
    }
    return out;
  };
  // focus: false checks without moving focus, for live previews while typing.
  const validate = ({ focus = true } = {}) => {
    for (const [, { f, input }] of inputs) {
      input.removeAttribute('aria-invalid');
      const raw = f.type === 'bool' ? input.checked : input.value;
      let v = raw;
      if (f.parse) v = f.parse(raw);
      const bad = (f.parse && (v === null || Number.isNaN(v))) || (f.type === 'number' && (raw === '' || Number.isNaN(Number(raw)) || (f.min != null && Number(raw) < f.min) || (f.max != null && Number(raw) > f.max))) || (f.required && !String(raw).trim());
      if (bad) { input.setAttribute('aria-invalid', 'true'); if (focus) input.focus(); return `${f.label}: ${f.error || 'enter a valid value'}`; }
    }
    return null;
  };
  return { el, values, validate, inputs };
}

/** Form dialog: resolves to the values object or null when cancelled. */
export async function formDialog({ title, fields, confirm = 'OK', size = '', intro }) {
  const form = buildForm(fields);
  const err = h('div.small.sev-error', { role: 'alert', style: { marginTop: '8px' } });
  let out = null;
  await openDialog({
    title, size,
    body: [intro ? h('p.muted', intro) : null, form.el, err],
    actions: [{ label: 'Cancel', value: null }, {
      label: confirm, primary: true,
      run: () => {
        const msg = form.validate();
        if (msg) { err.textContent = msg; return false; }
        out = form.values();
        return true;
      },
    }],
  }).result;
  return out;
}
