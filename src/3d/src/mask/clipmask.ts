// Mask editing in the Movie Clip Editor (mask mode): drawing the mask over the footage and the
// pointer interaction (select, slide points / handles / curvature, add points and feathers,
// box / circle / lasso selection, G/R/S transforms).
import { app } from '../app/app';
import type { MaskData, MaskLayer, MaskPoint, MaskSpline } from './types';
import { maskTable, activeLayer, newPoint } from './types';
import { recalcHandles, alignHandles, sampleSpline, featherOutline, insertPoint, layerAt } from './geom';
import { parentResolver } from './parent';
import { rasterizeMask, maskKey } from './raster';

type V = [number, number];

/** What mask editing needs from the clip editor. */
export interface MaskHost {
  maskId: string | null;
  canvas: HTMLCanvasElement;
  /** frame (footage) size in pixels */
  frameSize(): [number, number];
  /** footage pixel (y down) ↔ editor-local screen pixel */
  toScreen(x: number, y: number): [number, number];
  toImage(sx: number, sy: number): [number, number];
  local(e: { clientX: number; clientY: number }): { x: number; y: number };
  draw(): void;
  drawUI(): void;
  shapeOverlay?: { kind: 'circle'; x: number; y: number; r: number } | { kind: 'lasso'; pts: V[] } | null;
}

export function hostMask(ed: { maskId: string | null }): MaskData | null {
  return (ed.maskId && maskTable(app.doc)[ed.maskId]) || null;
}

/** Mask space (0..1, y up) → screen. */
export function m2s(ed: MaskHost, p: V): V {
  const [W, H] = ed.frameSize();
  return ed.toScreen(p[0] * W, (1 - p[1]) * H);
}
export function s2m(ed: MaskHost, x: number, y: number): V {
  const [W, H] = ed.frameSize();
  const [ix, iy] = ed.toImage(x, y);
  return [ix / W, 1 - iy / H];
}

export function aspectOf(ed: MaskHost) {
  const [W, H] = ed.frameSize();
  return W / Math.max(1, H);
}

const visibleLayers = (m: MaskData) => m.layers.filter((l) => !l.hide);

/** Points as shown (parents applied; edits go to the stored points by the same deltas). */
export function shownPoints(m: MaskData): Map<MaskPoint, MaskPoint> {
  const out = new Map<MaskPoint, MaskPoint>();
  const f = app.doc.scene.frame_current;
  const res = parentResolver(app.doc);
  for (const l of m.layers) {
    const L = layerAt(l, f, res, false);
    l.splines.forEach((s, i) => s.points.forEach((p, j) => out.set(p, L.splines[i].points[j])));
  }
  return out;
}

const shown = (E: Map<MaskPoint, MaskPoint>, p: MaskPoint) => E.get(p) ?? p;
const editableLayers = (m: MaskData) => m.layers.filter((l) => !l.hide && !l.hide_select);

export function allPoints(m: MaskData, editable = true): { layer: MaskLayer; spline: MaskSpline; point: MaskPoint }[] {
  const out: { layer: MaskLayer; spline: MaskSpline; point: MaskPoint }[] = [];
  for (const layer of editable ? editableLayers(m) : m.layers) for (const spline of layer.splines) for (const point of spline.points) if (!point.hide) out.push({ layer, spline, point });
  return out;
}

export function selectedPoints(m: MaskData) {
  return allPoints(m).filter((x) => x.point.select);
}

export function deselectAll(m: MaskData) {
  for (const l of m.layers) for (const s of l.splines) for (const p of s.points) p.select = p.select_left_handle = p.select_right_handle = false;
}

/** Handles are shown (and can be grabbed) for selected points that are not automatic. */
const showsHandles = (p: MaskPoint) => p.select && p.handle_type !== 'AUTO' && p.handle_type !== 'VECTOR';

// ---------------------------------------------------------------------------
// drawing

