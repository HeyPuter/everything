// Edit Mode for Grease Pencil: point / stroke selection, transforms (G/R/S through the transform
// operator), delete / dissolve, duplicate, join, subdivide, smooth, simplify, set material,
// cyclic toggle, caps, switch direction, uniform thickness / opacity, move to layer.
import { Matrix3, Matrix4, Vector3, Box3, Scene, Points, PointsMaterial, BufferGeometry, Float32BufferAttribute, LineSegments, LineBasicMaterial } from 'three';
import { app, registerOperators } from '../app/app';
import { editModeHooks, viewportExtensions } from '../editors/view3d/hooks';
import { transformProviders, type TElement } from '../ops/transform';
import { falloffWeight, seededRandom } from '../ops/transform_math';
import { gpOverlay } from './overlays';
import { setGizmoCenterHook, gizmoCenterHook } from '../editors/view3d/gizmo';
import { frameHooks } from '../ops/view3d';
import { renderContext } from '../render/context';
import { gpOf, gpTS, toStrokes, fromStrokes, frameAt, normalizeDrawing, uniqueLayerName, newLayer, setKeyframe, emptyDrawing, type GPStroke } from './data';
import { layerMatrix } from './render';
import { evaluatedDrawing, hasBezier, withDerived, H_ALIGN, H_AUTO, H_FREE, H_VECTOR } from './curves';
import { smoothPoints, subdivideStroke, joinStrokes, filterPoints, simplifyPoints } from './strokeops';
import type { GPDrawing, GPLayer, GreasePencilData } from './types';
import type { ObjectData } from '../data/types';

export const inGPEdit = () => app.doc.mode === 'EDIT' && !!gpOf(app.doc, app.activeObject);

function ctx(): { ob: ObjectData; gp: GreasePencilData } | null {
  const ob = app.activeObject;
  const gp = gpOf(app.doc, ob);
  return ob && gp ? { ob, gp } : null;
}

export interface EditTarget {
  layer: GPLayer;
  layerIndex: number;
  /** drawing index */
  idx: number;
  world: Matrix4;
}

/** Drawings editable in Edit Mode: the active keyframe of each visible, unlocked layer (plus selected keyframes with multi-frame editing). */
export function editTargets(): EditTarget[] {
  const c = ctx();
  if (!c) return [];
  const frame = app.doc.scene.frame_current;
  const multi = gpTS(app.doc).use_grease_pencil_multi_frame_editing;
  const obWorld = app.graph.get(c.ob.id)?.world ?? new Matrix4();
  const out: EditTarget[] = [];
  c.gp.layers.forEach((layer, li) => {
    if (layer.hide || layer.lock) return;
    const world = obWorld.clone().multiply(layerMatrix(layer));
    const seen = new Set<number>();
    const cur = frameAt(layer, frame);
    if (cur) seen.add(cur.drawing);
    if (multi) for (const f of layer.frames) if (f.select) seen.add(f.drawing);
    for (const idx of seen) if (c.gp.drawings[idx]) out.push({ layer, layerIndex: li, idx, world });
  });
  return out;
}

export const drawing = (t: EditTarget) => normalizeDrawing(ctx()!.gp.drawings[t.idx]);
export const setDrawing = (t: EditTarget, d: GPDrawing) => (ctx()!.gp.drawings[t.idx] = d);

export function strokeOfPoint(d: GPDrawing, i: number) {
  let lo = 0,
    hi = d.offsets.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (d.offsets[mid] <= i) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export const strokeMode = () => gpTS(app.doc).gpencil_selectmode_edit === 'STROKE';

/** In stroke selection mode a stroke is selected as a whole. */
export function expandToStrokes(d: GPDrawing) {
  const sel = d.select!;
  for (let s = 0; s + 1 < d.offsets.length; s++) {
    let any = false;
    for (let i = d.offsets[s]; i < d.offsets[s + 1]; i++) if (sel[i]) any = true;
    if (any) sel.fill(1, d.offsets[s], d.offsets[s + 1]);
  }
}

function commitSelection(label: string) {
  app.pushUndo(label);
  app.changed('select', 'doc');
}

export function withSelection(t: EditTarget, fn: (sel: Uint8Array, d: GPDrawing) => void) {
  const d = drawing(t);
  const sel = d.select!.slice();
  const nd = { ...d, select: sel };
  fn(sel, nd);
  setDrawing(t, nd);
}

// ---------------------------------------------------------------------------
// picking / box selection

const tmp = new Vector3();

editModeHooks.pick.unshift((v, x, y, o) => {
  if (!inGPEdit()) return false;
  let best: { t: EditTarget; i: number } | null = null,
    bd = 14;
  const targets = editTargets();
  for (const t of targets) {
    const d = drawing(t);
    for (let i = 0; i < d.position.length / 3; i++) {
      tmp.set(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]).applyMatrix4(t.world);
      const s = v.project(tmp);
      const dd = Math.hypot(s.x - x, s.y - y);
      if (dd < bd) {
        bd = dd;
        best = { t, i };
      }
    }
  }
  if (!o.extend && !o.toggle && !o.deselect) for (const t of targets) withSelection(t, (sel) => sel.fill(0));
  if (best) {
    withSelection(best.t, (sel, d) => {
      const s = strokeOfPoint(d, best!.i);
      const range: [number, number] = strokeMode()
        ? [d.offsets[s], d.offsets[s + 1]]
        : gpTS(app.doc).gpencil_selectmode_edit === 'SEGMENT'
          ? segmentRange(v, targets, best!.t, d, s, best!.i)
          : [best!.i, best!.i + 1];
      const on = o.deselect ? 0 : o.toggle && sel[best!.i] ? 0 : 1;
      sel.fill(on, range[0], range[1]);
    });
  }
  commitSelection('Select');
  return true;
});

