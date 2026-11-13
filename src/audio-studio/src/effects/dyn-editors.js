// Graphical editors for the dynamics effects:
//   dynamicsProcessingEditor  transfer curve with point tools and a segment table
//   deesserEditor             the detection band on a frequency axis, with a
//                             gain reduction meter
//   multibandEditor           crossover graph with per-band level and reduction,
//                             and a strip per band (solo, bypass, settings)

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { hotNumber } from '../ui/controls.js';
import { cssVar } from '../ui/theme.js';
import { plot, gridLines, labelText, transferCurveEditor } from './editors.js';
import { formatValue, formatParts, parseValue, editValueText } from './params.js';
import { splineOutput } from './defs/transfer-curve.js';
import { levelMeter } from './meters-ui.js';
import { glyph } from './layout.js';
import { liveSpectrum, drawSpectrum } from './views/common.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------ helpers

/** Hot-text value for a param: { el, show(values) }. */
export function paramHot(ctx, id, { label, set = (v) => ctx.set(id, v) } = {}) {
  const p = ctx.def.params.find((q) => q.id === id);
  const editText = (v) => editValueText(p, v);
  const hot = hotNumber({
    value: ctx.values[id],
    min: p.min ?? -Infinity,
    max: p.max ?? Infinity,
    step: p.step || 0.1,
    label: label || p.label || id,
    pixelsPerStep: Math.max(0.01, (240 * (p.step || 0.1)) / ((p.max ?? 1) - (p.min ?? 0) || 1)),
    format: (v) => formatValue(p, v),
    parts: (v) => formatParts(p, v),
    editText,
    parse: (s) => parseValue(p, s),
    onInput: set,
    onChange: (v) => {
      set(v);
      hot.setValue(ctx.values[id]); // a value the setter limited shows as set
    },
    defaultValue: p.default,
  });
  return { el: hot, show: (values) => hot.setValue(values[id]) };
}

const FREQ_MIN = 20;
const FREQ_MAX = 20000;
const xOfF = (f, W) => (Math.log(clamp(f, FREQ_MIN, FREQ_MAX) / FREQ_MIN) / Math.log(FREQ_MAX / FREQ_MIN)) * W;
const fOfX = (fx) => FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, clamp(fx, 0, 1));
const F_TICKS = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const fLabel = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));

/** Frequency grid with labels along the bottom and dB lines from `top` to `bottom`. */
function freqGrid(g, W, H, { top = 0, bottom = -80, step = 10 } = {}) {
  const yOf = (db) => ((top - db) / (top - bottom)) * H;
  const ys = [];
  for (let d = top - step; d > bottom; d -= step) ys.push(yOf(d));
  gridLines(g, W, H, F_TICKS.map((f) => xOfF(f, W)), ys);
  for (const f of [100, 1000, 10000]) labelText(g, fLabel(f), xOfF(f, W) + 3, H - 14);
  for (let d = top - 2 * step; d > bottom; d -= 2 * step) labelText(g, String(d), W - 4, yOf(d) + 2, 'right');
  return yOf;
}

/** Drag a vertical handle across the frequency axis. */
function freqDrag(handle, box, onFreq) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    handle.focus();
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const r = box.getBoundingClientRect();
      onFreq(fOfX((ev.clientX - r.left) / r.width));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    onFreq(null, d * (e.shiftKey ? 4 : 1));
  });
}

// ------------------------------------------------- Dynamics Processing

/**
 * Segments of a transfer curve from the loudest down: [{ ratio, type, threshold }].
 * A segment's ratio is input change over output change; its threshold is the
 * input level where it starts (the top segment) or ends (the ones below).
 */