export function drawMask(ed: MaskHost, g: CanvasRenderingContext2D, splines = true) {
  const m = hostMask(ed);
  if (!m) return;
  if (!splines) return drawSelectShape(g, ed.shapeOverlay);
  const aspect = aspectOf(ed);
  const act = activeLayer(m);
  const frame = app.doc.scene.frame_current;
  const res = parentResolver(app.doc);
  for (const layer of visibleLayers(m)) {
    const isAct = layer === act;
    const shownLayer = layerAt(layer, frame, res, false);
    for (const [si, sp0] of layer.splines.entries()) {
      const sp = shownLayer.splines[si];
      if (!sp.points.length) continue;
      const samples = sampleSpline(sp, 16);
      const line = samples.map((s) => m2s(ed, s.p));
      // fill preview of closed splines
      if (sp.use_cyclic && sp.use_fill && line.length > 2) {
        g.fillStyle = 'rgba(255, 255, 255,0.08)';
        g.beginPath();
        line.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.closePath();
        g.fill();
      }
      // feather outline
      if (sp.use_cyclic && sp.points.some((p) => p.weight > 0)) {
        const f = featherOutline(samples, aspect).map((p) => m2s(ed, p));
        g.strokeStyle = 'rgba(255, 255, 255,0.35)';
        g.lineWidth = 1;
        g.beginPath();
        f.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.closePath();
        g.stroke();
      }
      void sp0;
      const selected = sp.points.some((p) => p.select);
      const active = isAct && layer.active_spline === si;
      g.lineWidth = active ? 2 : 1.5;
      g.strokeStyle = '#000000';
      g.beginPath();
      line.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      if (sp.use_cyclic) g.closePath();
      g.stroke();
      g.setLineDash([4, 4]);
      g.strokeStyle = selected ? (active ? '#fcb454' : '#fa9404') : '#d1d2d4';
      g.stroke();
      g.setLineDash([]);
      if (layer.hide_select) continue;
      for (const p of sp.points) {
        if (p.hide) continue;
        const c = m2s(ed, p.co);
        if (showsHandles(p)) {
          for (const [h, sel] of [
            [p.handle_left, p.select_left_handle],
            [p.handle_right, p.select_right_handle],
          ] as const) {
            const hs = m2s(ed, h);
            g.strokeStyle = 'rgba(0, 0, 0,0.8)';
            g.lineWidth = 3;
            g.beginPath();
            g.moveTo(...c);
            g.lineTo(...hs);
            g.stroke();
            g.strokeStyle = sel ? '#fcb454' : '#eaebec';
            g.lineWidth = 1;
            g.stroke();
            g.beginPath();
            g.arc(hs[0], hs[1], 3.5, 0, Math.PI * 2);
            g.fillStyle = sel ? '#fcb454' : '#eaebec';
            g.fill();
            g.strokeStyle = '#000000';
            g.stroke();
          }
        }
        g.fillStyle = p.select ? '#fa9404' : '#eaebec';
        g.strokeStyle = '#000000';
        g.lineWidth = 1;
        g.fillRect(c[0] - 3.5, c[1] - 3.5, 7, 7);
        g.strokeRect(c[0] - 3.5 + 0.5, c[1] - 3.5 + 0.5, 6, 6);
      }
    }
  }
  drawSelectShape(g, ed.shapeOverlay);
}

/** Circle / lasso / box outline while selecting. */
export function drawSelectShape(g: CanvasRenderingContext2D, sh: MaskHost['shapeOverlay']) {
  if (!sh) return;
  g.save();
  g.setLineDash([4, 3]);
  g.strokeStyle = '#ffffff';
  g.beginPath();
  if (sh.kind === 'circle') g.arc(sh.x, sh.y, sh.r, 0, Math.PI * 2);
  else sh.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  if (sh.kind === 'lasso') g.closePath();
  g.stroke();
  g.restore();
}

let matte: { key: string; canvas: HTMLCanvasElement } | null = null;

