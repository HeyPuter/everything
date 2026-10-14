// Parameter controls for effect editors: knobs for continuous values, a
// segmented radio group for short option lists and a select for long ones.
// Each returns { el, set(value), def }; changes go through the mixer
// controller (knob drags are one undo step; option picks one step each).

import { h } from '../../lib/dom.js';
import { createKnob } from '../../ui/knob.js';

/** A control for parameter `def` of a slot. `ctx` = { ctl, track, slotId }. */
export function paramControl(ctx, def, value, { size = 36 } = {}) {
  if (def.options && def.options.length <= 4) return segmented(ctx, def, value);
  if (def.options) return selectControl(ctx, def, value);
  const knob = createKnob({ param: def, value, size, label: def.label, ...ctx.ctl.paramGesture(ctx.track, ctx.slotId, def) });
  knob.el.classList.add('fxw-knob');
  knob.el.dataset.param = def.id;
  return { el: knob.el, set: (v) => knob.set(v), def };
}

function segmented(ctx, def, value) {
  const buttons = def.options.map((o, i) => h('button', { type: 'button', role: 'radio', tabindex: '-1', dataset: { value: String(i) } }, o));
  const group = h('div.seg', { role: 'radiogroup', 'aria-label': def.label }, ...buttons);
  const el = h('div.fxw-field', { dataset: { param: def.id } }, h('span.fxw-field-label', { 'aria-hidden': 'true' }, def.label), group);
  let v = value;
  const draw = () => {
    buttons.forEach((b, i) => {
      const on = i === Math.round(v);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  };
  const pick = (i) => {
    if (i === Math.round(v)) return;
    v = i;
    draw();
    ctx.ctl.setParam(ctx.track, ctx.slotId, def, i);
  };
  buttons.forEach((b, i) => b.addEventListener('click', () => pick(i)));
  group.addEventListener('keydown', (e) => {
    const dir = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    const n = (Math.round(v) + dir + buttons.length) % buttons.length;
    pick(n);
    buttons[n].focus();
  });
  draw();
  return {
    el,
    def,
    set(next) {
      if (Math.round(next) === Math.round(v)) return;
      v = next;
      draw();
    },
  };
}

function selectControl(ctx, def, value) {
  const sel = h('select.select.sm', { 'aria-label': def.label }, ...def.options.map((o, i) => h('option', { value: String(i) }, o)));
  sel.value = String(Math.round(value));
  sel.addEventListener('change', () => ctx.ctl.setParam(ctx.track, ctx.slotId, def, Number(sel.value)));
  const el = h('label.fxw-field', { dataset: { param: def.id } }, h('span.fxw-field-label', def.label), sel);
  return {
    el,
    def,
    set(next) {
      const s = String(Math.round(next));
      if (sel.value !== s) sel.value = s;
    },
  };
}

/** Groups a parameter list by `group` (in first-seen order); ungrouped params share one group. */
export function groupParams(params) {
  const out = new Map();
  for (const p of params) {
    const g = p.group || '';
    if (!out.has(g)) out.set(g, []);
    out.get(g).push(p);
  }
  return out;
}

/**
 * A 2D canvas sized to its box at device pixel ratio. `draw(ctx, w, h)` runs
 * on redraw(); the canvas redraws itself on resize and theme changes.
 */
export function createCanvas(className, draw) {
  const canvas = h(`canvas.${className}`, { 'aria-hidden': 'true' });
  const ctx2 = canvas.getContext('2d');
  let w = 0;
  let hh = 0;
  const redraw = () => {
    if (!ctx2) return;
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.round(r.width) || Number(canvas.dataset.w) || 300;
    const ch = Math.round(r.height) || Number(canvas.dataset.h) || 150;
    if (cw !== w || ch !== hh || canvas.width !== Math.round(cw * dpr)) {
      w = cw;
      hh = ch;
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2.clearRect(0, 0, w, hh);
    draw(ctx2, w, hh);
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => redraw()) : null;
  ro?.observe(canvas);
  const onTheme = () => redraw();
  window.addEventListener('themechange', onTheme);
  return {
    canvas,
    redraw,
    size: () => ({ w, h: hh }),
    destroy() {
      ro?.disconnect();
      window.removeEventListener('themechange', onTheme);
    },
  };
}
