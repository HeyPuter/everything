// Color ramp eyedroppers: sample colors from the screen into the color ramp under the pointer.
//   ui.eyedropper_colorramp        drag a line; the colors along it become the ramp's stops
//   ui.eyedropper_colorramp_point  click points one by one; the stops spread evenly over them
// Colors come from what is drawn under the pointer: the 3D views (shared canvas), other canvases,
// images, and the background colour of interface elements (swatches, panels).
import { app, registerOperators } from '../app/app';
import { addKeys, keymaps, keyName, keyInputHooks } from '../app/keymap';
import { srgbToLinear } from './widgets';
import { renderContext } from '../render/context';

export interface RampStopLike {
  pos: number;
  color: [number, number, number, number];
}

/** A color ramp widget that can take sampled stops (set by the widget when the pointer enters it). */
export interface RampTarget {
  stops(): RampStopLike[];
  /** replace the stops (no undo step: the eyedropper pushes one when it finishes) */
  set(stops: RampStopLike[]): void;
}

export const hoveredRamp: { el: HTMLElement | null; target: RampTarget | null } = { el: null, target: null };

/** Called by color ramp widgets on pointer enter: they become the eyedroppers' target. */
export function setHoveredRamp(el: HTMLElement, target: RampTarget) {
  hoveredRamp.el = el;
  hoveredRamp.target = target;
}

function rampUnderPointer(): RampTarget | null {
  const { el, target } = hoveredRamp;
  if (!el || !target || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  const p = app.pointer;
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom ? target : null;
}

// ---------------------------------------------------------------------------
// screen sampling

let scratch: CanvasRenderingContext2D | null = null;
function pixelOf(src: CanvasImageSource, sx: number, sy: number): number[] | null {
  scratch ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  if (!scratch) return null;
  try {
    scratch.clearRect(0, 0, 1, 1);
    scratch.drawImage(src, sx, sy, 1, 1, 0, 0, 1, 1);
    const d = scratch.getImageData(0, 0, 1, 1).data;
    return [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255];
  } catch {
    return null;
  }
}

function cssColor(s: string): number[] | null {
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (!m) return null;
  const v = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (v.length < 3 || v.some((x) => !Number.isFinite(x))) return null;
  return [v[0] / 255, v[1] / 255, v[2] / 255, v[3] ?? 1];
}

let drawnFrame = -1;
/** sRGB color (0–1, with alpha) drawn at a client point, or null. */
export function sampleScreen(x: number, y: number): number[] | null {
  const hit = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!hit) return null;
  // the 3D views draw into one canvas behind their overlays
  const engine = renderContext?.engine;
  if (engine && hit.closest('.view3d')) {
    const r = engine.canvas.getBoundingClientRect();
    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) {
      // drawing keeps the frame readable for this sample
      const now = Math.floor(performance.now() / 16);
      if (now !== drawnFrame) {
        engine.drawAll();
        drawnFrame = now;
      }
      const px = pixelOf(engine.canvas, (x - r.left) * engine.dpr, (y - r.top) * engine.dpr);
      if (px) return px;
    }
  }
  if (hit instanceof HTMLCanvasElement || hit instanceof HTMLImageElement || hit instanceof HTMLVideoElement) {
    const r = hit.getBoundingClientRect();
    const w = hit instanceof HTMLCanvasElement ? hit.width : hit instanceof HTMLImageElement ? hit.naturalWidth : hit.videoWidth;
    const hh = hit instanceof HTMLCanvasElement ? hit.height : hit instanceof HTMLImageElement ? hit.naturalHeight : hit.videoHeight;
    const px = pixelOf(hit, ((x - r.left) / Math.max(1, r.width)) * w, ((y - r.top) / Math.max(1, r.height)) * hh);
    if (px && px[3] > 0) return px;
  }
  // interface elements: the first opaque background colour up the tree
  for (let e: HTMLElement | null = hit; e; e = e.parentElement) {
    const c = cssColor(getComputedStyle(e).backgroundColor);
    if (c && c[3] > 0.5) return c;
  }
  return null;
}

/** sRGB sample → linear RGBA as the ramps store it. */
const toLinear = (c: number[]): [number, number, number, number] => [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]), 1];

/** Evenly spaced stops for a list of colors (one color: a flat ramp). */
export function stopsFromColors(colors: [number, number, number, number][]): RampStopLike[] {
  if (!colors.length) return [];
  if (colors.length === 1) return [{ pos: 0, color: colors[0] }];
  return colors.map((color, i) => ({ pos: i / (colors.length - 1), color }));
}

/** Points along a line (inclusive), `n` of them. */
export function linePoints(x0: number, y0: number, x1: number, y1: number, n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
  }
  return out;
}

/** Most stops a sampled ramp gets. */
export const MAX_SAMPLES = 32;

// ---------------------------------------------------------------------------
// gestures

function overlay() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ramp-dropper');
  document.body.append(svg);
  document.body.classList.add('eyedropper-active');
  return {
    svg,
    dispose() {
      svg.remove();
      document.body.classList.remove('eyedropper-active');
    },
  };
}

