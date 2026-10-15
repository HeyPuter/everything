// Sculpt Mode transform: Move / Rotate / Scale the unmasked part of the mesh around the sculpt
// pivot (set with Set Pivot), through the regular modal transform.
import { Matrix3, Matrix4, Vector3 } from 'three';
import { app, onAppReady, registerOperators } from '../app/app';
import { cow } from '../data/cow';
import { h, type VNode } from '../ui/h';
import { editModeHooks } from '../editors/view3d/hooks';
import { activeView3D } from '../editors/view3d/view3d';
import { transformProviders, type TElement } from '../ops/transform';
import { gizmoCenterHook, setGizmoCenterHook } from '../editors/view3d/gizmo';
import { activeMeshData, beginGeometryStroke, meshSession, reevaluate } from './session';
import { finishDeform } from './gestureops';
import { sculptPoll } from './facesetops';

/** Sculpt pivot per object, in object space. */
const pivots = new Map<string, Vector3>();

export function sculptPivot(obId: string): Vector3 {
  return pivots.get(obId)?.clone() ?? new Vector3();
}

transformProviders.push({
  collect() {
    if (app.doc.mode !== 'SCULPT') return null;
    const am = activeMeshData();
    const s = meshSession();
    if (!am || !s) return null;
    const { ob, me } = am;
    const old = me.positions;
    beginGeometryStroke(s, me, () => cow(me, 'positions'));
    const orig = old !== me.positions ? old : me.positions.slice();
    const mask = me.sculpt_mask && me.sculpt_mask.length === s.nv ? me.sculpt_mask : null;
    const hid = s.hiddenV;
    const world = s.world().clone();
    const inv = world.clone().invert();
    const pivotWorld = sculptPivot(ob.id).applyMatrix4(world);
    let lastEval = 0;
    const write = () => {
      s.recomputeNormals();
      if (s.direct) {
        const all: number[] = [];
        for (let f = 0; f < s.nf; f++) all.push(f);
        s.writeFaces(all, me.smooth);
        s.flush();
      } else {
        const now = performance.now();
        if (now - lastEval > 40) {
          lastEval = now;
          reevaluate(s);
        }
      }
    };
    const el: TElement = {
      center: pivotWorld,
      basis: new Matrix3().setFromMatrix4(world),
      weight: 1,
      apply(m) {
        const L = inv.clone().multiply(m).multiply(world);
        const e = L.elements;
        const P = s.positions;
        for (let v = 0; v < s.nv; v++) {
          const i = v * 3;
          const x = orig[i],
            y = orig[i + 1],
            z = orig[i + 2];
          const k = hid?.[v] ? 0 : 1 - (mask ? mask[v] : 0);
          if (k <= 0) {
            P[i] = x;
            P[i + 1] = y;
            P[i + 2] = z;
            continue;
          }
          const nx = e[0] * x + e[4] * y + e[8] * z + e[12],
            ny = e[1] * x + e[5] * y + e[9] * z + e[13],
            nz = e[2] * x + e[6] * y + e[10] * z + e[14];
          P[i] = x + (nx - x) * k;
          P[i + 1] = y + (ny - y) * k;
          P[i + 2] = z + (nz - z) * k;
        }
        write();
      },
      restore() {
        s.positions.set(orig);
        write();
      },
    };
    return {
      elements: [el],
      active: pivotWorld.clone(),
      label: 'Transform',
      finish: () => finishDeform(s, me, null),
      cancel: () => {
        s.positions.set(orig);
        write();
        s.finishGeometry();
        if (!s.direct) reevaluate(s);
      },
    };
  },
});

// ---------------------------------------------------------------------------
// pivot

registerOperators([
  {
    idname: 'sculpt.set_pivot_position',
    label: 'Set Pivot Position',
    description: 'Place the pivot used by the sculpt transform tools',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'UNMASKED',
        items: [
          ['ORIGIN', 'Origin', 'The object origin'],
          ['UNMASKED', 'Unmasked', 'The center of the unmasked vertices'],
          ['BORDER', 'Mask Border', 'The center of the border of the mask'],
          ['ACTIVE', 'Active Vertex', 'The vertex under the cursor'],
          ['SURFACE', 'Surface', 'The surface under the cursor'],
        ],
      },
      { id: 'mouse_x', label: 'Mouse X', type: 'float', default: 0, hidden: true },
      { id: 'mouse_y', label: 'Mouse Y', type: 'float', default: 0, hidden: true },
    ],
    poll: sculptPoll,
    invoke: (ctx, p) => {
      const v = activeView3D();
      if (v) {
        const r = v.el.getBoundingClientRect();
        p.mouse_x = (ctx.event?.x ?? app.pointer.x) - r.left;
        p.mouse_y = (ctx.event?.y ?? app.pointer.y) - r.top;
      }
      return setPivot(p);
    },
    exec: (_ctx, p) => setPivot(p),
  },
]);

