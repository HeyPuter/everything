// Small DOM building blocks shared by the adjustment editors: labelled
// sliders with numeric entry, selects, checkboxes and a histogram canvas.
// Every control reports live changes (dragging) and the end of a gesture
// separately, so editors can preview continuously and commit once.
import type { Histograms } from '../../imaging/adjust';
import { escapeXML } from '../../model/assets';
import { svg } from '../../app/icons';

export type Live = (commit: boolean) => void;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (html) el.innerHTML = html;
  return el;
}

let uid = 0;
export const nextId = (p = 'adj') => `${p}-${++uid}`;

const round = (v: number, step: number) => {
  const d = step < 1 ? Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) : 0;
  return Number((Math.round(v / step) * step).toFixed(d));
};

export type SliderOptions = {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  unit?: string;
  // CSS background for the track (gradients for color sliders).
  track?: string;
  // Logarithmic slider travel (for multiplicative values such as gamma).
  log?: boolean;
  onInput: (v: number, commit: boolean) => void;
};
/** Label + number field on one line, range slider below. */
export function slider(o: SliderOptions) {
  const step = o.step ?? 1;
  const id = nextId('s');
  const row = h('div', { class: 'adj-slider' });
  // The range input works in its own units when the travel is logarithmic.
  const lo = Math.log(o.min),
    span = Math.log(o.max) - lo;
  const toPos = (v: number) => (o.log ? String(Math.round(((Math.log(v) - lo) / span) * 1000)) : String(v));
  const fromPos = (p: string) => (o.log ? round(Math.exp(lo + (Number(p) / 1000) * span), step) : Number(p));
  const rangeAttrs = o.log ? 'min="0" max="1000" step="1"' : `min="${o.min}" max="${o.max}" step="${step}"`;
  row.innerHTML = `<div class="adj-slider-head"><label for="${id}">${escapeXML(o.label)}</label><span><input type="number" min="${o.min}" max="${o.max}" step="${step}" value="${o.value}" aria-label="${escapeXML(o.label)} value">${o.unit ? `<small>${escapeXML(o.unit)}</small>` : ''}</span></div><input id="${id}" type="range" ${rangeAttrs} value="${toPos(o.value)}">`;
  const num = row.querySelector<HTMLInputElement>('input[type=number]')!,
    range = row.querySelector<HTMLInputElement>('input[type=range]')!;
  if (o.log) range.setAttribute('aria-valuetext', String(o.value));
  if (o.track) range.style.setProperty('--adj-track', o.track), range.classList.add('adj-track');
  const clamp = (v: number) => Math.min(o.max, Math.max(o.min, v));
  const fromRange = () => {
    const v = fromPos(range.value);
    num.value = String(v);
    if (o.log) range.setAttribute('aria-valuetext', String(v));
    return v;
  };
  range.addEventListener('input', () => o.onInput(fromRange(), false));
  range.addEventListener('change', () => o.onInput(fromRange(), true));
  num.addEventListener('change', () => {
    // A cleared field is not zero: it goes back to the value in use.
    const v = num.value.trim() === '' ? NaN : Number(num.value);
    if (!Number.isFinite(v)) {
      num.value = String(fromPos(range.value));
      return;
    }
    const c = round(clamp(v), step);
    num.value = String(c);
    range.value = toPos(c);
    o.onInput(c, true);
  });
  return {
    el: row,
    set(v: number) {
      num.value = String(v);
      range.value = toPos(v);
    },
  };
}

export function select(label: string, options: [string, string][], value: string, onChange: (v: string) => void) {
  const id = nextId('sel');
  const row = h('div', { class: 'adj-select' });
  row.innerHTML = `<label for="${id}">${escapeXML(label)}</label><select id="${id}">${options.map(([v, l]) => `<option value="${escapeXML(v)}" ${v === value ? 'selected' : ''}>${escapeXML(l)}</option>`).join('')}</select>`;
  const s = row.querySelector('select')!;
  s.addEventListener('change', () => onChange(s.value));
  return { el: row, select: s };
}

export function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void) {
  const row = h('label', { class: 'adj-check' });
  row.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''}><span>${escapeXML(label)}</span>`;
  const input = row.querySelector('input')!;
  input.addEventListener('change', () => onChange(input.checked));
  return { el: row, input };
}

export function button(label: string, onClick: () => void, opts: { icon?: string; title?: string; pressed?: boolean; cls?: string } = {}) {
  const b = h('button', { type: 'button', class: opts.cls ?? 'secondary', title: opts.title ?? label, 'aria-label': opts.title ?? label });
  b.innerHTML = opts.icon ? `${svg(opts.icon, 15)}${opts.cls?.includes('icon-button') ? '' : `<span>${escapeXML(label)}</span>`}` : escapeXML(label);
  if (opts.pressed !== undefined) b.setAttribute('aria-pressed', String(opts.pressed));
  b.addEventListener('click', onClick);
  return b;
}

export type HistogramView = 'rgb' | 'r' | 'g' | 'b' | 'luminosity';
const histColor: Record<HistogramView, string> = { rgb: 'var(--text)', luminosity: 'var(--text)', r: '#e5484d', g: '#46a758', b: '#3e8ef7' };

/** SVG path for a histogram scaled to width x height (log-damped peaks so
 * one huge spike does not flatten the rest). */
export function histogramPath(hist: ArrayLike<number> | undefined, width: number, height: number) {
  if (!hist) return '';
  let max = 0;
  const sorted = Array.from(hist).sort((a, b) => b - a);
  // Clip at the 3rd largest bin so isolated spikes do not dominate.
  max = Math.max(1, sorted[Math.min(3, sorted.length - 1)] * 1.15);
  let d = `M0 ${height}`;
  for (let i = 0; i < 256; i++) {
    const v = Math.min(1, hist[i] / max);
    const x = (i / 255) * width,
      y = height - v * height;
    d += `L${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return d + `L${width} ${height}Z`;
}

export function histogramSvg(hists: Histograms | null | undefined, view: HistogramView, width = 256, height = 100) {
  const data = hists ? (view === 'rgb' ? hists.rgb : hists[view]) : undefined;
  return `<svg class="adj-histogram" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${data ? `<path d="${histogramPath(data, width, height)}" fill="${histColor[view]}" opacity="0.55"/>` : `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="adj-hist-wait">…</text>`}</svg>`;
}

export const hueTrack = 'linear-gradient(90deg,#f00,#ff0 16.7%,#0f0 33.3%,#0ff 50%,#00f 66.7%,#f0f 83.3%,#f00)';
export const grayTrack = 'linear-gradient(90deg,#000,#fff)';
export const twoTone = (a: string, b: string) => `linear-gradient(90deg,${a},${b})`;
