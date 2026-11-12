// Phase Analysis panel: a goniometer (mid on the vertical axis, side on the
// horizontal, so mono is a vertical line and out-of-phase audio spreads
// sideways) drawn as dots, connected lines or a density map that builds up
// over time, or an X/Y Lissajous plot, during playback. The sample count sets
// how much audio each frame shows; Normalize scales quiet material up to fill
// the scope.
//
// Phase Meter panel: a segmented correlation bar from -1 (out of phase)
// through 0 (unrelated) to +1 (mono), red through yellow to green, with a
// hold tick at the lowest recent value. Horizontal when the panel is wide,
// vertical when it is tall and narrow.

import { h } from '../lib/dom.js';
import { select } from '../ui/controls.js';
import { cssVar, CANVAS_FONT } from '../ui/theme.js';
import { fitCanvas, masterTap } from './common.js';

/** Pearson correlation of two blocks (0 for silence). */
export function correlation(L, R) {
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = 0; i < L.length; i++) {
    lr += L[i] * R[i];
    ll += L[i] * L[i];
    rr += R[i] * R[i];
  }
  const den = Math.sqrt(ll * rr);
  return den > 1e-12 ? lr / den : 0;
}

export function phaseAnalysisPanel(app) {
  const modeSel = select({
    label: 'Display',
    value: app.prefs.get('phaseMode') || 'gonio',
    options: [
      { value: 'gonio', label: 'Goniometer' },
      { value: 'lines', label: 'Goniometer (Lines)' },
      { value: 'density', label: 'Density' },
      { value: 'xy', label: 'Lissajous (X/Y)' },
    ],
    onChange: (v) => app.prefs.set('phaseMode', v),
  });
  const samplesSel = select({
    label: 'Samples per frame',
    value: String(app.prefs.get('phaseSamples') || 2048),
    options: [256, 512, 1024, 2048, 4096].map((n) => ({ value: String(n), label: `${n} samples` })),
    onChange: (v) => app.prefs.set('phaseSamples', Number(v)),
  });
  const normBox = h('input', { type: 'checkbox', checked: Boolean(app.prefs.get('phaseNormalize')), onchange: (e) => app.prefs.set('phaseNormalize', e.target.checked) });
  const toolbar = h('div.panel-toolbar.analysis-toolbar', modeSel, samplesSel, h('label.check', { title: 'Scale quiet audio up to fill the scope' }, normBox, 'Normalize'));
  // Density mode accumulates points into a grid that fades a little every frame.
  const GRID = 160;
  const density = new Float32Array(GRID * GRID);
  const scope = h('canvas', { 'aria-hidden': 'true' });
  const scopeWrap = h('div.phase-scope', scope);
  // Correlation as a number in the toolbar; the Phase Meter panel shows it as a bar.
  const value = h('div.phase-value', { title: 'Phase correlation (+1 mono, 0 unrelated, -1 out of phase)' }, '');
  toolbar.append(h('div.spacer'), value);
  const el = h('div.analysis-panel.phase-panel', toolbar, scopeWrap);

  let visible = false;
  let raf = 0;
  let block = null;
  let corr = 0;
  let clearTrail = true;
  let seen = false;

  const tap = masterTap(app, (m) => {
    if (!visible) return;
    block = m;
    seen = true;
    const c = correlation(m.L.subarray(m.L.length - 4096), m.R.subarray(m.R.length - 4096));
    corr = corr * 0.7 + c * 0.3;
    schedule();
  });

  const schedule = () => {
    if (!raf && visible) raf = requestAnimationFrame(draw);
  };

  const draw = () => {
    raf = 0;
    drawScope();
    value.textContent = block || seen ? `${corr >= 0 ? '+' : ''}${corr.toFixed(2)}` : '';
    if (!app.engine.playing && block) {
      // Let the trail fade out after playback stops.
      block = null;
      corr *= 0.5;
      schedule();
    }
  };

  const drawScope = () => {
    const W = scopeWrap.clientWidth;
    const H = scopeWrap.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    if (scope.width !== Math.round(W * dpr) || scope.height !== Math.round(H * dpr)) {
      scope.width = Math.round(W * dpr);
      scope.height = Math.round(H * dpr);
      scope.style.width = `${W}px`;
      scope.style.height = `${H}px`;
      clearTrail = true;
    }
    const ctx = scope.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = cssVar('--bg-editor');
    // Persistence: fade the previous frame rather than clearing it.
    ctx.globalAlpha = clearTrail ? 1 : 0.35;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    clearTrail = false;
    const size = Math.min(W, H) - 16;
    const cx = W / 2;
    const cy = H / 2;
    const r = size / 2;
    const mode = app.prefs.get('phaseMode') || 'gonio';
    const xy = mode === 'xy';
    // Axes.
    ctx.strokeStyle = cssVar('--grid-strong');
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (xy) {
      ctx.rect(cx - r, cy - r, size, size);
      ctx.moveTo(cx - r, cy);
      ctx.lineTo(cx + r, cy);
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx, cy + r);
    } else {
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx, cy + r);
      ctx.moveTo(cx - r, cy);
      ctx.lineTo(cx + r, cy);
    }
    ctx.stroke();
    ctx.font = CANVAS_FONT;
    ctx.fillStyle = cssVar('--text-faint');
    ctx.textAlign = 'center';
    if (xy) {
      ctx.fillText('L', cx + r - 6, cy - 4);
      ctx.fillText('R', cx + 6, cy - r + 10);
    } else {
      ctx.fillText('M', cx + 8, cy - r + 10);
      ctx.fillText('L', cx - r / 2 - 6, cy - r / 2 - 2);
      ctx.fillText('R', cx + r / 2 + 6, cy - r / 2 - 2);
      ctx.fillText('S', cx + r - 6, cy - 4);
    }
    if (!block) {
      if (!app.engine.playing && !seen) {
        ctx.fillStyle = cssVar('--text-dim');
        ctx.fillText('Play audio to see the stereo image', cx, cy + r * 0.55);
      }
      return;
    }
    const { L, R } = block;
    const color = cssVar('--wave');
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    const n = Math.min(L.length, app.prefs.get('phaseSamples') || 2048);
    const off = L.length - n;
    // Normalize: scale so the loudest sample of this frame reaches the edge.
    let gain = 1;
    if (app.prefs.get('phaseNormalize')) {
      let peak = 0;
      for (let i = off; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
      if (peak > 1e-4) gain = Math.min(30, 1 / peak);
    }
    const k = r * 0.95;
    const point = (i, out) => {
      const l = L[off + i] * gain;
      const rr = R[off + i] * gain;
      // X/Y plots left against right; the goniometer rotates 45 degrees (side right, mid up).
      const x = xy ? l : (rr - l) * Math.SQRT1_2;
      const y = xy ? rr : (l + rr) * Math.SQRT1_2;
      out[0] = Math.max(-1, Math.min(1, x));
      out[1] = Math.max(-1, Math.min(1, y));
      return out;
    };
    const p = [0, 0];
    if (mode === 'density') {
      for (let i = 0; i < density.length; i++) density[i] *= 0.9;
      for (let i = 0; i < n; i++) {
        point(i, p);
        const gx = Math.min(GRID - 1, Math.floor(((p[0] + 1) / 2) * GRID));
        const gy = Math.min(GRID - 1, Math.floor(((1 - p[1]) / 2) * GRID));
        density[gy * GRID + gx] += 1;
      }
      drawDensity(ctx, cx - k, cy - k, 2 * k, color);
    } else if (mode === 'lines') {
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        point(i, p);
        const px = cx + p[0] * k;
        const py = cy - p[1] * k;
        if (i) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else {
      for (let i = 0; i < n; i++) {
        point(i, p);
        ctx.fillRect(cx + p[0] * k, cy - p[1] * k, 1.2, 1.2);
      }
    }
  };

  /** Density map: log-scaled counts as the opacity of the waveform color. */
  const drawDensity = (ctx, x0, y0, size, color) => {
    let max = 0;
    for (let i = 0; i < density.length; i++) if (density[i] > max) max = density[i];
    if (max <= 0) return;
    const img = new ImageData(GRID, GRID);
    const [r, g, b] = color.startsWith('#') ? [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)) : [63, 224, 165];
    const lmax = Math.log1p(max);
    for (let i = 0; i < density.length; i++) {
      const a = density[i] > 0 ? Math.log1p(density[i]) / lmax : 0;
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = Math.round(a * 255);
    }
    const tmp = (drawDensity.canvas ||= document.createElement('canvas'));
    tmp.width = GRID;
    tmp.height = GRID;
    tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, x0, y0, size, size);
  };

  const ro = new ResizeObserver(() => {
    clearTrail = true;
    schedule();
  });
  ro.observe(scopeWrap);
  app.on('transport', () => schedule());
  // Keep the toolbar in step with the preferences (another window or a script may change them).
  app.prefs.on('change', (key) => {
    if (key === 'phaseMode') {
      modeSel.value = app.prefs.get('phaseMode') || 'gonio';
      density.fill(0);
      clearTrail = true;
    } else if (key === 'phaseSamples') samplesSel.value = String(app.prefs.get('phaseSamples') || 2048);
    else if (key === 'phaseNormalize') normBox.checked = Boolean(app.prefs.get('phaseNormalize'));
    else return;
    schedule();
  });
  window.addEventListener('themechange', () => {
    clearTrail = true;
    schedule();
  });

  return {
    el,
    show() {
      visible = true;
      clearTrail = true;
      tap.start();
      schedule();
    },
    hide() {
      visible = false;
      tap.stop();
    },
  };
}

