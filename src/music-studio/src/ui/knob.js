// Rotary knob: an ARIA slider. Drag up/down (Shift for fine control), wheel,
// arrows (Shift = fine), Page Up/Down, Home/End, double-click to reset,
// Enter to type a value. Parameter defs come from the catalogs (lib/params.js
// handles curves and formatting).
//
//   const k = createKnob({ param, value, label, onStart, onInput, onEnd })
//   k.set(value)   // update from the model without firing callbacks
//
// onStart() fires before the first change of a gesture, onInput(v) on every
// change, onEnd(v) once at the end (keyboard and wheel gestures end after a
// short pause), which maps to store.begin / preview / commit.

import { h } from '../lib/dom.js';
import { toNorm, fromNorm, formatParam, parseParam } from '../lib/params.js';
import { clamp } from '../lib/util.js';
import { contextMenu, isContextKey } from './menu.js';

const SWEEP = 270; // degrees
const START = 135; // degrees from +x axis, clockwise (7:30 position)

let readout = null;
function showReadout(el, text) {
  if (!readout) {
    readout = h('div.param-readout', { 'aria-hidden': 'true' });
    document.body.append(readout);
  }
  readout.textContent = text;
  readout.hidden = false;
  const r = el.getBoundingClientRect();
  readout.style.left = `${Math.round(r.left + r.width / 2 - readout.offsetWidth / 2)}px`;
  readout.style.top = `${Math.round(r.top - readout.offsetHeight - 6)}px`;
}
function hideReadout() {
  if (readout) readout.hidden = true;
}