export function curveSegments(points) {
  const pts = [...(points || [])].sort((a, b) => a.x - b.x);
  const out = [];
  for (let k = pts.length - 1; k > 0; k--) {
    const a = pts[k - 1];
    const b = pts[k];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const slope = dx > 1e-6 ? dy / dx : 1;
    let type = 'Neutral';
    if (Math.abs(slope - 1) > 0.01) {
      if (slope <= 0.001) type = 'Limiter';
      else if (slope < 1) type = 'Compressor';
      else type = 'Expander';
    }
    const ratio = slope > 1e-6 ? 1 / slope : Infinity;
    const top = k === pts.length - 1;
    out.push({ ratio, type, threshold: top ? `Above ${a.x.toFixed(2)} dB` : `Below ${b.x.toFixed(2)} dB` });
  }
  return out;
}

const ratioText = (r) => (!Number.isFinite(r) ? 'inf:1' : r >= 1 ? `${r.toFixed(2)}:1` : `1:${(1 / r).toFixed(2)}`);

/**
 * The inverse of a transfer curve ([{ x, y }] in dB over [lo, hi]): every
 * point mirrored across the unity line, so a compressor becomes the matching
 * expander and back. Points that land on the same input level are spread
 * 0.1 dB apart, and the ends are extended at unity gain (held at the top)
 * so the curve still spans the whole input range.
 */
export function invertCurve(points, lo = -100, hi = 0) {
  const r1 = (v) => Math.round(v * 10) / 10;
  const out = (points || []).map((q) => ({ x: q.y, y: q.x })).sort((a, b) => a.x - b.x || a.y - b.y);
  for (let k = 1; k < out.length; k++) if (out[k].x <= out[k - 1].x) out[k] = { ...out[k], x: r1(out[k - 1].x + 0.1) };
  if (!out.length) return [{ x: lo, y: lo }, { x: hi, y: hi }];
  const first = out[0];
  const last = out[out.length - 1];
  if (first.x > lo) out.unshift({ x: lo, y: Math.max(lo, r1(first.y - (first.x - lo))) });
  if (last.x < hi) out.push({ x: hi, y: Math.min(hi, r1(last.y + (hi - last.x))) });
  return out.filter((q) => q.x <= hi + 1e-9).map((q) => ({ x: Math.min(hi, q.x), y: Math.min(hi, Math.max(lo, q.y)) }));
}

export function dynamicsProcessingEditor({ id = 'curve' } = {}) {
  const inner = transferCurveEditor({ id, spline: { id: 'spline', at: splineOutput } });
  return (ctx) => {
    const p = ctx.def.params.find((q) => q.id === id);
    const graph = inner(ctx);
    const pts = () => [...(ctx.values[id] || [])].sort((a, b) => a.x - b.x);
    const addBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Add a point', title: 'Add a point in the middle of the longest segment', onclick: () => {
      const list = pts();
      let best = 1;
      for (let k = 1; k < list.length; k++) if (list[k].x - list[k - 1].x > list[best].x - list[best - 1].x) best = k;
      const a = list[best - 1];
      const b = list[best];
      const x = Math.round(((a.x + b.x) / 2) * 10) / 10;
      list.splice(best, 0, { x, y: Math.round(((a.y + b.y) / 2) * 10) / 10 });
      ctx.set(id, list);
    } }, icon('plus', 15));
    const removeBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Remove a point', title: 'Remove the focused point (or the last inner point)', onclick: () => {
      const list = pts();
      if (list.length <= 2) return;
      const handles = [...graph.querySelectorAll('.fx-point')];
      const focused = handles.indexOf(document.activeElement);
      const k = focused > 0 && focused < list.length - 1 ? focused : list.length - 2;
      list.splice(k, 1);
      ctx.set(id, list);
    } }, icon('minus', 15));
    // Mirror the curve across the unity line: compression becomes expansion and back.
    const invertBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Invert the curve', title: 'Invert the curve: compression becomes expansion and back', onclick: () => ctx.set(id, invertCurve(pts(), p.min ?? -100, p.max ?? 0)) }, glyph(['M5 19L19 5', 'M8 5h11v11', 'M5 8v11h11'], 15));
    const resetBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Reset the curve', title: 'Reset the curve', onclick: () => ctx.set(id, structuredClone(p.default)) }, icon('rotate-ccw', 15));
    const splineBox = h('input', { type: 'checkbox', checked: Boolean(ctx.values.spline), onchange: () => ctx.set('spline', splineBox.checked) });
    const splineEl = ctx.def.params.some((q) => q.id === 'spline') ? h('label.check.fx-check', { title: 'Bend the curve smoothly through its points' }, splineBox, 'Spline Curves') : null;
    const tools = h('div.fx-dp-tools', addBtn, removeBtn, invertBtn, resetBtn, splineEl);
    const body = h('tbody');
    const table = h('table.fx-dp-table', h('thead', h('tr', h('th', 'Segment'), h('th', 'Ratio'), h('th', 'Type'), h('th', 'Threshold'))), body);
    const update = (values) => {
      const segs = curveSegments(values[id]);
      body.replaceChildren(...segs.map((s, i) => h('tr', h('td', String(i + 1)), h('td', ratioText(s.ratio)), h('td', s.type), h('td', s.threshold))));
      removeBtn.disabled = (values[id] || []).length <= 2;
      splineBox.checked = Boolean(values.spline);
    };
    ctx.subscribe(update);
    update(ctx.values);
    return h('div.fx-dp', graph, tools, h('div.fx-dp-scroll', table));
  };
}

