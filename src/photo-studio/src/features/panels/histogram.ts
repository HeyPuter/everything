// The Histogram panel: per-channel or overlaid color histograms of the whole
// image or the active layer (restricted to the selection when there is one),
// statistics for the whole range or a dragged level range, a level readout
// under the pointer, clipping warnings and an all-channels view.
import type { Editor } from '../../editor';
import type { Panel } from '../../app/registry';
import type { RGBA8 } from '../../imaging/types';
import { histograms, type Histograms } from '../../imaging/adjust/histogram';
import { readMask } from '../../model/tiles';
import { canvasRect, selectionGrid } from '../../model/selection';
import { compositeRGBA, layerRGBA } from '../pixels';

export type HistChannel = 'rgb' | 'r' | 'g' | 'b' | 'luminosity' | 'colors';
export type HistSource = 'image' | 'layer';
export type HistStats = {
  mean: number;
  stdDev: number;
  median: number;
  count: number;
  total: number;
  percentile: number;
};

/** Statistics of the levels `from..to` (inclusive) of one histogram;
 * `percentile` is the share of all counted pixels at or below `to`. */
export function histogramStats(bins: ArrayLike<number>, from = 0, to = 255): HistStats {
  const lo = Math.max(0, Math.min(from, to)),
    hi = Math.min(255, Math.max(from, to));
  let total = 0,
    count = 0,
    sum = 0,
    sq = 0,
    below = 0;
  for (let i = 0; i < 256; i++) {
    const n = bins[i];
    total += n;
    if (i <= hi) below += n;
    if (i < lo || i > hi) continue;
    count += n;
    sum += n * i;
    sq += n * i * i;
  }
  const mean = count ? sum / count : 0;
  const stdDev = count ? Math.sqrt(Math.max(0, sq / count - mean * mean)) : 0;
  let median = lo,
    acc = 0;
  for (let i = lo; i <= hi; i++) {
    acc += bins[i];
    if (acc * 2 >= count) {
      median = i;
      break;
    }
  }
  return {
    mean,
    stdDev,
    median: count ? median : 0,
    count,
    total,
    percentile: total ? (below / total) * 100 : 0,
  };
}

/** Share (0..1) of counted pixels at the darkest and the brightest level. */
export function clipping(bins: ArrayLike<number>): { shadows: number; highlights: number } {
  let total = 0;
  for (let i = 0; i < 256; i++) total += bins[i];
  return total
    ? { shadows: bins[0] / total, highlights: bins[255] / total }
    : { shadows: 0, highlights: 0 };
}

/** Count used for scaling: a few isolated spikes (flat fills, pure black or
 * white) are clipped so the rest of the distribution stays readable. */
export function displayMax(...sets: ArrayLike<number>[]): number {
  const all: number[] = [];
  for (const s of sets) for (let i = 0; i < 256; i++) all.push(s[i]);
  all.sort((a, b) => b - a);
  const top = all[0] ?? 0;
  const robust = (all[Math.min(4 * sets.length, all.length - 1)] ?? 0) * 1.6;
  return Math.max(1, Math.min(top, robust || top));
}

const W = 256,
  H = 100;
function area(bins: ArrayLike<number>, max: number, h = H) {
  let d = `M0 ${h}`;
  for (let i = 0; i < 256; i++) d += `L${i} ${(h - Math.min(1, bins[i] / max) * h).toFixed(1)}`;
  return d + `L255 ${h}Z`;
}
const CHANNEL_FILL: Record<'r' | 'g' | 'b', string> = { r: '#ff3b3b', g: '#33d65a', b: '#3f78ff' };
const binsFor = (h: Histograms, c: Exclude<HistChannel, 'colors'>) => (c === 'rgb' ? h.rgb : h[c]);

/** SVG markup of one histogram view. */
export function histogramMarkup(h: Histograms, channel: HistChannel, height = H) {
  if (channel === 'colors') {
    const m = displayMax(h.r, h.g, h.b);
    // Additive overlay: overlaps read as cyan, magenta, yellow and white.
    return `<g style="mix-blend-mode:screen">${(['r', 'g', 'b'] as const).map((c) => `<path d="${area(h[c], m, height)}" fill="${CHANNEL_FILL[c]}"/>`).join('')}</g><path d="${area(h.luminosity, displayMax(h.luminosity), height)}" fill="none" stroke="currentColor" stroke-width="0.6" opacity="0.7"/>`;
  }
  const bins = binsFor(h, channel);
  const fill =
    channel === 'r' || channel === 'g' || channel === 'b' ? CHANNEL_FILL[channel] : 'currentColor';
  return `<path d="${area(bins, displayMax(bins), height)}" fill="${fill}" opacity="0.85"/>`;
}

