// Small live meters for effect dialogs, fed by an effect's readout while
// audio plays through it (see `readout` in registry.js).
//   kind 'level'  input or output peak in dB, filling from the left
//   kind 'gr'     gain reduction in dB (<= 0), filling from the right
//   kind 'gate'   a lamp: lit while the gate is open (value 0..1)
// Values hold for a moment and then fall back, so short peaks stay visible;
// when the readings stop (playback stopped) the meter returns to rest.

import { h } from '../lib/dom.js';

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Readouts arrive about 15 times a second while audio plays; this long without one is rest. */
const IDLE_MS = 600;

/** One meter: { el, set(value), clear() }. */
export function levelMeter({ label = '', kind = 'level', min = kind === 'gr' ? -24 : -60, max = 0, vertical = false } = {}) {
  const fill = h('div.fx-lm-fill');
  const bar = h(`div.fx-lm-bar.${kind}${vertical ? '.v' : ''}`, fill);
  const text = h('span.fx-lm-value');
  const el = h(`div.fx-lm${vertical ? '.v' : ''}`, { role: 'meter', 'aria-label': label, 'aria-valuemin': String(min), 'aria-valuemax': String(max) }, label ? h('span.fx-lm-label', label) : null, bar, kind === 'gate' ? null : text);
  // At rest: no reduction, silence, the gate lamp off.
  const rest = kind === 'gr' ? 0 : min;
  let shown = rest;
  let at = 0;
  let idle = 0;
  const draw = (v) => {
    if (kind === 'gate') {
      bar.classList.toggle('on', v >= 0.5);
      el.setAttribute('aria-valuenow', v >= 0.5 ? '1' : '0');
      return;
    }
    const f = kind === 'gr' ? clamp01(v / min) : clamp01((v - min) / (max - min));
    fill.style.transform = vertical ? `scaleY(${f})` : `scaleX(${f})`;
    text.textContent = kind === 'gr' ? (v < -0.05 ? v.toFixed(1) : '0.0') : v <= min ? '-inf' : v.toFixed(1);
    el.setAttribute('aria-valuenow', String(Math.round(v * 10) / 10));
  };
  draw(shown);
  const clear = () => {
    clearTimeout(idle);
    shown = rest;
    draw(shown);
  };
  return {
    el,
    set(v) {
      if (!Number.isFinite(v)) return;
      clearTimeout(idle);
      idle = setTimeout(clear, IDLE_MS);
      const now = performance.now();
      // Peak hold: louder (or deeper) readings show at once; quieter ones after 300 ms.
      const louder = kind === 'gr' ? v < shown : v > shown;
      if (louder || now - at > 300) {
        shown = louder || kind === 'gate' ? v : kind === 'gr' ? Math.min(0, shown * 0.6 + v * 0.4) : shown * 0.6 + v * 0.4;
        at = now;
        draw(shown);
      }
    },
    clear,
  };
}

/**
 * Meters fed from readout indices: specs [{ index, label, kind, min, max }].
 * Returns { el, feed(readout), clear() }.
 */
export function meterStrip(specs, { vertical = false, className = '' } = {}) {
  const meters = specs.map((s) => ({ s, m: levelMeter({ ...s, vertical }) }));
  return {
    el: h(`div.fx-lm-strip${vertical ? '.v' : ''}${className ? `.${className}` : ''}`, meters.map((x) => x.m.el)),
    feed: (v) => meters.forEach(({ s, m }) => s.index < v.length && m.set(v[s.index])),
    clear: () => meters.forEach(({ m }) => m.clear()),
  };
}
