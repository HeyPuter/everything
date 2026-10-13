/**
 * Effect dialogs: the shared session (live preview inside one open
 * transaction, OK commits it as one undo step, Cancel rolls it back) and the
 * controls the dialogs are built from (slider + field pairs, choice rows,
 * check boxes, a reference point picker).
 */
import { h } from '../../lib/dom.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { formatLength, parseLength, parseNumber } from '../../lib/units.js';
import { EFFECTS, normalizeEffect, createEffect } from '../paint/effects-model.js';
import { effectTargets, rememberEffect, effectsOf, effectsPatch } from '../paint/effects-ui.js';
import { effectItemIndex } from '../paint/appearance-ops.js';
import { selectionBounds } from '../../model/geometry.js';

let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

/** Remember whether dialogs preview (shared by every effect dialog). */
function previewPref(app, v) {
  if (v === undefined) return app.prefs?.get?.('effectPreview') ?? true;
  app.prefs?.set?.('effectPreview', v);
  return v;
}

/**
 * Open an effect dialog.
 *   type     effect record type
 *   params   values to start from (merged over the last used ones)
 *   edit     { id, index, item? }: edit that object's existing effect (of
 *            its appearance item `item`)
 *   build(ctx) -> { body, read() -> params, validate?() -> bool, focus? }
 *            ctx: { start, unit, bounds, doc, app, changed() }
 * Resolves true when the effect was applied.
 */
export async function openEffectDialog(app, type, { params = null, edit = null, title = null, build, className = '' }) {
  const ed = app.editor;
  if (!ed) return false;
  const doc = ed.doc;
  const def = EFFECTS[type];
  const targets = edit ? [doc.get(edit.id)].filter(Boolean) : effectTargets(ed);
  if (!targets.length) {
    app.notify('Select an object to apply the effect to.');
    return false;
  }
  // Effects go to the object, or to the fill or stroke picked in the Appearance panel (edit.item).
  const slot = edit ? edit.item ?? null : effectItemIndex(ed);
  const existing = edit ? effectsOf(targets[0], slot)[edit.index] : null;
  const base = existing || app.lastEffects?.[type] || def.defaults;
  let start = normalizeEffect({ ...base, ...(params || {}), type });
  // A new Roughen or Scribble gets its own randomness unless repeating a known one.
  if (!existing && !params?.seed && def.init) start = createEffect(type, { ...start, seed: 0 });
  const originals = new Map(targets.map((n) => [n.id, effectsOf(n, slot)]));
  const tx = doc.begin(def.label);
  const apply = (fx) => {
    for (const [id, orig] of originals) {
      let list;
      if (edit) {
        list = orig.slice();
        list[edit.index] = fx ? { ...fx, ...(orig[edit.index]?.hidden ? { hidden: true } : {}) } : orig[edit.index];
      } else list = fx ? [...orig, fx] : orig;
      doc.update(id, effectsPatch(doc.get(id), slot, list));
    }
  };
  let preview = previewPref(app);
  let ui = null;
  const read = () => normalizeEffect({ ...start, ...ui.read(), type });
  // Previews update the records right away; the canvas coalesces the redraws.
  const refresh = () => {
    if (!ui) return;
    if (ui.validate && !ui.validate()) return;
    apply(preview ? read() : null);
  };
  const changed = refresh;
  const ctx = {
    start,
    app,
    doc,
    targets,
    unit: doc.root.units || 'pt',
    bounds: selectionBounds(doc, targets.map((n) => n.id), false) || { x: 0, y: 0, w: 100, h: 100 },
    changed,
  };
  ui = build(ctx);
  const previewBox = h('input', { type: 'checkbox', id: nextId('fx-preview'), checked: preview });
  previewBox.addEventListener('change', () => {
    preview = previewPref(app, previewBox.checked);
    refresh();
  });
  const previewRow = h('label.fx-preview-toggle', { for: previewBox.id }, previewBox, 'Preview');
  let res = null;
  try {
    res = await openDialog({
      title: title || def.label,
      className: `fx-dialog ${className}`.trim(),
      body: ui.body,
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'OK', primary: true, value: () => read(), validate: () => !ui.validate || ui.validate() },
      ],
      initialFocus: ui.focus,
      onOpen: ({ footer }) => {
        footer.prepend(previewRow);
        refresh();
      },
    });
  } catch (err) {
    tx.cancel();
    throw err;
  }
  if (!res) {
    tx.cancel();
    return false;
  }
  apply(res);
  tx.commit();
  app.lastEffects = { ...(app.lastEffects || {}), [type]: res };
  rememberEffect(app, res);
  return true;
}

