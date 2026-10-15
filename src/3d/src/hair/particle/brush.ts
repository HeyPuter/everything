// Particle Edit brushes: Comb, Smooth, Add, Length, Puff, Cut and Weight on edited hair keys.
// Brushes act on visible hair (tips only in Tip select mode); roots stay put.
import { Vector3 } from 'three';
import { app } from '../../app/app';
import type { View3D } from '../../editors/view3d/view3d';
import { runStroke } from '../../paint/stroke';
import type { EditedHair } from '../../physics/types';
import { combDab, falloff, growShrinkDab, newStrandShape, puffDab, restoreLengths, rootsOf, segmentLengths, smoothDab, trimPolyline, type BrushParams, type Projector } from '../brushmath';
import { projectorFor } from '../common';
import { rng } from '../data';
import { Surface } from '../surface';
import { activePE, editableKeys, peBrush, peSettings, setEd } from './mode';
import { fromStrandLists, keyCount, strandCount, toStrandLists } from './keys';

/** Soft mask of the keys brushes may move (hidden hair and roots excluded; tips only in Tip mode). */
function keyMask(ed: EditedHair, tipOnly: boolean): Float32Array {
  const ok = editableKeys(ed, tipOnly ? 'TIP' : 'POINT');
  return Float32Array.from(ok);
}

/** Keys pushed out of the emitter surface to at least `dist`. */
function deflect(ed: EditedHair, s: Surface, dist: number, strands: number[]) {
  const p = new Vector3();
  for (const st of strands)
    for (let k = ed.key_offsets[st] + 1; k < ed.key_offsets[st + 1]; k++) {
      p.fromArray(ed.co, k * 3);
      const h = s.closest(p);
      if (!h) continue;
      const d = p.clone().sub(h.point).dot(h.normal);
      if (d >= dist) continue;
      p.addScaledVector(h.normal, dist - d).toArray(ed.co, k * 3);
    }
}

let seed = 1;

