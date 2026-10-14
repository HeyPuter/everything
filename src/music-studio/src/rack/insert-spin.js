// Compact mixer-insert picker: an ARIA spinbutton showing the insert number
// ("--" for the master). Drag up/down, wheel, arrows, Page Up/Down, Home/End
// or type digits to change it. Callbacks follow the knob's gesture shape
// (onStart / onInput / onEnd) so a drag is one undo step.
//
//   const s = createInsertSpin({ max, value, label, nameOf, onStart, onInput, onEnd })
//   s.set(value); s.setMax(n); s.refresh()   // refresh re-reads nameOf for the tooltip

import { h } from '../lib/dom.js';
import { clamp } from '../lib/util.js';

export const insertText = (i) => (i > 0 ? String(i) : '--');

export function createInsertSpin({ max = 16, value = 0, label = 'Mixer insert', nameOf = () => '', onStart, onInput, onEnd }) {
  const el = h('div.insert-spin', { role: 'spinbutton', tabindex: '-1', 'aria-valuemin': '0', 'aria-label': label });
  let v = value;
  let hi = max;
  let active = false;
  let endTimer = 0;
  let typed = '';
  let typedAt = 0;

  const describe = () => (v > 0 ? `Insert ${v}${nameOf(v) ? `: ${nameOf(v)}` : ''}` : 'Master');
  const draw = () => {
    el.textContent = insertText(v);
    el.setAttribute('aria-valuenow', String(v));
    el.setAttribute('aria-valuemax', String(hi));
    const d = describe();
    el.setAttribute('aria-valuetext', d);
    el.title = `Mixer insert: ${d}. Drag or scroll to change`;
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
    onEnd?.(v);
  };
  const change = (next) => {
    const n = clamp(Math.round(next), 0, hi);
    if (n === v) return;
    begin();
    v = n;
    draw();
    onInput?.(v);
  };
  const deferEnd = () => {
    clearTimeout(endTimer);
    endTimer = setTimeout(finish, 450);
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    el.focus({ preventScroll: true });
    el.setPointerCapture?.(e.pointerId);
    const y0 = e.clientY;
    const base = v;
    el.classList.add('dragging');
    const move = (ev) => change(base + Math.round((y0 - ev.clientY) / 8));
    const up = () => {
      el.classList.remove('dragging');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      finish();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });

  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      change(v + (e.deltaY < 0 ? 1 : -1));
      deferEnd();
    },
    { passive: false },
  );

  el.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let handled = true;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        change(v + 1);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        change(v - 1);
        break;
      case 'PageUp':
        change(v + 4);
        break;
      case 'PageDown':
        change(v - 4);
        break;
      case 'Home':
        change(0);
        break;
      case 'End':
        change(hi);
        break;
      default:
        if (/^\d$/.test(e.key)) {
          const now = performance.now();
          typed = now - typedAt < 700 ? typed + e.key : e.key;
          typedAt = now;
          change(Number(typed));
        } else handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      deferEnd();
    }
  });
  el.addEventListener('blur', finish);

  draw();
  return {
    el,
    get: () => v,
    set(next) {
      if (active || next === v) return;
      v = next;
      draw();
    },
    setMax(n) {
      if (n === hi) return;
      hi = n;
      draw();
    },
    refresh: draw,
  };
}