/** Add an effect without a dialog (Outline Stroke, Crop Marks, Pathfinder effects). */
export function addEffectNow(app, type, params = {}) {
  const ed = app.editor;
  if (!ed) return false;
  const targets = effectTargets(ed);
  if (!targets.length) {
    app.notify('Select an object to apply the effect to.');
    return false;
  }
  const fx = createEffect(type, params);
  const slot = effectItemIndex(ed);
  ed.doc.transact(EFFECTS[type].describe?.(fx) || EFFECTS[type].label, () => {
    for (const n of targets) ed.doc.update(n.id, effectsPatch(n, slot, [...effectsOf(n, slot), { ...fx }]));
  });
  rememberEffect(app, fx);
  return true;
}

// ---- controls ----

const fmt = (kind, v, unit) => {
  if (!Number.isFinite(v)) return '';
  if (kind === 'length') return formatLength(v, unit);
  if (kind === 'percent') return `${Number(v.toFixed(1))}%`;
  if (kind === 'angle') return `${Number(v.toFixed(2))}°`;
  return String(Number(v.toFixed(3)));
};
const parse = (kind, s, unit) => (kind === 'length' ? parseLength(s, unit) : parseNumber(s));

/**
 * A labeled slider with a text field. kind: 'percent' | 'length' |
 * 'angle' | 'number'. The slider spans [min, max]; the field accepts any
 * value in [fieldMin, fieldMax] (defaults to the slider range). Values are
 * in display units (percent as 0-100, lengths in points).
 */
export function sliderField({ label, value, min, max, step = 1, kind = 'number', unit = 'pt', fieldMin = min, fieldMax = max, onInput, ends = null, integer = false }) {
  const id = nextId('fx-sl');
  let cur = value;
  // The text field is the accessible control; the slider is a pointer shortcut for it.
  const range = h('input.fx-range', { type: 'range', min, max, step, value: Math.min(max, Math.max(min, value)), 'aria-hidden': 'true', tabindex: '-1' });
  const field = h('input.fx-num', { type: 'text', id, inputmode: 'decimal', spellcheck: false, autocomplete: 'off', value: fmt(kind, value, unit) });
  const clampV = (v) => {
    let x = Math.min(fieldMax, Math.max(fieldMin, v));
    if (integer) x = Math.round(x);
    return x;
  };
  const set = (v, from) => {
    cur = clampV(v);
    if (from !== 'range') range.value = String(Math.min(max, Math.max(min, cur)));
    if (from !== 'field') field.value = fmt(kind, cur, unit);
    field.removeAttribute('aria-invalid');
  };
  range.addEventListener('input', () => {
    set(Number(range.value), 'range');
    onInput?.(cur);
  });
  field.addEventListener('input', () => {
    const v = parse(kind, field.value, unit);
    if (!Number.isFinite(v)) {
      field.setAttribute('aria-invalid', 'true');
      return;
    }
    set(v, 'field');
    onInput?.(cur);
  });
  field.addEventListener('change', () => set(cur));
  field.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const base = Number.isFinite(parse(kind, field.value, unit)) ? parse(kind, field.value, unit) : cur;
    set(base + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
    onInput?.(cur);
  });
  const endLabels = ends ? h('div.fx-range-ends', { 'aria-hidden': 'true' }, h('span', ends[0]), h('span', ends[1])) : null;
  const el = h('div.fx-row', h('label.fx-label', { id: `${id}-l`, for: id }, label), h('div.fx-slider', range, endLabels), field);
  return { el, get: () => cur, set: (v) => set(v), field, range };
}

