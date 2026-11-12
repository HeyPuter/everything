// Graph editors shared by several effect views: a frequency response plot
// with draggable band handles over any dB span (DeHummer notches, Mastering
// and reverb coloration EQs).

import { h } from '../../lib/dom.js';
import { cssVar } from '../../ui/theme.js';
import { plot, gridLines, labelText, draggable } from '../editors.js';
import { logFrequencies } from '../biquad.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const hzLabel = (f) => (f >= 1000 ? `${Number((f / 1000).toFixed(f >= 10000 ? 1 : 2))} kHz` : `${Math.round(f)} Hz`);

/** Frequency ticks for a log axis up to fMax: [value, label] (labels only on decades). */
export function freqTicks(fMax) {
  return [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].filter((f) => f < fMax).map((f) => [f, [100, 1000, 10000].includes(f) ? (f >= 1000 ? `${f / 1000}k` : String(f)) : '']);
}

/**
 * Response plot with band handles.
 *  response(values, freqs, rate) -> dB per frequency (default: the definition's response)
 *  handles(values) -> [{ freq, gain, enabled, ids: { freq, gain, q }, label }]
 *  span: [lo, hi] dB shown; step: grid step in dB
 * Drag a handle to move its frequency (and gain when it has a gain id);
 * arrows nudge, Alt+Up/Down or the wheel change Q.
 */
export function responseEditor({ label = 'Frequency response', span = [-24, 24], step = 6, response, handles = () => [], className = '' }) {
  return (ctx) => {
    const rate = ctx.doc?.sampleRate || 48000;
    const fMin = 20;
    const fMax = Math.min(20000, rate / 2);
    const freqs = logFrequencies(320, fMin, fMax);
    const [lo, hi] = span;
    const xOf = (f, W) => (Math.log(f / fMin) / Math.log(fMax / fMin)) * W;
    const yOf = (d, H) => 6 + ((hi - d) / (hi - lo)) * (H - 12);
    const view = plot(`fx-response${className ? `.${className}` : ''}`, label, (g, W, H) => {
      const ticks = freqTicks(fMax);
      const ys = [];
      for (let d = Math.ceil(lo / step) * step; d <= hi; d += step) ys.push(d);
      gridLines(g, W, H, ticks.map(([f]) => xOf(f, W)), ys.map((d) => yOf(d, H)));
      if (lo < 0 && hi >= 0) {
        g.strokeStyle = cssVar('--grid-strong');
        g.beginPath();
        g.moveTo(0, Math.round(yOf(0, H)) + 0.5);
        g.lineTo(W, Math.round(yOf(0, H)) + 0.5);
        g.stroke();
      }
      const resp = (response || ctx.def.response)(ctx.values, freqs, rate);
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
      ticks.forEach(([f, text]) => text && labelText(g, text, xOf(f, W) + 3, H - 14));
      ys.filter((d, i) => i % 2 === 0 || ys.length < 8).forEach((d) => labelText(g, `${d > 0 ? '+' : ''}${d}`, 3, yOf(d, H) + 2));
    });

    let buttons = [];
    const place = () => {
      const list = handles(ctx.values);
      if (buttons.length !== list.length) {
        view.layer.replaceChildren();
        buttons = list.map((b, i) => {
          const btn = h('button.fx-handle', { type: 'button', role: 'slider', 'aria-label': b.label || `Band ${i + 1}` });
          draggable(btn, view.el, (fx, fy) => {
            const cur = handles(ctx.values)[i];
            if (cur.ids.freq) ctx.set(cur.ids.freq, fMin * Math.pow(fMax / fMin, fx));
            if (cur.ids.gain) {
              const H = view.el.clientHeight || 1;
              ctx.set(cur.ids.gain, hi - ((fy * H - 6) / (H - 12)) * (hi - lo));
            }
          });
          btn.addEventListener('keydown', (e) => {
            const cur = handles(ctx.values)[i];
            const big = e.shiftKey ? 4 : 1;
            if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && cur.ids.freq) ctx.set(cur.ids.freq, cur.freq * Math.pow(2, ((e.key === 'ArrowRight' ? 1 : -1) * big) / 12));
            else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey && cur.ids.q) ctx.set(cur.ids.q, cur.q * Math.pow(1.15, e.key === 'ArrowUp' ? big : -big));
            else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && cur.ids.gain) ctx.set(cur.ids.gain, cur.gain + (e.key === 'ArrowUp' ? 0.5 : -0.5) * big);
            else return;
            e.preventDefault();
            e.stopPropagation();
          });
          btn.addEventListener('wheel', (e) => {
            const cur = handles(ctx.values)[i];
            if (!cur.ids.q) return;
            e.preventDefault();
            ctx.set(cur.ids.q, cur.q * Math.pow(1.1, e.deltaY < 0 ? 1 : -1));
          }, { passive: false });
          view.layer.append(btn);
          return btn;
        });
      }
      list.forEach((b, i) => {
        const btn = buttons[i];
        const fr = (hi - clamp(b.gain, lo, hi)) / (hi - lo);
        btn.style.left = `${(Math.log(clamp(b.freq, fMin, fMax) / fMin) / Math.log(fMax / fMin)) * 100}%`;
        btn.style.top = `calc(${(fr * 100).toFixed(3)}% + ${(6 - 12 * fr).toFixed(2)}px)`;
        btn.classList.toggle('off', b.enabled === false);
        const text = `${hzLabel(b.freq)}, ${b.gain.toFixed(1)} dB${b.q != null ? `, Q ${b.q.toFixed(2)}` : ''}`;
        btn.setAttribute('aria-valuenow', String(Math.round(b.freq)));
        btn.setAttribute('aria-valuetext', text);
        btn.title = `${b.label || `Band ${i + 1}`}: ${text}`;
      });
    };
    ctx.subscribe(() => {
      place();
      view.redraw();
    });
    place();
    return view.el;
  };
}

