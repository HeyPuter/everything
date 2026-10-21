// Meshes whose material only has a Volume shader render as a homogeneous medium filling the
// mesh's bounds in both engines (through the volume renderer, src/volume/render.ts); their
// surface is not drawn.
import { Matrix4, type Mesh } from 'three';
import type { DocumentData, MaterialData, ObjectData } from '../../data/types';
import { materialSlots } from '../../editors/view3d/draw';
import { extraVolumeSources, type Source } from '../../volume/render';
import { volumeShaderOfTree } from '../../volume/shader';
import { uvwToObject, type PackedVolume } from '../../volume/pack';
import { renderSceneHooks } from './renderscene';

/** Does the material describe only a volume (Volume linked, Surface not)? */
export function isVolumeOnlyMaterial(ma: MaterialData | undefined | null): boolean {
  if (!ma?.use_nodes || !ma.tree) return false;
  const outs = ma.tree.nodes.filter((n) => n.type === 'ShaderNodeOutputMaterial');
  const out = outs.find((n) => n.props.is_active_output !== false && (n.props.target ?? 'ALL') !== 'CYCLES') ?? outs[0];
  if (!out) return false;
  const linked = (socket: string) => ma.tree.links.some((l) => l.to_node === out.id && l.to_socket === socket);
  return linked('Volume') && !linked('Surface');
}

/** The volume-only material of a mesh object (all of its slots must be volume-only). */
function meshVolumeMaterial(doc: DocumentData, ob: ObjectData): MaterialData | null {
  if (ob.type !== 'MESH') return null;
  const slots = materialSlots(doc, ob).filter((m): m is string => !!m);
  if (!slots.length) return null;
  const mats = slots.map((id) => doc.materials[id]);
  return mats.every((m) => isVolumeOnlyMaterial(m)) ? mats[0] : null;
}

/** A uniform 2×2×2 grid spanning the box min..max (object space). */
export function boxVolume(min: number[], max: number[]): PackedVolume {
  const size = [0, 1, 2].map((i) => Math.max(1e-6, max[i] - min[i]));
  const n = 2;
  const vs = size.map((x) => x / n);
  const data = new Uint8Array(n * n * n * 4);
  for (let i = 0; i < n * n * n; i++) data[i * 4] = 255;
  return {
    dims: [n, n, n],
    transform: [vs[0], 0, 0, 0, 0, vs[1], 0, 0, 0, 0, vs[2], 0, min[0] + vs[0] / 2, min[1] + vs[1] / 2, min[2] + vs[2] / 2, 1],
    data,
    scale: [1, 1, 1],
    maxDensity: 1,
  };
}

const packCache = new Map<string, PackedVolume>();
/** Objects drawn as mesh volumes in the last build (their surfaces are hidden). */
const volumeObjects = new WeakMap<object, Set<string>>();

extraVolumeSources.push((app, visible) => {
  const doc = app.doc;
  const out: Source[] = [];
  const ids = new Set<string>();
  for (const ev of app.graph.objects.values()) {
    const m = ev.mesh;
    if (!m || m.volume?.length || !m.positions.length || !visible(ev.id)) continue;
    const ma = meshVolumeMaterial(doc, ev.ob);
    if (!ma) continue;
    const shader = volumeShaderOfTree(ma.tree);
    if (!shader) continue;
    const P = m.positions;
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], P[i + k]);
        max[k] = Math.max(max[k], P[i + k]);
      }
    const key = `${min.join(',')}|${max.join(',')}`;
    let packed = packCache.get(key);
    if (!packed) {
      if (packCache.size > 64) packCache.clear();
      packCache.set(key, (packed = boxVolume(min, max)));
    }
    ids.add(ev.id);
    out.push({ key: `mesh-volume|${ev.id}|${key}`, objectId: ev.id, packed, shader: { ...shader, densityGrid: null, emissionGrid: null, temperatureGrid: null, colorGrid: null }, matrix: ev.world.clone().multiply(new Matrix4().fromArray(uvwToObject(packed))), clipping: 0, stepSize: 0 });
  }
  volumeObjects.set(app, ids);
  return out;
});

// the mesh surfaces of volume objects are not drawn
renderSceneHooks.push((rs, app) => {
  const ids = volumeObjects.get(app);
  if (!ids?.size) return;
  for (const c of rs.scene.children) {
    const id = c.userData.id as string | undefined;
    if (id && ids.has(id) && (c as Mesh).isMesh) c.visible = false;
  }
});