editModeHooks.box.unshift((v, x0, y0, x1, y1, mode) => {
  if (!inGPEdit()) return false;
  const [lx, hx, ly, hy] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
  for (const t of editTargets())
    withSelection(t, (sel, d) => {
      const hit = new Uint8Array(sel.length);
      for (let i = 0; i < sel.length; i++) {
        tmp.set(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]).applyMatrix4(t.world);
        const s = v.project(tmp);
        hit[i] = s.x >= lx && s.x <= hx && s.y >= ly && s.y <= hy ? 1 : 0;
      }
      if (strokeMode()) {
        const tmpD = { ...d, select: hit };
        expandToStrokes(tmpD);
      }
      for (let i = 0; i < sel.length; i++) {
        const cur = sel[i],
          ht = hit[i];
        sel[i] = mode === 'SET' ? ht : mode === 'ADD' ? cur | ht : mode === 'SUB' ? cur & (ht ^ 1) : mode === 'AND' ? cur & ht : cur ^ ht;
      }
    });
  commitSelection('Box Select');
  return true;
});

editModeHooks.region.unshift((v, r, mode) => {
  if (!inGPEdit()) return false;
  const inside =
    r.kind === 'circle'
      ? (x: number, y: number) => Math.hypot(x - r.x, y - r.y) <= r.r
      : (x: number, y: number) => {
          // even-odd test against the lasso polygon
          let c = false;
          const P = r.kind === 'lasso' ? r.pts : [];
          for (let i = 0, j = P.length - 1; i < P.length; j = i++)
            if (P[i].y > y !== P[j].y > y && x < ((P[j].x - P[i].x) * (y - P[i].y)) / (P[j].y - P[i].y) + P[i].x) c = !c;
          return r.kind === 'box' ? x >= Math.min(r.x0, r.x1) && x <= Math.max(r.x0, r.x1) && y >= Math.min(r.y0, r.y1) && y <= Math.max(r.y0, r.y1) : c;
        };
  for (const t of editTargets())
    withSelection(t, (sel, d) => {
      const hit = new Uint8Array(sel.length);
      for (let i = 0; i < sel.length; i++) {
        tmp.set(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]).applyMatrix4(t.world);
        const s = v.project(tmp);
        hit[i] = inside(s.x, s.y) ? 1 : 0;
      }
      if (strokeMode()) expandToStrokes({ ...d, select: hit });
      for (let i = 0; i < sel.length; i++) {
        const cur = sel[i],
          ht = hit[i];
        sel[i] = mode === 'SET' ? ht : mode === 'ADD' ? cur | ht : mode === 'SUB' ? cur & (ht ^ 1) : mode === 'AND' ? cur & ht : cur ^ ht;
      }
    });
  commitSelection(r.kind === 'circle' ? 'Circle Select' : 'Lasso Select');
  return true;
});

