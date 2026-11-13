// Building blocks for effect dialogs whose body is laid out by hand (tabs,
// group boxes, vertical faders, radio choices, readouts) instead of the
// generated parameter grid. Every helper takes the dialog ctx
// ({ values, set(id, v), subscribe(fn), def }) and keeps itself in sync with
// the values, so a control can live anywhere in a custom body.

import { h } from '../lib/dom.js';
import { hotNumber } from '../ui/controls.js';
import { paramControls } from './dialog.js';
import { toPosition, fromPosition, formatValue, parseValue, editValueText } from './params.js';

const param = (ctx, id) => ctx.def.params.find((p) => p.id === id);

/** The generated rows (sliders, checkboxes, choices) for just `ids`, in that order; `labels` renames rows. */
export function controlsFor(ctx, ids, { className = '', labels = {} } = {}) {
  const params = ids.map((id) => param(ctx, id)).filter(Boolean).map((p) => ({ ...p, label: labels[p.id] ?? p.label, hidden: false, section: undefined }));
  // The id this block just set, so its own curve and envelope editors are not reset mid-drag.
  let from = null;
  const c = paramControls({ ...ctx.def, params }, () => ctx.values, (id, v) => {
    from = id;
    ctx.set(id, v);
    from = null;
  }, { doc: ctx.doc, range: ctx.range });
  ctx.subscribe((values) => c.refresh(values, from));
  if (className) c.el.classList.add(...className.split(' '));
  return c.el;
}

/** The generated frames of whole sections, laid out by the definition's `layout` (vertical sliders, knobs). */
export function sectionControls(ctx, sections) {
  let from = null;
  const c = paramControls(ctx.def, () => ctx.values, (id, v) => {
    from = id;
    ctx.set(id, v);
    from = null;
  }, { doc: ctx.doc, range: ctx.range, sections, layout: { ...(ctx.def.layout || {}), columns: undefined, tabs: undefined } });
  ctx.subscribe((values) => c.refresh(values, from));
  return c.el;
}

/** A titled box (a fieldset) around related controls. */
export function groupBox(title, ...children) {
  return h('fieldset.fx-group', title ? h('legend.fx-group-title', title) : null, ...children);
}

/**
 * A tab strip over panels. tabs: [{ label, content }]. Arrow keys move between
 * tabs. Returns { el, select(i), selected() }.
 */
export function tabPanels(tabs, { selected = 0, label = 'Settings', onSelect } = {}) {
  let current = Math.min(Math.max(0, selected), tabs.length - 1);
  const uid = `fxtab${Math.random().toString(36).slice(2, 8)}`;
  const buttons = tabs.map((t, i) =>
    h('button.fx-tab', {
      type: 'button',
      role: 'tab',
      id: `${uid}-t${i}`,
      'aria-controls': `${uid}-p${i}`,
      onclick: () => select(i, true),
      onkeydown: (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        e.stopPropagation();
        select((current + d + tabs.length) % tabs.length, true);
      },
    }, t.label),
  );
  const panels = tabs.map((t, i) => h('div.fx-tab-panel', { role: 'tabpanel', id: `${uid}-p${i}`, 'aria-labelledby': `${uid}-t${i}` }, t.content));
  function select(i, focus = false) {
    current = i;
    buttons.forEach((b, k) => {
      b.setAttribute('aria-selected', String(k === i));
      b.tabIndex = k === i ? 0 : -1;
    });
    panels.forEach((p, k) => (p.hidden = k !== i));
    if (focus) buttons[i].focus();
    onSelect?.(i);
  }
  select(current);
  const el = h('div.fx-tabs', h('div.fx-tablist', { role: 'tablist', 'aria-label': label }, buttons), panels);
  el.select = select;
  el.selected = () => current;
  return el;
}

/**
 * A vertical fader for a number param: the slider with the value under it.
 * Log params move along their log scale like the horizontal sliders.
 */
export function vSlider(ctx, id, { label } = {}) {
  const p = param(ctx, id);
  const name = p.label;
  const shown = label ?? p.label;
  const slider = h('input.slider.fx-vrange', {
    type: 'range',
    min: 0,
    max: 1000,
    step: 1,
    'aria-label': name,
    oninput: () => ctx.set(id, fromPosition(p, Number(slider.value) / 1000)),
  });
  const hot = hotNumber({
    value: ctx.values[id],
    min: p.min,
    max: p.max,
    step: p.step || 1,
    label: name,
    pixelsPerStep: Math.max(0.01, (240 * (p.step || 1)) / ((p.max ?? 1) - (p.min ?? 0) || 1)),
    format: (v) => formatValue(p, v),
    editText: (v) => editValueText(p, v),
    parse: (s) => parseValue(p, s),
    onInput: (v) => ctx.set(id, v),
    onChange: (v) => ctx.set(id, v),
    defaultValue: p.default,
  });
  const show = (values) => {
    const v = values[id];
    slider.value = String(Math.round(toPosition(p, v) * 1000));
    slider.setAttribute('aria-valuetext', formatValue(p, v));
    hot.setValue(v);
  };
  show(ctx.values);
  ctx.subscribe(show);
  return h('div.fx-vfader', shown ? h('div.fx-vfader-label', shown) : null, slider, h('div.fx-vfader-value', hot));
}

