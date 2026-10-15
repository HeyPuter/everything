// Grease Pencil modifiers: evaluated per layer drawing at draw time (non destructive), listed in
// the regular Modifiers tab for grease pencil objects. Kernels work on stroke lists in layer space.
//   Edit:     Time Offset
//   Generate: Array, Build, Dot Dash, Length, Mirror, Multiple Strokes, Outline, Simplify, Subdivide
//   Deform:   Lattice, Noise, Offset, Shrinkwrap, Smooth, Thickness
//   Color:    Hue/Saturation, Opacity, Tint
import { Matrix4, Vector3, Euler, Quaternion } from 'three';
import { app } from '../app/app';
import { modifierTypes, registerModifier } from '../eval/modifiers';
import type { EvalMesh, ModifierContext } from '../eval/types';
import type { DocumentData, ModifierBase, ObjectData } from '../data/types';
import { toStrokes, fromStrokes, normalizeDrawing, slotStyle, type GPPoint, type GPStroke } from './data';
import { smoothPoints, subdivideStroke, simplifyPoints, mergeByDistance, simplifyFixed, sampleByLength, outlinePoints } from './strokeops';
import { noise } from './drawproc';
import type { GPDrawing, GPLayer, GreasePencilData } from './types';

type M = Record<string, unknown>;
const num = (m: M, k: string, d = 0) => (typeof m[k] === 'number' ? (m[k] as number) : d);
const bool = (m: M, k: string, d = false) => (typeof m[k] === 'boolean' ? (m[k] as boolean) : d);
const vec = (m: M, k: string, d: number[] = [0, 0, 0]) => (Array.isArray(m[k]) ? (m[k] as number[]) : d);
const str = (m: M, k: string, d = '') => (typeof m[k] === 'string' ? (m[k] as string) : d);

export interface GPModContext {
  doc: DocumentData;
  ob: ObjectData;
  gp: GreasePencilData;
  layer: GPLayer;
  layerIndex: number;
  frame: number;
  /** frame number of the displayed key and of the key before it (Build) */
  keyFrame: number;
  nextKeyFrame: number | null;
  /** stroke count of the previous key (Build ▸ Additive) */
  prevStrokeCount: number;
  /** layer space → world */
  world: Matrix4;
}

type Kernel = (strokes: GPStroke[], m: M, c: GPModContext) => GPStroke[];