/** A labeled set of radio buttons. */
export function choiceField({ label, value, options, onChange }) {
  const id = nextId('fx-ch');
  const inputs = options.map((o) => {
    const input = h('input', { type: 'radio', name: id, value: o.value, checked: o.value === value });
    input.addEventListener('change', () => input.checked && onChange?.(o.value));
    return h('label.radio', input, o.label);
  });
  const group = h('div.radio-group', { role: 'radiogroup', 'aria-labelledby': `${id}-l` }, inputs);
  const el = h('div.fx-row.fx-choice', h('span.fx-label', { id: `${id}-l` }, label), group);
  return {
    el,
    get: () => group.querySelector('input:checked')?.value ?? value,
    set: (v) => {
      for (const i of group.querySelectorAll('input')) i.checked = i.value === v;
    },
  };
}

export function checkField({ label, value, onChange }) {
  const input = h('input', { type: 'checkbox', checked: Boolean(value) });
  input.addEventListener('change', () => onChange?.(input.checked));
  const el = h('label.fx-check', input, label);
  return { el, get: () => input.checked, set: (v) => (input.checked = Boolean(v)), input };
}

export function selectRow({ label, value, options, onChange }) {
  const id = nextId('fx-sel');
  const sel = h('select.select', { id }, options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  sel.addEventListener('change', () => onChange?.(sel.value));
  const el = h('div.fx-row.fx-select', h('label.fx-label', { for: id }, label), sel);
  return { el, get: () => sel.value, set: (v) => (sel.value = v), select: sel };
}

/** A plain number or length field row (no slider). */
export function numberRow({ label, value, kind = 'number', unit = 'pt', min = -Infinity, max = Infinity, step = 1, integer = false, onInput }) {
  const id = nextId('fx-n');
  let cur = value;
  const field = h('input.fx-num', { type: 'text', id, inputmode: 'decimal', spellcheck: false, autocomplete: 'off', value: fmt(kind, value, unit) });
  const set = (v, fromField) => {
    cur = Math.min(max, Math.max(min, integer ? Math.round(v) : v));
    if (!fromField) field.value = fmt(kind, cur, unit);
  };
  field.addEventListener('input', () => {
    const v = parse(kind, field.value, unit);
    if (!Number.isFinite(v)) {
      field.setAttribute('aria-invalid', 'true');
      return;
    }
    field.removeAttribute('aria-invalid');
    set(v, true);
    onInput?.(cur);
  });
  field.addEventListener('change', () => set(cur));
  field.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    set(cur + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
    onInput?.(cur);
  });
  const el = h('div.fx-row.fx-plain', h('label.fx-label', { for: id }, label), field);
  return { el, get: () => cur, set: (v) => set(v), field };
}

/** A titled group of rows. */
export function group(title, ...rows) {
  return h('fieldset.fx-group', h('legend', title), ...rows);
}

/**
 * A 3x3 reference point picker (origin fractions [x, y] in 0, 0.5, 1).
 * Arrow keys move the choice.
 */
export function originPicker({ value = [0.5, 0.5], onChange, label = 'Reference point' }) {
  let cur = value;
  const pts = [0, 0.5, 1];
  const names = { 0: ['Left', 'Top'], 0.5: ['Center', 'Middle'], 1: ['Right', 'Bottom'] };
  const cells = [];
  const grid = h('div.fx-origin', { role: 'radiogroup', 'aria-label': label });
  const select = (v, focus = false, notify = true) => {
    cur = v;
    for (const c of cells) {
      const on = c.v[0] === v[0] && c.v[1] === v[1];
      c.el.setAttribute('aria-checked', String(on));
      c.el.tabIndex = on ? 0 : -1;
      if (on && focus) c.el.focus();
    }
    if (notify) onChange?.(v);
  };
  for (const y of pts) {
    for (const x of pts) {
      const v = [x, y];
      const nm = x === 0.5 && y === 0.5 ? 'Center' : `${names[y][1]} ${names[x][0]}`;
      const el = h('button.fx-origin-pt', { type: 'button', role: 'radio', 'aria-label': nm, 'data-tip': nm, onclick: () => select(v) });
      el.addEventListener('keydown', (e) => {
        const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        const dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
        if (!dx && !dy) return;
        e.preventDefault();
        const i = Math.min(2, Math.max(0, pts.indexOf(cur[0]) + dx));
        const j = Math.min(2, Math.max(0, pts.indexOf(cur[1]) + dy));
        select([pts[i], pts[j]], true);
      });
      cells.push({ v, el });
      grid.append(el);
    }
  }
  select(cur, false, false);
  return { el: grid, get: () => cur, set: (v) => select(v, false, false) };
}