// ------------------------------------------------------------- DeEsser

export function deesserEditor() {
  return (ctx) => {
    const meter = levelMeter({ label: 'Reduction', kind: 'gr', min: -24, vertical: true });
    const view = plot('fx-band', 'Sibilance band', (g, W, H) => {
      const yOf = freqGrid(g, W, H, { top: 0, bottom: -120, step: 10 });
      const v = ctx.values;
      const lo = Math.max(FREQ_MIN, v.frequency - v.bandwidth / 2);
      const hi = Math.min(FREQ_MAX, v.frequency + v.bandwidth / 2);
      const x0 = xOfF(lo, W);
      const x1 = xOfF(hi, W);
      // The band the detector listens to; in multiband mode only it is processed.
      g.fillStyle = cssVar('--accent-soft');
      g.fillRect(x0, 0, x1 - x0, H);
      g.strokeStyle = cssVar('--text-strong');
      g.lineWidth = 1;
      for (const x of [x0, x1]) {
        g.beginPath();
        g.moveTo(Math.round(x) + 0.5, 0);
        g.lineTo(Math.round(x) + 0.5, H);
        g.stroke();
      }
      const ty = yOf(v.threshold);
      g.strokeStyle = cssVar('--envelope-vol');
      g.setLineDash([4, 3]);
      g.beginPath();
      g.moveTo(v.mode === 1 ? x0 : 0, ty);
      g.lineTo(v.mode === 1 ? x1 : W, ty);
      g.stroke();
      g.setLineDash([]);
    });
    const handle = h('button.fx-handle', { type: 'button', role: 'slider', 'aria-label': 'Center frequency' });
    view.layer.append(handle);
    freqDrag(handle, view.el, (f, steps) => ctx.set('frequency', f ?? ctx.values.frequency * Math.pow(2, steps / 12)));
    const update = (v) => {
      handle.style.left = `${(xOfF(v.frequency, 1) * 100).toFixed(3)}%`;
      handle.style.top = `${clamp(-v.threshold / 120, 0, 1) * 100}%`;
      handle.setAttribute('aria-valuenow', String(v.frequency));
      handle.setAttribute('aria-valuetext', formatValue(ctx.def.params.find((q) => q.id === 'frequency'), v.frequency));
      view.redraw();
    };
    ctx.subscribe(update);
    update(ctx.values);
    ctx.onReadout((r) => meter.set(r[0]));
    return h('div.fx-band-wrap', view.el, h('div.fx-band-meter', meter.el));
  };
}

