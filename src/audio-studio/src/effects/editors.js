// Reusable graphical editors for effect dialogs. An effect definition can use
// one as its `editor`, or the dialog picks one automatically from the
// parameter ids (autoEditor):
//
//   editor: eqEditor()                  parametric/graphic EQ curve with draggable band handles
//                                        (draws def.response(values, freqs, rate) when the definition has one)
//   editor: eqEditor({ bands: (values) => [{ type, freq, gain, q, enabled, ids: { freq, gain, q } }] })
//   editor: transferEditor()            static input/output curve for dynamics and limiters
//   display: 'loudness'                 live loudness meter (meter-view.js) fed by the readout
//   params: [{ id: 'curve', type: 'transfer', ... }]
//                                        renders transferCurveEditor: a drawn input/output level
//                                        curve with a live level dot from the effect's readout
//   params: [{ id: 'envelope', type: 'envelope', min: 0, max: 200, unit: '%', default: [{ t: 0, v: 100 }, { t: 1, v: 100 }] }]
//                                        renders envelopeControl for that param
//
// Every editor receives ctx = { values, set(id, value), subscribe(fn), def, app, doc }
// and returns an element. Handles are focusable sliders: arrows move them,
// Shift moves further, Delete removes envelope points.

import { h } from '../lib/dom.js';
import { cssVar, CANVAS_FONT } from '../ui/theme.js';
import { combinedResponse, logFrequencies, qForBandwidth, filterTypeFromLabel } from './biquad.js';
import { addPoint, movePoint, removePoint, normalizeEnvelope, renderEnvelope } from './envelope.js';
import { formatValue } from './params.js';
import { loudnessMeterEditor } from './meter-view.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Plots repainted on a theme change. One window listener serves them all; a
// plot that has been on the page and left it (its dialog closed) is dropped,
// so closed dialogs are not kept alive by the listener.
const themed = new Set();
const dropClosedPlots = () => {
  for (const p of themed) if (p.shown && !p.el.isConnected) themed.delete(p);
};
if (typeof window !== 'undefined') {
  window.addEventListener('themechange', () => {
    dropClosedPlots();
    for (const p of themed) p.redraw();
  });
}

/** A canvas plot with an overlay layer for handle buttons; redraws on resize and theme change. */
export function plot(className, label, draw) {
  const canvas = h('canvas', { 'aria-hidden': 'true' });
  const layer = h('div.fx-plot-layer');
  const el = h(`div.fx-plot.${className}`, { role: 'group', 'aria-label': label }, canvas, layer);
  let raf = 0;
  const entry = { el, shown: false, redraw: null };
  const redraw = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (el.isConnected) entry.shown = true;
      const W = el.clientWidth;
      const H = el.clientHeight;
      if (!W || !H) return;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      draw(ctx, W, H);
    });
  };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(redraw).observe(el);
  entry.redraw = redraw;
  dropClosedPlots();
  themed.add(entry);
  return { el, canvas, layer, redraw };
}

/** Drag helper for a handle: calls onMove(fx, fy) with fractions of the plot box. */
export function draggable(handle, box, onMove, onEnd) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    handle.focus();
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const r = box.getBoundingClientRect();
      onMove(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1), ev);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      onEnd?.();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

export function gridLines(ctx, W, H, xs, ys) {
  ctx.strokeStyle = cssVar('--grid');
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const x of xs) {
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, H);
  }
  for (const y of ys) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(W, Math.round(y) + 0.5);
  }
  ctx.stroke();
}

export function labelText(ctx, text, x, y, align = 'left') {
  ctx.fillStyle = cssVar('--text-faint');
  ctx.font = CANVAS_FONT;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  ctx.fillText(text, x, y);
}

// ------------------------------------------------------------- EQ curve

const ROLES = [
  ['freq', /^(freq|frequency|f|fc|hz|cutoff|center|centre)$/i],
  ['gain', /^(gain|g|level|boost|amount)$/i],
  ['q', /^(q|width|bw|bandwidth|res|resonance)$/i],
  ['type', /^(type|shape|filter|mode)$/i],
  ['on', /^(on|enabled|enable|active|band)$/i],
  ['order', /^(order|slope|poles)$/i],
];

function roleOf(word) {
  return ROLES.find(([, re]) => re.test(word))?.[0] || null;
}

