// Particle hair in renders: Path hair becomes thin tubes (Hair Shape gives their thickness) with the
// material of the system's material slot, for the path tracer and the realtime engine.
import { Mesh, type Material } from 'three';
import { renderSceneHooks, renderVisibleObjects, type RenderScene } from '../render/final/renderscene';
import { meshGeometry } from '../render/geometry';
import { viewportMaterial } from '../render/pbr';
import { pathTracerMaterial } from '../render/final/ptmaterial';
import { materialSlots } from '../geonodes/convert';
import { strandTubes } from '../hair/render';
import type { EvalMesh } from '../eval/types';
import { hairRenderData } from './particles';
import { strandRadii } from './hairpaths';

const tubeCache = new WeakMap<Float32Array, { key: string; mesh: EvalMesh }>();

function tubes(points: Float32Array, per: number, first: number, s: Record<string, unknown>): EvalMesh {
  const key = JSON.stringify([first, s.root_radius, s.tip_radius, s.radius_scale, s.shape, s.use_close_tip]);
  const hit = tubeCache.get(points);
  if (hit && hit.key === key) return hit.mesh;
  const strands = points.length / (per * 3);
  const curves: { points: Float32Array }[] = [];
  for (let i = first; i < strands; i++) curves.push({ points: points.subarray(i * per * 3, (i + 1) * per * 3) });
  const r = strandRadii(per, s as never);
  const radii = new Float32Array(curves.length * per);
  for (let c = 0; c < curves.length; c++) radii.set(r, c * per);
  const mesh = strandTubes(curves, radii, 3);
  tubeCache.set(points, { key, mesh });
  return mesh;
}

const meshes = new WeakMap<RenderScene, Map<string, Mesh>>();

renderSceneHooks.push((rs, appRef, o) => {
  let byKey = meshes.get(rs);
  if (!byKey) meshes.set(rs, (byKey = new Map()));
  const doc = appRef.doc;
  const renderable = o.final ? renderVisibleObjects(doc) : null;
  const seen = new Set<string>();
  let changed = false;
  for (const [key, h] of hairRenderData) {
    const ev = appRef.graph.get(h.objectId);
    if (!ev || o.hideSurfaces) continue;
    const mod = ev.ob.modifiers.find((m) => key.endsWith(`:${m.id}`));
    if (!mod || (o.final ? mod.show_render === false : mod.show_viewport === false)) continue;
    const visible = renderable ? renderable.has(ev.id) : ev.visible && !ev.ob.hide_render && (!o.localView || o.localView.has(ev.id));
    if (!visible) continue;
    seen.add(key);
    const geo = meshGeometry(tubes(h.points, h.per, h.first, h.settings as unknown as Record<string, unknown>)).geometry;
    const slots = materialSlots(doc, ev.ob);
    const vm = viewportMaterial(doc, slots[Math.max(0, h.materialSlot - 1)] ?? slots[0] ?? null);
    const mat: Material = rs.mode === 'pathtrace' ? pathTracerMaterial(vm) : vm;
    let m = byKey.get(key);
    if (!m) {
      m = new Mesh(geo, mat);
      m.matrixAutoUpdate = false;
      // (not userData.id: that marks the object's own surface meshes)
      m.userData.hairOf = ev.id;
      rs.scene.add(m);
      byKey.set(key, m);
      changed = true;
    }
    if (m.geometry !== geo) {
      m.geometry = geo;
      changed = true;
    }
    if (m.material !== mat) {
      m.material = mat;
      changed = true;
    }
    m.matrix.copy(ev.world);
    m.matrixWorld.copy(ev.world);
    m.castShadow = ev.ob.visible_shadow !== false;
    m.receiveShadow = true;
  }
  for (const [key, m] of byKey)
    if (!seen.has(key)) {
      rs.scene.remove(m);
      byKey.delete(key);
      changed = true;
    }
  if (changed) rs.structureVersion++;
});
