/**
 * Modal dialogs on the native <dialog> element (built-in focus trapping,
 * Escape to cancel, inert background). Dialogs are draggable by their title
 * bar on desktop and become bottom sheets on narrow screens (CSS).
 *
 *   const result = await openDialog({ title, body, buttons })
 *   const values = await formDialog(app, { title, fields })
 */
import { h } from '../../lib/dom.js';
import { icon } from '../icons.js';
import { formatLength, parseLength, parseNumber, UNITS } from '../../lib/units.js';

let counter = 0;

/**
 * Cancel every open dialog (as Escape would) and wait for their callers to
 * roll back their previews: for actions that arrive from outside the page
 * (opening files from the desktop, closing the window) while a dialog is up.
 */
export async function cancelOpenDialogs() {
  const open = [...document.querySelectorAll('dialog[open]')];
  if (!open.length) return false;
  const closed = open.map((d) => new Promise((r) => d.addEventListener('close', r, { once: true })));
  for (const d of open.reverse()) d.dispatchEvent(new Event('cancel', { cancelable: true }));
  await Promise.race([Promise.all(closed), new Promise((r) => setTimeout(r, 1000))]);
  // Let the callers' continuations (rolling back previews) run.
  await new Promise((r) => setTimeout(r, 0));
  return true;
}

/**
 * Hooks for recording and replaying dialogs (the Actions panel):
 *   open(opts, show)       wraps every openDialog() call; `show(opts)` shows it
 *   fields(title, fields)  may return form fields with prefilled values
 */
export const dialogHooks = { open: null, fields: null };

export function openDialog(opts = {}) {
  return dialogHooks.open ? dialogHooks.open(opts, showDialog) : showDialog(opts);
}

function showDialog({ title, body, buttons = [], className = '', onOpen, onClose, initialFocus, describedBy } = {}) {
  return new Promise((resolve) => {
    const id = `dlg-${++counter}`;
    const footer = h('div.dialog-footer');
    const dialog = h(`dialog.dialog${className ? '.' + className.split(' ').join('.') : ''}`, {
      'aria-labelledby': `${id}-title`,
      ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    });
    const header = h(
      'div.dialog-header',
      h('h2.dialog-title', { id: `${id}-title` }, title),
      h('button.icon-btn.dialog-close', { type: 'button', 'aria-label': 'Close', onclick: () => close(null) }, icon('x', 16)),
    );
    const content = h('div.dialog-body', body);
    let result = null;
    const close = (value) => {
      result = value;
      if (dialog.open) dialog.close();
    };
    for (const b of buttons) {
      const btn = h(
        `button.btn${b.primary ? '.primary' : ''}${b.danger ? '.danger' : ''}`,
        {
          type: 'button',
          onclick: async () => {
            if (b.validate && !(await b.validate())) return;
            close(typeof b.value === 'function' ? b.value() : b.value);
          },
          ...(b.disabled ? { disabled: true } : {}),
        },
        b.label,
      );
      if (b.left) btn.classList.add('left');
      footer.append(btn);
    }
    dialog.append(header, content);
    if (buttons.length) dialog.append(footer);
    dialog.addEventListener('close', () => {
      onClose?.(result);
      dialog.remove();
      resolve(result);
    });
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(null);
    });
    // Enter submits with the primary button unless focus is in a textarea or on a button.
    dialog.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.isComposing && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
        const primary = footer.querySelector('.btn.primary');
        if (primary && !primary.disabled) {
          e.preventDefault();
          // Fields that apply on 'change' (like hex fields) must commit what was typed before OK reads them.
          if (e.target.tagName === 'INPUT') e.target.dispatchEvent(new Event('change', { bubbles: true }));
          primary.click();
        }
      }
    });
    makeDraggable(dialog, header);
    document.body.append(dialog);
    dialog.showModal();
    const focusEl = initialFocus?.() || content.querySelector('input:not([type=hidden]), select, textarea, button') || footer.querySelector('.btn.primary');
    focusEl?.focus();
    if (focusEl?.select && focusEl.type !== 'checkbox' && focusEl.type !== 'range') focusEl.select();
    onOpen?.({ dialog, close, footer, content });
  });
}