export function startParticleStroke(v: View3D, e: PointerEvent, tool: string, invert: boolean) {
  const a = activePE();
  if (!a) return;
  const { psys, ob } = a;
  const pe = peSettings(app.doc);
  const b = peBrush(app.doc, tool);
  const before = psys.edited_hair!;
  let ed: EditedHair = { ...before, co: before.co.slice(), weight: before.weight.slice() };
  psys.edited_hair = ed;
  const w = app.graph.get(ob.id)?.world.clone();
  if (!w) return;
  const mesh = app.graph.get(ob.id)?.mesh;
  const surface = mesh && mesh.indices.length ? Surface.of(mesh) : null;
  const proj = (): Projector => projectorFor(v, w);
  let lengths = segmentLengths({ positions: ed.co, offsets: ed.key_offsets });
  const tipOnly = pe.select_mode === 'TIP';
  const rand = rng(seed++);
  let prev: { x: number; y: number } | null = null;
  let changed = false;
  const normals = () => {
    const n = new Float32Array(strandCount(ed) * 3);
    for (let s = 0; s < strandCount(ed); s++) {
      const r = new Vector3().fromArray(ed.co, ed.key_offsets[s] * 3);
      const h = surface?.closest(r);
      (h ? h.normal : new Vector3(0, 0, 1)).toArray(n, s * 3);
    }
    return n;
  };
  const rootNormals = tool === 'builtin.particle_puff' ? normals() : null;

  runStroke(v, e, {
    spacing: () => (tool === 'builtin.particle_add' ? 50 : 0),
    radiusPx: () => b.size,
    settings: () => ({ stroke_method: 'SPACE' }),
    dab: (d) => {
      const strands = { positions: ed.co, offsets: ed.key_offsets };
      const bp: BrushParams = { x: d.x, y: d.y, radius: b.size, strength: b.strength * d.pressure, falloff: 'SMOOTH', mask: keyMask(ed, tipOnly) };
      const dx = prev ? d.x - prev.x : 0,
        dy = prev ? d.y - prev.y : 0;
      const at = prev ? { ...bp, x: prev.x, y: prev.y } : bp;
      prev = { x: d.x, y: d.y };
      let touched: number[] = [];
      switch (tool) {
        case 'builtin.particle_comb':
          touched = combDab(strands, proj(), { ...at, strength: Math.min(1, at.strength * 2) }, dx, dy, pe.use_preserve_length ? lengths : segmentLengths(strands));
          if (!pe.use_preserve_length) lengths = segmentLengths(strands);
          break;
        case 'builtin.particle_smooth':
          touched = smoothDab(strands, proj(), bp);
          if (pe.use_preserve_length) for (const s of touched) restoreLengths(ed.co, ed.key_offsets[s], ed.key_offsets[s + 1], lengths);
          break;
        case 'builtin.particle_length': {
          const grow = (b.length_mode ?? 'GROW') === 'GROW' ? !invert : invert;
          touched = growShrinkDab(strands, proj(), bp, grow, { uniform: true, rate: 0.04 });
          if (touched.length) lengths = segmentLengths(strands);
          break;
        }
        case 'builtin.particle_puff':
          if (rootNormals) {
            const add = (b.puff_mode ?? 'ADD') === 'ADD' ? !invert : invert;
            touched = puffDab(strands, proj(), bp, rootNormals, lengths, !add);
          }
          break;
        case 'builtin.particle_weight': {
          // the brush strength is the weight painted
          const p = proj();
          const S = new Float64Array(3);
          const mask = bp.mask!;
          for (let k = 0; k < keyCount(ed); k++) {
            if (!mask[k]) continue;
            p.toScreen(ed.co[k * 3], ed.co[k * 3 + 1], ed.co[k * 3 + 2], S);
            const dd = Math.hypot(S[0] - d.x, S[1] - d.y);
            if (dd >= b.size) continue;
            const f = falloff(dd / b.size);
            ed.weight[k] += ((invert ? 0 : b.strength) - ed.weight[k]) * f;
            changed = true;
          }
          break;
        }
        case 'builtin.particle_cut': {
          const cut = cutDab(ed, proj(), bp);
          if (cut) {
            ed = psys.edited_hair = cut;
            lengths = segmentLengths({ positions: ed.co, offsets: ed.key_offsets });
            changed = true;
          }
          break;
        }
        case 'builtin.particle_add': {
          if (!surface) break;
          const made = addHairs(v, ob, ed, surface, d.x, d.y, b, pe, rand);
          if (made) {
            ed = psys.edited_hair = made;
            lengths = segmentLengths({ positions: ed.co, offsets: ed.key_offsets });
            changed = true;
          }
          break;
        }
      }
      if (touched.length) {
        changed = true;
        if (surface && pe.use_emitter_deflect) deflect(ed, surface, pe.emitter_distance, touched);
      }
    },
    update: () => {
      if (!changed) return;
      ed = psys.edited_hair = { ...ed, co: ed.co.slice(), weight: ed.weight.slice() };
      app.changed('doc');
    },
    end: () => {
      if (changed) app.pushUndo(`Particle ${tool.replace('builtin.particle_', '').replace(/^./, (c) => c.toUpperCase())}`);
      app.changed('doc');
    },
    cancel: () => {
      setEd(psys, before);
      app.changed('doc');
    },
  });
}

