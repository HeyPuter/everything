// Develop workspace controls: slider rows (number field + range with a
// colored track), the curve editor, the color grading wheel and the
// histogram with clipping indicators. Each control reports edits through
// callbacks; the workspace owns the settings.
import { escapeXML } from '../../../model/assets';
import type { NormPath, ParamValues, RGBA8 } from '../../../imaging/types';
import { developSpec } from '../../../imaging/filters/develop/params';
import { curvePoints, parametricEval, splineEval } from '../../../imaging/filters/develop/tone';

let uid = 0;
const nextId = () => `dv-${++uid}`;

const decimals = (step: number) => (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
export function formatValue(key: string, v: number) {
  const s = developSpec(key);
  const step = s && s.type === 'number' ? (s.step ?? 1) : 1;
  const d = decimals(step);
  const t = v.toFixed(d);
  return s && s.type === 'number' && s.min < 0 && v > 0 ? `+${t}` : t;
}

/** A labeled slider for a numeric setting. `track` is a CSS background for
 * the slider's track (temperature, tint and hue gradients). */
export function sliderHTML(key: string, opts: { label?: string; track?: string } = {}) {
  const s = developSpec(key);
  if (!s || s.type !== 'number') return '';
  const id = nextId(),
    label = opts.label ?? s.label,
    step = s.step ?? 1;
  const track = opts.track ? ` style="--track: ${opts.track}"` : '';
  return `<div class="dv-slider" data-row="${key}"><div class="dv-slider-head"><label for="${id}" data-reset="${key}" title="Double-click to reset">${escapeXML(label)}</label><input type="text" inputmode="decimal" id="${id}" class="dv-num" data-key="${key}" data-min="${s.min}" data-max="${s.max}" data-step="${step}" autocomplete="off" spellcheck="false"></div><input type="range" class="dv-range${opts.track ? ' dv-colored' : ''}" data-key="${key}" min="${s.min}" max="${s.max}" step="${step}" aria-label="${escapeXML(label)}"${track}></div>`;
}
export function selectHTML(key: string, label?: string) {
  const s = developSpec(key);
  if (!s || s.type !== 'select') return '';
  const id = nextId();
  return `<div class="dv-field" data-row="${key}"><label for="${id}">${escapeXML(label ?? s.label)}</label><select id="${id}" data-key="${key}">${s.options.map((o) => `<option value="${escapeXML(o.value)}">${escapeXML(o.label)}</option>`).join('')}</select></div>`;
}
export function checkHTML(key: string, label?: string) {
  const s = developSpec(key);
  if (!s || s.type !== 'checkbox') return '';
  return `<label class="dv-check" data-row="${key}"><input type="checkbox" data-key="${key}"> ${escapeXML(label ?? s.label)}</label>`;
}

/** Show `params` in every control under `host` (focused text fields keep what is typed). */
export function syncControls(host: HTMLElement, params: ParamValues) {
  for (const el of host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]')) {
    const v = params[el.dataset.key!];
    if (el instanceof HTMLSelectElement) {
      if (typeof v === 'string') el.value = v;
    } else if (el.type === 'checkbox') el.checked = v !== false;
    else if (el.type === 'range') el.value = String(v);
    else if (document.activeElement !== el && typeof v === 'number')
      el.value = formatValue(el.dataset.key!, v);
  }
}

/** Parse a typed value ("+12", "−0.5", "12.5") within a field's range. */
export function parseField(el: HTMLInputElement): number | undefined {
  const raw = el.value.replace(/[−–]/g, '-').replace(',', '.').trim();
  if (!raw) return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v)) return undefined;
  const min = Number(el.dataset.min),
    max = Number(el.dataset.max),
    step = Number(el.dataset.step) || 1;
  return Math.min(max, Math.max(min, Math.round(v / step) * step));
}

// ---------- Histogram ----------
export type HistInfo = {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  l: Uint32Array;
  total: number;
};
export function histogramOf(img: RGBA8): HistInfo {
  const r = new Uint32Array(256),
    g = new Uint32Array(256),
    b = new Uint32Array(256),
    l = new Uint32Array(256);
  const d = img.data;
  let total = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;
    r[d[i]]++;
    g[d[i + 1]]++;
    b[d[i + 2]]++;
    l[(d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8]++;
    total++;
  }
  return { r, g, b, l, total };
}
/** Clipping at either end: per channel share of pixels at 0 or 255. */
export function clipping(h: HistInfo) {
  const t = Math.max(1, h.total),
    lim = 0.0002;
  return {
    shadows: [h.r[0], h.g[0], h.b[0]].map((v) => v / t > lim),
    highlights: [h.r[255], h.g[255], h.b[255]].map((v) => v / t > lim),
  };
}
export function drawHistogram(canvas: HTMLCanvasElement, h: HistInfo | undefined) {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width,
    H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!h) return;
  let max = 1;
  for (const ch of [h.r, h.g, h.b]) for (let i = 2; i < 254; i++) max = Math.max(max, ch[i]);
  ctx.globalCompositeOperation = 'lighter';
  for (const [ch, color] of [
    [h.r, '#c83c3c'],
    [h.g, '#3ca046'],
    [h.b, '#3c64d2'],
  ] as const) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < 256; i++)
      ctx.lineTo((i / 255) * W, H - Math.min(1, Math.sqrt(ch[i] / max)) * (H - 4));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