type PanelState = {
  hist?: Histograms;
  doc?: unknown;
  source?: HistSource;
  layerId?: string;
  range?: [number, number];
  hover?: number;
  job: number;
};
const states = new WeakMap<HTMLElement, PanelState>();
let timer = 0;

const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '–');
const channelLabel: Record<HistChannel, string> = {
  rgb: 'RGB',
  r: 'Red',
  g: 'Green',
  b: 'Blue',
  luminosity: 'Luminosity',
  colors: 'Colors',
};

async function measure(e: Editor, source: HistSource): Promise<Histograms> {
  const doc = e.doc;
  const l = e.layer;
  const img: RGBA8 =
    source === 'layer' && l && l.kind !== 'group' && l.kind !== 'adjustment'
      ? await layerRGBA(e, l)
      : await compositeRGBA(e);
  const sel = selectionGrid(doc, e.assets.tiles);
  return histograms(img, sel ? readMask(e.assets.tiles, sel, canvasRect(doc)) : undefined);
}

function render(e: Editor, el: HTMLElement) {
  const st = states.get(el);
  const $ = <T extends Element>(s: string) => el.querySelector<T>(s)!;
  const channel = $<HTMLSelectElement>('.histogram-channel').value as HistChannel;
  const all = el.classList.contains('histogram-all');
  const main = $<SVGSVGElement>('svg.histogram');
  const extra = $<HTMLElement>('.histogram-channels');
  if (!st?.hist) {
    main.innerHTML = '';
    return;
  }
  const h = st.hist;
  main.innerHTML = histogramMarkup(h, channel) + rangeMarkup(st);
  main.setAttribute('aria-label', `${channelLabel[channel]} histogram`);
  extra.hidden = !all;
  if (all)
    extra.innerHTML = (['r', 'g', 'b'] as const)
      .map(
        (c) =>
          `<svg class="histogram histogram-small" viewBox="0 0 ${W} 60" preserveAspectRatio="none" role="img" aria-label="${channelLabel[c]} histogram">${histogramMarkup(h, c, 60)}</svg>`,
      )
      .join('');
  // Statistics follow the shown channel (luminosity for the color overlay).
  // The RGB composite counts each pixel once per channel: report it per pixel.
  const bins =
    channel === 'colors'
      ? h.luminosity
      : channel === 'rgb'
        ? Float64Array.from(h.rgb, (v) => v / 3)
        : binsFor(h, channel);
  const [from, to] = st.range ?? [0, 255];
  const s = histogramStats(bins, from, to);
  const pixels = histogramStats(h.luminosity).count;
  const hover = st.range ? undefined : st.hover;
  let level = '–',
    count = '–',
    pct = '–';
  if (st.range) {
    const a = Math.min(from, to),
      b = Math.max(from, to);
    level = a === b ? String(a) : `${a}…${b}`;
    count = Math.round(s.count).toLocaleString();
    pct = fmt(s.percentile);
  } else if (hover !== undefined) {
    level = String(hover);
    count = Math.round(bins[hover]).toLocaleString();
    pct = fmt(histogramStats(bins, 0, hover).percentile);
  }
  const set = (k: string, v: string) => ($<HTMLElement>(`[data-hs="${k}"]`).textContent = v);
  set('mean', fmt(s.mean));
  set('std', fmt(s.stdDev));
  set('median', s.count ? String(s.median) : '–');
  set('pixels', pixels.toLocaleString());
  set('level', level);
  set('count', count);
  set('percentile', pct);
  const c = clipping(bins);
  const warn = $<HTMLElement>('.histogram-clipping');
  const parts: string[] = [];
  if (c.shadows >= 0.001) parts.push(`Shadows clipped ${fmt(c.shadows * 100, 1)}%`);
  if (c.highlights >= 0.001) parts.push(`Highlights clipped ${fmt(c.highlights * 100, 1)}%`);
  warn.textContent = parts.join(' · ');
  warn.hidden = !parts.length;
  $<HTMLElement>('.histogram-clip-low').classList.toggle('on', c.shadows >= 0.001);
  $<HTMLElement>('.histogram-clip-high').classList.toggle('on', c.highlights >= 0.001);
  const scope = $<HTMLElement>('.histogram-scope');
  scope.textContent = selectionGrid(e.doc, e.assets.tiles) ? 'Selection only' : '';
}

function rangeMarkup(st: PanelState) {
  let out = '';
  if (st.range) {
    const a = Math.min(...st.range),
      b = Math.max(...st.range);
    out += `<rect class="histogram-range" x="${a}" y="0" width="${Math.max(1, b - a + 1)}" height="${H}"/>`;
  } else if (st.hover !== undefined)
    out += `<line class="histogram-cursor" x1="${st.hover + 0.5}" x2="${st.hover + 0.5}" y1="0" y2="${H}"/>`;
  return out;
}