/**
 * The live spectrum of the file at the playhead (the effect's input) while
 * audio plays: `levels` (dB per bin of a `size`-point FFT, falling like a
 * meter) refreshed every animation frame, then onFrame(). Idle, the levels
 * rest at -120 dB and live() is false.
 */
export function liveSpectrum(ctx, { size = 4096, onFrame = () => {} } = {}) {
  const { app, doc } = ctx;
  const rate = doc?.sampleRate || 48000;
  const bins = size / 2;
  const levels = new Float32Array(bins + 1).fill(-120);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const buf = new Float32Array(size);
  const win = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  const norm = 4 / size;
  let live = false;
  let raf = 0;
  let fftFn = null;
  import('../../multitrack/align.js').then((m) => {
    fftFn = m.fft;
    if (live && !raf) raf = requestAnimationFrame(frame);
  });
  const frame = () => {
    raf = 0;
    if (!live || !doc || !fftFn) return;
    const at = Math.floor(app.engine.position);
    const chans = doc.state.channels.slice(0, 2);
    re.fill(0);
    for (const c of chans) {
      c.read(Math.max(0, at - size), buf);
      for (let i = 0; i < size; i++) re[i] += (buf[i] * win[i]) / chans.length;
    }
    im.fill(0);
    fftFn(re, im);
    for (let k = 0; k <= bins; k++) {
      const d = 10 * Math.log10((re[k] * re[k] + im[k] * im[k]) * norm * norm + 1e-14);
      // Fast rise, slow fall, like a meter.
      levels[k] = d > levels[k] ? d : levels[k] - 1.5;
    }
    onFrame();
    raf = requestAnimationFrame(frame);
  };
  const off = app?.on?.('transport', (s) => {
    live = s === 'playing';
    if (live && !raf) raf = requestAnimationFrame(frame);
    if (!live) {
      levels.fill(-120);
      onFrame();
    }
  });
  // A dialog opened during playback (a rack slot edited while listening) is live at once.
  if (app?.engine?.playing) {
    live = true;
    raf = requestAnimationFrame(frame);
  }
  ctx.onClose?.(() => {
    off?.();
    cancelAnimationFrame(raf);
  });
  return { levels, rate, size, live: () => live };
}

/** Strokes spectrum `levels` (liveSpectrum) with xOf(f) and yOf(dB) mapping. */
export function drawSpectrum(g, spec, xOf, yOf, { H, fill = null } = {}) {
  const { levels, rate, size } = spec;
  g.beginPath();
  let started = false;
  let lastX = 0;
  for (let k = 1; k < levels.length; k++) {
    const f = (k * rate) / size;
    if (f < 20) continue;
    const x = xOf(f);
    const y = clamp(yOf(levels[k]), 0, H);
    if (started) g.lineTo(x, y);
    else {
      if (fill) g.moveTo(x, H);
      g.lineTo(x, y);
    }
    started = true;
    lastX = x;
  }
  if (fill) {
    g.lineTo(lastX, H);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  } else g.stroke();
}

/**
 * Live spectrum of the file at the playhead while audio plays (input to the
 * effect), on a log frequency axis. Idle, it shows a hint instead.
 */
export function spectrumMonitor(ctx, { label = 'Spectrum at the playhead', size = 4096 } = {}) {
  const fMax = (ctx.doc?.sampleRate || 48000) / 2;
  const xOf = (f, W) => (Math.log(f / 20) / Math.log(fMax / 20)) * W;
  const yOf = (d, H) => 4 + (-d / 100) * (H - 18);
  const spec = liveSpectrum(ctx, { size, onFrame: () => view.redraw() });
  const view = plot('fx-spectrum', label, (g, W, H) => {
    const ticks = freqTicks(fMax);
    gridLines(g, W, H, ticks.map(([f]) => xOf(f, W)), [-20, -40, -60, -80].map((d) => yOf(d, H)));
    ticks.forEach(([f, text]) => text && labelText(g, text, xOf(f, W) + 3, H - 14));
    [-20, -40, -60, -80].forEach((d) => labelText(g, `${d}`, 3, yOf(d, H) + 2));
    if (!spec.live()) {
      labelText(g, 'Press Preview to see the spectrum of the audio', 8, 8);
      return;
    }
    g.strokeStyle = cssVar('--wave');
    g.lineWidth = 1.5;
    drawSpectrum(g, spec, (f) => xOf(f, W), (d) => yOf(d, H), { H });
  });
  return view.el;
}