/**
 * Radio buttons for a choice param (Vocal Enhancer modes, scales). `icons`
 * optionally maps option values to elements drawn instead of the label text
 * (the label stays as the accessible name and tooltip).
 */
export function radioChoice(ctx, id, { label, icons = null, className = '' } = {}) {
  const p = param(ctx, id);
  const name = `${id}-${Math.random().toString(36).slice(2, 8)}`;
  const inputs = [];
  const items = (p.options || []).map((o) => {
    const input = h('input', { type: 'radio', name, value: String(o.value), onchange: () => input.checked && ctx.set(id, o.value) });
    inputs.push(input);
    const icon = icons?.[o.value];
    return h(`label.fx-radio${icon ? '.fx-radio-icon' : ''}`, { title: icon ? o.label : null }, input, icon || o.label, icon ? h('span.sr-only', o.label) : null);
  });
  const show = (values) => inputs.forEach((i) => (i.checked = i.value === String(values[id])));
  show(ctx.values);
  ctx.subscribe(show);
  const group = h(`div.fx-radios${className ? `.${className}` : ''}`, { role: 'radiogroup', 'aria-label': label ?? p.label }, items);
  return label === null ? group : h('div.fx-radio-row', h('span.fx-label', `${label ?? p.label}:`), group);
}

/** A checkbox for a bool param, outside the generated grid. */
export function checkbox(ctx, id, { label } = {}) {
  const p = param(ctx, id);
  const box = h('input', { type: 'checkbox', onchange: () => ctx.set(id, box.checked) });
  const show = (values) => (box.checked = Boolean(values[id]));
  show(ctx.values);
  ctx.subscribe(show);
  return h('label.check.fx-check', box, label ?? p.label);
}

/** A collapsible section ("Advanced"); its open state is remembered per key in prefs when given. */
export function disclosure(label, content, { open = false, prefs = null, key = null } = {}) {
  const stored = prefs && key ? prefs.get(`fxDisclosure.${key}`) : undefined;
  const el = h('details.fx-disclosure', { open: stored ?? open }, h('summary', label), h('div.fx-disclosure-body', content));
  if (prefs && key) el.addEventListener('toggle', () => prefs.set(`fxDisclosure.${key}`, el.open));
  return el;
}

/** Text kept up to date from the values: fn(values) returns the string. */
export function readout(ctx, fn, className = '') {
  const el = h(`span.fx-readout${className ? `.${className}` : ''}`, { 'aria-live': 'off' });
  const show = (values) => (el.textContent = fn(values));
  show(ctx.values);
  ctx.subscribe(show);
  return el;
}

let blockers = 0;

/**
 * Disables `el`'s controls while when(values) is false (fields that only
 * apply in some modes). Nested conditions combine: a control is enabled only
 * while every enableWhen around it allows it.
 */
export function enableWhen(ctx, el, when) {
  const key = ++blockers;
  const show = (values) => {
    const on = Boolean(when(values));
    el.classList.toggle('fx-disabled', !on);
    el.querySelectorAll('input, select, button, textarea').forEach((c) => {
      c.fxBlocked ??= new Set();
      if (on) c.fxBlocked.delete(key);
      else c.fxBlocked.add(key);
      c.disabled = c.fxBlocked.size > 0;
    });
  };
  show(ctx.values);
  ctx.subscribe(show);
  return el;
}

/** Shows `el` only while when(values) is true. */
export function showWhen(ctx, el, when) {
  const show = (values) => (el.hidden = !when(values));
  show(ctx.values);
  ctx.subscribe(show);
  return el;
}

/** A scrubbable value (drag, type or arrow keys) for a number param, without a slider. */
export function numberField(ctx, id, { label } = {}) {
  const p = param(ctx, id);
  const hot = hotNumber({
    value: ctx.values[id],
    min: p.min,
    max: p.max,
    step: p.step || 1,
    label: label ?? p.label,
    pixelsPerStep: Math.max(0.01, (240 * (p.step || 1)) / ((p.max ?? 1) - (p.min ?? 0) || 1)),
    format: (v) => formatValue(p, v),
    editText: (v) => editValueText(p, v),
    parse: (s) => parseValue(p, s),
    onInput: (v) => ctx.set(id, v),
    onChange: (v) => ctx.set(id, v),
    defaultValue: p.default,
  });
  ctx.subscribe((values) => hot.setValue(values[id]));
  return hot;
}

/** A small line glyph (24 x 24 viewBox, stroked in the text colour) for icon radios and buttons. */
export function glyph(d, size = 18) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const path of [].concat(d)) {
    const el = document.createElementNS(NS, 'path');
    el.setAttribute('d', path);
    svg.append(el);
  }
  return svg;
}
