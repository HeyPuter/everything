// Compact mixer-insert picker: an ARIA spinbutton showing the insert number
// ("--" for the master). Drag up/down, wheel, arrows, Page Up/Down, Home/End
// or type digits to change it. Callbacks follow the knob's gesture shape
// (onStart / onInput / onEnd) so a drag is one undo step.
//
//   const s = createInsertSpin({ max, value, label, nameOf, onStart, onInput, onEnd })
//   s.set(value); s.setMax(n); s.refresh()   // refresh re-reads nameOf for the tooltip
//   s.cancel()                             // discard input when its row is removed

import { h } from '../lib/dom.js';
import { clamp } from '../lib/util.js';
import { trackParameterInteraction } from '../ui/parameter-interactions.js';

export const insertText = (i) => (i > 0 ? String(i) : '--');

export function createInsertSpin({ max = 16, value = 0, label = 'Mixer insert', nameOf = () => '', onStart, onInput, onEnd }) {
  const el = h('div.insert-spin', { role: 'spinbutton', tabindex: '-1', 'aria-valuemin': '0', 'aria-label': label });
  let v = value;
  let hi = max;
  let active = false;
  let endTimer = 0;
  let stopDrag = null;
  let typed = '';
  let typedAt = 0;
  let typedTimer = 0;
  let untrack = null;
  const watch = () => {
    if (untrack) return;
    untrack = trackParameterInteraction(cancel);
    window.addEventListener('blur', onBlur);
  };
  const unwatch = () => {
    untrack?.();
    untrack = null;
    window.removeEventListener('blur', onBlur);
  };
  const resetTyped = () => {
    clearTimeout(typedTimer);
    typed = '';
    if (!active && !stopDrag) unwatch();
  };
  function cancel() {
    clearTimeout(endTimer);
    active = false;
    stopDrag?.();
    resetTyped();
    unwatch();
  }

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
    watch();
    active = true;
    onStart?.();
  };
  const finish = () => {
    // Digit entry lasts longer than the edit timer; keep that prefix tied
    // to the current document even when typing has not changed the value.
    if (!typed && !stopDrag) unwatch();
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
    if (e.button !== 0 || stopDrag) return;
    e.preventDefault();
    e.stopPropagation();
    el.focus({ preventScroll: true });
    resetTyped();
    watch();
    el.setPointerCapture?.(e.pointerId);
    const y0 = e.clientY;
    const base = v;
    el.classList.add('dragging');
    const move = (ev) => {
      if (ev.pointerId === e.pointerId) change(base + Math.round((y0 - ev.clientY) / 8));
    };
    stopDrag = () => {
      stopDrag = null;
      el.classList.remove('dragging');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
      try { el.releasePointerCapture?.(e.pointerId); } catch { /* capture already lost */ }
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      stopDrag?.();
      finish();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  });

  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      resetTyped();
      change(v + (e.deltaY < 0 ? 1 : -1));
      deferEnd();
    },
    { passive: false },
  );

  el.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let handled = true;
    if (['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) resetTyped();
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
          clearTimeout(typedTimer);
          typedTimer = setTimeout(resetTyped, 700);
          watch();
          change(Number(typed));
        } else handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      deferEnd();
    }
  });
  function onBlur() { stopDrag?.(); resetTyped(); finish(); }
  el.addEventListener('blur', onBlur);

  draw();
  return {
    el,
    cancel,
    get: () => v,
    set(next) {
      if (next === v) return;
      cancel();
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