function lineGesture(target: RampTarget) {
  const before = target.stops().map((s) => ({ pos: s.pos, color: [...s.color] as RampStopLike['color'] }));
  const o = overlay();
  let start: { x: number; y: number } | null = null;
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  o.svg.append(line);
  const apply = (x: number, y: number) => {
    if (!start) return;
    const len = Math.hypot(x - start.x, y - start.y);
    const n = Math.max(2, Math.min(MAX_SAMPLES, Math.round(len / 6)));
    const cols = linePoints(start.x, start.y, x, y, n)
      .map(([px, py]) => sampleScreen(px, py))
      .filter((c): c is number[] => !!c)
      .map(toLinear);
    if (cols.length) target.set(stopsFromColors(cols));
  };
  app.startModal({
    label: 'Eyedropper Colorband',
    cursor: 'crosshair',
    header: () => 'Colorband Eyedropper: drag a line over the colors to sample, Esc to cancel',
    status: () => [
      ['LMB', 'Sample a line'],
      ['RMB / Esc', 'Cancel'],
    ],
    onPointerDown: (e) => {
      if (e.button !== 0) return 'CANCELLED';
      start = { x: e.clientX, y: e.clientY };
      Object.entries({ x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY }).forEach(([k, v]) => line.setAttribute(k, String(v)));
    },
    onPointerMove: (e) => {
      if (!start) return;
      line.setAttribute('x2', String(e.clientX));
      line.setAttribute('y2', String(e.clientY));
      apply(e.clientX, e.clientY);
    },
    onPointerUp: (e) => {
      if (!start || e.button !== 0) return;
      apply(e.clientX, e.clientY);
      return 'FINISHED';
    },
    onKey: (e) => (e.type === 'keydown' && (e.key === 'Escape' || e.key === 'Backspace') ? 'CANCELLED' : true),
    finish: () => o.dispose(),
    cancel: () => {
      target.set(before);
      o.dispose();
    },
  });
}

function pointGesture(target: RampTarget) {
  const before = target.stops().map((s) => ({ pos: s.pos, color: [...s.color] as RampStopLike['color'] }));
  const o = overlay();
  const picked: [number, number, number, number][] = [];
  const dots: SVGCircleElement[] = [];
  app.startModal({
    label: 'Eyedropper Colorband (Points)',
    cursor: 'crosshair',
    header: () => `Colorband Eyedropper: click colors to sample (${picked.length}), Enter or RMB to confirm, Space to restart, Esc to cancel`,
    status: () => [
      ['LMB', 'Sample'],
      ['RMB / Enter', 'Confirm'],
      ['Space', 'Restart'],
      ['Esc', 'Cancel'],
    ],
    onPointerDown: (e) => {
      if (e.button === 2) return picked.length ? 'FINISHED' : 'CANCELLED';
      if (e.button !== 0) return;
      const c = sampleScreen(e.clientX, e.clientY);
      if (!c) return;
      if (picked.length >= MAX_SAMPLES) picked.shift();
      picked.push(toLinear(c));
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      Object.entries({ cx: e.clientX, cy: e.clientY, r: 4 }).forEach(([k, v]) => dot.setAttribute(k, String(v)));
      o.svg.append(dot);
      dots.push(dot);
      // live preview
      target.set(stopsFromColors(picked));
      app.changed('ui');
    },
    onKey: (e) => {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Enter') return picked.length ? 'FINISHED' : 'CANCELLED';
      if (e.key === 'Escape' || e.key === 'Backspace') return 'CANCELLED';
      if (e.key === ' ') {
        picked.length = 0;
        for (const d of dots.splice(0)) d.remove();
        target.set(before);
        app.changed('ui');
      }
      return true;
    },
    finish: () => o.dispose(),
    cancel: () => {
      target.set(before);
      o.dispose();
    },
  });
}

registerOperators([
  {
    idname: 'ui.eyedropper_colorramp',
    label: 'Eyedropper Colorband',
    description: 'Drag a line over the screen; the colors along it become the stops of the color ramp under the pointer',
    undo: false,
    poll: () => !!rampUnderPointer(),
    invoke: () => {
      lineGesture(rampUnderPointer()!);
      return 'RUNNING_MODAL';
    },
    exec: () => 'CANCELLED',
  },
  {
    idname: 'ui.eyedropper_colorramp_point',
    label: 'Eyedropper Colorband (Points)',
    description: 'Click colors on the screen one by one; they become evenly spaced stops of the color ramp under the pointer',
    undo: false,
    poll: () => !!rampUnderPointer(),
    invoke: () => {
      pointGesture(rampUnderPointer()!);
      return 'RUNNING_MODAL';
    },
    exec: () => 'CANCELLED',
  },
]);

addKeys('User Interface', [
  { key: 'E', op: 'ui.eyedropper_colorramp' },
  { key: 'E', alt: true, op: 'ui.eyedropper_colorramp_point' },
]);

// Over a color ramp, its eyedropper keys win (the ramp bar is not a property button).
keyInputHooks.push((e) => {
  if (e.type !== 'keydown' || e.repeat || !rampUnderPointer()) return false;
  const name = keyName(e);
  const ctrl = e.ctrlKey || e.metaKey;
  for (const k of keymaps['User Interface'] ?? []) {
    if (k.inactive || !k.op?.startsWith('ui.eyedropper_colorramp') || k.key !== name) continue;
    if (!k.any && (!!k.shift !== e.shiftKey || !!k.ctrl !== ctrl || !!k.alt !== e.altKey)) continue;
    if (!app.poll(k.op)) continue;
    app.run(k.op, k.props ?? {});
    return true;
  }
  return false;
});
