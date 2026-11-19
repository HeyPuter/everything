// Dialog bodies for Generate Tones and Generate Noise: a sweep with start and
// end tabs, a waveform preview, a frequency component bank with vertical
// faders, and a power spectral density view of the noise colour.

import { h } from '../lib/dom.js';
import { cssVar } from '../ui/theme.js';
import { plot, gridLines, labelText, freqGridLines, freqLabels } from './editors.js';
import { controlsFor, groupBox, tabPanels, vSlider, checkbox, numberField, readout, disclosure, enableWhen, showWhen } from './layout.js';
import { wavePreview, noiseSpectrum, dbToGain } from './generate.js';
import { fft } from '../multitrack/align.js';

const COMPONENTS = [1, 2, 3, 4, 5];

const hzText = (f) => (f >= 1000 ? `${Number((f / 1000).toFixed(f >= 10000 ? 1 : 2))} kHz` : `${Number(f.toFixed(f < 100 ? 1 : 0))} Hz`);

/** Partial amplitudes and multipliers from Generate Tones values. */
function partials(v) {
  return {
    components: COMPONENTS.map((k) => (v[`on${k}`] ? dbToGain(v[`amp${k}`]) : 0)),
    multipliers: COMPONENTS.map((k) => v[`mul${k}`]),
    waveform: v.waveform,
    symmetry: v.symmetry / 100,
  };
}

function waveView(ctx) {
  const view = plot('gen-wave', 'Waveform preview', (g, W, H) => {
    gridLines(g, W, H, [W / 2], [H / 2]);
    g.strokeStyle = cssVar('--grid-strong');
    g.beginPath();
    g.moveTo(0, Math.round(H / 2) + 0.5);
    g.lineTo(W, Math.round(H / 2) + 0.5);
    g.stroke();
    const pts = wavePreview(partials(ctx.values), Math.max(64, Math.round(W)), 2);
    g.strokeStyle = cssVar('--wave');
    g.lineWidth = 2;
    g.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x = (i / (pts.length - 1)) * W;
      const y = H / 2 - pts[i] * (H / 2 - 6);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.stroke();
  });
  ctx.subscribe(() => view.redraw());
  return view.el;
}

function componentBank(ctx) {
  const cols = COMPONENTS.map((k) => {
    const fader = enableWhen(ctx, vSlider(ctx, `amp${k}`, { label: '' }), (v) => v[`on${k}`]);
    return h(
      'div.gen-comp',
      { role: 'group', 'aria-label': `Component ${k}` },
      checkbox(ctx, `on${k}`, { label: h('span.sr-only', `Enable component ${k}`) }),
      fader,
      readout(ctx, (v) => hzText(v.base * v[`mul${k}`]), 'gen-comp-freq'),
      h('div.gen-comp-mul', numberField(ctx, `mul${k}`)),
    );
  });
  const labels = h('div.gen-comp-labels', h('span', 'On'), h('span.gen-comp-amp', 'Amplitude'), h('span', 'Frequency'), h('span', 'Multiplier'));
  return h('div.gen-comps', labels, cols);
}

/** Generate Tones: sweep tabs, waveform, components, volume and duration. */
export function tonesBody(ctx) {
  const tabs = tabPanels(
    [
      { label: 'Start', content: controlsFor(ctx, ['base', 'modulateBy', 'modFreq']) },
      { label: 'End', content: controlsFor(ctx, ['endBase', 'endModulateBy', 'endModFreq', 'sweepCurve']) },
    ],
    { label: 'Sweep' },
  );
  const endTab = tabs.querySelectorAll('[role="tab"]')[1];
  ctx.subscribe((v) => {
    endTab.disabled = !v.sweep;
    if (!v.sweep && tabs.selected() === 1) tabs.select(0);
  });
  endTab.disabled = !ctx.values.sweep;
  const left = h(
    'div.gen-col',
    checkbox(ctx, 'sweep'),
    tabs,
    groupBox('Waveform', controlsFor(ctx, ['waveform', 'symmetry']), waveView(ctx)),
  );
  const right = h(
    'div.gen-col.gen-col-narrow',
    groupBox('Volume', vSlider(ctx, 'volume', { label: '' })),
    groupBox('Duration', h('div.gen-duration', numberField(ctx, 'duration'))),
  );
  const advanced = disclosure('Advanced', controlsFor(ctx, ['startPhase', 'phaseOffset']), { prefs: ctx.app?.prefs, key: 'gen.tones' });
  return h(
    'div.gen-body',
    h('div.gen-columns', left, groupBox('Frequency Components', componentBank(ctx)), right),
    advanced,
    ctx.withPlacement ? controlsFor(ctx, ['placement']) : null,
  );
}

// ------------------------------------------------------------------ noise

function spectrumView(ctx) {
  let cache = null;
  const spectrum = () => {
    const v = ctx.values;
    const key = `${v.color}|${v.intensity}|${ctx.rate}`;
    if (cache?.key !== key) cache = { key, ...noiseSpectrum({ color: v.color, intensity: v.intensity / 100, rate: ctx.rate || 48000 }, fft) };
    return cache;
  };
  const range = 80;
  const view = plot('gen-psd', 'Power spectral density of the noise', (g, W, H) => {
    const { freqs, db } = spectrum();
    const fMin = 20;
    const fMax = (ctx.rate || 48000) / 2;
    const xOf = (f) => (Math.log(f / fMin) / Math.log(fMax / fMin)) * W;
    const yOf = (d) => 4 + (-d / range) * (H - 18);
    freqGridLines(g, W, H, xOf, { fMin, fMax, ys: [-20, -40, -60].map(yOf), labels: false });
    g.beginPath();
    g.moveTo(xOf(freqs[0]), H);
    for (let i = 0; i < freqs.length; i++) g.lineTo(xOf(freqs[i]), Math.min(H, yOf(db[i])));
    g.lineTo(xOf(freqs[freqs.length - 1]), H);
    g.closePath();
    g.fillStyle = cssVar('--wave-dim');
    g.fill();
    g.strokeStyle = cssVar('--wave');
    g.lineWidth = 1.5;
    g.beginPath();
    for (let i = 0; i < freqs.length; i++) {
      const y = Math.min(H, yOf(db[i]));
      if (i) g.lineTo(xOf(freqs[i]), y);
      else g.moveTo(xOf(freqs[i]), y);
    }
    g.stroke();
    freqLabels(g, W, H, xOf, { fMin, fMax });
    [-20, -40, -60].forEach((d) => labelText(g, `${d} dB`, 3, yOf(d) + 2));
  });
  ctx.subscribe(() => view.redraw());
  return view.el;
}

/** Generate Noise: colour and stereo style, the spectrum, intensity, DC offset, volume and duration. */
export function noiseBody(ctx) {
  const delay = showWhen(ctx, controlsFor(ctx, ['delay']), (v) => v.style === 'spatial');
  const top = h('div.gen-noise-top', controlsFor(ctx, ['color', 'style']), delay);
  const faders = h(
    'div.gen-faders',
    groupBox('Intensity', enableWhen(ctx, vSlider(ctx, 'intensity', { label: '' }), (v) => v.color !== 'white')),
    groupBox('DC Offset', vSlider(ctx, 'dcOffset', { label: '' })),
    groupBox('Volume', vSlider(ctx, 'volume', { label: '' })),
  );
  return h(
    'div.gen-body',
    top,
    h('div.gen-columns', groupBox('Power Spectral Density', spectrumView(ctx)), faders),
    controlsFor(ctx, ctx.withPlacement ? ['duration', 'placement'] : ['duration']),
  );
}