function arcPath(cx, cy, r, a0, a1) {
  const rad = (a) => (a * Math.PI) / 180;
  const x0 = cx + r * Math.cos(rad(a0));
  const y0 = cy + r * Math.sin(rad(a0));
  const x1 = cx + r * Math.cos(rad(a1));
  const y1 = cy + r * Math.sin(rad(a1));
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function createKnob({ param, value = param.def, label = param.label, ariaLabel, size = 28, color, showLabel = true, format, onStart, onInput, onEnd, menuItems }) {
  const fmt = format || ((v) => formatParam(param, v));
  const bipolar = param.min < 0 && param.max > 0;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  const mk = (tag, attrs) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    svg.append(n);
    return n;
  };
  mk('path', { class: 'knob-track', d: arcPath(16, 16, 13, START, START + SWEEP), 'stroke-width': '3' });
  const valueArc = mk('path', { class: 'knob-value', 'stroke-width': '3' });
  mk('circle', { class: 'knob-face', cx: '16', cy: '16', r: '9' });
  const pointer = mk('line', { class: 'knob-pointer', x1: '16', y1: '16', x2: '16', y2: '9', 'stroke-width': '2' });

  const el = h('div.knob', {
    role: 'slider',
    tabindex: '0',
    'aria-label': ariaLabel || label,
    'aria-valuemin': String(param.min),
    'aria-valuemax': String(param.max),
    style: color ? { '--knob-color': color } : null,
  });
  el.append(svg);
  if (showLabel && label) el.append(h('span.knob-label', label));

  let v = value;
  let active = false;
  let endTimer = 0;

  const draw = () => {
    const n = toNorm(param, v);
    const a = START + n * SWEEP;
    const zero = bipolar ? START + toNorm(param, 0) * SWEEP : START;
    const [a0, a1] = a >= zero ? [zero, a] : [a, zero];
    valueArc.setAttribute('d', a1 - a0 < 0.5 ? '' : arcPath(16, 16, 13, a0, a1));
    pointer.setAttribute('transform', `rotate(${a + 90} 16 16)`);
    el.setAttribute('aria-valuenow', String(Math.round(v * 1000) / 1000));
    el.setAttribute('aria-valuetext', fmt(v));
    el.title = `${label}: ${fmt(v)}`;
  };

  const begin = () => {
    if (active) return;
    active = true;
    onStart?.();
  };
  const finish = () => {
    clearTimeout(endTimer);
    if (!active) return;
    active = false;
    hideReadout();
    onEnd?.(v);
  };
  const change = (next, { readoutOn = true } = {}) => {
    const val = clamp(param.step ? Math.round(next / param.step) * param.step : next, param.min, param.max);
    if (val === v) return;
    begin();
    v = val;
    draw();
    if (readoutOn) showReadout(el, fmt(v));
    onInput?.(v);
  };
  const setNorm = (n) => change(fromNorm(param, n));
  const deferEnd = () => {
    clearTimeout(endTimer);
    endTimer = setTimeout(finish, 450);
  };

  // Pointer drag: 200px for the full range, 10x finer with Shift.
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    el.setPointerCapture(e.pointerId);
    let lastY = e.clientY;
    let norm = toNorm(param, v);
    showReadout(el, fmt(v));
    const move = (ev) => {
      const dy = lastY - ev.clientY;
      lastY = ev.clientY;
      const range = param.options ? 80 + param.options.length * 12 : 200;
      norm = clamp(norm + dy / (ev.shiftKey ? range * 10 : range), 0, 1);
      setNorm(norm);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      finish();
      hideReadout();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });

  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    change(param.def);
    finish();
  });

  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const steps = param.step ? Math.sign(-e.deltaY) * param.step : 0;
      if (steps) change(v + steps);
      else setNorm(toNorm(param, v) - e.deltaY * (e.shiftKey ? 0.0002 : 0.0015));
      deferEnd();
    },
    { passive: false },
  );

  el.addEventListener('keydown', (e) => {
    const n = toNorm(param, v);
    const fine = e.shiftKey ? 0.002 : 0.01;
    let handled = true;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        if (param.step) change(v + param.step);
        else setNorm(n + fine);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        if (param.step) change(v - param.step);
        else setNorm(n - fine);
        break;
      case 'PageUp':
        setNorm(n + 0.1);
        break;
      case 'PageDown':
        setNorm(n - 0.1);
        break;
      case 'Home':
        change(param.min);
        break;
      case 'End':
        change(param.max);
        break;
      case 'Delete':
      case 'Backspace':
        change(param.def);
        break;
      case 'Enter':
        typeIn();
        break;
      default:
        handled = false;
    }
    if (isContextKey(e)) {
      const r = el.getBoundingClientRect();
      openContext({ clientX: r.left, clientY: r.bottom, preventDefault() {} });
      handled = true;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key !== 'Enter') deferEnd();
    }
  });
  el.addEventListener('blur', () => {
    hideReadout();
    finish();
  });

  function typeIn() {
    const input = h('input.input.sm', { type: 'text', value: fmt(v), 'aria-label': `${label} value`, style: { position: 'fixed', width: '88px', zIndex: 1300 } });
    const r = el.getBoundingClientRect();
    input.style.left = `${Math.round(r.left + r.width / 2 - 44)}px`;
    input.style.top = `${Math.round(r.top - 30)}px`;
    document.body.append(input);
    input.focus();
    input.select();
    let done = false;
    const close = (apply) => {
      if (done) return;
      done = true;
      if (apply) {
        const parsed = parseParam(param, input.value);
        if (parsed !== null) {
          change(parsed, { readoutOn: false });
          finish();
        }
      }
      input.remove();
      el.focus({ preventScroll: true });
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') close(true);
      else if (e.key === 'Escape') close(false);
    });
    input.addEventListener('blur', () => close(true));
  }

  function openContext(e) {
    const items = [
      { label: 'Reset', keys: 'Double-click', run: () => (change(param.def), finish()) },
      { label: 'Type in value...', keys: 'Enter', run: typeIn },
      ...(menuItems ? [{ type: 'sep' }, ...(typeof menuItems === 'function' ? menuItems() : menuItems)] : []),
    ];
    contextMenu(e, items, `${label} options`);
  }
  el.addEventListener('contextmenu', openContext);

  draw();
  return {
    el,
    get: () => v,
    set(next) {
      if (active || next === v) return;
      v = next;
      draw();
    },
  };
}