// --------------------------------------------------- Multiband Compressor

const BAND_KEYS = ['band1', 'band2', 'band3', 'band4'];
// Muted band colours that read on both the dark and the light theme.
const BAND_COLOURS = ['#3f7d93', '#a8792e', '#6f8a3a', '#8e4f9c'];
const BAND_NAMES = ['Low', 'Low Mid', 'High Mid', 'High'];

export function multibandEditor() {
  return (ctx) => {
    const v0 = () => ctx.values;
    const edges = (v) => [FREQ_MIN, v.xover1, v.xover2, v.xover3, FREQ_MAX];
    const levels = [-120, -120, -120, -120];
    const reds = [0, 0, 0, 0];
    // Spectrum on Input: the live input spectrum behind the bands.
    const spec = liveSpectrum(ctx, { onFrame: () => ctx.values.spectrum && view.redraw() });
    const view = plot('fx-mb', 'Crossovers and band levels', (g, W, H) => {
      const yOf = freqGrid(g, W, H, { top: 0, bottom: -80, step: 10 });
      const v = v0();
      const e = edges(v);
      if (v.spectrum && spec.live()) {
        g.strokeStyle = cssVar('--text-faint');
        g.lineWidth = 1;
        drawSpectrum(g, spec, (f) => xOfF(f, W), yOf, { H, fill: cssVar('--wave-dim') });
      }
      for (let b = 0; b < 4; b++) {
        const x0 = xOfF(e[b], W);
        const x1 = xOfF(e[b + 1], W);
        const colour = BAND_COLOURS[b];
        const muted = (v[`${BAND_KEYS[b]}Bypass`] || BAND_KEYS.some((k) => v[`${k}Solo`])) && !v[`${BAND_KEYS[b]}Solo`];
        // Input level as a bar, reduction stacked on top of the output level.
        g.globalAlpha = muted ? 0.15 : 0.35;
        g.fillStyle = colour;
        const y = yOf(clamp(levels[b], -80, 0));
        g.fillRect(x0 + 1, y, x1 - x0 - 2, H - y);
        g.globalAlpha = 1;
        const ty = yOf(v[`${BAND_KEYS[b]}Threshold`]);
        g.strokeStyle = colour;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(x0 + 1, ty);
        g.lineTo(x1 - 1, ty);
        g.stroke();
        if (reds[b] < -0.1) {
          g.fillStyle = cssVar('--meter-red');
          g.fillRect(x0 + 1, 0, x1 - x0 - 2, Math.min(H, (-reds[b] / 80) * H));
        }
      }
    });
    // Crossovers keep their order, 10 % apart, as the processor does.
    const setXover = (k, f) => {
      const v = ctx.values;
      const lo = k > 1 ? v[`xover${k - 1}`] * 1.1 : FREQ_MIN;
      const hi = k < 3 ? v[`xover${k + 1}`] / 1.1 : FREQ_MAX;
      ctx.set(`xover${k}`, clamp(f, lo, Math.max(lo, hi)));
    };
    const handles = [1, 2, 3].map((k) => {
      const btn = h('button.fx-handle.fx-xover', { type: 'button', role: 'slider', 'aria-label': ['Low crossover', 'Mid crossover', 'High crossover'][k - 1] });
      freqDrag(btn, view.el, (f, steps) => setXover(k, f ?? ctx.values[`xover${k}`] * Math.pow(2, steps / 12)));
      view.layer.append(btn);
      return btn;
    });
    const xoverRow = h('div.fx-mb-xovers', h('span.fx-label', 'Crossover:'), ...[1, 2, 3].flatMap((k) => {
      const hot = paramHot(ctx, `xover${k}`, { set: (f) => setXover(k, f) });
      ctx.subscribe(hot.show);
      return [h('span.fx-label', `${['Low', 'Mid', 'High'][k - 1]}:`), hot.el];
    }));
    // Link Band Controls: a change to one band's setting moves every band by
    // the same amount (dB settings) or the same factor (ratio and times).
    const bandCtx = {
      ...ctx,
      get values() {
        return ctx.values;
      },
      set: (id, v) => {
        const m = /^(band\d)(Threshold|Gain|Ratio|Attack|Release)$/.exec(id);
        const old = ctx.values[id];
        if (!m || !ctx.values.linkBands || !Number.isFinite(old)) return ctx.set(id, v);
        const additive = m[2] === 'Threshold' || m[2] === 'Gain';
        for (const k of BAND_KEYS) {
          const other = `${k}${m[2]}`;
          const p = ctx.def.params.find((q) => q.id === other);
          const cur = ctx.values[other];
          const next = other === id ? v : additive ? cur + (v - old) : old > 0 ? cur * (v / old) : v;
          ctx.set(other, clamp(next, p.min, p.max));
        }
      },
    };
    const strips = BAND_KEYS.map((key, b) => {
      const toggle = (role, text, title) => {
        const id = `${key}${role}`;
        const btn = h(`button.fx-mb-toggle.${role.toLowerCase()}`, { type: 'button', 'aria-pressed': String(Boolean(ctx.values[id])), 'aria-label': `${title} ${BAND_NAMES[b]}`, title: `${title} the ${BAND_NAMES[b].toLowerCase()} band`, onclick: () => ctx.set(id, !ctx.values[id]) }, text);
        return { btn, show: (v) => btn.setAttribute('aria-pressed', String(Boolean(v[id]))) };
      };
      const solo = toggle('Solo', 'S', 'Solo');
      const bypass = toggle('Bypass', 'B', 'Bypass');
      const inMeter = levelMeter({ label: 'In', kind: 'level', min: -60, vertical: true });
      const grMeter = levelMeter({ label: 'GR', kind: 'gr', min: -24, vertical: true });
      const rows = ['Threshold', 'Gain', 'Ratio', 'Attack', 'Release'].map((role) => {
        const hot = paramHot(bandCtx, `${key}${role}`, { label: `${BAND_NAMES[b]} ${role.toLowerCase()}` });
        ctx.subscribe(hot.show);
        return h('div.fx-mb-row', h('span.fx-label', `${role === 'Threshold' ? 'Thresh' : role}:`), hot.el);
      });
      const el = h('div.fx-mb-strip', { style: { '--band': BAND_COLOURS[b] }, role: 'group', 'aria-label': `${BAND_NAMES[b]} band` }, h('div.fx-mb-head', h('span', BAND_NAMES[b]), solo.btn, bypass.btn), h('div.fx-mb-meters', inMeter.el, grMeter.el), rows);
      return { el, show: (v) => (solo.show(v), bypass.show(v)), inMeter, grMeter };
    });
    const update = (v) => {
      [1, 2, 3].forEach((k, i) => {
        handles[i].style.left = `${(xOfF(v[`xover${k}`], 1) * 100).toFixed(3)}%`;
        handles[i].style.top = '50%';
        handles[i].setAttribute('aria-valuenow', String(v[`xover${k}`]));
        handles[i].setAttribute('aria-valuetext', `${Math.round(v[`xover${k}`])} Hz`);
      });
      strips.forEach((s) => s.show(v));
      view.redraw();
    };
    ctx.subscribe(update);
    update(ctx.values);
    ctx.onReadout((r) => {
      if (r.length < 9) return;
      for (let b = 0; b < 4; b++) {
        levels[b] = r[2 * b];
        reds[b] = r[2 * b + 1];
        strips[b].inMeter.set(r[2 * b]);
        strips[b].grMeter.set(r[2 * b + 1]);
      }
      view.redraw();
    });
    return h('div.fx-mb-editor', view.el, xoverRow, h('div.fx-mb-strips', strips.map((s) => s.el)));
  };
}
