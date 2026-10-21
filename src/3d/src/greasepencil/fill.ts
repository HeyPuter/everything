// Fill tool: the visible strokes are rasterized in screen space, the clicked closed region is
// flood filled, dilated a little under the boundary lines, and its outline (plus the outlines of
// any holes) is traced with marching squares and projected back onto the drawing plane. The
// boundary curves share a fill id so holes stay open (even-odd fill).
import { Vector3 } from 'three';
import { app } from '../app/app';
import type { ObjectData } from '../data/types';
import type { View3D } from '../editors/view3d/view3d';
import { frameAt, type GPPoint } from './data';
import { Placement } from './placement';
import { layerMatrix } from './render';
import type { GPBrush, GPLayer, GreasePencilData } from './types';
import { floodFill, dilate, traceContours, simplifyLoop, invertedRegion } from './fillmath';
import { extensionLines, type ScreenStroke } from './fillgaps';
import { evaluatedDrawing } from './curves';

export { floodFill, dilate, traceContours, simplifyLoop };

// ---------------------------------------------------------------------------

function fillLayers(gp: GreasePencilData, active: GPLayer, mode: GPBrush['fill_layer_mode']): GPLayer[] {
  const i = gp.layers.indexOf(active);
  const vis = gp.layers.filter((l) => !l.hide);
  switch (mode) {
    case 'ACTIVE':
      return [active];
    case 'ABOVE':
      return gp.layers[i + 1] ? [gp.layers[i + 1]] : [];
    case 'BELOW':
      return gp.layers[i - 1] ? [gp.layers[i - 1]] : [];
    case 'ALL_ABOVE':
      return gp.layers.slice(i + 1).filter((l) => !l.hide);
    case 'ALL_BELOW':
      return gp.layers.slice(0, i).filter((l) => !l.hide);
    default:
      return vis;
  }
}