function setPivot(p: Record<string, unknown>): 'CANCELLED' | void {
  const am = activeMeshData();
  const s = meshSession();
  if (!am || !s) return 'CANCELLED';
  const { ob, me } = am;
  const mask = me.sculpt_mask && me.sculpt_mask.length === s.nv ? me.sculpt_mask : null;
  const P = s.positions;
  const pos = new Vector3();
  if (p.mode === 'ORIGIN') pivots.set(ob.id, pos);
  else if (p.mode === 'ACTIVE' || p.mode === 'SURFACE') {
    const v = activeView3D();
    const hit = v ? s.raycast(v, p.mouse_x as number, p.mouse_y as number) : null;
    if (!hit) return 'CANCELLED';
    if (p.mode === 'SURFACE') pos.copy(hit.point);
    else {
      let bd = Infinity;
      for (let c = s.offsets[hit.face]; c < s.offsets[hit.face + 1]; c++) {
        const vi = s.indices[c];
        const q = new Vector3(P[vi * 3], P[vi * 3 + 1], P[vi * 3 + 2]);
        const d = q.distanceTo(hit.point);
        if (d < bd) {
          bd = d;
          pos.copy(q);
        }
      }
    }
    pivots.set(ob.id, pos);
  } else {
    // weighted center: unmasked vertices, or vertices around the mask border (mask ≈ 0.5)
    let wsum = 0;
    for (let v = 0; v < s.nv; v++) {
      if (s.hiddenV?.[v]) continue;
      const m = mask ? mask[v] : 0;
      const w = p.mode === 'UNMASKED' ? (m < 1 ? 1 - m : 0) : m > 0.2 && m < 0.8 ? 1 : 0;
      if (!w) continue;
      pos.x += P[v * 3] * w;
      pos.y += P[v * 3 + 1] * w;
      pos.z += P[v * 3 + 2] * w;
      wsum += w;
    }
    if (!wsum) return 'CANCELLED';
    pivots.set(ob.id, pos.multiplyScalar(1 / wsum));
  }
  activeView3D()?.drawSvg();
}

// pivot marker
editModeHooks.svg.push((v) => {
  if (app.doc.mode !== 'SCULPT') return null;
  const ob = app.activeObject;
  const piv = ob ? pivots.get(ob.id) : undefined;
  if (!ob || !piv) return null;
  const w = piv.clone().applyMatrix4(app.graph.get(ob.id)?.world ?? new Matrix4());
  const q = v.project(w);
  if (q.z < -1 || q.z > 1) return null;
  return h(
    'g',
    { key: 'sculpt-pivot', 'pointer-events': 'none' },
    h('circle', { cx: q.x, cy: q.y, r: 6, fill: 'none', stroke: '#000000', 'stroke-width': 3, opacity: 0.6 }),
    h('circle', { cx: q.x, cy: q.y, r: 6, fill: 'none', stroke: '#ffffff', 'stroke-width': 1.5 }),
    h('path', { d: `M${q.x - 10} ${q.y}h6M${q.x + 4} ${q.y}h6M${q.x} ${q.y - 10}v6M${q.x} ${q.y + 4}v6`, stroke: '#ffffff', 'stroke-width': 1.2 }),
  ) as VNode;
});

// transform gizmo (Move / Rotate / Scale / Transform tools) sits on the sculpt pivot
// (registered once all modules are loaded: other modes install their hooks at import time)
onAppReady(() => {
  const prevGizmoHook = gizmoCenterHook;
  setGizmoCenterHook(() => {
    if (app.doc.mode !== 'SCULPT') return prevGizmoHook?.() ?? null;
    const ob = app.activeObject;
    if (!ob || ob.type !== 'MESH') return null;
    const w = app.graph.get(ob.id)?.world ?? new Matrix4();
    return { center: sculptPivot(ob.id).applyMatrix4(w), basis: new Matrix3().setFromMatrix4(w) };
  });
});
