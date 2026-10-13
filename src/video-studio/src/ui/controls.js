/**
 * Property controls used by the details panel: labeled sliders with a number
 * box and keyframe toggle, color fields, switches, selects, segmented
 * groups and collapsible sections.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

let seq = 0;
const nextId = (p) => `${p}-${++seq}`;

function pct(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const v = Number(input.value);
  input.style.setProperty('--pct', `${((v - min) / (max - min || 1)) * 100}%`);
}

/**
 * Slider + number box.
 *  onInput(value, final)  final is true on change/commit (end of drag, Enter)
 *  keyframe: { onToggle, onPrev, onNext } shows the diamond button group
 */
export function sliderField({ label, min = 0, max = 100, step = 1, value = 0, unit = '', decimals, onInput, keyframe, resetTo, wide = false }) {
  const id = nextId('sl');
  const dec = decimals ?? (step < 1 ? Math.max(0, -Math.floor(Math.log10(step))) : 0);
  const range = h('input', { type: 'range', id, min, max, step, value, 'aria-label': label });
  const num = h('input.num-input', { type: 'text', inputMode: 'decimal', value: Number(value).toFixed(dec), 'aria-label': `${label} value`, spellcheck: false });
  const fmt = (v) => Number(v).toFixed(dec);
  pct(range);
  let last = Number(value);
  const emit = (v, final) => {
    last = v;
    onInput?.(v, final);
  };
  range.addEventListener('input', () => {
    num.value = fmt(range.value);
    pct(range);
    emit(Number(range.value), false);
  });
  range.addEventListener('change', () => emit(Number(range.value), true));
  const commitNum = () => {
    const raw = parseFloat(num.value);
    if (!Number.isFinite(raw)) {
      num.value = fmt(last);
      return;
    }
    // The number box accepts values outside the slider range where meaningful.
    const v = Math.min(Number(range.dataset.hardMax ?? Infinity), Math.max(Number(range.dataset.hardMin ?? -Infinity), raw));
    num.value = fmt(v);
    range.value = String(v);
    pct(range);
    emit(v, true);
  };
  num.addEventListener('change', commitNum);
  num.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitNum();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const delta = (e.key === 'ArrowUp' ? 1 : -1) * Number(step) * (e.shiftKey ? 10 : 1);
      const v = Math.min(max, Math.max(min, last + delta));
      num.value = fmt(v);
      range.value = String(v);
      pct(range);
      emit(v, true);
    }
  });
  let kf = null;
  let kfBtn = null;
  if (keyframe) {
    kfBtn = h('button.icon-btn.small.kf-btn', { type: 'button', 'aria-label': `Add keyframe for ${label}`, 'aria-pressed': 'false', 'data-tip': 'Add keyframe' }, icon('keyframe', 14));
    const prev = h('button.icon-btn.small.kf-nav', { type: 'button', 'aria-label': `Previous ${label} keyframe`, 'data-tip': 'Previous keyframe' }, icon('chevronLeft', 12));
    const next = h('button.icon-btn.small.kf-nav', { type: 'button', 'aria-label': `Next ${label} keyframe`, 'data-tip': 'Next keyframe' }, icon('chevronRight', 12));
    kfBtn.addEventListener('click', () => keyframe.onToggle?.());
    prev.addEventListener('click', () => keyframe.onPrev?.());
    next.addEventListener('click', () => keyframe.onNext?.());
    kf = h('div.kf-group', prev, kfBtn, next);
  }
  const reset = resetTo !== undefined ? h('button.icon-btn.small.reset-btn', { type: 'button', 'aria-label': `Reset ${label}`, 'data-tip': 'Reset' }, icon('rotateLeft', 12)) : null;
  reset?.addEventListener('click', () => {
    range.value = String(resetTo);
    num.value = fmt(resetTo);
    pct(range);
    emit(resetTo, true);
  });
  const el = h(`div.field.slider-field${wide ? '.wide' : ''}`, h('label.field-label', { for: id }, label), h('div.slider-row', range, num, reset, kf));
  return {
    el,
    input: range,
    set(v) {
      if (document.activeElement === range || document.activeElement === num) return;
      last = Number(v);
      range.value = String(v);
      num.value = fmt(v);
      pct(range);
    },
    setKeyframe(state) {
      if (!kfBtn) return;
      kfBtn.setAttribute('aria-pressed', state === 'on' ? 'true' : 'false');
      kfBtn.classList.toggle('has-keys', state !== 'none');
      kfBtn.setAttribute('aria-label', state === 'on' ? `Remove ${label} keyframe` : `Add keyframe for ${label}`);
      kfBtn.setAttribute('data-tip', state === 'on' ? 'Remove keyframe' : 'Add keyframe');
    },
    setLimits(lo, hi) {
      range.dataset.hardMin = lo;
      range.dataset.hardMax = hi;
    },
  };
}

