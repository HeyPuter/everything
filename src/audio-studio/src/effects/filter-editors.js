// Graphical editor for the Scientific Filter: the response of the designed
// filter as magnitude (dB), phase (degrees) or group delay (ms), with
// draggable cutoff handles.

import { h } from '../lib/dom.js';
import { cssVar } from '../ui/theme.js';
import { plot, gridLines, labelText } from './editors.js';
import { scientificSections, cascadeDb, cascadePhase, cascadeGroupDelay } from './defs/filter-math.js';
import { scientificOrderFor, scientificTransition } from './defs/filter.js';
import { logFrequencies } from './biquad.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
let uid = 0;
const F_MIN = 20;
const F_MAX = 20000;
const VIEWS = [
  { id: 'db', label: 'Frequency Response (dB)', colour: '--wave-2' },
  { id: 'phase', label: 'Phase (deg)', colour: '--playhead' },
  { id: 'delay', label: 'Group Delay (ms)', colour: '--envelope-vol' },
];

/** Response curve for a view: { values, top, bottom, step, unit }. */
export function responseView(view, sections, freqs, rate, gain = 0) {
  if (view === 'phase') return { values: cascadePhase(sections, freqs, rate), top: 180, bottom: -180, step: 45 };
  if (view === 'delay') {
    const values = cascadeGroupDelay(sections, freqs, rate);
    let max = 1;
    for (const v of values) if (Number.isFinite(v)) max = Math.max(max, v);
    const top = Math.pow(10, Math.ceil(Math.log10(max * 1.1)));
    const nice = [1, 2, 5, 10].map((k) => (k * top) / 10).find((t) => t >= max * 1.1) || top;
    return { values, top: nice, bottom: 0, step: nice / 5 };
  }
  return { values: cascadeDb(sections, freqs, rate, gain), top: 10, bottom: -60, step: 10 };
}

export function scientificEditor() {
  return (ctx) => {
    const rate = ctx.doc?.sampleRate || 48000;
    const fMax = Math.min(F_MAX, rate / 2);
    const freqs = logFrequencies(360, F_MIN, fMax);
    const xOf = (f, W) => (Math.log(clamp(f, F_MIN, fMax) / F_MIN) / Math.log(fMax / F_MIN)) * W;
    let view = 'db';
    const view_ = plot('fx-sci', 'Filter response', (g, W, H) => {
      const v = ctx.values;
      const r = responseView(view, scientificSections(v, rate), freqs, rate, v.gain);
      const yOf = (y) => ((r.top - y) / (r.top - r.bottom)) * H;
      const ys = [];
      for (let y = r.top - r.step; y > r.bottom; y -= r.step) ys.push(yOf(y));
      gridLines(g, W, H, [50, 100, 200, 500, 1000, 2000, 5000, 10000].filter((f) => f < fMax).map((f) => xOf(f, W)), ys);
      for (const f of [100, 1000, 10000]) if (f < fMax) labelText(g, f >= 1000 ? `${f / 1000}k` : String(f), xOf(f, W) + 3, H - 14);
      for (let y = r.top - r.step; y > r.bottom; y -= 2 * r.step) labelText(g, String(Number(y.toPrecision(3))), W - 4, yOf(y) + 2, 'right');
      g.strokeStyle = cssVar(VIEWS.find((x) => x.id === view).colour);
      g.lineWidth = 2;
      g.beginPath();
      let pen = false;
      for (let i = 0; i < freqs.length; i++) {
        const y = r.values[i];
        if (!Number.isFinite(y)) {
          pen = false;
          continue;
        }
        const px = xOf(freqs[i], W);
        const py = clamp(yOf(y), -2, H + 2);
        // Phase wraps: do not draw the jump from +180 to -180.
        if (pen && view === 'phase' && Math.abs(y - r.values[i - 1]) > 180) pen = false;
        if (pen) g.lineTo(px, py);
        else g.moveTo(px, py);
        pen = true;
      }
      g.stroke();
    });
    const group = `fx-sci-${++uid}`;
    const radios = h(
      'div.fx-radios.fx-sci-views',
      { role: 'radiogroup', 'aria-label': 'Response view' },
      VIEWS.map((x) => {
        const input = h('input', { type: 'radio', name: group, checked: x.id === view, onchange: () => {
          view = x.id;
          view_.redraw();
        } });
        return h('label.fx-radio', input, h('span', x.label), h('span.fx-sci-swatch', { style: { background: `var(${x.colour})` } }));
      }),
    );
    const handles = ['cutoff', 'highCutoff'].map((id) => {
      const btn = h('button.fx-handle.fx-xover', { type: 'button', role: 'slider', 'aria-label': id === 'cutoff' ? 'Cutoff' : 'High cutoff' });
      btn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        btn.focus();
        btn.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const r = view_.el.getBoundingClientRect();
          ctx.set(id, F_MIN * Math.pow(fMax / F_MIN, clamp((ev.clientX - r.left) / r.width, 0, 1)));
        };
        const up = () => {
          btn.removeEventListener('pointermove', move);
          btn.removeEventListener('pointerup', up);
          btn.removeEventListener('pointercancel', up);
        };
        btn.addEventListener('pointermove', move);
        btn.addEventListener('pointerup', up);
        btn.addEventListener('pointercancel', up);
      });
      btn.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        e.stopPropagation();
        ctx.set(id, ctx.values[id] * Math.pow(2, (d * (e.shiftKey ? 4 : 1)) / 12));
      });
      view_.layer.append(btn);
      return { id, btn };
    });
    // Design by transition bandwidth: keep the order at the lowest that meets it.
    const design = h('div.fx-sci-design.faint', { 'aria-live': 'polite' });
    const showDesign = (v) => {
      if (v.designBy === 1) {
        const { order, met } = scientificOrderFor(v, rate);
        if (order !== v.order) ctx.set('order', order);
        design.textContent = met ? `Order ${order} is down ${v.stopAtten} dB within ${Math.round(v.transition)} Hz` : `Even order ${order}, the steepest, is not down ${v.stopAtten} dB within ${Math.round(v.transition)} Hz`;
      } else {
        const w = scientificTransition(v, rate);
        design.textContent = w == null ? `Order ${Math.round(v.order)} does not reach ${v.stopAtten} dB of attenuation in the audio band` : `Order ${Math.round(v.order)} is down ${v.stopAtten} dB within ${w < 100 ? w.toFixed(1) : Math.round(w)} Hz`;
      }
    };
    const update = (v) => {
      showDesign(v);
      for (const { id, btn } of handles) {
        btn.style.display = id === 'highCutoff' && v.mode < 2 ? 'none' : '';
        btn.style.left = `${(xOf(v[id], 1) * 100).toFixed(3)}%`;
        btn.setAttribute('aria-valuenow', String(Math.round(v[id])));
        btn.setAttribute('aria-valuetext', `${Math.round(v[id])} Hz`);
      }
      view_.redraw();
    };
    ctx.subscribe(update);
    update(ctx.values);
    return h('div.fx-sci-editor', radios, view_.el, design);
  };
}
