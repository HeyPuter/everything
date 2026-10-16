// Per view layer render visibility and light linking in both render engines:
// - Holdout (collection or object): the object renders as a transparent cut-out (alpha 0).
// - Indirect Only (collection) / object "Camera" ray visibility off: the object is invisible to
//   the camera but still casts shadows (and, in the path tracer, shows in reflections and bounces).
// - Light linking: lights only light their receivers; in the path tracer only blockers cast their
//   shadows. The realtime engine honours receivers (per object influence of each light).
// RenderScene asks `renderVisHooks` for the variant materials of each mesh.
import { MeshBasicMaterial, NoBlending, type Light, type Material, type Mesh, type MeshPhysicalMaterial } from 'three';
import type { DocumentData, ID } from '../data/types';
import { renderVisHooks, type RenderVisState } from '../render/final/renderscene';
import { pathTracerLinkHook } from '../render/final/pathtracer';
import { computeLinkTable, ALL_GROUPS, type LinkTable } from './lightlinking';
import { fxUniforms, MAX_LIGHTS } from '../render/realtime/fxshader';
import { influenceUpdatedHooks, lastPackedLights } from '../render/realtime/lightinfluence';

/** Objects in holdout / indirect-only collections of the live view layer, plus object flags. */
export function layerVisibility(doc: DocumentData): { holdout: Set<ID>; indirect: Set<ID> } {
  const holdout = new Set<ID>(),
    indirect = new Set<ID>();
  const seen = new Set<ID>();
  const walk = (cid: ID, h: boolean, ind: boolean) => {
    if (seen.has(cid)) return;
    seen.add(cid);
    const c = doc.collections[cid];
    if (!c) return;
    const master = cid === doc.scene.collection;
    const hh = h || (!master && !!c.holdout);
    const ii = ind || (!master && !!c.indirect_only);
    for (const o of c.objects) {
      if (hh) holdout.add(o);
      if (ii) indirect.add(o);
    }
    for (const ch of c.children) walk(ch, hh, ii);
  };
  walk(doc.scene.collection, false, false);
  for (const ob of Object.values(doc.objects)) {
    if (ob.is_holdout) holdout.add(ob.id);
    if (ob.visible_camera === false) indirect.add(ob.id);
  }
  return { holdout, indirect };
}

// ---------------------------------------------------------------------------
// materials

let holdoutMat: MeshBasicMaterial | null = null;
let hiddenMat: MeshBasicMaterial | null = null;

