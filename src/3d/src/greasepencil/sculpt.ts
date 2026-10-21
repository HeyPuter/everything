// Sculpt Mode brushes: Smooth, Thickness, Strength, Randomize, Grab, Push, Twist, Pinch.
// Points are edited in screen space (moved within the view plane at their own depth).
import { Matrix4, Vector3 } from 'three';
import { app } from '../app/app';
import { activeTools } from '../app/prefs';
import { editModeHooks } from '../editors/view3d/hooks';
import type { View3D } from '../editors/view3d/view3d';
import { gpRunStroke as runStroke } from './strokereplay';
import { drawContext, editableDrawing } from './paint';
import { gpBrush, gpTS, frameAt, toStrokes, fromStrokes, normalizeDrawing } from './data';
import { Placement } from './placement';
import { clipboardWorldStrokes } from './editops';
import { layerMatrix } from './render';
import type { GPDrawing, GPLayer } from './types';

const inSculpt = () => app.doc.mode === 'SCULPT_GREASE_PENCIL' && !!drawContext();

interface Target {
  layer: GPLayer;
  idx: number | null; // drawing index once a key was ensured
  world: Matrix4;
  inv: Matrix4;
}

/** Smooth falloff 1 → 0 over the brush radius. */
export function brushFalloff(d: number): number {
  if (d >= 1) return 0;
  const t = 1 - d;
  return t * t * (3 - 2 * t);
}

let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

