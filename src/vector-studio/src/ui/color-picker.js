/**
 * Color picker: a saturation/brightness field with a hue slider, hex and
 * RGB fields, and an eyedropper where the browser supports it. Keyboard:
 * arrows move the S/B handle (Shift for 10x) and the hue slider is a native
 * range input.
 */
import { h } from '../lib/dom.js';
import { hexToRgb, rgbToHex, rgbToHsb, hsbToRgb, isHex, normalizeHex } from '../lib/color.js';
import { icon } from './icons.js';

export function createColorPicker({ value = '#000000', onInput, onCommit, label = 'Color' }) {
  let hsb = rgbToHsb(hexToRgb(value));
  const sv = h('canvas.cp-sv', { width: 224, height: 140 });
  const knob = h('div.cp-knob', {
    role: 'slider',
    tabindex: '0',
    'aria-label': `${label} saturation and brightness`,
    'aria-valuemin': '0',
    'aria-valuemax': '100',
  });
  const svWrap = h('div.cp-sv-wrap', sv, knob);
  const hue = h('input.cp-hue', { type: 'range', min: 0, max: 360, step: 1, value: Math.round(hsb.h), 'aria-label': `${label} hue` });
  const hex = h('input.cp-hex', { type: 'text', value: value.replace('#', '').toUpperCase(), 'aria-label': `${label} hex value`, maxlength: 7, spellcheck: false });
  const chans = ['r', 'g', 'b'].map((c) => h('input.cp-chan', { type: 'number', min: 0, max: 255, 'aria-label': `${label} ${c.toUpperCase()}` }));
  const preview = h('span.cp-preview', { 'aria-hidden': 'true' });
  const dropper =
    typeof window !== 'undefined' && 'EyeDropper' in window
      ? h(
          'button.icon-btn',
          {
            type: 'button',
            'aria-label': 'Pick a color from the screen',
            'data-tip': 'Pick a color from the screen',
            onclick: async () => {
              try {
                const r = await new window.EyeDropper().open();
                setHex(r.sRGBHex, true);
              } catch {
                // Cancelled.
              }
            },
          },
          icon('pipette', 16),
        )
      : null;

  const ctx = sv.getContext('2d');
  const drawSV = () => {
    const { width: w, height: hh } = sv;
    const base = rgbToHex(hsbToRgb({ h: hsb.h, s: 100, v: 100 }));
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, hh);
    const white = ctx.createLinearGradient(0, 0, w, 0);
    white.addColorStop(0, '#ffffff');
    white.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = white;
    ctx.fillRect(0, 0, w, hh);
    const black = ctx.createLinearGradient(0, 0, 0, hh);
    black.addColorStop(0, 'rgba(0,0,0,0)');
    black.addColorStop(1, '#000000');
    ctx.fillStyle = black;
    ctx.fillRect(0, 0, w, hh);
  };

  const current = () => rgbToHex(hsbToRgb(hsb));

  const sync = (skip) => {
    const hx = current();
    const rgb = hexToRgb(hx);
    if (skip !== 'hex') hex.value = hx.slice(1).toUpperCase();
    if (skip !== 'chan') chans.forEach((c, i) => (c.value = String([rgb.r, rgb.g, rgb.b][i])));
    if (skip !== 'hue') hue.value = String(Math.round(hsb.h));
    knob.style.left = `${hsb.s}%`;
    knob.style.top = `${100 - hsb.v}%`;
    knob.setAttribute('aria-valuetext', `Saturation ${Math.round(hsb.s)}%, brightness ${Math.round(hsb.v)}%`);
    preview.style.background = hx;
    hue.style.setProperty('--hue-color', rgbToHex(hsbToRgb({ h: hsb.h, s: 100, v: 100 })));
  };

  const emit = (commit) => {
    const hx = current();
    onInput?.(hx);
    if (commit) onCommit?.(hx);
  };

  const setHex = (v, commit) => {
    if (!isHex(v)) return;
    const n = normalizeHex(v);
    const next = rgbToHsb(hexToRgb(n));
    // Keep the hue for grays so the field does not jump.
    if (next.s === 0 || next.v === 0) next.h = hsb.h;
    hsb = next;
    drawSV();
    sync();
    emit(commit);
  };

  const pick = (e) => {
    const r = sv.getBoundingClientRect();
    hsb.s = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
    hsb.v = Math.max(0, Math.min(100, 100 - ((e.clientY - r.top) / r.height) * 100));
    sync();
    emit(false);
  };
  let dragPointer = null;
  svWrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || dragPointer !== null) return;
    try {
      svWrap.setPointerCapture?.(e.pointerId);
    } catch {
      // An ended pointer cannot start a color change or leave a drag behind.
      return;
    }
    dragPointer = e.pointerId;
    const move = (ev) => { if (ev.pointerId === dragPointer) pick(ev); };
    const up = (ev) => {
      if (ev.pointerId !== dragPointer) return;
      dragPointer = null;
      svWrap.removeEventListener('pointermove', move);
      svWrap.removeEventListener('pointerup', up);
      svWrap.removeEventListener('pointercancel', up);
      svWrap.removeEventListener('lostpointercapture', up);
      emit(true);
    };
    svWrap.addEventListener('pointermove', move);
    svWrap.addEventListener('pointerup', up);
    svWrap.addEventListener('pointercancel', up);
    svWrap.addEventListener('lostpointercapture', up);
    pick(e);
    knob.focus({ preventScroll: true });
  });
  knob.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') hsb.s = Math.max(0, hsb.s - step);
    else if (e.key === 'ArrowRight') hsb.s = Math.min(100, hsb.s + step);
    else if (e.key === 'ArrowUp') hsb.v = Math.min(100, hsb.v + step);
    else if (e.key === 'ArrowDown') hsb.v = Math.max(0, hsb.v - step);
    else return;
    e.preventDefault();
    e.stopPropagation();
    sync();
    emit(true);
  });
  hue.addEventListener('input', () => {
    hsb.h = Number(hue.value);
    drawSV();
    sync('hue');
    emit(false);
  });
  hue.addEventListener('change', () => emit(true));
  hex.addEventListener('change', () => {
    const v = hex.value.trim();
    // Text that is not a color goes back to the current color instead of staying in the field.
    if (isHex(v)) setHex(v.startsWith('#') ? v : `#${v}`, true);
    else hex.value = current().slice(1).toUpperCase();
  });
  // Escape still reaches the popover or panel around the picker, to close it.
  hex.addEventListener('keydown', (e) => e.key !== 'Escape' && e.stopPropagation());
  chans.forEach((c) =>
    c.addEventListener('change', () => {
      const [r, g, b] = chans.map((x) => Math.max(0, Math.min(255, Number(x.value) || 0)));
      setHex(rgbToHex({ r, g, b }), true);
    }),
  );

  const el = h(
    'div.color-picker',
    svWrap,
    h('div.cp-row', preview, hue, dropper),
    h('div.cp-row.cp-fields', h('label.cp-field', h('span', '#'), hex), ...['R', 'G', 'B'].map((n, i) => h('label.cp-field', h('span', n), chans[i]))),
  );
  drawSV();
  sync();
  return {
    el,
    set: (v) => {
      if (v && v.toLowerCase() !== current().toLowerCase()) {
        const next = rgbToHsb(hexToRgb(v));
        if (next.s === 0 || next.v === 0) next.h = hsb.h;
        hsb = next;
        drawSV();
        sync();
      }
    },
    get value() {
      return current();
    },
  };
}
