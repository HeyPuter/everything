// Expand: grow a mask or a face set from the vertex under the cursor following a falloff field
// (geodesic, topology, normals, spherical, face set boundary). The cursor picks how far it goes.
import { app, registerOperators, type OpContext } from '../app/app';
import { cow } from '../data/cow';
import type { MeshData } from '../data/types';
import { renderContext } from '../render/context';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { activeMeshData, meshSession, type MeshSession } from './session';
import { invalidatePaintAttributes, maskChanged } from './display';
import { faceCount, faceSetsOf, hiddenFacesOf, maxFaceSet } from './fsdata';
import { sculptPoll } from './facesetops';
import { editableMask } from './gestureops';
import { distortField, expandInside, expandSources, expandValue, faceNeighbors, geodesicDistances, normalAngles, normalizeField, sphericalDistances, topologySteps, type ExpandFalloff } from './expandmath';
import { activeBrush } from './brushes';
import { falloff as brushFalloff } from './math';
import { proceduralTex3, sampleTex, textureActive } from './brushtex';

const FALLOFFS: [ExpandFalloff, string, string][] = [
  ['GEODESIC', 'Geodesic', 'Distance along the surface'],
  ['TOPOLOGY', 'Topology', 'Number of edges from the origin'],
  ['TOPOLOGY_DIAGONALS', 'Topology Diagonals', 'Number of faces from the origin'],
  ['NORMALS', 'Normals', 'Angle to the normal of the origin'],
  ['SPHERICAL', 'Spherical', 'Straight distance from the origin'],
  ['BOUNDARY_TOPOLOGY', 'Boundary Topology', 'Distance from the mesh boundary'],
  ['BOUNDARY_FACE_SET', 'Active Face Set', 'Distance from the border of the face set under the cursor'],
];

/** Vertex of the face under a viewport pixel closest to the hit point, plus the face. */
function vertexUnder(s: MeshSession, v: View3D, x: number, y: number): { vert: number; face: number } | null {
  const hit = s.raycast(v, x, y);
  if (!hit) return null;
  let best = -1,
    bd = Infinity;
  for (let c = s.offsets[hit.face]; c < s.offsets[hit.face + 1]; c++) {
    const vi = s.indices[c];
    const d = Math.hypot(s.positions[vi * 3] - hit.point.x, s.positions[vi * 3 + 1] - hit.point.y, s.positions[vi * 3 + 2] - hit.point.z);
    if (d < bd) {
      bd = d;
      best = vi;
    }
  }
  return best < 0 ? null : { vert: best, face: hit.face };
}

/** Normalized falloff field for the expansion. */
export function expandField(s: MeshSession, me: MeshData, falloff: ExpandFalloff, origin: number, activeSet: number): Float32Array {
  const nb = s.neighbors;
  const hid = s.hiddenV;
  switch (falloff) {
    case 'TOPOLOGY':
      return normalizeField(topologySteps(nb.offsets, nb.neighbors, [origin], hid));
    case 'TOPOLOGY_DIAGONALS': {
      const fnb = faceNeighbors(s.offsets, s.indices, s.nv);
      return normalizeField(topologySteps(fnb.offsets, fnb.nb, [origin], hid));
    }
    case 'NORMALS':
      return normalizeField(normalAngles(s.vn, origin, topologySteps(nb.offsets, nb.neighbors, [origin], hid)));
    case 'SPHERICAL':
      return normalizeField(sphericalDistances(s.positions, origin));
    case 'BOUNDARY_TOPOLOGY':
    case 'BOUNDARY_FACE_SET': {
      // distance from the border of the region (mesh boundary, or the face set's border)
      const fs = faceSetsOf(me);
      const sources: number[] = [];
      const vf = s.vf;
      for (let v = 0; v < s.nv; v++) {
        const a = vf.offsets[v],
          b = vf.offsets[v + 1];
        if (falloff === 'BOUNDARY_FACE_SET') {
          let inSet = false,
            outSet = false;
          for (let k = a; k < b; k++) {
            if ((fs ? fs[vf.faces[k]] : 1) === activeSet) inSet = true;
            else outSet = true;
          }
          if (inSet && outSet) sources.push(v);
        } else {
          for (let k = nb.offsets[v]; k < nb.offsets[v + 1]; k++) {
            // an edge with a single face marks the boundary
            const u = nb.neighbors[k];
            let shared = 0;
            for (let j = a; j < b; j++) {
              const f = vf.faces[j];
              for (let c = s.offsets[f]; c < s.offsets[f + 1]; c++) if (s.indices[c] === u) shared++;
            }
            if (shared === 1) {
              sources.push(v);
              break;
            }
          }
        }
      }
      if (!sources.length) sources.push(origin);
      return normalizeField(geodesicDistances(s.positions, nb.offsets, nb.neighbors, sources, hid));
    }
    default:
      return normalizeField(geodesicDistances(s.positions, nb.offsets, nb.neighbors, [origin], hid));
  }
}