function splitId(id) {
  let m = id.match(/^b(?:and)?(\d+)[_-]?([a-z]+)$/i);
  if (m) return { band: m[1], role: roleOf(m[2]) };
  m = id.match(/^([a-z]+?)[_-]?(\d+)$/i);
  if (m) return { band: m[2], role: roleOf(m[1]) };
  m = id.match(/^([a-z]+?)(Freq|Frequency|Gain|Q|Type|On|Enabled|Width|Order|Slope)$/);
  if (m) return { band: m[1], role: roleOf(m[2]), named: true };
  return null;
}

function typeForName(name) {
  const s = name.toLowerCase();
  if (/^(hp|highpass|lowcut|locut)$/.test(s)) return 'highpass';
  if (/^(lp|lowpass|highcut|hicut)$/.test(s)) return 'lowpass';
  if (/^(low|lowshelf|ls|bass)$/.test(s)) return 'lowshelf';
  if (/^(high|highshelf|hs|treble)$/.test(s)) return 'highshelf';
  if (/notch/.test(s)) return 'notch';
  return 'peaking';
}

function parseLabelFreq(text) {
  const m = String(text).match(/(\d+(?:\.\d+)?)\s*(k)?\s*(hz)?/i);
  if (!m) return null;
  const v = Number(m[1]) * (m[2] ? 1000 : 1);
  return v >= 10 && v <= 24000 ? v : null;
}

/**
 * Band layout of an EQ definition from its param ids:
 *  freq1/gain1/q1/type1/on1, band1Freq, b1_gain, lowFreq/lowGain... (parametric)
 *  or dB sliders labelled with a centre frequency ("31.5 Hz", "1k") (graphic).
 * Returns { bands: [{ key, ids, fixed }], offsetId } or null.
 */
export function detectBands(def) {
  const groups = new Map();
  for (const p of def.params) {
    const s = splitId(p.id);
    if (!s || !s.role) continue;
    if (!groups.has(s.band)) groups.set(s.band, { key: s.band, ids: {}, named: s.named });
    groups.get(s.band).ids[s.role] = p.id;
  }
  const bands = [...groups.values()].filter((b) => b.ids.freq);
  const used = new Set(bands.flatMap((b) => Object.values(b.ids)));
  const offsetId = def.params.find((p) => !used.has(p.id) && p.unit === 'dB' && /^(master|mastergain|output|outputgain|gain|makeup)$/i.test(p.id))?.id || null;
  if (bands.length) return { bands, offsetId, graphic: false };
  const graphic = def.params
    .filter((p) => (p.type || 'number') === 'number' && p.unit === 'dB' && p.id !== offsetId)
    .map((p) => ({ p, f: parseLabelFreq(p.label) ?? parseLabelFreq(p.id.replace(/^\D+/, '')) }))
    .filter((x) => x.f);
  if (graphic.length >= 3) {
    const fs = graphic.map((x) => x.f);
    const oct = Math.log2(Math.max(...fs) / Math.min(...fs)) / (fs.length - 1);
    return { bands: graphic.map((x, i) => ({ key: String(i), ids: { gain: x.p.id }, fixed: { freq: x.f, type: 'peaking', q: qForBandwidth(oct) } })), offsetId, graphic: true };
  }
  return null;
}

function bandsFromLayout(def, layout, values) {
  const param = (id) => def.params.find((p) => p.id === id);
  return layout.bands.map((b) => {
    const typeParam = b.ids.type && param(b.ids.type);
    let type = b.fixed?.type || (b.named ? typeForName(b.key) : 'peaking');
    if (typeParam) {
      const v = values[b.ids.type];
      const opt = typeParam.options?.find((o) => String(o.value) === String(v));
      type = filterTypeFromLabel(opt ? opt.label : v);
    }
    return {
      key: b.key,
      type,
      freq: b.fixed?.freq ?? Number(values[b.ids.freq]),
      gain: b.ids.gain ? Number(values[b.ids.gain]) : 0,
      q: b.ids.q ? Number(values[b.ids.q]) : b.fixed?.q ?? 0.707,
      order: b.ids.order ? Number(values[b.ids.order]) || 1 : 1,
      enabled: b.ids.on ? Boolean(values[b.ids.on]) : true,
      ids: b.ids,
    };
  });
}

