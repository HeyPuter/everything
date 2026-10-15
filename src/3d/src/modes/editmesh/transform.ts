// G/R/S support for mesh components, including proportional editing and gizmo centers.
import { Matrix3, Matrix4, Vector3 } from 'three';
import { app } from '../../app/app';
import { transformProviders, type TElement } from '../../ops/transform';
import { editMeshObjects, ensureSelection } from './context';
import { setGizmoCenterHook } from '../../editors/view3d/gizmo';
import { frameHooks, medianHooks } from '../../ops/view3d';
import { Box3 } from 'three';
import { cornerNormals, vertexNeighbors, polyNormal } from '../../mesh/mesh';
import type { MeshData } from '../../data/types';

function falloff(type: string, t: number): number {
  // t: 0 at selection → 1 at radius
  const x = Math.max(0, Math.min(1, 1 - t));
  switch (type) {
    case 'SPHERE':
      return Math.sqrt(1 - (1 - x) * (1 - x));
    case 'ROOT':
      return Math.sqrt(x);
    case 'INVERSE_SQUARE':
      return x * (2 - x);
    case 'SHARP':
      return x * x;
    case 'LINEAR':
      return x;
    case 'CONSTANT':
      return x > 0 ? 1 : 0;
    case 'RANDOM':
      return x * (0.5 + 0.5 * Math.random());
    default:
      return x * x * (3 - 2 * x);
  }
}

/** Average normal (object space) of the selection. */
export function selectionNormal(me: MeshData): Vector3 {
  const n = new Vector3();
  const sel = me.select_vert!;
  for (let f = 0; f < me.offsets.length - 1; f++) {
    let all = true;
    for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (!sel[me.indices[c]]) all = false;
    if (!all) continue;
    const fn = polyNormal(me.positions, me.indices.subarray(me.offsets[f], me.offsets[f + 1]));
    n.add(new Vector3(...fn));
  }
  if (n.lengthSq() < 1e-12) {
    // vertex normals of selected vertices
    const cn = cornerNormals(me);
    for (let c = 0; c < me.indices.length; c++) if (sel[me.indices[c]]) n.add(new Vector3(cn[c * 3], cn[c * 3 + 1], cn[c * 3 + 2]));
  }
  return n.lengthSq() > 0 ? n.normalize() : new Vector3(0, 0, 1);
}

function basisFromNormal(n: Vector3): Matrix3 {
  const z = n.clone().normalize();
  const x = Math.abs(z.z) < 0.9 ? new Vector3(0, 0, 1).cross(z).normalize() : new Vector3(1, 0, 0).cross(z).normalize();
  const y = z.clone().cross(x);
  return new Matrix3().set(x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z);
}

/** per-mesh writers registered while collecting (flush the working positions into the mesh) */
const updaters: (() => void)[] = [];

