// Noise Reduction (process) dialog: capture, save and load the noise print,
// a graph of the print per channel with the reduction threshold drawn over
// it (drag the threshold up to reduce a region harder, down to spare it),
// and the main controls with the fine-tuning ones under Advanced.

import { h, announce } from '../../lib/dom.js';
import { cssVar } from '../../ui/theme.js';
import { plot, gridLines, labelText, draggable, registerEditor, freqGridLines } from '../editors.js';
import { controlsFor, disclosure, glyph } from '../layout.js';
import { curveGainAt, FLAT_CURVE, serializeNoisePrint, parseNoisePrint } from '../defs/restoration.js';
import { downloadBlob, pickLocalFiles } from '../../storage/files.js';
import { hzLabel, needBanner } from './common.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const G_MIN = -30;
const G_MAX = 30;
/** Where the threshold sits without a print. */
const NO_PRINT_DB = -80;

/** Per-bin print level in dB, and a smoothed version (a sixth of an octave) the threshold follows. */
export function printLevels(print, channel) {
  const c = print.channels[Math.min(channel, print.channels.length - 1)];
  const n = c.length;
  const raw = new Float32Array(n);
  const smooth = new Float32Array(n);
  const sum = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) sum[k + 1] = sum[k] + c[k];
  for (let k = 0; k < n; k++) {
    raw[k] = 10 * Math.log10(c[k] + 1e-20);
    const lo = Math.max(0, Math.floor(k * 2 ** (-1 / 12)) - 1);
    const hi = Math.min(n - 1, Math.ceil(k * 2 ** (1 / 12)) + 1);
    smooth[k] = 10 * Math.log10((sum[hi + 1] - sum[lo]) / (hi - lo + 1) + 1e-20);
  }
  return { raw, smooth };
}