/**
 * EQ curve editor. Options: bands(values) to describe bands yourself (each
 * with ids for the params a handle drags), range (dB, or fn(values); default from params),
 * offset(values) for a master gain in dB.
 */
export function eqEditor(opts = {}) {
  return (ctx) => {
    const { def } = ctx;
    const layout = opts.bands ? null : detectBands(def);
    const getBands = (values) => (opts.bands ? opts.bands(values) : layout ? bandsFromLayout(def, layout, values) : []);
    const offset = (values) => (opts.offset ? opts.offset(values) : layout?.offsetId ? Number(values[layout.offsetId]) || 0 : 0);
    const gainParams = def.params.filter((p) => p.unit === 'dB');
    const fixedRange = Math.min(48, Math.max(12, ...gainParams.map((p) => Math.max(Math.abs(p.min ?? 0), Math.abs(p.max ?? 0)))));
    // opts.range: a span in dB, or fn(values) for a span the dialog switches (Parametric EQ Range).
    const rangeNow = () => (typeof opts.range === 'function' ? opts.range(ctx.values) : opts.range || fixedRange);
    let range = rangeNow();
    const rate = ctx.doc?.sampleRate || 48000;
    const fMin = 20;
    const fMax = Math.min(20000, rate / 2);
    const freqs = logFrequencies(320, fMin, fMax);
    const xOf = (f, W) => (Math.log(f / fMin) / Math.log(fMax / fMin)) * W;
    const yOf = (db, H) => H / 2 - (db / range) * (H / 2 - 8);
    const param = (id) => def.params.find((p) => p.id === id);

    const view = plot('fx-eq', 'Equalizer curve', (g, W, H) => {
      range = rangeNow();
      const xs = [50, 100, 200, 500, 1000, 2000, 5000, 10000].filter((f) => f < fMax).map((f) => xOf(f, W));
      const step = range > 24 ? 12 : range % 6 ? 5 : 6;
      const ys = [];
      for (let d = Math.ceil(-range / step) * step; d <= range; d += step) ys.push(yOf(d, H));
      gridLines(g, W, H, xs, ys);
      g.strokeStyle = cssVar('--grid-strong');
      g.beginPath();
      g.moveTo(0, Math.round(yOf(0, H)) + 0.5);
      g.lineTo(W, Math.round(yOf(0, H)) + 0.5);
      g.stroke();
      for (const f of [100, 1000, 10000]) if (f < fMax) labelText(g, f >= 1000 ? `${f / 1000}k` : String(f), xOf(f, W) + 3, H - 14);
      for (const d of range % 6 ? [range, 10, 5, -5, -10] : [range, range / 2, -range / 2]) labelText(g, `${d > 0 ? '+' : ''}${Math.round(d)}`, 3, yOf(d, H) + 2);
      const values = ctx.values;
      // A definition's own response (exact for its filter design) wins over the biquad model.
      const resp = def.response && !opts.bands ? def.response(values, freqs, rate) : combinedResponse(getBands(values), freqs, rate, offset(values));
      g.strokeStyle = cssVar('--wave');
      g.lineWidth = 2;
      g.beginPath();
      for (let i = 0; i < freqs.length; i++) {
        const x = xOf(freqs[i], W);
        const y = clamp(yOf(resp[i], H), -2, H + 2);
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.stroke();
    });

    let handles = [];
    const placeHandles = () => {
      const bands = getBands(ctx.values);
      if (handles.length !== bands.length) {
        view.layer.replaceChildren();
        handles = bands.map((b, i) => {
          // Band tables name their columns (HP, L, 1..5, H, LP); handles use the same names.
          const sec = b.ids.freq && param(b.ids.freq)?.section;
          const name = def.layout?.table?.columns.find((c) => c.section === sec)?.label || String(i + 1);
          const btn = h('button.fx-handle', { type: 'button', role: 'slider', 'aria-label': sec || `Band ${i + 1}` }, h('span', name));
          draggable(btn, view.el, (fx, fy) => {
            const band = getBands(ctx.values)[i];
            if (band.ids.freq) {
              const p = param(band.ids.freq);
              ctx.set(band.ids.freq, fMin * Math.pow(fMax / fMin, fx), p);
            }
            if (band.ids.gain && !['lowpass', 'highpass', 'bandpass', 'notch'].includes(band.type)) {
              ctx.set(band.ids.gain, ((0.5 - fy) * 2 * range * view.el.clientHeight) / (view.el.clientHeight - 16));
            }
          });
          btn.addEventListener('keydown', (e) => {
            const band = getBands(ctx.values)[i];
            const big = e.shiftKey ? 4 : 1;
            if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && band.ids.freq) {
              ctx.set(band.ids.freq, band.freq * Math.pow(2, ((e.key === 'ArrowRight' ? 1 : -1) * big) / 12));
            } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey && band.ids.q) {
              ctx.set(band.ids.q, band.q * Math.pow(1.15, e.key === 'ArrowUp' ? big : -big));
            } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && band.ids.gain) {
              ctx.set(band.ids.gain, band.gain + (e.key === 'ArrowUp' ? 0.5 : -0.5) * big);
            } else return;
            e.preventDefault();
            e.stopPropagation();
          });
          btn.addEventListener('wheel', (e) => {
            const band = getBands(ctx.values)[i];
            if (!band.ids.q) return;
            e.preventDefault();
            ctx.set(band.ids.q, band.q * Math.pow(1.1, e.deltaY < 0 ? 1 : -1));
          }, { passive: false });
          view.layer.append(btn);
          return btn;
        });
      }
      bands.forEach((b, i) => {
        const btn = handles[i];
        const fx = Math.log(clamp(b.freq, fMin, fMax) / fMin) / Math.log(fMax / fMin);
        const g = ['lowpass', 'highpass', 'bandpass', 'notch'].includes(b.type) ? 0 : b.gain;
        const fr = clamp(g, -range, range) / range;
        btn.style.left = `${fx * 100}%`;
        btn.style.top = `calc(${50 - 50 * fr}% + ${(8 * fr).toFixed(2)}px)`;
        btn.classList.toggle('off', !b.enabled);
        const fText = b.freq >= 1000 ? `${(b.freq / 1000).toFixed(2)} kHz` : `${Math.round(b.freq)} Hz`;
        btn.setAttribute('aria-valuetext', `${fText}, ${g.toFixed(1)} dB${b.ids.q ? `, Q ${b.q.toFixed(2)}` : ''}`);
        btn.title = `Band ${i + 1}: ${fText}, ${g.toFixed(1)} dB${b.ids.q ? `, Q ${b.q.toFixed(2)}` : ''}. Arrows move, Alt+Up/Down or the wheel change Q.`;
        btn.setAttribute('aria-valuenow', String(Math.round(b.freq)));
      });
    };
    const update = () => {
      range = rangeNow();
      placeHandles();
      view.redraw();
    };
    ctx.subscribe(update);
    update();
    return view.el;
  };
}

