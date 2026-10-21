// Force field shapes on objects with a field (Extras overlay): Force draws three screen-facing
// rings, Wind a stack of rings in its XY plane (spaced by the strength), Vortex a spiral. With a
// maximum distance the limit is drawn as a dashed screen-facing circle.
import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineDashedMaterial, LineSegments, Matrix4, Vector3, type Camera, type OrthographicCamera, type PerspectiveCamera } from 'three';
import { app } from '../../app/app';
import { renderContext } from '../../render/context';
import { sceneSyncHooks, type SyncedObject } from '../../render/scene';
import { drawHooks, viewportTheme, type DrawView } from './draw';
import type { ForceField } from '../../data/types';

type Seg = number[];

function ring(out: Seg, r: number, z = 0, n = 48) {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2,
      a1 = ((i + 1) / n) * Math.PI * 2;
    out.push(Math.cos(a0) * r, Math.sin(a0) * r, z, Math.cos(a1) * r, Math.sin(a1) * r, z);
  }
}

/** Object-space (or, for billboards, view-plane) lines of a field. */
export function fieldShape(f: Pick<ForceField, 'type' | 'strength'>): { local: Seg; billboard: Seg } {
  const local: Seg = [];
  const billboard: Seg = [];
  if (f.type === 'FORCE') for (const r of [1, 1.5, 2]) ring(billboard, r);
  else if (f.type === 'WIND') {
    const step = 0.05 * Math.max(-4, Math.min(4, f.strength));
    for (let i = 0; i < 4; i++) ring(local, 1, i * step);
  } else if (f.type === 'VORTEX') {
    // one and a half turns out to radius 1, ending on +Y
    const n = 72,
      turns = 1.5;
    let prev: number[] | null = null;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const a = Math.PI / 2 + turns * Math.PI * 2 * (1 - t);
      const p = [Math.cos(a) * t, Math.sin(a) * t, 0];
      if (prev) local.push(...prev, ...p);
      prev = p;
    }
  }
  return { local, billboard };
}

const PARTS = 'fieldParts';
interface FieldParts {
  key: string;
  local: LineSegments | null;
  billboard: LineSegments | null;
  limit: LineSegments | null;
}

const geo = (seg: Seg) => {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(seg, 3));
  return g;
};

sceneSyncHooks.push((_doc, ev, so) => {
  const f = ev.ob.field as (ForceField & { use_max_distance?: boolean; distance_max?: number }) | null;
  const old = so.root.userData[PARTS] as FieldParts | undefined;
  const key = f && f.type !== 'NONE' && ev.ob.type === 'EMPTY' ? JSON.stringify([f.type, f.strength, f.use_max_distance, f.distance_max]) : '';
  if (old?.key === key) return;
  if (old)
    for (const o of [old.local, old.billboard, old.limit])
      if (o) {
        so.root.remove(o);
        o.geometry.dispose();
      }
  delete so.root.userData[PARTS];
  if (!key || !f) return;
  const shape = fieldShape(f);
  const mk = (seg: Seg, dashed = false) => {
    if (!seg.length) return null;
    const l = new LineSegments(geo(seg), dashed ? new LineDashedMaterial({ dashSize: 0.1, gapSize: 0.1, transparent: true, opacity: 0.6 }) : new LineBasicMaterial({ transparent: true, opacity: 0.6 }));
    if (dashed) l.computeLineDistances();
    l.matrixAutoUpdate = false;
    l.matrixWorldAutoUpdate = false;
    l.visible = false;
    l.userData.id = ev.id;
    so.root.add(l);
    return l;
  };
  const limitSeg: Seg = [];
  if (f.use_max_distance && (f.distance_max ?? 0) > 0) ring(limitSeg, f.distance_max!, 0, 64);
  so.root.userData[PARTS] = { key, local: mk(shape.local), billboard: mk(shape.billboard), limit: mk(limitSeg, true) } satisfies FieldParts;
});

const right = new Vector3(),
  up = new Vector3(),
  back = new Vector3();

function update(so: SyncedObject, parts: FieldParts, show: boolean, camera: Camera) {
  const ob = so.ev.ob;
  const st = app.doc.scene.active_object === ob.id && ob.select ? 2 : ob.select ? 1 : 0;
  // unselected fields are drawn in a light grey, selected ones in the selection colours
  const color = st === 2 ? viewportTheme.active : st === 1 ? viewportTheme.selected : null;
  camera.updateMatrixWorld();
  right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  back.setFromMatrixColumn(camera.matrixWorld, 2).normalize();
  const pos = new Vector3().setFromMatrixPosition(so.ev.world);
  const sc = new Vector3().setFromMatrixScale(so.ev.world);
  const s = Math.max(sc.x, sc.y, sc.z);
  const bill = new Matrix4().makeBasis(right.clone().multiplyScalar(s), up.clone().multiplyScalar(s), back.clone().multiplyScalar(s)).setPosition(pos);
  for (const [o, m] of [
    [parts.local, so.ev.world],
    [parts.billboard, bill],
    [parts.limit, bill],
  ] as const) {
    if (!o) continue;
    o.visible = show;
    o.matrixWorld.copy(m);
    const mat = o.material as LineBasicMaterial;
    if (color) mat.color.copy(color);
    else mat.color.setRGB(0.42, 0.42, 0.42);
    mat.opacity = color ? 1 : 0.6;
  }
}

drawHooks.passes.push((pass, view: DrawView, camera: Camera | OrthographicCamera | PerspectiveCamera) => {
  if (!renderContext) return;
  const touched: FieldParts[] = [];
  for (const so of renderContext.sync.objects.values()) {
    const parts = so.root.userData[PARTS] as FieldParts | undefined;
    if (!parts) continue;
    update(so, parts, pass === 'OVERLAY' && view.overlay.show_extras && so.root.visible, camera);
    touched.push(parts);
  }
  return () => {
    for (const p of touched) for (const o of [p.local, p.billboard, p.limit]) if (o) o.visible = false;
  };
});