export function startSculpt(v: View3D, e: PointerEvent, toolOverride?: string) {
  const c = drawContext();
  if (!c) return;
  const tool = toolOverride ?? (e.shiftKey ? 'builtin.brush.Smooth' : (activeTools[app.doc.mode] ?? 'builtin.brush.Smooth'));
  const b = gpBrush(app.doc, tool);
  const R = b.size / 2;
  const frame = app.doc.scene.frame_current;
  const obWorld = app.graph.get(c.ob.id)?.world ?? new Matrix4();
  const invert = e.ctrlKey;
  const targets: Target[] = c.gp.layers
    .filter((l) => !l.lock && !l.hide && frameAt(l, frame))
    .map((l) => {
      const w = obWorld.clone().multiply(layerMatrix(l));
      return { layer: l, idx: null, world: w, inv: w.clone().invert() };
    });
  const locked = new Set<number>();
  c.gp.materials.forEach((id, i) => id && app.doc.materials[id]?.grease_pencil?.lock && locked.add(i));
  let changed = false;
  let last = v.local(e);
  // grab: points captured at the start with their weights
  const grabbed = new Map<Target, { i: number; w: number }[]>();
  const p = new Vector3();

  const drawingOf = (t: Target): GPDrawing => c.gp.drawings[t.idx ?? frameAt(t.layer, frame)!.drawing];
  const own = (t: Target): GPDrawing => {
    if (t.idx === null) {
      t.idx = editableDrawing(c.gp, t.layer, frame, true);
      const d = c.gp.drawings[t.idx];
      // private copies for this stroke
      c.gp.drawings[t.idx] = {
        ...d,
        position: d.position.slice(),
        radius: d.radius.slice(),
        opacity: d.opacity.slice(),
      };
    }
    return c.gp.drawings[t.idx];
  };
  const strokeOf = (d: GPDrawing, i: number) => {
    let lo = 0,
      hi = d.offsets.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (d.offsets[mid] <= i) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  // selection masks (Sculpt Mode only) and auto-masking, decided at the start of the stroke
  const ts = gpTS(app.doc);
  const sculptMode = app.doc.mode === 'SCULPT_GREASE_PENCIL' && !toolOverride;
  const maskPoint = sculptMode && !!ts.use_gpencil_select_mask_point;
  const maskStroke = sculptMode && !!(ts.use_gpencil_select_mask_stroke || ts.use_gpencil_select_mask_segment);
  const auto = sculptMode
    ? { stroke: !!ts.use_automasking_stroke, layer: !!ts.use_automasking_layer_stroke, material: !!ts.use_automasking_material_stroke, activeLayer: !!ts.use_automasking_layer_active, activeMaterial: !!ts.use_automasking_material_active }
    : null;
  const startHits = { strokes: new Map<Target, Set<number>>(), layers: new Set<GPLayer>(), materials: new Set<number>() };
  if (auto && (auto.stroke || auto.layer || auto.material)) {
    const p0 = v.local(e);
    for (const t of targets) {
      const d = c.gp.drawings[frameAt(t.layer, frame)!.drawing];
      for (let i = 0; i < d.position.length / 3; i++) {
        p.set(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]).applyMatrix4(t.world);
        const sp = v.project(p);
        if (Math.hypot(sp.x - p0.x, sp.y - p0.y) > R) continue;
        const s = strokeOf(d, i);
        (startHits.strokes.get(t) ?? startHits.strokes.set(t, new Set()).get(t)!).add(s);
        startHits.layers.add(t.layer);
        startHits.materials.add(d.material_index[s]);
      }
    }
  }
  const selectedStrokes = new Map<Target, Set<number>>();
  if (maskStroke)
    for (const t of targets) {
      const d = c.gp.drawings[frameAt(t.layer, frame)!.drawing];
      const set = new Set<number>();
      d.select?.forEach((x, i) => x && set.add(strokeOf(d, i)));
      selectedStrokes.set(t, set);
    }
  let curTarget: Target | null = null;
  const pointLocked = (d: GPDrawing, i: number) => {
    const s = strokeOf(d, i);
    if (locked.size && locked.has(d.material_index[s])) return true;
    if (maskPoint && !d.select?.[i]) return true;
    if (maskStroke && !(curTarget && selectedStrokes.get(curTarget)?.has(s))) return true;
    if (auto) {
      if (auto.activeLayer && curTarget?.layer !== c.layer) return true;
      if (auto.activeMaterial && d.material_index[s] !== c.ob.active_material_index) return true;
      if (auto.stroke && !(curTarget && startHits.strokes.get(curTarget)?.has(s))) return true;
      if (auto.layer && !(curTarget && startHits.layers.has(curTarget.layer))) return true;
      if (auto.material && !startHits.materials.has(d.material_index[s])) return true;
    }
    return false;
  };
  const screenOf = (t: Target, d: GPDrawing, i: number) => {
    p.set(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]).applyMatrix4(t.world);
    return { s: v.project(p), w: p.clone() };
  };
  /** move point i of target t by a screen delta (keeping its depth) */
  const moveBy = (t: Target, d: GPDrawing, i: number, dx: number, dy: number) => {
    const { s, w } = screenOf(t, d, i);
    const q = v.unproject(s.x + dx, s.y + dy, w).applyMatrix4(t.inv);
    d.position[i * 3] = q.x;
    d.position[i * 3 + 1] = q.y;
    d.position[i * 3 + 2] = q.z;
  };

  if (tool === 'builtin.brush.Grab')
    for (const t of targets) {
      curTarget = t;
      const d = drawingOf(t);
      const list: { i: number; w: number }[] = [];
      for (let i = 0; i < d.position.length / 3; i++) {
        if (pointLocked(d, i)) continue;
        const { s } = screenOf(t, d, i);
        const f = brushFalloff(Math.hypot(s.x - last.x, s.y - last.y) / R);
        if (f > 0) list.push({ i, w: f });
      }
      if (list.length) grabbed.set(t, list);
    }

  runStroke(v, e, {
    spacing: () => (tool === 'builtin.brush.Grab' || tool === 'builtin.brush.Push' ? 0 : 10),
    radiusPx: () => R,
    dab: (dab) => {
      const dx = dab.x - last.x,
        dy = dab.y - last.y;
      last = { x: dab.x, y: dab.y };
      const strength = b.strength * (b.use_pressure_strength ? dab.pressure : 1);
      const sign = (b.direction === 'SUBTRACT' ? -1 : 1) * (invert ? -1 : 1);
      if (tool === 'builtin.brush.Grab') {
        if (dab.first) return;
        for (const [t, list] of grabbed) {
          const d = own(t);
          for (const { i, w } of list) moveBy(t, d, i, dx * w, dy * w);
          changed = true;
        }
        return;
      }
      for (const t of targets) {
        curTarget = t;
        const src = drawingOf(t);
        const n = src.position.length / 3;
        const hits: { i: number; f: number; sx: number; sy: number }[] = [];
        for (let i = 0; i < n; i++) {
          if (pointLocked(src, i)) continue;
          const { s } = screenOf(t, src, i);
          const f = brushFalloff(Math.hypot(s.x - dab.x, s.y - dab.y) / R);
          if (f > 0) hits.push({ i, f, sx: s.x, sy: s.y });
        }
        if (!hits.length) continue;
        const d = own(t);
        changed = true;
        switch (tool) {
          case 'builtin.brush.Smooth': {
            const P = d.position.slice();
            for (const { i, f } of hits) {
              // neighbours within the same stroke
              let s = 0;
              while (s + 1 < d.offsets.length - 1 && d.offsets[s + 1] <= i) s++;
              const a = d.offsets[s],
                bnd = d.offsets[s + 1] - 1;
              const cyc = !!d.cyclic[s];
              if (!cyc && (i === a || i === bnd)) continue;
              const prev = i === a ? bnd : i - 1,
                next = i === bnd ? a : i + 1;
              const k = strength * f * 0.5;
              for (let c3 = 0; c3 < 3; c3++) d.position[i * 3 + c3] = P[i * 3 + c3] + ((P[prev * 3 + c3] + P[next * 3 + c3]) / 2 - P[i * 3 + c3]) * k;
            }
            break;
          }
          case 'builtin.brush.Thickness':
            for (const { i, f } of hits) d.radius[i] = Math.max(1e-5, d.radius[i] * (1 + sign * strength * f * 0.08));
            break;
          case 'builtin.brush.Strength':
            for (const { i, f } of hits) d.opacity[i] = Math.max(0, Math.min(1, d.opacity[i] + sign * strength * f * 0.06));
            break;
          case 'builtin.brush.Randomize':
            for (const { i, f } of hits) moveBy(t, d, i, rnd() * strength * f * 3, rnd() * strength * f * 3);
            break;
          case 'builtin.brush.Push':
            for (const { i, f } of hits) moveBy(t, d, i, dx * strength * f, dy * strength * f);
            break;
          case 'builtin.brush.Twist': {
            const ang = sign * strength * 0.08;
            for (const { i, f, sx, sy } of hits) {
              const rx = sx - dab.x,
                ry = sy - dab.y;
              const a = ang * f;
              const nx = rx * Math.cos(a) - ry * Math.sin(a),
                ny = rx * Math.sin(a) + ry * Math.cos(a);
              moveBy(t, d, i, nx - rx, ny - ry);
            }
            break;
          }
          case 'builtin.brush.Pinch':
            for (const { i, f, sx, sy } of hits) {
              const k = sign * strength * f * 0.1;
              moveBy(t, d, i, (dab.x - sx) * k, (dab.y - sy) * k);
            }
            break;
        }
      }
    },
    update: () => {
      // new array identities so the GPU cache rebuilds
      for (const t of targets)
        if (t.idx !== null) {
          const d = c.gp.drawings[t.idx];
          c.gp.drawings[t.idx] = {
            ...d,
            position: d.position.slice(),
            radius: d.radius.slice(),
            opacity: d.opacity.slice(),
          };
        }
      if (changed) app.changed('doc');
    },
    end: () => {
      if (changed) app.pushUndo(`Grease Pencil Sculpt`);
    },
  });
}