// --------------------------------------------------------- transfer curve

/**
 * Static gain curve: input dB to output dB.
 * o: { threshold, ratio, knee, makeup, boost, ceiling }
 */
export function transferCurve(x, { threshold = 0, ratio = 1, knee = 0, makeup = 0, boost = 0, ceiling = null } = {}) {
  const xin = x + boost;
  let y = xin;
  const r = Math.max(1, ratio);
  const over = xin - threshold;
  if (knee > 0 && Math.abs(over) <= knee / 2) y = xin + ((1 / r - 1) * (over + knee / 2) ** 2) / (2 * knee);
  else if (over > 0) y = threshold + over / r;
  y += makeup;
  if (ceiling != null) y = Math.min(y, ceiling);
  return y;
}

const DYN_ROLES = {
  threshold: /thresh/i,
  ratio: /ratio/i,
  knee: /knee/i,
  makeup: /makeup|^output|outputgain|^gain$/i,
  boost: /boost|^input|inputgain/i,
  ceiling: /ceiling|maxamp|maximum|^limit/i,
};

export function detectDynamics(def) {
  const ids = {};
  for (const p of def.params) {
    if ((p.type || 'number') !== 'number') continue;
    for (const [role, re] of Object.entries(DYN_ROLES)) if (!ids[role] && re.test(p.id)) ids[role] = p.id;
  }
  return ids.threshold || ids.ceiling ? ids : null;
}

