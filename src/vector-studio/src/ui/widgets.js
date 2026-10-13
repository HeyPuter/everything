/**
 * Small UI widgets shared by panels and bars: icon buttons with tooltips,
 * numeric fields with units, scrubbing and arithmetic, paint swatches,
 * segmented toggles and selects.
 */
import { h } from '../lib/dom.js';
import { icon } from './icons.js';
import { formatLength, parseLength, parseNumber, UNITS } from '../lib/units.js';

/** Icon-only button with an accessible name and a tooltip (label + shortcut). */
export function iconButton(name, label, onclick, { shortcut = '', pressed = null, className = '', size = 16, disabled = false } = {}) {
  const btn = h(`button.icon-btn${className ? '.' + className.split(' ').join('.') : ''}`, {
    type: 'button',
    'aria-label': label,
    'data-tip': shortcut ? `${label} (${shortcut})` : label,
    'aria-pressed': pressed == null ? null : String(Boolean(pressed)),
    disabled,
    onclick,
  });
  btn.append(icon(name, size));
  return btn;
}

/** CSS previews for paint types that feature modules add: type -> (paint) -> CSS background or null. */
export const paintCssHooks = {};

/** CSS background for a paint preview. */
export function paintCss(paint) {
  if (!paint) return null;
  if (paint.type === 'solid') return paint.color;
  if (paint.type === 'linear' || paint.type === 'radial') {
    const stops = [...paint.stops].sort((a, b) => a.offset - b.offset).map((s) => `${rgba(s.color, s.opacity ?? 1)} ${Math.round(s.offset * 100)}%`);
    return paint.type === 'linear' ? `linear-gradient(${90 - (paint.angle || 0)}deg, ${stops.join(', ')})` : `radial-gradient(circle, ${stops.join(', ')})`;
  }
  return paintCssHooks[paint.type]?.(paint) || null;
}

function rgba(hex, a) {
  if (a >= 1) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** A swatch element showing a paint (None draws the red slash). */
export function paintSwatch(paint, { className = '', mixed = false } = {}) {
  const el = h(`span.paint-swatch${className ? '.' + className : ''}`);
  updatePaintSwatch(el, paint, mixed);
  return el;
}

export function updatePaintSwatch(el, paint, mixed = false) {
  el.classList.toggle('none', !paint && !mixed);
  el.classList.toggle('mixed', mixed);
  el.style.background = mixed ? '' : paintCss(paint) || '';
}

let tipEl = null;
let tipTimer = 0;

/** Global tooltip for [data-tip] elements (hover and keyboard focus). */
export function installTooltips(root = document) {
  // Hidden from assistive tech until shown, then linked to its target so the
  // shortcut in the tip is announced along with the control's name.
  tipEl = h('div.tooltip', { role: 'tooltip', id: 'app-tooltip', 'aria-hidden': 'true' });
  document.body.append(tipEl);
  let owner = null;
  const show = (target) => {
    const text = target.getAttribute('data-tip');
    if (!text || document.documentElement.dataset.tooltips === 'off') return;
    tipEl.textContent = text;
    tipEl.classList.add('show');
    tipEl.removeAttribute('aria-hidden');
    owner = target;
    if (!target.hasAttribute('aria-describedby') && text !== target.getAttribute('aria-label')) target.setAttribute('aria-describedby', tipEl.id);
    const r = target.getBoundingClientRect();
    const tw = tipEl.offsetWidth;
    const th = tipEl.offsetHeight;
    let left = r.right + 8;
    let top = r.top + r.height / 2 - th / 2;
    const placeBelow = target.closest('[data-tip-below]') || r.left > window.innerWidth - tw - 40;
    if (placeBelow || r.width > 60) {
      left = r.left + r.width / 2 - tw / 2;
      top = r.bottom + 6;
    }
    tipEl.style.left = `${Math.max(4, Math.min(window.innerWidth - tw - 4, left))}px`;
    tipEl.style.top = `${Math.max(4, Math.min(window.innerHeight - th - 4, top))}px`;
  };
  const hide = () => {
    clearTimeout(tipTimer);
    tipEl.classList.remove('show');
    tipEl.setAttribute('aria-hidden', 'true');
    if (owner?.getAttribute('aria-describedby') === tipEl.id) owner.removeAttribute('aria-describedby');
    owner = null;
  };
  root.addEventListener('pointerover', (e) => {
    const t = e.target.closest?.('[data-tip]');
    clearTimeout(tipTimer);
    if (!t || e.pointerType === 'touch') return hide();
    tipTimer = setTimeout(() => show(t), 550);
  });
  root.addEventListener('pointerout', (e) => {
    if (e.target.closest?.('[data-tip]')) hide();
  });
  root.addEventListener('focusin', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (t && t.matches(':focus-visible')) {
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => show(t), 300);
    }
  });
  root.addEventListener('focusout', hide);
  root.addEventListener('pointerdown', hide, true);
  root.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
}

/**
 * Numeric field. kind: 'length' (points, shown in `unit`), 'angle',
 * 'percent', 'number'. Commits on Enter/blur; Up/Down step (Shift 10x);
 * dragging the label scrubs the value. `onCommit(value)` gets points/degrees.
 */