interface ExpandState {
  me: MeshData;
  s: MeshSession;
  field: Float32Array;
  origMask: Float32Array | null;
  origSets: Int32Array | null;
}

/** Write the expansion for the props into the mesh (mask or face sets). */
function applyExpand(st: ExpandState, p: Record<string, unknown>) {
  const { me, s, field } = st;
  const opts = { invert: !!p.invert, gradient: !!p.use_falloff_gradient, loops: p.loop_count as number };
  // the gradient can follow the falloff curve of the active brush
  const fo = p.use_brush_gradient && opts.gradient ? activeBrush('SCULPT')?.falloff : null;
  const value = (f: number) => {
    const x = expandValue(f, thr, opts);
    return fo && x > 0 && x < 1 ? brushFalloff(fo, 1 - x) : x;
  };
  const thr = p.threshold as number;
  const hid = s.hiddenV;
  // snapping: whole face sets join as soon as one of their vertices is reached
  let snapIn: Uint8Array | null = null;
  const fsets = faceSetsOf(me);
  if (p.use_snap && fsets) {
    const ids = new Set<number>();
    for (let f = 0; f < s.nf; f++)
      for (let c = s.offsets[f]; c < s.offsets[f + 1]; c++)
        if (expandInside(field[s.indices[c]], thr, opts)) {
          ids.add(fsets[f]);
          break;
        }
    snapIn = new Uint8Array(s.nv);
    for (let f = 0; f < s.nf; f++) if (ids.has(fsets[f])) for (let c = s.offsets[f]; c < s.offsets[f + 1]; c++) snapIn[s.indices[c]] = 1;
  }
  if (p.target === 'MASK') {
    const mask = me.sculpt_mask!;
    for (let v = 0; v < s.nv; v++) {
      if (hid?.[v]) continue;
      const val = snapIn ? snapIn[v] : value(field[v]);
      const o = st.origMask ? st.origMask[v] : 0;
      mask[v] = p.use_mask_preserve ? Math.max(o, val) : val;
    }
    maskChanged(mask);
  } else {
    const base = st.origSets ?? new Int32Array(faceCount(me)).fill(1);
    const out = base.slice();
    const id = p.use_modify_active ? (p.active_face_set as number) : maxFaceSet(st.origSets) + 1;
    const hf = hiddenFacesOf(me);
    for (let f = 0; f < s.nf; f++) {
      if (hf?.[f]) continue;
      let all = true;
      for (let c = s.offsets[f]; c < s.offsets[f + 1]; c++)
        if (snapIn ? !snapIn[s.indices[c]] : !expandInside(field[s.indices[c]], thr, opts)) {
          all = false;
          break;
        }
      if (all) out[f] = id;
    }
    me.sculpt_face_set = out;
  }
  invalidatePaintAttributes();
  renderContext?.engine.requestDraw();
}

function prepare(me: MeshData, s: MeshSession, p: Record<string, unknown>): ExpandState | null {
  const origin = p.origin as number;
  if (origin < 0 || origin >= s.nv) return null;
  const st: ExpandState = { me, s, field: expandField(s, me, p.falloff_type as ExpandFalloff, origin, p.active_face_set as number), origMask: null, origSets: faceSetsOf(me) };
  if (p.target === 'MASK') {
    const had = me.sculpt_mask && me.sculpt_mask.length === s.nv ? me.sculpt_mask.slice() : null;
    editableMask(me);
    st.origMask = had;
  }
  return st;
}