export function transferEditor(opts = {}) {
  return (ctx) => {
    const ids = opts.ids || detectDynamics(ctx.def) || {};
    const lo = opts.floor ?? -60;
    const curve = (values) => {
      const o = {};
      for (const [role, id] of Object.entries(ids)) o[role] = Number(values[id]);
      if (!ids.ratio && ids.ceiling) o.ratio = 1;
      return o;
    };
    const pos = (db, W) => ((db - lo) / -lo) * W;
    const view = plot('fx-transfer', 'Transfer curve', (g, W, H) => {
      const ticks = [];
      for (let d = lo; d <= 0; d += 10) ticks.push(d);
      gridLines(g, W, H, ticks.map((d) => pos(d, W)), ticks.map((d) => H - pos(d, H)));
      g.strokeStyle = cssVar('--grid-strong');
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(0, H);
      g.lineTo(W, 0);
      g.stroke();
      g.setLineDash([]);
      for (const d of [-40, -20]) {
        labelText(g, `${d}`, pos(d, W) + 2, H - 14);
        labelText(g, `${d}`, 3, H - pos(d, H) + 2);
      }
      const o = curve(ctx.values);
      g.strokeStyle = cssVar('--wave');
      g.lineWidth = 2;
      g.beginPath();
      for (let i = 0; i <= 120; i++) {
        const x = lo + (-lo * i) / 120;
        const y = clamp(transferCurve(x, o), lo - 6, 6);
        const px = pos(x, W);
        const py = H - pos(y, H);
        if (i) g.lineTo(px, py);
        else g.moveTo(px, py);
      }
      g.stroke();
    });
    const handleId = ids.threshold || ids.ceiling;
    const handle = h('button.fx-handle', { type: 'button', role: 'slider', 'aria-label': ids.threshold ? 'Threshold' : 'Ceiling' });
    view.layer.append(handle);
    const p = ctx.def.params.find((q) => q.id === handleId);
    draggable(handle, view.el, (fx) => ctx.set(handleId, lo + fx * -lo));
    handle.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      ctx.set(handleId, Number(ctx.values[handleId]) + d * (e.shiftKey ? 5 : 0.5));
    });
    const update = () => {
      const v = Number(ctx.values[handleId]);
      const o = curve(ctx.values);
      const at = ids.threshold ? v - (o.boost || 0) : v;
      handle.style.left = `${clamp((at - lo) / -lo, 0, 1) * 100}%`;
      handle.style.top = `${(1 - clamp((transferCurve(at, o) - lo) / -lo, 0, 1)) * 100}%`;
      handle.setAttribute('aria-valuenow', String(v));
      handle.setAttribute('aria-valuetext', p ? formatValue(p, v) : `${v} dB`);
      view.redraw();
    };
    ctx.subscribe(update);
    update();
    return view.el;
  };
}

// -------------------------------------------------------- envelope control

/**
 * Breakpoint envelope editor for a param of type 'envelope'.
 * o: { param, value (points), onChange(points), smooth: () => bool, doc, range: [start, end],
 *      render(points, n) to draw the curve some other way (n samples across) }
 * Click empty space to add a point, drag points, Delete or double-click to remove.
 */
