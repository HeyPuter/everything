// Reusable value controls.
//  hotNumber: a scrubbable value drawn as accent text. Drag sideways to change,
//             click to type, arrows/Page keys to step. role=spinbutton.
//  knob:      a rotary control for gain and pan; drag vertically, double-click
//             resets, arrows step. role=slider.

import { h } from '../lib/dom.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function roundTo(v, step) {
  if (!step) return v;
  const r = Math.round(v / step) * step;
  // The step's magnitude is not its precision: log fields use 0.0025.
  // Keep fractional steps intact while removing floating-point arithmetic noise.
  return Number(r.toFixed(10));
}

/**
 * @param {object} o
 * @param {number} o.value
 * @param {number} [o.min] @param {number} [o.max] @param {number} [o.step]
 * @param {(v:number)=>string} [o.format] display text
 * @param {(s:string)=>number} [o.parse] typed text to value (NaN rejects)
 * @param {(v:number)=>void} [o.onInput] live updates while dragging
 * @param {(v:number)=>void} [o.onChange] committed value
 * @param {string} o.label accessible name
 * @param {number} [o.pixelsPerStep] drag sensitivity
 */
export function hotNumber({ value, min = -Infinity, max = Infinity, step = 1, format = (v) => String(v), parts = null, editText = null, parse = Number, onInput, onChange, label, pixelsPerStep = 2, defaultValue }) {
  let current = value;
  const btn = h('button.hot', { type: 'button', role: 'spinbutton', 'aria-label': label });
  // parts(v) => [number, unit] shows the unit in a quieter style after the number.
  const show = () => {
    if (parts) {
      const [num, unit] = parts(current);
      btn.replaceChildren(h('span.hot-num', num), ...(unit ? [' ', h('span.hot-unit', unit)] : []));
    } else btn.textContent = format(current);
    if (Number.isFinite(current)) btn.setAttribute('aria-valuenow', String(current));
    btn.setAttribute('aria-valuetext', format(current));
    if (Number.isFinite(min)) btn.setAttribute('aria-valuemin', String(min));
    if (Number.isFinite(max)) btn.setAttribute('aria-valuemax', String(max));
  };
  const set = (v, commit) => {
    v = clamp(roundTo(v, step), min, max);
    if (!Number.isFinite(v)) return;
    const changed = v !== current;
    current = v;
    show();
    if (changed || commit) (commit ? onChange : onInput)?.(v);
  };
  show();

  let drag = null;
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || btn.disabled) return;
    e.preventDefault();
    btn.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, start: current, moved: false };
  });
  btn.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 3) return;
    drag.moved = true;
    const mult = e.shiftKey ? 10 : e.altKey || e.metaKey ? 0.1 : 1;
    set(drag.start + (dx / pixelsPerStep) * step * mult, false);
  });
  const end = (e) => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) onChange?.(current);
    else if (e.type === 'pointerup') edit();
  };
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
  btn.addEventListener('keydown', (e) => {
    const big = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') set(current + step * big, true);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') set(current - step * big, true);
    else if (e.key === 'PageUp') set(current + step * 10, true);
    else if (e.key === 'PageDown') set(current - step * 10, true);
    else if (e.key === 'Home' && Number.isFinite(min)) set(min, true);
    else if (e.key === 'End' && Number.isFinite(max)) set(max, true);
    else if (e.key === 'Enter' || e.key === 'F2') edit();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  btn.addEventListener('dblclick', () => {
    if (defaultValue !== undefined) set(defaultValue, true);
  });

  function edit() {
    const input = h('input.hot-edit', { type: 'text', value: editText ? editText(current) : format(current).replace(/\s*(dB|%|Hz|ms|s)$/i, ''), 'aria-label': label });
    btn.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = (commit) => {
      if (finished) return;
      finished = true;
      if (commit) {
        const v = parse(input.value);
        if (Number.isFinite(v)) set(v, true);
      }
      input.replaceWith(btn);
      btn.focus();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  btn.setValue = (v) => {
    current = v;
    show();
  };
  btn.getValue = () => current;
  return btn;
}

/**
 * Rotary knob.
 * @param {object} o same value options as hotNumber, plus `bipolar` (arc from centre)
 */
export function knob({ value, min = 0, max = 1, step = 0.01, defaultValue = value, format = (v) => String(v), onInput, onChange, label, bipolar = false, size = 22 }) {
  let current = value;
  const el = h('button.knob', { type: 'button', role: 'slider', 'aria-label': label, style: { width: `${size}px`, height: `${size}px` } });
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const ring = document.createElementNS(NS, 'circle');
  ring.setAttribute('cx', '12');
  ring.setAttribute('cy', '12');
  ring.setAttribute('r', '9');
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', 'currentColor');
  ring.setAttribute('stroke-width', '1.5');
  ring.setAttribute('opacity', '0.5');
  const arc = document.createElementNS(NS, 'path');
  arc.setAttribute('fill', 'none');
  arc.setAttribute('stroke', 'var(--hot)');
  arc.setAttribute('stroke-width', '2.5');
  arc.setAttribute('stroke-linecap', 'round');
  const tick = document.createElementNS(NS, 'line');
  tick.setAttribute('stroke', 'currentColor');
  tick.setAttribute('stroke-width', '2');
  tick.setAttribute('stroke-linecap', 'round');
  svg.append(ring, arc, tick);
  el.append(svg);

  const A0 = -135;
  const A1 = 135;
  const angleOf = (v) => A0 + ((v - min) / (max - min || 1)) * (A1 - A0);
  const pt = (deg, r) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [12 + r * Math.cos(a), 12 + r * Math.sin(a)];
  };
  const show = () => {
    const a = angleOf(clamp(current, min, max));
    const from = bipolar ? angleOf(clamp(0, min, max)) : A0;
    const [x0, y0] = pt(Math.min(from, a), 9);
    const [x1, y1] = pt(Math.max(from, a), 9);
    const large = Math.abs(a - from) > 180 ? 1 : 0;
    arc.setAttribute('d', Math.abs(a - from) < 0.5 ? '' : `M${x0} ${y0}A9 9 0 ${large} 1 ${x1} ${y1}`);
    const [tx, ty] = pt(a, 7);
    const [cx, cy] = pt(a, 2.5);
    tick.setAttribute('x1', String(cx));
    tick.setAttribute('y1', String(cy));
    tick.setAttribute('x2', String(tx));
    tick.setAttribute('y2', String(ty));
    el.setAttribute('aria-valuenow', String(current));
    el.setAttribute('aria-valuemin', String(min));
    el.setAttribute('aria-valuemax', String(max));
    el.setAttribute('aria-valuetext', format(current));
    el.title = `${label}: ${format(current)}`;
  };
  const set = (v, commit) => {
    v = clamp(roundTo(v, step), min, max);
    const changed = v !== current;
    current = v;
    show();
    if (changed || commit) (commit ? onChange : onInput)?.(v);
  };
  show();

  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, x: e.clientX, start: current };
    el.focus();
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const d = drag.y - e.clientY + (e.clientX - drag.x);
    const range = max - min;
    const fine = e.shiftKey ? 0.2 : 1;
    set(drag.start + (d / 150) * range * fine, false);
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    onChange?.(current);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => set(defaultValue, true));
  el.addEventListener('keydown', (e) => {
    const big = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') set(current + step * big, true);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') set(current - step * big, true);
    else if (e.key === 'Home') set(min, true);
    else if (e.key === 'End') set(max, true);
    else if (e.key === 'Delete' || e.key === 'Backspace') set(defaultValue, true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  el.setValue = (v) => {
    current = v;
    show();
  };
  el.getValue = () => current;
  return el;
}

/** Labelled select. options: [{ value, label }]. */
export function select({ value, options, onChange, label, className = '' }) {
  const el = h(`select.select${className ? `.${className}` : ''}`, { 'aria-label': label, onchange: () => onChange?.(el.value) });
  for (const o of options) el.append(h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label));
  return el;
}

/** Parses "-3.5", "-3.5 dB", "inf" style text into a number. */
export function parseNumber(text) {
  const s = String(text).trim().toLowerCase();
  if (s === '-inf' || s === '-∞') return -Infinity;
  const m = s.match(/^[-+]?\d*\.?\d+(e[-+]?\d+)?/);
  return m ? Number(m[0]) : NaN;
}