/** Spoken description of a correlation value. */
export function correlationText(v) {
  return `${v.toFixed(2)}, ${v > 0.5 ? 'mostly mono' : v > 0 ? 'wide stereo' : v > -0.3 ? 'very wide, check mono compatibility' : 'out of phase'}`;
}

/** Label spacing for a correlation scale `len` px long: the finest step whose labels stay `minGap` px apart. */
export function correlationLabelStep(len, minGap = 34) {
  for (const step of [0.05, 0.1, 0.25, 0.5, 1]) if ((step / 2) * len >= minGap) return step;
  return 1;
}

/** "Auto" orientation: vertical only when the panel is clearly taller than wide. */
export const meterIsVertical = (W, H) => H > W * 1.4;

export function phaseMeterPanel(app) {
  const canvas = h('canvas', { 'aria-hidden': 'true' });
  const bar = h('div.phase-meter', { role: 'meter', 'aria-label': 'Phase correlation', 'aria-valuemin': '-1', 'aria-valuemax': '1', 'aria-valuenow': '0' }, canvas);
  const value = h('div.phase-value', { 'aria-hidden': 'true' }, '0.00');
  const el = h('div.analysis-panel.phase-meter-panel', h('div.phase-meter-row', bar, value));

  let visible = false;
  let raf = 0;
  let corr = 0;
  let low = null; // lowest recent value: { v, at }
  let active = false;
  let lastSpoken = 0;

  const tap = masterTap(app, (m) => {
    if (!visible) return;
    const c = correlation(m.L.subarray(m.L.length - 4096), m.R.subarray(m.R.length - 4096));
    corr = active ? corr * 0.7 + c * 0.3 : c;
    active = true;
    const now = performance.now();
    if (!low || corr <= low.v || now - low.at > 2500) low = { v: corr, at: now };
    schedule();
  });
  const schedule = () => {
    if (!raf && visible) raf = requestAnimationFrame(draw);
  };

  const draw = () => {
    raf = 0;
    const vertical = meterIsVertical(el.clientWidth, el.clientHeight);
    el.classList.toggle('vertical', vertical);
    const fit = fitCanvas(canvas, bar);
    if (!fit) return;
    const { ctx, W, H } = fit;
    const pad = vertical ? 8 : 14;
    const labelRoom = vertical ? 36 : 16;
    const len = (vertical ? H : W) - pad * 2;
    const thick = Math.max(6, Math.min(vertical ? 40 : 96, (vertical ? W : H) - labelRoom - 4));
    // Bar origin and the position of a value along it (+1 at the right or top).
    const pos = (v) => pad + ((vertical ? 1 - v : v + 1) / 2) * len;
    const rect = (a, b) => {
      const p0 = Math.min(pos(a), pos(b));
      const p1 = Math.max(pos(a), pos(b));
      if (vertical) ctx.fillRect(2, p0, thick, p1 - p0);
      else ctx.fillRect(p0, 2, p1 - p0, thick);
    };
    const grad = vertical ? ctx.createLinearGradient(0, pos(-1), 0, pos(1)) : ctx.createLinearGradient(pos(-1), 0, pos(1), 0);
    grad.addColorStop(0, cssVar('--meter-red'));
    grad.addColorStop(0.5, cssVar('--meter-yellow'));
    grad.addColorStop(1, cssVar('--meter-green'));
    ctx.fillStyle = cssVar('--meter-bg');
    rect(-1, 1);
    // Unlit: the whole scale dimmed. Lit: from 0 to the current value.
    ctx.fillStyle = grad;
    ctx.globalAlpha = active ? 0.28 : 0.45;
    rect(-1, 1);
    ctx.globalAlpha = 1;
    if (active) rect(0, corr);
    // Segment gaps every 0.05.
    ctx.fillStyle = cssVar('--meter-bg');
    for (let i = -19; i <= 19; i++) {
      const p = Math.round(pos(i / 20));
      if (vertical) ctx.fillRect(2, p, thick, 1);
      else ctx.fillRect(p, 2, 1, thick);
    }
    // Centre line, needle and the low hold tick.
    ctx.fillStyle = cssVar('--text-dim');
    rect(-0.004, 0.004);
    if (active) {
      ctx.fillStyle = cssVar('--text-strong');
      rect(corr - 0.008, corr + 0.008);
      if (low) {
        ctx.fillStyle = cssVar('--hot');
        rect(low.v - 0.006, low.v + 0.006);
      }
    }
    // Scale.
    const step = correlationLabelStep(len, vertical ? 18 : 34);
    ctx.font = CANVAS_FONT;
    ctx.fillStyle = cssVar('--text-dim');
    ctx.textAlign = vertical ? 'left' : 'center';
    ctx.textBaseline = vertical ? 'middle' : 'top';
    const digits = step < 0.1 ? 2 : step < 1 ? (step === 0.25 ? 2 : 1) : 0;
    for (let k = -Math.round(1 / step); k <= Math.round(1 / step); k++) {
      const v = k * step;
      const p = pos(v);
      const text = Math.abs(v) < 1e-9 ? (0).toFixed(digits) : v.toFixed(digits);
      if (vertical) {
        ctx.fillRect(thick + 3, Math.round(p), 3, 1);
        ctx.fillText(text, thick + 8, p);
      } else {
        ctx.fillRect(Math.round(p), thick + 3, 1, 3);
        ctx.fillText(text, p, thick + 5);
      }
    }
    value.textContent = `${corr >= 0 ? '+' : ''}${corr.toFixed(2)}`;
    const now = performance.now();
    // Spoken at most once a second while active; at rest it must not keep a stale reading.
    if (now - lastSpoken > 1000 || !active) {
      bar.setAttribute('aria-valuenow', corr.toFixed(2));
      bar.setAttribute('aria-valuetext', active ? correlationText(corr) : 'No signal');
      lastSpoken = now;
    }
    if (!app.engine.playing && active) {
      // Settle back to rest once playback stops.
      corr *= 0.5;
      if (Math.abs(corr) < 0.01) {
        active = false;
        corr = 0;
        low = null;
      }
      schedule();
    }
  };

  const ro = new ResizeObserver(() => schedule());
  ro.observe(el);
  app.on('transport', () => schedule());
  window.addEventListener('themechange', () => schedule());

  return {
    el,
    show() {
      visible = true;
      tap.start();
      schedule();
    },
    hide() {
      visible = false;
      tap.stop();
    },
    resetHold() {
      low = null;
      schedule();
    },
  };
}