function schedule(e: Editor, el: HTMLElement, force = false) {
  const st = states.get(el)!;
  const source = el.querySelector<HTMLSelectElement>('.histogram-source')!.value as HistSource;
  const layerId = e.layer?.id;
  if (
    !force &&
    st.hist &&
    st.doc === e.doc &&
    st.source === source &&
    (source === 'image' || st.layerId === layerId)
  )
    return render(e, el);
  clearTimeout(timer);
  const job = ++st.job;
  el.classList.add('histogram-stale');
  timer = window.setTimeout(() => {
    if (e.toolBusy || !e.renderer || !e.hasDocument) return;
    const doc = e.doc;
    void measure(e, source).then(
      (hist) => {
        if (job !== st.job) return;
        Object.assign(st, { hist, doc, source, layerId });
        el.classList.remove('histogram-stale');
        render(e, el);
      },
      () => el.classList.remove('histogram-stale'),
    );
  }, 350);
}

export const histogramPanel: Panel = {
  id: 'histogram',
  title: 'Histogram',
  icon: 'chart-column',
  location: 'strip',
  mount: (e, el) => {
    states.set(el, { job: 0 });
    el.innerHTML = `<div class="histogram-bar">
      <label>Channel <select class="histogram-channel" aria-label="Channel">${(Object.keys(channelLabel) as HistChannel[]).map((c) => `<option value="${c}">${channelLabel[c]}</option>`).join('')}</select></label>
      <label>Source <select class="histogram-source" aria-label="Source"><option value="image">Entire Image</option><option value="layer">Selected Layer</option></select></label>
      <button type="button" class="icon-button toggle histogram-all-toggle" aria-pressed="false" title="Show each color channel" aria-label="Show each color channel"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 5h12M2 9h12M2 13h12" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M2 4.5 5 2l3 2 3-1.5 3 2" stroke="currentColor" fill="none"/></svg></button>
      <button type="button" class="icon-button histogram-refresh" title="Measure again" aria-label="Measure again"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg></button>
    </div>
    <div class="histogram-plot"><svg class="histogram" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Histogram"></svg><span class="histogram-clip-low" title="Pure black pixels"></span><span class="histogram-clip-high" title="Pure white pixels"></span></div>
    <div class="histogram-channels" hidden></div>
    <dl class="histogram-stats">
      <dt>Mean</dt><dd data-hs="mean"></dd><dt>Level</dt><dd data-hs="level"></dd>
      <dt>Std Dev</dt><dd data-hs="std"></dd><dt>Count</dt><dd data-hs="count"></dd>
      <dt>Median</dt><dd data-hs="median"></dd><dt>Percentile</dt><dd data-hs="percentile"></dd>
      <dt>Pixels</dt><dd data-hs="pixels"></dd><dt class="histogram-scope-label"></dt><dd class="histogram-scope muted"></dd>
    </dl>
    <p class="histogram-clipping" hidden></p>`;
    const st = states.get(el)!;
    el.querySelector('.histogram-channel')!.addEventListener('change', () => render(e, el));
    el.querySelector('.histogram-source')!.addEventListener('change', () => schedule(e, el));
    el.querySelector('.histogram-refresh')!.addEventListener('click', () => schedule(e, el, true));
    const allBtn = el.querySelector<HTMLButtonElement>('.histogram-all-toggle')!;
    allBtn.addEventListener('click', () => {
      const on = !el.classList.contains('histogram-all');
      el.classList.toggle('histogram-all', on);
      allBtn.setAttribute('aria-pressed', String(on));
      render(e, el);
    });
    // Pointer: hover reads one level, dragging measures a range, a click clears it.
    const svgEl = el.querySelector<SVGSVGElement>('svg.histogram')!;
    const levelAt = (ev: PointerEvent) => {
      const r = svgEl.getBoundingClientRect();
      return Math.max(
        0,
        Math.min(255, Math.floor(((ev.clientX - r.left) / Math.max(1, r.width)) * 256)),
      );
    };
    let dragFrom: number | undefined;
    svgEl.addEventListener('pointerdown', (ev) => {
      dragFrom = levelAt(ev);
      st.range = undefined;
      svgEl.setPointerCapture?.(ev.pointerId);
    });
    svgEl.addEventListener('pointermove', (ev) => {
      const v = levelAt(ev);
      if (dragFrom !== undefined && v !== dragFrom) st.range = [dragFrom, v];
      else if (dragFrom === undefined) st.hover = v;
      render(e, el);
    });
    svgEl.addEventListener('pointerup', () => {
      dragFrom = undefined;
      render(e, el);
    });
    svgEl.addEventListener('pointerleave', () => {
      if (dragFrom !== undefined) return;
      st.hover = undefined;
      render(e, el);
    });
  },
  update: (e, el) => {
    if (!e.hasDocument || !states.has(el)) return;
    schedule(e, el);
  },
};
