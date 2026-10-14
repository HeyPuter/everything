// Vertical volume fader: an ARIA slider over linear gain (0..MAX_GAIN) with
// the mixer's fader law (mixer/db.js). Drag anywhere on it (relative, Shift
// for fine control), wheel (0.5 dB a notch, Shift 0.1 dB), arrows (0.5 dB,
// Shift 0.1 dB), Page Up/Down (3 dB), Home (silence), End (max), Enter types
// a value, double-click or Alt/Mod-click resets to 0 dB. Left and Right are
// left to the strip (they move the mixer selection).
//
//   const f = createFader({ value, label, onStart, onInput, onEnd, menuItems })
//   f.set(gain)          // from the model, no callbacks
//   f.setTicks(ticks)    // scale labels (mixer/db.js ticksFor)
//
// The cap moves through the CSS variable --pos so updates never relayout.

import { h } from '../lib/dom.js';
import { clamp } from '../lib/util.js';
import { contextMenu, isContextKey } from '../ui/menu.js';
import { gainToPos, posToGain, formatGain, nudgeDb, parseGain, MAX_GAIN, UNITY } from './db.js';

const DRAG_PX = 220; // full travel per this many px of pointer movement (roughly the visible height)

export function createFader({ value = UNITY, label = 'Volume', onStart, onInput, onEnd, menuItems, resetValue = UNITY }) {
  const cap = h('div.fdr-cap', { 'aria-hidden': 'true' });
  const fill = h('div.fdr-fill', { 'aria-hidden': 'true' });
  const track = h('div.fdr-track', { 'aria-hidden': 'true' }, fill);
  const unity = h('div.fdr-unity', { 'aria-hidden': 'true', style: { '--pos': String(gainToPos(UNITY)) } });
  const scale = h('div.fdr-scale', { 'aria-hidden': 'true' });
  const slider = h(
    'div.fdr-slider',
    {
      role: 'slider',
      tabindex: '0',
      'aria-label': label,
      'aria-orientation': 'vertical',
      'aria-valuemin': '0',
      'aria-valuemax': String(MAX_GAIN),
    },
    track,
    unity,
    cap,
  );
  const el = h('div.fdr', scale, slider);

  let v = value;
  let active = false;
  let endTimer = 0;

  const draw = () => {
    el.style.setProperty('--pos', gainToPos(v).toFixed(4));
    slider.setAttribute('aria-valuenow', String(Math.round(v * 10000) / 10000));
    const text = formatGain(v);
    slider.setAttribute('aria-valuetext', text);
    slider.title = `${label}: ${text}`;
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
  const deferEnd = () => {
    clearTimeout(endTimer);
    endTimer = setTimeout(finish, 450);
  };
  const change = (next) => {
    const g = clamp(next, 0, MAX_GAIN);
    if (g === v) return;
    begin();
    v = g;
    draw();
    onInput?.(v);
  };
  const reset = () => {
    change(resetValue);
    finish();
  };

  slider.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    slider.focus({ preventScroll: true });
    if (e.altKey || e.metaKey || e.ctrlKey) {
      reset();
      return;
    }
    slider.setPointerCapture?.(e.pointerId);
    slider.classList.add('dragging');
    let lastY = e.clientY;
    let pos = gainToPos(v);
    const move = (ev) => {
      const dy = lastY - ev.clientY;
      lastY = ev.clientY;
      const travel = Math.max(80, slider.clientHeight - 16) || DRAG_PX;
      pos = clamp(pos + dy / (ev.shiftKey ? travel * 8 : travel), 0, 1);
      change(posToGain(pos));
    };
    const up = () => {
      slider.classList.remove('dragging');
      slider.removeEventListener('pointermove', move);
      slider.removeEventListener('pointerup', up);
      slider.removeEventListener('pointercancel', up);
      finish();
    };
    slider.addEventListener('pointermove', move);
    slider.addEventListener('pointerup', up);
    slider.addEventListener('pointercancel', up);
  });

  slider.addEventListener('dblclick', (e) => {
    e.preventDefault();
    reset();
  });

  slider.addEventListener(
    'wheel',
    (e) => {
      if (!e.deltaY) return;
      e.preventDefault();
      change(nudgeDb(v, (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.1 : 0.5)));
      deferEnd();
    },
    { passive: false },
  );

  slider.addEventListener('keydown', (e) => {
    let handled = true;
    switch (e.key) {
      case 'ArrowUp':
        change(nudgeDb(v, e.shiftKey ? 0.1 : 0.5));
        break;
      case 'ArrowDown':
        change(nudgeDb(v, e.shiftKey ? -0.1 : -0.5));
        break;
      case 'PageUp':
        change(nudgeDb(v, 3));
        break;
      case 'PageDown':
        change(nudgeDb(v, -3));
        break;
      case 'Home':
        change(0);
        break;
      case 'End':
        change(MAX_GAIN);
        break;
      case 'Delete':
      case 'Backspace':
        change(resetValue);
        break;
      case 'Enter':
        typeIn();
        break;
      default:
        handled = false;
    }
    if (isContextKey(e)) {
      const r = slider.getBoundingClientRect();
      openContext({ clientX: r.left, clientY: r.bottom, preventDefault() {} });
      handled = true;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key !== 'Enter') deferEnd();
    }
  });
  slider.addEventListener('blur', finish);

  function typeIn() {
    const input = h('input.input.sm', { type: 'text', value: formatGain(v), 'aria-label': `${label} in dB`, style: { position: 'fixed', width: '84px', zIndex: 1300 } });
    const r = slider.getBoundingClientRect();
    input.style.left = `${Math.round(r.left + r.width / 2 - 42)}px`;
    input.style.top = `${Math.round(r.top + r.height * (1 - gainToPos(v)) - 12)}px`;
    document.body.append(input);
    input.focus();
    input.select();
    let done = false;
    const close = (apply) => {
      if (done) return;
      done = true;
      if (apply) {
        const g = parseGain(input.value);
        if (g !== null) {
          change(g);
          finish();
        }
      }
      input.remove();
      slider.focus({ preventScroll: true });
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
      { label: 'Reset to 0 dB', keys: 'Double-click', run: reset },
      { label: 'Type in value...', keys: 'Enter', run: typeIn },
      ...(menuItems ? [{ type: 'sep' }, ...(typeof menuItems === 'function' ? menuItems() : menuItems)] : []),
    ];
    contextMenu(e, items, `${label} options`);
  }
  slider.addEventListener('contextmenu', (e) => {
    e.stopPropagation();
    openContext(e);
  });

  draw();
  return {
    el,
    slider,
    get: () => v,
    set(next) {
      if (active || next === v) return;
      v = next;
      draw();
    },
    setLabel(text) {
      label = text;
      slider.setAttribute('aria-label', text);
      draw();
    },
    setTicks(ticks) {
      scale.replaceChildren(...ticks.map((t) => h('span.fdr-tick', { style: { '--pos': t.pos.toFixed(4) }, dataset: { major: t.major ? '1' : '0' } }, t.label)));
    },
  };
}
