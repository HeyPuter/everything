// Points as spheres in the render engines: the realtime engine draws instanced spheres, the path
// tracer gets one merged sphere mesh per object (its BVH handles many small primitives well).
import { InstancedMesh, Mesh, type Material } from 'three';
import { renderSceneHooks, renderVisibleObjects, type RenderScene } from '../render/final/renderscene';
import { viewportMaterial } from '../render/pbr';
import { pathTracerMaterial } from '../render/final/ptmaterial';
import { materialSlots } from '../geonodes/convert';
import type { EvalMesh } from '../eval/types';
import { isPointMesh, pointMatrices, sphereGeometry, mergedSpheres } from './spheres';

interface Entry {
  src: EvalMesh;
  mode: string;
  obj: Mesh;
}
const perScene = new WeakMap<RenderScene, Map<string, Entry>>();

renderSceneHooks.push((rs, app, o) => {
  let map = perScene.get(rs);
  if (!map) perScene.set(rs, (map = new Map()));
  const doc = app.doc;
  const renderable = o.final ? renderVisibleObjects(doc) : null;
  const seen = new Set<string>();
  let changed = false;
  for (const ev of app.graph.objects.values()) {
    const ob = ev.ob;
    const m = ev.mesh;
    if (!isPointMesh(m) || o.hideSurfaces) continue;
    const visible = renderable ? renderable.has(ev.id) : ev.visible && !ob.hide_render && (!o.localView || o.localView.has(ev.id));
    if (!visible) continue;
    seen.add(ev.id);
    let e = map.get(ev.id);
    if (e && (e.src !== m || e.mode !== o.mode)) {
      rs.scene.remove(e.obj);
      if (!(e.obj instanceof InstancedMesh)) e.obj.geometry.dispose();
      map.delete(ev.id);
      e = undefined;
    }
    const vm = viewportMaterial(doc, materialSlots(doc, ob)[0] ?? null);
    const mat: Material = o.mode === 'pathtrace' ? pathTracerMaterial(vm) : vm;
    if (!e) {
      let obj: Mesh;
      if (o.mode === 'pathtrace') obj = new Mesh(mergedSpheres(m.positions, m.pointRadius), mat);
      else {
        const n = m.positions.length / 3;
        const im = new InstancedMesh(sphereGeometry(n), mat, n);
        pointMatrices(m.positions, m.pointRadius, im);
        obj = im;
      }
      obj.matrixAutoUpdate = false;
      obj.userData.id = ev.id;
      obj.castShadow = ob.visible_shadow !== false;
      obj.receiveShadow = true;
      rs.scene.add(obj);
      e = { src: m, mode: o.mode, obj };
      map.set(ev.id, e);
      changed = true;
    }
    if (e.obj.material !== mat) {
      e.obj.material = mat;
      changed = true;
    }
    e.obj.matrix.copy(ev.world);
  }
  for (const [id, e] of map)
    if (!seen.has(id)) {
      rs.scene.remove(e.obj);
      if (!(e.obj instanceof InstancedMesh)) e.obj.geometry.dispose();
      map.delete(id);
      changed = true;
    }
  if (changed) rs.structureVersion++;
});