function makeDraggable(dialog, handle) {
  let start = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || matchMedia('(max-width: 760px)').matches) return;
    const r = dialog.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!start) return;
    dialog.style.margin = '0';
    dialog.style.left = `${Math.max(0, start.left + e.clientX - start.x)}px`;
    dialog.style.top = `${Math.max(0, start.top + e.clientY - start.y)}px`;
  });
  handle.addEventListener('pointerup', () => {
    start = null;
  });
}

const NUMERIC = ['length', 'number', 'angle', 'percent'];

/** Text shown in a numeric field for a value. */
function showValue(f, v, unit) {
  if (f.type === 'length') return formatLength(v ?? 0, unit);
  if (f.type === 'angle') return `${Number((v ?? 0).toFixed(3))}°`;
  if (f.type === 'percent') return `${Number((v ?? 0).toFixed(3))}%`;
  return v ?? '';
}

const REF_POINTS = [
  [0, 0, 'Top left'],
  [0.5, 0, 'Top center'],
  [1, 0, 'Top right'],
  [0, 0.5, 'Middle left'],
  [0.5, 0.5, 'Center'],
  [1, 0.5, 'Middle right'],
  [0, 1, 'Bottom left'],
  [0.5, 1, 'Bottom center'],
  [1, 1, 'Bottom right'],
];

/**
 * An angle dial: a small circle with a hand pointing at the angle
 * (degrees, counterclockwise from 3 o'clock). Drag or click to set it
 * (Shift snaps to 15°); arrow keys step by 1° (Shift for 15°).
 */