export function envelopeControl({ param, value, onChange, smooth = () => false, doc = null, range = null, xLabel = (t) => `${Math.round(t * 100)}%`, xTicks = [0.25, 0.5, 0.75], xTickLabels = [], yTicks = null, overlay = null, className = '', pointText = null, render = null }) {
  const min = param.min ?? 0;
  const max = param.max ?? 100;
  const fmt = (v) => formatPoint(param, v);
  let points = normalizeEnvelope(value, { min, max });
  let focused = -1;
  const peaks = doc && range ? overviewPeaks(doc, range[0], range[1], 400) : null;
  const yOf = (v, H) => H - 6 - ((v - min) / (max - min || 1)) * (H - 12);
  const view = plot('fx-envelope', `${param.label || 'Envelope'} editor`, (g, W, H) => {
    if (peaks) {
      g.fillStyle = cssVar('--wave-dim');
      const mid = H / 2;
      for (let i = 0; i < peaks.length; i++) {
        const x = (i / peaks.length) * W;
        const a = peaks[i] * (H / 2 - 4);
        g.fillRect(x, mid - a, Math.max(1, W / peaks.length), 2 * a || 1);
      }
    }
    const ys = [];
    if (yTicks) for (const v of yTicks) ys.push(yOf(v, H));
    else for (let k = 0; k <= 4; k++) ys.push(yOf(min + ((max - min) * k) / 4, H));
    gridLines(g, W, H, xTicks.map((f) => f * W), ys);
    if (yTicks) yTicks.forEach((v) => labelText(g, fmt(v).replace(/\.0 /, ' '), 3, yOf(v, H) + 2));
    labelText(g, fmt(max), 3, 3);
    labelText(g, fmt(min), 3, H - 16);
    xTickLabels.forEach((text, i) => text && labelText(g, text, xTicks[i] * W + 3, H - 14));
    const curve = render ? render(points, Math.max(2, Math.round(W))) : renderEnvelope(points, Math.max(2, Math.round(W)), { smooth: smooth() });
    g.strokeStyle = cssVar('--envelope-vol');
    g.lineWidth = 2;
    g.beginPath();
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * W;
      const y = yOf(curve[i], H);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.stroke();
    overlay?.(g, W, H, { yOf });
  });
  if (className) view.el.classList.add(className);
  const topFor = (v) => {
    const fr = (v - min) / (max - min || 1);
    return `calc(${((1 - fr) * 100).toFixed(3)}% + ${(12 * fr - 6).toFixed(2)}px)`;
  };
  const emit = () => onChange?.(points);
  const place = (btn, pt, i) => {
    btn.setAttribute('aria-label', `Point ${i + 1} of ${points.length}`);
    btn.setAttribute('aria-valuenow', String(pt.v));
    btn.setAttribute('aria-valuetext', pointText ? pointText(pt) : `${xLabel(pt.t)}, ${fmt(pt.v)}`);
    btn.title = pointText ? pointText(pt) : `${xLabel(pt.t)}: ${fmt(pt.v)}`;
    btn.style.left = `${pt.t * 100}%`;
    btn.style.top = topFor(pt.v);
  };
  const layout = () => {
    // The same number of points keeps the handles in place, so a handle being
    // dragged keeps its pointer capture (rebuilding it would end the drag).
    if (view.layer.children.length === points.length) {
      points.forEach((pt, i) => place(view.layer.children[i], pt, i));
      return;
    }
    view.layer.replaceChildren(
      ...points.map((pt, i) => {
        const btn = h('button.fx-handle.fx-point', { type: 'button', role: 'slider' });
        place(btn, pt, i);
        draggable(btn, view.el, (fx, fy) => {
          const H = view.el.clientHeight;
          const v = min + ((H - 6 - fy * H) / (H - 12)) * (max - min);
          points = movePoint(points, i, fx, roundStep(v), { min, max });
          focused = i;
          sync();
        });
        btn.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          points = removePoint(points, i);
          focused = Math.min(i, points.length - 1);
          sync(true);
        });
        btn.addEventListener('focus', () => (focused = i));
        btn.addEventListener('keydown', (e) => {
          const big = e.shiftKey ? 10 : 1;
          const step = param.step || (max - min) / 100;
          const pt2 = points[i];
          if (e.key === 'ArrowLeft') points = movePoint(points, i, pt2.t - 0.01 * big, pt2.v, { min, max });
          else if (e.key === 'ArrowRight') points = movePoint(points, i, pt2.t + 0.01 * big, pt2.v, { min, max });
          else if (e.key === 'ArrowUp') points = movePoint(points, i, pt2.t, roundStep(pt2.v + step * big), { min, max });
          else if (e.key === 'ArrowDown') points = movePoint(points, i, pt2.t, roundStep(pt2.v - step * big), { min, max });
          else if (e.key === 'Delete' || e.key === 'Backspace') {
            points = removePoint(points, i);
            focused = Math.max(0, i - 1);
          } else if (e.key === 'Insert' || e.key === '+') {
            const nxt = points[Math.min(i + 1, points.length - 1)];
            const r = addPoint(points, (pt2.t + nxt.t) / 2);
            if (r.index >= 0) {
              points = r.points;
              focused = r.index;
            }
          } else return;
          e.preventDefault();
          e.stopPropagation();
          sync(true);
        });
        return btn;
      }),
    );
  };
  const roundStep = (v) => (param.step ? Math.round(v / param.step) * param.step : v);
  const sync = (refocus = false) => {
    layout();
    view.redraw();
    emit();
    if (refocus && focused >= 0) view.layer.children[focused]?.focus();
  };
  view.el.addEventListener('pointerdown', (e) => {
    if (e.target !== view.el && e.target.tagName !== 'CANVAS' && e.target !== view.layer) return;
    const r = view.el.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    const H = r.height;
    const v = min + ((H - 6 - fy * H) / (H - 12)) * (max - min);
    const res = addPoint(points, fx, clamp(roundStep(v), min, max));
    if (res.index < 0) return;
    points = res.points;
    focused = res.index;
    sync(true);
  });
  view.el.title = 'Click to add a point. Drag points to move them; double-click or press Delete to remove one.';
  layout();
  view.el.setPoints = (p) => {
    points = normalizeEnvelope(p, { min, max });
    layout();
    view.redraw();
  };
  view.el.redraw = view.redraw;
  return view.el;
}