function startExpand(ctx: OpContext, p: Record<string, unknown>): 'RUNNING_MODAL' | 'CANCELLED' {
  const v = activeView3D();
  const am = activeMeshData();
  const s = meshSession();
  if (!v || !am || !s || app.modal) return 'CANCELLED';
  const r = v.el.getBoundingClientRect();
  const { me } = am;
  const prevMask = me.sculpt_mask,
    prevSets = me.sculpt_face_set;
  let st: ExpandState | null = null;
  // the origin is the vertex under the cursor; from a menu it is picked on the first move over the mesh
  const begin = (x: number, y: number) => {
    const under = vertexUnder(s, v, x, y);
    if (!under) return false;
    p.origin = under.vert;
    p.active_face_set = faceSetsOf(me)?.[under.face] ?? 1;
    p.threshold = 0;
    st = prepare(me, s, p);
    if (st) applyExpand(st, p);
    return !!st;
  };
  begin((ctx.event?.x ?? app.pointer.x) - r.left, (ctx.event?.y ?? app.pointer.y) - r.top);
  let moving = false;
  const update = (e?: PointerEvent) => {
    if (e) {
      const q = v.local(e);
      if (!st) {
        begin(q.x, q.y);
        app.changed('ui');
        return;
      }
      if (moving) {
        // move the origin, keeping the distance
        const u = vertexUnder(s, v, q.x, q.y);
        if (u) {
          p.origin = u.vert;
          setField(expandField(s, me, p.falloff_type as ExpandFalloff, u.vert, p.active_face_set as number));
          applyExpand(st!, p);
          app.changed('ui');
        }
        return;
      }
      const u = vertexUnder(s, v, q.x, q.y);
      if (u) p.threshold = Math.round(st.field[u.vert] * 10000) / 10000;
    }
    if (!st) return;
    applyExpand(st, p);
    app.changed('ui');
  };
  // texture distortion of the field (T / Y) with the active brush's texture
  const texAt = (vi: number) => {
    const b = activeBrush('SCULPT');
    if (!b || !textureActive(b)) return 0.5;
    const t = b.texture_slot!;
    const sc = Math.max(1e-3, t.scale);
    const x = s.positions[vi * 3] / sc,
      y = s.positions[vi * 3 + 1] / sc,
      z = s.positions[vi * 3 + 2] / sc;
    return t.source === 'IMAGE' ? sampleTex(t, x, y) : proceduralTex3(t.source, x, y, z);
  };
  let base: Float32Array | null = null;
  const setField = (f: Float32Array) => {
    base = f;
    if (st) st = { ...st, field: distortField(f, (p.texture_distortion as number) || 0, texAt) };
  };
  const recompute = (f: ExpandFalloff) => {
    p.falloff_type = f;
    if (st) setField(expandField(s, me, f, p.origin as number, p.active_face_set as number));
    update();
  };
  // recursion: the current expansion becomes the origin of a new field
  const recurse = (topology: boolean) => {
    if (!st) return;
    const opts = { invert: !!p.invert, loops: p.loop_count as number };
    let src = expandSources(st.field, p.threshold as number, opts);
    if (!src.length) src = [p.origin as number];
    const nb = s.neighbors;
    setField(normalizeField(topology ? topologySteps(nb.offsets, nb.neighbors, src, s.hiddenV) : geodesicDistances(s.positions, nb.offsets, nb.neighbors, src, s.hiddenV)));
    p.threshold = 0;
    update();
  };
  app.startModal({
    label: 'Expand',
    onPointerMove: (e) => update(e),
    onPointerDown: (e) => (e.button === 2 ? 'CANCELLED' : e.button === 0 ? (st ? 'FINISHED' : 'CANCELLED') : undefined),
    onKey: (e) => {
      const k = e.key.toLowerCase();
      // hold Space to move the origin, hold Ctrl to snap to whole face sets
      if (k === ' ' || e.code === 'Space') {
        moving = e.type === 'keydown';
        return true;
      }
      if (k === 'control' || k === 'meta') {
        p.use_snap = e.type === 'keydown';
        update();
        return true;
      }
      if (e.type !== 'keydown') return true;
      if (k === 'escape') return 'CANCELLED';
      if (k === 'enter') return st ? 'FINISHED' : 'CANCELLED';
      if (k === 'f') p.invert = !p.invert;
      else if (k === 'e') p.use_mask_preserve = !p.use_mask_preserve;
      else if (k === 'g') p.use_falloff_gradient = !p.use_falloff_gradient;
      else if (k === 'r') return recurse(e.altKey), true;
      else if (k === 'b') p.use_brush_gradient = !p.use_brush_gradient;
      else if (k === 'y' || k === 't') {
        p.texture_distortion = Math.max(0, Math.round((((p.texture_distortion as number) || 0) + (k === 'y' ? 0.1 : -0.1)) * 10) / 10);
        if (st) setField(base ?? st.field);
        if (!activeBrush('SCULPT') || !textureActive(activeBrush('SCULPT')!)) app.report('INFO', 'Texture distortion uses the texture of the active brush');
      } else if (k === 'w') p.loop_count = Math.min(20, (p.loop_count as number) + 1);
      else if (k === 'q') p.loop_count = Math.max(1, (p.loop_count as number) - 1);
      else if (k === '1') return recompute('GEODESIC'), true;
      else if (k === '2') return recompute('TOPOLOGY'), true;
      else if (k === '3') return recompute('TOPOLOGY_DIAGONALS'), true;
      else if (k === '4') return recompute('SPHERICAL'), true;
      else return true;
      update();
      return true;
    },
    cancel: () => {
      me.sculpt_mask = prevMask;
      me.sculpt_face_set = prevSets;
      if (prevMask) maskChanged(prevMask);
      invalidatePaintAttributes();
      renderContext?.engine.requestDraw();
    },
    header: () =>
      `Expand ${p.target === 'MASK' ? 'Mask' : 'Face Set'} (${FALLOFFS.find((f) => f[0] === p.falloff_type)?.[1]}): move to grow, click to apply · F invert${p.invert ? ' ✓' : ''} · E preserve${p.use_mask_preserve ? ' ✓' : ''} · G gradient${p.use_falloff_gradient ? ' ✓' : ''} · B brush gradient${p.use_brush_gradient ? ' ✓' : ''} · Q/W loops ${p.loop_count} · R / Alt R recurse · T/Y distortion ${((p.texture_distortion as number) || 0).toFixed(1)} · 1-4 falloff · Space move · Ctrl snap`,
    redoOp: { idname: 'sculpt.expand', props: p },
  });
  void cow;
  return 'RUNNING_MODAL';
}