/** 2D segment intersection parameter along a→b, or null. */
function segHit(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number | null {
  const rx = bx - ax,
    ry = by - ay,
    sx = dx - cx,
    sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den,
    u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/** Point range of stroke `s` around point `pi` bounded by the nearest crossings with other strokes (screen space). */
function segmentRange(v: Parameters<(typeof editModeHooks.pick)[number]>[0], targets: EditTarget[], tgt: EditTarget, d: GPDrawing, s: number, pi: number): [number, number] {
  const a = d.offsets[s],
    b = d.offsets[s + 1];
  const scr = (t: EditTarget, dd: GPDrawing, i: number) => {
    tmp.set(dd.position[i * 3], dd.position[i * 3 + 1], dd.position[i * 3 + 2]).applyMatrix4(t.world);
    return v.project(tmp);
  };
  const own = Array.from({ length: b - a }, (_, k) => scr(tgt, d, a + k));
  // crossings per segment index of this stroke (k → between point a+k and a+k+1)
  const cut = new Set<number>();
  for (const t of targets) {
    const od = drawing(t);
    for (let os = 0; os + 1 < od.offsets.length; os++) {
      if (t === tgt && os === s) continue;
      const pts = Array.from({ length: od.offsets[os + 1] - od.offsets[os] }, (_, k) => scr(t, od, od.offsets[os] + k));
      for (let k = 0; k + 1 < own.length; k++)
        for (let m = 0; m + 1 < pts.length; m++) if (segHit(own[k].x, own[k].y, own[k + 1].x, own[k + 1].y, pts[m].x, pts[m].y, pts[m + 1].x, pts[m + 1].y) !== null) cut.add(k);
    }
  }
  let lo = pi - a,
    hi = pi - a;
  while (lo > 0 && !cut.has(lo - 1)) lo--;
  while (hi < own.length - 1 && !cut.has(hi)) hi++;
  return [a + lo, a + hi + 1];
}

// ---------------------------------------------------------------------------
// overlay: points (selected = orange) and thin edit lines

const ovScene = new Scene();
const ptsGeo = new BufferGeometry();
const pts = new Points(
  ptsGeo,
  new PointsMaterial({
    size: 5,
    sizeAttenuation: false,
    vertexColors: true,
    depthTest: false,
    transparent: true,
  }),
);
const linesGeo = new BufferGeometry();
const lines = new LineSegments(
  linesGeo,
  new LineBasicMaterial({
    color: 0xf58e04,
    depthTest: false,
    transparent: true,
    opacity: 0.8,
  }),
);
const dimGeo = new BufferGeometry();
// edit lines of the unselected strokes
const dimLines = new LineSegments(dimGeo, new LineBasicMaterial({ color: 0x9a9b9c, depthTest: false, transparent: true, opacity: 0.5 }));
pts.frustumCulled = lines.frustumCulled = dimLines.frustumCulled = false;
pts.renderOrder = 2;
ovScene.add(dimLines, lines, pts);
let ovKey = '';

function rebuildOverlay(allLines: boolean) {
  const pos: number[] = [],
    col: number[] = [],
    seg: number[] = [],
    dim: number[] = [];
  const v = new Vector3(),
    w = new Vector3();
  for (const t of editTargets()) {
    const d = drawing(t);
    // smooth strokes show their edit line along the evaluated curve
    const ev = evaluatedDrawing(d);
    for (let s = 0; s + 1 < d.offsets.length; s++) {
      const a = d.offsets[s],
        b = d.offsets[s + 1];
      let anySel = false;
      for (let i = a; i < b; i++) if (d.select![i] || d.select_handle_left?.[i] || d.select_handle_right?.[i]) anySel = true;
      for (let i = a; i < b; i++) {
        v.set(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]).applyMatrix4(t.world);
        // in stroke mode only selected strokes show their points
        if (!strokeMode() || anySel) {
          pos.push(v.x, v.y, v.z);
          if (d.select![i]) col.push(1, 0.52, 0);
          else col.push(0.05, 0.05, 0.05);
        }
      }
      if (!anySel && !allLines) continue;
      const L = ev === d ? d : ev;
      const ea = L.offsets[s],
        eb = L.offsets[s + 1];
      const closed = !!d.cyclic[s] && eb - ea > 2;
      for (let i = ea; i < eb; i++) {
        const j = i + 1 < eb ? i + 1 : closed ? ea : -1;
        if (j < 0) break;
        v.set(L.position[i * 3], L.position[i * 3 + 1], L.position[i * 3 + 2]).applyMatrix4(t.world);
        w.set(L.position[j * 3], L.position[j * 3 + 1], L.position[j * 3 + 2]).applyMatrix4(t.world);
        (anySel ? seg : dim).push(v.x, v.y, v.z, w.x, w.y, w.z);
      }
    }
  }
  ptsGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  ptsGeo.setAttribute('color', new Float32BufferAttribute(col, 3));
  linesGeo.setAttribute('position', new Float32BufferAttribute(seg, 3));
  dimGeo.setAttribute('position', new Float32BufferAttribute(dim, 3));
}

viewportExtensions.push((v) => {
  const fn = (_s: unknown, camera: import('three').Camera) => {
    if (!inGPEdit() || !v.overlay.show_overlays) return;
    const o = gpOverlay(v);
    const allLines = o.use_gpencil_edit_lines !== false && (!o.use_gpencil_multiedit_line_only || gpTS(app.doc).use_grease_pencil_multi_frame_editing);
    const key = `${app.revision}|${app.doc.scene.frame_current}|${allLines}`;
    if (key !== ovKey) {
      ovKey = key;
      rebuildOverlay(allLines);
    }
    (pts.material as PointsMaterial).opacity = o.vertex_opacity;
    renderContext?.engine.renderer.render(ovScene, camera);
  };
  v.extraOverlays.push(fn);
  return () => {
    const i = v.extraOverlays.indexOf(fn);
    if (i >= 0) v.extraOverlays.splice(i, 1);
  };
});

// ---------------------------------------------------------------------------
// transforms

export function selectedWorld(): Vector3[] {
  const out: Vector3[] = [];
  for (const t of editTargets()) {
    const d = drawing(t);
    for (let i = 0; i < d.select!.length; i++) if (d.select![i]) out.push(new Vector3(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]).applyMatrix4(t.world));
  }
  return out;
}