/** Writes transparent black with depth: a cut-out in the image. */
function rasterHoldout() {
  return (holdoutMat ??= new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, blending: NoBlending, depthWrite: true }));
}
/** Draws nothing (the mesh still casts shadows through its depth material). */
function rasterHidden() {
  return (hiddenMat ??= new MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
}

const ptVariants = new WeakMap<Material, Map<string, MeshPhysicalMaterial>>();
/** Path tracer copy of a material with holdout / indirect-only / link group settings. */
function ptVariant(base: Material, holdout: boolean, indirect: boolean, group: number): Material {
  if (!holdout && !indirect && !group) return base;
  const key = `${holdout ? 1 : 0}${indirect ? 1 : 0}${group}`;
  let m = ptVariants.get(base);
  if (!m) ptVariants.set(base, (m = new Map()));
  let v = m.get(key);
  if (!v) m.set(key, (v = (base as MeshPhysicalMaterial).clone()));
  // follow the base material's current values
  v.copy(base as MeshPhysicalMaterial);
  (v as unknown as { matte: boolean }).matte = holdout;
  // the path tracer packs this field above its vertex colour flag: bit 1 flat shading, bit 3
  // indirect only, bits 4+ the link group (the shader patch in render/final/pathtracer.ts reads them)
  (v as unknown as { flatShading: number }).flatShading = ((base as MeshPhysicalMaterial).flatShading ? 1 : 0) + (indirect ? 4 : 0) + group * 8;
  v.userData.ptIndirect = indirect;
  v.userData.ptLink = group;
  return v;
}

const rasterVariants = new WeakMap<Material, Map<number, Material>>();
let nextVariantId = 1_000_000_000;
/**
 * Realtime variant of a material for a light linking group: a separate material identity (so
 * the renderer re-uploads the per-light factors between groups) sharing everything else.
 */
function rasterVariant(base: Material, group: number): Material {
  if (!group) return base;
  let m = rasterVariants.get(base);
  if (!m) rasterVariants.set(base, (m = new Map()));
  let v = m.get(group);
  if (!v) {
    v = Object.create(base) as Material;
    Object.defineProperties(v, {
      id: { value: nextVariantId++, writable: true },
      uuid: { value: `${base.uuid}-link${group}`, writable: true },
      userData: { value: { linkGroup: group }, writable: true },
      _listeners: { value: {}, writable: true },
    });
    m.set(group, v);
  }
  // re-inherit the version (a needsUpdate on the variant would shadow the base's)
  if (Object.prototype.hasOwnProperty.call(v, 'version')) delete (v as unknown as { version?: number }).version;
  return v;
}

// ---------------------------------------------------------------------------
// realtime light linking: each mesh sets the per-light factors of its group before drawing

const baseInfluence: Record<string, Float32Array> = {};
const KIND_ARRAY: Record<string, 'ndLiPoint' | 'ndLiSpot' | 'ndLiDir' | 'ndLiSun' | 'ndLiRect'> = { point: 'ndLiPoint', spot: 'ndLiSpot', dir: 'ndLiDir', sun: 'ndLiSun', rect: 'ndLiRect' };
// keep the factors of the current render: meshes of linking groups start from them
influenceUpdatedHooks.push(() => {
  for (const [k, u] of Object.entries(KIND_ARRAY)) {
    const arr = fxUniforms[u].value;
    (baseInfluence[k] ??= new Float32Array(arr.length)).set(arr);
  }
});

function applyGroupInfluence(table: LinkTable, group: number) {
  for (const [k, u] of Object.entries(KIND_ARRAY)) if (baseInfluence[k]) fxUniforms[u].value.set(baseInfluence[k]);
  const bit = 1 << group;
  for (const p of lastPackedLights()) {
    if (p.index >= MAX_LIGHTS) continue;
    const id = (p.light.userData as { obId?: ID }).obId;
    const masks = id ? table.lights.get(id) : undefined;
    if (!masks || masks.receive & bit) continue;
    const arr = fxUniforms[KIND_ARRAY[p.kind]].value;
    arr[p.index * 2] = 1;
    arr[p.index * 2 + 1] = 1;
  }
}

renderVisHooks.prepare = (doc, mode, objects, lights): RenderVisState | null => {
  const vis = layerVisibility(doc);
  const table = computeLinkTable(doc, objects, lights);
  if (!vis.holdout.size && !vis.indirect.size && !table) return null;
  return { vis, table, mode };
};

renderVisHooks.materials = (st, obId, mats, mesh) => {
  const s = st as { vis: ReturnType<typeof layerVisibility>; table: LinkTable | null; mode: 'raster' | 'pathtrace' };
  const holdout = s.vis.holdout.has(obId);
  const indirect = !holdout && s.vis.indirect.has(obId);
  const group = s.table?.objectGroup.get(obId) ?? 0;
  if (s.mode === 'pathtrace') return mats.map((m) => ptVariant(m, holdout, indirect, group));
  // realtime
  const table = s.table;
  if (table) {
    mesh.onBeforeRender = () => applyGroupInfluence(table, group);
  }
  if (holdout) return mats.map(() => rasterHoldout());
  if (indirect) return mats.map(() => rasterHidden());
  return mats.map((m) => rasterVariant(m, group));
};

renderVisHooks.reset = (mesh) => {
  delete (mesh as Partial<Mesh>).onBeforeRender;
};

/** Link masks of the lights in the path tracer's light order. */
export function pathTracerLinkData(st: RenderVisState | null, lights: Light[], materials: Material[]): { lights: Float32Array; on: boolean } {
  const s = st as { table: LinkTable | null } | null;
  const L = new Float32Array(Math.max(1, lights.length) * 4);
  lights.forEach((l, i) => {
    const id = (l.userData as { obId?: ID }).obId;
    const m = id ? s?.table?.lights.get(id) : undefined;
    L[i * 4] = m ? m.receive : ALL_GROUPS;
    L[i * 4 + 1] = m ? m.block : ALL_GROUPS;
  });
  return { lights: L, on: !!s?.table || materials.some((m) => m.userData?.ptIndirect) };
}

pathTracerLinkHook.data = (rs, lights, materials) => pathTracerLinkData(rs.vis, lights, materials);