// ---------- Curve editor ----------
export type CurveChannel = 'RGB' | 'Red' | 'Green' | 'Blue';
const curveKey = (c: CurveChannel) => `curve${c}`;
const CHANNEL_COLOR: Record<CurveChannel, string> = {
  RGB: '#e6e6e6',
  Red: '#e05050',
  Green: '#50c060',
  Blue: '#5a8cf0',
};
const REGION_KEYS = ['curveShadows', 'curveDarks', 'curveLights', 'curveHighlights'];

/** Point and parametric curve editing on one canvas. Points: click to add,
 * drag to move, drag off the top or bottom (or Delete) to remove; with the
 * canvas focused, arrows move the selected point, [ and ] select points and
 * Enter adds one. Parametric: drag up or down over a region to adjust it. */
export class CurveEditor {
  mode: 'parametric' | 'point' = 'parametric';
  channel: CurveChannel = 'RGB';
  private selected = -1;
  private drag?:
    | { kind: 'point'; index: number; removed: boolean }
    | { kind: 'region'; key: string; y: number; start: number };
  hist?: HistInfo;
  constructor(
    readonly canvas: HTMLCanvasElement,
    private get: () => ParamValues,
    private setCurve: (key: string, v: NormPath[], done: boolean) => void,
    private setValue: (key: string, v: number, done: boolean) => void,
  ) {
    canvas.tabIndex = 0;
    canvas.addEventListener('pointerdown', (ev) => this.down(ev));
    canvas.addEventListener('pointermove', (ev) => this.move(ev));
    canvas.addEventListener('pointerup', () => this.up());
    canvas.addEventListener('pointercancel', () => this.up());
    canvas.addEventListener('keydown', (ev) => this.key(ev));
    this.label();
  }
  setMode(mode: 'parametric' | 'point', channel: CurveChannel = this.channel) {
    this.mode = mode;
    this.channel = mode === 'parametric' ? 'RGB' : channel;
    this.selected = -1;
    this.label();
    this.draw();
  }
  private label() {
    this.canvas.setAttribute(
      'aria-label',
      this.mode === 'parametric'
        ? 'Parametric curve: drag up or down over a tonal region to adjust it'
        : `${this.channel === 'RGB' ? 'Point' : this.channel} curve: click to add a point, drag to move, drag off the curve or press Delete to remove; arrow keys move the selected point, [ and ] select points, Enter adds one`,
    );
  }
  /** Points of the channel being edited, with the end points when empty. */
  private points(): { x: number; y: number }[] {
    const pts = curvePoints(this.get()[curveKey(this.channel)]);
    return pts.length >= 2
      ? pts
      : [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ];
  }
  private commit(pts: { x: number; y: number }[], done: boolean) {
    const straight =
      pts.length === 2 && pts[0].x === 0 && pts[0].y === 0 && pts[1].x === 1 && pts[1].y === 1;
    this.setCurve(
      curveKey(this.channel),
      straight ? [] : [pts.map((p) => ({ x: round(p.x), y: round(p.y) }))],
      done,
    );
    this.draw();
  }
  private pos(ev: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / r.width, y: 1 - (ev.clientY - r.top) / r.height };
  }
  private down(ev: PointerEvent) {
    this.canvas.focus();
    this.canvas.setPointerCapture(ev.pointerId);
    const p = this.pos(ev);
    if (this.mode === 'parametric') {
      const key = this.regionAt(p.x);
      this.drag = { kind: 'region', key, y: ev.clientY, start: Number(this.get()[key]) || 0 };
      return;
    }
    const pts = this.points();
    const tol = 10 / this.canvas.getBoundingClientRect().width;
    let i = pts.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < tol * 1.5);
    if (i < 0) {
      const f = splineEval(pts);
      const q = { x: clamp01(p.x), y: Math.abs(f(p.x) - p.y) < 0.08 ? f(p.x) : clamp01(p.y) };
      pts.push(q);
      pts.sort((a, b) => a.x - b.x);
      i = pts.indexOf(q);
      this.commit(pts, false);
    }
    this.selected = i;
    this.drag = { kind: 'point', index: i, removed: false };
    this.draw();
  }
  private move(ev: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'region') {
      const v = Math.max(-100, Math.min(100, Math.round(d.start + (d.y - ev.clientY) * 0.6)));
      this.setValue(d.key, v, false);
      this.draw();
      return;
    }
    const p = this.pos(ev);
    const pts = this.points();
    const i = d.index;
    // Inner points dragged well off the canvas are removed (put back if dragged in again).
    const off = p.y < -0.12 || p.y > 1.12;
    const inner = i > 0 && i < pts.length - 1;
    if (off && inner && !d.removed) {
      pts.splice(i, 1);
      d.removed = true;
      this.selected = -1;
      this.commit(pts, false);
      return;
    }
    if (d.removed) return;
    const lo = i > 0 ? pts[i - 1].x + 0.01 : 0,
      hi = i < pts.length - 1 ? pts[i + 1].x - 0.01 : 1;
    pts[i] = { x: Math.min(hi, Math.max(lo, p.x)), y: clamp01(p.y) };
    this.commit(pts, false);
  }
  private up() {
    const d = this.drag;
    this.drag = undefined;
    if (!d) return;
    if (d.kind === 'region') this.setValue(d.key, Number(this.get()[d.key]) || 0, true);
    else this.commit(this.points(), true);
  }
  private key(ev: KeyboardEvent) {
    if (this.mode === 'parametric') return;
    const pts = this.points();
    const step = ev.shiftKey ? 10 / 255 : 1 / 255;
    let handled = true;
    if (ev.key === '[' || ev.key === ']')
      this.selected = Math.max(
        0,
        Math.min(
          pts.length - 1,
          (this.selected < 0 ? 0 : this.selected) + (ev.key === ']' ? 1 : -1),
        ),
      );
    else if (ev.key === 'Enter') {
      // A new point in the middle of the widest gap.
      let gap = 0;
      for (let i = 1; i < pts.length; i++)
        if (pts[i].x - pts[i - 1].x > pts[gap + 1].x - pts[gap].x) gap = i - 1;
      const x = (pts[gap].x + pts[gap + 1].x) / 2;
      const q = { x, y: splineEval(pts)(x) };
      pts.splice(gap + 1, 0, q);
      this.selected = gap + 1;
      this.commit(pts, true);
    } else if (
      (ev.key === 'Delete' || ev.key === 'Backspace') &&
      this.selected > 0 &&
      this.selected < pts.length - 1
    ) {
      pts.splice(this.selected, 1);
      this.selected = -1;
      this.commit(pts, true);
    } else if (ev.key.startsWith('Arrow') && this.selected >= 0) {
      const i = this.selected,
        q = { ...pts[i] };
      if (ev.key === 'ArrowUp') q.y = clamp01(q.y + step);
      if (ev.key === 'ArrowDown') q.y = clamp01(q.y - step);
      const lo = i > 0 ? pts[i - 1].x + 0.01 : 0,
        hi = i < pts.length - 1 ? pts[i + 1].x - 0.01 : 1;
      if (ev.key === 'ArrowLeft') q.x = Math.max(lo, q.x - step);
      if (ev.key === 'ArrowRight') q.x = Math.min(hi, q.x + step);
      pts[i] = q;
      this.commit(pts, true);
    } else handled = false;
    if (handled) {
      ev.preventDefault();
      ev.stopPropagation();
      this.draw();
    }
  }
  private regionAt(x: number) {
    const p = this.get();
    const s1 = (Number(p.curveSplit1) || 25) / 100,
      s2 = (Number(p.curveSplit2) || 50) / 100,
      s3 = (Number(p.curveSplit3) || 75) / 100;
    return REGION_KEYS[x < s1 ? 0 : x < s2 ? 1 : x < s3 ? 2 : 3];
  }
  draw() {
    const c = this.canvas,
      ctx = c.getContext('2d')!,
      W = c.width,
      H = c.height;
    const css = getComputedStyle(c);
    ctx.clearRect(0, 0, W, H);
    // Histogram backdrop.
    const h = this.hist;
    if (h) {
      const ch =
        this.channel === 'Red'
          ? h.r
          : this.channel === 'Green'
            ? h.g
            : this.channel === 'Blue'
              ? h.b
              : h.l;
      let max = 1;
      for (let i = 2; i < 254; i++) max = Math.max(max, ch[i]);
      ctx.fillStyle = css.getPropertyValue('--dv-curve-hist').trim() || '#ffffff22';
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++)
        ctx.lineTo((i / 255) * W, H - Math.min(1, Math.sqrt(ch[i] / max)) * H * 0.9);
      ctx.lineTo(W, H);
      ctx.fill();
    }
    ctx.strokeStyle = css.getPropertyValue('--dv-curve-grid').trim() || '#ffffff30';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 1; k < 4; k++) {
      const x = Math.round((k * W) / 4) + 0.5,
        y = Math.round((k * H) / 4) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.moveTo(0, H);
    ctx.lineTo(W, 0);
    ctx.stroke();
    const p = this.get();
    if (this.mode === 'parametric') {
      // Region splits.
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      for (const k of ['curveSplit1', 'curveSplit2', 'curveSplit3']) {
        const x = Math.round(((Number(p[k]) || 0) / 100) * W) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const f = this.mode === 'parametric' ? parametricEval(p) : splineEval(this.points());
    ctx.strokeStyle = CHANNEL_COLOR[this.channel];
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= W; i++) {
      const y = Math.min(1, Math.max(0, f(i / W)));
      if (i) ctx.lineTo(i, H - y * H);
      else ctx.moveTo(i, H - y * H);
    }
    ctx.stroke();
    if (this.mode === 'point')
      this.points().forEach((q, i) => {
        ctx.beginPath();
        ctx.arc(q.x * W, H - q.y * H, i === this.selected ? 5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = i === this.selected ? CHANNEL_COLOR[this.channel] : '#000';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
  }
}
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round = (v: number) => Math.round(v * 1000) / 1000;

// ---------- Color grading wheel ----------
/** A hue/saturation disk: angle is hue (0° at the right, counterclockwise),
 * distance from the center is saturation. Arrow keys: Left/Right hue,
 * Up/Down saturation (Shift for steps of 10). */
export class GradeWheel {
  private disk?: ImageData;
  private dragging = false;
  constructor(
    readonly canvas: HTMLCanvasElement,
    private get: () => { hue: number; sat: number },
    private set: (hue: number, sat: number, done: boolean) => void,
  ) {
    canvas.tabIndex = 0;
    canvas.addEventListener('pointerdown', (ev) => {
      canvas.focus();
      canvas.setPointerCapture(ev.pointerId);
      this.dragging = true;
      this.pick(ev, false);
    });
    canvas.addEventListener('pointermove', (ev) => this.dragging && this.pick(ev, false));
    const end = (ev: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.pick(ev, true);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('keydown', (ev) => {
      const { hue, sat } = this.get();
      const k = ev.shiftKey ? 10 : 1;
      let h = hue,
        s = sat;
      if (ev.key === 'ArrowLeft') h = (hue - k + 360) % 360;
      else if (ev.key === 'ArrowRight') h = (hue + k) % 360;
      else if (ev.key === 'ArrowUp') s = Math.min(100, sat + k);
      else if (ev.key === 'ArrowDown') s = Math.max(0, sat - k);
      else return;
      ev.preventDefault();
      ev.stopPropagation();
      this.set(h, s, true);
      this.draw();
    });
  }
  private pick(ev: PointerEvent, done: boolean) {
    const r = this.canvas.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width - 0.5,
      y = 0.5 - (ev.clientY - r.top) / r.height;
    let hue = Math.round((Math.atan2(y, x) * 180) / Math.PI);
    if (hue < 0) hue += 360;
    // Shift keeps the hue and changes only the saturation.
    if (ev.shiftKey) hue = this.get().hue;
    const sat = Math.round(Math.min(1, Math.hypot(x, y) / 0.46) * 100);
    this.set(hue, sat, done);
    this.draw();
  }
  draw() {
    const c = this.canvas,
      ctx = c.getContext('2d')!,
      W = c.width,
      R = W * 0.46;
    if (!this.disk) {
      const img = ctx.createImageData(W, W);
      for (let y = 0; y < W; y++)
        for (let x = 0; x < W; x++) {
          const dx = x + 0.5 - W / 2,
            dy = W / 2 - (y + 0.5),
            d = Math.hypot(dx, dy) / R;
          const o = (y * W + x) * 4;
          if (d > 1.02) continue;
          const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
          const [r, g, b] = hsv(h, Math.min(1, d) * 0.85, 0.82);
          img.data.set([r, g, b, d > 1 ? Math.round((1.02 - d) * 50 * 255) : 255], o);
        }
      this.disk = img;
    }
    ctx.putImageData(this.disk, 0, 0);
    const { hue, sat } = this.get();
    const a = (hue * Math.PI) / 180,
      d = (sat / 100) * R;
    const x = W / 2 + Math.cos(a) * d,
      y = W / 2 - Math.sin(a) * d;
    ctx.strokeStyle = '#0008';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 5, W / 2);
    ctx.lineTo(W / 2 + 5, W / 2);
    ctx.moveTo(W / 2, W / 2 - 5);
    ctx.lineTo(W / 2, W / 2 + 5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 7.5, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    c.setAttribute('aria-valuetext', `Hue ${hue}°, saturation ${sat}`);
  }
}
export function hsv(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}
export const hueCSS = (h: number, s = 0.75, v = 0.85) =>
  `rgb(${hsv(((h % 360) + 360) % 360, s, v).join(' ')})`;