transformProviders.unshift({
  collect({ proportional, connected }) {
    if (!inGPEdit()) return null;
    const els: TElement[] = [];
    // proportional editing: unselected points near the selection follow with a falloff
    const pts = proportional ? proportionalWeights(connected) : null;
    const restores: (() => void)[] = [];
    const live: { t: EditTarget; d: GPDrawing }[] = [];
    const scaleThickness = (gpTS(app.doc) as unknown as { use_scale_thickness?: boolean }).use_scale_thickness !== false;
    for (const t of editTargets()) {
      const d0 = drawing(t);
      const bez = hasBezier(d0);
      const handleSel = bez && (d0.select_handle_left!.some((x) => x) || d0.select_handle_right!.some((x) => x));
      if (!d0.select!.some((x) => x) && !handleSel && !pts?.get(t.idx)?.some((x) => x > 0)) continue;
      const before = d0.position;
      const rBefore = d0.radius;
      const hl0 = d0.handle_left,
        hr0 = d0.handle_right,
        tl0 = d0.handle_type_left,
        tr0 = d0.handle_type_right;
      const d: GPDrawing = { ...d0, position: d0.position.slice(), radius: d0.radius.slice() };
      if (bez) Object.assign(d, { handle_left: hl0!.slice(), handle_right: hr0!.slice(), handle_type_left: tl0!.slice(), handle_type_right: tr0!.slice() });
      setDrawing(t, d);
      live.push({ t, d });
      restores.push(() => setDrawing(t, { ...d, position: before, radius: rBefore, ...(bez ? { handle_left: hl0, handle_right: hr0, handle_type_left: tl0, handle_type_right: tr0 } : {}) }));
      const inv = t.world.clone().invert();
      const basis = new Matrix3().setFromMatrix4(t.world);
      const pw = pts?.get(t.idx);
      const W = (a: Float32Array, i: number) => new Vector3(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]).applyMatrix4(t.world);
      const put = (a: Float32Array, i: number, q: Vector3) => {
        a[i * 3] = q.x;
        a[i * 3 + 1] = q.y;
        a[i * 3 + 2] = q.z;
      };
      const restoreTo = (a: Float32Array, b: Float32Array, i: number) => a.set(b.subarray(i * 3, i * 3 + 3), i * 3);
      for (let i = 0; i < d.select!.length; i++) {
        const w = d.select![i] ? 1 : (pw?.[i] ?? 0);
        const q = new Vector3();
        if (w <= 0) {
          // handles moved on their own (their point stays)
          if (!bez) continue;
          for (const side of ['L', 'R'] as const) {
            const sel = side === 'L' ? d.select_handle_left! : d.select_handle_right!;
            if (!sel[i]) continue;
            const arr = side === 'L' ? d.handle_left! : d.handle_right!,
              src = side === 'L' ? hl0! : hr0!;
            const other = side === 'L' ? d.handle_right! : d.handle_left!,
              otherSrc = side === 'L' ? hr0! : hl0!;
            const tOwn = side === 'L' ? d.handle_type_left! : d.handle_type_right!,
              tOther = side === 'L' ? d.handle_type_right! : d.handle_type_left!;
            const own0 = (side === 'L' ? tl0! : tr0!)[i],
              oth0 = (side === 'L' ? tr0! : tl0!)[i];
            const h0 = W(src, i);
            els.push({
              center: h0,
              basis,
              weight: 1,
              apply(m: Matrix4) {
                q.copy(h0).applyMatrix4(m).applyMatrix4(inv);
                put(arr, i, q);
                // moving a derived handle makes it editable: auto → aligned, vector → free
                if (own0 === H_AUTO) {
                  tOwn[i] = H_ALIGN;
                  if (oth0 === H_AUTO) tOther[i] = H_ALIGN;
                } else if (own0 === H_VECTOR) tOwn[i] = H_FREE;
                // aligned pair: the other handle turns to stay opposite (keeping its length)
                if (tOwn[i] === H_ALIGN && tOther[i] === H_ALIGN) {
                  const p = new Vector3(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]);
                  const dir = p.clone().sub(q);
                  const l = new Vector3(otherSrc[i * 3], otherSrc[i * 3 + 1], otherSrc[i * 3 + 2]).distanceTo(p);
                  if (dir.lengthSq() > 1e-18) put(other, i, p.add(dir.normalize().multiplyScalar(l)));
                }
              },
              restore() {
                restoreTo(arr, src, i);
                restoreTo(other, otherSrc, i);
                tOwn[i] = own0;
                tOther[i] = oth0;
              },
            });
          }
          continue;
        }
        const p0 = W(before, i);
        const hl = bez ? W(hl0!, i) : null,
          hr = bez ? W(hr0!, i) : null;
        els.push({
          center: p0,
          basis,
          weight: w,
          apply(m: Matrix4, c: { mode: string }) {
            q.copy(p0).applyMatrix4(m).applyMatrix4(inv);
            put(d.position, i, q);
            // handles travel with their point
            if (hl && hr) {
              put(d.handle_left!, i, q.copy(hl).applyMatrix4(m).applyMatrix4(inv));
              put(d.handle_right!, i, q.copy(hr).applyMatrix4(m).applyMatrix4(inv));
            }
            // Scale Thickness: scaling also scales the stroke radius
            if (c.mode === 'RESIZE' && scaleThickness) d.radius[i] = rBefore[i] * Math.cbrt(Math.abs(m.determinant()));
          },
          restore() {
            restoreTo(d.position, before, i);
            d.radius[i] = rBefore[i];
            if (hl) {
              restoreTo(d.handle_left!, hl0!, i);
              restoreTo(d.handle_right!, hr0!, i);
            }
          },
        });
      }
    }
    if (!els.length) return null;
    const bump = () => {
      // the elements write into private arrays; publish a copy (new identity → GPU rebuild);
      // auto / vector handles follow the moved points
      for (const { t, d } of live)
        setDrawing(
          t,
          withDerived({
            ...d,
            position: d.position.slice(),
            radius: d.radius.slice(),
            ...(d.handle_type_left ? { handle_type_left: d.handle_type_left.slice(), handle_type_right: d.handle_type_right!.slice() } : {}),
          }),
        );
    };
    return {
      elements: els,
      label: 'Grease Pencil',
      finish: bump,
      cancel: () => restores.forEach((f) => f()),
      onUpdate: () => {
        bump();
        app.changed('doc');
      },
    };
  },
});

