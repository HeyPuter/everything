// Levels editor: channel, histogram with input black/gamma/white handles,
// output range, eyedroppers for black/gray/white points, Auto and presets.
import { autoLevels, defaultParams, levelsFunction, luma, type ChannelKey, type LevelsChannel, type LevelsParams } from '../../imaging/adjust';
import type { AdjustHost } from './host';
import { button, h, histogramSvg, select, type HistogramView } from './ui';
import { droppers } from './droppers';

const CHANNELS: [ChannelKey, string][] = [
  ['rgb', 'RGB'],
  ['r', 'Red'],
  ['g', 'Green'],
  ['b', 'Blue'],
];
const ch = (inBlack: number, gamma: number, inWhite: number, outBlack = 0, outWhite = 255): LevelsChannel => ({ inBlack, inWhite, gamma, outBlack, outWhite });
// Original starting points.
const PRESETS: Record<string, { label: string; rgb: LevelsChannel }> = {
  default: { label: 'Default', rgb: ch(0, 1, 255) },
  darker: { label: 'Darker', rgb: ch(15, 0.75, 255) },
  lighter: { label: 'Lighter', rgb: ch(0, 1.35, 240) },
  contrast1: { label: 'Increase Contrast 1', rgb: ch(12, 1, 243) },
  contrast2: { label: 'Increase Contrast 2', rgb: ch(24, 1, 231) },
  contrast3: { label: 'Increase Contrast 3', rgb: ch(38, 1, 217) },
  shadows: { label: 'Lighten Shadows', rgb: ch(0, 1.5, 255) },
  midBright: { label: 'Midtones Brighter', rgb: ch(0, 1.25, 255) },
  midDark: { label: 'Midtones Darker', rgb: ch(0, 0.8, 255) },
  fade: { label: 'Faded', rgb: ch(0, 1, 255, 28, 232) },
};

/** Handle position of the gamma slider between the black and white points:
 * input p (relative) maps to 50% output, so p = 0.5^gamma. */
export const gammaPosition = (c: LevelsChannel) => c.inBlack + (c.inWhite - c.inBlack) * Math.pow(0.5, c.gamma);
export const gammaFromPosition = (c: LevelsChannel, x: number) => {
  const t = (x - c.inBlack) / Math.max(1, c.inWhite - c.inBlack);
  return Math.round(Math.min(9.99, Math.max(0.01, Math.log(Math.min(0.9999, Math.max(1e-4, t))) / Math.log(0.5))) * 100) / 100;
};

/** Per-channel levels that map a sampled color to black, white or neutral
 * gray (after the composite channel, which applies first). */
export function eyedropLevels(p: LevelsParams, mode: 'black' | 'gray' | 'white', color: [number, number, number]) {
  const rgb = levelsFunction(p.rgb);
  const v = color.map((c) => rgb(c / 255) * 255);
  (['r', 'g', 'b'] as const).forEach((k, i) => {
    const c = p[k];
    if (mode === 'black') c.inBlack = Math.max(0, Math.min(c.inWhite - 2, Math.round(v[i])));
    else if (mode === 'white') c.inWhite = Math.min(255, Math.max(c.inBlack + 2, Math.round(v[i])));
  });
  if (mode === 'gray') {
    const target = luma(v[0], v[1], v[2]);
    (['r', 'g', 'b'] as const).forEach((k, i) => {
      const c = p[k];
      const t = (v[i] - c.inBlack) / Math.max(1, c.inWhite - c.inBlack);
      const o = (target - c.outBlack) / Math.max(1, c.outWhite - c.outBlack);
      if (t > 0.005 && t < 0.995 && o > 0.005 && o < 0.995) c.gamma = Math.round(Math.min(9.99, Math.max(0.1, Math.log(t) / Math.log(o))) * 100) / 100;
    });
  }
}

