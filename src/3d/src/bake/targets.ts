// Which objects are baked and where each result goes: the image of the active Image Texture node
// of every material slot, or the mesh's active color attribute. Problems are collected as
// readable messages instead of failing half-way through a bake.
import type { DocumentData, MaterialData, NodeData, ObjectData, MeshData } from '../data/types';

/** One object baked into one image (the faces of `slots`) or into its active color attribute. */
export interface BakeTarget {
  object: ObjectData;
  kind: 'IMAGE' | 'COLOR';
  /** image id (IMAGE) */
  image?: string;
  /** material slots whose faces are baked (IMAGE) */
  slots: number[];
}

/** Slot materials of an object (object-linked slots resolved). */
export function slotMaterials(doc: DocumentData, ob: ObjectData): (MaterialData | null)[] {
  const me = ob.data ? doc.meshes[ob.data] : undefined;
  const base = me?.materials ?? [];
  return base.map((m, i) => {
    const id = ob.material_slots_link?.[i] === 'OBJECT' ? (ob.object_materials?.[i] ?? null) : m;
    return id ? (doc.materials[id] ?? null) : null;
  });
}

/**
 * The Image Texture node a material bakes into: the active node when it is an Image Texture with
 * an image; otherwise the only Image Texture node whose output is not connected (a node added
 * just to receive the bake), when there is exactly one.
 */
export function bakeImageNode(doc: DocumentData, ma: MaterialData): NodeData | null {
  const tree = ma.tree;
  if (!tree) return null;
  const isImg = (n: NodeData | undefined) => !!n && n.type === 'ShaderNodeTexImage' && !n.mute && typeof n.props.image === 'string' && !!doc.images[n.props.image];
  const active = tree.nodes.find((n) => n.id === tree.active_node);
  if (isImg(active)) return active!;
  const loose = tree.nodes.filter((n) => isImg(n) && !tree.links.some((l) => l.from_node === n.id));
  return loose.length === 1 ? loose[0] : null;
}

function hasUVs(me: MeshData) {
  if (!me.uvs?.length || me.uvs.length !== me.indices.length * 2) return false;
  for (let i = 0; i < me.uvs.length; i++) if (me.uvs[i] !== 0) return true;
  return false;
}

export interface Plan {
  targets: BakeTarget[];
  errors: string[];
}

/** Resolve bake targets for `objects` (meshes only). */
export function planTargets(doc: DocumentData, objects: ObjectData[], target: 'IMAGE_TEXTURES' | 'VERTEX_COLORS'): Plan {
  const out: Plan = { targets: [], errors: [] };
  for (const ob of objects) {
    if (ob.type !== 'MESH' || !ob.data || !doc.meshes[ob.data]) {
      out.errors.push(`"${ob.name}" is not a mesh and cannot be baked`);
      continue;
    }
    const me = doc.meshes[ob.data];
    if (target === 'VERTEX_COLORS') {
      const attr = me.color_attributes?.[me.active_color_index ?? 0];
      if (!attr) out.errors.push(`"${ob.name}" has no color attribute to bake into: add one in Object Data ▸ Color Attributes`);
      else out.targets.push({ object: ob, kind: 'COLOR', slots: [] });
      continue;
    }
    if (!hasUVs(me)) {
      out.errors.push(`"${ob.name}" has no UV map: unwrap it before baking to an image`);
      continue;
    }
    const mats = slotMaterials(doc, ob);
    if (!mats.length || mats.every((m) => !m)) {
      out.errors.push(`"${ob.name}" has no material: add one with an Image Texture node to bake into`);
      continue;
    }
    // faces reference slots; only slots that are used need an image
    const used = new Set<number>();
    const nf = me.offsets.length - 1;
    for (let f = 0; f < nf; f++) used.add(Math.min(mats.length - 1, me.material_index?.[f] ?? 0));
    const byImage = new Map<string, number[]>();
    let ok = true;
    for (const s of [...used].sort((a, b) => a - b)) {
      const ma = mats[s];
      if (!ma) {
        out.errors.push(`"${ob.name}": material slot ${s + 1} is empty`);
        ok = false;
        continue;
      }
      const node = bakeImageNode(doc, ma);
      if (!node) {
        out.errors.push(`Material "${ma.name}" has no Image Texture node to bake into: add one with an image and make it the active node`);
        ok = false;
        continue;
      }
      const img = node.props.image as string;
      let l = byImage.get(img);
      if (!l) byImage.set(img, (l = []));
      l.push(s);
    }
    if (!ok) continue;
    for (const [image, slots] of byImage) out.targets.push({ object: ob, kind: 'IMAGE', image, slots });
  }
  return out;
}