/** Clone brush: the copied strokes are pasted under the brush and follow it until release. */
export function startClone(v: View3D, e: PointerEvent) {
  const c = drawContext();
  if (!c?.layer || c.layer.lock) return;
  const src = clipboardWorldStrokes();
  if (!src.length) {
    app.report('WARNING', 'Copy some strokes in Edit Mode first (Ctrl C)');
    return;
  }
  const frame = app.doc.scene.frame_current;
  const pl = new Placement(v, c.ob, c.gp, c.layer);
  const center = new Vector3();
  let n = 0;
  for (const s of src)
    for (const p of s.points) {
      center.add(new Vector3(...p.co));
      n++;
    }
  center.multiplyScalar(1 / Math.max(1, n));
  const p0 = v.local(e);
  const at = pl.project(p0.x, p0.y) ?? center.clone();
  const idx = editableDrawing(c.gp, c.layer, frame, false);
  const before = toStrokes(normalizeDrawing(c.gp.drawings[idx]));
  const inv = pl.inv;
  const place = (offset: Vector3) => {
    const w = new Vector3();
    const pasted = src.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, select: false, co: w.set(...p.co).add(offset).applyMatrix4(inv).toArray() as [number, number, number] })) }));
    c.gp.drawings[idx] = fromStrokes([...before, ...pasted]);
    app.changed('doc');
  };
  let offset = at.clone().sub(center);
  place(offset);
  const start = { x: p0.x, y: p0.y, at: at.clone() };
  runStroke(v, e, {
    spacing: () => 0,
    radiusPx: () => gpBrush(app.doc, 'builtin.brush.Clone').size / 2,
    dab: (d) => {
      const target = v.unproject(d.x, d.y, start.at);
      offset = target.sub(center);
    },
    update: () => place(offset),
    end: () => app.pushUndo('Grease Pencil Clone'),
  });
}

editModeHooks.pointer.unshift((v, e) => {
  if (!inSculpt() || e.button !== 0) return false;
  if ((activeTools[app.doc.mode] ?? '') === 'builtin.brush.Clone' && !e.shiftKey) startClone(v, e);
  else startSculpt(v, e);
  return true;
});
