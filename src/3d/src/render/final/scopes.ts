// Image Editor scopes: a histogram of the shown pixels and a line sample (values along a line
// dragged over the image).
import { h, type Child } from '../../ui/h';
import { app, registerOperators, type AreaLike } from '../../app/app';
import { panel, enumRow, button } from '../../ui/widgets';
import { splitRow } from '../../ui/props';

export interface ScopesHost {
  el: HTMLElement;
  displayCanvas(): HTMLCanvasElement | null;
  /** changes whenever the displayed pixels change */
  scopeKey(): string;
  /** editor pixel → image pixel (top-left origin) */
  toImage(sx: number, sy: number): [number, number];
  drawUI(): void;
  host: { area?: AreaLike };
}

type Mode = 'LUMA' | 'RGB' | 'R' | 'G' | 'B';
export const scopeSettings: { histogram: Mode; line: { x0: number; y0: number; x1: number; y1: number } | null } = { histogram: 'RGB', line: null };

let cache: { canvas: HTMLCanvasElement; w: number; h: number; stamp: string; bins: number[][] } | null = null;

/** 256-bin histograms (R, G, B, luma) of a canvas, normalized to the tallest bin. */
export function histogram(px: Uint8ClampedArray): number[][] {
  const bins = [new Array(256).fill(0), new Array(256).fill(0), new Array(256).fill(0), new Array(256).fill(0)];
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    bins[0][px[i]]++;
    bins[1][px[i + 1]]++;
    bins[2][px[i + 2]]++;
    bins[3][Math.round(px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722)]++;
  }
  // ignore the extremes when scaling so a black/white background does not flatten the curve
  for (const b of bins) {
    let max = 1;
    for (let i = 1; i < 255; i++) max = Math.max(max, b[i]);
    for (let i = 0; i < 256; i++) b[i] = Math.min(1, b[i] / max);
  }
  return bins;
}