/** The rasterized mask over the frame: darkening outside it, or as the matte alone. */
export function drawMaskMatte(ed: MaskHost, g: CanvasRenderingContext2D, mode: 'NONE' | 'COMBINED' | 'ALPHACHANNEL') {
  const m = hostMask(ed);
  if (!m || mode === 'NONE') return;
  const [W, H] = ed.frameSize();
  // rasterize at most at screen resolution
  const a = ed.toScreen(0, 0),
    b = ed.toScreen(W, H);
  const sw = Math.max(16, Math.min(W, Math.round(Math.abs(b[0] - a[0]) * (devicePixelRatio || 1)))),
    sh = Math.max(16, Math.round((sw * H) / W));
  const f = app.doc.scene.frame_current;
  const res = parentResolver(app.doc);
  const key = `${maskKey(m, f, res)}|${sw}x${sh}|${mode}`;
  if (matte?.key !== key) {
    const c = matte?.canvas ?? document.createElement('canvas');
    rasterizeMask(m, f, sw, sh, true, c, res);
    if (mode === 'COMBINED') {
      // inside stays white, outside becomes half grey: multiplied over the footage
      const x = c.getContext('2d')!;
      x.globalCompositeOperation = 'screen';
      x.fillStyle = '#7f8082';
      x.fillRect(0, 0, sw, sh);
      x.globalCompositeOperation = 'source-over';
    }
    matte = { key, canvas: c };
  }
  const p0 = ed.toScreen(0, 0),
    px = ed.toScreen(W, 0),
    py = ed.toScreen(0, H);
  g.save();
  const dpr = g.getTransform().a;
  g.setTransform((dpr * (px[0] - p0[0])) / sw, (dpr * (px[1] - p0[1])) / sw, (dpr * (py[0] - p0[0])) / sh, (dpr * (py[1] - p0[1])) / sh, dpr * p0[0], dpr * p0[1]);
  if (mode === 'COMBINED') g.globalCompositeOperation = 'multiply';
  g.drawImage(matte.canvas, 0, 0);
  g.restore();
}

// ---------------------------------------------------------------------------
// hit testing (screen pixels)

type Hit = { layer: MaskLayer; spline: MaskSpline; point: MaskPoint; kind: 'point' | 'left' | 'right' } | { layer: MaskLayer; spline: MaskSpline; kind: 'segment'; seg: number; t: number };

export function hitMask(ed: MaskHost, x: number, y: number): Hit | null {
  const m = hostMask(ed);
  if (!m) return null;
  let best: Hit | null = null,
    bd = 8;
  const E = shownPoints(m);
  for (const { layer, spline, point } of allPoints(m)) {
    const sp = shown(E, point);
    const c = m2s(ed, sp.co);
    const d = Math.hypot(c[0] - x, c[1] - y);
    if (d < bd) {
      bd = d;
      best = { layer, spline, point, kind: 'point' };
    }
    if (showsHandles(point))
      for (const [side, h] of [
        ['left', sp.handle_left],
        ['right', sp.handle_right],
      ] as const) {
        const hs = m2s(ed, h);
        const dh = Math.hypot(hs[0] - x, hs[1] - y);
        if (dh < bd) {
          bd = dh;
          best = { layer, spline, point, kind: side };
        }
      }
  }
  if (best) return best;
  return hitSegment(ed, x, y, 6);
}