/** Cut: hair is shortened where the brush crosses it (hair cut at the root is removed). */
export function cutDab(ed: EditedHair, p: Projector, b: BrushParams): EditedHair | null {
  const S = new Float64Array(3);
  const lists = toStrandLists(ed);
  let any = false;
  const out: typeof lists = [];
  lists.forEach((s) => {
    if (s.hide) {
      out.push(s);
      return;
    }
    const n = s.weight.length;
    let cut = -1;
    for (let k = 0; k < n; k++) {
      p.toScreen(s.co[k * 3], s.co[k * 3 + 1], s.co[k * 3 + 2], S);
      if (Math.hypot(S[0] - b.x, S[1] - b.y) < b.radius) {
        cut = k;
        break;
      }
    }
    if (cut < 0) {
      out.push(s);
      return;
    }
    any = true;
    if (cut === 0) return;
    // the hair ends half way into the segment entering the brush
    let len = 0;
    for (let k = 1; k <= cut; k++) len += Math.hypot(s.co[k * 3] - s.co[k * 3 - 3], s.co[k * 3 + 1] - s.co[k * 3 - 2], s.co[k * 3 + 2] - s.co[k * 3 - 1]);
    const last = Math.hypot(s.co[cut * 3] - s.co[cut * 3 - 3], s.co[cut * 3 + 1] - s.co[cut * 3 - 2], s.co[cut * 3 + 2] - s.co[cut * 3 - 1]);
    out.push({ ...s, co: trimPolyline(s.co, Math.max(1e-4, len - last / 2), n) });
  });
  return any ? fromStrandLists(out) : null;
}

/** Add: new hair at surface hits under the brush, shaped like their neighbours (or straight). */
function addHairs(v: View3D, ob: import('../../data/types').ObjectData, ed: EditedHair, s: Surface, x: number, y: number, b: { size: number; count?: number }, pe: ReturnType<typeof peSettings>, rand: () => number): EditedHair | null {
  const w = app.graph.get(ob.id)!.world;
  const inv = w.clone().invert();
  const roots = rootsOf({ positions: ed.co, offsets: ed.key_offsets });
  const lists = toStrandLists(ed);
  const ns = strandCount(ed);
  // average hair length and key count for straight new hair
  let avgLen = 0;
  for (let st = 0; st < ns; st++) {
    let l = 0;
    for (let k = ed.key_offsets[st] + 1; k < ed.key_offsets[st + 1]; k++) l += Math.hypot(ed.co[k * 3] - ed.co[k * 3 - 3], ed.co[k * 3 + 1] - ed.co[k * 3 - 2], ed.co[k * 3 + 2] - ed.co[k * 3 - 1]);
    avgLen += l;
  }
  avgLen = ns ? avgLen / ns : 0.1;
  const count = Math.max(1, Math.round(b.count ?? 10));
  const added: typeof lists = [];
  for (let i = 0; i < count; i++) {
    const ang = rand() * Math.PI * 2,
      r = Math.sqrt(rand()) * b.size;
    const ray = v.ray(x + Math.cos(ang) * r, y + Math.sin(ang) * r);
    const hit = s.raycast(ray.origin.clone().applyMatrix4(inv), ray.dir.clone().transformDirection(inv));
    if (!hit) continue;
    const root: [number, number, number] = [hit.point.x, hit.point.y, hit.point.z];
    // nearest existing hair for interpolation
    const nb = [];
    if (pe.use_default_interpolate && ns) {
      const best: { st: number; d: number }[] = [];
      for (let st = 0; st < ns; st++) {
        const d = Math.hypot(roots[st * 3] - root[0], roots[st * 3 + 1] - root[1], roots[st * 3 + 2] - root[2]);
        best.push({ st, d });
      }
      best.sort((p, q) => p.d - q.d);
      for (const { st, d } of best.slice(0, 3)) {
        const n = s.closest(new Vector3(roots[st * 3], roots[st * 3 + 1], roots[st * 3 + 2]))?.normal ?? hit.normal;
        nb.push({ root: [roots[st * 3], roots[st * 3 + 1], roots[st * 3 + 2]] as [number, number, number], normal: [n.x, n.y, n.z] as [number, number, number], points: lists[st].co, weight: 1 / Math.max(1e-4, d) });
      }
    }
    const co = newStrandShape(root, [hit.normal.x, hit.normal.y, hit.normal.z], {
      length: avgLen || 0.1,
      points: pe.default_key_count,
      neighbours: nb,
      interpolateLength: true,
      interpolateShape: true,
      interpolatePointCount: true,
    });
    const k = co.length / 3;
    added.push({ co, weight: new Float32Array(k).fill(1), select: new Uint8Array(k), hide: 0 });
  }
  if (!added.length) return null;
  return fromStrandLists([...lists, ...added]);
}