export function colorField({ label, value = '#ffffff', onInput }) {
  const id = nextId('col');
  const swatch = h('input.color-swatch', { type: 'color', id, value, 'aria-label': label });
  const hex = h('input.input.hex-input', { type: 'text', value: value.toUpperCase(), maxLength: 7, 'aria-label': `${label} hex value`, spellcheck: false });
  swatch.addEventListener('input', () => {
    hex.value = swatch.value.toUpperCase();
    onInput?.(swatch.value, false);
  });
  swatch.addEventListener('change', () => onInput?.(swatch.value, true));
  hex.addEventListener('change', () => {
    let v = hex.value.trim();
    if (!v.startsWith('#')) v = `#${v}`;
    if (/^#[0-9a-f]{3}$/i.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
    if (!/^#[0-9a-f]{6}$/i.test(v)) {
      hex.value = swatch.value.toUpperCase();
      return;
    }
    swatch.value = v.toLowerCase();
    hex.value = v.toUpperCase();
    onInput?.(swatch.value, true);
  });
  const el = h('div.field.color-field', h('label.field-label', { for: id }, label), h('div.color-row', swatch, hex));
  return {
    el,
    set(v) {
      if (document.activeElement === hex) return;
      swatch.value = v;
      hex.value = v.toUpperCase();
    },
  };
}

export function switchField({ label, checked = false, onChange, hint }) {
  const id = nextId('sw');
  const sw = h('button.switch', { type: 'button', role: 'switch', id, 'aria-checked': String(checked), 'aria-labelledby': `${id}-l` });
  sw.addEventListener('click', () => {
    const v = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', String(v));
    onChange?.(v);
  });
  const el = h('div.field.switch-field', h('span.field-label', { id: `${id}-l` }, label, hint ? h('span.field-hint', hint) : null), sw);
  return {
    el,
    set(v) {
      sw.setAttribute('aria-checked', String(Boolean(v)));
    },
  };
}

export function selectField({ label, options, value, onChange }) {
  const id = nextId('sel');
  const sel = h('select.select', { id }, options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  sel.addEventListener('change', () => onChange?.(sel.value));
  const el = h('div.field.select-field', h('label.field-label', { for: id }, label), sel);
  return {
    el,
    select: sel,
    set(v) {
      sel.value = v;
    },
  };
}

/** Radio-group style segmented control with arrow-key navigation. */
export function segmented({ label, options, value, onChange, iconOnly = false, className = '' }) {
  const group = h(`div.segmented${className ? '.' + className : ''}`, { role: 'radiogroup', 'aria-label': label });
  const buttons = options.map((o) => {
    const b = h('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': String(o.value === value),
      tabindex: o.value === value ? '0' : '-1',
      'aria-label': iconOnly ? o.label : null,
      'data-tip': iconOnly ? o.label : null,
    }, o.icon ? icon(o.icon, 15) : null, iconOnly ? null : o.label);
    b.addEventListener('click', () => {
      set(o.value);
      onChange?.(o.value);
    });
    return b;
  });
  const set = (v) => {
    buttons.forEach((b, i) => {
      const on = options[i].value === v;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  };
  group.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % buttons.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + buttons.length) % buttons.length;
    if (j >= 0) {
      e.preventDefault();
      buttons[j].focus();
      buttons[j].click();
    }
  });
  group.append(...buttons);
  return { el: group, set };
}

/** Collapsible section with a heading button. */
export function section(title, children, { open = true, actions = null } = {}) {
  const id = nextId('sec');
  const btn = h('button.section-toggle', { type: 'button', 'aria-expanded': String(open), 'aria-controls': id }, icon('chevronDown', 14, 'section-chevron'), h('span', title));
  const body = h('div.section-body', { id, hidden: !open }, children);
  btn.addEventListener('click', () => {
    const o = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(o));
    body.hidden = !o;
  });
  return h('section.prop-section', h('div.section-head', h('h3.section-title', btn), actions), body);
}

/** Tab list with roving focus; returns { el, select(id) }. */
export function tabs({ label, items, value, onChange, className = '' }) {
  const list = h(`div.tablist${className ? '.' + className : ''}`, { role: 'tablist', 'aria-label': label });
  const btns = items.map((it) => {
    const b = h('button.tab', { type: 'button', role: 'tab', id: `tab-${it.id}`, 'aria-selected': String(it.id === value), tabindex: it.id === value ? '0' : '-1', 'aria-controls': it.panel || null }, it.icon ? icon(it.icon, 18) : null, h('span.tab-label', it.label));
    b.addEventListener('click', () => {
      select(it.id);
      onChange?.(it.id);
    });
    return b;
  });
  const select = (id) => {
    btns.forEach((b, i) => {
      const on = items[i].id === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  };
  // Arrow keys move between the tabs on show (a row may hide some, see panels/index.js).
  list.addEventListener('keydown', (e) => {
    const shown = btns.filter((b) => !b.hidden);
    const i = shown.indexOf(document.activeElement);
    if (i < 0) return;
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % shown.length;
    if (e.key === 'ArrowLeft') j = (i - 1 + shown.length) % shown.length;
    if (e.key === 'Home') j = 0;
    if (e.key === 'End') j = shown.length - 1;
    if (j >= 0) {
      e.preventDefault();
      shown[j].focus();
      shown[j].click();
    }
  });
  list.append(...btns);
  return { el: list, select, buttons: btns };
}