/** Falloff weights of unselected points for proportional editing (per edit target). */
function proportionalWeights(connected: boolean): Map<number, Float32Array> {
  const ts = app.doc.scene.tool_settings;
  const radius = Math.max(1e-6, ts.proportional_size);
  const rand = seededRandom(1);
  const out = new Map<number, Float32Array>();
  const targets = editTargets();
  const world = (t: EditTarget, d: GPDrawing, i: number) => new Vector3(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]).applyMatrix4(t.world);
  const selected: Vector3[] = [];
  if (!connected) for (const t of targets) {
    const d = drawing(t);
    for (let i = 0; i < d.select!.length; i++) if (d.select![i]) selected.push(world(t, d, i));
  }
  for (const t of targets) {
    const d = drawing(t);
    const n = d.select!.length;
    const dist = new Float32Array(n).fill(Infinity);
    if (connected) {
      // along each stroke, from the nearest selected point
      for (let s = 0; s + 1 < d.offsets.length; s++) {
        const a = d.offsets[s],
          b = d.offsets[s + 1];
        for (const dir of [1, -1]) {
          let acc = Infinity;
          for (let k = dir > 0 ? a : b - 1; dir > 0 ? k < b : k >= a; k += dir) {
            if (d.select![k]) acc = 0;
            else if (acc < Infinity) acc += world(t, d, k).distanceTo(world(t, d, k - dir));
            dist[k] = Math.min(dist[k], acc);
          }
        }
      }
    } else
      for (let i = 0; i < n; i++) {
        if (d.select![i]) continue;
        const p = world(t, d, i);
        for (const q of selected) dist[i] = Math.min(dist[i], p.distanceTo(q));
      }
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) if (!d.select![i] && dist[i] < radius) w[i] = falloffWeight(ts.proportional_edit_falloff, dist[i] / radius, rand);
    out.set(t.idx, w);
  }
  return out;
}

const prevGizmo = gizmoCenterHook;
setGizmoCenterHook(() => {
  if (inGPEdit()) {
    const p = selectedWorld();
    if (!p.length) return null;
    const c = new Vector3();
    p.forEach((x) => c.add(x));
    return { center: c.multiplyScalar(1 / p.length) };
  }
  return prevGizmo?.() ?? null;
});

frameHooks.unshift(() => {
  if (!inGPEdit()) return null;
  const p = selectedWorld();
  return p.length ? new Box3().setFromPoints(p) : null;
});

// ---------------------------------------------------------------------------
// operators