registerOperators([
  {
    idname: 'sculpt.expand',
    label: 'Expand',
    description: 'Grow a mask or a face set from the vertex under the cursor; the cursor sets how far',
    props: [
      {
        id: 'target',
        label: 'Data Target',
        type: 'enum',
        default: 'MASK',
        items: [
          ['MASK', 'Mask', 'Expand the mask'],
          ['FACE_SETS', 'Face Sets', 'Expand a face set'],
        ],
      },
      { id: 'falloff_type', label: 'Falloff Type', type: 'enum', default: 'GEODESIC', items: FALLOFFS },
      { id: 'threshold', label: 'Distance', type: 'float', default: 0, min: 0, max: 1, subtype: 'factor' },
      { id: 'invert', label: 'Invert', type: 'bool', default: false },
      { id: 'use_mask_preserve', label: 'Preserve Previous', type: 'bool', default: false },
      { id: 'use_falloff_gradient', label: 'Falloff Gradient', type: 'bool', default: false },
      { id: 'use_modify_active', label: 'Modify Active', type: 'bool', default: false },
      { id: 'loop_count', label: 'Loops', type: 'int', default: 1, min: 1, max: 20 },
      { id: 'origin', label: 'Origin', type: 'int', default: -1, hidden: true },
      { id: 'active_face_set', label: 'Active Face Set', type: 'int', default: 1, hidden: true },
      { id: 'use_auto_mask', label: 'Auto Create', type: 'bool', default: false, hidden: true },
      { id: 'use_snap', label: 'Snap to Face Sets', type: 'bool', default: false },
      { id: 'use_brush_gradient', label: 'Brush Gradient', type: 'bool', default: false, hidden: true },
      { id: 'texture_distortion', label: 'Texture Distortion', type: 'float', default: 0, min: 0, max: 10, hidden: true },
    ],
    poll: sculptPoll,
    invoke: (ctx, p) => startExpand(ctx, p),
    exec: (_ctx, p) => {
      const am = activeMeshData();
      const s = meshSession();
      if (!am || !s) return 'CANCELLED';
      const st = prepare(am.me, s, p);
      if (!st) return 'CANCELLED';
      applyExpand(st, p);
    },
  },
]);