/**
 * Display text for an envelope or curve point value. Data params whose unit is
 * '%' but whose range is a small multiplier (0..4) show v x 100 %.
 */
export function formatPoint(param, v) {
  if (param.unit === '%' && (param.max ?? 100) <= 10) return `${Math.round(v * 100)} %`;
  return formatValue({ ...param, type: 'number', step: param.step || ((param.max ?? 1) - (param.min ?? 0)) / 100 }, v);
}

/** Frequency curve editor for a param of type 'curve' ([{ f, g }], f in Hz on a log axis, g in dB). */
export function curveControl({ param, value, onChange, smooth = () => false }) {
  const fMin = 20;
  const fMax = 20000;
  const toT = (f) => clamp(Math.log(Math.max(fMin, f) / fMin) / Math.log(fMax / fMin), 0, 1);
  const toF = (t) => fMin * Math.pow(fMax / fMin, t);
  const conv = (pts) => (pts || []).map((p) => ({ t: toT(p.f), v: p.g }));
  const fText = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`);
  const ticks = [100, 1000, 10000];
  const el = envelopeControl({
    param: { min: -60, max: 24, unit: 'dB', ...param },
    value: conv(value),
    onChange: (pts) => onChange(pts.map((p) => ({ f: Math.round(toF(p.t) * 10) / 10, g: Math.round(p.v * 10) / 10 }))),
    xLabel: (t) => fText(toF(t)),
    xTicks: ticks.map(toT),
    xTickLabels: ['100', '1k', '10k'],
    smooth,
  });
  const set = el.setPoints;
  el.setPoints = (pts) => set(conv(pts));
  el.classList.add('fx-curve');
  return el;
}

// ------------------------------------------------- drawn transfer curve

/**
 * Editor for a 'transfer' data param ([{ x, y }]: input to output level in
 * dB, Dynamics Processing). The input axis runs left to right, the output
 * axis bottom to top, over the param's [min, max]. Click to add a point,
 * drag to move one, double-click or Delete to remove it; the end points
 * stay at the edges and move only up and down. While audio plays through
 * the effect, a dot shows the current detector level on the curve
 * (readout [level dB, gain change dB]).
 */
export function transferCurveEditor({ id = 'curve', spline = null } = {}) {
  return (ctx) => {
    const p = ctx.def.params.find((q) => q.id === id);
    const min = p.min ?? -100;
    const max = p.max ?? 0;
    const span = max - min || 1;
    const r1 = (v) => Math.round(v * 10) / 10;
    const toEnv = (pts) => (pts || []).map((q) => ({ t: (q.x - min) / span, v: q.y }));
    const ticks = [];
    for (let v = min + 20; v < max; v += 20) ticks.push(v);
    let dot = null;
    let dotTimer = 0;
    let last = JSON.stringify(ctx.values[id]);
    const el = envelopeControl({
      param: { ...p, label: 'Transfer curve', step: 0.1 },
      value: toEnv(ctx.values[id]),
      onChange: (pts) => {
        const next = pts.map((q) => ({ x: r1(min + q.t * span), y: r1(q.v) }));
        last = JSON.stringify(next);
        ctx.set(id, next);
      },
      xLabel: (t) => `${(min + t * span).toFixed(1)} dB`,
      pointText: (pt) => `Input ${(min + pt.t * span).toFixed(1)} dB, output ${pt.v.toFixed(1)} dB`,
      xTicks: ticks.map((v) => (v - min) / span),
      xTickLabels: ticks.map((v) => String(v)),
      yTicks: ticks,
      className: 'fx-transfer-curve',
      // Spline Curves: spline(points as { x, y }, x) gives the output level.
      render: spline
        ? (env, n) => {
            if (!ctx.values[spline.id]) return renderEnvelope(env, n);
            const pts = env.map((q) => ({ x: min + q.t * span, y: q.v }));
            return Float32Array.from({ length: n }, (_, i) => spline.at(pts, min + (i / (n - 1)) * span));
          }
        : null,
      overlay: (g, W, H, { yOf }) => {
        // Unity line: points on it leave the level unchanged.
        g.strokeStyle = cssVar('--grid-strong');
        g.setLineDash([3, 3]);
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(0, yOf(min, H));
        g.lineTo(W, yOf(max, H));
        g.stroke();
        g.setLineDash([]);
        if (!dot) return;
        const x = clamp((dot.x - min) / span, 0, 1) * W;
        const y = clamp(yOf(dot.y, H), 0, H);
        g.fillStyle = cssVar('--hot');
        g.beginPath();
        g.arc(x, y, 4.5, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = cssVar('--bg-editor');
        g.lineWidth = 1.5;
        g.stroke();
      },
    });
    const status = h('div.fx-transfer-status.faint', { 'aria-live': 'off' });
    const showStatus = () => {
      status.textContent = dot ? `Level ${dot.x.toFixed(1)} dB, gain ${dot.g > 0 ? '+' : ''}${dot.g.toFixed(1)} dB` : 'Play audio through the effect to see its level on the curve.';
    };
    showStatus();
    ctx.subscribe((values) => {
      const now = JSON.stringify(values[id]);
      if (now === last) {
        el.redraw(); // our own edit (the points are in place) or another setting, such as Spline Curves
        return;
      }
      last = now;
      el.setPoints(toEnv(values[id]));
    });
    ctx.onReadout?.((v) => {
      if (!(v.length >= 2) || !Number.isFinite(v[0])) return;
      dot = { x: Math.max(min, v[0]), y: v[0] + v[1], g: v[1] };
      el.redraw();
      showStatus();
      clearTimeout(dotTimer);
      dotTimer = setTimeout(() => {
        dot = null;
        el.redraw();
        showStatus();
      }, 600);
    });
    ctx.onClose?.(() => clearTimeout(dotTimer));
    return h('div.fx-transfer-wrap', el, status);
  };
}

/** Rough per-column peak levels of [start, end) of the first channel (sparse reads; cheap on long files). */
function overviewPeaks(doc, start, end, columns) {
  const ch = doc.state.channels[0];
  if (!ch || end <= start) return null;
  const out = new Float32Array(columns);
  const span = (end - start) / columns;
  const win = Math.max(1, Math.min(256, Math.floor(span)));
  const buf = new Float32Array(win);
  for (let i = 0; i < columns; i++) {
    ch.read(Math.floor(start + i * span), buf);
    let m = 0;
    for (let k = 0; k < win; k++) m = Math.max(m, Math.abs(buf[k]));
    out[i] = Math.min(1, m);
  }
  return out;
}

// ------------------------------------------------------------ selection

const CUSTOM = new Map();

/**
 * Registers the dialog editor for an effect id. Definitions stay free of DOM
 * code (they also load in the effect worker), so UI modules register their
 * editors here (fx-views.js). `editor.hides` lists the param ids the editor
 * draws itself, or true when it lays out every param.
 */
export function registerEditor(id, editor) {
  CUSTOM.set(id, editor);
}

const EQ_IDS = /eq|equali[sz]er|filter/i;
const DYN_IDS = /dynamics|compressor|limiter|maximizer|leveler/i;

/** The built-in editor that suits a definition without its own `editor`, or null. */
export function autoEditor(def) {
  if (def.editor) return def.editor;
  if (CUSTOM.has(def.id)) return CUSTOM.get(def.id);
  if (def.display === 'loudness') return loudnessMeterEditor();
  const transfer = def.params.find((p) => p.type === 'transfer');
  if (transfer) return transferCurveEditor({ id: transfer.id });
  if (EQ_IDS.test(def.id) && (def.response || detectBands(def))) return eqEditor();
  if (DYN_IDS.test(def.id) && detectDynamics(def)) return transferEditor();
  return null;
}