export function hitSegment(ed: MaskHost, x: number, y: number, radius: number, layers?: MaskLayer[]): Extract<Hit, { kind: 'segment' }> | null {
  const m = hostMask(ed);
  if (!m) return null;
  let best: Extract<Hit, { kind: 'segment' }> | null = null,
    bd = radius;
  const f = app.doc.scene.frame_current;
  const res = parentResolver(app.doc);
  for (const layer of layers ?? editableLayers(m)) {
    const L = layerAt(layer, f, res, false);
    for (const [si, spline] of layer.splines.entries()) {
      if (spline.points.length < 2) continue;
      const s = sampleSpline(L.splines[si], 24);
      for (let i = 0; i < s.length; i++) {
        const a = m2s(ed, s[i].p);
        const d = Math.hypot(a[0] - x, a[1] - y);
        if (d < bd) {
          bd = d;
          best = { layer, spline, kind: 'segment', seg: s[i].seg, t: s[i].t };
        }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// interaction

function refresh(ed: MaskHost) {
  app.changed('doc');
  ed.draw();
}

/** After moving points: automatic handles follow. */
export function updateHandles(m: MaskData, aspect: number) {
  for (const l of m.layers) for (const s of l.splines) recalcHandles(s, aspect);
}

function track(e: PointerEvent, move: (ev: PointerEvent) => void, up: (ev: PointerEvent, moved: boolean) => void) {
  const x0 = e.clientX,
    y0 = e.clientY;
  let moved = false;
  const mv = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
    moved = true;
    move(ev);
  };
  const u = (ev: PointerEvent) => {
    removeEventListener('pointermove', mv);
    removeEventListener('pointerup', u);
    up(ev, moved);
  };
  addEventListener('pointermove', mv);
  addEventListener('pointerup', u);
}

/** Pointer press in mask mode. Returns true when handled. */
export function maskPointerDown(ed: MaskHost, e: PointerEvent): boolean {
  const m = hostMask(ed);
  if (!m || e.button !== 0) return false;
  const p = ed.local(e);
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.altKey) return lassoSelect(ed, m, e, e.shiftKey ? 'SUB' : 'ADD');
  if (ctrl && e.shiftKey) return addFeather(ed, m, e);
  if (ctrl) return addVertex(ed, m, e);
  const hit = hitMask(ed, p.x, p.y);
  if (!hit) {
    boxOrDeselect(ed, m, e);
    return true;
  }
  if (hit.kind === 'segment') {
    // press on a curve: select the spline; dragging bends the segment
    if (!e.shiftKey) deselectAll(m);
    for (const q of hit.spline.points) q.select = true;
    hit.layer.active_spline = hit.layer.splines.indexOf(hit.spline);
    m.active_layer_index = m.layers.indexOf(hit.layer);
    refresh(ed);
    ed.drawUI();
    slideCurvature(ed, m, hit, e);
    return true;
  }
  const pt = hit.point;
  if (hit.kind === 'point') {
    if (e.shiftKey && pt.select) {
      pt.select = false;
      refresh(ed);
      app.pushUndo('Select');
      return true;
    }
    if (!pt.select && !e.shiftKey) deselectAll(m);
    pt.select = true;
    pt.select_left_handle = pt.select_right_handle = false;
  } else {
    if (!e.shiftKey) for (const x of allPoints(m)) x.point.select_left_handle = x.point.select_right_handle = false;
    if (hit.kind === 'left') pt.select_left_handle = true;
    else pt.select_right_handle = true;
  }
  hit.layer.active_spline = hit.layer.splines.indexOf(hit.spline);
  m.active_layer_index = m.layers.indexOf(hit.layer);
  refresh(ed);
  ed.drawUI();
  slidePoints(ed, m, e, hit.kind === 'point' ? null : { point: pt, side: hit.kind === 'left' ? 'LEFT' : 'RIGHT' });
  return true;
}

function snapshot(m: MaskData) {
  return JSON.stringify(m.layers);
}
function restore(m: MaskData, s: string) {
  m.layers = JSON.parse(s);
}

/** Drag selected points (or one handle). */
function slidePoints(ed: MaskHost, m: MaskData, e: PointerEvent, handle: { point: MaskPoint; side: 'LEFT' | 'RIGHT' } | null) {
  const aspect = aspectOf(ed);
  const p0 = ed.local(e);
  const a0 = s2m(ed, p0.x, p0.y);
  const sel = selectedPoints(m).map((x) => x.point);
  const orig = new Map(sel.map((q) => [q, { co: [...q.co] as V, hl: [...q.handle_left] as V, hr: [...q.handle_right] as V }]));
  const origH = handle ? { hl: [...handle.point.handle_left] as V, hr: [...handle.point.handle_right] as V, type: handle.point.handle_type } : null;
  track(
    e,
    (ev) => {
      const q = ed.local(ev);
      const a = s2m(ed, q.x, q.y);
      const k = ev.shiftKey ? 0.2 : 1;
      const d: V = [(a[0] - a0[0]) * k, (a[1] - a0[1]) * k];
      if (handle && origH) {
        const P = handle.point;
        // grabbing a handle of an automatic point makes it aligned
        if (P.handle_type === 'AUTO' || P.handle_type === 'VECTOR') P.handle_type = 'ALIGNED';
        if (handle.side === 'LEFT') P.handle_left = [origH.hl[0] + d[0], origH.hl[1] + d[1]];
        else P.handle_right = [origH.hr[0] + d[0], origH.hr[1] + d[1]];
        alignHandles(P, handle.side, aspect);
      } else
        for (const [q2, o] of orig) {
          q2.co = [o.co[0] + d[0], o.co[1] + d[1]];
          q2.handle_left = [o.hl[0] + d[0], o.hl[1] + d[1]];
          q2.handle_right = [o.hr[0] + d[0], o.hr[1] + d[1]];
        }
      updateHandles(m, aspect);
      refresh(ed);
    },
    (_ev, moved) => app.pushUndo(moved ? (handle ? 'Slide Handle' : 'Slide Point') : 'Select'),
  );
}

/** Drag on a segment: both adjacent handles move to bend the curve through the pointer. */
function slideCurvature(ed: MaskHost, m: MaskData, hit: Extract<Hit, { kind: 'segment' }>, e: PointerEvent) {
  const aspect = aspectOf(ed);
  const sp = hit.spline;
  const a = sp.points[hit.seg],
    b = sp.points[(hit.seg + 1) % sp.points.length];
  const o = { ar: [...a.handle_right] as V, bl: [...b.handle_left] as V, at: a.handle_type, bt: b.handle_type };
  const p0 = ed.local(e);
  const m0 = s2m(ed, p0.x, p0.y);
  const t = Math.min(0.9, Math.max(0.1, hit.t));
  track(
    e,
    (ev) => {
      const q = ed.local(ev);
      const mm = s2m(ed, q.x, q.y);
      const d: V = [mm[0] - m0[0], mm[1] - m0[1]];
      // move the handles so the curve at t follows the pointer
      const wa = 3 * (1 - t) * (1 - t) * t,
        wb = 3 * (1 - t) * t * t;
      const k = 1 / (wa * wa + wb * wb);
      for (const [p, side] of [
        [a, 'RIGHT'],
        [b, 'LEFT'],
      ] as const)
        if (p.handle_type === 'AUTO' || p.handle_type === 'VECTOR') p.handle_type = 'ALIGNED';
      a.handle_right = [o.ar[0] + d[0] * wa * k, o.ar[1] + d[1] * wa * k];
      b.handle_left = [o.bl[0] + d[0] * wb * k, o.bl[1] + d[1] * wb * k];
      alignHandles(a, 'RIGHT', aspect);
      alignHandles(b, 'LEFT', aspect);
      refresh(ed);
    },
    (_ev, moved) => {
      if (!moved) {
        a.handle_type = o.at;
        b.handle_type = o.bt;
      }
      app.pushUndo(moved ? 'Slide Spline Curvature' : 'Select');
    },
  );
}

/** Ctrl click: insert on a curve, extend an open spline from its selected end, or start a spline. */
function addVertex(ed: MaskHost, m: MaskData, e: PointerEvent): boolean {
  const aspect = aspectOf(ed);
  let layer = activeLayer(m);
  if (!layer) return false;
  if (layer.hide || layer.hide_select) {
    app.report('WARNING', 'The active mask layer is hidden or locked');
    return true;
  }
  const p = ed.local(e);
  const at = s2m(ed, p.x, p.y);
  const seg = hitSegment(ed, p.x, p.y, 6, [layer]);
  let pt: MaskPoint;
  if (seg) {
    pt = insertPoint(seg.spline, seg.seg, seg.t);
    layer.active_spline = layer.splines.indexOf(seg.spline);
  } else {
    let sp = layer.splines[layer.active_spline];
    const ends = sp && !sp.use_cyclic && sp.points.length ? [...new Set([sp.points[0], sp.points[sp.points.length - 1]])] : [];
    const sel = ends.filter((q) => q.select);
    pt = newPoint(at[0], at[1], 'AUTO');
    if (sp && sel.length === 1 && ends.length) {
      if (sel[0] === sp.points[0] && sp.points.length > 1) sp.points.unshift(pt);
      else sp.points.push(pt);
    } else {
      sp = { points: [pt], use_cyclic: false, use_fill: true };
      layer.splines.push(sp);
      layer.active_spline = layer.splines.length - 1;
    }
    recalcHandles(sp, aspect);
  }
  deselectAll(m);
  pt.select = true;
  refresh(ed);
  ed.drawUI();
  layer = activeLayer(m)!;
  // keep sliding the new point while the button is held
  slidePoints(ed, m, e, null);
  return true;
}

/** Shift Ctrl drag: set the feather width of the nearest point by the drag distance. */
function addFeather(ed: MaskHost, m: MaskData, e: PointerEvent): boolean {
  const p = ed.local(e);
  let best: MaskPoint | null = null,
    bd = Infinity;
  const E = shownPoints(m);
  for (const { point } of allPoints(m)) {
    const c = m2s(ed, shown(E, point).co);
    const d = Math.hypot(c[0] - p.x, c[1] - p.y);
    if (d < bd) {
      bd = d;
      best = point;
    }
  }
  if (!best) return true;
  const P = best;
  const set = (ev: { clientX: number; clientY: number }) => {
    const q = ed.local(ev);
    const a = s2m(ed, q.x, q.y);
    const aspect = aspectOf(ed);
    const co = shown(shownPoints(m), P).co;
    P.weight = Math.hypot((a[0] - co[0]) * aspect, a[1] - co[1]) / aspect;
    refresh(ed);
  };
  set(e);
  track(e, set, () => app.pushUndo('Add Feather'));
  return true;
}

/** Ctrl Alt drag: lasso selection of points. */
function lassoSelect(ed: MaskHost, m: MaskData, e: PointerEvent, mode: 'ADD' | 'SUB'): boolean {
  const p0 = ed.local(e);
  const pts: V[] = [[p0.x, p0.y]];
  track(
    e,
    (ev) => {
      const q = ed.local(ev);
      pts.push([q.x, q.y]);
      ed.shapeOverlay = { kind: 'lasso', pts };
      ed.draw();
    },
    (_ev, moved) => {
      ed.shapeOverlay = null;
      if (moved && pts.length > 2) selectWhere(ed, m, (x, y) => inPolygon(x, y, pts), mode);
      refresh(ed);
      ed.drawUI();
      app.pushUndo('Lasso Select');
    },
  );
  return true;
}

function inPolygon(x: number, y: number, poly: V[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i],
      [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

/** Click on empty space deselects; dragging draws a selection box. */
function boxOrDeselect(ed: MaskHost, m: MaskData, e: PointerEvent) {
  const p0 = ed.local(e);
  track(
    e,
    (ev) => {
      const q = ed.local(ev);
      ed.shapeOverlay = { kind: 'lasso', pts: [[p0.x, p0.y], [q.x, p0.y], [q.x, q.y], [p0.x, q.y]] };
      ed.draw();
    },
    (ev, moved) => {
      ed.shapeOverlay = null;
      if (!moved) {
        if (!e.shiftKey) deselectAll(m);
      } else {
        const q = ed.local(ev);
        selectInRect(ed, m, Math.min(p0.x, q.x), Math.min(p0.y, q.y), Math.max(p0.x, q.x), Math.max(p0.y, q.y), e.shiftKey ? 'ADD' : e.ctrlKey || e.metaKey ? 'SUB' : 'SET');
      }
      refresh(ed);
      ed.drawUI();
      app.pushUndo(moved ? 'Box Select' : 'Select');
    },
  );
}

export function selectInRect(ed: MaskHost, m: MaskData, x0: number, y0: number, x1: number, y1: number, mode: 'SET' | 'ADD' | 'SUB') {
  selectWhere(ed, m, (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1, mode);
}

/** (De)select points whose screen position passes a test. */
export function selectWhere(ed: MaskHost, m: MaskData, test: (x: number, y: number) => boolean, mode: 'SET' | 'ADD' | 'SUB') {
  if (mode === 'SET') deselectAll(m);
  const E = shownPoints(m);
  for (const { point } of allPoints(m)) {
    const [x, y] = m2s(ed, shown(E, point).co);
    if (test(x, y)) point.select = mode !== 'SUB';
  }
}