/** Fill the region under (x, y): returns the boundary curves (layer space) or an error message. */
export function fillRegion(v: View3D, ob: ObjectData, gp: GreasePencilData, layer: GPLayer, x: number, y: number, b: GPBrush, invert = false): GPPoint[][] | string {
  const W0 = Math.max(1, Math.round(v.width)),
    H0 = Math.max(1, Math.round(v.height));
  const s = Math.min(1, 1400 / Math.max(W0, H0));
  const W = Math.max(8, Math.round(W0 * s)),
    H = Math.max(8, Math.round(H0 * s));
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(W, H)
      : Object.assign(document.createElement('canvas'), {
          width: W,
          height: H,
        });
  const g = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!g) return 'Fill is not available (no 2D canvas)';
  g.clearRect(0, 0, W, H);
  g.strokeStyle = '#ffffff';
  g.fillStyle = '#ffffff';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const frame = app.doc.scene.frame_current;
  const obWorld = app.graph.get(ob.id)?.world;
  const pl = new Placement(v, ob, gp, layer);
  const wp = new Vector3();
  let any = false;
  const screenStrokes: ScreenStroke[] = [];
  const pxPerWorld: number[] = [];
  for (const l of fillLayers(gp, layer, b.fill_layer_mode)) {
    const fr = frameAt(l, frame);
    const d = fr && gp.drawings[fr.drawing] ? evaluatedDrawing(gp.drawings[fr.drawing]) : null;
    if (!d) continue;
    const m = obWorld ? obWorld.clone().multiply(layerMatrix(l)) : layerMatrix(l);
    for (let k = 0; k + 1 < d.offsets.length; k++) {
      const a = d.offsets[k],
        e = d.offsets[k + 1];
      if (e <= a) continue;
      wp.set(d.position[a * 3], d.position[a * 3 + 1], d.position[a * 3 + 2]).applyMatrix4(m);
      const px = 1 / pl.pixelSize(wp);
      const scl = (Math.hypot(m.elements[0], m.elements[1], m.elements[2]) + Math.hypot(m.elements[4], m.elements[5], m.elements[6]) + Math.hypot(m.elements[8], m.elements[9], m.elements[10])) / 3;
      const scr: [number, number, number][] = [];
      for (let i = a; i < e; i++) {
        wp.set(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]).applyMatrix4(m);
        const p = v.project(wp);
        scr.push([p.x * s, p.y * s, Math.max(0.6, d.radius[i] * scl * px * s)]);
      }
      screenStrokes.push({ pts: scr.map((q) => [q[0], q[1]]), cyclic: !!d.cyclic[k] });
      pxPerWorld.push(px * s);
      // segment by segment so the line width follows the point radius
      for (let i = 0; i < scr.length; i++) {
        const p = scr[i],
          q = scr[i + 1] ?? (d.cyclic[k] && scr.length > 2 ? scr[0] : null);
        g.beginPath();
        if (!q) {
          g.arc(p[0], p[1], p[2], 0, Math.PI * 2);
          g.fill();
          continue;
        }
        g.lineWidth = Math.max(1.2, p[2] + q[2]);
        g.moveTo(p[0], p[1]);
        g.lineTo(q[0], q[1]);
        g.stroke();
      }
      any = true;
    }
  }
  if (!any) return 'Unable to fill: there are no strokes to fill inside';
  // gap closure: extension lines count as boundaries
  const ext = (b.fill_extend ?? 0) > 0 ? extensionLines(screenStrokes, b.fill_extend_mode ?? 'EXTEND', () => (b.fill_extend ?? 0) * (pxPerWorld[0] ?? 1), !!b.use_collide_strokes) : [];
  g.lineWidth = 1.6;
  for (const [x0, y0, x1, y1] of ext) {
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  }
  const img = g.getImageData(0, 0, W, H).data;
  const boundary = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) boundary[i] = img[i * 4 + 3] > 40 ? 1 : 0;
  const sx = Math.round(x * s),
    sy = Math.round(y * s);
  if (boundary[sy * W + sx]) return 'Unable to fill: click inside a closed area, not on a stroke';
  const region = invert ? invertedRegion(boundary, W, H, sx, sy) : floodFill(boundary, W, H, sx, sy);
  if (!region) return invert ? 'Unable to fill: no closed areas next to the clicked one' : 'Unable to fill unclosed areas';
  const grown = dilate(region, W, H, Math.max(0, Math.round((b.dilate ?? 1) * s)) + 1);
  const loops = traceContours(grown, W, H);
  if (!loops.length) return 'Unable to fill';
  const radiusPx = (b.size ?? 2) / 2;
  const out: GPPoint[][] = [];
  const sc = pl.scale();
  for (const loop of loops) {
    const simp = simplifyLoop(loop, 0.8);
    const pts: GPPoint[] = [];
    for (const [lx, ly] of simp) {
      const w = pl.project(lx / s, ly / s);
      if (!w) continue;
      pts.push({
        co: pl.toLocal(w),
        radius: (radiusPx * pl.pixelSize(w)) / sc,
        opacity: b.strength,
        vertex_color: [0, 0, 0, 0],
      });
    }
    if (pts.length >= 3) out.push(pts);
  }
  // largest first (outer boundary)
  out.sort((p, q) => q.length - p.length);
  return out.length ? out : 'Unable to fill';
}

// ---------------------------------------------------------------------------
// gap closure preview (while the Fill tool hovers the viewport)

/** The extension lines a fill would use, in viewport pixels. */
export function extensionPreview(v: View3D, ob: ObjectData, gp: GreasePencilData, layer: GPLayer, b: GPBrush): [number, number, number, number][] {
  if (!(b.fill_extend && b.fill_extend > 0)) return [];
  const frame = app.doc.scene.frame_current;
  const obWorld = app.graph.get(ob.id)?.world;
  const pl = new Placement(v, ob, gp, layer);
  const wp = new Vector3();
  const strokes: ScreenStroke[] = [];
  let px = 1;
  for (const l of fillLayers(gp, layer, b.fill_layer_mode)) {
    const fr = frameAt(l, frame);
    const d = fr && gp.drawings[fr.drawing] ? evaluatedDrawing(gp.drawings[fr.drawing]) : null;
    if (!d) continue;
    const m = obWorld ? obWorld.clone().multiply(layerMatrix(l)) : layerMatrix(l);
    for (let k = 0; k + 1 < d.offsets.length; k++) {
      const pts: [number, number][] = [];
      for (let i = d.offsets[k]; i < d.offsets[k + 1]; i++) {
        wp.set(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]).applyMatrix4(m);
        const p = v.project(wp);
        pts.push([p.x, p.y]);
        if (strokes.length === 0 && pts.length === 1) px = 1 / pl.pixelSize(wp);
      }
      strokes.push({ pts, cyclic: !!d.cyclic[k] });
    }
  }
  return extensionLines(strokes, b.fill_extend_mode ?? 'EXTEND', () => (b.fill_extend ?? 0) * px, !!b.use_collide_strokes);
}
