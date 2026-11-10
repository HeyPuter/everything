/**
 * Small Canvas 2D previews of entities (block thumbnails, hatch swatches),
 * drawn through the same display-list pipeline as the main view.
 */
import { emitEntity, makeContext, BoundsSink } from '../core/tessellate.js';

class CanvasSink {
  constructor(ctx, m, fg) {
    this.c = ctx;
    this.m = m;
    this.fg = fg;
  }
  _path(pts, closed) {
    const [s, tx, ty] = this.m;
    const c = this.c;
    c.moveTo(pts[0] * s + tx, -pts[1] * s + ty);
    for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i] * s + tx, -pts[i + 1] * s + ty);
    if (closed) c.closePath();
  }
  _color(style) {
    this.c.globalAlpha = style.alpha ?? 1;
    return style.aci7 ? this.fg : `rgb(${style.rgb[0]},${style.rgb[1]},${style.rgb[2]})`;
  }
  line(pts, closed, style) {
    const c = this.c;
    c.beginPath();
    // Points and zero-length dashes (pattern dots) draw as one-pixel squares.
    if (pts.length === 2 || (pts.length === 4 && pts[0] === pts[2] && pts[1] === pts[3])) {
      const [s, tx, ty] = this.m;
      c.rect(pts[0] * s + tx - 0.5, -pts[1] * s + ty - 0.5, 1, 1);
    } else this._path(pts, closed);
    c.strokeStyle = this._color(style);
    c.stroke();
  }
  segs(s, style) {
    const c = this.c;
    c.beginPath();
    for (let i = 0; i < s.length; i += 4) this._path([s[i], s[i + 1], s[i + 2], s[i + 3]], false);
    c.strokeStyle = this._color(style);
    c.stroke();
  }
  fill(rings, style) {
    const c = this.c;
    c.beginPath();
    for (const r of rings) this._path(r, true);
    c.fillStyle = this._color(style);
    c.fill('evenodd');
  }
}

/**
 * Draw entities into a canvas, fitted with a margin. `fg` is the CSS color
 * used for index 7 (normally the text color).
 */
export function drawPreview(canvas, drawing, entities, { fg = '#888', bounds = null, margin = 6, lineWidth = 1 } = {}) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || canvas.width,
    h = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  // The browser can refuse a context; a blank thumbnail beats an exception per block.
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  let b = bounds;
  if (!b) {
    const bs = new BoundsSink();
    const bctx = makeContext(drawing, { tol: 1e-3, pointSize: 0 });
    bctx.ignoreVisibility = true;
    for (const e of entities) {
      try {
        emitEntity(e, bs, bctx);
      } catch {
        /* skip */
      }
    }
    b = bs.bounds;
  }
  if (!b) return;
  const bw = Math.max(b[2] - b[0], 1e-9),
    bh = Math.max(b[3] - b[1], 1e-9);
  const s = Math.min((w - margin * 2) / bw, (h - margin * 2) / bh);
  const tx = w / 2 - ((b[0] + b[2]) / 2) * s;
  const ty = h / 2 + ((b[1] + b[3]) / 2) * s;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // Previews show patterns as patterns (as on paper), never as a density tint.
  const ctxr = makeContext(drawing, { tol: 0.5 / s, pointSize: 3 / s, fg: [128, 128, 128], view: b, plot: true });
  ctxr.ignoreVisibility = true;
  const sink = new CanvasSink(ctx, [s, tx, ty], fg);
  for (const e of entities) {
    try {
      emitEntity(e, sink, ctxr);
    } catch {
      /* skip */
    }
  }
}
