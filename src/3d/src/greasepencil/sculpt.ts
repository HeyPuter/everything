// Sculpt Mode brushes: Smooth, Thickness, Strength, Randomize, Grab, Push, Twist, Pinch.
// Points are edited in screen space (moved within the view plane at their own depth).
import { Matrix4, Vector3 } from 'three';
import { app } from '../app/app';
import { activeTools } from '../app/prefs';
import { editModeHooks } from '../editors/view3d/hooks';
import type { View3D } from '../editors/view3d/view3d';
import { runStroke } from '../paint/stroke';
import { drawContext, editableDrawing } from './paint';
import { gpBrush, frameAt } from './data';
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
  const pointLocked = (d: GPDrawing, i: number) => {
    if (!locked.size) return false;
    let lo = 0,
      hi = d.offsets.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (d.offsets[mid] <= i) lo = mid;
      else hi = mid - 1;
    }
    return locked.has(d.material_index[lo]);
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

editModeHooks.pointer.unshift((v, e) => {
  if (!inSculpt() || e.button !== 0) return false;
  startSculpt(v, e);
  return true;
});