export function angleDial({ value = 0, label = 'Angle', onChange } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  const ring = document.createElementNS(NS, 'circle');
  for (const [k, v] of Object.entries({ cx: 16, cy: 16, r: 13, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 })) ring.setAttribute(k, v);
  const hand = document.createElementNS(NS, 'line');
  for (const [k, v] of Object.entries({ x1: 16, y1: 16, stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' })) hand.setAttribute(k, v);
  svg.append(ring, hand);
  const el = h('div.angle-dial', { role: 'slider', tabindex: '0', 'aria-label': `${label} dial`, 'aria-valuemin': '-180', 'aria-valuemax': '180' });
  el.append(svg);
  let cur = value;
  const draw = () => {
    const a = (cur * Math.PI) / 180;
    hand.setAttribute('x2', String(16 + Math.cos(a) * 11));
    hand.setAttribute('y2', String(16 - Math.sin(a) * 11));
    el.setAttribute('aria-valuenow', String(Math.round(cur * 100) / 100));
    el.setAttribute('aria-valuetext', `${Math.round(cur * 100) / 100}°`);
  };
  const set = (v, notify = true) => {
    if (!Number.isFinite(v)) return;
    cur = v;
    draw();
    if (notify) onChange?.(cur);
  };
  const fromPointer = (e) => {
    const r = el.getBoundingClientRect();
    let a = (Math.atan2(r.top + r.height / 2 - e.clientY, e.clientX - r.left - r.width / 2) * 180) / Math.PI;
    if (e.shiftKey) a = Math.round(a / 15) * 15;
    set(Math.round(a * 10) / 10);
  };
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture?.(e.pointerId);
    fromPointer(e);
    const move = (ev) => fromPointer(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
  el.addEventListener('keydown', (e) => {
    const d = { ArrowUp: 1, ArrowRight: -1, ArrowDown: -1, ArrowLeft: 1 }[e.key];
    if (!d) return;
    e.preventDefault();
    let v = cur + d * (e.shiftKey ? 15 : 1);
    if (v > 180) v -= 360;
    if (v <= -180) v += 360;
    set(v);
  });
  draw();
  return { el, get: () => cur, set };
}

/**
 * A 3x3 reference point picker (a radio group). `value` is { x, y } with
 * coordinates 0, 0.5 or 1 in the object's bounding box.
 */
export function refPointPicker({ value = { x: 0.5, y: 0.5 }, label = 'Reference point', onChange } = {}) {
  let cur = { ...value };
  const cells = REF_POINTS.map(([x, y, name]) =>
    h('button.refpoint-cell', { type: 'button', role: 'radio', 'aria-label': name, 'data-tip': name, dataset: { x: String(x), y: String(y) } }),
  );
  const el = h('div.refpoint', { role: 'radiogroup', 'aria-label': label }, cells);
  const sync = () => {
    for (const c of cells) {
      const on = Number(c.dataset.x) === cur.x && Number(c.dataset.y) === cur.y;
      c.setAttribute('aria-checked', String(on));
      c.tabIndex = on ? 0 : -1;
    }
  };
  const set = (v, notify = true) => {
    cur = { x: v.x, y: v.y };
    sync();
    if (notify) {
      onChange?.(cur);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };
  cells.forEach((c, i) => {
    c.addEventListener('click', () => set({ x: Number(c.dataset.x), y: Number(c.dataset.y) }));
    c.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }[e.key];
      if (d == null) return;
      e.preventDefault();
      const j = i + d;
      if (j < 0 || j > 8 || (Math.abs(d) === 1 && Math.floor(j / 3) !== Math.floor(i / 3))) return;
      cells[j].click();
      cells[j].focus();
    });
  });
  sync();
  return { el, get: () => ({ ...cur }), set };
}

/**
 * A form dialog. Field types: number, length (document units, stored in
 * points), angle (degrees), percent, text, textarea, checkbox, select, range,
 * color, radio, refpoint (3x3 reference point, { x, y }), heading. Returns
 * an object of values, or null when cancelled.
 *
 * Field options:
 *   slider: [min, max]       a slider next to a numeric field
 *   dial: true               an angle dial next to an angle field
 *   disabled(values)         greys the field out (re-evaluated on every edit)
 *   onInput(value, form)     runs when the user edits this field; `form.get(key)`
 *                            and `form.set(key, value)` keep linked fields in step
 *   inline: true             shares a line with the previous checkbox/radio
 * `onChange(values)` runs on every edit (for live previews).
 */
export function formDialog(app, { title, fields, okLabel = 'OK', extraButtons = [], onChange, description, previewToggle = false, className = '' }) {
  fields = dialogHooks.fields?.(title, fields) || fields;
  const unit = app?.editor?.doc.root.units || 'pt';
  const inputs = new Map();
  const rowsByKey = new Map();
  const sliders = new Map();
  const dials = new Map();
  let fid = 0;
  const readOne = (f) => {
    const el = inputs.get(f.key);
    if (!el) return undefined;
    if (f.type === 'checkbox') return el.checked;
    if (f.type === 'length') return parseLength(el.value, unit);
    if (NUMERIC.includes(f.type)) return parseNumber(el.value);
    if (f.type === 'range') return Number(el.value);
    if (f.type === 'radio') return el.querySelector('input:checked')?.value;
    if (f.type === 'refpoint') return el._picker.get();
    return el.value;
  };
  const read = () => {
    const out = {};
    for (const f of fields) {
      if (f.type === 'heading' || !inputs.has(f.key)) continue;
      out[f.key] = readOne(f);
    }
    return out;
  };
  const writeOne = (key, v) => {
    const f = fields.find((x) => x.key === key);
    const el = inputs.get(key);
    if (!f || !el) return;
    if (f.type === 'checkbox') el.checked = Boolean(v);
    else if (f.type === 'radio') {
      const r = [...el.querySelectorAll('input')].find((x) => x.value === String(v));
      if (r) r.checked = true;
    } else if (f.type === 'refpoint') el._picker.set(v, false);
    else if (NUMERIC.includes(f.type)) el.value = showValue(f, v, unit);
    else el.value = v;
    syncSlider(f);
    if (dials.has(key) && Number.isFinite(v)) dials.get(key).set(v, false);
  };
  const form = { get: (key) => readOne(fields.find((x) => x.key === key) || {}), set: writeOne, values: read };
  const syncSlider = (f) => {
    const s = sliders.get(f.key);
    if (!s) return;
    const v = readOne(f);
    if (Number.isFinite(v)) s.value = String(f.type === 'length' ? v / (UNITS[unit]?.factor || 1) : v);
  };
  const syncDisabled = () => {
    const v = read();
    for (const f of fields) {
      if (!f.disabled || !rowsByKey.has(f.key)) continue;
      const off = Boolean(f.disabled(v));
      const row = rowsByKey.get(f.key);
      row.classList.toggle('disabled', off);
      // Dimmed labels belong to inactive controls (no contrast requirement).
      if (off) row.setAttribute('aria-disabled', 'true');
      else row.removeAttribute('aria-disabled');
      for (const el of row.querySelectorAll('input, select, textarea, button')) el.disabled = off;
      for (const el of row.querySelectorAll('.angle-dial')) el.tabIndex = off ? -1 : 0;
    }
  };
  const valid = () => {
    const v = read();
    for (const f of fields) {
      const val = v[f.key];
      if (NUMERIC.includes(f.type) && !inputs.get(f.key)?.disabled) {
        if (!Number.isFinite(val)) return { ok: false, field: f };
        if (f.min != null && val < f.min) return { ok: false, field: f };
        if (f.max != null && val > f.max) return { ok: false, field: f };
      }
    }
    return { ok: true };
  };
  const rows = [];
  for (const f of fields) {
    if (f.type === 'heading') {
      rows.push(h('h3.form-heading', f.label));
      continue;
    }
    const id = `f-${counter}-${++fid}`;
    let input;
    let row;
    if (f.type === 'checkbox') {
      input = h('input', { type: 'checkbox', id, checked: Boolean(f.value) });
      inputs.set(f.key, input);
      row = h('div.form-row.check', input, h('label', { for: id }, f.label));
      const prev = rows[rows.length - 1];
      if (f.inline && prev?.classList.contains('form-inline')) prev.append(row);
      else if (f.inline && prev?.classList.contains('check')) rows[rows.length - 1] = h('div.form-inline', prev, row);
      else rows.push(row);
      rowsByKey.set(f.key, row);
      continue;
    }
    if (f.type === 'select') {
      input = h('select', { id }, f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)));
    } else if (f.type === 'radio') {
      input = h(
        'div.radio-group',
        { role: 'radiogroup', 'aria-labelledby': `${id}-l` },
        f.options.map((o, i) => h('label.radio', h('input', { type: 'radio', name: id, value: o.value, checked: o.value === f.value || (!f.value && i === 0) }), o.label)),
      );
      inputs.set(f.key, input);
      row = h('div.form-row', h('span.form-label', { id: `${id}-l` }, f.label), input);
      rowsByKey.set(f.key, row);
      rows.push(row);
      continue;
    } else if (f.type === 'refpoint') {
      const picker = refPointPicker({ value: f.value, label: f.label });
      input = picker.el;
      input._picker = picker;
      inputs.set(f.key, input);
      row = h('div.form-row', h('span.form-label', f.label), input);
      rowsByKey.set(f.key, row);
      rows.push(row);
      continue;
    } else if (f.type === 'range') {
      const out = h('output.range-out', { for: id }, String(f.value));
      input = h('input', { type: 'range', id, min: f.min ?? 0, max: f.max ?? 100, step: f.step ?? 1, value: f.value, oninput: () => (out.textContent = input.value) });
      inputs.set(f.key, input);
      row = h('div.form-row', h('label', { for: id }, f.label), h('div.range-wrap', input, out));
      rowsByKey.set(f.key, row);
      rows.push(row);
      continue;
    } else if (f.type === 'color') {
      input = h('input', { type: 'color', id, value: f.value || '#000000' });
    } else if (f.type === 'textarea') {
      input = h('textarea', { id, rows: f.rows || 4 }, f.value ?? '');
    } else {
      input = h('input', {
        type: 'text',
        id,
        value: NUMERIC.includes(f.type) ? showValue(f, f.value, unit) : (f.value ?? ''),
        inputmode: NUMERIC.includes(f.type) ? 'decimal' : undefined,
        spellcheck: false,
        autocomplete: 'off',
        'aria-describedby': f.help ? `${id}-help` : undefined,
      });
      if (NUMERIC.includes(f.type)) {
        // Arrow keys step the value (Shift for 10x).
        input.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          const step = (f.step ?? 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
          if (f.type === 'length') {
            const cur = parseLength(input.value, unit);
            if (Number.isFinite(cur)) input.value = formatLength(cur + step * (UNITS[unit]?.factor || 1), unit);
          } else {
            const cur = parseNumber(input.value);
            if (Number.isFinite(cur)) {
              const v = cur + step;
              input.value = f.type === 'angle' ? `${v}°` : f.type === 'percent' ? `${v}%` : String(v);
            }
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        input.addEventListener('blur', () => {
          const v = f.type === 'length' ? parseLength(input.value, unit) : parseNumber(input.value);
          if (Number.isFinite(v)) input.value = showValue(f, v, unit);
        });
      }
    }
    inputs.set(f.key, input);
    let control = input;
    if (f.dial && f.type === 'angle') {
      const dial = angleDial({
        value: f.value ?? 0,
        label: f.label,
        onChange: (v) => {
          input.value = showValue(f, v, unit);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        },
      });
      input.addEventListener('input', () => {
        const v = parseNumber(input.value);
        if (Number.isFinite(v)) dial.set(v, false);
      });
      dials.set(f.key, dial);
      control = h('div.range-wrap.dial-field', dial.el, input);
    } else if (f.slider && NUMERIC.includes(f.type)) {
      const factor = f.type === 'length' ? UNITS[unit]?.factor || 1 : 1;
      const s = h('input', { type: 'range', min: f.slider[0], max: f.slider[1], step: f.sliderStep ?? 'any', 'aria-label': `${f.label} slider`, tabindex: '-1' });
      sliders.set(f.key, s);
      s.addEventListener('input', () => {
        const v = Number(s.value) * factor;
        input.value = showValue(f, Number(v.toFixed(4)), unit);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      input.addEventListener('input', () => syncSlider(f));
      control = h('div.range-wrap.slider-field', s, input);
    }
    row = h('div.form-row', h('label', { for: id }, f.label), control, f.help ? h('p.form-help', { id: `${id}-help` }, f.help) : null);
    rowsByKey.set(f.key, row);
    rows.push(row);
  }
  for (const f of fields) if (f.slider) syncSlider(f);
  const error = h('p.form-error', { role: 'alert' });
  const body = h('div.form', description ? h('p.form-description', description) : null, rows, error);
  // Linked fields: a field's own hook runs before previews read the values.
  const fieldOf = (target) => fields.find((f) => {
    const el = inputs.get(f.key);
    return el && (el === target || el.contains?.(target));
  });
  const onEdit = (e) => {
    const f = fieldOf(e.target);
    if (f?.onInput) {
      const v = readOne(f);
      if (!NUMERIC.includes(f.type) || Number.isFinite(v)) f.onInput(v, form);
    }
    syncDisabled();
  };
  body.addEventListener('input', onEdit);
  body.addEventListener('change', onEdit);
  if (onChange) body.addEventListener('input', () => valid().ok && onChange(read()));
  if (onChange) body.addEventListener('change', () => valid().ok && onChange(read()));
  syncDisabled();
  const validate = () => {
    const r = valid();
    if (!r.ok) {
      error.textContent = `Enter a valid value for ${r.field.label}.`;
      inputs.get(r.field.key)?.focus();
      return false;
    }
    error.textContent = '';
    return true;
  };
  return openDialog({
    title,
    body,
    className,
    buttons: [
      ...extraButtons.map((b) => ({ ...b, value: () => ({ ...read(), __action: b.action }), validate })),
      { label: 'Cancel', value: null },
      { label: okLabel, primary: true, value: () => read(), validate },
    ],
    onOpen: () => {
      if (previewToggle && onChange) onChange(read());
    },
  });
}

export function confirmDialog({ title, message, okLabel = 'OK', cancelLabel = 'Cancel', danger = false, extra = null }) {
  return openDialog({
    title,
    body: h('p.dialog-message', message),
    buttons: [...(extra ? [{ label: extra.label, value: extra.value, left: true }] : []), { label: cancelLabel, value: false }, { label: okLabel, value: true, primary: !danger, danger }],
  });
}

export function alertDialog({ title, message }) {
  return openDialog({ title, body: h('p.dialog-message', message), buttons: [{ label: 'OK', value: true, primary: true }] });
}