transformProviders.push({
  collect({ proportional, connected }) {
    const meshes = editMeshObjects();
    if (!meshes.length) return null;
    updaters.length = 0;
    const ts = app.doc.scene.tool_settings;
    const elements: TElement[] = [];
    const finishes: (() => void)[] = [];
    let activePos: Vector3 | undefined;
    for (const { ob, me } of meshes) {
      ensureSelection(me);
      const world = app.graph.get(ob.id)?.world ?? new Matrix4();
      const inv = world.clone().invert();
      const base = me.positions;
      const nv = base.length / 3;
      const sel = me.select_vert!;
      const work = new Float32Array(base);
      // shape keys follow the edited basis offsets
      let any = false;
      for (let i = 0; i < nv; i++) if (sel[i] && !me.hide_vert?.[i]) any = true;
      if (!any) continue;
      const normal = selectionNormal(me);
      const basisObj = basisFromNormal(normal);
      const wrot = new Matrix3().setFromMatrix4(world);
      const basisWorld = wrot.clone().multiply(basisObj);
      // per-vertex normals for shrink/fatten
      const vn = new Float32Array(base.length);
      const vnSel = new Uint8Array(nv);
      const cn = cornerNormals(me);
      // vertices on selected faces follow those faces only (so extruded walls don't tilt them)
      for (const onlySelected of [true, false])
        for (let f = 0; f < me.offsets.length - 1; f++) {
          const s = me.offsets[f],
            e = me.offsets[f + 1];
          let all = true;
          for (let c = s; c < e; c++) if (!sel[me.indices[c]]) all = false;
          if (all !== onlySelected) continue;
          for (let c = s; c < e; c++) {
            const v = me.indices[c] * 3;
            if (!onlySelected && vnSel[me.indices[c]]) continue;
            vn[v] += cn[c * 3];
            vn[v + 1] += cn[c * 3 + 1];
            vn[v + 2] += cn[c * 3 + 2];
            if (onlySelected) vnSel[me.indices[c]] = 1;
          }
        }
      // proportional influence
      const weight = new Float32Array(nv);
      for (let i = 0; i < nv; i++) if (sel[i] && !me.hide_vert?.[i]) weight[i] = 1;
      const dist = new Float32Array(nv).fill(Infinity);
      if (proportional) {
        const radius = ts.proportional_size;
        if (connected) {
          const nb = vertexNeighbors(me);
          const queue: number[] = [];
          for (let i = 0; i < nv; i++)
            if (weight[i]) {
              dist[i] = 0;
              queue.push(i);
            }
          // Dijkstra-lite (BFS with relaxation) in world space
          while (queue.length) {
            const u = queue.shift()!;
            for (let k = nb.offsets[u]; k < nb.offsets[u + 1]; k++) {
              const w = nb.neighbors[k];
              const pu = new Vector3(base[u * 3], base[u * 3 + 1], base[u * 3 + 2]).applyMatrix4(world);
              const pw = new Vector3(base[w * 3], base[w * 3 + 1], base[w * 3 + 2]).applyMatrix4(world);
              const d = dist[u] + pu.distanceTo(pw);
              if (d < dist[w] && d < radius) {
                dist[w] = d;
                queue.push(w);
              }
            }
          }
        } else {
          const selPts: Vector3[] = [];
          for (let i = 0; i < nv; i++) if (weight[i]) selPts.push(new Vector3(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]).applyMatrix4(world));
          for (let i = 0; i < nv; i++) {
            if (weight[i]) {
              dist[i] = 0;
              continue;
            }
            const p = new Vector3(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]).applyMatrix4(world);
            let best = Infinity;
            for (const q of selPts) best = Math.min(best, p.distanceToSquared(q));
            dist[i] = Math.sqrt(best);
          }
        }
        for (let i = 0; i < nv; i++) if (!weight[i] && dist[i] < radius && !me.hide_vert?.[i]) weight[i] = falloff(ts.proportional_edit_falloff, dist[i] / radius);
      }
      const keysBefore = me.shape_keys.map((k) => k.data);
      const activeKey = me.use_shape_key_edit_mode && me.active_shape_key_index > 0 ? me.active_shape_key_index : -1;
      for (let i = 0; i < nv; i++) {
        if (!weight[i]) continue;
        const local = new Vector3(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]);
        const center = local.clone().applyMatrix4(world);
        const n = new Vector3(vn[i * 3], vn[i * 3 + 1], vn[i * 3 + 2]).normalize().transformDirection(world);
        const idx = i;
        const w = weight[i];
        elements.push({
          center,
          basis: basisWorld,
          weight: w,
          distance: dist[i],
          normal: n,
          apply(m: Matrix4) {
            const p = center.clone().applyMatrix4(m).applyMatrix4(inv);
            work[idx * 3] = p.x;
            work[idx * 3 + 1] = p.y;
            work[idx * 3 + 2] = p.z;
            pending.add(me);
          },
          restore() {
            work[idx * 3] = base[idx * 3];
            work[idx * 3 + 1] = base[idx * 3 + 1];
            work[idx * 3 + 2] = base[idx * 3 + 2];
            pending.add(me);
          },
        });
      }
      const pending = new Set<MeshData>();
      updaters.push(() => {
        if (!pending.size) return;
        pending.clear();
        const out = new Float32Array(work);
        if (activeKey >= 0) {
          // edit the active shape key instead of the basis
          const k = me.shape_keys[activeKey];
          me.shape_keys = me.shape_keys.map((kk, j) => (j === activeKey ? { ...kk, data: offsetKey(kk.data, base, out) } : kk));
          void k;
          return;
        }
        me.positions = out;
        // shape keys: the basis key follows edits; others keep their relative offsets
        if (me.shape_keys.length) me.shape_keys = me.shape_keys.map((k, j) => ({ ...k, data: j === 0 ? new Float32Array(out) : offsetKey(keysBefore[j], base, out) }));
      });
      if (ob.id === app.activeObject?.id) {
        const sp: Vector3[] = [];
        for (let i = 0; i < nv; i++) if (sel[i]) sp.push(new Vector3(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]).applyMatrix4(world));
        if (sp.length) activePos = sp[sp.length - 1];
      }
      finishes.push(() => {
        if (ts.use_mesh_automerge) app.run('mesh.remove_doubles', { threshold: ts.double_threshold }, { invoke: false });
      });
    }
    if (!elements.length) return null;
    const mine = [...updaters];
    return {
      elements,
      active: activePos,
      label: 'Mesh',
      onUpdate() {
        for (const u of mine) u();
        app.changed('geometry');
      },
      finish() {
        for (const f of finishes) f();
      },
      cancel() {},
    };
  },
});

function offsetKey(key: Float32Array, oldBase: Float32Array, newBase: Float32Array) {
  const out = new Float32Array(key.length);
  for (let i = 0; i < key.length; i++) out[i] = key[i] + (newBase[i] - oldBase[i]);
  return out;
}

// gizmo center & framing in edit mode
function selectionWorldPoints(): Vector3[] {
  const pts: Vector3[] = [];
  for (const { ob, me } of editMeshObjects()) {
    if (!me.select_vert) continue;
    const world = app.graph.get(ob.id)?.world ?? new Matrix4();
    for (let i = 0; i < me.select_vert.length; i++) if (me.select_vert[i] && !me.hide_vert?.[i]) pts.push(new Vector3(me.positions[i * 3], me.positions[i * 3 + 1], me.positions[i * 3 + 2]).applyMatrix4(world));
  }
  return pts;
}

setGizmoCenterHook(() => {
  if (app.doc.mode !== 'EDIT') return null;
  const pts = selectionWorldPoints();
  if (!pts.length) return null;
  const c = new Vector3();
  for (const p of pts) c.add(p);
  c.multiplyScalar(1 / pts.length);
  const act = editMeshObjects()[0];
  let basis: Matrix3 | undefined;
  if (act) {
    const world = app.graph.get(act.ob.id)?.world ?? new Matrix4();
    basis = new Matrix3().setFromMatrix4(world).multiply(basisFromNormal(selectionNormal(act.me)));
  }
  return { center: c, basis };
});

frameHooks.push(() => {
  if (app.doc.mode !== 'EDIT') return null;
  const pts = selectionWorldPoints();
  if (!pts.length) return null;
  return new Box3().setFromPoints(pts);
});

medianHooks.push(() => {
  if (app.doc.mode !== 'EDIT') return null;
  const pts = selectionWorldPoints();
  if (!pts.length) return null;
  const c = new Vector3();
  for (const p of pts) c.add(p);
  return c.multiplyScalar(1 / pts.length);
});