const clonePt = (p: GPPoint): GPPoint => ({ ...p, co: [...p.co] as GPPoint['co'], vertex_color: [...p.vertex_color] as GPPoint['vertex_color'] });
const cloneStroke = (s: GPStroke): GPStroke => ({ ...s, points: s.points.map(clonePt) });
const len3 = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Plane normal of a stroke (Newell), or the front axis for straight strokes. */
function strokeNormal(s: GPStroke): Vector3 {
  const n = new Vector3();
  const P = s.points;
  for (let i = 0; i < P.length; i++) {
    const a = P[i].co,
      b = P[(i + 1) % P.length].co;
    n.x += (a[1] - b[1]) * (a[2] + b[2]);
    n.y += (a[2] - b[2]) * (a[0] + b[0]);
    n.z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n.lengthSq() > 1e-12 ? n.normalize() : new Vector3(0, 1, 0);
}

function strokeLength(s: GPStroke) {
  let l = 0;
  for (let i = 1; i < s.points.length; i++) l += len3(s.points[i].co, s.points[i - 1].co);
  return l;
}

/** Smooth 1D value noise in [-1, 1]. */
function smoothNoise(seed: number, x: number) {
  const i = Math.floor(x),
    f = x - i;
  const t = f * f * (3 - 2 * f);
  return noise(seed, i) * (1 - t) + noise(seed, i + 1) * t;
}

// ---------------------------------------------------------------------------
// kernels

export const kernels: Record<string, Kernel> = {
  GREASE_PENCIL_THICKNESS: (ss, m) =>
    ss.map((s) => ({
      ...s,
      points: s.points.map((p) => ({ ...p, radius: bool(m, 'use_uniform_thickness') ? num(m, 'thickness', 0.02) / 2 : p.radius * num(m, 'thickness_factor', 1) })),
    })),

  GREASE_PENCIL_OPACITY: (ss, m) => {
    const mode = str(m, 'color_mode', 'BOTH');
    const f = num(m, 'color_factor', 1);
    const uniform = bool(m, 'use_uniform_opacity');
    return ss.map((s) => ({
      ...s,
      fill_opacity: mode === 'STROKE' ? s.fill_opacity : Math.max(0, Math.min(1, uniform ? f : s.fill_opacity * f)),
      points: mode === 'FILL' ? s.points : s.points.map((p) => ({ ...p, opacity: Math.max(0, Math.min(1, uniform ? f : p.opacity * f)) })),
    }));
  },

  GREASE_PENCIL_TINT: (ss, m) => {
    const mode = str(m, 'color_mode', 'BOTH');
    const f = Math.max(0, Math.min(1, num(m, 'factor', 0.5)));
    const col = vec(m, 'color', [1, 1, 1]);
    const tint = (c: number[]): [number, number, number, number] => {
      // the tint is mixed over whatever the color attribute shows (its alpha grows with the factor)
      const a = c[3];
      const base = [0, 1, 2].map((k) => (a > 0 ? c[k] : col[k]));
      return [base[0] + (col[0] - base[0]) * f, base[1] + (col[1] - base[1]) * f, base[2] + (col[2] - base[2]) * f, a + (1 - a) * f];
    };
    return ss.map((s) => ({
      ...s,
      fill_color: mode === 'STROKE' ? s.fill_color : tint(s.fill_color),
      points: mode === 'FILL' ? s.points : s.points.map((p) => ({ ...p, vertex_color: tint(p.vertex_color) })),
    }));
  },

  GREASE_PENCIL_COLOR: (ss, m, c) => {
    // Hue / Saturation / Value of the shown colors (material color under the color attribute)
    const mode = str(m, 'color_mode', 'BOTH');
    const dh = num(m, 'hue', 0.5) - 0.5,
      sf = num(m, 'saturation', 1),
      vf = num(m, 'value', 1);
    const adjust = (rgb: number[]): [number, number, number] => {
      const mx = Math.max(rgb[0], rgb[1], rgb[2]),
        mn = Math.min(rgb[0], rgb[1], rgb[2]);
      const d = mx - mn;
      let hh = 0;
      if (d > 1e-9) hh = mx === rgb[0] ? ((rgb[1] - rgb[2]) / d) % 6 : mx === rgb[1] ? (rgb[2] - rgb[0]) / d + 2 : (rgb[0] - rgb[1]) / d + 4;
      hh = (((hh / 6 + dh) % 1) + 1) % 1;
      const sat = Math.min(1, (mx > 0 ? d / mx : 0) * sf),
        val = mx * vf;
      const k = (n: number) => (n + hh * 6) % 6;
      const ch = (n: number) => val - val * sat * Math.max(0, Math.min(k(n), 4 - k(n), 1));
      return [ch(5), ch(3), ch(1)];
    };
    const shown = (mat: number[], vc: number[]) => [0, 1, 2].map((k) => mat[k] + (vc[k] - mat[k]) * vc[3]);
    return ss.map((s) => {
      const st = slotStyle(c.doc, c.gp, s.material_index);
      const sc = st?.color ?? [0, 0, 0, 1],
        fc = st?.fill_color ?? [0.5, 0.5, 0.5, 1];
      return {
        ...s,
        fill_color: mode === 'STROKE' ? s.fill_color : ([...adjust(shown(fc, s.fill_color)), 1] as GPStroke['fill_color']),
        points: mode === 'FILL' ? s.points : s.points.map((p) => ({ ...p, vertex_color: [...adjust(shown(sc, p.vertex_color)), 1] as GPPoint['vertex_color'] })),
      };
    });
  },

  GREASE_PENCIL_SMOOTH: (ss, m) => {
    const what = { position: bool(m, 'use_edit_position', true), radius: bool(m, 'use_edit_thickness'), opacity: bool(m, 'use_edit_strength') };
    const f = num(m, 'factor', 1) * 0.5,
      steps = Math.max(1, Math.round(num(m, 'step', 1)));
    return ss.map((s) => {
      let pts = smoothPoints(s.points, f, steps, s.cyclic, what);
      if (bool(m, 'use_keep_shape')) pts = smoothPoints(pts, -f * 1.05, steps, s.cyclic, what);
      if (bool(m, 'use_smooth_ends') && pts.length > 2 && !s.cyclic) {
        const n = pts.length;
        for (const [e, nb] of [
          [0, 1],
          [n - 1, n - 2],
        ])
          for (let k = 0; k < 3; k++) pts[e].co[k] += (pts[nb].co[k] - pts[e].co[k]) * f * 0.5;
      }
      return { ...s, points: pts };
    });
  },

  GREASE_PENCIL_SUBDIV: (ss, m) => {
    const level = Math.max(0, Math.round(num(m, 'level', 1)));
    const cc = str(m, 'subdivision_type', 'CATMULL_CLARK') === 'CATMULL_CLARK';
    return ss.map((s) => {
      let out = s;
      for (let k = 0; k < level; k++) {
        out = subdivideStroke(out, 1, false);
        if (cc && out.points.length > 2) out = { ...out, points: smoothPoints(out.points, 0.5, 1, out.cyclic, { position: true, radius: false, opacity: false }) };
      }
      return out;
    });
  },

  GREASE_PENCIL_SIMPLIFY: (ss, m) => {
    const mode = str(m, 'mode', 'FIXED');
    return ss.map((s) => ({
      ...s,
      points:
        mode === 'FIXED'
          ? simplifyFixed(s.points, Math.round(num(m, 'step', 1)))
          : mode === 'ADAPTIVE'
            ? simplifyPoints(s.points, num(m, 'factor', 0))
            : mode === 'SAMPLE'
              ? sampleByLength(s.points, Math.max(1e-4, num(m, 'length', 0.1)), s.cyclic)
              : mergeByDistance(s.points, num(m, 'distance', 0.1)),
    }));
  },

  GREASE_PENCIL_NOISE: (ss, m, c) => {
    const step = Math.max(1, Math.round(num(m, 'step', 4)));
    let seed = Math.round(num(m, 'seed', 1));
    if (bool(m, 'use_random', true)) seed += str(m, 'random_mode', 'STEP') === 'KEYFRAME' ? c.keyFrame * 7919 : Math.floor(c.frame / step) * 7919;
    const fp = num(m, 'factor', 0.5),
      fs = num(m, 'factor_strength', 0),
      ft = num(m, 'factor_thickness', 0);
    const scale = num(m, 'noise_scale', 0) > 0 ? num(m, 'noise_scale', 0) : 1;
    const off = num(m, 'noise_offset', 0);
    return ss.map((s, si) => {
      const nrm = strokeNormal(s);
      const n = s.points.length;
      const P = s.points;
      return {
        ...s,
        points: P.map((p, i) => {
          const x = (i / Math.max(1, n - 1)) * scale * n * 0.1 + off;
          const sd = seed + si * 131;
          const q = clonePt(p);
          if (fp) {
            const a = P[Math.max(0, i - 1)].co,
              b = P[Math.min(n - 1, i + 1)].co;
            const t = new Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
            const side = new Vector3().crossVectors(nrm, t);
            if (side.lengthSq() > 1e-12) {
              side.normalize().multiplyScalar(smoothNoise(sd, x) * fp * p.radius * 4);
              q.co = [p.co[0] + side.x, p.co[1] + side.y, p.co[2] + side.z];
            }
          }
          if (ft) q.radius = Math.max(1e-5, p.radius * (1 + smoothNoise(sd + 17, x) * ft));
          if (fs) q.opacity = Math.max(0, Math.min(1, p.opacity * (1 - Math.abs(smoothNoise(sd + 31, x)) * fs)));
          return q;
        }),
      };
    });
  },

  GREASE_PENCIL_OFFSET: (ss, m, c) => {
    const mode = str(m, 'offset_mode', 'RANDOM');
    const loc = vec(m, 'location'),
      rot = vec(m, 'rotation'),
      scl = vec(m, 'scale');
    const sl = vec(m, 'stroke_location'),
      sr = vec(m, 'stroke_rotation'),
      ss2 = vec(m, 'stroke_scale');
    const seed = Math.round(num(m, 'seed', 0));
    const stepN = Math.max(1, Math.round(num(m, 'stroke_step', 1))),
      start = Math.round(num(m, 'stroke_start_offset', 0));
    const uniform = bool(m, 'use_uniform_random_scale');
    const matrixFor = (k: number[] | number) => {
      const f = (i: number) => (Array.isArray(k) ? k[i] : k);
      const S = uniform && Array.isArray(k) ? [f(0), f(0), f(0)] : [f(0), f(1), f(2)];
      return new Matrix4().compose(
        new Vector3(loc[0] + sl[0] * f(0), loc[1] + sl[1] * f(1), loc[2] + sl[2] * f(2)),
        new Quaternion().setFromEuler(new Euler(rot[0] + sr[0] * f(0), rot[1] + sr[1] * f(1), rot[2] + sr[2] * f(2))),
        new Vector3(1 + scl[0] + ss2[0] * S[0], 1 + scl[1] + ss2[1] * S[1], 1 + scl[2] + ss2[2] * S[2]),
      );
    };
    const v = new Vector3();
    return ss.map((s, i) => {
      const k: number[] | number =
        mode === 'RANDOM' ? [noise(seed, i * 3), noise(seed, i * 3 + 1), noise(seed, i * 3 + 2)] : mode === 'LAYER' ? c.layerIndex : mode === 'MATERIAL' ? s.material_index : Math.floor((i + start) / stepN);
      const mat = matrixFor(k);
      // scale & rotate around the stroke's own center
      const cen = new Vector3();
      for (const p of s.points) cen.add(v.set(...p.co));
      cen.multiplyScalar(1 / Math.max(1, s.points.length));
      const full = new Matrix4().makeTranslation(cen.x, cen.y, cen.z).multiply(mat).multiply(new Matrix4().makeTranslation(-cen.x, -cen.y, -cen.z));
      const sc = (Math.abs(1 + scl[0]) + Math.abs(1 + scl[1]) + Math.abs(1 + scl[2])) / 3;
      return { ...s, points: s.points.map((p) => ({ ...clonePt(p), co: v.set(...p.co).applyMatrix4(full).toArray() as GPPoint['co'], radius: p.radius * sc })) };
    });
  },

  GREASE_PENCIL_ARRAY: (ss, m, c) => {
    const count = Math.max(1, Math.round(num(m, 'count', 2)));
    // bounds for the relative offset
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (const s of ss) for (const p of s.points) for (let k = 0; k < 3; k++) [min[k], max[k]] = [Math.min(min[k], p.co[k]), Math.max(max[k], p.co[k])];
    const size = min[0] === Infinity ? [0, 0, 0] : [0, 1, 2].map((k) => max[k] - min[k]);
    const step = new Matrix4();
    const t = new Vector3();
    if (bool(m, 'use_relative_offset', true)) t.add(new Vector3(...vec(m, 'relative_offset', [1, 0, 0]).map((x, k) => x * size[k])));
    if (bool(m, 'use_constant_offset')) t.add(new Vector3(...vec(m, 'constant_offset')));
    step.makeTranslation(t.x, t.y, t.z);
    const target = bool(m, 'use_object_offset') && typeof m.offset_object === 'string' ? app.graph.get(m.offset_object as string) : null;
    if (target) {
      // the target's transform relative to this object's layer space, applied per copy
      const rel = c.world.clone().invert().multiply(target.world).multiply(new Matrix4().makeTranslation(-c.world.elements[12], -c.world.elements[13], -c.world.elements[14]));
      step.multiply(rel);
    }
    const seed = Math.round(num(m, 'seed', 1));
    const ro = vec(m, 'random_offset'),
      rr = vec(m, 'random_rotation'),
      rs = vec(m, 'random_scale');
    const repl = Math.round(num(m, 'replace_material', 0));
    const out: GPStroke[] = ss.map(cloneStroke);
    let acc = new Matrix4();
    const v = new Vector3();
    for (let k = 1; k < count; k++) {
      acc = acc.clone().multiply(step);
      const r = (i: number) => noise(seed, k * 9 + i);
      const us = bool(m, 'use_uniform_random_scale');
      const jitter = new Matrix4().compose(
        new Vector3(ro[0] * r(0), ro[1] * r(1), ro[2] * r(2)),
        new Quaternion().setFromEuler(new Euler(rr[0] * r(3), rr[1] * r(4), rr[2] * r(5))),
        new Vector3(1 + rs[0] * r(6), 1 + rs[1] * (us ? r(6) : r(7)), 1 + rs[2] * (us ? r(6) : r(8))),
      );
      const mk = acc.clone().multiply(jitter);
      for (const s of ss)
        out.push({
          ...s,
          material_index: repl > 0 ? repl - 1 : s.material_index,
          points: s.points.map((p) => ({ ...clonePt(p), select: false, co: v.set(...p.co).applyMatrix4(mk).toArray() as GPPoint['co'] })),
        });
    }
    return out;
  },

  GREASE_PENCIL_MIRROR: (ss, m, c) => {
    const axes = [bool(m, 'use_axis_x', true), bool(m, 'use_axis_y'), bool(m, 'use_axis_z')];
    const target = typeof m.object === 'string' ? app.graph.get(m.object as string) : null;
    // layer space → mirror space
    const toM = target ? target.world.clone().invert().multiply(c.world) : new Matrix4();
    const fromM = toM.clone().invert();
    let out = ss.map(cloneStroke);
    const v = new Vector3();
    axes.forEach((on, a) => {
      if (!on) return;
      const flip = new Matrix4().makeScale(a === 0 ? -1 : 1, a === 1 ? -1 : 1, a === 2 ? -1 : 1);
      const mk = fromM.clone().multiply(flip).multiply(toM);
      out = [...out, ...out.map((s) => ({ ...s, points: s.points.map((p) => ({ ...clonePt(p), co: v.set(...p.co).applyMatrix4(mk).toArray() as GPPoint['co'] })) }))];
    });
    return out;
  },

  GREASE_PENCIL_MULTIPLY: (ss, m) => {
    const n = Math.max(0, Math.round(num(m, 'duplicates', 3)));
    if (!n) return ss;
    const dist = num(m, 'distance', 0.1),
      off = num(m, 'offset', 0);
    const fade = bool(m, 'use_fade');
    const ft = num(m, 'fading_thickness', 0.5),
      fo = num(m, 'fading_opacity', 0.5),
      fc = num(m, 'fading_center', 0.5);
    const out: GPStroke[] = [];
    for (const s of ss) {
      const nrm = strokeNormal(s);
      const P = s.points;
      for (let k = 0; k <= n; k++) {
        // positions spread evenly across [-1, 1], shifted by the offset
        const t = n ? (k / n) * 2 - 1 + off : 0;
        const w = fade ? 1 - Math.min(1, Math.abs((k / n) - fc) * 2) : 1;
        out.push({
          ...s,
          points: P.map((p, i) => {
            const a = P[Math.max(0, i - 1)].co,
              b = P[Math.min(P.length - 1, i + 1)].co;
            const side = new Vector3().crossVectors(nrm, new Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
            if (side.lengthSq() > 1e-12) side.normalize().multiplyScalar(t * dist);
            return { ...clonePt(p), co: [p.co[0] + side.x, p.co[1] + side.y, p.co[2] + side.z], radius: p.radius * (1 - ft * (1 - w)), opacity: p.opacity * (1 - fo * (1 - w)) };
          }),
        });
      }
    }
    return out;
  },

  GREASE_PENCIL_LENGTH: (ss, m) => {
    const rel = str(m, 'mode', 'RELATIVE') === 'RELATIVE';
    const seed = Math.round(num(m, 'seed', 0));
    return ss.map((s, si) => {
      if (s.cyclic || s.points.length < 2) return s;
      const L = strokeLength(s);
      const rnd = bool(m, 'use_random');
      let a = rel ? num(m, 'start_factor', 0.1) * L : num(m, 'start_length', 0.1);
      let b = rel ? num(m, 'end_factor', 0.1) * L : num(m, 'end_length', 0.1);
      if (rnd) {
        a += num(m, 'random_start_factor') * noise(seed, si * 2) * L;
        b += num(m, 'random_end_factor') * noise(seed, si * 2 + 1) * L;
      }
      return { ...s, points: changeLength(s.points, a, b) };
    });
  },

  GREASE_PENCIL_DASH: (ss, m) => {
    const segs = (Array.isArray(m.segments) ? (m.segments as M[]) : []).filter((g) => num(g, 'dash', 2) > 0);
    if (!segs.length) return ss;
    const period = segs.reduce((acc, g) => acc + num(g, 'dash', 2) + num(g, 'gap', 1), 0);
    const offset = Math.round(num(m, 'dash_offset', 0));
    const out: GPStroke[] = [];
    for (const s of ss) {
      const n = s.points.length;
      let i = ((-offset % period) + period) % period;
      // walk the pattern from the stroke start
      let pos = 0;
      let gi = 0;
      // skip into the pattern by the offset
      let skip = i;
      while (skip > 0) {
        const g = segs[gi];
        const dl = num(g, 'dash', 2) + num(g, 'gap', 1);
        if (skip < dl) break;
        skip -= dl;
        gi = (gi + 1) % segs.length;
      }
      pos = -skip;
      while (pos < n) {
        const g = segs[gi];
        const d = num(g, 'dash', 2),
          gap = num(g, 'gap', 1);
        const from = Math.max(0, pos),
          to = Math.min(n, pos + d + 1);
        if (to - from >= 1) {
          const mi = Math.round(num(g, 'material_index', -1));
          out.push({
            ...s,
            cyclic: bool(g, 'use_cyclic') && to - from > 2,
            material_index: mi >= 0 ? mi : s.material_index,
            points: s.points.slice(from, to).map((p) => ({ ...clonePt(p), radius: p.radius * num(g, 'radius', 1), opacity: p.opacity * num(g, 'opacity', 1) })),
          });
        }
        pos += d + gap;
        gi = (gi + 1) % segs.length;
      }
      void i;
    }
    return out;
  },

  GREASE_PENCIL_OUTLINE: (ss, m, c) => {
    // outline as seen from the scene camera (or the front when there is none)
    const cam = c.doc.scene.camera ? app.graph.get(c.doc.scene.camera) : null;
    const viewN = cam ? new Vector3(0, 0, 1).transformDirection(cam.world) : new Vector3(0, -1, 0);
    const local = viewN.transformDirection(c.world.clone().invert()).normalize();
    const radius = Math.max(1e-4, num(m, 'thickness', 1) * 0.001);
    const mat = typeof m.outline_material === 'string' ? c.gp.materials.indexOf(m.outline_material as string) : -1;
    return ss.flatMap((s) => {
      const loops: GPPoint[][] = [outlinePoints(s, local, 0, Math.round(num(m, 'subdivision', 3)))];
      if (s.cyclic) loops.push(outlinePoints(s, local.clone().negate(), 0, Math.round(num(m, 'subdivision', 3))).reverse());
      return loops.map((pts) => ({ ...s, cyclic: true, material_index: mat >= 0 ? mat : s.material_index, points: pts.map((p) => ({ ...p, radius })) }));
    });
  },

  GREASE_PENCIL_BUILD: (ss, m, c) => buildStrokes(ss, m, c),

  GREASE_PENCIL_ENVELOPE: (ss, m) => {
    // strokes between points `spread` apart: lines (Segments) or filled quads (Fills)
    const spread = Math.max(1, Math.round(num(m, 'spread', 10)));
    const skip = Math.max(0, Math.round(num(m, 'skip', 0)));
    const fills = str(m, 'mode', 'SEGMENTS') === 'FILLS';
    const mat = Math.round(num(m, 'mat_nr', -1));
    const th = num(m, 'thickness', 1),
      st = num(m, 'strength', 1);
    const out: GPStroke[] = [];
    for (const s of ss) {
      const P = s.points;
      const n = P.length;
      const last = s.cyclic ? n : n - spread;
      for (let i = 0; i < last; i += 1 + skip) {
        const j = (i + spread) % n;
        const scale = (p: GPPoint) => ({ ...clonePt(p), select: false, radius: p.radius * th, opacity: p.opacity * st });
        const pts = fills ? [P[i], P[(i + 1) % n], P[(j + 1) % n], P[j]].map(scale) : [scale(P[i]), scale(P[j])];
        out.push({ ...s, points: pts, cyclic: fills, fill_id: 0, material_index: mat >= 0 ? mat : s.material_index });
      }
    }
    return [...ss, ...out];
  },

  GREASE_PENCIL_VERTEX_WEIGHT_PROXIMITY: (ss, m, c) => {
    const target = str(m, 'target_vertex_group');
    const ob = typeof m.object === 'string' ? app.graph.get(m.object as string) : null;
    if (!target || !ob) return ss;
    const at = new Vector3().setFromMatrixPosition(ob.world);
    const d0 = num(m, 'distance_start', 0),
      d1 = num(m, 'distance_end', 20);
    const v = new Vector3();
    return writeWeights(ss, m, target, (p) => {
      const d = v.set(...p.co).applyMatrix4(c.world).distanceTo(at);
      return d1 !== d0 ? (d - d0) / (d1 - d0) : d >= d1 ? 1 : 0;
    });
  },

  GREASE_PENCIL_VERTEX_WEIGHT_ANGLE: (ss, m, c) => {
    const target = str(m, 'target_vertex_group');
    if (!target) return ss;
    const axis = str(m, 'axis', 'Y');
    const a = num(m, 'angle', 0);
    // reference direction: in the plane across the axis, turned by the angle
    const ref = axis === 'X' ? new Vector3(0, Math.cos(a), Math.sin(a)) : axis === 'Z' ? new Vector3(Math.cos(a), Math.sin(a), 0) : new Vector3(Math.cos(a), 0, Math.sin(a));
    const world = str(m, 'space', 'LOCAL') === 'WORLD';
    const out: GPStroke[] = [];
    for (const s of ss) {
      const P = s.points.map((p) => (world ? new Vector3(...p.co).applyMatrix4(c.world) : new Vector3(...p.co)));
      out.push(
        ...writeWeights([s], m, target, (_p, i) => {
          const d = P[Math.min(P.length - 1, i + 1)].clone().sub(P[Math.max(0, i - 1)]);
          return d.lengthSq() > 1e-12 ? Math.abs(d.normalize().dot(ref)) : 0;
        }),
      );
    }
    return out;
  },

  GREASE_PENCIL_LATTICE: (ss, m, c) => viaMeshModifier('LATTICE', { object: m.object, strength: num(m, 'strength', 1), vertex_group: '' }, ss, c),

  GREASE_PENCIL_HOOK: (ss, m, c) => viaMeshModifier('HOOK', { object: m.object, strength: num(m, 'strength', 1), falloff_radius: num(m, 'falloff_radius', 0), center: vec(m, 'center'), matrix_inverse: m.matrix_inverse, vertex_indices: [] }, ss, c),

  GREASE_PENCIL_ARMATURE: (ss, m, c) => viaMeshModifier('ARMATURE', { object: m.object, use_vertex_groups: true, use_deform_preserve_volume: bool(m, 'use_deform_preserve_volume') }, ss, c, true),

  GREASE_PENCIL_SHRINKWRAP: (ss, m, c) => viaMeshModifier('SHRINKWRAP', { target: m.target, wrap_method: str(m, 'wrap_method', 'NEAREST_SURFACEPOINT'), offset: num(m, 'offset', 0.05), vertex_group: '' }, ss, c),
};

/** Write weights into a group (minimum, invert, multiply with the existing weights). */
function writeWeights(ss: GPStroke[], m: M, group: string, fn: (p: GPPoint, i: number) => number): GPStroke[] {
  const min = num(m, 'minimum_weight', 0);
  return ss.map((s) => ({
    ...s,
    points: s.points.map((p, i) => {
      let w = Math.max(0, Math.min(1, fn(p, i)));
      if (bool(m, 'use_invert_output')) w = 1 - w;
      w = Math.max(min, w);
      if (bool(m, 'use_multiply')) w *= p.weights?.[group] ?? 0;
      return { ...p, weights: { ...(p.weights ?? {}), [group]: w } };
    }),
  }));
}

/** Extend (positive) or shorten (negative) both ends of an open stroke by a length. */
export function changeLength(points: GPPoint[], start: number, end: number): GPPoint[] {
  let pts = points.map(clonePt);
  const cut = (list: GPPoint[], amount: number): GPPoint[] => {
    // remove `amount` of length from the start of the list
    let rest = amount;
    while (list.length > 2) {
      const d = len3(list[0].co, list[1].co);
      if (d > rest) {
        const t = rest / d;
        list[0] = { ...list[0], co: [0, 1, 2].map((k) => list[0].co[k] + (list[1].co[k] - list[0].co[k]) * t) as GPPoint['co'] };
        return list;
      }
      rest -= d;
      list.shift();
    }
    return list;
  };
  const grow = (list: GPPoint[], amount: number): GPPoint[] => {
    const a = list[0],
      b = list[1];
    const d = len3(a.co, b.co) || 1;
    const dir = [0, 1, 2].map((k) => (a.co[k] - b.co[k]) / d);
    return [{ ...clonePt(a), co: [0, 1, 2].map((k) => a.co[k] + dir[k] * amount) as GPPoint['co'] }, ...list];
  };
  if (start > 0) pts = grow(pts, start);
  else if (start < 0) pts = cut(pts, -start);
  pts.reverse();
  if (end > 0) pts = grow(pts, end);
  else if (end < 0) pts = cut(pts, -end);
  return pts.reverse();
}

/** Build: strokes appear (grow), disappear (shrink) or fade over time from the key's frame. */
export function buildStrokes(ss: GPStroke[], m: M, c: { frame: number; keyFrame: number; prevStrokeCount: number }): GPStroke[] {
  let f: number;
  if (str(m, 'time_mode', 'FRAMES') === 'PERCENTAGE' || bool(m, 'use_percentage')) f = num(m, 'percentage_factor', 0);
  else {
    const start = bool(m, 'use_restrict_frame_range') ? num(m, 'frame_start', 1) : c.keyFrame;
    const length = bool(m, 'use_restrict_frame_range') ? Math.max(1, num(m, 'frame_end', 125) - num(m, 'frame_start', 1)) : Math.max(1, num(m, 'length', 100));
    f = (c.frame - start - num(m, 'start_delay', 0)) / length;
  }
  f = Math.max(0, Math.min(1, f));
  const transition = str(m, 'transition', 'GROW');
  const mode = str(m, 'mode', 'SEQUENTIAL');
  const animated = mode === 'ADDITIVE' ? ss.slice(Math.min(ss.length, c.prevStrokeCount)) : ss;
  const fixed = mode === 'ADDITIVE' ? ss.slice(0, Math.min(ss.length, c.prevStrokeCount)) : [];
  const shown = transition === 'SHRINK' ? 1 - f : f;
  if (transition === 'FADE') {
    const total = animated.reduce((a, s) => a + s.points.length, 0);
    let before = 0;
    return [
      ...fixed,
      ...animated.map((s) => {
        const out = {
          ...s,
          points: s.points.map((p, i) => {
            const t = mode === 'CONCURRENT' ? i / Math.max(1, s.points.length - 1) : (before + i) / Math.max(1, total - 1);
            return { ...p, opacity: p.opacity * Math.max(0, Math.min(1, (1 - f) * 2 - t)) };
          }),
        };
        before += s.points.length;
        return out;
      }),
    ];
  }
  if (mode === 'CONCURRENT') {
    const maxLen = Math.max(1, ...animated.map((s) => s.points.length));
    const endAligned = str(m, 'concurrent_time_alignment', 'START') === 'END';
    return [
      ...fixed,
      ...animated.flatMap((s) => {
        const n = s.points.length;
        // shorter strokes finish early (start aligned) or start late (end aligned)
        const frac = endAligned ? Math.max(0, Math.min(1, (shown * maxLen - (maxLen - n)) / n)) : Math.min(1, (shown * maxLen) / n);
        const k = Math.round(frac * n);
        return k > 0 ? [{ ...s, points: transition === 'SHRINK' ? s.points.slice(n - k) : s.points.slice(0, k) }] : [];
      }),
    ];
  }
  const total = animated.reduce((a, s) => a + s.points.length, 0);
  let budget = Math.round(shown * total);
  const out: GPStroke[] = [...fixed];
  const list = transition === 'SHRINK' ? [...animated].reverse() : animated;
  const kept: GPStroke[] = [];
  for (const s of list) {
    if (budget <= 0) break;
    const k = Math.min(s.points.length, budget);
    budget -= k;
    kept.push({ ...s, points: transition === 'SHRINK' ? s.points.slice(s.points.length - k) : s.points.slice(0, k) });
  }
  return [...out, ...(transition === 'SHRINK' ? kept.reverse() : kept)];
}

/** Run a mesh deform modifier on the stroke points (converted to object space and back). */
function viaMeshModifier(type: string, mod: M, ss: GPStroke[], c: GPModContext, withWeights = false): GPStroke[] {
  const t = modifierTypes[type];
  if (!t) return ss;
  const obWorld = app.graph.get(c.ob.id)?.world ?? new Matrix4();
  const toOb = obWorld.clone().invert().multiply(c.world);
  const back = toOb.clone().invert();
  const n = ss.reduce((a, s) => a + s.points.length, 0);
  const positions = new Float32Array(n * 3);
  const v = new Vector3();
  let i = 0;
  for (const s of ss)
    for (const p of s.points) {
      v.set(...p.co).applyMatrix4(toOb);
      positions.set([v.x, v.y, v.z], i * 3);
      i++;
    }
  const mesh = { positions, offsets: new Uint32Array([0]), indices: new Uint32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0) } as EvalMesh;
  if (withWeights) {
    // vertex groups of the object, weights from the points
    const groups = (c.gp.vertex_groups ?? []).map((g) => ({ name: g.name }));
    mesh.vertex_groups = groups;
    mesh.weights = groups.map(() => new Float32Array(n));
    let k = 0;
    for (const s of ss)
      for (const p of s.points) {
        if (p.weights) groups.forEach((g, gi) => (mesh.weights![gi][k] = p.weights![g.name] ?? 0));
        k++;
      }
  }
  const ctx: ModifierContext = { doc: c.doc, ob: c.ob, graph: app.graph, frame: c.frame, source: null, editMode: false, render: false };
  const res = t.apply(mesh, { id: 'gp', name: type, type, show_viewport: true, show_render: true, show_in_editmode: true, show_expanded: true, ...mod }, ctx);
  i = 0;
  return ss.map((s) => ({
    ...s,
    points: s.points.map((p) => {
      v.set(res.positions[i * 3], res.positions[i * 3 + 1], res.positions[i * 3 + 2]).applyMatrix4(back);
      i++;
      return { ...clonePt(p), co: [v.x, v.y, v.z] };
    }),
  }));
}

// ---------------------------------------------------------------------------
// influence filters (layer / material, by name or pass index)

function passes(m: M, c: GPModContext, s: GPStroke | null): boolean {
  const lf = str(m, 'layer_filter');
  if (lf) {
    const hit = c.layer.name === lf;
    if (hit === bool(m, 'invert_layer_filter')) return false;
  }
  if (bool(m, 'use_layer_pass_filter')) {
    const hit = (c.layer.pass_index ?? 0) === num(m, 'layer_pass_filter', 0);
    if (hit === bool(m, 'invert_layer_pass_filter')) return false;
  }
  if (!s) return true;
  const mf = m.material_filter as string | null | undefined;
  if (mf) {
    const hit = c.gp.materials[s.material_index] === mf;
    if (hit === bool(m, 'invert_material_filter')) return false;
  }
  if (bool(m, 'use_material_pass_filter')) {
    const st = slotStyle(c.doc, c.gp, s.material_index);
    const hit = (st?.pass_index ?? 0) === num(m, 'material_pass_filter', 0);
    if (hit === bool(m, 'invert_material_pass_filter')) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// vertex group influence: deforming / coloring modifiers act by each point's weight

/** Modifiers that keep the points (their results can be blended per point). */
export const WEIGHTED = new Set(['GREASE_PENCIL_HOOK', 'GREASE_PENCIL_THICKNESS', 'GREASE_PENCIL_OPACITY', 'GREASE_PENCIL_TINT', 'GREASE_PENCIL_NOISE', 'GREASE_PENCIL_OFFSET', 'GREASE_PENCIL_SMOOTH', 'GREASE_PENCIL_LATTICE', 'GREASE_PENCIL_SHRINKWRAP']);

/** Blend a kernel's result with the input by the points' group weights (unchanged when the topology differs). */
export function weighByGroup(before: GPStroke[], after: GPStroke[], group: string, invert: boolean): GPStroke[] {
  if (before.length !== after.length || before.some((s, i) => s.points.length !== after[i].points.length)) return after;
  return after.map((s, si) => ({
    ...s,
    points: s.points.map((q, i) => {
      const p = before[si].points[i];
      let w = p.weights?.[group] ?? 0;
      if (invert) w = 1 - w;
      if (w >= 1) return q;
      const l = (a: number, b: number) => a + (b - a) * w;
      return {
        ...q,
        co: [l(p.co[0], q.co[0]), l(p.co[1], q.co[1]), l(p.co[2], q.co[2])],
        radius: l(p.radius, q.radius),
        opacity: l(p.opacity, q.opacity),
        vertex_color: [0, 1, 2, 3].map((k) => l(p.vertex_color[k], q.vertex_color[k])) as GPPoint['vertex_color'],
      };
    }),
  }));
}

// ---------------------------------------------------------------------------
// evaluation

export const GP_MOD_PREFIX = 'GREASE_PENCIL_';
export const isGPModifier = (type: string) => type.startsWith(GP_MOD_PREFIX);

/** Grease pencil modifiers of an object that are enabled for the viewport (or render). */
export function activeModifiers(ob: ObjectData, render = false): ModifierBase[] {
  return ob.modifiers.filter((m) => isGPModifier(m.type) && (render ? m.show_render : m.show_viewport) && (kernels[m.type] || m.type === 'GREASE_PENCIL_TIME'));
}

/** Displayed frame for a layer after the Time Offset modifiers. */
export function layerFrame(ob: ObjectData, c: { layer: GPLayer; layerIndex: number; doc: DocumentData; gp: GreasePencilData }, frame: number, mods = activeModifiers(ob)): number {
  let f = frame;
  for (const m of mods) {
    if (m.type !== 'GREASE_PENCIL_TIME') continue;
    if (!passes(m, { ...c, ob, frame, keyFrame: 0, nextKeyFrame: null, prevStrokeCount: 0, world: new Matrix4() }, null)) continue;
    f = timeOffset(m, f, c.doc.scene.frame_start, c.doc.scene.frame_end);
  }
  return f;
}

export function timeOffset(m: M, frame: number, sceneStart: number, sceneEnd: number): number {
  const custom = bool(m, 'use_custom_frame_range');
  const s = custom ? num(m, 'frame_start', 1) : sceneStart;
  const e = custom ? num(m, 'frame_end', 250) : sceneEnd;
  const len = Math.max(1, e - s + 1);
  const sc = num(m, 'frame_scale', 1),
    off = Math.round(num(m, 'offset', 1));
  const loop = bool(m, 'use_keep_loop', true);
  const wrap = (x: number) => (loop ? s + ((((x - s) % len) + len) % len) : x);
  switch (str(m, 'mode', 'NORMAL')) {
    case 'FIX':
      return off;
    case 'REVERSE':
      return wrap(e - Math.round((frame - s) * sc) - off);
    case 'PINGPONG': {
      const t = Math.round((frame - s) * sc) + off;
      const span = Math.max(1, len - 1);
      const k = ((t % (2 * span)) + 2 * span) % (2 * span);
      return s + (k <= span ? k : 2 * span - k);
    }
    default:
      return wrap(s + Math.round((frame - s) * sc) + off);
  }
}

const cache = new WeakMap<GPDrawing, Map<string, GPDrawing>>();
const ids = new WeakMap<object, number>();
let nextId = 1;
/** A stable number per object identity (cache keys of arrays replaced on edit). */
function identity(o: object): number {
  let i = ids.get(o);
  if (!i) ids.set(o, (i = nextId++));
  return i;
}

/** A layer drawing with the object's grease pencil modifiers applied (cached). */
export function evaluateDrawing(d: GPDrawing, c: GPModContext, mods: ModifierBase[]): GPDrawing {
  const list = mods.filter((m) => kernels[m.type]);
  if (!list.length) return d;
  const timeDep = list.some((m) => m.type === 'GREASE_PENCIL_BUILD' || (m.type === 'GREASE_PENCIL_NOISE' && bool(m, 'use_random', true)));
  const deps = list
    .flatMap((m) => [m.object, m.offset_object, m.target].filter((x): x is string => typeof x === 'string'))
    .map((id) => {
      const ev = app.graph.get(id);
      // targets' transforms (and poses, for armatures) feed the result
      const lat = ev?.ob.type === 'LATTICE' && ev.ob.data ? c.doc.lattices?.[ev.ob.data]?.points : undefined;
      return ev ? `${ev.world.elements.map((x) => x.toFixed(4)).join(',')}${ev.pose ? `:${ev.pose.signature}` : ''}${lat ? `:${identity(lat)}` : ''}${ev.geomVersion ? `:${ev.geomVersion}` : ''}` : '';
    });
  const key = `${c.layerIndex}|${c.layer.name}|${c.layer.pass_index ?? 0}|${JSON.stringify(list)}|${timeDep ? `${c.frame}|${c.keyFrame}|${c.prevStrokeCount}` : ''}|${deps.join(';')}|${c.world.elements.join(',')}|${c.gp.materials.join(',')}`;
  let per = cache.get(d);
  const hit = per?.get(key);
  if (hit) return hit;
  let strokes = toStrokes(normalizeDrawing(d));
  for (const m of list) {
    const k = kernels[m.type];
    const inScope = passes(m, c, null);
    if (!inScope) continue;
    const before = strokes;
    // per stroke material filters: only the passing strokes go through the kernel (order kept)
    const mask = strokes.map((s) => passes(m, c, s));
    if (mask.every(Boolean)) strokes = k(strokes, m, c);
    else {
      const sel = strokes.filter((_, i) => mask[i]);
      const rest = strokes.filter((_, i) => !mask[i]);
      strokes = [...rest, ...k(sel, m, c)];
    }
    const vg = str(m, 'vertex_group_name');
    if (vg && WEIGHTED.has(m.type) && mask.every(Boolean)) strokes = weighByGroup(before, strokes, vg, bool(m, 'invert_vertex_group'));
  }
  const out = fromStrokes(strokes);
  if (!per) cache.set(d, (per = new Map()));
  if (per.size > 8) per.clear();
  per.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// registration (listed only for grease pencil objects)

const filters = () => ({
  layer_filter: '',
  invert_layer_filter: false,
  use_layer_pass_filter: false,
  layer_pass_filter: 0,
  invert_layer_pass_filter: false,
  material_filter: null,
  invert_material_filter: false,
  use_material_pass_filter: false,
  material_pass_filter: 0,
  invert_material_pass_filter: false,
});

interface Def {
  type: string;
  label: string;
  category: 'EDIT' | 'GENERATE' | 'DEFORM' | 'COLOR';
  icon: string;
  defaults: M;
  deps?: (m: ModifierBase) => (string | null | undefined)[];
}

export const GP_MODIFIERS: Def[] = [
  { type: 'GREASE_PENCIL_VERTEX_WEIGHT_ANGLE', label: 'Vertex Weight Angle', category: 'EDIT', icon: 'mod_vertex_weight', defaults: { target_vertex_group: '', angle: 0, axis: 'Y', space: 'LOCAL', minimum_weight: 0, use_multiply: false, use_invert_output: false } },
  { type: 'GREASE_PENCIL_VERTEX_WEIGHT_PROXIMITY', label: 'Vertex Weight Proximity', category: 'EDIT', icon: 'mod_vertex_weight', defaults: { target_vertex_group: '', object: null, distance_start: 0, distance_end: 20, minimum_weight: 0, use_multiply: false, use_invert_output: false }, deps: (m) => [m.object as string] },
  { type: 'GREASE_PENCIL_TIME', label: 'Time Offset', category: 'EDIT', icon: 'mod_time', defaults: { mode: 'NORMAL', offset: 1, frame_scale: 1, frame_start: 1, frame_end: 250, use_keep_loop: true, use_custom_frame_range: false } },
  { type: 'GREASE_PENCIL_ARRAY', label: 'Array', category: 'GENERATE', icon: 'mod_array', defaults: { count: 2, use_relative_offset: true, relative_offset: [1, 0, 0], use_constant_offset: false, constant_offset: [0, 0, 0], use_object_offset: false, offset_object: null, random_offset: [0, 0, 0], random_rotation: [0, 0, 0], random_scale: [0, 0, 0], use_uniform_random_scale: false, seed: 1, replace_material: 0 }, deps: (m) => [m.offset_object as string] },
  { type: 'GREASE_PENCIL_BUILD', label: 'Build', category: 'GENERATE', icon: 'mod_build', defaults: { mode: 'SEQUENTIAL', transition: 'GROW', time_mode: 'FRAMES', start_delay: 0, length: 100, concurrent_time_alignment: 'START', use_restrict_frame_range: false, frame_start: 1, frame_end: 125, percentage_factor: 0 } },
  { type: 'GREASE_PENCIL_DASH', label: 'Dot Dash', category: 'GENERATE', icon: 'mod_dash', defaults: { dash_offset: 0, segments: [{ name: 'Segment', dash: 2, gap: 1, radius: 1, opacity: 1, material_index: -1, use_cyclic: false }] } },
  { type: 'GREASE_PENCIL_ENVELOPE', label: 'Envelope', category: 'GENERATE', icon: 'mod_envelope', defaults: { mode: 'SEGMENTS', spread: 10, skip: 0, thickness: 1, strength: 1, mat_nr: -1 } },
  { type: 'GREASE_PENCIL_LENGTH', label: 'Length', category: 'GENERATE', icon: 'mod_length', defaults: { mode: 'RELATIVE', start_factor: 0.1, end_factor: 0.1, start_length: 0.1, end_length: 0.1, use_random: false, random_start_factor: 0, random_end_factor: 0, seed: 0 } },
  { type: 'GREASE_PENCIL_MIRROR', label: 'Mirror', category: 'GENERATE', icon: 'mod_mirror', defaults: { use_axis_x: true, use_axis_y: false, use_axis_z: false, object: null }, deps: (m) => [m.object as string] },
  { type: 'GREASE_PENCIL_MULTIPLY', label: 'Multiple Strokes', category: 'GENERATE', icon: 'mod_multiply', defaults: { duplicates: 3, distance: 0.1, offset: 0, use_fade: false, fading_center: 0.5, fading_thickness: 0.5, fading_opacity: 0.5 } },
  { type: 'GREASE_PENCIL_OUTLINE', label: 'Outline', category: 'GENERATE', icon: 'mod_outline', defaults: { thickness: 1, subdivision: 3, outline_material: null } },
  { type: 'GREASE_PENCIL_SIMPLIFY', label: 'Simplify', category: 'GENERATE', icon: 'mod_simplify', defaults: { mode: 'FIXED', step: 1, factor: 0, length: 0.1, distance: 0.1 } },
  { type: 'GREASE_PENCIL_SUBDIV', label: 'Subdivide', category: 'GENERATE', icon: 'mod_subsurf', defaults: { level: 1, subdivision_type: 'CATMULL_CLARK' } },
  { type: 'GREASE_PENCIL_ARMATURE', label: 'Armature', category: 'DEFORM', icon: 'mod_armature', defaults: { object: null, use_vertex_groups: true, use_bone_envelopes: false, use_deform_preserve_volume: false }, deps: (m) => [m.object as string] },
  { type: 'GREASE_PENCIL_HOOK', label: 'Hook', category: 'DEFORM', icon: 'hook', defaults: { object: null, strength: 1, falloff_radius: 0, center: [0, 0, 0], matrix_inverse: new Matrix4().toArray() }, deps: (m) => [m.object as string] },
  { type: 'GREASE_PENCIL_LATTICE', label: 'Lattice', category: 'DEFORM', icon: 'mod_lattice', defaults: { object: null, strength: 1 }, deps: (m) => [m.object as string] },
  { type: 'GREASE_PENCIL_NOISE', label: 'Noise', category: 'DEFORM', icon: 'mod_noise', defaults: { factor: 0.5, factor_strength: 0, factor_thickness: 0, noise_scale: 1, noise_offset: 0, use_random: true, random_mode: 'STEP', step: 4, seed: 1 } },
  { type: 'GREASE_PENCIL_OFFSET', label: 'Offset', category: 'DEFORM', icon: 'mod_offset', defaults: { offset_mode: 'RANDOM', location: [0, 0, 0], rotation: [0, 0, 0], scale: [0, 0, 0], stroke_location: [0, 0, 0], stroke_rotation: [0, 0, 0], stroke_scale: [0, 0, 0], seed: 0, stroke_step: 1, stroke_start_offset: 0, use_uniform_random_scale: false } },
  { type: 'GREASE_PENCIL_SHRINKWRAP', label: 'Shrinkwrap', category: 'DEFORM', icon: 'mod_shrinkwrap', defaults: { target: null, wrap_method: 'NEAREST_SURFACEPOINT', offset: 0.05 }, deps: (m) => [m.target as string] },
  { type: 'GREASE_PENCIL_SMOOTH', label: 'Smooth', category: 'DEFORM', icon: 'mod_smooth', defaults: { factor: 1, step: 1, use_edit_position: true, use_edit_strength: false, use_edit_thickness: false, use_keep_shape: false, use_smooth_ends: false } },
  { type: 'GREASE_PENCIL_THICKNESS', label: 'Thickness', category: 'DEFORM', icon: 'mod_thickness', defaults: { thickness: 0.02, thickness_factor: 1, use_uniform_thickness: false } },
  { type: 'GREASE_PENCIL_COLOR', label: 'Hue/Saturation', category: 'COLOR', icon: 'mod_hue_saturation', defaults: { color_mode: 'BOTH', hue: 0.5, saturation: 1, value: 1 } },
  { type: 'GREASE_PENCIL_OPACITY', label: 'Opacity', category: 'COLOR', icon: 'mod_opacity', defaults: { color_mode: 'BOTH', color_factor: 1, use_uniform_opacity: false } },
  { type: 'GREASE_PENCIL_TINT', label: 'Tint', category: 'COLOR', icon: 'mod_tint', defaults: { color_mode: 'BOTH', factor: 0.5, color: [1, 1, 1] } },
];

for (const d of GP_MODIFIERS)
  registerModifier({
    type: d.type,
    label: d.label,
    category: d.category,
    icon: d.icon,
    objectTypes: ['GREASEPENCIL'],
    defaults: () => ({ ...filters(), ...structuredClone(d.defaults) }),
    deps: d.deps,
    // evaluated by the grease pencil renderer, not the mesh stack
    apply: (mesh) => mesh,
  });