const poll = () => inGPEdit();

/** Apply a stroke-list transform to every edit target; returns false when nothing changed. */
export function mapStrokes(fn: (strokes: GPStroke[], t: EditTarget) => GPStroke[] | null): boolean {
  let changed = false;
  for (const t of editTargets()) {
    const out = fn(toStrokes(drawing(t)), t);
    if (out) {
      setDrawing(t, fromStrokes(out));
      changed = true;
    }
  }
  return changed;
}

export const anySel = (s: GPStroke) => s.points.some((p) => p.select);
export const allSel = (s: GPStroke) => s.points.every((p) => p.select);

registerOperators([
  {
    idname: 'grease_pencil.select_all',
    label: '(De)select All Strokes',
    props: [
      {
        id: 'action',
        label: 'Action',
        type: 'enum',
        default: 'TOGGLE',
        items: [
          ['TOGGLE', 'Toggle'],
          ['SELECT', 'Select'],
          ['DESELECT', 'Deselect'],
          ['INVERT', 'Invert'],
        ],
      },
    ],
    poll,
    exec: (_c, p) => {
      const ts = editTargets();
      let a = p.action as string;
      if (a === 'TOGGLE') a = ts.some((t) => drawing(t).select!.some((x) => x)) ? 'DESELECT' : 'SELECT';
      for (const t of ts)
        withSelection(t, (sel, d) => {
          for (let i = 0; i < sel.length; i++) sel[i] = a === 'SELECT' ? 1 : a === 'DESELECT' ? 0 : sel[i] ^ 1;
          if (a === 'INVERT' && strokeMode()) expandToStrokes(d);
          // handles count as part of their point here
          if (d.select_handle_left) {
            d.select_handle_left = new Uint8Array(sel.length);
            d.select_handle_right = new Uint8Array(sel.length);
          }
        });
      app.changed('select');
    },
    redo: false,
  },
  {
    idname: 'grease_pencil.select_linked',
    label: 'Select Linked',
    description: 'Select all points of strokes with a selected point',
    poll,
    exec: () => {
      for (const t of editTargets()) withSelection(t, (_s, d) => expandToStrokes(d));
    },
  },
  {
    idname: 'grease_pencil.select_more',
    label: 'Select More',
    poll,
    exec: () => {
      for (const t of editTargets())
        withSelection(t, (sel, d) => {
          const src = sel.slice();
          for (let s = 0; s + 1 < d.offsets.length; s++)
            for (let i = d.offsets[s]; i < d.offsets[s + 1]; i++) if ((i > d.offsets[s] && src[i - 1]) || (i + 1 < d.offsets[s + 1] && src[i + 1])) sel[i] = 1;
        });
    },
  },
  {
    idname: 'grease_pencil.select_less',
    label: 'Select Less',
    poll,
    exec: () => {
      for (const t of editTargets())
        withSelection(t, (sel, d) => {
          const src = sel.slice();
          for (let s = 0; s + 1 < d.offsets.length; s++)
            for (let i = d.offsets[s]; i < d.offsets[s + 1]; i++) if ((i > d.offsets[s] && !src[i - 1]) || (i + 1 < d.offsets[s + 1] && !src[i + 1])) sel[i] = 0;
        });
    },
  },
  {
    idname: 'grease_pencil.set_selection_mode',
    label: 'Select Mode',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'POINT',
        items: [
          ['POINT', 'Point', 'Select individual points'],
          ['STROKE', 'Stroke', 'Select whole strokes'],
          ['SEGMENT', 'Segment', 'Select the part of a stroke between its crossings with other strokes'],
        ],
      },
    ],
    poll,
    exec: (_c, p) => {
      gpTS(app.doc).gpencil_selectmode_edit = p.mode as 'POINT';
      if (p.mode === 'STROKE') for (const t of editTargets()) withSelection(t, (_s, d) => expandToStrokes(d));
    },
    redo: false,
  },
  {
    idname: 'grease_pencil.delete',
    label: 'Delete',
    description: 'Delete selected points (strokes are split where points are removed)',
    poll,
    exec: () => {
      if (!mapStrokes((ss) => (ss.some(anySel) ? ss.flatMap((s) => filterPoints(s, (pt) => !pt.select)) : null))) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.dissolve',
    label: 'Dissolve',
    description: 'Remove selected points without splitting strokes',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'POINTS',
        items: [
          ['POINTS', 'Dissolve'],
          ['UNSELECT', 'Dissolve Unselected'],
        ],
      },
    ],
    poll,
    exec: (_c, p) => {
      const keep = (sel: boolean | undefined) => (p.type === 'UNSELECT' ? !!sel : !sel);
      if (
        !mapStrokes((ss) =>
          ss.some(anySel)
            ? ss
                .map((s) => ({
                  ...s,
                  points: s.points.filter((pt) => keep(pt.select)),
                }))
                .filter((s) => s.points.length > 0)
            : null,
        )
      )
        return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.duplicate',
    label: 'Duplicate',
    description: 'Duplicate the selected points as new strokes',
    poll,
    exec: () => {
      if (
        !mapStrokes((ss) => {
          if (!ss.some(anySel)) return null;
          const copies = ss
            .flatMap((s) => filterPoints(s, (pt) => !!pt.select))
            .map((s) => ({
              ...s,
              points: s.points.map((pt) => ({
                ...pt,
                co: [...pt.co] as [number, number, number],
                select: true,
              })),
            }));
          const old = ss.map((s) => ({
            ...s,
            points: s.points.map((pt) => ({ ...pt, select: false })),
          }));
          return [...old, ...copies];
        })
      )
        return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.join_selection',
    label: 'Join Selection',
    description: 'Join the selected strokes into one',
    poll,
    exec: () => {
      if (
        !mapStrokes((ss) => {
          const sel = ss.filter(anySel);
          if (sel.length < 2) return null;
          const j = joinStrokes(sel)!;
          const first = ss.indexOf(sel[0]);
          const out = ss.filter((s) => !sel.includes(s));
          out.splice(first, 0, j);
          return out;
        })
      )
        return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.stroke_subdivide',
    label: 'Subdivide Stroke',
    props: [
      {
        id: 'number_cuts',
        label: 'Number of Cuts',
        type: 'int',
        default: 1,
        min: 1,
        max: 32,
      },
      {
        id: 'only_selected',
        label: 'Selected Points',
        type: 'bool',
        default: true,
      },
    ],
    poll,
    exec: (_c, p) => {
      if (!mapStrokes((ss) => (ss.some(anySel) ? ss.map((s) => (anySel(s) ? subdivideStroke(s, p.number_cuts as number, !!p.only_selected) : s)) : null))) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.stroke_smooth',
    label: 'Smooth Stroke',
    props: [
      {
        id: 'iterations',
        label: 'Iterations',
        type: 'int',
        default: 10,
        min: 1,
        max: 100,
      },
      {
        id: 'factor',
        label: 'Factor',
        type: 'float',
        default: 1,
        min: 0,
        max: 1,
        subtype: 'factor',
      },
      {
        id: 'smooth_ends',
        label: 'Smooth Endpoints',
        type: 'bool',
        default: false,
      },
      { id: 'smooth_position', label: 'Position', type: 'bool', default: true },
      { id: 'smooth_radius', label: 'Radius', type: 'bool', default: true },
      { id: 'smooth_opacity', label: 'Opacity', type: 'bool', default: false },
    ],
    poll,
    exec: (_c, p) => {
      const what = {
        position: !!p.smooth_position,
        radius: !!p.smooth_radius,
        opacity: !!p.smooth_opacity,
      };
      if (
        !mapStrokes((ss) =>
          ss.some(anySel)
            ? ss.map((s) => {
                if (!anySel(s)) return s;
                const pts = smoothPoints(s.points, (p.factor as number) * 0.5, p.iterations as number, s.cyclic, what, (i) => (s.points[i].select ? 1 : 0));
                if (p.smooth_ends && pts.length > 2 && !s.cyclic) {
                  const n = pts.length;
                  for (const [e, nb] of [
                    [0, 1],
                    [n - 1, n - 2],
                  ] as const)
                    if (s.points[e].select) for (let k = 0; k < 3; k++) pts[e].co[k] += (pts[nb].co[k] - pts[e].co[k]) * 0.25 * (p.factor as number);
                }
                return { ...s, points: pts };
              })
            : null,
        )
      )
        return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.stroke_simplify',
    label: 'Simplify Stroke',
    props: [
      {
        id: 'factor',
        label: 'Factor',
        type: 'float',
        default: 0.01,
        min: 0,
        max: 100,
        subtype: 'distance',
      },
    ],
    poll,
    exec: (_c, p) => {
      if (
        !mapStrokes((ss) =>
          ss.some(anySel)
            ? ss.map((s) =>
                anySel(s)
                  ? {
                      ...s,
                      points: simplifyPoints(s.points, p.factor as number),
                    }
                  : s,
              )
            : null,
        )
      )
        return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.stroke_material_set',
    label: 'Assign Material',
    description: 'Assign the active material slot to the selected strokes',
    props: [{ id: 'slot', label: 'Material Slot', type: 'int', default: -1, min: -1 }],
    poll,
    exec: (_c, p) => {
      const c = ctx()!;
      const slot = (p.slot as number) < 0 ? c.ob.active_material_index : (p.slot as number);
      if (!mapStrokes((ss) => (ss.some(anySel) ? ss.map((s) => (anySel(s) ? { ...s, material_index: slot } : s)) : null))) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.cyclical_set',
    label: 'Set Cyclical State',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'TOGGLE',
        items: [
          ['CLOSE', 'Close All'],
          ['OPEN', 'Open All'],
          ['TOGGLE', 'Toggle'],
        ],
      },
    ],
    poll,
    exec: (_c, p) => {
      if (
        !mapStrokes((ss) =>
          ss.some(anySel)
            ? ss.map((s) =>
                anySel(s)
                  ? {
                      ...s,
                      cyclic: p.type === 'CLOSE' ? true : p.type === 'OPEN' ? false : !s.cyclic,
                    }
                  : s,
              )
            : null,
        )
      )
        return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.caps_set',
    label: 'Set Curve Caps',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'ROUND',
        items: [
          ['ROUND', 'Rounded'],
          ['FLAT', 'Flat'],
          ['START', 'Toggle Start'],
          ['END', 'Toggle End'],
        ],
      },
    ],
    poll,
    exec: (_c, p) => {
      const t = p.type as string;
      const f = (s: GPStroke): GPStroke =>
        t === 'ROUND'
          ? { ...s, start_cap: 0, end_cap: 0 }
          : t === 'FLAT'
            ? { ...s, start_cap: 1, end_cap: 1 }
            : t === 'START'
              ? { ...s, start_cap: (s.start_cap ? 0 : 1) as 0 | 1 }
              : { ...s, end_cap: (s.end_cap ? 0 : 1) as 0 | 1 };
      if (!mapStrokes((ss) => (ss.some(anySel) ? ss.map((s) => (anySel(s) ? f(s) : s)) : null))) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.stroke_switch_direction',
    label: 'Switch Direction',
    poll,
    exec: () => {
      if (
        !mapStrokes((ss) =>
          ss.some(anySel)
            ? ss.map((s) =>
                anySel(s)
                  ? {
                      ...s,
                      points: s.points.slice().reverse(),
                      start_cap: s.end_cap,
                      end_cap: s.start_cap,
                    }
                  : s,
              )
            : null,
        )
      )
        return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.set_uniform_thickness',
    label: 'Set Uniform Thickness',
    props: [
      {
        id: 'thickness',
        label: 'Thickness',
        type: 'float',
        default: 0.1,
        min: 0,
        max: 1000,
        subtype: 'distance',
      },
    ],
    poll,
    exec: (_c, p) => {
      const r = (p.thickness as number) / 2;
      if (
        !mapStrokes((ss) =>
          ss.some(anySel)
            ? ss.map((s) =>
                anySel(s)
                  ? {
                      ...s,
                      points: s.points.map((pt) => ({ ...pt, radius: r })),
                    }
                  : s,
              )
            : null,
        )
      )
        return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.set_uniform_opacity',
    label: 'Set Uniform Opacity',
    props: [
      {
        id: 'opacity',
        label: 'Opacity',
        type: 'float',
        default: 1,
        min: 0,
        max: 1,
        subtype: 'factor',
      },
    ],
    poll,
    exec: (_c, p) => {
      if (
        !mapStrokes((ss) =>
          ss.some(anySel)
            ? ss.map((s) =>
                anySel(s)
                  ? {
                      ...s,
                      points: s.points.map((pt) => ({
                        ...pt,
                        opacity: p.opacity as number,
                      })),
                    }
                  : s,
              )
            : null,
        )
      )
        return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.move_to_layer',
    label: 'Move to Layer',
    description: 'Move the selected strokes to another layer',
    props: [
      { id: 'target_layer_name', label: 'Name', type: 'string', default: '' },
      { id: 'add_new_layer', label: 'New Layer', type: 'bool', default: false },
    ],
    poll,
    exec: (c, p) => {
      const { gp } = ctx()!;
      let target = gp.layers.find((l) => l.name === p.target_layer_name);
      if (!target || p.add_new_layer) {
        target = newLayer(uniqueLayerName(gp, (p.target_layer_name as string) || 'Layer'));
        gp.layers.push(target);
      }
      const frame = c.doc.scene.frame_current;
      const moved: GPStroke[] = [];
      for (const t of editTargets()) {
        if (t.layer === target) continue;
        const ss = toStrokes(drawing(t));
        const sel = ss.filter(allSel);
        if (!sel.length) continue;
        moved.push(...sel);
        setDrawing(t, fromStrokes(ss.filter((s) => !sel.includes(s))));
      }
      if (!moved.length) return 'CANCELLED';
      const fr = frameAt(target, frame);
      const idx = fr && fr.frame_number === frame ? fr.drawing : setKeyframe(gp, target, frame, emptyDrawing()).drawing;
      gp.drawings[idx] = fromStrokes([...toStrokes(gp.drawings[idx]), ...moved]);
    },
  },
]);