function sampleCanvas(src: HTMLCanvasElement): Uint8ClampedArray {
  const k = Math.min(1, 256 / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * k)),
    hh = Math.max(1, Math.round(src.height * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hh;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(src, 0, 0, w, hh);
  return g.getImageData(0, 0, w, hh).data;
}

const COLORS = ['#dc433b', '#48c04e', '#475ede', '#d1d2d4'];

function curve(values: number[], w: number, hh: number, color: string, fill: boolean, key: string): Child {
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(hh - v * hh).toFixed(1)}`);
  return h('path', { key, d: `M${fill ? `0,${hh} L` : ''}${pts.join(' L')}${fill ? ` L${w},${hh} Z` : ''}`, fill: fill ? color : 'none', 'fill-opacity': fill ? 0.25 : 0, stroke: color, 'stroke-width': 1 });
}

function histogramView(host: ScopesHost): Child {
  const src = host.displayCanvas();
  if (!src) return h('div', { class: 'sb-empty' }, 'No image');
  const stamp = host.scopeKey();
  if (!cache || cache.canvas !== src || cache.stamp !== stamp || cache.w !== src.width) cache = { canvas: src, w: src.width, h: src.height, stamp, bins: histogram(sampleCanvas(src)) };
  const W = 240,
    H = 110;
  const mode = scopeSettings.histogram;
  const which = mode === 'LUMA' ? [3] : mode === 'RGB' ? [0, 1, 2] : [{ R: 0, G: 1, B: 2 }[mode]];
  return h(
    'div',
    { class: 'scope-box' },
    h('svg', { class: 'scope-svg', width: '100%', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'data-scope': 'histogram' }, h('rect', { x: 0, y: 0, width: W, height: H, fill: '#1a1b1c' }), ...which.map((i) => curve(cache!.bins[i], W, H, COLORS[i], true, `h${i}`))),
    enumRow(
      'scope-hist-mode',
      [
        { value: 'LUMA', label: 'Luma' },
        { value: 'RGB', label: 'RGB' },
        { value: 'R', label: 'R' },
        { value: 'G', label: 'G' },
        { value: 'B', label: 'B' },
      ],
      mode,
      (v) => ((scopeSettings.histogram = v as Mode), host.drawUI()),
    ),
  );
}

/** Pixel values along the sampled line, per channel (0..1). */
export function lineValues(src: HTMLCanvasElement, l: { x0: number; y0: number; x1: number; y1: number }, n = 128): number[][] {
  const g = src.getContext('2d', { willReadFrequently: true })!;
  const out = [[], [], [], []] as number[][];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = Math.max(0, Math.min(src.width - 1, Math.floor(l.x0 + (l.x1 - l.x0) * t)));
    const y = Math.max(0, Math.min(src.height - 1, Math.floor(l.y0 + (l.y1 - l.y0) * t)));
    const p = g.getImageData(x, y, 1, 1).data;
    out[0].push(p[0] / 255);
    out[1].push(p[1] / 255);
    out[2].push(p[2] / 255);
    out[3].push((p[0] * 0.2126 + p[1] * 0.7152 + p[2] * 0.0722) / 255);
  }
  return out;
}

function lineView(host: ScopesHost): Child {
  const src = host.displayCanvas();
  const l = scopeSettings.line;
  const body: Child[] = [];
  if (src && l) {
    const vals = lineValues(src, l);
    const W = 240,
      H = 90;
    body.push(h('svg', { class: 'scope-svg', width: '100%', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'data-scope': 'line' }, h('rect', { x: 0, y: 0, width: W, height: H, fill: '#1a1b1c' }), ...[0, 1, 2, 3].map((i) => curve(vals[i], W, H, COLORS[i], false, `l${i}`))));
    body.push(splitRow('From', h('span', { class: 'ie-value' }, `${Math.round(l.x0)}, ${Math.round(l.y0)}`)), splitRow('To', h('span', { class: 'ie-value' }, `${Math.round(l.x1)}, ${Math.round(l.y1)}`)));
  } else body.push(h('div', { class: 'sb-empty' }, 'Drag a line over the image to sample it.'));
  body.push(h('div', { class: 'btn-col' }, button('scope-line', 'Sample Line', () => app.run('image.sample_line', {}, { area: host.host.area ?? null }))));
  return h('div', { class: 'scope-box' }, body);
}

/** Waveform (luma per column) and vectorscope (chroma) of a canvas, drawn into small images. */
export function waveformAndVectorscope(px: Uint8ClampedArray, w: number, h: number): { waveform: string; vectorscope: string } {
  const W = 256,
    H = 128,
    V = 160;
  const wave = new Float32Array(W * H),
    vec = new Float32Array(V * V);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (px[i + 3] === 0) continue;
      const r = px[i] / 255,
        g = px[i + 1] / 255,
        b = px[i + 2] / 255;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const cx = Math.min(W - 1, Math.floor((x / w) * W)),
        cy = Math.min(H - 1, Math.floor((1 - luma) * (H - 1)));
      wave[cy * W + cx]++;
      // chroma (BT.709 color differences)
      const u = (b - luma) / 1.8556,
        v = (r - luma) / 1.5748;
      const vx = Math.round(V / 2 + u * (V - 4)),
        vy = Math.round(V / 2 - v * (V - 4));
      if (vx >= 0 && vy >= 0 && vx < V && vy < V) vec[vy * V + vx]++;
    }
  const toURL = (data: Float32Array, cw: number, ch: number, tint: [number, number, number]) => {
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const g = c.getContext('2d')!;
    const img = g.createImageData(cw, ch);
    let max = 1;
    for (const d of data) max = Math.max(max, d);
    for (let i = 0; i < data.length; i++) {
      const k = data[i] ? Math.min(1, 0.25 + Math.log1p(data[i]) / Math.log1p(max)) : 0;
      img.data[i * 4] = tint[0] * k;
      img.data[i * 4 + 1] = tint[1] * k;
      img.data[i * 4 + 2] = tint[2] * k;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL();
  };
  return { waveform: toURL(wave, W, H, [220, 230, 220]), vectorscope: toURL(vec, V, V, [200, 220, 255]) };
}

let scopeCache: { canvas: HTMLCanvasElement; stamp: string; urls: { waveform: string; vectorscope: string } } | null = null;

function scopeImages(host: ScopesHost) {
  const src = host.displayCanvas();
  if (!src) return null;
  const stamp = host.scopeKey();
  if (scopeCache?.canvas === src && scopeCache.stamp === stamp) return scopeCache.urls;
  const k = Math.min(1, 256 / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * k)),
    hh = Math.max(1, Math.round(src.height * k));
  const urls = waveformAndVectorscope(sampleCanvas(src), w, hh);
  scopeCache = { canvas: src, stamp, urls };
  return urls;
}

export function scopesPanel(host: ScopesHost): Child[] {
  return [
    panel('ie-histogram', 'Histogram', () => [histogramView(host)]),
    panel('ie-waveform', 'Waveform', () => {
      const s = scopeImages(host);
      return [s ? h('img', { class: 'scope-img', src: s.waveform, alt: 'Waveform', 'data-scope': 'waveform' }) : h('div', { class: 'sb-empty' }, 'No image')];
    }),
    panel('ie-vectorscope', 'Vectorscope', () => {
      const s = scopeImages(host);
      return [s ? h('img', { class: 'scope-img scope-round', src: s.vectorscope, alt: 'Vectorscope', 'data-scope': 'vectorscope' }) : h('div', { class: 'sb-empty' }, 'No image')];
    }),
    panel('ie-line', 'Sample Line', () => [lineView(host)]),
  ];
}

registerOperators([
  {
    idname: 'image.sample_line',
    label: 'Sample Line',
    description: 'Drag a line over the image to plot its values in the Scopes tab',
    poll: (ctx) => ctx.area?.type === 'IMAGE_EDITOR' && !!(ctx.area.editor as ScopesHost).displayCanvas(),
    undo: false,
    invoke: (ctx) => {
      const host = ctx.area!.editor as ScopesHost;
      const r = host.el.getBoundingClientRect();
      let start: [number, number] | null = null;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      Object.assign(line.style, { position: 'absolute', inset: '0', pointerEvents: 'none', width: '100%', height: '100%' });
      line.innerHTML = '<line stroke="#ffffff" stroke-dasharray="4 3" stroke-width="1"/>';
      host.el.append(line);
      const ln = line.firstElementChild as SVGLineElement;
      const finish = () => line.remove();
      app.startModal({
        label: 'Sample Line',
        cursor: 'crosshair',
        header: () => 'Drag a line to sample',
        onPointerDown(e) {
          if (e.button !== 0) return 'CANCELLED';
          start = [e.clientX - r.left, e.clientY - r.top];
          return undefined;
        },
        onPointerMove(e) {
          if (!start) return;
          ln.setAttribute('x1', String(start[0]));
          ln.setAttribute('y1', String(start[1]));
          ln.setAttribute('x2', String(e.clientX - r.left));
          ln.setAttribute('y2', String(e.clientY - r.top));
        },
        onPointerUp(e) {
          if (!start) return undefined;
          const [x0, y0] = host.toImage(start[0], start[1]);
          const [x1, y1] = host.toImage(e.clientX - r.left, e.clientY - r.top);
          scopeSettings.line = { x0, y0, x1, y1 };
          finish();
          host.drawUI();
          return 'CANCELLED';
        },
        onKey(e) {
          return e.type === 'keydown' && e.key === 'Escape' ? 'CANCELLED' : true;
        },
        cancel: finish,
      });
      return 'RUNNING_MODAL';
    },
  },
]);
