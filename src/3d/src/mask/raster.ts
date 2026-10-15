// Mask rasterization (2D canvas): each layer's closed splines are filled (overlaps make holes),
// feathers are built from offset outlines stacked into a falloff ramp, then layers combine with
// their blend mode and opacity. Output: a grayscale image (white = inside).
import type { MaskData, MaskLayer, MaskSpline } from './types';
import { layerAt, sampleSpline, featherOutline } from './geom';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Canvas = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(w: number, h: number): Canvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const FEATHER_STEPS = 12;
const smooth = (x: number) => x * x * (3 - 2 * x);

function tracePath(g: Ctx, sp: MaskSpline, W: number, H: number) {
  const P = (v: [number, number]): [number, number] => [v[0] * W, (1 - v[1]) * H];
  const pts = sp.points;
  g.moveTo(...P(pts[0].co));
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i],
      b = pts[(i + 1) % pts.length];
    g.bezierCurveTo(...P(a.handle_right), ...P(b.handle_left), ...P(b.co));
  }
  g.closePath();
}

/** One layer (already evaluated at the frame) as white-on-black coverage. */
function drawLayer(g: Ctx, layer: MaskLayer, W: number, H: number, feather: boolean) {
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  const closed = layer.splines.filter((s) => s.use_cyclic && s.use_fill && s.points.length >= 2);
  if (feather) {
    // rings from the outermost in: each adds a step of the falloff
    const aspect = W / H;
    for (const sp of closed) {
      if (!sp.points.some((p) => p.weight > 0)) continue;
      const samples = sampleSpline(sp, 24);
      for (let k = FEATHER_STEPS; k >= 1; k--) {
        const f0 = (k - 1) / FEATHER_STEPS,
          f1 = k / FEATHER_STEPS;
        const v = (f: number) => (layer.falloff === 'SMOOTH' ? 1 - smooth(f) : 1 - f);
        const step = v(f0) - v(f1);
        if (step <= 0) continue;
        const ring = featherOutline(samples, aspect, f1 - 0.5 / FEATHER_STEPS);
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = step;
        g.fillStyle = '#fff';
        g.beginPath();
        ring.forEach(([x, y], i) => (i ? g.lineTo(x * W, (1 - y) * H) : g.moveTo(x * W, (1 - y) * H)));
        g.closePath();
        g.fill('nonzero');
      }
    }
  }
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.fillStyle = '#fff';
  g.beginPath();
  for (const sp of closed) tracePath(g, sp, W, H);
  // overlapping splines of a layer cut holes
  g.fill('evenodd');
  if (layer.invert) {
    g.globalCompositeOperation = 'difference';
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
  }
}

const OPS: Record<string, GlobalCompositeOperation> = {
  MERGE_ADD: 'screen',
  ADD: 'lighter',
  LIGHTEN: 'lighten',
  DARKEN: 'darken',
  MUL: 'multiply',
  DIFFERENCE: 'difference',
  REPLACE: 'source-over',
};

let layerCanvas: Canvas | null = null;

/** Rasterize a mask at a frame into a W×H canvas (grayscale, opaque). */
export function rasterizeMask(mask: MaskData, frame: number, W: number, H: number, feather = true, target?: Canvas): Canvas {
  W = Math.max(1, Math.round(W));
  H = Math.max(1, Math.round(H));
  const out = target ?? makeCanvas(W, H);
  if (out.width !== W || out.height !== H) {
    out.width = W;
    out.height = H;
  }
  const g = out.getContext('2d') as Ctx;
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  if (!layerCanvas || layerCanvas.width !== W || layerCanvas.height !== H) layerCanvas = makeCanvas(W, H);
  const lg = layerCanvas.getContext('2d') as Ctx;
  for (const layer of mask.layers) {
    if (layer.hide_render || !layer.splines.length) continue;
    drawLayer(lg, layerAt(layer, frame), W, H, feather);
    g.globalAlpha = Math.max(0, Math.min(1, layer.alpha));
    if (layer.blend === 'SUBTRACT' || layer.blend === 'MERGE_SUBTRACT') {
      // acc × (1 − layer): multiply by the inverted layer
      lg.globalCompositeOperation = 'difference';
      lg.globalAlpha = 1;
      lg.fillStyle = '#fff';
      lg.fillRect(0, 0, W, H);
      // opacity fades the cut towards no change (white)
      if (layer.alpha < 1) {
        lg.globalCompositeOperation = 'source-over';
        lg.globalAlpha = 1 - Math.max(0, layer.alpha);
        lg.fillRect(0, 0, W, H);
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'multiply';
    } else g.globalCompositeOperation = OPS[layer.blend] ?? 'screen';
    g.drawImage(layerCanvas as CanvasImageSource, 0, 0);
  }
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  return out;
}

/** Mask coverage as floats (row 0 at the top). */
export function maskPixels(mask: MaskData, frame: number, W: number, H: number, feather = true): Float32Array {
  const c = rasterizeMask(mask, frame, W, H, feather);
  const d = (c.getContext('2d') as Ctx).getImageData(0, 0, c.width, c.height).data;
  const out = new Float32Array(c.width * c.height);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4] / 255;
  return out;
}

/** A cheap fingerprint of what a mask renders at a frame (texture caches). */
export function maskKey(mask: MaskData, frame: number): string {
  const s = JSON.stringify(mask.layers.map((l) => [l.hide_render, l.alpha, l.blend, l.invert, l.falloff, layerAt(l, frame).splines.map((sp) => [sp.use_cyclic, sp.use_fill, sp.points.map((p) => [p.co, p.handle_left, p.handle_right, p.weight])])]));
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `${mask.id}|${(h >>> 0).toString(36)}|${s.length}`;
}