type Handle = { el: HTMLElement; get: () => number; set: (v: number) => void };
/** A horizontal 0..255 track with draggable triangle handles. */
export function handleTrack(cls: string, handles: { cls: string; label: string; get: () => number; set: (v: number) => void }[], live: (commit: boolean) => void) {
  const track = h('div', { class: `adj-track-bar ${cls}` });
  const list: Handle[] = handles.map((d) => {
    const el = h('button', { type: 'button', class: `adj-handle ${d.cls}`, 'aria-label': d.label, title: d.label, role: 'slider', 'aria-valuemin': '0', 'aria-valuemax': '255' });
    track.append(el);
    return { el, get: d.get, set: d.set };
  });
  const place = () => {
    for (const x of list) {
      const v = x.get();
      x.el.style.left = `${(v / 255) * 100}%`;
      x.el.setAttribute('aria-valuenow', String(Math.round(v * 100) / 100));
    }
  };
  for (const x of list) {
    x.el.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      x.el.focus();
      const rect = track.getBoundingClientRect();
      const move = (m: PointerEvent) => {
        x.set(Math.min(255, Math.max(0, ((m.clientX - rect.left) / rect.width) * 255)));
        place();
        live(false);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        live(true);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    x.el.addEventListener('keydown', (ev) => {
      const d = ev.key === 'ArrowLeft' || ev.key === 'ArrowDown' ? -1 : ev.key === 'ArrowRight' || ev.key === 'ArrowUp' ? 1 : 0;
      if (!d) return;
      ev.preventDefault();
      ev.stopPropagation();
      x.set(Math.min(255, Math.max(0, x.get() + d * (ev.shiftKey ? 10 : 1))));
      place();
      live(true);
    });
  }
  place();
  return { el: track, place };
}

/** Numeric field; `onChange` stores the value and must rewrite the field
 * with the value in use (clamped or kept when the entry is blank). */
function numberBox(label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void, sync: () => void) {
  const i = h('input', { type: 'number', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label, title: label });
  i.addEventListener('change', () => {
    const v = i.value.trim() === '' ? NaN : Number(i.value);
    if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
    else sync();
  });
  return i;
}

export function levelsEditor(body: HTMLElement, host: AdjustHost<'levels'>) {
  const p = host.params;
  const key = (host.ui.channel as ChannelKey) ?? 'rgb';
  const c = p[key];
  const presetKey = Object.entries(PRESETS).find(([, v]) => ['r', 'g', 'b'].every((k) => JSON.stringify(p[k as ChannelKey]) === JSON.stringify(defaultParams('levels').r)) && JSON.stringify(v.rgb) === JSON.stringify(p.rgb))?.[0] ?? 'custom';
  const top = h('div', { class: 'adj-row' });
  top.append(
    select('Preset', [...Object.entries(PRESETS).map(([k, v]) => [k, v.label] as [string, string]), ['custom', 'Custom']], presetKey, (v) => {
      const preset = PRESETS[v];
      if (!preset) return;
      Object.assign(p, defaultParams('levels'), { rgb: { ...preset.rgb } });
      host.change(true);
      host.rerender();
    }).el,
  );
  body.append(top);
  const row = h('div', { class: 'adj-row' });
  row.append(
    select('Channel', CHANNELS, key, (v) => {
      host.ui.channel = v;
      host.rerender();
    }).el,
  );
  const tools = droppers(host as AdjustHost, (mode, color) => eyedropLevels(p, mode, color));
  tools.append(
    button('Auto', async () => {
      const s = await host.source();
      if (!s) return;
      Object.assign(p, autoLevels(s.image, 'tone'));
      host.change(true);
      host.rerender();
    }, { title: 'Automatic per-channel levels' }),
  );
  row.append(tools);
  body.append(row);

  const view: HistogramView = key;
  const hist = h('div', { class: 'adj-hist-box' }, histogramSvg(null, view));
  void host.source().then((s) => {
    if (s) hist.querySelector('svg')!.outerHTML = histogramSvg(s.hist, view);
  });
  body.append(hist);

  let inputs: { b: HTMLInputElement; g: HTMLInputElement; w: HTMLInputElement };
  const sync = () => {
    inputs.b.value = String(Math.round(c.inBlack));
    inputs.g.value = c.gamma.toFixed(2);
    inputs.w.value = String(Math.round(c.inWhite));
  };
  const input = handleTrack(
    'adj-input',
    [
      { cls: 'black', label: 'Input black point', get: () => c.inBlack, set: (v) => (c.inBlack = Math.round(Math.min(v, c.inWhite - 2))) },
      { cls: 'gray', label: 'Input midtones (gamma)', get: () => gammaPosition(c), set: (v) => (c.gamma = gammaFromPosition(c, Math.min(c.inWhite - 1, Math.max(c.inBlack + 1, v)))) },
      { cls: 'white', label: 'Input white point', get: () => c.inWhite, set: (v) => (c.inWhite = Math.round(Math.max(v, c.inBlack + 2))) },
    ],
    (commit) => {
      sync();
      host.change(commit);
    },
  );
  body.append(input.el);
  inputs = {
    b: numberBox('Input black', c.inBlack, 0, 253, 1, (v) => ((c.inBlack = Math.min(Math.round(v), c.inWhite - 2)), input.place(), sync(), host.change(true)), () => sync()),
    g: numberBox('Gamma', c.gamma, 0.01, 9.99, 0.01, (v) => ((c.gamma = Math.round(v * 100) / 100), input.place(), sync(), host.change(true)), () => sync()),
    w: numberBox('Input white', c.inWhite, 2, 255, 1, (v) => ((c.inWhite = Math.max(Math.round(v), c.inBlack + 2)), input.place(), sync(), host.change(true)), () => sync()),
  };
  sync();
  const nums = h('div', { class: 'adj-level-nums' });
  nums.append(inputs.b, inputs.g, inputs.w);
  body.append(nums);

  body.append(h('div', { class: 'adj-field-label' }, 'Output Levels'));
  let outs: { b: HTMLInputElement; w: HTMLInputElement };
  const syncOut = () => {
    outs.b.value = String(Math.round(c.outBlack));
    outs.w.value = String(Math.round(c.outWhite));
  };
  const output = handleTrack(
    'adj-output',
    [
      { cls: 'black', label: 'Output black', get: () => c.outBlack, set: (v) => (c.outBlack = Math.round(v)) },
      { cls: 'white', label: 'Output white', get: () => c.outWhite, set: (v) => (c.outWhite = Math.round(v)) },
    ],
    (commit) => {
      syncOut();
      host.change(commit);
    },
  );
  body.append(output.el);
  outs = {
    b: numberBox('Output black', c.outBlack, 0, 255, 1, (v) => ((c.outBlack = Math.round(v)), output.place(), syncOut(), host.change(true)), () => syncOut()),
    w: numberBox('Output white', c.outWhite, 0, 255, 1, (v) => ((c.outWhite = Math.round(v)), output.place(), syncOut(), host.change(true)), () => syncOut()),
  };
  const onums = h('div', { class: 'adj-level-nums two' });
  onums.append(outs.b, outs.w);
  body.append(onums);
}