function printGraph(ctx, ui) {
  const doc = ctx.doc;
  const rate = doc?.sampleRate || 48000;
  const nyq = rate / 2;
  let levels = null;
  let levelsKey = '';
  const getLevels = () => {
    const p = doc?.noisePrint;
    if (!p) return null;
    const key = `${p.id}:${ui.channel}`;
    if (key !== levelsKey) {
      levels = printLevels(p, ui.channel);
      levelsKey = key;
    }
    return levels;
  };
  const range = () => {
    const l = getLevels();
    if (!l) return [-120, 0];
    let lo = 0;
    for (const v of l.raw) if (v > -200) lo = Math.min(lo, v);
    return [clamp(Math.floor((lo - 10) / 20) * 20, -160, -60), 0];
  };
  const xOf = (f, W) => (ui.scale === 'log' ? (Math.log(clamp(f, 20, nyq) / 20) / Math.log(nyq / 20)) * W : (clamp(f, 0, nyq) / nyq) * W);
  const fOf = (x, W) => (ui.scale === 'log' ? 20 * Math.pow(nyq / 20, clamp(x / W, 0, 1)) : Math.max(20, clamp(x / W, 0, 1) * nyq));
  const yOf = (d, H, [lo, hi]) => 6 + ((hi - d) / (hi - lo)) * (H - 12);
  const dOf = (y, H, [lo, hi]) => hi - ((y - 6) / (H - 12)) * (hi - lo);
  /** Level the threshold follows at f (the smoothed print, or a fixed line without one). */
  const baseline = (f) => {
    const l = getLevels();
    if (!l) return NO_PRINT_DB;
    const p = doc.noisePrint;
    return l.smooth[clamp(Math.round((f / p.rate) * p.fftSize), 0, l.smooth.length - 1)];
  };

  const view = plot('nr-graph', 'Noise print and reduction threshold', (g, W, H) => {
    const r = range();
    const fTicks = Array.from({ length: Math.floor(nyq / 2000) }, (_, i) => (i + 1) * 2000);
    const dTicks = [];
    for (let d = r[0] + 20; d < r[1]; d += 20) dTicks.push(d);
    if (ui.scale === 'log') freqGridLines(g, W, H, (f) => xOf(f, W), { fMin: 20, fMax: nyq, ys: dTicks.map((d) => yOf(d, H, r)) });
    else gridLines(g, W, H, fTicks.filter((f) => f < nyq).map((f) => xOf(f, W)), dTicks.map((d) => yOf(d, H, r)));
    const l = getLevels();
    if (l) {
      const p = doc.noisePrint;
      g.fillStyle = cssVar('--wave');
      const step = Math.max(1, Math.floor(l.raw.length / (W * 2)));
      for (let k = 1; k < l.raw.length; k += step) {
        const x = xOf((k * p.rate) / p.fftSize, W);
        g.fillRect(x - 0.75, yOf(l.raw[k], H, r) - 0.75, 1.5, 1.5);
      }
    }
    // The threshold: the smoothed print moved by the adjustment curve.
    g.strokeStyle = cssVar('--hot');
    g.lineWidth = 2;
    g.beginPath();
    for (let i = 0; i <= 240; i++) {
      const f = fOf((i / 240) * W, W);
      const y = clamp(yOf(baseline(f) + curveGainAt(ctx.values.curve, f), H, r), 0, H);
      if (i) g.lineTo((i / 240) * W, y);
      else g.moveTo(0, y);
    }
    g.stroke();
    const labels = ui.scale === 'log' ? [] : fTicks.filter((_, i) => i % 2 === 1);
    labels.filter((f) => f < nyq).forEach((f) => labelText(g, f >= 1000 ? `${f / 1000}k` : String(f), xOf(f, W) + 3, H - 14));
    dTicks.forEach((d) => labelText(g, `${d} dB`, 3, yOf(d, H, r) + 2));
    if (!l) labelText(g, 'No noise print yet: select noise only and capture one.', 8, 8);
  });

  // Handles: one per adjustment point, riding on the threshold.
  let handles = [];
  const points = () => [...(ctx.values.curve || FLAT_CURVE)].sort((a, b) => a.f - b.f);
  const setPoints = (pts) => ctx.set('curve', pts.map((p) => ({ f: Math.round(p.f * 10) / 10, g: Math.round(clamp(p.g, G_MIN, G_MAX) * 10) / 10 })));
  const place = () => {
    const pts = points();
    if (handles.length !== pts.length) {
      view.layer.replaceChildren();
      handles = pts.map((_, i) => {
        const btn = h('button.fx-handle.fx-point', { type: 'button', role: 'slider', 'aria-label': `Threshold point ${i + 1}` });
        draggable(btn, view.el, (fx, fy) => {
          const cur = points();
          const W = view.el.clientWidth || 1;
          const H = view.el.clientHeight || 1;
          const ends = i === 0 || i === cur.length - 1;
          const f = ends ? cur[i].f : clamp(fOf(fx * W, W), cur[i - 1].f * 1.01, cur[i + 1].f / 1.01);
          cur[i] = { f, g: dOf(fy * H, H, range()) - baseline(f) };
          setPoints(cur);
        });
        btn.addEventListener('keydown', (e) => {
          const cur = points();
          const big = e.shiftKey ? 5 : 1;
          const ends = i === 0 || i === cur.length - 1;
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') cur[i] = { ...cur[i], g: cur[i].g + (e.key === 'ArrowUp' ? 1 : -1) * big };
          else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !ends) cur[i] = { ...cur[i], f: clamp(cur[i].f * 2 ** ((e.key === 'ArrowRight' ? 1 : -1) * big / 12), cur[i - 1].f * 1.01, cur[i + 1].f / 1.01) };
          else if ((e.key === 'Delete' || e.key === 'Backspace') && !ends) cur.splice(i, 1);
          else return;
          e.preventDefault();
          e.stopPropagation();
          setPoints(cur);
          view.layer.children[Math.min(i, cur.length - 1)]?.focus();
        });
        btn.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          const cur = points();
          if (i === 0 || i === cur.length - 1) return;
          cur.splice(i, 1);
          setPoints(cur);
        });
        view.layer.append(btn);
        return btn;
      });
    }
    const r = range();
    pts.forEach((p, i) => {
      const W = view.el.clientWidth;
      const H = view.el.clientHeight;
      const btn = handles[i];
      const d = baseline(p.f) + p.g;
      btn.style.left = W ? `${xOf(p.f, W)}px` : `${(i / Math.max(1, pts.length - 1)) * 100}%`;
      btn.style.top = H ? `${clamp(yOf(d, H, r), 0, H)}px` : '50%';
      const text = `${hzLabel(p.f)}: threshold ${p.g > 0 ? '+' : ''}${p.g.toFixed(1)} dB`;
      btn.setAttribute('aria-valuenow', String(p.g));
      btn.setAttribute('aria-valuetext', text);
      btn.title = `${text}. Drag or use the arrow keys; double-click or Delete removes a point.`;
    });
  };
  view.el.addEventListener('pointerdown', (e) => {
    if (e.target !== view.el && e.target.tagName !== 'CANVAS' && e.target !== view.layer) return;
    const rect = view.el.getBoundingClientRect();
    const f = fOf(e.clientX - rect.left, rect.width);
    const cur = points();
    if (cur.some((p) => Math.abs(Math.log2(p.f / f)) < 0.05)) return;
    cur.push({ f, g: dOf(e.clientY - rect.top, rect.height, range()) - baseline(f) });
    setPoints(cur.sort((a, b) => a.f - b.f));
  });
  view.el.title = 'Click to add a threshold point; drag points up to reduce that region harder, down to spare it.';
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(place).observe(view.el);
  const refresh = () => {
    place();
    view.redraw();
  };
  ctx.subscribe(refresh);
  ui.refresh = refresh;
  place();
  return view.el;
}

function channelNames(n) {
  if (n === 1) return ['Mono'];
  if (n === 2) return ['Left', 'Right'];
  return Array.from({ length: n }, (_, i) => `Channel ${i + 1}`);
}