export function numberField({ label, kind = 'length', value, unit = 'pt', onCommit, onInput, step = 1, min = -Infinity, max = Infinity, icon: iconName, width, ariaLabel, digits }) {
  const id = `nf-${Math.random().toString(36).slice(2, 8)}`;
  const input = h('input.num-input', { id, type: 'text', inputmode: 'decimal', spellcheck: false, autocomplete: 'off', 'aria-label': ariaLabel || label });
  if (width) input.style.width = width;
  let current = value;
  const fmt = (v) => {
    if (v === 'mixed' || v == null || Number.isNaN(v)) return '';
    if (kind === 'length') return formatLength(v, unit, { digits });
    if (kind === 'angle') return `${Number(v.toFixed(digits ?? 2))}°`;
    if (kind === 'percent') return `${Number(v.toFixed(digits ?? 1))}%`;
    return String(Number(v.toFixed(digits ?? 3)));
  };
  const parse = (s) => (kind === 'length' ? parseLength(s, unit) : parseNumber(s));
  const set = (v) => {
    current = v;
    if (document.activeElement !== input) input.value = fmt(v);
    input.placeholder = v === 'mixed' ? 'Mixed' : '';
  };
  const commit = () => {
    const v = parse(input.value);
    if (!Number.isFinite(v)) {
      input.value = fmt(current);
      return;
    }
    const c = Math.min(max, Math.max(min, v));
    if (c !== current) onCommit?.(c);
    current = c;
    input.value = fmt(c);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      input.select();
    } else if (e.key === 'Escape') {
      input.value = fmt(current);
      input.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const base = Number.isFinite(parse(input.value)) ? parse(input.value) : Number.isFinite(current) ? current : 0;
      const factor = kind === 'length' ? UNITS[unit]?.factor || 1 : 1;
      const v = Math.min(max, Math.max(min, base + (e.key === 'ArrowUp' ? 1 : -1) * step * factor * (e.shiftKey ? 10 : 1)));
      input.value = fmt(v);
      onCommit?.(v);
      current = v;
    }
    e.stopPropagation();
  });
  input.addEventListener('blur', commit);
  input.addEventListener('focus', () => input.select());
  if (onInput) input.addEventListener('input', () => onInput(parse(input.value)));
  const lab = h('label.num-label', { for: id }, iconName ? icon(iconName, 14) : label);
  if (iconName) lab.setAttribute('data-tip', label);
  // Scrub: drag horizontally on the label.
  lab.addEventListener('pointerdown', (e) => {
    if (!Number.isFinite(current)) return;
    e.preventDefault();
    lab.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const v0 = current;
    const factor = kind === 'length' ? UNITS[unit]?.factor || 1 : 1;
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - x0;
      if (Math.abs(dx) > 2) moved = true;
      if (!moved) return;
      const v = Math.min(max, Math.max(min, v0 + Math.round(dx / 2) * step * factor * (ev.shiftKey ? 10 : 1)));
      input.value = fmt(v);
      current = v;
      onCommit?.(v, { live: true });
    };
    const up = () => {
      lab.removeEventListener('pointermove', move);
      lab.removeEventListener('pointerup', up);
      if (!moved) input.focus();
    };
    lab.addEventListener('pointermove', move);
    lab.addEventListener('pointerup', up);
  });
  set(value);
  const el = h('div.num-field', lab, input);
  return { el, input, set, setUnit: (u) => ((unit = u), set(current)) };
}

/** Segmented control of icon buttons (radio semantics). */
export function segmented(label, options, value, onChange) {
  const group = h('div.segmented', { role: 'radiogroup', 'aria-label': label });
  const buttons = options.map((o) => {
    const b = h(
      'button.seg-btn',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': String(o.value === value),
        'aria-label': o.label,
        'data-tip': o.label,
        tabindex: o.value === value ? '0' : '-1',
        onclick: () => onChange(o.value),
        onkeydown: (e) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
          e.preventDefault();
          const i = options.indexOf(o);
          const next = options[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length];
          onChange(next.value);
          buttons[options.indexOf(next)].focus();
        },
      },
      o.icon ? icon(o.icon, 16) : o.text,
    );
    return b;
  });
  group.append(...buttons);
  return {
    el: group,
    set: (v) => {
      buttons.forEach((b, i) => {
        b.setAttribute('aria-checked', String(options[i].value === v));
        b.tabIndex = options[i].value === v ? 0 : -1;
      });
    },
  };
}

export function selectField(label, options, value, onChange, { id } = {}) {
  const sid = id || `sel-${Math.random().toString(36).slice(2, 8)}`;
  const sel = h(
    'select.select',
    { id: sid, 'aria-label': label, onchange: () => onChange(sel.value) },
    options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)),
  );
  return {
    el: sel,
    set: (v) => {
      sel.value = v ?? '';
    },
  };
}

/** Section with a heading inside a panel. */
export function section(title, ...children) {
  return h('section.panel-section', h('h3.section-title', title), ...children);
}