function noiseReductionView(ctx) {
  const { app, doc } = ctx;
  const ui = { scale: app?.prefs?.get('nrGraphScale') === 'log' ? 'log' : 'linear', channel: 0, refresh: () => {} };
  const status = h('span.nr-status', { 'aria-live': 'polite' });
  const showStatus = () => {
    const p = doc?.noisePrint;
    status.textContent = p ? `Noise print: ${p.seconds.toFixed(p.seconds < 10 ? 2 : 1)} s, ${p.channels.length} channel${p.channels.length > 1 ? 's' : ''}, FFT ${p.fftSize}` : 'Noise print: none';
    saveBtn.disabled = !p;
  };
  const capture = h('button.btn', {
    type: 'button',
    disabled: !doc,
    title: 'Use the current selection (noise only) as the noise print',
    onclick: async () => {
      capture.disabled = true;
      try {
        await app.commands.run('fx.captureNoisePrint');
      } finally {
        capture.disabled = !doc;
      }
    },
  }, 'Capture Noise Print');
  const saveBtn = h('button.icon-btn', {
    type: 'button',
    'aria-label': 'Save the noise print to a file',
    title: 'Save the noise print to a file',
    onclick: () => {
      const p = doc?.noisePrint;
      if (!p) return;
      downloadBlob(new Blob([JSON.stringify(serializeNoisePrint(p))], { type: 'application/json' }), `${(doc.name || 'noise').replace(/\.[^.]+$/, '')} noise print.json`);
    },
  }, iconSave());
  const loadBtn = h('button.icon-btn', {
    type: 'button',
    'aria-label': 'Load a noise print from a file',
    title: 'Load a noise print from a file',
    disabled: !doc,
    onclick: async () => {
      const [file] = await pickLocalFiles({ accept: '.json,application/json', multiple: false });
      if (!file) return;
      try {
        doc.noisePrint = parseNoisePrint(await file.text());
        doc.emit('change', { kind: 'noisePrint' });
        announce('Noise print loaded');
      } catch (err) {
        app.notify(err.message, { error: true });
      }
    },
  }, iconOpen());
  const onDoc = (e) => {
    if (e?.kind !== 'noisePrint') return;
    showStatus();
    ui.refresh();
  };
  const off = doc?.on?.('change', onDoc);
  if (off) ctx.onClose?.(off);

  const graph = printGraph(ctx, ui);
  const scaleSel = h('select.select', { 'aria-label': 'Frequency scale', onchange: () => {
    ui.scale = scaleSel.value;
    app?.prefs?.set('nrGraphScale', ui.scale);
    ui.refresh();
  } }, h('option', { value: 'linear' }, 'Linear'), h('option', { value: 'log' }, 'Logarithmic'));
  scaleSel.value = ui.scale;
  const chanSel = h('select.select', { 'aria-label': 'Channel shown', onchange: () => {
    ui.channel = Number(chanSel.value);
    ui.refresh();
  } }, channelNames(doc?.channelCount || 2).map((n, i) => h('option', { value: String(i) }, n)));
  const selectAll = h('button.btn', { type: 'button', disabled: !doc, title: 'Select the whole file to process it all', onclick: () => doc.setSelection(0, doc.length) }, 'Select Entire File');
  const reset = h('button.icon-btn', { type: 'button', 'aria-label': 'Reset the threshold curve', title: 'Reset the threshold curve', onclick: () => ctx.set('curve', FLAT_CURVE) }, iconReset());
  showStatus();
  const need = needBanner(ctx, {
    has: () => doc?.noisePrint,
    missing: 'No noise print yet.',
    howTo: 'Select a stretch of noise only in the editor (this window stays open), then capture it.',
    action: 'Capture from Selection',
    change: 'noisePrint',
    run: () => app.commands.run('fx.captureNoisePrint'),
  });
  return h(
    'div.fx-stack',
    h('div.nr-bar', capture, saveBtn, loadBtn, status),
    need,
    graph,
    h('div.nr-legend.faint', h('span.nr-swatch.nr-print'), 'Noise print', h('span.nr-swatch.nr-threshold'), 'Threshold (drag to adjust)'),
    h('div.nr-bar', h('label.fx-label', 'Scale:'), scaleSel, h('label.fx-label', 'Channel:'), chanSel, selectAll, h('div.spacer'), reset),
    controlsFor(ctx, ['reduction', 'reduceBy', 'noiseOnly']),
    disclosure('Advanced', controlsFor(ctx, ['decay', 'smoothing', 'precision', 'transition', 'fftSize']), { prefs: app?.prefs, key: 'noiseReduction' }),
  );
}
noiseReductionView.hides = true;
noiseReductionView.dialogClass = 'fx-wide';

// Small line glyphs for the print tools (save to file, open file, reset).
const iconSave = () => glyph(['M12 3v12', 'M7 10l5 5 5-5', 'M4 19h16']);
const iconOpen = () => glyph(['M3 7h6l2 2h10v10H3z']);
const iconReset = () => glyph(['M4 12a8 8 0 1 0 2.3-5.7', 'M4 4v4h4']);

registerEditor('noiseReduction', noiseReductionView);
